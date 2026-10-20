import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createToolProposal, readToolProposal } from '../packages/capability-platform/tool-proposals.mjs';
const fixture = JSON.parse(fs.readFileSync(new URL('../examples/04-tool-contract/proposal.draft.json', import.meta.url), 'utf8'));

function proposal() {
  const input = structuredClone(fixture);
  // Structure-only fixture: this digest has no real image/build behind it.
  // Nothing in this suite executes candidate or baseline source.
  input.runtimeArtifact = {
    protocolVersion: 'sirna-tool-runtime-artifact/v1', imageDigest: `sha256:${'a'.repeat(64)}`,
    command: ['/usr/local/bin/node', '/opt/tool/main.mjs'], platform: 'linux/amd64',
    createdAt: '2026-10-20T00:00:00.000Z', buildSessionId: '12345678-1234-4234-8234-123456789abc',
  };
  input.script = 'throw new Error("候选 must never execute");\r\n';
  input.baseline.script = 'throw new Error("baseline must never execute");\n';
  return input;
}

function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-proposals-')));
  t.after(() => {
    function writable(directory) {
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) writable(file);
        else fs.chmodSync(file, 0o600);
      }
    }
    writable(root);
    fs.rmSync(root, { recursive: true });
  });
  return root;
}

function digest(directory) {
  const hash = createHash('sha256');
  for (const name of fs.readdirSync(directory).sort()) {
    hash.update(`${name}\0`);
    hash.update(fs.readFileSync(path.join(directory, name)));
  }
  return hash.digest('hex');
}

function edit(result, filename, bytes) {
  const file = path.join(result.artifactPath, filename);
  fs.chmodSync(result.artifactPath, 0o700);
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, bytes);
}

function editManifest(result, change) {
  const manifest = JSON.parse(fs.readFileSync(path.join(result.artifactPath, 'manifest.json'), 'utf8'));
  change(manifest);
  edit(result, 'manifest.json', JSON.stringify(manifest));
}

