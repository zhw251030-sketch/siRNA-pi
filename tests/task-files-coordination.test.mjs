import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { TaskStore } from '../packages/task-core/task-store.mjs';
import { TaskMessageService } from '../packages/task-core/task-message-service.mjs';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; }
function fixture(t) {
  const parent = path.resolve('runtime/file-coordination-tests'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  const store = new TaskStore(path.join(root, 'tasks.sqlite'));
  const task = store.createTask({ id: 'execution-one' });
  const events = [], order = [];
  const files = {
    async saveInput() { order.push('save'); return { name: 'values.csv', kind: 'input' }; },
    async hydrate() { order.push('hydrate'); return { synchronization: 'current', inputFiles: [{ name: 'values.csv' }] }; },
    async collect() { order.push('collect'); return { state: 'ready', synchronization: 'current' }; },
  };
  const runtime = {
    async describe() { return { backend: 'agent-compose', supportsLifecycle: true }; },
    async assertWorkspaceIdle() { order.push('idle'); },
    async cancel() { return { status: 'idle' }; },
    async remove() { order.push('release'); return { status: 'stopped' }; },
    async run(request, emit) {
      if (request.prepareWorkspace) assert.deepEqual(await request.prepareWorkspace(), ['values.csv']);
      order.push('model'); emit({ type: 'done', status: 'succeeded', runId: 'one' });
    },
  };
  const service = new TaskMessageService({ taskStore: store, agentRuntime: runtime, workspaceFiles: files });
  t.after(() => { store.close(); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true }); });
  return { store, task, files, runtime, service, events, order, start: () => service.start({ taskId: task.id, message: 'use uploaded data' }, e => events.push(e)) };
}
test('accepted input upload reserves the task against send and end until saved and hydrated', async t => {
  const f = fixture(t), held = deferred(), started = deferred();
  f.files.saveInput = async () => { started.resolve(); await held.promise; f.order.push('save'); return { name: 'values.csv' }; };
  const upload = f.service.uploadInput(f.task.id, { name: 'values.csv', contentBase64: 'MQ==' });
  await started.promise;
  await assert.rejects(f.start(), { statusCode: 409 });
  await assert.rejects(f.service.endTask(f.task.id), { statusCode: 409 });
  await assert.rejects(f.service.uploadInput(f.task.id, {}), { statusCode: 409 });
  held.resolve(); assert.equal((await upload).file.name, 'values.csv');
  assert.deepEqual(f.order, ['idle', 'save', 'hydrate']);
  assert.equal(f.store.listMessages(f.task.id).length, 0);
  await (await f.start()).completion;
  assert.equal(f.store.listMessages(f.task.id).length, 2);
});
test('a runtime that cannot confirm idle never saves an upload', async t => {
  const f = fixture(t); f.runtime.assertWorkspaceIdle = async () => { throw new Error('PRIVATE_UNCERTAIN_RUN'); };
  await assert.rejects(f.service.uploadInput(f.task.id, {}), e => e.statusCode === 409 && !e.message.includes('PRIVATE'));
  assert.deepEqual(f.order, []);
});
test('saved upload reports pending sync without pretending the file was not saved', async t => {
  const f = fixture(t); f.files.hydrate = async () => { throw new Error('PRIVATE_FS'); };
  const result = await f.service.uploadInput(f.task.id, {});
  assert.equal(result.file.name, 'values.csv'); assert.equal(result.synchronization, 'pending');
  assert.ok(result.warning && !result.warning.includes('PRIVATE'));
});
test('run hydrates before model and archives before task_saved while preserving the true model outcome', async t => {
  const f = fixture(t); await (await f.start()).completion;
  assert.deepEqual(f.order, ['hydrate', 'model', 'collect']);
  assert.deepEqual(f.events.slice(-3).map(e => e.type), ['workspace_synced', 'message_saved', 'task_saved']);
  assert.equal(f.store.getTask(f.task.id).status, 'idle');
});
test('archive failure produces a durable workspace_warning without changing succeeded into failed', async t => {
  const f = fixture(t); f.files.collect = async () => { throw new Error('PRIVATE_ARCHIVE'); };
  await (await f.start()).completion;
  assert.equal(f.events.find(e => e.type === 'done').status, 'succeeded');
  assert.equal(f.store.getTask(f.task.id).status, 'idle');
  const warning = f.store.listRunEvents(f.task.id).find(e => e.payload.type === 'workspace_warning');
  assert.ok(warning); assert.ok(!JSON.stringify(warning).includes('PRIVATE'));
});
test('hydrate failure prevents model execution and still preserves a failed conversation record', async t => {
  const f = fixture(t); f.files.hydrate = async () => { throw new Error('cannot sync'); };
  await (await f.start()).completion;
  assert.ok(!f.order.includes('model')); assert.equal(f.store.getTask(f.task.id).status, 'failed');
  assert.equal(f.store.listMessages(f.task.id).length, 2);
});
test('initialization failure without a workspace never claims files were synchronized', async t => {
  const f = fixture(t);
  f.runtime.run = async () => { throw new Error('initialization failed'); };
  f.files.collect = async () => ({ state: 'unprepared', synchronization: 'unprepared' });
  await (await f.start()).completion;
  assert.equal(f.store.getTask(f.task.id).status, 'failed');
  assert.equal(f.store.listMessages(f.task.id).length, 2);
  assert.ok(!f.events.some(event => event.type === 'workspace_synced'));
  assert.ok(!f.store.listRunEvents(f.task.id).some(event => event.payload.type === 'workspace_synced'));
});
test('ending waits for archive after release and a failed archive can be retried', async t => {
  const f = fixture(t); let attempts = 0;
  f.files.collect = async () => { f.order.push('collect'); if (!attempts++) throw new Error('archive unavailable'); return { synchronization: 'current' }; };
  await assert.rejects(f.service.endTask(f.task.id), { statusCode: 503 });
  assert.notEqual(f.store.getTask(f.task.id).status, 'stopped');
  await f.service.endTask(f.task.id);
  assert.equal(f.store.getTask(f.task.id).status, 'stopped');
  assert.deepEqual(f.order, ['release', 'collect', 'release', 'collect']);
  await assert.rejects(f.service.uploadInput(f.task.id, {}), { statusCode: 409 });
});
