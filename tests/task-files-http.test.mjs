import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createAppServer } from '../apps/api/router.mjs';

async function serve(t) {
  const task = { id: 'task-one', executionSessionId: 'execution-one', status: 'stopped' };
  const calls = [];
  const files = [{ id: 'output:reports/结果.json', kind: 'output', name: 'reports/结果.json', size: 12, sha256: 'digest', modifiedAt: '2026-10-20T00:00:00.000Z' }];
  const workspaceFiles = {
    async list(received) { assert.equal(received, task); calls.push('list'); return { files, state: 'ready' }; },
    async read(received, kind, name, options) {
      assert.equal(received, task); calls.push({ kind, name, ...options });
      return { data: Buffer.from(name.endsWith('.bin') ? [0xff, 0x00] : name.endsWith('invalid.txt') ? [0xff] : '{"mean":25}\n'), file: { ...files[0], name, kind } };
    },
  };
  const server = createAppServer({ taskStore: { getTask(id) { return id === task.id ? task : null; } }, agentRuntime: {}, workspaceFiles });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (suffix = '', options) => fetch(`${base}/v1/tasks/task-one/files${suffix}`, options);
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  return { task, files, calls, workspaceFiles, base, call };
}

test('task file HTTP list and encoded nested text preview preserve the reference contract', async t => {
  const f = await serve(t);
  const listing = await f.call();
  assert.equal(listing.status, 200); assert.deepEqual(await listing.json(), { files: f.files, state: 'ready' });
  const response = await f.call(`/output/${encodeURIComponent('reports/结果.json')}`);
  assert.equal(response.status, 200); assert.equal(await response.text(), '{"mean":25}\n');
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(response.headers.get('content-disposition'), /^inline;/);
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-length'), '12');
  assert.deepEqual(f.calls[1], { kind: 'output', name: 'reports/结果.json', maxBytes: 256 * 1024 });
});

test('download keeps original bytes while HTML and unknown binary types cannot run inline', async t => {
  const f = await serve(t);
  for (const name of ['report.html', 'report.svg', 'bytes.bin', 'reports/结果.json']) {
    const response = await f.call(`/output/${encodeURIComponent(name)}${name.endsWith('.json') ? '?download=true' : ''}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment; filename="workspace-file"; filename\*=UTF-8''/);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    if (name.endsWith('.bin')) assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([255, 0]));
    else assert.equal(await response.text(), '{"mean":25}\n');
    assert.equal(f.calls.at(-1).maxBytes, 50_000_000);
  }
  assert.equal((await f.call('/output/invalid.txt')).status, 415);
  const raw = await f.call('/output/invalid.txt?download=true');
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), Buffer.from([255]));
});

test('file HTTP routes reject foreign origins, unknown tasks and malformed names without private error leakage', async t => {
  const f = await serve(t);
  assert.equal((await f.call('', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await fetch(`${f.base}/v1/tasks/missing/files`)).status, 404);
  assert.equal((await fetch(`${f.base}/v1/tasks/missing/files/output/result.json`)).status, 404);
  assert.equal((await f.call('/output/%FF')).status, 400);
  assert.equal((await f.call('/state/result.json')).status, 404);
  assert.equal((await f.call('', { method: 'POST' })).status, 409);
  assert.equal(f.calls.length, 0);
  f.workspaceFiles.list = async () => { throw new Error('PRIVATE_DIRECTORY_AND_SECRET'); };
  const response = await f.call(); assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes('PRIVATE_DIRECTORY_AND_SECRET'));
});
