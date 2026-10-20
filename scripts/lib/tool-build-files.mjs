import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const limit = 1048576;
function canonicalDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new Error('Refusing a linked or redirected project directory');
  }
}

export function readBuildProposal(filename, {root}) {
  root = path.resolve(root);
  canonicalDirectory(root);
  const absolute = path.resolve(root, filename);
  const relative = path.relative(root,absolute);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Proposal must stay inside the project root');
  }
  const initial = fs.lstatSync(absolute);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || fs.realpathSync(absolute) !== absolute) {
    throw new Error('Proposal must be an ordinary file without links or redirection');
  }
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.ino !== initial.ino || before.dev !== initial.dev) {
      throw new Error('Proposal file identity changed');
    }
    if (before.size < 1 || before.size > limit) throw new Error('Proposal must be nonempty and at most 1 MiB in size');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length-size, null);
      if (count === 0) break;
      size += count;
    }
    const after = fs.fstatSync(fd);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('Proposal size or contents changed during reading');
    }
    let text;
    try { text = new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)); }
    catch { throw new Error('Proposal must be valid UTF-8'); }
    try { return JSON.parse(text); }
    catch { throw new Error('Proposal must be valid JSON; source text is not echoed'); }
  } finally { fs.closeSync(fd); }
}

export function createBuildEvidence(root, sessionId) {
  root = path.resolve(root);
  canonicalDirectory(root);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) throw new Error('Invalid session ID');
  for (const directory of [path.join(root,'runtime'), path.join(root,'runtime','tool-builds')]) {
    try { fs.mkdirSync(directory,{mode:0o700}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    canonicalDirectory(directory);
  }
  const directory = path.join(root,'runtime','tool-builds',sessionId);
  fs.mkdirSync(directory,{mode:0o700});
  const journal = path.join(directory,'events.jsonl');
  fs.writeFileSync(journal,'',{flag:'wx',mode:0o600});
  const write = (name, value) => {
    if (!/^[a-z][a-z0-9-]*\.json$/.test(name)) throw new Error('Invalid evidence file name');
    const data = `${JSON.stringify(value,null,2)}\n`;
    canonicalDirectory(directory);
    const temporary = path.join(directory,`.${randomUUID()}.partial`);
    const fd = fs.openSync(temporary,'wx',0o600);
    try { fs.writeFileSync(fd,data); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary,path.join(directory,name)); }
    finally { fs.unlinkSync(temporary); }
  };
  const appendEvent = event => {
    const data = `${JSON.stringify(event)}\n`;
    canonicalDirectory(directory);
    const fd = fs.openSync(journal,fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat=fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Event journal must remain an unlinked ordinary file');
      fs.writeFileSync(fd,data); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  };
  return {directory,write,appendEvent};
}
