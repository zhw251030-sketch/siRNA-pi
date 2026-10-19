import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskFiles, taskFileUrl, canPreviewFile, canDownloadFile } from '../public/files.mjs';

const file = (name = 'result.json', overrides = {}) => ({
  id: `output:${name}`, kind: 'output', name, size: 16,
  sha256: 'a'.repeat(64), modifiedAt: '2026-10-20T12:00:00.000Z', ...overrides,
});
const listing = (files, state = 'ready') => Response.json({ files, state });
function requests() {
  const queue = [];
  const fetcher = (url, options) => new Promise((resolve, reject) => queue.push({ url, options, resolve, reject }));
  return { queue, fetcher };
}

test('nested filenames are encoded as one path parameter without changing their literal characters', () => {
  assert.equal(taskFileUrl('task:1', file('目录/a #?%.json'), true),
    '/v1/tasks/task%3A1/files/output/%E7%9B%AE%E5%BD%95%2Fa%20%23%3F%25.json?download=true');
  assert.equal(taskFileUrl('task-1', file('result.json')),
    '/v1/tasks/task-1/files/output/result.json');
});

test('preview accepts the supported text types up to 256 KiB and keeps binary or oversized files downloadable', () => {
  for (const extension of ['txt', 'md', 'csv', 'tsv', 'tab', 'aln', 'json', 'yaml', 'yml', 'fa', 'fasta', 'fna', 'fastq', 'fq']) {
    assert.equal(canPreviewFile(file(`nested/path.${extension.toUpperCase()}`, { size: 262144 })), true);
  }
  for (const value of [file('result.json', { size: 262145 }), file('plot.png'), file('page.html'), file('README'), file('a.txt', { size: -1 })]) {
    assert.equal(canPreviewFile(value), false);
  }
  assert.equal(canDownloadFile(file('plot.png', { size: 50_000_000 })), true);
  assert.equal(canDownloadFile(file('plot.png', { size: 50_000_001 })), false);
});

test('switching tasks aborts the old list and ignores its late response', async () => {
  const { queue, fetcher } = requests();
  const viewer = createTaskFiles({ fetcher });
  viewer.setTask('first');
  const first = viewer.refresh();
  viewer.setTask('second');
  assert.equal(queue[0].options.signal.aborted, true);
  assert.deepEqual(viewer.state.files, []);
  const second = viewer.refresh();
  queue[1].resolve(listing([file('second.json')]));
  await second;
  queue[0].resolve(listing([file('first.json')]));
  await first;
  assert.equal(viewer.state.taskId, 'second');
  assert.deepEqual(viewer.state.files.map((item) => item.name), ['second.json']);
});

test('returning to the same task cannot accept its earlier list response', async () => {
  const { queue, fetcher } = requests();
  const viewer = createTaskFiles({ fetcher });
  viewer.setTask('first');
  const old = viewer.refresh();
  viewer.setTask('second');
  viewer.setTask('first');
  const current = viewer.refresh();
  queue[1].resolve(listing([file('new.json')]));
  await current;
  queue[0].resolve(listing([file('old.json')]));
  await old;
  assert.equal(viewer.state.files[0].name, 'new.json');
});

test('failed refresh clears old files and permits a new request', async () => {
  const { queue, fetcher } = requests();
  const viewer = createTaskFiles({ fetcher });
  viewer.setTask('a');
  let pending = viewer.refresh();
  queue[0].resolve(listing([file()]));
  await pending;
  pending = viewer.refresh();
  assert.deepEqual(viewer.state.files, []);
  queue[1].resolve(Response.json({ error: '文件暂不可读' }, { status: 503 }));
  await pending;
  assert.equal(viewer.state.listStatus, 'error');
  assert.equal(viewer.state.error, '文件暂不可读');
  assert.deepEqual(viewer.state.files, []);
  pending = viewer.refresh();
  queue[2].resolve(listing([]));
  await pending;
  assert.equal(viewer.state.listStatus, 'ready');
  assert.equal(viewer.state.error, '');
});

