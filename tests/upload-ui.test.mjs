import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createTaskFiles, taskFileUrl, canPreviewFile, canDownloadFile } from '../public/files.mjs';
import { lifecycleControls, mergeTaskState, pendingDisposition } from '../public/lifecycle.mjs';
import { consumeSse } from '../public/sse.mjs';
import { createCurationPreviewPanel, curationNavigation } from '../public/curation.mjs';

const metadata = (name = 'data.csv', size = 4) => ({ id: `input:${name}`, kind: 'input', name, size, sha256: 'a'.repeat(64), modifiedAt: '2026-10-20T12:00:00.000Z' });
const listing = (files = [], extra = {}) => Response.json({ files, state: 'ready', synchronization: 'unprepared', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('explicit upload sends the original binary bytes and filename, and exposes busy before reading', async () => {
  const requests = [];
  const reading = deferred();
  const controller = createTaskFiles({ fetcher: async (url, options) => {
    requests.push({ url, options });
    return Response.json({ file: metadata('自有 #.csv') }, { status: 201 });
  } });
  controller.setTask('task:1');
  const chosen = { name: '自有 #.csv', size: 4, arrayBuffer: () => reading.promise };
  assert.equal(requests.length, 0);
  assert.equal(typeof controller.uploadFile, 'function', 'file controller needs an explicit upload operation');
  const upload = controller.uploadFile(chosen);
  assert.equal(controller.state.uploadStatus, 'loading');
  assert.equal(requests.length, 0);
  reading.resolve(Uint8Array.from([0, 255, 13, 10]).buffer);
  assert.equal((await upload).name, '自有 #.csv');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/tasks/task%3A1/files');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), { name: '自有 #.csv', contentBase64: 'AP8NCg==' });
  assert.equal(controller.state.uploadStatus, 'success');
  assert.match(controller.state.uploadMessage, /保存/);
  assert.doesNotMatch(controller.state.uploadMessage, /已同步/);
});

test('empty, oversized and path-like upload files never produce a request', async () => {
  const requests = [];
  const controller = createTaskFiles({ fetcher: (...args) => { requests.push(args); throw new Error('must not send'); } });
  controller.setTask('a');
  assert.equal(typeof controller.uploadFile, 'function');
  for (const [name, size] of [['empty.csv', 0], ['large.csv', 600001], ['../data.csv', 4], ['dir\\data.csv', 4], ['.', 4], ['bad\u0000.csv', 4]]) {
    await controller.uploadFile({ name, size, arrayBuffer: async () => { throw new Error('must not read'); } });
    assert.equal(controller.state.uploadStatus, 'error');
  }
  assert.deepEqual(requests, []);
});

test('the upload ceiling accepts exactly 600000 bytes without corrupting the last bytes', async () => {
  let body;
  const controller = createTaskFiles({ fetcher: async (_url, options) => {
    body = JSON.parse(options.body);
    return Response.json({ file: metadata('limit.bin', 600000) }, { status: 201 });
  } });
  controller.setTask('a');
  assert.equal(typeof controller.uploadFile, 'function');
  const bytes = new Uint8Array(600000); bytes.set([0, 128, 255], 599997);
  await controller.uploadFile(new File([bytes], 'limit.bin'));
  assert.deepEqual(Buffer.from(body.contentBase64, 'base64'), Buffer.from(bytes));
});

test('duplicate upload errors are safe and never retry or overwrite', async () => {
  let requests = 0;
  const controller = createTaskFiles({ fetcher: async () => {
    requests += 1;
    return Response.json({ error: '<script>private /host/path token</script>' }, { status: 409 });
  } });
  controller.setTask('a');
  assert.equal(typeof controller.uploadFile, 'function');
  assert.equal(await controller.uploadFile(new File(['test'], 'data.csv')), null);
  assert.equal(requests, 1);
  assert.equal(controller.state.uploadStatus, 'error');
  assert.match(controller.state.uploadMessage, /同名|状态/);
  assert.doesNotMatch(controller.state.uploadMessage, /script|private|token/);
});

test('lost upload responses disclose uncertain save outcome and never retry automatically', async () => {
  let requests = 0;
  const controller = createTaskFiles({ fetcher: async () => { requests += 1; throw new Error('secret internal transport data'); } });
  controller.setTask('a');
  assert.equal(typeof controller.uploadFile, 'function');
  await controller.uploadFile(new File(['test'], 'data.csv'));
  assert.equal(requests, 1);
  assert.match(controller.state.uploadMessage, /保存可能成功.*刷新核对/);
  assert.doesNotMatch(controller.state.uploadMessage, /secret/);
});

test('switching tasks during a file read prevents the old upload from being submitted', async () => {
  const reading = deferred();
  let requests = 0;
  const controller = createTaskFiles({ fetcher: async () => { requests += 1; } });
  controller.setTask('a');
  assert.equal(typeof controller.uploadFile, 'function');
  const old = controller.uploadFile({ name: 'old.csv', size: 4, arrayBuffer: () => reading.promise });
  controller.setTask('b');
  reading.resolve(new Uint8Array(4).buffer);
  assert.equal(await old, null);
  assert.equal(requests, 0);
  assert.equal(controller.state.taskId, 'b');
  assert.equal(controller.state.uploadStatus, 'idle');
});

test('switching away and back ignores the old upload response even if fetch ignores abort', async () => {
  const network = deferred();
  let signal;
  const controller = createTaskFiles({ fetcher: (_url, options) => { signal = options.signal; return network.promise; } });
  controller.setTask('a');
  assert.equal(typeof controller.uploadFile, 'function');
  const old = controller.uploadFile(new File(['test'], 'old.csv'));
  await tick();
  controller.setTask('b');
  controller.setTask('a');
  assert.equal(signal.aborted, true);
  network.resolve(Response.json({ file: metadata('old.csv') }, { status: 201 }));
  assert.equal(await old, null);
  assert.equal(controller.state.uploadStatus, 'idle');
  assert.deepEqual(controller.state.files, []);
});

test('a second upload click cannot start a competing request while the first is pending', async () => {
  const network = deferred();
  let requests = 0;
  const controller = createTaskFiles({ fetcher: () => { requests += 1; return network.promise; } });
  controller.setTask('a');
  const upload = controller.uploadFile(new File(['test'], 'data.csv'));
  assert.equal(await controller.uploadFile(new File(['next'], 'other.csv')), null);
  await tick();
  assert.equal(requests, 1);
  network.resolve(Response.json({ file: metadata(), synchronization: 'pending', warning: '同步尚未确认' }, { status: 201 }));
  assert.equal((await upload).name, 'data.csv');
  assert.equal(controller.state.uploadStatus, 'success');
  assert.match(controller.state.uploadMessage, /已保存.*同步.*未确认/);
});

test('an incomplete success response never claims a confirmed save or causes a retry', async () => {
  let requests = 0;
  const controller = createTaskFiles({ fetcher: async () => { requests += 1; return Response.json({ file: metadata('wrong.csv') }, { status: 201 }); } });
  controller.setTask('a');
  assert.equal(await controller.uploadFile(new File(['test'], 'data.csv')), null);
  assert.equal(requests, 1);
  assert.equal(controller.state.uploadStatus, 'error');
  assert.match(controller.state.uploadMessage, /保存可能成功.*刷新核对/);
});

// The real app controller runs with a small DOM boundary, without a browser,
// network, model, or execution environment. All application logic is unchanged.
class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this.value = ''; this.files = []; this.className = ''; this.hidden = false; this.disabled = false; this.ownText = ''; this.parent = null; this.classList = { toggle() {} }; }
  set textContent(value) { this.ownText = value; this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const child of nodes) { child.parent = this; this.children.push(child); } }
  prepend(child) { child.parent = this; this.children.unshift(child); }
  replaceChildren(...children) { this.ownText = ''; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  querySelectorAll(selector) { return this.children.flatMap(child => [(selector === 'button' ? child.tagName === 'BUTTON' : child.className.split(' ').includes(selector.slice(1))) ? child : null, ...child.querySelectorAll(selector)]).filter(Boolean); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() {}
  get lastElementChild() { return this.children.at(-1); }
  get isConnected() { return Boolean(this.parent); }
  dispatch(name) { this.listeners.get(name)?.({ preventDefault() {} }); }
}

async function appHarness({ status = 'idle', execution = {}, events = [], fetcher } = {}) {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const stored = new Map();
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  const task = { id: 'a', title: 'My task', status, updatedAt: '2026-10-20T12:00:00Z' };
  const requests = [];
  let historyFails = false;
  const document = { getElementById: id => nodes[id], createElement: tag => Object.assign(new Element(tag), { ownerDocument: document }) };
  for (const element of Object.values(nodes)) element.ownerDocument = document;
  const sandbox = { document, localStorage: storage, sessionStorage: storage, crypto: { randomUUID: () => 'random-id' },
    createTaskFiles, taskFileUrl, canPreviewFile, canDownloadFile, lifecycleControls, mergeTaskState, pendingDisposition, consumeSse, curationNavigation,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (options?.method === 'POST' || options?.method === 'DELETE') return fetcher(url, options);
      if (url === '/v1/tasks') return Response.json({ tasks: [task, { ...task, id: 'b' }] });
      if (url.endsWith('/messages')) return historyFails ? Response.json({ error: 'cannot read history' }, { status: 503 }) : Response.json({ task, execution: { backend: 'agent-compose', supportsLifecycle: true, ...execution }, messages: [{ id: 'm1', role: 'user', content: 'original history' }], runEvents: events });
      return listing();
    } };
  // Bind the files controller to the same transport boundary as the browser.
  sandbox.createTaskFiles = options => createTaskFiles({ ...options, fetcher: sandbox.fetch });
  sandbox.createCurationPreviewPanel = options => createCurationPreviewPanel({ ...options, fetcher: sandbox.fetch });
  const context = vm.createContext(sandbox);
  const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  await tick(); await tick();
  return { nodes, requests, stored, run: code => vm.runInContext(code, context), failHistory: () => { historyFails = true; } };
}

