import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AgentComposeRuntime } from '../packages/agent-runtime/agent-compose-runtime.mjs';

const base = new URL('../runtime/compose-runtime-tests/', import.meta.url);
function fixture(t) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base.pathname.replace(/^\/(?=[A-Z]:)/, ''), 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sandboxes = new Map();
  let serial = 0;
  const counts = { boot: 0, model: 0 };
  const executor = {
    async up() { return { project: { id: 'p'.repeat(64) } }; },
    async bootstrap(onUpdate) {
      counts.boot++;
      const id = (++serial).toString(16).padStart(64, '0');
      const workspace_path = `/data/sandboxes/2026/10/20/${id}/workspace`;
      const workspace = path.join(root, 'runtime/agent-compose', workspace_path);
      for (const name of ['input', 'output', 'work', 'tool-drafts']) fs.mkdirSync(path.join(workspace, name), { recursive: true });
      sandboxes.set(id, { sandbox_id: id, workspace_path, driver: 'docker', vm_status: 'running' });
      const run = { id: `boot-${serial}`, sandbox_id: id, status: 'succeeded', exit_code: 0 };
      await onUpdate(run);
      return run;
    },
    async wait() { throw new Error('unexpected bootstrap retry'); },
    async inspectSandbox(id) { return sandboxes.get(id); },
  };
  const rpc = {
    async hasActiveRuns() { return false; },
    async run(request, callbacks) {
      counts.model++;
      const runId = randomUUID();
      const threadId = `thread-${request.sandboxId}`;
      await callbacks.onStarted({ runId, sandboxId: request.sandboxId, status: 'running' });
      await callbacks.onAgentEvent({ name: 'step_start', payload: { step: 1 } });
      await callbacks.onAgentEvent({ name: 'text_delta', payload: { step: 1, text: '完成' } });
      await callbacks.onAgentEvent({ name: 'step_end', payload: { step: 1, stopReason: 'stop', rawStopReason: 'stop' } });
      const result = { provider: 'pi', threadId, finalText: '完成', finalTextSource: 'provider_message' };
      const sandbox = sandboxes.get(request.sandboxId);
      const provider = path.join(root, 'runtime/agent-compose', sandbox.workspace_path, '../state/agents/providers');
      fs.mkdirSync(path.join(provider, 'pi/sessions'), { recursive: true });
      fs.writeFileSync(path.join(provider, 'pi.json'), JSON.stringify({ threadId }));
      const file = path.join(provider, 'pi/sessions/context.jsonl');
      if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: 'session', id: threadId, cwd: '/workspace' }) + '\n');
      fs.appendFileSync(file, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [] } }) + '\n');
      await callbacks.onTurnCompleted(JSON.stringify({ ...result, type: 'agent_turn_completed', stopReason: 'completed' }));
      return { runId, sandboxId: request.sandboxId, status: 'succeeded', resultJson: JSON.stringify({ ...result, type: 'result', stopReason: 'eof' }) };
    },
  };
  const make = () => new AgentComposeRuntime({ root, executor, rpc });
  return { root, executor, rpc, counts, sandboxes, make, runtime: make() };
}

test('creating a task saves metadata without creating containers or calling a model', async t => {
  const f = fixture(t); const session = await f.runtime.create();
  assert.equal(session.status, 'idle');
  assert.deepEqual(f.counts, { boot: 0, model: 0 });
  assert.equal((await f.make().status(session.id)).backend, 'agent-compose');
  assert.equal((await f.runtime.describe(session.id)).workspacePath, null);
});

