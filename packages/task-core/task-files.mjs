import path from 'node:path';
import { WorkspaceFiles, WorkspaceFileError, FILE_BYTES, validName, safeError } from './workspace.mjs';
import { scanTree, readTreeFile, writeTreeFile, checkCapacity, internalName } from './safe-file-tree.mjs';

const INPUT_BYTES = 600_000;
const taskIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const cachedWarning = '执行目录暂不可用或文件正在变化，当前显示最近完整保存的归档；部分新结果可能尚未同步。';
const sameContent = (left, right) => left?.size === right.size && left?.sha256 === right.sha256;

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'name') || !Object.hasOwn(payload, 'contentBase64'))
    throw new WorkspaceFileError(400, '上传内容必须只包含文件名和 Base64 文件内容。');
  const { name, contentBase64 } = payload;
  if (!validName(name) || !name.isWellFormed() || name.includes('/') || name.trim() !== name || name.length > 180 || internalName(name))
    throw new WorkspaceFileError(400, '输入文件名无效，请使用不含路径的普通文件名。');
  if (typeof contentBase64 !== 'string' || !contentBase64)
    throw new WorkspaceFileError(400, '文件内容必须是完整、规范的 Base64 编码。');
  if (contentBase64.length > Math.ceil(INPUT_BYTES / 3) * 4)
    throw new WorkspaceFileError(413, '输入文件不能超过 600000 字节。');
  if (!base64Pattern.test(contentBase64)) throw new WorkspaceFileError(400, '文件内容必须是完整、规范的 Base64 编码。');
  const data = Buffer.from(contentBase64, 'base64');
  if (!data.length || data.toString('base64') !== contentBase64)
    throw new WorkspaceFileError(400, '文件内容必须是非空、规范的 Base64 编码。');
  if (data.length > INPUT_BYTES) throw new WorkspaceFileError(413, '输入文件不能超过 600000 字节。');
  return { name, data };
}

// Independent implementation of task archives and sandbox synchronization;
// the reference workspace.ts supplied the interface semantics, not source code.
export class TaskFiles {
  #queues = new Map();

  constructor({ root, agentRuntime }) {
    if (!path.isAbsolute(root)) throw new TypeError('Workspace root must be absolute');
    this.root = path.resolve(root);
    this.live = new WorkspaceFiles({ root: this.root, agentRuntime });
  }

