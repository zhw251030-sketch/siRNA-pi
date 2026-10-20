import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { WorkspaceFileError } from '../packages/task-core/workspace.mjs';

const archiveModule = await import('../packages/task-core/task-files.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const code = statusCode => error => error instanceof WorkspaceFileError && error.statusCode === statusCode;
const upload = (name = 'numbers.csv', text = 'value\n7\n11\n') => ({ name, contentBase64: Buffer.from(text).toString('base64') });

async function fixture(t, prepared = false) {
  assert.equal(typeof archiveModule.TaskFiles, 'function', 'TaskFiles archive implementation must exist');
  const parent = path.resolve('runtime/task-archive-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'case-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); await fs.rm(root, { recursive: true, force: true }); });
  const task = { id: randomUUID(), executionSessionId: randomUUID(), status: 'idle' };
  const sandboxId = 'a'.repeat(64);
  const relative = `runtime/agent-compose/data/sandboxes/2026/10/20/${sandboxId}/workspace`;
  const workspace = path.join(root, relative);
  const archive = path.join(root, 'runtime/task-files', task.id);
  const session = { id: task.executionSessionId, backend: 'agent-compose', status: 'idle', runs: [], sandboxId: null, workspacePath: null };
  const files = new archiveModule.TaskFiles({ root, agentRuntime: {
    async status(id) { assert.equal(id, task.executionSessionId); return session; },
    async prepare() { assert.fail('File operation must not prepare runtime'); },
    async create() { assert.fail('File operation must not create runtime'); },
    async run() { assert.fail('File operation must not call model'); },
  } });
  async function prepare() {
    session.sandboxId = sandboxId; session.workspacePath = relative;
    await fs.mkdir(path.join(workspace, 'input'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'output'), { recursive: true });
  }
  async function put(kind, name, content) {
    const target = path.join(workspace, kind, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    return target;
  }
  if (prepared) await prepare();
  return { root, task, session, workspace, archive, files, prepare, put };
}

test('initial upload is archived without booting guest and is immediately readable', async t => {
  const { root, task, archive, files } = await fixture(t);
  assert.deepEqual(await files.list(task), { state: 'unprepared', synchronization: 'unprepared', files: [] });
  const file = await files.saveInput(task, upload());
  assert.equal(file.id, 'input:numbers.csv');
  assert.equal(file.size, 11);
  assert.equal(await fs.readFile(path.join(archive, 'input/numbers.csv'), 'utf8'), 'value\n7\n11\n');
  const uploaded = await files.list(task);
  assert.equal(uploaded.state, 'ready');
  assert.equal(uploaded.synchronization, 'unprepared');
  assert.equal(uploaded.warning, undefined);
  assert.equal((await files.read(task, 'input', 'numbers.csv')).data.toString(), 'value\n7\n11\n');
  assert.equal(await fs.stat(path.join(root, 'runtime/agent-compose')).catch(error => error.code), 'ENOENT');
});

test('hydration restores uploaded numbers instead of the runtime seed and imports other old inputs', async t => {
  const { task, files, prepare, workspace, put } = await fixture(t);
  await files.saveInput(task, upload());
  await prepare();
  await put('input', 'numbers.csv', 'value\n10\n20\n30\n40\n');
  await put('input', 'nested/old.txt', 'legacy input');
  const result = await files.hydrate(task);
  assert.equal(result.synchronization, 'current');
  assert.deepEqual(result.inputFiles.map(file => file.name), ['nested/old.txt', 'numbers.csv']);
  assert.equal(await fs.readFile(path.join(workspace, 'input/numbers.csv'), 'utf8'), 'value\n7\n11\n');
  assert.equal((await files.read(task, 'input', 'nested/old.txt')).data.toString(), 'legacy input');
});

