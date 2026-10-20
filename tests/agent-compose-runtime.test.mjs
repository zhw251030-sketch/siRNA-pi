import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AgentComposeRuntime } from '../packages/agent-runtime/agent-compose-runtime.mjs';
import { createToolCallLeases } from '../packages/capability-platform/tool-call-leases.mjs';

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
    async release(id) {
      const sandbox = sandboxes.get(id);
      return { ...sandbox, vm_status: 'stopped', stopped_runtime_state: 'released' };
    },
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
  const make = (options = {}) => new AgentComposeRuntime({ root, executor, rpc, ...options });
  return { root, executor, rpc, counts, sandboxes, make, runtime: make() };
}

test('web tool lease is activated with daemon identity, drained before done and removed from workspace', {timeout:2000}, async t => {
  const f = fixture(t); const taskId = randomUUID(); const token = 'a'.repeat(64); const calls = []; let context;
  let release; const gate = new Promise(resolve => { release = resolve; }); let closing;
  const entered = new Promise(resolve => { closing = resolve; });
  const leases = { begin(binding) {
    calls.push(['begin', binding]);
    context = { protocolVersion: 'sirna-task-context/v1', taskId, agentTurnId: binding.agentTurnId, token };
    return { context, activate(id) { calls.push(['activate', id]); }, async close() { closing(); await gate; calls.push(['close']); } };
  } };
  const runtime = f.make({ toolCallLeases: leases }); const session = await runtime.create(); const events = [];
  const run = runtime.run({ taskId, sessionId: session.id, message: 'call tool' }, e => events.push(e));
  await entered;
  const saved = await runtime.status(session.id);
  const file = path.join(f.root, saved.workspacePath, '.sirna-task-context.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), context);
  assert.equal(calls[0][1].executionSessionId, session.id);
  assert.equal(calls[0][1].sandboxId, saved.sandboxId);
  assert.equal(calls[1][1], saved.currentRunId);
  assert.notEqual(calls[0][1].agentTurnId, saved.currentRunId);
  assert.equal(events.some(e => e.type === 'done'), false);
  release(); await run;
  assert.equal(events.at(-1).status, 'succeeded');
  assert.equal(fs.existsSync(file), false);
  assert.equal(calls.filter(c => c[0] === 'close').length, 1);
  assert.equal(JSON.stringify(events).includes(token), false);
  assert.equal(JSON.stringify(await runtime.status(session.id)).includes(token), false);
});
test('builder availability is recorded for new workspaces and cleanup failure still removes capability context',async t=>{
  const f=fixture(t);const taskId=randomUUID();let context;
  const leases={begin(binding){context={protocolVersion:'sirna-task-context/v1',taskId,agentTurnId:binding.agentTurnId,token:'a'.repeat(64)};return {context,activate(){},async close(){throw new Error('cleanup unknown');}};}};
  const runtime=f.make({toolCallLeases:leases,toolBuildersAvailable:true});const created=await runtime.create();const events=[];
  assert.equal((await runtime.describe(created.id)).builderToolsAvailable,true);await runtime.run({taskId,sessionId:created.id,message:'build'},event=>events.push(event));
  const saved=await runtime.status(created.id);assert.equal(saved.remoteBuilderTools,true);assert.equal(events.at(-1).status,'failed');assert.equal(fs.existsSync(path.join(f.root,saved.workspacePath,'.sirna-task-context.json')),false);
});

test('failed submission still closes its pending capability before emitting failure', async t => {
  const f = fixture(t); const taskId = randomUUID(); let closed = false; let file;
  const runtime = f.make({ toolCallLeases: { begin(binding) {
    return { context: { protocolVersion: 'sirna-task-context/v1', taskId, agentTurnId: binding.agentTurnId, token: 'b'.repeat(64) },
      activate() { throw new Error('must not activate'); }, async close() { closed = true; } };
  } } });
  const session = await runtime.create();
  f.rpc.run = async () => { file = path.join(f.root, (await runtime.status(session.id)).workspacePath, '.sirna-task-context.json'); throw new Error('transport unavailable'); };
  const events = [];
  await runtime.run({ taskId, sessionId: session.id, message: 'go' }, e => { if (e.type === 'done') assert.equal(closed, true); events.push(e); });
  assert.equal(events.at(-1).status, 'failed'); assert.equal(fs.existsSync(file), false);
});

test('old guest revision is explicitly unsupported for approved tools and receives no capability', async t => {
  const f=fixture(t);const session=await f.runtime.create();await f.runtime.ensureWorkspace(session.id);
  const runtime=f.make({toolCallLeases:{begin(){throw new Error('old guest must not receive a lease');}}});
  const events=[];await runtime.run({taskId:randomUUID(),sessionId:session.id,message:'old fixed tool task'},e=>events.push(e));
  assert.equal(events.at(-1).status,'succeeded');
  assert.equal((await runtime.describe(session.id)).approvedToolsAvailable,false);
  assert.ok(events.some(e=>e.type==='progress_message'&&e.text.includes('新建任务')));
  assert.equal(fs.existsSync(path.join(f.root,(await runtime.status(session.id)).workspacePath,'.sirna-task-context.json')),false);
});

test('cancel after RPC submission but before started keeps the confirmed canceled outcome with real leases', async t => {
  const f=fixture(t);const controller=new AbortController();const leases=createToolCallLeases();
  const runtime=f.make({toolCallLeases:leases});const session=await runtime.create();const original=f.rpc.run;
  f.rpc.run=async(request,callbacks)=>{controller.abort();const result=await original(request,callbacks);return {...result,status:'canceled'};};
  const events=[];await runtime.run({taskId:randomUUID(),sessionId:session.id,message:'cancel on startup'},e=>events.push(e),controller.signal);
  assert.equal(events.at(-1).status,'canceled');
  const saved=await runtime.status(session.id);assert.equal(saved.runs.at(-1).status,'canceled');
  assert.notEqual(saved.runs.at(-1).outcomeUnconfirmed,true);
  assert.equal(fs.existsSync(path.join(f.root,saved.workspacePath,'.sirna-task-context.json')),false);
});

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

test('canceling an accepted turn saves canceled without a fake successful answer and permits same-context continuation', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  await f.runtime.run({ sessionId: s.id, message: 'first' }, () => {});
  const previous = await f.runtime.status(s.id); const success = f.rpc.run;
  let started; const ready = new Promise(resolve => { started = resolve; });
  f.rpc.run = async (request, cb) => {
    await cb.onStarted({ runId: 'cancel-me', sandboxId: request.sandboxId, status: 'running' });
    started();
    await new Promise(resolve => cb.signal.addEventListener('abort', resolve, { once: true }));
    return { runId: 'cancel-me', sandboxId: request.sandboxId, status: 'canceled' };
  };
  const events = []; const running = f.runtime.run({ sessionId: s.id, message: 'long turn' }, e => events.push(e));
  await ready;
  assert.equal((await f.runtime.cancel(s.id)).status, 'running');
  await running;
  const canceled = await f.runtime.status(s.id);
  assert.equal(canceled.status, 'idle');
  assert.equal(canceled.runs.at(-1).status, 'canceled');
  assert.equal(canceled.piSessionId, previous.piSessionId);
  assert.equal(events.at(-1).status, 'canceled');
  assert.ok(!events.some(e => ['error', 'assistant_message'].includes(e.type)));
  f.rpc.run = success;
  await f.runtime.run({ sessionId: s.id, message: 'continue' }, () => {});
  assert.equal((await f.runtime.status(s.id)).piSessionId, previous.piSessionId);
  assert.equal(f.counts.boot, 1);
});

