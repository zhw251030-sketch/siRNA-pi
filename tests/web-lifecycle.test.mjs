import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { TaskStore } from '../packages/task-core/task-store.mjs';
import { createAppServer } from '../apps/api/router.mjs';

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

async function serve(t, { backend = 'agent-compose', holdRun = false, holdRelease = false } = {}) {
  const parent = path.resolve('runtime/web-lifecycle-tests');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'case-'));
  const store = new TaskStore(path.join(directory, 'tasks.sqlite'));
  const finish = deferred(), started = deferred(), release = deferred(), removing = deferred(), canceled = deferred();
  let signal, running = false, cancels = 0, removes = 0;
  const runtime = {
    async create() { return { id: 'execution-one' }; },
    runtimeInfo() { return { backend }; },
    async describe() { return { backend, supportsLifecycle: backend === 'agent-compose' }; },
    async run(input, emit, abortSignal) {
      assert.equal(input.sessionId, 'execution-one'); signal = abortSignal; running = true; started.resolve();
      emit({ type: 'session', backend, runId: 'http-run' });
      if (holdRun) await finish.promise;
      emit({ type: 'assistant_message', text: signal.aborted ? '已中断' : '结果已保存' });
      emit({ type: 'done', status: signal.aborted ? 'canceled' : 'succeeded', runId: 'http-run' });
      running = false;
    },
    async cancel(id) { assert.equal(id, 'execution-one'); cancels++; canceled.resolve(); return { status: running ? 'running' : 'idle' }; },
    async remove(id) {
      assert.equal(id, 'execution-one'); removes++; removing.resolve();
      if (holdRelease) await release.promise;
      return { status: 'stopped' };
    },
  };
  const server = createAppServer({ taskStore: store, agentRuntime: runtime });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const task = store.createTask({ id: 'execution-one' });
  const call = (suffix, options = {}) => fetch(`${url}/v1/tasks/${task.id}/${suffix}`, options);
  const send = (message) => call('messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
  t.after(async () => {
    finish.resolve(); release.resolve(); await server.waitForTaskCompletion();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    store.close(); assert.equal(path.dirname(directory), parent); fs.rmSync(directory, { recursive: true });
  });
  return { url, call, send, task, store, runtime, server, finish, started, release, removing, canceled,
    counts: () => ({ cancels, removes }) };
}

test('cancel and end keep the reference HTTP contracts and preserve readable history', async (t) => {
  const f = await serve(t);
  const canceled = await f.call('cancel', { method: 'POST' });
  assert.equal(canceled.status, 200);
  assert.deepEqual(Object.keys(await canceled.json()).sort(), ['stopRequested', 'task']);
  await (await f.send('keep this history')).text();
  const ended = await f.call('runtime', { method: 'DELETE' });
  assert.equal(ended.status, 200); assert.equal((await ended.json()).task.status, 'stopped');
  const history = await (await f.call('messages')).json();
  assert.equal(history.task.id, f.task.id); assert.equal(history.task.executionSessionId, 'execution-one');
  assert.deepEqual(history.messages.map(({ content }) => content), ['keep this history', '结果已保存']);
  assert.equal((await f.send('cannot reopen')).status, 409);
  assert.equal((await f.call('runtime', { method: 'DELETE' })).status, 200);
  assert.equal(f.counts().removes, 1);
  const helper = await fetch(`${f.url}/lifecycle.mjs`);
  assert.equal(helper.status, 200); assert.match(helper.headers.get('content-type'), /javascript/);
});

test('HTTP stop acknowledgement cannot unlock the still-streaming turn', async (t) => {
  const f = await serve(t, { holdRun: true });
  const stream = await f.send('running'); await f.started.promise;
  const response = await f.call('cancel', { method: 'POST' });
  assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.stopRequested, true); assert.equal(result.task.status, 'running');
  assert.equal((await f.send('too early')).status, 409);
  f.finish.resolve();
  const events = (await stream.text()).split('\n\n').filter((frame) => frame.startsWith('data:')).map((frame) => JSON.parse(frame.slice(5)));
  assert.deepEqual(events.slice(-3).map(({ type }) => type), ['done', 'message_saved', 'task_saved']);
  assert.equal(events.at(-1).task.status, 'idle');
});

test('concurrent HTTP end requests share release and cannot race a new message', async (t) => {
  const f = await serve(t, { holdRun: true, holdRelease: true });
  const stream = await f.send('ending'); await f.started.promise;
  const first = f.call('runtime', { method: 'DELETE' });
  // Observe the actual cancel boundary before sending racing requests.
  await f.canceled.promise;
  const duplicate = f.call('runtime', { method: 'DELETE' });
  assert.equal((await f.send('race')).status, 409);
  assert.equal((await f.call('cancel', { method: 'POST' })).status, 409);
  f.finish.resolve(); await stream.text(); await f.removing.promise;
  assert.equal(f.store.listMessages(f.task.id).length, 2);
  f.release.resolve();
  assert.equal((await first).status, 200); assert.equal((await duplicate).status, 200);
  assert.equal(f.counts().removes, 1); assert.equal(f.store.getTask(f.task.id).status, 'stopped');
});

test('lifecycle routes reject nonempty bodies, foreign origins, unknown tasks, and private runtime errors', async (t) => {
  const f = await serve(t);
  for (const [suffix, method] of [['cancel', 'POST'], ['runtime', 'DELETE']]) {
    assert.equal((await f.call(suffix, { method, headers: { 'Content-Type': 'application/json' }, body: '{"unexpected":true}' })).status, 400);
    assert.equal((await f.call(suffix, { method, headers: { Origin: 'https://malicious.example' } })).status, 403);
    assert.equal((await fetch(`${f.url}/v1/tasks/missing/${suffix}`, { method })).status, 404);
  }
  f.runtime.remove = async () => { throw new Error('PRIVATE_RUNTIME_SECRET'); };
  const failed = await f.call('runtime', { method: 'DELETE' });
  assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes('PRIVATE_RUNTIME_SECRET'));
  assert.equal(f.store.getTask(f.task.id).status, 'idle');
});

test('legacy HTTP lifecycle calls reject without reaching unsupported runtime methods', async (t) => {
  const f = await serve(t, { backend: 'local-pi' });
  assert.equal((await f.call('cancel', { method: 'POST' })).status, 409);
  assert.equal((await f.call('runtime', { method: 'DELETE' })).status, 409);
  assert.deepEqual(f.counts(), { cancels: 0, removes: 0 });
});

test('shutdown tracking waits for accepted release even after its browser disconnects', async (t) => {
  const f = await serve(t, { holdRelease: true });
  const controller = new AbortController();
  const response = f.call('runtime', { method: 'DELETE', signal: controller.signal }).catch((error) => error);
  await f.removing.promise; controller.abort(); await response;
  let completed = false;
  const waiting = f.server.waitForTaskCompletion().then(() => { completed = true; });
  await new Promise(setImmediate); assert.equal(completed, false);
  f.release.resolve(); await waiting;
  assert.equal(f.store.getTask(f.task.id).status, 'stopped');
});