test('real app mounts curation without automatic fetch and task status disables reads', async () => {
  for (const status of ['idle', 'running']) {
    const app = await appHarness({ status });
    const panel = app.nodes['curation-panel'];
    const button = panel.children.find(child => child.tagName === 'BUTTON');
    assert.ok(panel.textContent.includes('当前任务：a'));
    assert.equal(button.disabled, status === 'running');
    assert.equal(app.requests.some(request => request.url.includes('curation-preview')), false);
  }
});

test('file selection sends nothing; upload click locks competing actions and preserves chat history', async () => {
  const response = deferred();
  const app = await appHarness({ fetcher: () => response.promise });
  assert.ok(app.nodes['upload-file'], 'the page exposes an upload button');
  app.nodes['file-input'].files = [new File(['test'], 'data.csv')];
  app.nodes['file-input'].value = 'C:\\fakepath\\data.csv';
  app.nodes['file-input'].dispatch('change');
  assert.equal(app.requests.filter(item => item.options?.method).length, 0);
  app.nodes['upload-file'].dispatch('click');
  assert.equal(app.run('state.uploadBusy'), true);
  for (const id of ['send-button', 'new-session', 'refresh-tasks', 'end-task']) assert.equal(app.nodes[id].disabled, true, id);
  app.nodes['message-input'].value = 'must not send';
  app.nodes.composer.dispatch('submit');
  app.nodes['new-session'].dispatch('click');
  app.nodes['end-task'].dispatch('click');
  app.nodes['task-list'].children[1].dispatch('click');
  await tick();
  assert.equal(app.requests.filter(item => item.options?.method).length, 1);
  response.resolve(Response.json({ file: metadata() }, { status: 201 }));
  await tick(); await tick();
  assert.equal(app.run('state.uploadBusy'), false);
  assert.equal(app.nodes['input-files'].attributes['aria-pressed'], 'true');
  assert.equal(app.nodes['file-input'].value, '');
  assert.match(app.nodes.messages.textContent, /original history/);
  assert.equal([...app.stored.values()].some(value => value.includes('dGVzdA==')), false);
});