test('two turns and a new runtime instance preserve sandbox, Pi context and completed metadata', async t => {
  const f = fixture(t); const session = await f.runtime.create(); const events = [];
  await f.runtime.run({ sessionId: session.id, message: 'first' }, e => events.push(e));
  const first = await f.runtime.status(session.id);
  await f.make().run({ sessionId: session.id, message: 'second' }, e => events.push(e));
  const second = await f.runtime.status(session.id);
  assert.equal(second.sandboxId, first.sandboxId);
  assert.equal(second.piSessionId, first.piSessionId);
  assert.equal(second.runs.length, 2);
  assert.ok(second.runs.every(r => r.status === 'succeeded'));
  assert.notEqual(second.runs[0].runId, second.runs[1].runId);
  assert.deepEqual(f.counts, { boot: 1, model: 2 });
  assert.deepEqual(events.slice(-3).map(e => e.type), ['assistant_message', 'run_status', 'done']);
  assert.equal(events.at(-1).piSessionId, first.piSessionId);
  assert.match((await f.runtime.describe(session.id)).workspacePath, /^runtime\/agent-compose\/data\/sandboxes\//);
});

test('different tasks get distinct sandbox directories and seeded input', async t => {
  const f = fixture(t); const a = await f.runtime.create(); const b = await f.runtime.create();
  await f.runtime.run({ sessionId: a.id, message: 'a' }, () => {});
  await f.runtime.run({ sessionId: b.id, message: 'b' }, () => {});
  const one = await f.runtime.status(a.id); const two = await f.runtime.status(b.id);
  assert.notEqual(one.sandboxId, two.sandboxId);
  for (const id of [a.id, b.id]) {
    const description = await f.runtime.describe(id);
    assert.equal(fs.readFileSync(path.join(f.root, description.workspacePath, 'input/numbers.csv'), 'utf8'), 'value\n10\n20\n30\n40\n');
  }
});

test('missing persisted Pi context fails instead of silently creating an empty conversation', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  await f.runtime.run({ sessionId: s.id, message: 'first' }, () => {});
  const saved = await f.runtime.status(s.id);
  fs.unlinkSync(path.join(f.root, saved.workspacePath, '../state/agents/providers/pi/sessions/context.jsonl'));
  const events = []; await f.make().run({ sessionId: s.id, message: 'second' }, e => events.push(e));
  assert.equal(events.at(-1).status, 'failed');
  assert.equal(f.counts.model, 1);
});

test('a detached active run blocks another model submission after restart', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  await f.runtime.ensureWorkspace(s.id);
  f.rpc.hasActiveRuns = async () => true;
  const events = []; await f.make().run({ sessionId: s.id, message: 'retry' }, e => events.push(e));
  assert.equal(events.at(-1).status, 'failed');
  assert.equal(f.counts.model, 0);
});

test('transport failures preserve the received run ID and do not expose raw error details', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  f.rpc.run = async (request, cb) => {
    await cb.onStarted({ runId: 'known-run', sandboxId: request.sandboxId, status: 'running' });
    throw new Error('Bearer PRIVATE_SECRET');
  };
  const events = []; await f.runtime.run({ sessionId: s.id, message: 'go' }, e => events.push(e));
  assert.equal((await f.runtime.status(s.id)).currentRunId, 'known-run');
  assert.equal(events.at(-1).status, 'failed');
  assert.ok(!JSON.stringify(events).includes('PRIVATE_SECRET'));
});

test('malformed or escaping controller workspace paths are rejected before model execution', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  f.executor.inspectSandbox = async id => ({ sandbox_id: id, driver: 'docker', workspace_path: '/data/../../elsewhere' });
  const events = []; await f.runtime.run({ sessionId: s.id, message: 'go' }, e => events.push(e));
  assert.equal(events.at(-1).status, 'failed');
  assert.equal(f.counts.model, 0);
});

test('initialization resumes after the sample was written but readiness was not saved', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  const saved = await f.runtime.ensureWorkspace(s.id);
  saved.workspaceReady = false;
  f.runtime.store.save(saved);
  f.executor.wait = async (id, cb) => cb({ id, sandbox_id: saved.sandboxId, status: 'succeeded', exit_code: 0 });
  const recovered = await f.make().ensureWorkspace(s.id);
  assert.equal(recovered.workspaceReady, true);
  assert.equal(f.counts.boot, 1);
});

test('a failed first accepted turn recovers its native Pi context before a retry', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  const success = f.rpc.run;
  f.rpc.run = async (...args) => { await success(...args); throw new Error('lost final frame'); };
  await f.runtime.run({ sessionId: s.id, message: 'first' }, () => {});
  f.rpc.run = success;
  await f.make().run({ sessionId: s.id, message: 'second' }, () => {});
  const saved = await f.runtime.status(s.id);
  assert.equal(saved.runs[1].status, 'succeeded');
  assert.equal(saved.piSessionId, `thread-${saved.sandboxId}`);
  assert.equal(saved.runs[0].outcomeUnconfirmed, true);
});

test('simultaneous turns on one execution session cannot both be submitted', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const success = f.rpc.run;
  f.rpc.run = async (...args) => { entered(); await gate; return success(...args); };
  const first = f.runtime.run({ sessionId: s.id, message: 'first' }, () => {});
  await ready;
  await assert.rejects(f.runtime.run({ sessionId: s.id, message: 'duplicate' }, () => {}), /already running/);
  release(); await first;
  assert.equal(f.counts.model, 1);
});

test('a failed controller status check prevents an uncertain duplicate model run', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  f.rpc.hasActiveRuns = async () => { throw new Error('controller offline'); };
  const events = [];
  await f.runtime.run({ sessionId: s.id, message: 'go' }, e => events.push(e));
  assert.equal(events.at(-1).status, 'failed');
  assert.equal(f.counts.model, 0);
});
