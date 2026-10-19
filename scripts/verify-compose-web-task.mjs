// Read-only acceptance check for the web statistics exercise; no model calls.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ComposeSessionStore, executionId } from '../packages/agent-runtime/compose-session-store.mjs';
import { verifyComposeFileTask } from './lib/verify-compose-file-task.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const [taskId, ...extra] = process.argv.slice(2);
assert.ok(executionId.test(taskId) && !extra.length, 'Usage: node scripts/verify-compose-web-task.mjs <taskId>');
const response = await fetch(`http://127.0.0.1:3000/v1/tasks/${taskId}/messages`);
assert.equal(response.status, 200);
const history = await response.json();
assert.equal(history.task.status, 'idle');
assert.equal(history.execution.backend, 'agent-compose');
const store = new ComposeSessionStore(root);
const session = store.load(history.task.executionSessionId);
store.assertConversation(session);
assert.equal(session.piSessionId, history.task.piSessionId);
assert.equal(session.workspacePath, history.execution.workspacePath);
assert.equal(session.currentRunId, history.task.currentRunId);
assert.equal(session.runs.at(-1).status, 'succeeded');
const workspace = path.join(root, session.workspacePath);
assert.equal(fs.realpathSync(workspace), workspace);
const directory = path.join(workspace, '../state/agents/providers/pi/sessions');
const files = fs.readdirSync(directory).filter(name => name.endsWith('.jsonl')).map(name => path.join(directory, name));
const native = files.find(file => JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).id === session.piSessionId);
assert.ok(native);
const sessionJsonl = fs.readFileSync(native, 'utf8');
const resultFile = path.join(workspace, 'output/result.json');
assert.equal(fs.realpathSync(resultFile), resultFile);
const report = verifyComposeFileTask({ sessionJsonl, csv: fs.readFileSync(path.join(workspace, 'input/numbers.csv'), 'utf8'),
  resultJson: fs.readFileSync(resultFile, 'utf8') });
assert.equal(history.runEvents.filter(e => e.type === 'tool_start').length, report.toolCalls);
assert.equal(history.runEvents.filter(e => e.type === 'tool_end').length, report.toolResults);
const log = session.runs.at(-1).eventLogPath;
assert.equal(log, `runtime/compose-web/${session.id}.${session.currentRunId}.events.jsonl`);
const events = fs.readFileSync(path.join(root, log), 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(events.at(-1).type, 'done');
assert.equal(events.at(-1).status, 'succeeded');
assert.equal(history.messages.at(-1).status, 'complete');
console.log(JSON.stringify({ taskId, executionSessionId: session.id, sandboxId: session.sandboxId,
  piSessionId: session.piSessionId, runIds: session.runs.map(run => run.runId), workspacePath: session.workspacePath,
  nativeSessionPath: path.relative(root, native), nativeBytes: Buffer.byteLength(sessionJsonl),
  nativeSha256: createHash('sha256').update(sessionJsonl).digest('hex'),
  messageCount: history.messages.length, ...report }, null, 2));