test('unprepared and unsupported task states are distinct from an empty ready workspace', async () => {
  for (const state of ['unprepared', 'unsupported', 'ready']) {
    const viewer = createTaskFiles({ fetcher: async () => listing([], state) });
    viewer.setTask('ended-task');
    await viewer.refresh();
    assert.equal(viewer.state.workspaceState, state);
    assert.deepEqual(viewer.state.files, []);
  }
});

test('malformed listings show a failure instead of stale files or actionable malformed links', async () => {
  const viewer = createTaskFiles({ fetcher: async () => listing([file('bad.json', { kind: 'unknown' })]) });
  viewer.setTask('a');
  await viewer.refresh();
  assert.equal(viewer.state.listStatus, 'error');
  assert.deepEqual(viewer.state.files, []);
});

async function readyViewer() {
  const { queue, fetcher } = requests();
  const viewer = createTaskFiles({ fetcher });
  viewer.setTask('a');
  const pending = viewer.refresh();
  queue[0].resolve(listing([file('first.json'), file('second.md'), file('plot.png')]));
  await pending;
  return { viewer, queue };
}

test('only the latest preview response is shown, preserving plain text literally', async () => {
  const { viewer, queue } = await readyViewer();
  const first = viewer.previewFile(viewer.state.files[0]);
  const second = viewer.previewFile(viewer.state.files[1]);
  assert.equal(queue[1].options.signal.aborted, true);
  queue[2].resolve(new Response('<script>alert(1)</script>\n# literal markdown'));
  await second;
  queue[1].resolve(new Response('obsolete'));
  await first;
  assert.equal(viewer.state.preview.file.name, 'second.md');
  assert.equal(viewer.state.preview.text, '<script>alert(1)</script>\n# literal markdown');
});

test('closing a preview or switching task invalidates content even if fetch ignores abort', async () => {
  for (const operation of ['close', 'switch', 'refresh']) {
    const { viewer, queue } = await readyViewer();
    const pending = viewer.previewFile(viewer.state.files[0]);
    let refresh;
    if (operation === 'close') viewer.closePreview();
    if (operation === 'switch') viewer.setTask('b');
    if (operation === 'refresh') refresh = viewer.refresh();
    assert.equal(queue[1].options.signal.aborted, true);
    queue[1].resolve(new Response('obsolete'));
    await pending;
    assert.equal(viewer.state.preview, null);
    if (refresh) { queue[2].resolve(listing([])); await refresh; }
  }
});

test('preview failures keep the selected file available for downloading without stale content', async () => {
  const { viewer, queue } = await readyViewer();
  const pending = viewer.previewFile(viewer.state.files[0]);
  queue[1].resolve(Response.json({ error: '文本不是有效 UTF-8' }, { status: 415 }));
  await pending;
  assert.equal(viewer.state.preview.status, 'error');
  assert.equal(viewer.state.preview.text, '');
  assert.equal(viewer.state.preview.error, '文本不是有效 UTF-8');
  assert.equal(viewer.state.preview.file.name, 'first.json');
});

test('binary files and files from an earlier list never start a preview request', async () => {
  const { viewer, queue } = await readyViewer();
  await viewer.previewFile(viewer.state.files[2]);
  await viewer.previewFile(file('not-in-list.json'));
  assert.equal(queue.length, 1);
  assert.equal(viewer.state.preview, null);
});

test('files that grew beyond the preview limit are rejected before displaying content', async () => {
  const { viewer, queue } = await readyViewer();
  const pending = viewer.previewFile(viewer.state.files[0]);
  queue[1].resolve(new Response('x'.repeat(262145)));
  await pending;
  assert.equal(viewer.state.preview.status, 'error');
  assert.equal(viewer.state.preview.text, '');
});
