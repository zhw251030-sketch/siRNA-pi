import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceFiles, WorkspaceFileError } from '../packages/task-core/workspace.mjs';

const sandboxId = 'a'.repeat(64);
const relativeWorkspace = `runtime/agent-compose/data/sandboxes/2026/10/20/${sandboxId}/workspace`;
const task = { id: 'web-task', executionSessionId: 'execution-session', status: 'stopped' };

async function fixture(t, { prepared = true, backend = 'agent-compose' } = {}) {
  const parent = path.resolve('runtime/task-file-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'case-'));
  const workspace = path.join(root, relativeWorkspace);
  if (prepared) {
    await fs.mkdir(path.join(workspace, 'input'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'output'));
  }
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    await fs.rm(root, { recursive: true, force: true });
  });
  const session = { id: task.executionSessionId, backend, sandboxId: prepared ? sandboxId : null,
    workspacePath: prepared ? relativeWorkspace : null, runs: [], status: 'stopped' };
  const agentRuntime = { async status(id) {
    assert.equal(id, task.executionSessionId);
    return session;
  } };
  const files = new WorkspaceFiles({ root, agentRuntime });
  async function put(kind, name, data = 'abc') {
    const target = path.join(workspace, kind, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    return target;
  }
  return { root, workspace, session, files, put };
}

function status(code) {
  return error => error instanceof WorkspaceFileError && error.statusCode === code &&
    /[\u3400-\u9fff]/.test(error.message) && !error.message.includes('case-');
}

async function sparse(file, size) {
  const handle = await fs.open(file, 'w');
  try { await handle.truncate(size); } finally { await handle.close(); }
}

test('task files list only nested input/output files with real bytes, hashes and dates after task end', async t => {
  const { root, workspace, files, put } = await fixture(t);
  await put('input', 'numbers.csv', 'abc');
  const content = Buffer.from([0, 255, 34, 13, 10]);
  await put('output', '结果/data.bin', content);
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'docs/auth.json'), 'must-not-be-listed');
  await fs.writeFile(path.join(workspace, 'private.txt'), 'must-not-be-listed');
  const result = await files.list(task);
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.files.map(({ id, name, kind, size }) => ({ id, name, kind, size })), [
    { id: 'input:numbers.csv', name: 'numbers.csv', kind: 'input', size: 3 },
    { id: 'output:结果/data.bin', name: '结果/data.bin', kind: 'output', size: 5 },
  ]);
  assert.equal(result.files[0].sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const file of result.files) assert.equal(new Date(file.modifiedAt).toISOString(), file.modifiedAt);
  const read = await files.read(task, 'output', '结果/data.bin');
  assert.deepEqual(read.data, content);
  assert.deepEqual(read.file, result.files[1]);
  assert.equal(read.file.sha256, createHash('sha256').update(content).digest('hex'));
});

test('unprepared tasks are reported without creating any workspace', async t => {
  const { root, files } = await fixture(t, { prepared: false });
  const result = await files.list(task);
  assert.equal(result.state, 'unprepared');
  assert.deepEqual(result.files, []);
  await assert.rejects(files.read(task, 'output', 'result.json'), status(404));
  assert.deepEqual(await fs.readdir(root), []);
});

test('legacy tasks are explicitly unsupported without reading their directories', async t => {
  const { files } = await fixture(t, { backend: 'local-pi' });
  const result = await files.list(task);
  assert.equal(result.state, 'unsupported');
  assert.deepEqual(result.files, []);
  await assert.rejects(files.read(task, 'input', 'numbers.csv'), status(409));
});

test('missing saved workspace is an error while absent input/output directories are empty', async t => {
  const { workspace, files } = await fixture(t);
  await fs.rmdir(path.join(workspace, 'input'));
  await fs.rmdir(path.join(workspace, 'output'));
  assert.deepEqual(await files.list(task), { state: 'ready', files: [] });
  await assert.rejects(files.read(task, 'input', 'missing.csv'), status(404));
  await fs.rmdir(workspace);
  await assert.rejects(files.list(task), status(404));
});

test('workspace metadata cannot redirect into another sandbox, private tree or normalized alias', async t => {
  const { root, session, files } = await fixture(t);
  for (const candidate of [
    relativeWorkspace.replace(sandboxId, 'b'.repeat(64)),
    'docs', path.join(root, relativeWorkspace), `${relativeWorkspace}/../workspace`,
    relativeWorkspace.replace('/2026/10/20/', '/2026/1/20/'),
  ]) {
    session.workspacePath = candidate;
    await assert.rejects(files.list(task), status(403));
    await assert.rejects(files.read(task, 'input', 'numbers.csv'), status(403));
  }
});

test('file requests reject traversal, ambiguous segments, excessive depth and private kinds', async t => {
  const { files } = await fixture(t);
  for (const name of ['', '.', '..', '../docs/auth.json', '/etc/passwd', 'C:/secret', 'x\\y',
    'x//y', 'x/./y', 'x/../y', 'x\0y', 'x\ny', 'x:y', 'x?y', 'x*y', 'x<y', 'x|y',
    'x"y', 'trailing.', 'trailing ', 'con', 'NUL.txt', 'x'.repeat(181),
    Array(17).fill('a').join('/'), Array(16).fill('a'.repeat(70)).join('/')]) {
    await assert.rejects(files.read(task, 'output', name), status(400), name);
  }
  await assert.rejects(files.read(task, 'state', 'pi.json'), status(400));
});