test('repeated collection and hydration preserve identical destination files and their timestamps', async t => {
  const { task, files, prepare, workspace, archive, put } = await fixture(t);
  await files.saveInput(task, upload());
  await prepare();
  await files.hydrate(task);
  await put('output', 'result.txt', 'complete result');
  await files.collect(task);
  const guestInput = path.join(workspace, 'input/numbers.csv');
  const savedOutput = path.join(archive, 'output/result.txt');
  const oldTime = new Date('2000-01-01T00:00:00.000Z');
  await fs.utimes(guestInput, oldTime, oldTime);
  await fs.utimes(savedOutput, oldTime, oldTime);
  const inputBefore = await fs.stat(guestInput, { bigint: true });
  const outputBefore = await fs.stat(savedOutput, { bigint: true });
  await files.list(task);
  await files.read(task, 'output', 'result.txt');
  await files.hydrate(task);
  const inputAfter = await fs.stat(guestInput, { bigint: true });
  const outputAfter = await fs.stat(savedOutput, { bigint: true });
  assert.equal(inputAfter.ino, inputBefore.ino);
  assert.equal(inputAfter.mtimeNs, inputBefore.mtimeNs);
  assert.equal(outputAfter.ino, outputBefore.ino);
  assert.equal(outputAfter.mtimeNs, outputBefore.mtimeNs);
  assert.equal(await fs.readFile(guestInput, 'utf8'), 'value\n7\n11\n');
  assert.equal(await fs.readFile(savedOutput, 'utf8'), 'complete result');
});

test('old live inputs reserve their names before upload duplicate checks', async t => {
  const { task, files, put, archive } = await fixture(t, true);
  await put('input', 'numbers.csv', 'old bytes');
  await assert.rejects(files.saveInput(task, upload()), code(409));
  assert.equal(await fs.readFile(path.join(archive, 'input/numbers.csv'), 'utf8'), 'old bytes');
  await assert.rejects(files.saveInput(task, upload()), code(409));
  assert.equal((await files.read(task, 'input', 'numbers.csv')).data.toString(), 'old bytes');
});

test('list refreshes complete output snapshots and preserves them after guest is gone', async t => {
  const { task, files, put, workspace } = await fixture(t, true);
  await put('output', 'nested/result.json', '{"mean":9}');
  assert.equal((await files.list(task)).synchronization, 'current');
  await put('output', 'nested/result.json', '{"mean":18}');
  assert.equal((await files.read(task, 'output', 'nested/result.json')).data.toString(), '{"mean":18}');
  await fs.rm(workspace, { recursive: true });
  const cached = await files.list(task);
  assert.equal(cached.synchronization, 'cached');
  assert.match(cached.warning, /[\u3400-\u9fff]/);
  assert.equal((await files.read(task, 'output', 'nested/result.json')).data.toString(), '{"mean":18}');
  await assert.rejects(fs.stat(workspace), { code: 'ENOENT' });
});

test('collection never mirrors guest deletion and reads never hydrate modified guest inputs', async t => {
  const { task, files, put, workspace } = await fixture(t, true);
  await put('input', 'numbers.csv', 'original');
  await put('output', 'old.txt', 'retained');
  await files.collect(task);
  await put('input', 'numbers.csv', 'guest edit');
  await fs.unlink(path.join(workspace, 'output/old.txt'));
  assert.equal((await files.read(task, 'input', 'numbers.csv')).data.toString(), 'original');
  assert.equal(await fs.readFile(path.join(workspace, 'input/numbers.csv'), 'utf8'), 'guest edit');
  assert.equal((await files.read(task, 'output', 'old.txt')).data.toString(), 'retained');
});

test('task archive IDs prevent traversal and separate tasks sharing an execution fixture', async t => {
  const { task, files } = await fixture(t);
  await files.saveInput(task, upload('a.txt', 'first'));
  const other = { ...task, id: randomUUID() };
  await files.saveInput(other, upload('a.txt', 'second'));
  assert.equal((await files.read(task, 'input', 'a.txt')).data.toString(), 'first');
  assert.equal((await files.read(other, 'input', 'a.txt')).data.toString(), 'second');
  for (const id of ['../escape', `${task.id}/..`, '', null, task.id + ' '])
    await assert.rejects(files.list({ ...task, id }), code(400));
});