test('failed same-task history refresh preserves existing messages and lifecycle execution', async () => {
  const app = await appHarness();
  app.failHistory();
  app.nodes['refresh-tasks'].dispatch('click');
  await tick(); await tick();
  assert.match(app.nodes.messages.textContent, /original history/);
  assert.equal(app.nodes['end-task'].disabled, false);
  assert.equal(app.run('state.execution.backend'), 'agent-compose');
});

test('running and uncertain tasks block uploads while their stop control remains available', async () => {
  for (const options of [{ status: 'running' }, { status: 'failed', execution: { stopUnconfirmed: true } }]) {
    const app = await appHarness(options);
    assert.ok(app.nodes['upload-file'], 'the page exposes an upload button');
    app.nodes['file-input'].files = [new File(['test'], 'data.csv')];
    app.nodes['file-input'].dispatch('change');
    assert.equal(app.nodes['upload-file'].disabled, true);
    assert.equal(app.nodes['stop-run'].disabled, false);
    app.nodes['upload-file'].dispatch('click');
    await tick();
    assert.equal(app.requests.filter(item => item.options?.method).length, 0);
  }
});

test('stopped, legacy and unavailable execution states cannot submit selected files', async () => {
  for (const options of [{ status: 'stopped' }, { execution: { backend: 'local-pi' } }, { execution: { unavailable: true } }]) {
    const app = await appHarness(options);
    app.nodes['file-input'].files = [new File(['test'], 'data.csv')];
    app.nodes['file-input'].dispatch('change');
    assert.equal(app.nodes['upload-file'].disabled, true);
    app.nodes['upload-file'].dispatch('click');
    await tick();
    assert.equal(app.requests.filter(item => item.options?.method).length, 0);
  }
});

test('workspace warning history and live sync events remain visible alongside file refresh', async () => {
  const app = await appHarness({ events: [{ runId: 'r1', payload: { type: 'workspace_warning', error: '归档不完整，请核对。' } }] });
  assert.match(app.nodes['run-log'].textContent, /归档不完整/);
  app.run('handleStreamEvent({ type: "workspace_synced", taskId: "a" })');
  await tick();
  assert.match(app.nodes['run-log'].textContent, /同步/);
  assert.match(app.nodes['run-log'].textContent, /归档不完整/);
});
