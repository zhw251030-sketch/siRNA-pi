// Fixed trusted container helper. Importing this module never executes source.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function requireThat(condition, message) { if (!condition) throw new Error(message); }
function stable(a, b) {
  return ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
}

/** Hash only the dedicated workdir: deterministic paths, directories and bytes. */
export function digestWorkspace(root, { maxEntries = 1024, maxBytes = 16 * 1024 * 1024 } = {}) {
  const rootStat = fs.lstatSync(root, { bigint: true });
  requireThat(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'Workspace must be a real directory');
  const entries = []; let bytes = 0;
  function walk(directory, relative = '') {
    const before = fs.lstatSync(directory, { bigint: true });
    requireThat(before.isDirectory() && !before.isSymbolicLink(), 'Workspace directory changed');
    const names = fs.readdirSync(directory).sort();
    for (const name of names) {
      requireThat(!name.includes('\0') && name !== '.' && name !== '..', 'Invalid workspace entry');
      const rel = relative ? `${relative}/${name}` : name;
      const absolute = path.join(directory, name); const stat = fs.lstatSync(absolute, { bigint: true });
      requireThat(entries.length < maxEntries, 'Workspace entry limit exceeded');
      requireThat(!stat.isSymbolicLink(), 'Workspace links are forbidden');
      if (stat.isDirectory()) { entries.push({ relative: rel, absolute, stat, directory: true }); walk(absolute, rel); }
      else {
        requireThat(stat.isFile() && stat.nlink === 1n, 'Workspace file must be regular without hardlinks');
        bytes += Number(stat.size); requireThat(bytes <= maxBytes, 'Workspace byte limit exceeded');
        entries.push({ relative: rel, absolute, stat, directory: false });
      }
    }
    requireThat(stable(before, fs.lstatSync(directory, { bigint: true })) &&
      JSON.stringify(names) === JSON.stringify(fs.readdirSync(directory).sort()), 'Workspace changed while listing');
  }
  walk(root);
  const digest = createHash('sha256');
  entries.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  const block = Buffer.alloc(65536);
  for (const entry of entries) {
    requireThat(stable(entry.stat, fs.lstatSync(entry.absolute, { bigint: true })), 'Workspace changed while hashing');
    digest.update(`${entry.directory ? 'd' : 'f'}:${entry.relative}\0`);
    if (entry.directory) continue;
    // Paths cannot contain NUL; decimal byte length plus NUL then makes the
    // following raw content unambiguous even when it contains entry headers.
    digest.update(`${entry.stat.size}\0`);
    const fd = fs.openSync(entry.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      requireThat(stable(entry.stat, fs.fstatSync(fd, { bigint: true })), 'Workspace file changed before reading');
      let count = 0;
      for (;;) { const size = fs.readSync(fd, block, 0, block.length, null); if (!size) break; count += size;
        requireThat(count <= Number(entry.stat.size), 'Workspace file grew while reading'); digest.update(block.subarray(0, size)); }
      requireThat(count === Number(entry.stat.size) && stable(entry.stat, fs.fstatSync(fd, { bigint: true })), 'Workspace file changed while reading');
    } finally { fs.closeSync(fd); }
  }
  for (const entry of entries) requireThat(stable(entry.stat, fs.lstatSync(entry.absolute, { bigint: true })), 'Workspace changed after hashing');
  requireThat(stable(rootStat, fs.lstatSync(root, { bigint: true })), 'Workspace root changed');
  return digest.digest('hex');
}

// Kill only same-UID non-controller processes, including descendants that left
// the original process group. This container contains exactly one tool run.
function liveToolProcesses() {
  const pids = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name); if (pid === 1 || pid === process.pid) continue;
    let status;
    try { status = fs.readFileSync(`/proc/${name}/status`, 'utf8'); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    if (/^Uid:\s+65534\s+65534\s+65534\s+65534\s*$/m.test(status) && !/^State:\s+Z\b/m.test(status)) pids.push(pid);
  }
  return pids;
}
async function quiesce() {
  requireThat(process.getuid() === 65534, 'Quiescence must run as the tool user');
  for (let attempt = 0; attempt < 25; attempt++) {
    const pids = liveToolProcesses(); if (!pids.length) return;
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  requireThat(liveToolProcesses().length === 0, 'Tool processes remained active');
}

async function runSource(source, encoded, duration) {
  requireThat(process.getuid() === 65534, 'Tool execution must be nonroot');
  requireThat(['/opt/tool/main.mjs', '/tmp/sirna-validator/baseline.mjs'].includes(source), 'Unexpected tool source');
  const timeoutMs = Number(duration); requireThat(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 30000, 'Invalid tool timeout');
  const input = Buffer.from(encoded, 'base64'); requireThat(input.length <= 66000, 'Envelope limit exceeded');
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/node', [source], { cwd: '/tmp/work', env: {}, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; const err = []; let received = 0; let timedOut = false; let outputLimitExceeded = false;
    function kill() { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') reject(error); } }
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    function consume(chunks, bytes) {
      const remaining = 65536 - received; received += bytes.length;
      if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
      if (received > 65536) { outputLimitExceeded = true; kill(); }
    }
    child.stdout.on('data', bytes => consume(out, bytes)); child.stderr.on('data', bytes => consume(err, bytes));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', error => { if (!['EPIPE', 'ECONNRESET'].includes(error.code)) reject(error); });
    // Kill same-UID descendants on exit so inherited pipes cannot keep 'close'
    // pending; use 'close' to preserve stdout bytes already in the kernel pipe.
    child.on('exit', () => { kill(); quiesce().catch(reject); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, outputLimitExceeded, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.end(input);
  });
  await quiesce();
  process.stdout.write(JSON.stringify(result));
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'digest') {
    requireThat(process.getuid() === 0 && liveToolProcesses().length === 0, 'Workspace is not quiescent');
    process.stdout.write(digestWorkspace('/tmp/work'));
  }
  else if (mode === 'source-hash') {
    const [file] = args; requireThat(['/opt/tool/main.mjs', '/tmp/sirna-validator/baseline.mjs'].includes(file), 'Unexpected source path');
    const stat = fs.lstatSync(file);
    requireThat(stat.isFile() && stat.nlink === 1 && stat.size <= 200000, 'Image source must be bounded and regular');
    process.stdout.write(createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  } else if (mode === 'quiesce') await quiesce();
  else if (mode === 'run') await runSource(...args);
  else throw new Error('Unknown validation helper mode');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Trusted validation helper failed\n'); process.exitCode = 1; });
}