test('creates a three-file draft, reads back actual bytes and independently hashes the package', t => {
  assert.equal(typeof createToolProposal, 'function');
  assert.equal(typeof readToolProposal, 'function');
  const root = temporary(t);
  const input = proposal();
  const before = JSON.stringify(input);
  const result = createToolProposal(input, { proposalsRoot: root });
  assert.match(result.manifest.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(result.artifactPath, path.join(root, result.manifest.id));
  assert.deepEqual(fs.readdirSync(result.artifactPath).sort(), ['baseline.mjs', 'manifest.json', 'tool.mjs']);
  assert.deepEqual(result.input, input);
  assert.notEqual(result.input, input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(fs.readFileSync(path.join(result.artifactPath, 'tool.mjs'), 'utf8'), input.script);
  assert.equal(fs.readFileSync(path.join(result.artifactPath, 'baseline.mjs'), 'utf8'), input.baseline.script);
  assert.equal(result.manifest.scriptSha256, createHash('sha256').update(input.script).digest('hex'));
  assert.equal(result.manifest.baselineScriptSha256, createHash('sha256').update(input.baseline.script).digest('hex'));
  assert.equal(result.artifactSha256, digest(result.artifactPath));
  assert.deepEqual(readToolProposal(result.manifest.id, { proposalsRoot: root, expectedArtifactSha256: result.artifactSha256 }), result);
  result.input.smokeInput.sequence = 'modified result';
  assert.equal(readToolProposal(result.manifest.id, { proposalsRoot: root }).input.smokeInput.sequence, 'ACGT');
});

test('same input creates distinct proposal UUIDs without deduplication', t => {
  const root = temporary(t);
  const first = createToolProposal(proposal(), { proposalsRoot: root });
  const second = createToolProposal(proposal(), { proposalsRoot: root });
  assert.notEqual(first.manifest.id, second.manifest.id);
  assert.equal(fs.readdirSync(root).length, 2);
});

test('preserves source BOM, multibyte text and exact 200000-byte boundary', t => {
  const root = temporary(t);
  const input = proposal();
  input.script = '\ufeff' + 'x'.repeat(199997);
  input.baseline.script = '界'.repeat(66666) + 'xx';
  const result = createToolProposal(input, { proposalsRoot: root });
  assert.deepEqual(result.input, input);
  assert.equal(fs.statSync(path.join(result.artifactPath, 'tool.mjs')).size, 200000);
  assert.equal(fs.statSync(path.join(result.artifactPath, 'baseline.mjs')).size, 200000);
});

for (const field of ['script', 'baseline']) {
  test(`rejects a non-lossless UTF-8 ${field} instead of silently replacing its source`, t => {
    const root = temporary(t);
    const input = proposal();
    if (field === 'script') input.script = 'source \ud800';
    else input.baseline.script = 'source \udfff';
    assert.throws(() => createToolProposal(input, { proposalsRoot: root }), /UTF-8/);
    assert.deepEqual(fs.readdirSync(root), []);
  });
}

test('detects an earlier file changed while another package file is being read', t => {
  const root = temporary(t);
  const result = createToolProposal(proposal(), { proposalsRoot: root });
  const original = fs.readSync;
  let changed = false;
  // Inject a real concurrent-style file edit at the filesystem read boundary;
  // all reads, stats, writes and assertions still use real files.
  fs.readSync = function(descriptor, buffer, offset, length, position) {
    const count = original.call(this, descriptor, buffer, offset, length, position);
    if (!changed && count && buffer.subarray(offset, offset + count).toString('utf8').includes('候选')) {
      changed = true;
      editManifest(result, manifest => { manifest.description += ' changed during another read'; });
    }
    return count;
  };
  try {
    assert.throws(() => readToolProposal(result.manifest.id, { proposalsRoot: root }), /changed/);
  } finally {
    fs.readSync = original;
  }
  assert.equal(changed, true);
});

test('rejects invalid UTF-8 even when the manifest source digest matches its raw bytes', t => {
  const root = temporary(t);
  const result = createToolProposal(proposal(), { proposalsRoot: root });
  const bytes = Buffer.from([0xff, 0xfe, 0x61]);
  edit(result, 'tool.mjs', bytes);
  editManifest(result, manifest => { manifest.scriptSha256 = createHash('sha256').update(bytes).digest('hex'); });
  assert.throws(() => readToolProposal(result.manifest.id, { proposalsRoot: root }), /encoded data|encoding|UTF/i);
});

test('retains partial create files and attaches their exact lifecycle identity on write failure', t => {
  const root = temporary(t);
  const original = fs.writeFileSync;
  let failure;
  // Deterministic disk-failure injection; the preceding source write is real.
  fs.writeFileSync = function(file, ...args) {
    if (path.dirname(path.dirname(file)) === root && path.basename(file) === 'baseline.mjs') {
      throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
    }
    return original.call(this, file, ...args);
  };
  try {
    assert.throws(() => createToolProposal(proposal(), { proposalsRoot: root }), error => {
      failure = error;
      assert.equal(error.code, 'EIO');
      assert.match(error.proposalId, /^[0-9a-f-]{36}$/);
      assert.equal(error.artifactPath, path.join(root, error.proposalId));
      return true;
    });
  } finally {
    fs.writeFileSync = original;
  }
  assert.deepEqual(fs.readdirSync(root), [failure.proposalId]);
  assert.deepEqual(fs.readdirSync(failure.artifactPath), ['tool.mjs']);
  assert.equal(fs.readFileSync(path.join(failure.artifactPath, 'tool.mjs'), 'utf8'), proposal().script);
  assert.throws(() => readToolProposal(failure.proposalId, { proposalsRoot: root }));
});

for (const expectedArtifactSha256 of ['sha256:' + 'a'.repeat(64), 'A'.repeat(64), '', null, 123]) {
  test(`rejects malformed external artifact pin ${JSON.stringify(expectedArtifactSha256)}`, t => {
    const root = temporary(t);
    const result = createToolProposal(proposal(), { proposalsRoot: root });
    assert.throws(() => readToolProposal(result.manifest.id, { proposalsRoot: root, expectedArtifactSha256 }));
  });
}

for (const [runtime, extension] of [['node', 'mjs'], ['python', 'py'], ['bash', 'sh']]) {
  test(`uses fixed ${runtime} source filename and supports a different baseline runtime`, t => {
    const root = temporary(t);
    const input = proposal();
    input.runtime = runtime;
    input.baseline.runtime = 'bash';
    delete input.minNetGain;
    const result = createToolProposal(input, { proposalsRoot: root });
    assert.equal(result.manifest.scriptFile, `tool.${extension}`);
    assert.equal(result.manifest.baselineScriptFile, 'baseline.sh');
    assert.equal(Object.hasOwn(result.manifest, 'minNetGain'), false);
    assert.deepEqual(readToolProposal(result.manifest.id, { proposalsRoot: root }).input, input);
  });
}

for (const [label, change] of [
  ['missing artifact', input => { delete input.runtimeArtifact; }],
  ['incomplete contract', input => { delete input.smokeInput; }],
  ['invalid field', input => { input.toolName = 'Bad Name'; }],
  ['parent relationship', input => { input.parent = { toolName: 'prior_tool', version: '1.0.0' }; }],
  ['oversized source', input => { input.script = 'x'.repeat(200001); }],
  ['oversized baseline', input => { input.baseline.script = 'x'.repeat(200001); }],
  ['oversized manifest', input => { input.smokeInput.large = 'x'.repeat(1024 * 1024); }],
]) {
  test(`rejects ${label} before publishing any package`, t => {
    const root = temporary(t);
    const input = proposal();
    change(input);
    assert.throws(() => createToolProposal(input, { proposalsRoot: root }));
    assert.deepEqual(fs.readdirSync(root), []);
  });
}

for (const label of ['relative', 'missing', 'file']) {
  test(`rejects a ${label} proposals root`, t => {
    const root = temporary(t);
    const file = path.join(root, 'root-file');
    fs.writeFileSync(file, 'file');
    const candidate = { relative: '.', missing: path.join(root, 'absent'), file }[label];
    assert.throws(() => createToolProposal(proposal(), { proposalsRoot: candidate }));
    assert.throws(() => readToolProposal('10000000-0000-4000-8000-000000000000', { proposalsRoot: candidate }));
  });
}

for (const id of ['../escape', '', 'invalid', '10000000-0000-4000-8000-000000000000/../outside', 'A0000000-0000-4000-8000-000000000000']) {
  test(`rejects invalid proposal identifier ${JSON.stringify(id)}`, t => {
    assert.throws(() => readToolProposal(id, { proposalsRoot: temporary(t) }));
  });
}

for (const filename of ['tool.mjs', 'baseline.mjs']) {
  test(`detects changed ${filename} without trusting its stored source digest`, t => {
    const root = temporary(t);
    const result = createToolProposal(proposal(), { proposalsRoot: root });
    edit(result, filename, 'tampered source');
    assert.throws(() => readToolProposal(result.manifest.id, { proposalsRoot: root }));
  });
}

test('external expected digest detects consistent source/hash rewrite and manifest-only edits', t => {
  const root = temporary(t);
  const result = createToolProposal(proposal(), { proposalsRoot: root });
  edit(result, 'tool.mjs', 'changed but structurally valid source');
  editManifest(result, manifest => {
    manifest.scriptSha256 = createHash('sha256').update('changed but structurally valid source').digest('hex');
    manifest.description = 'Changed description is still structurally acceptable.';
  });
  assert.notEqual(readToolProposal(result.manifest.id, { proposalsRoot: root }).artifactSha256, result.artifactSha256);
  assert.throws(() => readToolProposal(result.manifest.id, { proposalsRoot: root, expectedArtifactSha256: result.artifactSha256 }));
});

for (const [label, change] of [
  ['unknown field', manifest => { manifest.extra = true; }],
  ['missing field', manifest => { delete manifest.testCases; }],
  ['wrong id', manifest => { manifest.id = '10000000-0000-4000-8000-000000000000'; }],
  ['wrong protocol', manifest => { manifest.protocolVersion = 'unknown'; }],
  ['wrong status', manifest => { manifest.status = 'approved'; }],
  ['wrong version', manifest => { manifest.version = '1.0.0'; }],
  ['unsafe source path', manifest => { manifest.scriptFile = '../tool.mjs'; }],
  ['unsafe baseline path', manifest => { manifest.baselineScriptFile = '../baseline.mjs'; }],
  ['wrong runtime extension', manifest => { manifest.runtime = 'python'; }],
  ['invalid date', manifest => { manifest.createdAt = 'yesterday'; }],
  ['noncanonical date', manifest => { manifest.createdAt = '2026-10-20'; }],
  ['invalid source hash', manifest => { manifest.scriptSha256 = 'sha256:abc'; }],
  ['invalid restored contract', manifest => { manifest.permissions = { profile: 'unknown' }; }],
]) {
  test(`rejects manifest ${label}`, t => {
    const root = temporary(t);
    const result = createToolProposal(proposal(), { proposalsRoot: root });
    editManifest(result, change);
    assert.throws(() => readToolProposal(result.manifest.id, { proposalsRoot: root }));
  });
}

for (const filename of ['manifest.json', 'tool.mjs', 'baseline.mjs']) {
  test(`rejects missing ${filename} and retains lifecycle context on read error`, t => {
    const root = temporary(t);
    const result = createToolProposal(proposal(), { proposalsRoot: root });
    fs.chmodSync(result.artifactPath, 0o700);
    fs.chmodSync(path.join(result.artifactPath, filename), 0o600);
    fs.unlinkSync(path.join(result.artifactPath, filename));
    assert.throws(() => readToolProposal(result.manifest.id, { proposalsRoot: root }), error => {
      assert.equal(error.proposalId, result.manifest.id);
      assert.equal(error.artifactPath, result.artifactPath);
      return true;
    });
  });
}

for (const kind of ['file', 'directory']) {
  test(`rejects extra ${kind} inside the exact package`, t => {
    const root = temporary(t);
    const result = createToolProposal(proposal(), { proposalsRoot: root });
    fs.chmodSync(result.artifactPath, 0o700);
    const extra = path.join(result.artifactPath, 'extra');
    if (kind === 'file') fs.writeFileSync(extra, 'extra');
    else fs.mkdirSync(extra);
    assert.throws(() => readToolProposal(result.manifest.id, { proposalsRoot: root }));
  });
}

for (const [label, bytes] of [
  ['invalid JSON', Buffer.from('SOURCE_SECRET_MARKER')],
  ['invalid UTF-8', Buffer.concat([Buffer.from('SOURCE_SECRET_MARKER'), Buffer.from([0xff])])],
]) {
  test(`sanitizes manifest ${label} diagnostics and retains package identity`, t => {
    const root = temporary(t);
    const result = createToolProposal(proposal(), { proposalsRoot: root });
    edit(result, 'manifest.json', bytes);
    assert.throws(() => readToolProposal(result.manifest.id, { proposalsRoot: root }), error => {
      assert.equal(error.message.includes('SOURCE_SECRET_MARKER'), false);
      assert.equal(error.message, 'proposal manifest must be valid UTF-8 JSON');
      assert.equal(error.proposalId, result.manifest.id);
      assert.equal(error.artifactPath, result.artifactPath);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
  });
}

for (const [filename, bytes] of [
  ['manifest.json', Buffer.from([0xff])], ['tool.mjs', Buffer.from([0xc3, 0x28])],
  ['baseline.mjs', Buffer.alloc(200001, 97)], ['manifest.json', Buffer.alloc(1024 * 1024 + 1, 32)],
]) {
  test(`rejects invalid UTF-8 or oversize ${filename} (${bytes.length} bytes)`, t => {
    const root = temporary(t);
    const result = createToolProposal(proposal(), { proposalsRoot: root });
    edit(result, filename, bytes);
    assert.throws(() => readToolProposal(result.manifest.id, { proposalsRoot: root }));
  });
}

test('rejects hard-linked source even when its bytes and hash are unchanged', t => {
  const root = temporary(t);
  const result = createToolProposal(proposal(), { proposalsRoot: root });
  fs.linkSync(path.join(result.artifactPath, 'tool.mjs'), path.join(root, 'hardlink'));
  assert.throws(() => readToolProposal(result.manifest.id, { proposalsRoot: root }));
});

test('rejects links at the root, package and source boundaries', t => {
  const root = temporary(t);
  const actual = path.join(root, 'actual');
  fs.mkdirSync(actual);
  const linked = path.join(root, 'linked');
  try { fs.symlinkSync(actual, linked, 'junction'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('symlink creation unavailable'); return; } throw error; }
  assert.throws(() => createToolProposal(proposal(), { proposalsRoot: linked }));
  const result = createToolProposal(proposal(), { proposalsRoot: actual });
  const alternateId = '10000000-0000-4000-8000-000000000000';
  fs.symlinkSync(result.artifactPath, path.join(actual, alternateId), 'junction');
  assert.throws(() => readToolProposal(alternateId, { proposalsRoot: actual }));
  const file = path.join(result.artifactPath, 'tool.mjs');
  fs.chmodSync(result.artifactPath, 0o700);
  fs.chmodSync(file, 0o600);
  fs.renameSync(file, path.join(actual, 'source'));
  try { fs.symlinkSync(path.join(actual, 'source'), file, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('file symlink unavailable; root/package junction cases verified'); return; } throw error; }
  assert.throws(() => readToolProposal(result.manifest.id, { proposalsRoot: actual }));
});

test('freezes only this package on POSIX without changing the caller root', { skip: process.platform === 'win32' }, t => {
  const root = temporary(t);
  const rootMode = fs.statSync(root).mode & 0o777;
  const result = createToolProposal(proposal(), { proposalsRoot: root });
  assert.equal(fs.statSync(root).mode & 0o777, rootMode);
  assert.equal(fs.statSync(result.artifactPath).mode & 0o777, 0o500);
  for (const name of fs.readdirSync(result.artifactPath)) {
    assert.equal(fs.statSync(path.join(result.artifactPath, name)).mode & 0o777, 0o400);
  }
});
