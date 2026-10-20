import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { TaskFiles } from '../packages/task-core/task-files.mjs';
import { TaskStore } from '../packages/task-core/task-store.mjs';
import { createAppServer } from '../apps/api/router.mjs';

async function serve(t) {
  const parent = path.resolve('runtime/upload-http-tests'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  const store = new TaskStore(path.join(root, 'tasks.sqlite'));
  const session = { id: randomUUID(), backend: 'agent-compose', status: 'idle', runs: [] };
  const runtime = {
    async status() { return session; },
    async assertWorkspaceIdle() { if (session.status !== 'idle' || session.backend !== 'agent-compose') throw new Error('not idle'); },
    async run() { throw new Error('upload must not run'); },
  };
  const files = new TaskFiles({ root, agentRuntime: runtime });
  const task = store.createTask(session);
  const server = createAppServer({ taskStore: store, agentRuntime: runtime, workspaceFiles: files });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/v1/tasks/${task.id}/files`;
  const upload = (body, headers = {}) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  t.after(async () => {
    await server.waitForTaskCompletion();
    await new Promise(r => { server.close(r); server.closeAllConnections(); });
    store.close(); assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true });
  });
  return { root, files, task, store, session, server, base, upload };
}
test('HTTP upload persists exact binary bytes independently of any guest and preserves same-name input', async t => {
  const f = await serve(t), data = Buffer.from([0, 255, 128, 10]);
  const response = await f.upload({ name: '资料.bin', contentBase64: data.toString('base64') });
  assert.equal(response.status, 201);
  const saved = await response.json(); assert.equal(saved.file.size, 4); assert.equal(saved.synchronization, 'unprepared');
  assert.deepEqual(fs.readFileSync(path.join(f.root, `runtime/task-files/${f.task.id}/input/资料.bin`)), data);
  const listing = await (await fetch(f.base)).json(); assert.equal(listing.files.length, 1);
  const download = await fetch(`${f.base}/input/${encodeURIComponent('资料.bin')}?download=true`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), data);
  assert.equal((await f.upload({ name: '资料.bin', contentBase64: 'Mg==' })).status, 409);
  assert.deepEqual(fs.readFileSync(path.join(f.root, `runtime/task-files/${f.task.id}/input/资料.bin`)), data);
  assert.equal(f.store.listMessages(f.task.id).length, 0); assert.equal(f.session.sandboxId, undefined);
});
test('HTTP rejects oversized, malformed, path-bearing and foreign-origin uploads without saving them', async t => {
  const f = await serve(t);
  for (const payload of [{ name: '../escape.txt', contentBase64: 'MQ==' }, { name: 'empty.txt', contentBase64: '' },
    { name: 'bad.txt', contentBase64: 'MR==' }, { name: 'ok.txt', contentBase64: 'MQ==', extra: true }]) {
    assert.equal((await f.upload(payload)).status, 400);
  }
  assert.equal((await f.upload({ name: 'large.bin', contentBase64: Buffer.alloc(600001).toString('base64') })).status, 413);
  assert.equal((await f.upload({ name: 'origin.txt', contentBase64: 'MQ==' }, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal(fs.existsSync(path.join(f.root, 'runtime/task-files')), false);
});
test('HTTP upload is disallowed for running, ended and legacy tasks', async t => {
  const f = await serve(t), payload = { name: 'values.csv', contentBase64: 'MQ==' };
  for (const status of ['running', 'stopped']) {
    f.store.updateExecution(f.task.id, { status }); assert.equal((await f.upload(payload)).status, 409);
  }
  f.store.updateExecution(f.task.id, { status: 'idle' }); f.session.backend = 'local-pi';
  assert.equal((await f.upload(payload)).status, 409);
  assert.equal(fs.existsSync(path.join(f.root, 'runtime/task-files')), false);
});
test('shutdown waits for accepted archive writes', async t => {
  const f = await serve(t); let release, started;
  const held = new Promise(r => { release = r; }), entered = new Promise(r => { started = r; });
  const original = f.files.saveInput.bind(f.files);
  f.files.saveInput = async (...args) => { started(); await held; return original(...args); };
  const upload = f.upload({ name: 'held.txt', contentBase64: 'MQ==' });
  await entered;
  let complete = false; const shutdown = f.server.waitForTaskCompletion().then(() => { complete = true; });
  await new Promise(setImmediate); assert.equal(complete, false);
  release(); assert.equal((await upload).status, 201); await shutdown;
});