test('cancel during initialization finishes only fixed setup and never submits a model prompt', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const boot = f.executor.bootstrap;
  f.executor.bootstrap = async cb => { entered(); await gate; return boot(cb); };
  const events = []; const running = f.runtime.run({ sessionId: s.id, message: 'stop before model' }, e => events.push(e));
  await ready; await f.runtime.cancel(s.id); unblock(); await running;
  assert.equal(f.counts.model, 0);
  assert.equal(events.at(-1).status, 'canceled');
  assert.equal((await f.runtime.status(s.id)).status, 'idle');
});

test('a cancellation latched before runtime dispatch creates neither a guest nor a model request', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const c = new AbortController(); c.abort();
  const events = []; await f.runtime.run({ sessionId: s.id, message: 'stop' }, e => events.push(e), c.signal);
  assert.deepEqual(f.counts, { boot: 0, model: 0 });
  assert.equal(events.at(-1).status, 'canceled');
});

test('ending releases only this sandbox, keeps files and history, and permanently rejects new runs', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  await f.runtime.run({ sessionId: s.id, message: 'first' }, () => {});
  const before = await f.runtime.status(s.id);
  const file = path.join(f.root, before.workspacePath, 'output/keep.txt'); fs.writeFileSync(file, 'preserve me');
  const ended = await f.runtime.remove(s.id);
  assert.equal(ended.status, 'stopped'); assert.equal(ended.runtimeReleased, true);
  assert.equal(ended.sandboxId, before.sandboxId); assert.equal(ended.piSessionId, before.piSessionId);
  assert.deepEqual(ended.runs, before.runs); assert.equal(fs.readFileSync(file, 'utf8'), 'preserve me');
  await assert.rejects(f.runtime.run({ sessionId: s.id, message: 'no' }, () => {}), /ended/);
  assert.equal((await f.runtime.remove(s.id)).status, 'stopped');
  assert.equal(f.counts.model, 1);
});

test('failed or unconfirmed resource release cannot mark a task stopped', async t => {
  const f = fixture(t); const s = await f.runtime.create(); await f.runtime.ensureWorkspace(s.id);
  f.executor.release = async id => ({ ...f.sandboxes.get(id), vm_status: 'stopped', stopped_runtime_state: 'release-failed' });
  await assert.rejects(f.runtime.remove(s.id), /release/);
  assert.notEqual((await f.runtime.status(s.id)).status, 'stopped');
});