test('upload validates exact payload, canonical base64, safe scalar filename and decoded size', async t => {
  const { task, files, root } = await fixture(t);
  for (const payload of [null, [], {}, { ...upload(), extra: 1 }, { name: 'x', contentBase64: 'YQ' },
    { name: 'x', contentBase64: 'YQ==\n' }, { name: 'x', contentBase64: 'YR==' }, upload('x', ''),
    ...[' a', 'a ', 'a\n', 'a\x7f', '../x', 'a/b', 'a\\b', '.', '..', 'CON.txt', 'NUL', 'a:', 'a.', '\ud800', 'x'.repeat(181)]
      .map(name => upload(name))]) await assert.rejects(files.saveInput(task, payload), code(400));
  await assert.rejects(files.saveInput(task, upload('large', 'a'.repeat(600_001))), code(413));
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal((await files.saveInput(task, upload('limit', 'a'.repeat(600_000)))).size, 600_000);
});

test('an interrupted temporary write is never exposed as an archived file', async t => {
  const { task, files, archive } = await fixture(t);
  await files.saveInput(task, upload('complete.txt', 'saved'));
  const temporary = `.task-file-${randomUUID()}.tmp`;
  await fs.writeFile(path.join(archive, 'input', temporary), 'half of an interrupted upload');
  assert.deepEqual((await files.list(task)).files.map(file => file.name), ['complete.txt']);
  await assert.rejects(files.read(task, 'input', temporary), code(400));
  await assert.rejects(files.saveInput(task, upload(temporary)), code(400));
});

test('files growing after source enumeration cannot bypass the archive total byte limit', async t => {
  const { task, files, archive, prepare, put } = await fixture(t);
  await files.saveInput(task, upload('first', 'a'));
  await fs.mkdir(path.join(archive, 'output'));
  for (const [name, size] of [['a', 50_000_000], ['b', 49_999_999]]) {
    const handle = await fs.open(path.join(archive, 'output', name), 'w');
    await handle.truncate(size); await handle.close();
  }
  await prepare();
  const live = await put('output', 'extra', '');
  const originalOpen = fs.open.bind(fs);
  let enumerated = false;
  let changed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('extra')) enumerated = true;
    if (enumerated && !changed && String(args[0]).endsWith('first')) {
      changed = true;
      await fs.writeFile(live, 'now bigger');
    }
    return handle;
  });
  await assert.rejects(files.collect(task), code(413));
  assert.equal(await fs.stat(path.join(archive, 'output/extra')).catch(error => error.code), 'ENOENT');
});

test('Linux directory descriptors prevent a parent swap during archive publication from escaping',
  { skip: process.platform !== 'linux' && 'Linux 目录描述符写入检查。' }, async t => {
    const { task, files, archive, root } = await fixture(t);
    await files.saveInput(task, upload('first', 'saved'));
    const external = path.join(root, 'private');
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'next'), 'private bytes');
    const originalOpen = fs.open.bind(fs);
    let changed = false;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).includes('.task-file-') && !changed) {
        const write = handle.write.bind(handle);
        handle.write = async (...values) => {
          if (!changed) {
            changed = true;
            await fs.rename(path.join(archive, 'input'), path.join(archive, 'original'));
            await fs.symlink(external, path.join(archive, 'input'), 'dir');
          }
          return write(...values);
        };
      }
      return handle;
    });
    await assert.rejects(files.saveInput(task, upload('next', 'uploaded bytes')), code(409));
    assert.equal(await fs.readFile(path.join(external, 'next'), 'utf8'), 'private bytes');
    assert.deepEqual(await fs.readdir(path.join(archive, 'original')), ['first']);
  });

