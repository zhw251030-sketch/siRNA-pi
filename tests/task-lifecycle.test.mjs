import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { TaskStore } from '../packages/task-core/task-store.mjs';
import { TaskMessageService } from '../packages/task-core/task-message-service.mjs';

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

function fixture(t, backend = 'agent-compose') {
  const parent = path.resolve('runtime/task-lifecycle-tests');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'case-'));
  const store = new TaskStore(path.join(directory, 'tasks.sqlite'));
  const finish = deferred(), started = deferred(), release = deferred();
  let signal, cancelCount = 0, removeCount = 0;
  const runtime = {
    async create() { return { id: 'execution-one' }; },
    async describe(id) { assert.equal(id, 'execution-one'); return { backend, supportsLifecycle: backend === 'agent-compose' }; },
    async run(input, emit, abortSignal) {
      assert.equal(input.sessionId, 'execution-one'); signal = abortSignal; started.resolve();
      emit({ type: 'session', backend, runId: 'run-one' });
      await finish.promise;
      emit({ type: 'done', status: signal?.aborted ? 'canceled' : 'succeeded', runId: 'run-one' });
    },
    async cancel(id) { assert.equal(id, 'execution-one'); cancelCount++; return { status: signal ? 'running' : 'idle' }; },
    async remove(id) {
      assert.equal(id, 'execution-one'); removeCount++;
      assert.notEqual(store.getTask(task.id).status, 'running', 'active message must settle before release');
      await release.promise; return { status: 'stopped' };
    },
  };
  const service = new TaskMessageService({ taskStore: store, agentRuntime: runtime });
  const task = store.createTask({ id: 'execution-one' });
  t.after(() => {
    finish.resolve(); release.resolve(); store.close();
    assert.equal(path.dirname(directory), parent); fs.rmSync(directory, { recursive: true });
  });
  return { store, runtime, service, task, finish, release, started, signal: () => signal,
    counts: () => ({ cancel: cancelCount, remove: removeCount }) };
}

test('stop acknowledges interruption but keeps the turn reserved until message_saved and task_saved', async (t) => {
  const f = fixture(t), events = [];
  const turn = await f.service.start({ taskId: f.task.id, message: 'stop me' }, (event) => events.push(event));
  await f.started.promise;
  const result = await f.service.cancelTask(f.task.id);
  assert.equal(result.stopRequested, true); assert.equal(result.task.status, 'running');
  assert.equal(f.signal().aborted, true);
  assert.equal(f.store.listMessages(f.task.id).length, 1);
  await assert.rejects(f.service.start({ taskId: f.task.id, message: 'too soon' }, () => {}), { statusCode: 409 });
  f.finish.resolve(); await turn.completion;
  assert.equal(f.store.getTask(f.task.id).status, 'idle');
  assert.deepEqual(events.slice(-3).map((event) => event.type), ['done', 'message_saved', 'task_saved']);
  assert.match(f.store.listMessages(f.task.id)[1].content, /中断/);
});

test('an abort signal reaches a runtime whose dispatch was queued before stop', async (t) => {
  const f = fixture(t), dispatch = deferred(); let abortedAtDispatch;
  f.runtime.run = async (_input, emit, signal) => {
    await dispatch.promise; abortedAtDispatch = signal.aborted;
    emit({ type: 'done', status: 'canceled', runId: 'queued-run' });
  };
  const turn = await f.service.start({ taskId: f.task.id, message: 'queued' }, () => {});
  await f.service.cancelTask(f.task.id); dispatch.resolve(); await turn.completion;
  assert.equal(abortedAtDispatch, true);
  assert.equal(f.store.getTask(f.task.id).status, 'idle');
});

test('ending an active turn blocks new submissions, waits for durable history, and shares release', async (t) => {
  const f = fixture(t), events = [];
  const turn = await f.service.start({ taskId: f.task.id, message: 'end me' }, (event) => events.push(event));
  await f.started.promise;
  const ending = f.service.endTask(f.task.id);
  const duplicate = f.service.endTask(f.task.id);
  await assert.rejects(f.service.start({ taskId: f.task.id, message: 'racing send' }, () => {}), { statusCode: 409 });
  await new Promise(setImmediate);
  assert.equal(f.signal().aborted, true); assert.equal(f.counts().remove, 0);
  f.finish.resolve(); await turn.completion; await new Promise(setImmediate);
  assert.equal(events.at(-1).type, 'task_saved');
  assert.equal(f.store.listMessages(f.task.id).length, 2);
  assert.equal(f.counts().remove, 1);
  await assert.rejects(f.service.start({ taskId: f.task.id, message: 'release pending' }, () => {}), { statusCode: 409 });
  f.release.resolve();
  const results = await Promise.all([ending, duplicate]);
  assert.ok(results.every(({ task }) => task.status === 'stopped'));
  assert.equal(results[0].task.executionSessionId, f.task.executionSessionId);
  assert.equal(f.store.listMessages(f.task.id).length, 2);
  await f.service.endTask(f.task.id);
  assert.equal(f.counts().remove, 1, 'already ended tasks must not release twice');
});