test('a release in flight blocks a new turn before any model request', async t => {
  const f = fixture(t); const s = await f.runtime.create(); await f.runtime.ensureWorkspace(s.id);
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const release = f.executor.release;
  f.executor.release = async id => { entered(); await gate; return release(id); };
  const ending = f.runtime.remove(s.id); await ready;
  await assert.rejects(f.runtime.run({ sessionId: s.id, message: 'race' }, () => {}), /ending/);
  unblock(); await ending; assert.equal(f.counts.model, 0);
});

test('ending an unused task requires no container and remains idempotent', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  assert.equal((await f.runtime.remove(s.id)).status, 'stopped');
  assert.equal((await f.runtime.remove(s.id)).status, 'stopped');
  assert.deepEqual(f.counts, { boot: 0, model: 0 });
});

async function detached(f, id) {
  const session = await f.runtime.ensureWorkspace(id);
  session.status = 'running';
  session.currentRunId = 'detached-run';
  session.runs.push({ runId: 'detached-run', status: 'running', accepted: true });
  f.runtime.store.save(session);
  return session;
}

test('restart exposes an accepted running turn as unconfirmed before a failed retry', async t => {
  const f = fixture(t); const s = await f.runtime.create(); await detached(f, s.id);
  assert.equal((await f.make().describe(s.id)).stopUnconfirmed, true);
});

test('an unconfirmed stop before daemon identity was saved remains visible after restart', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  s.status = 'failed'; s.runs.push({ runId: 'local-request', status: 'failed', stopUnconfirmed: true });
  f.runtime.store.save(s);
  assert.equal((await f.make().describe(s.id)).stopUnconfirmed, true);
  await assert.rejects(f.make().cancel(s.id), /unconfirmed|identity|run id/i);
});

test('a blocked retry cannot hide the older accepted detached cancellation target', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const saved = await detached(f, s.id);
  f.rpc.hasActiveRuns = async () => true;
  const runtime = f.make();
  await runtime.run({ sessionId: s.id, message: 'blocked retry' }, () => {});
  const before = await runtime.status(s.id);
  assert.equal(before.runs.at(-1).accepted, undefined);
  assert.equal((await runtime.describe(s.id)).stopUnconfirmed, true);
  const targets = [];
  f.rpc.getRun = async id => { targets.push(id); return { runId: id, sandboxId: saved.sandboxId, status: 'running' }; };
  f.rpc.stopRunAndWait = async id => { targets.push(id); return { runId: id, sandboxId: saved.sandboxId, status: 'canceled' }; };
  const canceled = await runtime.cancel(s.id);
  assert.deepEqual(targets, ['detached-run', 'detached-run']);
  assert.equal(canceled.runs[0].status, 'canceled');
  assert.equal(canceled.runs.at(-1).status, 'failed');
  assert.equal(f.counts.model, 0);
});

test('cancel on a normally completed idle turn is a no-op without querying or changing history', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  await f.runtime.run({ sessionId: s.id, message: 'complete' }, () => {});
  const before = await f.runtime.status(s.id);
  f.rpc.getRun = async () => { throw new Error('must not query a completed turn'); };
  const after = await f.make().cancel(s.id);
  assert.deepEqual(after, before);
  assert.equal((await f.make().describe(s.id)).stopUnconfirmed, false);
});

test('a newer accepted completed turn supersedes historical stop uncertainty without changing history', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  await f.runtime.run({ sessionId: s.id, message: 'create native context' }, () => {});
  const saved = await detached(f, s.id);
  Object.assign(saved.runs.at(-1), { status: 'failed', stopUnconfirmed: true, outcomeUnconfirmed: true });
  saved.runs.push({ runId: 'local-unknown', status: 'failed', stopUnconfirmed: true });
  f.runtime.store.save(saved);
  await f.make().run({ sessionId: s.id, message: 'new accepted turn after confirmed idle preflight' }, () => {});
  const before = await f.runtime.status(s.id);
  assert.equal(before.runs.at(-1).status, 'succeeded');
  f.rpc.getRun = async () => { throw new Error('must not query a superseded historical turn'); };
  assert.equal((await f.make().describe(s.id)).stopUnconfirmed, false);
  assert.deepEqual(await f.make().cancel(s.id), before);
  assert.equal(before.runs[1].stopUnconfirmed, true);
});