test('running, stopped and legacy tasks reject upload before creating an archive', async t => {
  const { task, session, files, root } = await fixture(t);
  for (const state of ['running', 'stopped']) await assert.rejects(files.saveInput({ ...task, status: state }, upload()), code(409));
  session.backend = 'local-pi';
  await assert.rejects(files.saveInput(task, upload()), code(409));
  assert.equal((await files.list(task)).state, 'unsupported');
  assert.deepEqual(await fs.readdir(root), []);
});

test('unprepared synchronization is a no-op and missing guest without archive is not an empty success', async t => {
  const { task, files, prepare, workspace, root } = await fixture(t);
  assert.equal((await files.hydrate(task)).synchronization, 'unprepared');
  assert.equal((await files.collect(task)).synchronization, 'unprepared');
  assert.deepEqual(await fs.readdir(root), []);
  await prepare(); await fs.rm(workspace, { recursive: true });
  await assert.rejects(files.list(task), code(404));
});

test('bad workspace metadata and archive directory links cannot be disguised by cached files', async t => {
  const { task, files, session, archive, root } = await fixture(t);
  await files.saveInput(task, upload());
  session.workspacePath = 'docs';
  await assert.rejects(files.list(task), code(403));
  session.workspacePath = null;
  await fs.rename(archive, `${archive}-original`);
  await fs.symlink(`${archive}-original`, archive, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(files.read(task, 'input', 'numbers.csv'), code(403));
  assert.equal(await fs.readFile(path.join(root, 'runtime/task-files', `${task.id}-original/input/numbers.csv`), 'utf8'), 'value\n7\n11\n');
});

test('archive and guest hardlinks are rejected without modifying their target bytes', async t => {
  const { task, files, prepare, workspace, archive, root, put } = await fixture(t);
  await files.saveInput(task, upload());
  const outside = path.join(root, 'private.txt');
  await fs.writeFile(outside, 'private');
  await prepare();
  await fs.link(outside, path.join(workspace, 'input/numbers.csv'));
  await assert.rejects(files.hydrate(task), code(403));
  await fs.unlink(path.join(workspace, 'input/numbers.csv'));
  await put('output', 'result.txt', 'new result');
  await fs.mkdir(path.join(archive, 'output'));
  await fs.link(outside, path.join(archive, 'output/result.txt'));
  await assert.rejects(files.collect(task), code(403));
  assert.equal(await fs.readFile(outside, 'utf8'), 'private');
});

test('guest linked directory causes 403 even when archive has a usable cached copy', async t => {
  const { task, files, prepare, workspace, root } = await fixture(t);
  await files.saveInput(task, upload());
  await prepare();
  await fs.rmdir(path.join(workspace, 'output'));
  await fs.mkdir(path.join(root, 'private'));
  await fs.symlink(path.join(root, 'private'), path.join(workspace, 'output'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(files.list(task), code(403));
});

test('failed output copy exposes no partial snapshot and succeeds on retry', async t => {
  const { task, files, put, archive } = await fixture(t, true);
  await put('output', 'result.txt', 'complete bytes');
  const originalOpen = fs.open.bind(fs);
  let failed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).includes('.task-file-') && !failed) {
      const write = handle.write.bind(handle);
      handle.write = async (...values) => { failed = true; await write(...values); throw Object.assign(new Error('injected disk failure'), { code: 'EIO' }); };
    }
    return handle;
  });
  await assert.rejects(files.collect(task), code(500));
  assert.equal(await fs.stat(path.join(archive, 'output/result.txt')).catch(error => error.code), 'ENOENT');
  assert.deepEqual(await fs.readdir(path.join(archive, 'output')), []);
  assert.equal((await files.read(task, 'output', 'result.txt')).data.toString(), 'complete bytes');
});