  #archive(task) {
    if (typeof task?.id !== 'string' || !taskIdPattern.test(task.id))
      throw new WorkspaceFileError(400, '任务编号无效。');
    return `runtime/task-files/${task.id}`;
  }

  async #queue(task, action) {
    const archive = this.#archive(task);
    const previous = this.#queues.get(archive) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => action(archive)).catch(error => { throw safeError(error); });
    this.#queues.set(archive, pending);
    try { return await pending; }
    finally { if (this.#queues.get(archive) === pending) this.#queues.delete(archive); }
  }

  async #snapshot(archive) {
    try { return await scanTree(this.root, archive); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async #synchronize(archive, workspace, { inputsOnly = false } = {}) {
    if (workspace.state !== 'ready') return { state: workspace.state, synchronization: 'unprepared' };
    const source = await scanTree(this.root, workspace.path,
      { kinds: inputsOnly ? ['input'] : ['input', 'output'] });
    const snapshot = await this.#snapshot(archive);
    const known = new Map(snapshot?.files.map(file => [file.id, file]));
    const candidates = source.files.filter(file => file.kind === 'output'
      ? !sameContent(known.get(file.id), file) : !known.has(file.id));
    checkCapacity(snapshot, candidates);
    const committed = [];
    for (const file of candidates) {
      const content = await readTreeFile(this.root, workspace.path, file.kind, file.name);
      // A stable file can still grow between enumeration and its later copy.
      // Charge its actual copied size before publishing any new inode.
      checkCapacity(snapshot, [...committed, content.file]);
      await writeTreeFile(this.root, archive, file.kind, file.name, content.data, { overwrite: file.kind === 'output' });
      committed.push(content.file);
    }
    return { state: 'ready', synchronization: 'current' };
  }

  async #refresh(task, archive) {
    const workspace = await this.live.workspace(task);
    if (workspace.state === 'unsupported') return { state: 'unsupported', synchronization: 'unprepared', files: [], warning: workspace.reason };
    let synchronization;
    try { ({ synchronization } = await this.#synchronize(archive, workspace)); }
    catch (error) {
      const safe = safeError(error);
      if (![404, 409].includes(safe.statusCode)) throw safe;
      const snapshot = await this.#snapshot(archive);
      // An empty directory left by a failed first copy is not a saved snapshot.
      if (!snapshot?.files.length) throw safe;
      return { state: 'ready', synchronization: 'cached', warning: cachedWarning, files: snapshot.files };
    }
    const snapshot = await this.#snapshot(archive);
    return { state: workspace.state === 'ready' || snapshot?.files.length ? 'ready' : 'unprepared',
      synchronization, files: snapshot?.files ?? [] };
  }

  list(task) { return this.#queue(task, archive => this.#refresh(task, archive)); }

  read(task, kind, name, { maxBytes = FILE_BYTES } = {}) {
    return this.#queue(task, async archive => {
      if (!['input', 'output'].includes(kind) || !validName(name) || !name.isWellFormed() || internalName(name))
        throw new WorkspaceFileError(400, '文件类别或文件名无效。');
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > FILE_BYTES)
        throw new WorkspaceFileError(400, '文件读取大小限制无效。');
      const state = await this.#refresh(task, archive);
      if (state.state === 'unsupported') throw new WorkspaceFileError(409, state.warning);
      if (state.state === 'unprepared') throw new WorkspaceFileError(404, '任务尚未保存文件。');
      const result = await readTreeFile(this.root, archive, kind, name, maxBytes);
      return { ...result, synchronization: state.synchronization, ...(state.warning ? { warning: state.warning } : {}) };
    });
  }

  saveInput(task, payload) {
    return this.#queue(task, async archive => {
      const { name, data } = validatePayload(payload);
      if (['running', 'stopped'].includes(task.status)) throw new WorkspaceFileError(409, '任务当前状态不允许上传输入文件。');
      const workspace = await this.live.workspace(task);
      if (workspace.state === 'unsupported') throw new WorkspaceFileError(409, '旧 SDK 任务暂不支持输入上传。');
      // Import legacy/seed input before duplicate detection, but never prepare
      // the guest. A missing saved guest is recoverable only from an archive.
      try { await this.#synchronize(archive, workspace, { inputsOnly: true }); }
      catch (error) {
        if (safeError(error).statusCode !== 404 || !(await this.#snapshot(archive))?.files.length) throw error;
      }
      const snapshot = await this.#snapshot(archive);
      if (snapshot?.files.some(file => file.id === `input:${name}`)) throw new WorkspaceFileError(409, '已存在同名输入文件，请更换文件名。');
      checkCapacity(snapshot, [{ id: `input:${name}`, kind: 'input', name, size: data.length }]);
      return writeTreeFile(this.root, archive, 'input', name, data);
    });
  }

  collect(task) {
    return this.#queue(task, async archive => this.#synchronize(archive, await this.live.workspace(task)));
  }

  hydrate(task) {
    return this.#queue(task, async archive => {
      const workspace = await this.live.workspace(task);
      if (workspace.state !== 'ready') return { state: workspace.state, synchronization: 'unprepared', inputFiles: [] };
      await this.#synchronize(archive, workspace, { inputsOnly: true });
      const snapshot = await this.#snapshot(archive);
      const inputFiles = snapshot?.files.filter(file => file.kind === 'input') ?? [];
      const guest = await scanTree(this.root, workspace.path, { kinds: ['input'] });
      const known = new Map(guest.files.map(file => [file.id, file]));
      for (const file of inputFiles) {
        if (sameContent(known.get(file.id), file)) continue;
        const content = await readTreeFile(this.root, archive, 'input', file.name);
        await writeTreeFile(this.root, workspace.path, 'input', file.name, content.data, { overwrite: true });
      }
      return { state: 'ready', synchronization: 'current', inputFiles };
    });
  }
}