for (const failure of ['get', 'stop', 'identity']) {
  test(`detached cancellation ${failure} failure persists uncertainty for another attempt`, async t => {
    const f = fixture(t); const s = await f.runtime.create(); const saved = await detached(f, s.id);
    f.rpc.getRun = async id => {
      if (failure === 'get') throw new Error('controller offline');
      return { runId: failure === 'identity' ? 'wrong-run' : id, sandboxId: saved.sandboxId, status: 'running' };
    };
    f.rpc.stopRunAndWait = async () => { throw new Error('stop offline'); };
    await assert.rejects(f.make().cancel(s.id));
    const after = await f.runtime.status(s.id);
    assert.equal(after.runs[0].stopUnconfirmed, true);
    assert.notEqual(after.runs[0].status, 'canceled');
    assert.equal((await f.make().describe(s.id)).stopUnconfirmed, true);
  });
}

test('detached confirmed cancellation recovers native context and clears a stale context warning', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  await f.runtime.run({ sessionId: s.id, message: 'context' }, () => {});
  const saved = await detached(f, s.id); const threadId = saved.piSessionId;
  delete saved.piSessionId; saved.contextUnconfirmed = true; f.runtime.store.save(saved);
  f.rpc.getRun = async id => ({ runId: id, sandboxId: saved.sandboxId, status: 'canceled' });
  const after = await f.make().cancel(s.id);
  assert.equal(after.piSessionId, threadId);
  assert.equal(after.contextUnconfirmed, undefined);
});

test('detached canceled first turn with missing native context records uncertainty instead of starting again', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const saved = await detached(f, s.id);
  f.rpc.getRun = async id => ({ runId: id, sandboxId: saved.sandboxId, status: 'canceled' });
  const after = await f.make().cancel(s.id);
  assert.equal(after.contextUnconfirmed, true);
  assert.equal(after.runs[0].status, 'canceled');
  assert.equal(f.counts.model, 0);
});

test('detached cancellation is shared, blocks a new turn, and cannot resurrect a released task', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const saved = await detached(f, s.id);
  let resolveGet; let entered; const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resolveGet = resolve; }); let queries = 0;
  f.rpc.getRun = async id => { queries++; entered(); await gate; return { runId: id, sandboxId: saved.sandboxId, status: 'canceled' }; };
  const runtime = f.make(); const first = runtime.cancel(s.id); await ready;
  const second = runtime.cancel(s.id);
  const ending = runtime.remove(s.id);
  const blocked = assert.rejects(runtime.run({ sessionId: s.id, message: 'race' }, () => {}), /cancel|ending/i);
  resolveGet(); await Promise.all([first, second, ending, blocked]);
  assert.equal(queries, 1);
  const after = await f.make().status(s.id);
  assert.equal(after.status, 'stopped');
  assert.equal(after.runtimeReleased, true);
  assert.equal(f.counts.model, 0);
});

test('restart exposes unfinished bootstrap and confirmation clears its stop uncertainty', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const saved = await f.runtime.ensureWorkspace(s.id);
  saved.workspaceReady = false; delete saved.bootstrapStatus; f.runtime.store.save(saved);
  const runtime = f.make();
  assert.equal((await runtime.describe(s.id)).stopUnconfirmed, true);
  f.executor.wait = async (id, cb) => cb({ id, sandbox_id: saved.sandboxId, status: 'succeeded', exit_code: 0 });
  const canceled = await runtime.cancel(s.id);
  assert.equal(canceled.bootstrapStatus, 'succeeded');
  assert.equal((await runtime.describe(s.id)).stopUnconfirmed, false);
  assert.equal(f.counts.model, 0);
});

test('cancel after restart lets only fixed bootstrap finish and the next turn reuses that workspace', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const saved = await f.runtime.ensureWorkspace(s.id);
  saved.workspaceReady = false; saved.bootstrapStatus = 'running'; f.runtime.store.save(saved);
  let waits = 0;
  f.executor.wait = async (id, cb) => { waits++; await cb({ id, sandbox_id: saved.sandboxId, status: 'succeeded', exit_code: 0 }); };
  f.rpc.getRun = async () => { throw new Error('fixed bootstrap must not use model cancellation'); };
  f.rpc.stopRunAndWait = async () => { throw new Error('fixed bootstrap must not be stopped'); };
  const runtime = f.make();
  const canceled = await runtime.cancel(s.id);
  assert.equal(canceled.status, 'idle');
  assert.equal(waits, 1);
  assert.equal(f.counts.model, 0);
  await runtime.run({ sessionId: s.id, message: 'continue' }, () => {});
  const after = await runtime.status(s.id);
  assert.equal(after.sandboxId, saved.sandboxId);
  assert.equal(after.runs.at(-1).status, 'succeeded');
  assert.deepEqual(f.counts, { boot: 1, model: 1 });
});

