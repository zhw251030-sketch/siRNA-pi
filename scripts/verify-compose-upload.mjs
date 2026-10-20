// Verify a dedicated upload exercise without submitting model, stop, or start
// requests. GET files may refresh the host archive from an existing workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { executionId } from '../packages/agent-runtime/compose-session-store.mjs';
import { verifyComposeFileTask } from './lib/verify-compose-file-task.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const [taskId, stage = 'completed', ...extra] = process.argv.slice(2);
assert.ok(executionId.test(taskId) && ['uploaded', 'completed', 'ended'].includes(stage) && !extra.length,
  'Usage: node scripts/verify-compose-upload.mjs <taskId> [uploaded|completed|ended]');
const base = `http://127.0.0.1:3000/v1/tasks/${taskId}`;
const expectedInput = Buffer.from('value\n3\n9\n15\n');
const expectedResult = { count: 3, sum: 27, mean: 9 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function projectPath(relative) {
  const absolute = path.resolve(root, relative);
  assert.ok(absolute.startsWith(root + path.sep), 'Artifact is outside the project');
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep)) {
    current = path.join(current, segment);
    assert.ok(!fs.lstatSync(current).isSymbolicLink(), 'Artifact path contains a symbolic link');
  }
  assert.equal(fs.realpathSync(absolute), absolute);
  return absolute;
}

function localFile(relative) {
  const absolute = projectPath(relative);
  const stat = fs.statSync(absolute);
  assert.ok(stat.isFile() && stat.nlink === 1, 'Artifact must be an ordinary unshared file');
  return fs.readFileSync(absolute);
}

async function json(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, `GET ${url} failed`);
  return response.json();
}

const before = await json(`${base}/messages`);
assert.equal(before.task.id, taskId);
assert.equal(before.execution.backend, 'agent-compose');
assert.equal(before.task.status, stage === 'ended' ? 'stopped' : 'idle');
assert.ok(executionId.test(before.task.executionSessionId));
const metadataPath = `runtime/compose-sessions/${before.task.executionSessionId}.json`;
const metadataBefore = localFile(metadataPath);
const session = JSON.parse(metadataBefore);
assert.equal(session.id, before.task.executionSessionId);
assert.equal(session.backend, 'agent-compose');
assert.equal(session.status, before.task.status);
const listing = await json(`${base}/files`);
assert.equal(listing.state, 'ready');
assert.equal(listing.synchronization, stage === 'uploaded' ? 'unprepared' : 'current');
const archivePath = `runtime/task-files/${taskId}`;
const verifiedFiles = [];

async function verifyFile(kind, name, compareGuest) {
  const matches = listing.files.filter(file => file.kind === kind && file.name === name);
  assert.equal(matches.length, 1, `Missing or ambiguous ${kind}/${name}`);
  const file = matches[0];
  const bytes = localFile(`${archivePath}/${kind}/${name}`);
  assert.equal(file.id, `${kind}:${name}`);
  assert.equal(file.size, bytes.length);
  assert.equal(file.sha256, hash(bytes));
  const response = await fetch(`${base}/files/${kind}/${encodeURIComponent(name)}?download=true`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(response.headers.get('x-task-files-sync'), listing.synchronization);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, 'HTTP bytes differ from the task archive');
  if (compareGuest) {
    assert.deepEqual(localFile(`${session.workspacePath}/${kind}/${name}`), bytes, 'Guest workspace bytes differ from archive');
  }
  verifiedFiles.push({ kind, name, size: bytes.length, sha256: hash(bytes),
    archiveMatchesHttp: true, ...(compareGuest ? { archiveMatchesGuest: true } : {}) });
  return bytes;
}

