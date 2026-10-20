import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const FILE_BYTES = 50_000_000;
const LIST_BYTES = 100_000_000;
const LIST_ENTRIES = 1000;
const anchored = process.platform === 'linux';

export class WorkspaceFileError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'WorkspaceFileError';
    this.statusCode = statusCode;
  }
}

const denied = () => new WorkspaceFileError(403, '该文件或目录不允许访问。');
const changed = () => new WorkspaceFileError(409, '文件或目录在读取期间发生变化，请刷新后重试。');
const missing = () => new WorkspaceFileError(404, '任务目录或文件不存在。');

function safeError(error) {
  if (error instanceof WorkspaceFileError) return error;
  if (error.code === 'ENOENT') return missing();
  if (['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return denied();
  return new WorkspaceFileError(500, '暂时无法读取任务文件。');
}

function validName(name) {
  if (typeof name !== 'string' || !name || name.length > 1000) return false;
  const parts = name.split('/');
  return parts.length <= 16 && parts.every(part => part.length > 0 && part.length <= 180 &&
    part !== '.' && part !== '..' && !/[\\\x00-\x1f\x7f-\x9f<>:"|?*]/.test(part) &&
    !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameFile(left, right) {
  return sameIdentity(left, right) && left.mode === right.mode && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function ordinaryFile(stat) { return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n; }
function childPath(directory, name) { return path.join(directory.access, name); }

// Linux keeps each directory open and resolves children via its descriptor. Renaming
// a checked parent therefore cannot redirect a later open into a different tree.
// Windows development uses identity checks before/after; production runs on Linux.
async function openDirectory(parent, name) {
  const location = parent ? childPath(parent, name) : name;
  const stat = await fs.lstat(location, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw denied();
  let handle;
  try {
    if (anchored) {
      handle = await fs.open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!sameIdentity(stat, await handle.stat({ bigint: true }))) throw changed();
    }
    const latest = await fs.lstat(location, { bigint: true });
    if (latest.isSymbolicLink() || !latest.isDirectory() || !sameIdentity(stat, latest)) throw changed();
    return { parent, location, stat, handle, access: handle ? `/proc/self/fd/${handle.fd}` : location };
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

async function verifyDirectories(directory) {
  const chain = [];
  for (let current = directory; current; current = current.parent) chain.push(current);
  for (const current of chain.reverse()) {
    let latest;
    try { latest = await fs.lstat(current.location, { bigint: true }); }
    catch { throw changed(); }
    if (latest.isSymbolicLink() || !latest.isDirectory() || !sameIdentity(current.stat, latest)) throw changed();
    if (current.handle && !sameIdentity(current.stat, await current.handle.stat({ bigint: true }))) throw changed();
  }
}

async function inWorkspace(root, relative, action) {
  const volume = path.parse(root).root;
  const segments = [...root.slice(volume.length).split(path.sep).filter(Boolean), ...relative.split('/').filter(Boolean)];
  const opened = [];
  try {
    let current = await openDirectory(null, volume);
    opened.push(current);
    for (const segment of segments) {
      current = await openDirectory(current, segment);
      opened.push(current);
    }
    const result = await action(current);
    await verifyDirectories(current);
    return result;
  } finally {
    for (const directory of opened.reverse()) await directory.handle?.close();
  }
}

// Shared filesystem primitives keep the live viewer and durable archive under
// the same descriptor, identity, bounded-read and error-redaction rules.
export { FILE_BYTES, LIST_BYTES, LIST_ENTRIES, denied, changed, missing, safeError,
  validName, sameIdentity, sameFile, ordinaryFile, childPath, openDirectory,
  verifyDirectories, inWorkspace, readStable };

async function readStable(directory, basename, kind, name, { maxBytes, collect, budget }) {
  const location = childPath(directory, basename);
  const before = await fs.lstat(location, { bigint: true });
  if (!ordinaryFile(before)) throw denied();
  if (before.size > BigInt(maxBytes)) throw new WorkspaceFileError(413, '文件超过本次读取的大小限制。');
  const size = Number(before.size);
  if (budget) {
    if (budget.bytes + size > LIST_BYTES) throw new WorkspaceFileError(413, '任务文件总量超过列表校验的 100 MB 限制。');
    budget.bytes += size;
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await fs.open(location, flags);
  try {
    if (!sameFile(before, await handle.stat({ bigint: true }))) throw changed();
    await verifyDirectories(directory);
    if (!sameFile(before, await fs.lstat(location, { bigint: true }))) throw changed();
    const data = collect ? Buffer.allocUnsafe(size) : null;
    const chunk = collect ? data : Buffer.allocUnsafe(Math.min(size, 64 * 1024));
    const hash = createHash('sha256');
    let position = 0;
    while (position < size) {
      const offset = collect ? position : 0;
      const length = Math.min(size - position, 64 * 1024);
      const { bytesRead } = await handle.read(chunk, offset, length, position);
      if (!bytesRead) throw changed();
      hash.update(chunk.subarray(offset, offset + bytesRead));
      position += bytesRead;
    }
    if (!sameFile(before, await handle.stat({ bigint: true }))) throw changed();
    await verifyDirectories(directory);
    let after;
    try { after = await fs.lstat(location, { bigint: true }); } catch { throw changed(); }
    if (!sameFile(before, after) || !ordinaryFile(after)) throw changed();
    return { data, file: { id: `${kind}:${name}`, name, kind, size,
      sha256: hash.digest('hex'), modifiedAt: new Date(Number(before.mtimeMs)).toISOString() } };
  } finally { await handle.close(); }
}

export class WorkspaceFiles {
  constructor({ root, agentRuntime }) {
    if (!path.isAbsolute(root)) throw new TypeError('Workspace root must be absolute');
    this.root = path.resolve(root);
    this.agentRuntime = agentRuntime;
  }

  async workspace(task) {
    const session = await this.agentRuntime.status(task.executionSessionId);
    if (session.backend !== 'agent-compose') return { state: 'unsupported', reason: '旧 SDK 任务暂不支持网页文件查看。' };
    if (session.workspacePath == null) return { state: 'unprepared', reason: '任务尚未准备文件目录。' };
    const match = typeof session.workspacePath === 'string' &&
      /^runtime\/agent-compose\/data\/sandboxes\/\d{4}\/\d{2}\/\d{2}\/([a-f0-9]{64})\/workspace$/.exec(session.workspacePath);
    if (!match || match[1] !== session.sandboxId) throw denied();
    return { state: 'ready', path: session.workspacePath };
  }

  async list(task) {
    try {
      const workspace = await this.workspace(task);
      if (workspace.state !== 'ready') return { files: [], ...workspace };
      return await inWorkspace(this.root, workspace.path, async directory => {
        const files = [];
        const budget = { entries: 0, bytes: 0 };
        async function walk(current, kind, prefix = '') {
          await verifyDirectories(current);
          const entries = await fs.opendir(current.access);
          for await (const entry of entries) {
            if (++budget.entries > LIST_ENTRIES) throw new WorkspaceFileError(413, '任务目录超过 1000 个条目的列表限制。');
            const name = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (!validName(name)) continue;
            let child;
            try {
              const stat = await fs.lstat(childPath(current, entry.name), { bigint: true });
              if (stat.isSymbolicLink()) continue;
              if (stat.isDirectory()) {
                child = await openDirectory(current, entry.name);
                await walk(child, kind, name);
              } else if (ordinaryFile(stat)) {
                const result = await readStable(current, entry.name, kind, name,
                  { maxBytes: FILE_BYTES, collect: false, budget });
                files.push(result.file);
              }
            } catch (error) {
              if (safeError(error).statusCode === 403) continue;
              if (error.code === 'ENOENT') throw changed();
              throw error;
            } finally { await child?.handle?.close(); }
          }
          await verifyDirectories(current);
        }
        for (const kind of ['input', 'output']) {
          let child;
          try {
            child = await openDirectory(directory, kind);
            await walk(child, kind);
          } catch (error) {
            // A task may not have produced either subtree yet. Never treat a
            // missing saved workspace (opened above) as a successful empty list.
            if ((!child && error.code === 'ENOENT') || safeError(error).statusCode === 403) continue;
            throw error;
          } finally { await child?.handle?.close(); }
        }
        files.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
        return { state: 'ready', files };
      });
    } catch (error) { throw safeError(error); }
  }

  async read(task, kind, name, { maxBytes = FILE_BYTES } = {}) {
    if (!['input', 'output'].includes(kind) || !validName(name))
      throw new WorkspaceFileError(400, '文件类别或文件名无效。');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > FILE_BYTES)
      throw new WorkspaceFileError(400, '文件读取大小限制无效。');
    try {
      const workspace = await this.workspace(task);
      if (workspace.state === 'unsupported') throw new WorkspaceFileError(409, workspace.reason);
      if (workspace.state === 'unprepared') throw new WorkspaceFileError(404, workspace.reason);
      return await inWorkspace(this.root, workspace.path, async directory => {
        const parts = [kind, ...name.split('/')];
        const basename = parts.pop();
        const opened = [];
        try {
          let current = directory;
          for (const part of parts) {
            current = await openDirectory(current, part);
            opened.push(current);
          }
          return await readStable(current, basename, kind, name, { maxBytes, collect: true });
        } finally {
          for (const current of opened.reverse()) await current.handle?.close();
        }
      });
    } catch (error) { throw safeError(error); }
  }
}