test('release waits for a persisted bootstrap even when its sandbox id is already known', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const saved = await f.runtime.ensureWorkspace(s.id);
  saved.workspaceReady = false; saved.bootstrapStatus = 'running'; f.runtime.store.save(saved);
  let finishSetup; let entered; const gate = new Promise(resolve => { finishSetup = resolve; });
  const ready = new Promise(resolve => { entered = resolve; }); const sequence = [];
  f.executor.wait = async (id, cb) => {
    sequence.push('wait'); entered(); await gate;
    await cb({ id, sandbox_id: saved.sandboxId, status: 'succeeded', exit_code: 0 });
  };
  const release = f.executor.release;
  f.executor.release = async id => { sequence.push('release'); return release(id); };
  const runtime = f.make(); const ending = runtime.remove(s.id);
  await Promise.race([ready, ending.then(() => assert.fail('release finished before waiting for bootstrap'))]);
  assert.deepEqual(sequence, ['wait']);
  await assert.rejects(runtime.run({ sessionId: s.id, message: 'race' }, () => {}), /ending/);
  finishSetup(); await ending;
  assert.deepEqual(sequence, ['wait', 'release']);
  assert.equal(f.counts.boot, 1);
  assert.equal(f.counts.model, 0);
});

test('a bootstrap snapshot with a different sandbox cannot redirect resource release', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const saved = await f.runtime.ensureWorkspace(s.id);
  saved.workspaceReady = false; saved.bootstrapStatus = 'running'; f.runtime.store.save(saved); let releases = 0;
  f.executor.wait = async (id, cb) => cb({ id, sandbox_id: 'f'.repeat(64), status: 'succeeded', exit_code: 0 });
  f.executor.release = async () => { releases++; throw new Error('wrong target released'); };
  await assert.rejects(f.make().remove(s.id), /identity|target/i);
  assert.equal(releases, 0);
  assert.equal((await f.runtime.status(s.id)).sandboxId, saved.sandboxId);
});

test('release still proceeds when the existing bootstrap is confirmed canceled by wait', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const saved = await f.runtime.ensureWorkspace(s.id);
  saved.workspaceReady = false; delete saved.bootstrapStatus; f.runtime.store.save(saved);
  f.executor.wait = async (id, cb) => {
    await cb({ id, sandbox_id: saved.sandboxId, status: 'canceled', exit_code: 1 });
    throw new Error('Workspace initialization failed');
  };
  const after = await f.make().remove(s.id);
  assert.equal(after.status, 'stopped');
  assert.equal(after.runtimeReleased, true);
  assert.equal(after.bootstrapStatus, 'canceled');
  assert.equal(f.counts.boot, 1);
  assert.equal(f.counts.model, 0);
});

for (const external of [false, true]) {
  test(`explicit ${external ? 'external' : 'runtime'} abort recognizes v2609 context-canceled failure and preserves daemon evidence`, async t => {
    const f = fixture(t); const s = await f.runtime.create(); const controller = new AbortController();
    let ready; const started = new Promise(resolve => { ready = resolve; });
    f.rpc.run = async (request, cb) => {
      await cb.onStarted({ runId: 'cancel-context', sandboxId: request.sandboxId, status: 'running' }); ready();
      await new Promise(resolve => cb.signal.addEventListener('abort', () => {
        assert.equal(f.runtime.store.load(s.id).runs.at(-1).userCancelRequested, true);
        resolve();
      }, { once: true }));
      return { runId: 'cancel-context', sandboxId: request.sandboxId, status: 'failed', exitCode: 1, error: 'context canceled', resultJson: '{}' };
    };
    const events = []; const running = f.runtime.run({ sessionId: s.id, message: 'go' }, e => events.push(e), external ? controller.signal : undefined);
    await started;
    if (external) controller.abort(); else await f.runtime.cancel(s.id);
    await running;
    const saved = await f.runtime.status(s.id); const run = saved.runs.at(-1);
    assert.equal(run.status, 'canceled');
    assert.equal(run.daemonStatus, 'failed');
    assert.equal(run.daemonError, 'context canceled');
    assert.equal(run.daemonResultJson, '{}');
    assert.equal(run.daemonExitCode, 1);
    assert.equal(run.userCancelRequested, true);
    assert.equal(events.at(-1).status, 'canceled');
    assert.ok(!events.some(event => ['assistant_message', 'error'].includes(event.type)));
  });
}

for (const failure of [{ error: 'Provider failed' }, { error: 'context canceled', cleanupError: 'Termination not confirmed' }]) {
  test(`explicit abort never hides a distinct daemon failure (${failure.cleanupError || failure.error})`, async t => {
    const f = fixture(t); const s = await f.runtime.create(); let ready; const started = new Promise(resolve => { ready = resolve; });
    f.rpc.run = async (request, cb) => {
      await cb.onStarted({ runId: 'failed-after-stop', sandboxId: request.sandboxId, status: 'running' }); ready();
      await new Promise(resolve => cb.signal.addEventListener('abort', resolve, { once: true }));
      return { runId: 'failed-after-stop', sandboxId: request.sandboxId, status: 'failed', ...failure };
    };
    const events = []; const running = f.runtime.run({ sessionId: s.id, message: 'go' }, e => events.push(e));
    await started; await f.runtime.cancel(s.id); await running;
    const run = (await f.runtime.status(s.id)).runs.at(-1);
    assert.equal(run.status, 'failed');
    assert.equal(run.userCancelRequested, true);
    assert.equal(events.at(-1).status, 'failed');
  });
}