let nativePath;
let nativeBefore;
let eventLogPath;
let eventLogBefore;
let verification;
if (stage === 'uploaded') {
  assert.ok(session.sandboxId == null && session.workspacePath == null && session.bootstrapRunId == null);
  assert.ok(session.piSessionId == null && session.currentRunId == null && session.projectId == null);
  assert.ok(before.execution.sandboxId == null && before.execution.workspacePath == null);
  assert.deepEqual(session.runs, []);
  assert.deepEqual(before.messages, []);
  assert.deepEqual(before.runEvents, []);
  assert.deepEqual(listing.files.map(file => file.id), ['input:values.csv']);
  assert.deepEqual(await verifyFile('input', 'values.csv', false), expectedInput);
} else {
  assert.match(session.workspacePath, /^runtime\/agent-compose\/data\/sandboxes\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{64}\/workspace$/);
  assert.equal(session.workspacePath.split('/').at(-2), session.sandboxId);
  assert.equal(session.workspacePath, before.execution.workspacePath);
  assert.equal(session.sandboxId, before.execution.sandboxId);
  assert.equal(session.piSessionId, before.task.piSessionId);
  assert.equal(session.currentRunId, before.task.currentRunId);
  assert.equal(session.runs.length, 1, 'Use a dedicated task containing one upload exercise');
  const run = session.runs[0];
  assert.equal(run.runId, session.currentRunId);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.accepted, true);
  assert.ok(!run.stopUnconfirmed && !run.outcomeUnconfirmed && !session.contextUnconfirmed);
  assert.equal(before.messages.length, 2);
  assert.equal(before.messages[0].role, 'user');
  assert.equal(before.messages[1].role, 'assistant');
  assert.equal(before.messages[1].status, 'complete');
  if (stage === 'ended') {
    assert.equal(session.runtimeReleased, true);
    assert.equal(before.execution.runtimeReleased, true);
    assert.ok(typeof session.endedAt === 'string' && Number.isFinite(Date.parse(session.endedAt)));
  }
  const input = await verifyFile('input', 'values.csv', true);
  assert.deepEqual(input, expectedInput);
  const output = await verifyFile('output', 'upload-result.json', true);
  const providerPath = path.posix.normalize(`${session.workspacePath}/../state/agents/providers`);
  assert.equal(JSON.parse(localFile(`${providerPath}/pi.json`)).threadId, session.piSessionId);
  const nativeDirectory = `${providerPath}/pi/sessions`;
  const matching = fs.readdirSync(projectPath(nativeDirectory)).filter(name => {
    if (!name.endsWith('.jsonl')) return false;
    return JSON.parse(localFile(`${nativeDirectory}/${name}`).toString('utf8').split('\n')[0]).id === session.piSessionId;
  });
  assert.equal(matching.length, 1, 'Native Pi conversation is missing or ambiguous');
  nativePath = `${nativeDirectory}/${matching[0]}`;
  nativeBefore = localFile(nativePath);
  verification = verifyComposeFileTask({ sessionJsonl: nativeBefore.toString('utf8'), csv: input.toString('utf8'),
    resultJson: output.toString('utf8'), inputName: 'values.csv', outputName: 'upload-result.json' });
  assert.equal(verification.sessionId, session.piSessionId);
  assert.deepEqual(verification.result, expectedResult);
  const runEvents = before.runEvents.filter(event => event.runId === run.runId);
  assert.equal(runEvents.filter(event => event.type === 'tool_start').length, verification.toolCalls);
  assert.equal(runEvents.filter(event => event.type === 'tool_end').length, verification.toolResults);
  const done = runEvents.find(event => event.type === 'done' && event.payload.status === 'succeeded');
  // The existing SQLite CHECK retains progress_message as the storage type;
  // the payload preserves the specific workspace event presented to clients.
  const synced = runEvents.find(event => event.payload?.type === 'workspace_synced');
  assert.ok(done && synced && synced.sequence > done.sequence, 'Durable file synchronization must follow the run terminal event');
  assert.equal(synced.payload.type, 'workspace_synced');
  assert.ok(!runEvents.some(event => event.payload?.type === 'workspace_warning'));
  eventLogPath = run.eventLogPath;
  assert.equal(eventLogPath, `runtime/compose-web/${session.id}.${run.runId}.events.jsonl`);
  eventLogBefore = localFile(eventLogPath);
  const events = eventLogBefore.toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).status, 'succeeded');
}

assert.deepEqual(await json(`${base}/messages`), before, 'File verification changed task history');
assert.deepEqual(localFile(metadataPath), metadataBefore, 'File verification changed execution metadata');
if (nativePath) assert.deepEqual(localFile(nativePath), nativeBefore, 'File verification changed native context');
if (eventLogPath) assert.deepEqual(localFile(eventLogPath), eventLogBefore, 'File verification changed runtime events');
console.log(JSON.stringify({ taskId, stage, executionSessionId: session.id, taskStatus: before.task.status,
  sandboxId: session.sandboxId ?? null, piSessionId: session.piSessionId ?? null, runCount: session.runs.length,
  workspaceState: listing.state, synchronization: listing.synchronization, archivePath, files: verifiedFiles,
  ...(stage === 'uploaded' ? { taskHasNoGuestOrModelRun: true } : { ...verification, workspaceSyncDurable: true,
    nativeSessionPath: nativePath, nativeBytes: nativeBefore.length, nativeSha256: hash(nativeBefore),
    runtimeReleased: Boolean(session.runtimeReleased) }),
  taskHistoryUnchanged: true, executionMetadataUnchanged: true }, null, 2));
