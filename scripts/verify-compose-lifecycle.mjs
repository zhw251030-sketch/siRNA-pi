// Read-only checks for a dedicated lifecycle exercise. No model call or stop command.
// First capture scripts/verify-compose-web-task.mjs output as a private baseline.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ComposeSessionStore, executionId } from '../packages/agent-runtime/compose-session-store.mjs';
import { AgentComposeRpcClient } from '../packages/agent-runtime/agent-compose-rpc.mjs';
import { readComposeControlToken } from '../packages/agent-runtime/compose-control-token.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const [taskId, stage, baselinePath, ...extra] = process.argv.slice(2);
assert.ok(executionId.test(taskId) && ['canceled', 'resumed', 'ended'].includes(stage) && baselinePath && !extra.length,
  'Usage: node scripts/verify-compose-lifecycle.mjs <taskId> canceled|resumed|ended <project-relative-baseline.json>');
function projectFile(relative) {
  const absolute = path.resolve(root, relative);
  assert.ok(absolute.startsWith(root + path.sep));
  assert.equal(fs.realpathSync(absolute), absolute);
  return absolute;
}
const baseline = JSON.parse(fs.readFileSync(projectFile(baselinePath), 'utf8'));
assert.equal(baseline.taskId, taskId);
const response = await fetch(`http://127.0.0.1:3000/v1/tasks/${taskId}/messages`);
assert.equal(response.status, 200);
const history = await response.json();
const store = new ComposeSessionStore(root);
const session = store.load(history.task.executionSessionId);
for (const [actual, expected] of [[session.id, baseline.executionSessionId], [session.sandboxId, baseline.sandboxId],
  [session.piSessionId, baseline.piSessionId], [session.workspacePath, baseline.workspacePath],
  [history.task.piSessionId, baseline.piSessionId], [history.task.currentRunId, session.currentRunId]]) assert.equal(actual, expected);
store.assertConversation(session);
const expectedStatuses = stage === 'canceled' ? ['succeeded', 'canceled']
  : stage === 'resumed' ? ['succeeded', 'canceled', 'succeeded'] : ['succeeded', 'canceled', 'succeeded', 'canceled'];
assert.deepEqual(session.runs.map(run => run.status), expectedStatuses);
assert.equal(history.task.status, stage === 'ended' ? 'stopped' : 'idle');
assert.equal(session.status, history.task.status);
assert.equal(history.messages.length, expectedStatuses.length * 2);
const native = fs.readFileSync(projectFile(baseline.nativeSessionPath));
assert.ok(native.length >= baseline.nativeBytes);
assert.equal(createHash('sha256').update(native.subarray(0, baseline.nativeBytes)).digest('hex'), baseline.nativeSha256);
const result = JSON.parse(fs.readFileSync(projectFile(`${session.workspacePath}/output/result.json`), 'utf8'));
assert.deepEqual(result, baseline.result);
for (const run of session.runs) {
  const events = fs.readFileSync(projectFile(run.eventLogPath), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).status, run.status);
  assert.ok(history.runEvents.some(record => record.runId === run.runId && record.type === 'done' && record.payload.status === run.status));
}
const rpc = new AgentComposeRpcClient({ token: readComposeControlToken(root) });
try {
  assert.equal(await rpc.hasActiveRuns(session.sandboxId), false);
  for (const run of session.runs) {
    const actual = await rpc.getRun(run.runId);
    assert.equal(actual.sandboxId, session.sandboxId);
    assert.equal(actual.status, run.daemonStatus ?? run.status);
    if (run.status === 'canceled' && actual.status === 'failed') {
      assert.equal(run.userCancelRequested, true);
      assert.equal(actual.error, 'context canceled');
      assert.ok(!actual.cleanupError);
    }
  }
} finally { rpc.close(); }
const command = (script, ...args) => execFileSync('sh', [path.join(root, 'scripts', script), ...args],
  { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 }).trim();
const sandbox = JSON.parse(command('project-agent-compose.sh', 'inspect', 'sandbox', session.sandboxId));
assert.equal(store.workspace(sandbox), session.workspacePath);
const guests = command('project-docker.sh', 'container', 'ls', '--all', '--quiet',
  '--filter', `label=agent-compose.sandbox_id=${session.sandboxId}`).split('\n').filter(Boolean);
if (stage === 'ended') {
  assert.equal(sandbox.vm_status, 'stopped');
  assert.equal(sandbox.stopped_runtime_state, 'released');
  assert.equal(session.runtimeReleased, true);
  assert.equal(guests.length, 0);
} else {
  assert.equal(sandbox.vm_status, 'running');
  assert.equal(guests.length, 1);
}
console.log(JSON.stringify({ taskId, stage, executionSessionId: session.id, sandboxId: session.sandboxId,
  piSessionId: session.piSessionId, runIds: session.runs.map(run => run.runId), statuses: expectedStatuses,
  daemonStatuses: session.runs.map(run => run.daemonStatus ?? run.status),
  taskStatus: history.task.status, vmStatus: sandbox.vm_status, runtimeState: sandbox.stopped_runtime_state,
  releaseOutcome: session.releaseOutcome, guestCount: guests.length, activeRuns: false,
  nativeBytes: native.length, baselinePrefixUnchanged: true, result, messageCount: history.messages.length }, null, 2));