test('a detached failed context-canceled snapshot without prior stop intent remains failed', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const saved = await detached(f, s.id);
  f.rpc.getRun = async id => ({ runId: id, sandboxId: saved.sandboxId, status: 'failed', error: 'context canceled', resultJson: '{}' });
  const after = await f.make().cancel(s.id);
  assert.equal(after.runs.at(-1).status, 'failed');
  assert.equal(after.runs.at(-1).userCancelRequested, undefined);
});

test('detached running cancellation persists intent before StopRun and records the daemon failed outcome as canceled', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const saved = await detached(f, s.id);
  f.rpc.getRun = async id => ({ runId: id, sandboxId: saved.sandboxId, status: 'running' });
  f.rpc.stopRunAndWait = async id => {
    assert.equal(f.runtime.store.load(s.id).runs.at(-1).userCancelRequested, true);
    return { runId: id, sandboxId: saved.sandboxId, status: 'failed', error: 'context canceled', resultJson: '{}' };
  };
  const after = await f.make().cancel(s.id); const run = after.runs.at(-1);
  assert.equal(run.status, 'canceled'); assert.equal(run.daemonStatus, 'failed');
  assert.equal(run.outcomeUnconfirmed, undefined);
});

test('restart recognizes the exact canceled daemon failure only with an earlier persisted stop request', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const saved = await detached(f, s.id);
  saved.runs.at(-1).userCancelRequested = true; f.runtime.store.save(saved);
  f.rpc.getRun = async id => ({ runId: id, sandboxId: saved.sandboxId, status: 'failed', error: 'context canceled' });
  const after = await f.make().cancel(s.id);
  assert.equal(after.runs.at(-1).status, 'canceled');
  assert.equal(after.runs.at(-1).daemonStatus, 'failed');
});

test('failure to persist stop intent remains owned by the run while RPC still receives abort', async t => {
  const f = fixture(t); const s = await f.runtime.create(); let ready; const started = new Promise(resolve => { ready = resolve; });
  let abortReachedRpc = false;
  f.rpc.run = async (request, cb) => {
    await cb.onStarted({ runId: 'stop-save-failure', sandboxId: request.sandboxId, status: 'running' }); ready();
    await new Promise(resolve => cb.signal.addEventListener('abort', () => { abortReachedRpc = true; resolve(); }, { once: true }));
    return { runId: 'stop-save-failure', sandboxId: request.sandboxId, status: 'canceled' };
  };
  const save = f.runtime.store.save.bind(f.runtime.store); let failures = 0;
  f.runtime.store.save = session => {
    if (session.runs.at(-1)?.userCancelRequested && failures++ === 0) throw new Error('injected stop-intent storage failure');
    return save(session);
  };
  const events = []; const running = f.runtime.run({ sessionId: s.id, message: 'go' }, e => events.push(e));
  await started; await f.runtime.cancel(s.id); await running;
  const run = (await f.runtime.status(s.id)).runs.at(-1);
  assert.equal(abortReachedRpc, true);
  assert.equal(run.userCancelRequested, undefined);
  assert.equal(run.status, 'failed');
  assert.equal(events.at(-1).status, 'failed');
  assert.ok(!events.some(event => event.status === 'canceled' || event.type === 'assistant_message'));
});

test('workspace preparation hydrates real input after idle preflight and before model submission', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const order = []; let prompt;
  f.rpc.hasActiveRuns = async id => {
    const saved = f.runtime.store.load(s.id);
    assert.equal(saved.workspaceReady, true);
    assert.equal(saved.sandboxId, id);
    assert.equal(fs.existsSync(path.join(f.root, saved.workspacePath, 'input/upload.csv')), false);
    order.push('idle'); return false;
  };
  const run = f.rpc.run;
  f.rpc.run = async (request, callbacks) => {
    order.push('model'); prompt = request.prompt;
    const saved = f.runtime.store.load(s.id);
    assert.equal(fs.readFileSync(path.join(f.root, saved.workspacePath, 'input/upload.csv'), 'utf8'), 'value\n7\n');
    return run(request, callbacks);
  };
  const events = [];
  await f.runtime.run({ sessionId: s.id, message: 'use my input', prepareWorkspace: async () => {
    order.push('hydrate'); const saved = await f.runtime.status(s.id);
    fs.writeFileSync(path.join(f.root, saved.workspacePath, 'input/upload.csv'), 'value\n7\n');
    return ['upload.csv'];
  } }, e => events.push(e));
  assert.deepEqual(order, ['idle', 'hydrate', 'model']);
  assert.equal(events.at(-1).status, 'succeeded');
  assert.match(prompt, /input\//); assert.match(prompt, /output\//);
  assert.match(prompt, /upload\.csv/); assert.doesNotMatch(prompt, /value\n7\n/);
});