test('missing files return a safe 404 and directory reads are denied', async t => {
  const { files, put } = await fixture(t);
  await put('output', 'nested/result.json');
  await assert.rejects(files.read(task, 'output', 'nested/missing.json'), status(404));
  await assert.rejects(files.read(task, 'output', 'nested'), status(403));
});

test('hardlinked files are hidden from lists and cannot be read directly', async t => {
  const { root, workspace, files, put } = await fixture(t);
  await fs.writeFile(path.join(root, 'secret.txt'), 'private');
  await fs.link(path.join(root, 'secret.txt'), path.join(workspace, 'output/linked.txt'));
  await put('output', 'safe.txt');
  assert.deepEqual((await files.list(task)).files.map(file => file.name), ['safe.txt']);
  await assert.rejects(files.read(task, 'output', 'linked.txt'), status(403));
});

test('linked directories are never traversed, including links above the workspace', async t => {
  const { root, workspace, files, put } = await fixture(t);
  await fs.mkdir(path.join(root, 'private'));
  await fs.writeFile(path.join(root, 'private/secret.txt'), 'private');
  await fs.symlink(path.join(root, 'private'), path.join(workspace, 'output/linked'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await put('output', 'safe.txt');
  assert.deepEqual((await files.list(task)).files.map(file => file.name), ['safe.txt']);
  await assert.rejects(files.read(task, 'output', 'linked/secret.txt'), status(403));
  const sandboxes = path.join(root, 'runtime/agent-compose/data/sandboxes');
  await fs.rename(sandboxes, `${sandboxes}-real`);
  await fs.symlink(`${sandboxes}-real`, sandboxes, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(files.list(task), status(403));
});

test('symbolic file links are hidden and cannot be opened', async t => {
  const { root, workspace, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'secret.txt'), 'private');
  try { await fs.symlink(path.join(root, 'secret.txt'), path.join(workspace, 'output/linked.txt'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows 当前账号没有创建文件符号链接权限；Linux 部署验证仍须运行此项。'); return;
    }
    throw error;
  }
  assert.deepEqual((await files.list(task)).files, []);
  await assert.rejects(files.read(task, 'output', 'linked.txt'), status(403));
});

test('named pipes are omitted and direct reads fail without waiting for a writer',
  { skip: process.platform !== 'linux' && '命名管道安全检查在 Linux 部署环境运行。' }, async t => {
    const { workspace, files } = await fixture(t);
    execFileSync('mkfifo', [path.join(workspace, 'output/pipe')]);
    assert.deepEqual((await files.list(task)).files, []);
    await assert.rejects(files.read(task, 'output', 'pipe'), status(403));
  });

test('Linux descriptor traversal detects a parent replacement during an actual read',
  { skip: process.platform !== 'linux' && '目录描述符与父目录替换检查在 Linux 部署环境运行。' }, async t => {
    const { root, workspace, files, put } = await fixture(t);
    await put('output', 'nested/result.txt', 'task-content');
    await fs.mkdir(path.join(root, 'private'));
    await fs.writeFile(path.join(root, 'private/result.txt'), 'private-content');
    const originalOpen = fs.open.bind(fs);
    let replaced = false;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith('result.txt')) {
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          if (!replaced) {
            replaced = true;
            await fs.rename(path.join(workspace, 'output/nested'), path.join(workspace, 'output/original'));
            await fs.symlink(path.join(root, 'private'), path.join(workspace, 'output/nested'), 'dir');
          }
          return read(...readArgs);
        };
      }
      return handle;
    });
    await assert.rejects(files.read(task, 'output', 'nested/result.txt'), status(409));
    assert.equal(replaced, true);
  });

test('preview byte limit rejects the whole read rather than returning truncated content', async t => {
  const { files, put } = await fixture(t);
  await put('output', 'small.txt', 'hello');
  assert.equal((await files.read(task, 'output', 'small.txt', { maxBytes: 5 })).data.toString(), 'hello');
  await assert.rejects(files.read(task, 'output', 'small.txt', { maxBytes: 4 }), status(413));
});

test('oversized files cause explicit list and download errors', async t => {
  const { workspace, files } = await fixture(t);
  await sparse(path.join(workspace, 'output/large.bin'), 50_000_001);
  await assert.rejects(files.list(task), status(413));
  await assert.rejects(files.read(task, 'output', 'large.bin'), status(413));
});

test('aggregate hashing budget rejects incomplete lists', async t => {
  const { workspace, files } = await fixture(t);
  for (const name of ['first.bin', 'second.bin', 'third.bin'])
    await sparse(path.join(workspace, 'output', name), 40 * 1024 * 1024);
  await assert.rejects(files.list(task), status(413));
});

test('directory entry budget counts directories as well as returned files', async t => {
  const { workspace, files } = await fixture(t);
  for (let batch = 0; batch < 11; batch++) {
    await Promise.all(Array.from({ length: batch === 10 ? 1 : 100 }, (_, offset) =>
      fs.mkdir(path.join(workspace, 'output', `empty-${batch * 100 + offset}`))));
  }
  await assert.rejects(files.list(task), status(413));
});

test('a file changing during a read is rejected instead of returning an inconsistent hash', async t => {
  const { files, put } = await fixture(t);
  const target = await put('output', 'changing.txt', 'abc');
  const originalOpen = fs.open.bind(fs);
  let changed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('changing.txt')) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!changed) { changed = true; await fs.writeFile(target, 'changed-during-read'); }
        return result;
      };
    }
    return handle;
  });
  await assert.rejects(files.read(task, 'output', 'changing.txt'), status(409));
  assert.equal(changed, true);
});
