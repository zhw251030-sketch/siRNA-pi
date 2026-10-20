// Read-only model/container acceptance check. GET files may refresh the existing host archive.
// Expected values come from the hand-checked fixture, never from the domain algorithm.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { executionId } from '../packages/agent-runtime/compose-session-store.mjs';
import { verifyComposeCandidateTask } from './lib/verify-compose-candidate-task.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const [taskId, stage = 'completed', ...extra] = process.argv.slice(2);
assert.ok(executionId.test(taskId) && ['completed', 'ended'].includes(stage) && !extra.length,
  'Usage: node scripts/verify-compose-candidate-tool.mjs <taskId> [completed|ended]');
const base = `http://127.0.0.1:3000/v1/tasks/${taskId}`;
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

const expectedInput = localFile('examples/03-candidate-tool/target.fasta');
const expectedOutput = localFile('examples/03-candidate-tool/expected.json');
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
assert.match(session.workspacePath, /^runtime\/agent-compose\/data\/sandboxes\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{64}\/workspace$/);
assert.equal(session.workspacePath.split('/').at(-2), session.sandboxId);
assert.equal(session.workspacePath, before.execution.workspacePath);
assert.equal(session.sandboxId, before.execution.sandboxId);
assert.equal(session.piSessionId, before.task.piSessionId);
assert.equal(session.currentRunId, before.task.currentRunId);
assert.equal(session.runs.length, 1, 'Use a dedicated task with one candidate exercise');
const run = session.runs[0];
assert.equal(run.runId, session.currentRunId);
assert.equal(run.status, 'succeeded');
assert.equal(run.daemonStatus, 'succeeded');
assert.equal(run.accepted, true);
assert.ok(!run.stopUnconfirmed && !run.outcomeUnconfirmed && !session.contextUnconfirmed);
assert.equal(before.messages.length, 2);
assert.equal(before.messages[0].role, 'user');
assert.equal(before.messages[1].role, 'assistant');
assert.equal(before.messages[1].status, 'complete');
assert.equal(Boolean(session.runtimeReleased), stage === 'ended');
assert.equal(before.execution.runtimeReleased, stage === 'ended');
if (stage === 'ended') assert.ok(typeof session.endedAt === 'string' && Number.isFinite(Date.parse(session.endedAt)));

const listing = await json(`${base}/files`);
assert.equal(listing.state, 'ready');
assert.equal(listing.synchronization, 'current');
const archivePath = `runtime/task-files/${taskId}`;
const verifiedFiles = [];
async function verifyFile(kind, name) {
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
  assert.equal(response.headers.get('x-task-files-sync'), 'current');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, 'HTTP differs from the archive');
  assert.deepEqual(localFile(`${session.workspacePath}/${kind}/${name}`), bytes, 'Guest differs from the archive');
  verifiedFiles.push({ kind, name, size: bytes.length, sha256: hash(bytes), archiveMatchesHttp: true, archiveMatchesGuest: true });
  return bytes;
}
const input = await verifyFile('input', 'target.fasta');
assert.deepEqual(input, expectedInput, 'Uploaded input differs from the independent fixture');
const output = await verifyFile('output', 'candidates.json');
const providerPath = path.posix.normalize(`${session.workspacePath}/../state/agents/providers`);
assert.equal(JSON.parse(localFile(`${providerPath}/pi.json`)).threadId, session.piSessionId);
const nativeDirectory = `${providerPath}/pi/sessions`;
const matching = fs.readdirSync(projectPath(nativeDirectory)).filter(name => {
  if (!name.endsWith('.jsonl')) return false;
  return JSON.parse(localFile(`${nativeDirectory}/${name}`).toString('utf8').split('\n')[0]).id === session.piSessionId;
});
assert.equal(matching.length, 1, 'Native Pi conversation is missing or ambiguous');
const nativePath = `${nativeDirectory}/${matching[0]}`;
const nativeBefore = localFile(nativePath);
const verification = verifyComposeCandidateTask({ sessionJsonl: nativeBefore.toString('utf8'),
  inputFasta: input.toString('utf8'), resultJson: output.toString('utf8'), expectedJson: expectedOutput.toString('utf8') });
assert.equal(verification.sessionId, session.piSessionId);
assert.equal(run.modelResponses, verification.assistantResponses);
assert.equal(run.toolCalls, verification.toolCalls);
const runEvents = before.runEvents.filter(event => event.runId === run.runId);
assert.equal(runEvents.filter(event => event.type === 'tool_start').length, verification.toolCalls);
assert.equal(runEvents.filter(event => event.type === 'tool_end').length, verification.toolResults);
for (const tool of verification.toolEvidence) {
  const starts = runEvents.filter(event => event.type === 'tool_start' && event.payload.toolCallId === tool.toolCallId);
  const ends = runEvents.filter(event => event.type === 'tool_end' && event.payload.toolCallId === tool.toolCallId);
  assert.equal(starts.length, 1, 'Missing or duplicate projected tool start');
  assert.equal(ends.length, 1, 'Missing or duplicate projected tool end');
  assert.equal(starts[0].payload.toolName, tool.toolName);
  assert.equal(ends[0].payload.toolName, tool.toolName);
  assert.equal(ends[0].payload.isError, false);
  assert.ok(ends[0].sequence > starts[0].sequence);
}
const done = runEvents.filter(event => event.type === 'done');
assert.equal(done.length, 1);
assert.equal(done[0].payload.status, 'succeeded');
const synced = runEvents.find(event => event.payload?.type === 'workspace_synced');
assert.ok(synced && synced.sequence > done[0].sequence, 'Durable workspace synchronization must follow run completion');
assert.ok(!runEvents.some(event => event.payload?.type === 'workspace_warning'));
const eventLogPath = run.eventLogPath;
assert.equal(eventLogPath, `runtime/compose-web/${session.id}.${run.runId}.events.jsonl`);
const eventLogBefore = localFile(eventLogPath);
const events = eventLogBefore.toString('utf8').trim().split('\n').map(JSON.parse);
assert.equal(events.at(-1).type, 'done');
assert.equal(events.at(-1).status, 'succeeded');

assert.deepEqual(await json(`${base}/messages`), before, 'Verification changed task history');
assert.deepEqual(localFile(metadataPath), metadataBefore, 'Verification changed execution metadata');
assert.deepEqual(localFile(nativePath), nativeBefore, 'Verification changed native context');
assert.deepEqual(localFile(eventLogPath), eventLogBefore, 'Verification changed runtime events');
console.log(JSON.stringify({ taskId, stage, taskStatus: before.task.status, executionSessionId: session.id,
  sandboxId: session.sandboxId, piSessionId: session.piSessionId, runId: run.runId, archivePath,
  workspaceState: listing.state, synchronization: listing.synchronization, files: verifiedFiles,
  expectedFixtureSha256: hash(expectedOutput), ...verification, nativeSessionPath: nativePath,
  nativeBytes: nativeBefore.length, nativeSha256: hash(nativeBefore), runtimeReleased: Boolean(session.runtimeReleased),
  workspaceSyncDurable: true, taskHistoryUnchanged: true, executionMetadataUnchanged: true,
  nativeContextUnchanged: true, runtimeEventsUnchanged: true }, null, 2));
