import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WorkspaceFileError, FILE_BYTES, LIST_BYTES, LIST_ENTRIES, denied, changed,
  validName, sameIdentity, sameFile, ordinaryFile, childPath, openDirectory,
  verifyDirectories, inWorkspace, readStable } from './workspace.mjs';

export function internalName(name) {
  return name.split('/').some(part => /^\.task-file-[a-f0-9-]{36}\.tmp$/.test(part));
}

async function descend(parent, name, create) {
  try { return await openDirectory(parent, name); }
  catch (error) {
    if (!create || error.code !== 'ENOENT') throw error;
    await verifyDirectories(parent);
    try { await fs.mkdir(childPath(parent, name), { mode: 0o700 }); }
    catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
    await verifyDirectories(parent);
    return openDirectory(parent, name);
  }
}

export async function inTree(root, relative, action, { create = false } = {}) {
  return inWorkspace(root, '', async base => {
    const opened = [];
    try {
      let current = base;
      for (const name of relative.split('/').filter(Boolean)) {
        current = await descend(current, name, create);
        opened.push(current);
      }
      const result = await action(current);
      await verifyDirectories(current);
      return result;
    } finally { for (const directory of opened.reverse()) await directory.handle?.close(); }
  });
}

// Unlike the legacy viewer, synchronization rejects unsafe entries. It must
// never present a partial successful archive when a link was encountered.
export async function scanTree(root, relative, { inputBytes = FILE_BYTES, kinds = ['input', 'output'] } = {}) {
  return inTree(root, relative, async directory => {
    const files = [];
    const entryNames = new Set();
    const budget = { bytes: 0, entries: 0 };
    async function walk(current, kind, prefix = '') {
      await verifyDirectories(current);
      const entries = await fs.opendir(current.access);
      for await (const entry of entries) {
        if (++budget.entries > LIST_ENTRIES) throw new WorkspaceFileError(413, '任务目录超过 1000 个条目的列表限制。');
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!validName(name)) throw denied();
        let child;
        try {
          const stat = await fs.lstat(childPath(current, entry.name), { bigint: true });
          if (stat.isSymbolicLink()) throw denied();
          if (internalName(name)) {
            if (!ordinaryFile(stat)) throw denied();
            continue;
          }
          entryNames.add(`${kind}/${name}`);
          if (stat.isDirectory()) {
            child = await openDirectory(current, entry.name);
            await walk(child, kind, name);
          } else {
            if (!ordinaryFile(stat)) throw denied();
            const result = await readStable(current, entry.name, kind, name,
              { maxBytes: kind === 'input' ? inputBytes : FILE_BYTES, collect: false, budget });
            files.push(result.file);
          }
        } catch (error) { if (error.code === 'ENOENT') throw changed(); throw error; }
        finally { await child?.handle?.close(); }
      }
      await verifyDirectories(current);
    }
    for (const kind of kinds) {
      let child;
      try { child = await openDirectory(directory, kind); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      try { await walk(child, kind); } finally { await child.handle?.close(); }
    }
    files.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { files, entryNames, bytes: budget.bytes };
  });
}

export async function readTreeFile(root, relative, kind, name, maxBytes = FILE_BYTES) {
  const parts = name.split('/');
  const basename = parts.pop();
  return inTree(root, [relative, kind, ...parts].join('/'), directory =>
    readStable(directory, basename, kind, name, { maxBytes, collect: true }));
}

async function destination(directory, name) {
  try {
    const stat = await fs.lstat(childPath(directory, name), { bigint: true });
    if (!ordinaryFile(stat)) throw denied();
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Publish only a completely written private temporary inode. No destination is
// ever opened for truncation, so a guest-created hardlink cannot damage its peer.
export async function writeTreeFile(root, relative, kind, name, data, { overwrite = false } = {}) {
  const parts = name.split('/');
  const basename = parts.pop();
  return inTree(root, [relative, kind, ...parts].join('/'), async directory => {
    await verifyDirectories(directory);
    const before = await destination(directory, basename);
    if (before && !overwrite) throw new WorkspaceFileError(409, '已存在同名输入文件，请更换文件名。');
    const tempName = `.task-file-${randomUUID()}.tmp`;
    const temp = childPath(directory, tempName);
    const target = childPath(directory, basename);
    let handle;
    let ownStat;
    try {
      handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      ownStat = await handle.stat({ bigint: true });
      let offset = 0;
      while (offset < data.length) {
        const { bytesWritten } = await handle.write(data, offset, data.length - offset, offset);
        if (!bytesWritten) throw changed();
        offset += bytesWritten;
      }
      await handle.sync();
      const complete = await handle.stat({ bigint: true });
      if (!ordinaryFile(complete) || !sameIdentity(ownStat, complete) || complete.size !== BigInt(data.length)) throw changed();
      await handle.close(); handle = null;
      await verifyDirectories(directory);
      const latest = await destination(directory, basename);
      if (before ? !latest || !sameFile(before, latest) : latest !== null) throw changed();
      const staged = await fs.lstat(temp, { bigint: true });
      if (!ordinaryFile(staged) || !sameFile(complete, staged)) throw changed();
      if (overwrite && before) await fs.rename(temp, target);
      else {
        // link() publishes exclusively without a truncate or a rename-overwrite
        // race. The temporary name is removed before the queue exposes a read.
        try { await fs.link(temp, target); }
        catch (error) { if (error.code === 'EEXIST') throw new WorkspaceFileError(409, '已存在同名文件，请刷新后重试。'); throw error; }
        await fs.unlink(temp);
      }
      await verifyDirectories(directory);
      const published = await destination(directory, basename);
      if (!published || !sameIdentity(complete, published) || published.size !== BigInt(data.length)) throw changed();
      return (await readStable(directory, basename, kind, name, { maxBytes: FILE_BYTES, collect: false })).file;
    } finally {
      await handle?.close();
      // Remove only this operation's own temporary inode, never a replacement.
      if (ownStat) {
        const remaining = await fs.lstat(temp, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (remaining && sameIdentity(ownStat, remaining)) await fs.unlink(temp);
      }
    }
  }, { create: true });
}

export function checkCapacity(snapshot, additions) {
  const files = new Map(snapshot?.files.map(file => [file.id, file.size]) ?? []);
  const entryNames = new Set(snapshot?.entryNames ?? []);
  for (const file of additions) {
    files.set(file.id, file.size);
    const parts = file.name.split('/');
    for (let i = 1; i <= parts.length; i++) entryNames.add(`${file.kind}/${parts.slice(0, i).join('/')}`);
  }
  if (entryNames.size > LIST_ENTRIES) throw new WorkspaceFileError(413, '任务目录超过 1000 个条目的列表限制。');
  if ([...files.values()].reduce((sum, size) => sum + size, 0) > LIST_BYTES)
    throw new WorkspaceFileError(413, '任务文件总量超过 100 MB 限制。');
}