test('workspace preparation failure saves a failed turn without submitting a model request', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const events = [];
  await f.runtime.run({ sessionId: s.id, message: 'go', prepareWorkspace: async () => {
    throw new Error('archive hydration failed');
  } }, e => events.push(e));
  assert.equal(f.counts.model, 0);
  assert.equal(events.at(-1).status, 'failed');
  assert.equal((await f.runtime.status(s.id)).runs.at(-1).accepted, undefined);
});

test('abort during workspace preparation cancels before model submission', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const controller = new AbortController(); const events = [];
  await f.runtime.run({ sessionId: s.id, message: 'go', prepareWorkspace: async () => {
    await Promise.resolve(); controller.abort(); return ['upload.csv'];
  } }, e => events.push(e), controller.signal);
  assert.equal(f.counts.model, 0);
  assert.equal(events.at(-1).status, 'canceled');
  assert.equal((await f.runtime.status(s.id)).runs.at(-1).accepted, undefined);
});

for (const names of [Array.from({ length: 70 }, (_, i) => `upload-${i}.csv`),
  Array.from({ length: 50 }, (_, i) => `${'x'.repeat(175)}-${i}`)]) {
  test(`input names remain bounded JSON data in the model prompt (${names[0].length} character names)`, async t => {
    const f = fixture(t); const s = await f.runtime.create(); let prompt;
    const run = f.rpc.run;
    f.rpc.run = async (request, callbacks) => { prompt = request.prompt; return run(request, callbacks); };
    await f.runtime.run({ sessionId: s.id, message: 'inspect uploads', prepareWorkspace: async () => names }, () => {});
    const line = prompt.split('\n').find(item => item.startsWith('['));
    assert.ok(line, 'the model must receive an explicit JSON filename list');
    assert.ok(line.length <= 8000);
    const listed = JSON.parse(line);
    assert.ok(listed.length > 0 && listed.length <= 50);
    assert.deepEqual(listed, names.slice(0, listed.length));
    assert.match(prompt, /数据.*指令/);
  });
}

test('upload idle check on a pristine session does not create a workspace or change metadata', async t => {
  const f = fixture(t); const s = await f.runtime.create();
  await f.runtime.assertWorkspaceIdle(s.id);
  assert.deepEqual(await f.runtime.status(s.id), s);
  assert.deepEqual(f.counts, { boot: 0, model: 0 });
});

test('detached active work blocks both hydration and upload idle confirmation', async t => {
  const f = fixture(t); const s = await f.runtime.create(); await f.runtime.ensureWorkspace(s.id);
  f.rpc.hasActiveRuns = async () => true; let hydrated = false;
  await f.runtime.run({ sessionId: s.id, message: 'retry', prepareWorkspace: async () => { hydrated = true; return []; } }, () => {});
  assert.equal(hydrated, false); assert.equal(f.counts.model, 0);
  await assert.rejects(async () => f.runtime.assertWorkspaceIdle(s.id), error =>
    !(error instanceof TypeError) && /active|idle/i.test(error.message));
});

for (const result of [undefined, null, 0]) {
  test(`an unknown idle response (${String(result)}) blocks hydration and uploads`, async t => {
    const f = fixture(t); const s = await f.runtime.create(); await f.runtime.ensureWorkspace(s.id);
    f.rpc.hasActiveRuns = async () => result; let hydrated = false;
    await f.runtime.run({ sessionId: s.id, message: 'retry', prepareWorkspace: async () => { hydrated = true; return []; } }, () => {});
    assert.equal(f.counts.model, 0); assert.equal(hydrated, false);
    await assert.rejects(async () => f.runtime.assertWorkspaceIdle(s.id), error =>
      !(error instanceof TypeError) && /active|idle|confirm/i.test(error.message));
  });
}

test('upload idle confirmation rejects a failed controller check without changing metadata', async t => {
  const f = fixture(t); const s = await f.runtime.create(); const before = await f.runtime.ensureWorkspace(s.id);
  f.rpc.hasActiveRuns = async () => { throw new Error('controller unavailable'); };
  await assert.rejects(async () => f.runtime.assertWorkspaceIdle(s.id), /controller unavailable/);
  assert.deepEqual(await f.runtime.status(s.id), before);
});

for (const uncertainty of ['accepted-running', 'unknown-stop', 'outcome', 'bootstrap', 'bootstrap-stop']) {
  test(`upload idle confirmation rejects persisted ${uncertainty} uncertainty`, async t => {
    const f = fixture(t); const s = await f.runtime.create(); const saved = await f.runtime.ensureWorkspace(s.id);
    if (uncertainty === 'accepted-running') saved.runs.push({ runId: 'pending', status: 'running', accepted: true });
    if (uncertainty === 'unknown-stop') saved.runs.push({ runId: 'unknown', status: 'failed', stopUnconfirmed: true });
    if (uncertainty === 'outcome') saved.runs.push({ runId: 'accepted', status: 'failed', accepted: true, outcomeUnconfirmed: true });
    if (uncertainty === 'bootstrap') { saved.workspaceReady = false; saved.bootstrapStatus = 'running'; }
    if (uncertainty === 'bootstrap-stop') saved.bootstrapStopUnconfirmed = true;
    f.runtime.store.save(saved);
    await assert.rejects(async () => f.make().assertWorkspaceIdle(s.id), error =>
      !(error instanceof TypeError) && /unconfirmed|idle|running|bootstrap/i.test(error.message));
    assert.deepEqual(f.runtime.store.load(s.id), saved);
    assert.equal(f.counts.model, 0);
  });
}