test('an idle end reserves its lock before asynchronous metadata validation', async (t) => {
  const f = fixture(t), inspected = deferred();
  f.runtime.describe = async () => { await inspected.promise; return { backend: 'agent-compose', supportsLifecycle: true }; };
  const ending = f.service.endTask(f.task.id);
  await assert.rejects(f.service.start({ taskId: f.task.id, message: 'racing validation' }, () => {}), { statusCode: 409 });
  inspected.resolve(); f.release.resolve(); await ending;
  assert.deepEqual(f.counts(), { cancel: 0, remove: 1 });
});

test('unconfirmed release returns a safe error, leaves history open, and allows retry', async (t) => {
  const f = fixture(t); let attempts = 0;
  f.runtime.remove = async () => { attempts++; if (attempts === 1) throw new Error('PRIVATE_STOP_TOKEN'); return { status: 'stopped' }; };
  await assert.rejects(f.service.endTask(f.task.id), (error) => error.statusCode === 503 && !error.message.includes('PRIVATE_STOP_TOKEN'));
  assert.equal(f.store.getTask(f.task.id).status, 'idle');
  assert.equal((await f.service.endTask(f.task.id)).task.status, 'stopped'); assert.equal(attempts, 2);
});

test('a running release result is never recorded as an ended task', async (t) => {
  const f = fixture(t); f.runtime.remove = async () => ({ status: 'running' });
  await assert.rejects(f.service.endTask(f.task.id), { statusCode: 503 });
  assert.equal(f.store.getTask(f.task.id).status, 'idle');
});

test('legacy tasks reject stop and end before aborting their active execution', async (t) => {
  const f = fixture(t, 'local-pi');
  const turn = await f.service.start({ taskId: f.task.id, message: 'legacy' }, () => {});
  await f.started.promise;
  await assert.rejects(f.service.cancelTask(f.task.id), { statusCode: 409 });
  await assert.rejects(f.service.endTask(f.task.id), { statusCode: 409 });
  assert.equal(f.signal().aborted, false); assert.deepEqual(f.counts(), { cancel: 0, remove: 0 });
  f.finish.resolve(); await turn.completion;
});

test('detached stop applies a confirmed terminal state without inventing a new turn', async (t) => {
  const f = fixture(t);
  f.store.updateExecution(f.task.id, { status: 'failed' });
  f.runtime.cancel = async () => ({ status: 'idle' });
  const result = await f.service.cancelTask(f.task.id);
  assert.equal(result.stopRequested, false); assert.equal(result.task.status, 'idle');
  assert.equal(f.store.listMessages(f.task.id).length, 0);
  await assert.rejects(f.service.cancelTask('missing'), { statusCode: 404 });
  await assert.rejects(f.service.endTask('missing'), { statusCode: 404 });
});

test('late assistant persistence cannot resurrect an ended task or drop its history', (t) => {
  const f = fixture(t);
  f.store.updateExecution(f.task.id, { status: 'stopped' });
  f.store.appendAssistantMessage(f.task.id, 'late final answer', 'complete');
  assert.equal(f.store.getTask(f.task.id).status, 'stopped');
  assert.equal(f.store.listMessages(f.task.id)[0].content, 'late final answer');
});

test('late execution failure cannot change a permanently stopped task back to failed', (t) => {
  const f = fixture(t);
  f.store.updateExecution(f.task.id, { status: 'stopped' });
  f.store.updateExecution(f.task.id, { status: 'failed', currentRunId: 'late-run' });
  assert.equal(f.store.getTask(f.task.id).status, 'stopped');
  assert.equal(f.store.getTask(f.task.id).currentRunId, 'late-run');
});

test('concurrent stops share one operation and reserve an otherwise idle task', async (t) => {
  const f = fixture(t), acknowledge = deferred(); let calls = 0;
  f.runtime.cancel = async () => { calls++; await acknowledge.promise; return { status: 'idle' }; };
  const first = f.service.cancelTask(f.task.id), second = f.service.cancelTask(f.task.id);
  await assert.rejects(f.service.start({ taskId: f.task.id, message: 'while stop pending' }, () => {}), { statusCode: 409 });
  acknowledge.resolve(); await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('detached stop must confirm a terminal state before changing a failed task', async (t) => {
  const f = fixture(t);
  f.store.updateExecution(f.task.id, { status: 'failed' });
  f.runtime.cancel = async () => ({ status: 'running' });
  await assert.rejects(f.service.cancelTask(f.task.id), { statusCode: 503 });
  assert.equal(f.store.getTask(f.task.id).status, 'failed');
});
