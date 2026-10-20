// GET may refresh the host archive. Task history, execution metadata, models
// and container lifecycle are unchanged by this acceptance check.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { executionId } from '../packages/agent-runtime/compose-session-store.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const [taskId, ...extra] = process.argv.slice(2);
assert.ok(executionId.test(taskId) && !extra.length, 'Usage: node scripts/verify-compose-task-files.mjs <taskId>');
const base = `http://127.0.0.1:3000/v1/tasks/${taskId}`;
const hash = data => createHash('sha256').update(data).digest('hex');
async function json(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}
function localFile(relative) {
  const absolute = path.resolve(root, relative);
  assert.ok(absolute.startsWith(root + path.sep));
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep)) {
    current = path.join(current, part);
    assert.ok(!fs.lstatSync(current).isSymbolicLink());
  }
  assert.equal(fs.realpathSync(absolute), absolute);
  assert.equal(fs.statSync(absolute).nlink, 1);
  return fs.readFileSync(absolute);
}
const before = await json(`${base}/messages`);
assert.equal(before.execution.backend, 'agent-compose');
assert.notEqual(before.task.status, 'running', 'Use an idle or ended task for reproducible verification');
const metadataPath = `runtime/compose-sessions/${before.task.executionSessionId}.json`;
const metadataBytes = localFile(metadataPath);
const session = JSON.parse(metadataBytes);
assert.equal(session.id, before.task.executionSessionId);
const listing = await json(`${base}/files`);
if (session.workspacePath == null) {
  assert.equal(listing.state, listing.files.length ? 'ready' : 'unprepared');
  assert.equal(listing.synchronization, 'unprepared');
  assert.ok(session.sandboxId == null);
  assert.deepEqual(session.runs, []);
} else {
  assert.match(session.workspacePath, /^runtime\/agent-compose\/data\/sandboxes\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{64}\/workspace$/);
  assert.equal(session.workspacePath.split('/').at(-2), session.sandboxId);
  assert.equal(listing.state, 'ready');
  assert.ok(['current', 'cached'].includes(listing.synchronization));
}
const archivePath = `runtime/task-files/${taskId}`;
const verified = [];
for (const file of listing.files) {
  assert.ok(['input', 'output'].includes(file.kind));
  assert.ok(file.name.split('/').every(part => part && part !== '.' && part !== '..' && !/[\\:]/.test(part)));
  const response = await fetch(`${base}/files/${file.kind}/${encodeURIComponent(file.name)}?download=true`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, file.size);
  assert.equal(hash(bytes), file.sha256);
  assert.deepEqual(bytes, localFile(`${archivePath}/${file.kind}/${file.name}`));
  let guestComparison;
  if (session.workspacePath != null) {
    const relative = `${session.workspacePath}/${file.kind}/${file.name}`;
    try { guestComparison = { guestBytesMatchArchive: bytes.equals(localFile(relative)) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  verified.push({ kind: file.kind, name: file.name, size: bytes.length, sha256: hash(bytes), ...guestComparison });
}
assert.deepEqual(await json(`${base}/messages`), before);
assert.deepEqual(localFile(metadataPath), metadataBytes);
console.log(JSON.stringify({ taskId, taskStatus: before.task.status, workspaceState: listing.state,
  synchronization: listing.synchronization, archivePath, files: verified,
  downloadedBytesMatchArchive: verified.length ? true : null, taskHistoryUnchanged: true, executionMetadataUnchanged: true }, null, 2));