test('upload idle confirmation rechecks a task ended while the controller response was pending', async t => {
  const f = fixture(t); const s = await f.runtime.create(); await f.runtime.ensureWorkspace(s.id);
  let unblock; let entered; const gate = new Promise(resolve => { unblock = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  f.rpc.hasActiveRuns = async () => { entered(); await gate; return false; };
  const checking = f.runtime.assertWorkspaceIdle(s.id);
  await ready;
  await f.runtime.remove(s.id); unblock();
  await assert.rejects(checking, /ended|stopped/i);
  assert.equal(f.counts.model, 0);
});

test('upload idle confirmation rejects a live model turn before querying the controller', async t => {
  const f = fixture(t); const s = await f.runtime.create(); let release; let entered;
  const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { entered = resolve; });
  const run = f.rpc.run;
  f.rpc.run = async (...args) => { entered(); await gate; return run(...args); };
  const running = f.runtime.run({ sessionId: s.id, message: 'go' }, () => {}); await ready;
  f.rpc.hasActiveRuns = async () => { throw new Error('unexpected query while locally running'); };
  try { await assert.rejects(async () => f.runtime.assertWorkspaceIdle(s.id), /running/i); }
  finally { release(); await running; }
});

test('RuntimeRouter permits Compose upload checks and rejects legacy sessions', async t => {
  const { RuntimeRouter } = await import('../packages/agent-runtime/runtime-router.mjs');
  const f = fixture(t); const s = await f.runtime.create();
  const router = new RuntimeRouter({ compose: f.runtime, legacy: { status: async id => ({ id, backend: 'local-pi' }) } });
  await router.assertWorkspaceIdle(s.id);
  await assert.rejects(async () => router.assertWorkspaceIdle(randomUUID()), /legacy|SDK/i);
  assert.deepEqual(f.counts, { boot: 0, model: 0 });
});

for (const operation of ['preparing', 'releasing', 'canceling']) {
  test(`upload idle confirmation blocks while ${operation} is in progress`, async t => {
    const f = fixture(t); const s = await f.runtime.create(); let unblock; let entered;
    const gate = new Promise(resolve => { unblock = resolve; }); const ready = new Promise(resolve => { entered = resolve; });
    let pending;
    if (operation === 'preparing') {
      const bootstrap = f.executor.bootstrap;
      f.executor.bootstrap = async callback => { entered(); await gate; return bootstrap(callback); };
      pending = f.runtime.ensureWorkspace(s.id);
    } else if (operation === 'releasing') {
      await f.runtime.ensureWorkspace(s.id); const release = f.executor.release;
      f.executor.release = async id => { entered(); await gate; return release(id); };
      pending = f.runtime.remove(s.id);
    } else {
      const saved = await detached(f, s.id);
      f.rpc.getRun = async id => { entered(); await gate; return { runId: id, sandboxId: saved.sandboxId, status: 'canceled' }; };
      pending = f.runtime.cancel(s.id);
    }
    await ready;
    f.rpc.hasActiveRuns = async () => { throw new Error('unexpected controller query during local operation'); };
    try {
      await assert.rejects(async () => f.runtime.assertWorkspaceIdle(s.id), error =>
        !(error instanceof TypeError) && /prepar|ending|cancel/i.test(error.message));
    } finally { unblock(); await pending; }
  });
}

test('upload idle confirmation rechecks a release lock acquired during the controller query', async t => {
  const f = fixture(t); const s = await f.runtime.create(); await f.runtime.ensureWorkspace(s.id);
  let finishCheck; let checkingEntered; const checkGate = new Promise(resolve => { finishCheck = resolve; });
  const checkReady = new Promise(resolve => { checkingEntered = resolve; });
  let finishRelease; let releaseEntered; const releaseGate = new Promise(resolve => { finishRelease = resolve; });
  const releaseReady = new Promise(resolve => { releaseEntered = resolve; });
  f.rpc.hasActiveRuns = async () => { checkingEntered(); await checkGate; return false; };
  const release = f.executor.release;
  f.executor.release = async id => { releaseEntered(); await releaseGate; return release(id); };
  const checking = f.runtime.assertWorkspaceIdle(s.id); await checkReady;
  const ending = f.runtime.remove(s.id); await releaseReady;
  finishCheck();
  try { await assert.rejects(checking, /ending/i); }
  finally { finishRelease(); await ending; }
});