test('a changing live output serves its previous complete snapshot with an explicit cached warning', async t => {
  const { task, files, put, workspace } = await fixture(t, true);
  const live = await put('output', 'changing.txt', 'old complete');
  await files.collect(task);
  await put('output', 'changing.txt', 'new candidate');
  const originalOpen = fs.open.bind(fs);
  let changed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('changing.txt') && !changed) {
      const read = handle.read.bind(handle);
      handle.read = async (...values) => { const result = await read(...values); if (!changed) { changed = true; await fs.writeFile(live, 'changed while copying'); } return result; };
    }
    return handle;
  });
  const result = await files.read(task, 'output', 'changing.txt');
  assert.equal(result.data.toString(), 'old complete');
  assert.equal(result.synchronization, 'cached');
  assert.match(result.warning, /[\u3400-\u9fff]/);
  assert.equal(await fs.readFile(path.join(workspace, 'output/changing.txt'), 'utf8'), 'changed while copying');
});

test('concurrent uploads serialize duplicate decisions and preserve the winning bytes', async t => {
  const { task, files } = await fixture(t);
  const results = await Promise.allSettled([files.saveInput(task, upload('same', 'first')), files.saveInput(task, upload('same', 'second')),
    files.saveInput(task, upload('different', 'third'))]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.statusCode, 409);
  assert.equal(results[2].status, 'fulfilled');
  assert.equal((await files.read(task, 'input', 'same')).data.toString(), 'first');
});

test('historical inputs above the upload limit remain readable and hydratable without relaxing new uploads', async t => {
  const { task, files, put, workspace } = await fixture(t, true);
  const historical = Buffer.alloc(600_001, 97);
  await put('input', 'historical.csv', historical);
  await put('output', 'result.txt', 'existing result');
  const listed = await files.list(task);
  assert.deepEqual(listed.files.map(file => [file.id, file.size]), [
    ['input:historical.csv', 600_001], ['output:result.txt', 15],
  ]);
  assert.deepEqual((await files.read(task, 'input', 'historical.csv')).data, historical);
  assert.equal((await files.read(task, 'output', 'result.txt')).data.toString(), 'existing result');
  await put('input', 'historical.csv', 'guest edit');
  await files.hydrate(task);
  assert.deepEqual(await fs.readFile(path.join(workspace, 'input/historical.csv')), historical);
  await assert.rejects(files.saveInput(task, { name: 'new-upload.csv', contentBase64: historical.toString('base64') }), code(413));
});

test('existing inputs and single outputs above 50 MB fail explicitly before archive publication', async t => {
  const { task, files, put, workspace } = await fixture(t, true);
  const largeInput = await fs.open(await put('input', 'large.csv', ''), 'w');
  await largeInput.truncate(50_000_001); await largeInput.close();
  await assert.rejects(files.collect(task), code(413));
  await fs.unlink(path.join(workspace, 'input/large.csv'));
  const handle = await fs.open(path.join(workspace, 'output/large.bin'), 'w');
  await handle.truncate(50_000_001); await handle.close();
  await assert.rejects(files.list(task), code(413));
});

test('archive aggregate and entry budgets also constrain uploads', async t => {
  const { task, files, archive } = await fixture(t);
  await files.saveInput(task, upload('first', 'a'));
  await fs.mkdir(path.join(archive, 'output'));
  for (const [name, size] of [['a', 50_000_000], ['b', 49_999_999]]) {
    const handle = await fs.open(path.join(archive, 'output', name), 'w');
    await handle.truncate(size); await handle.close();
  }
  await assert.rejects(files.saveInput(task, upload('overflow', 'b')), code(413));
  await fs.rm(path.join(archive, 'output'), { recursive: true });
  for (let batch = 0; batch < 10; batch++) await Promise.all(Array.from({ length: batch === 9 ? 99 : 100 }, (_, i) =>
    fs.mkdir(path.join(archive, 'input', `empty-${batch * 100 + i}`))));
  await assert.rejects(files.saveInput(task, upload('overflow', 'b')), code(413));
});
