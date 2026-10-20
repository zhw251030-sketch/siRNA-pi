import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const guest = await import('../scripts/lib/tool-validation-guest.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error;
});
test('real workspace digest includes ordered directories, relative paths and actual bytes', () => {
  assert.equal(typeof guest.digestWorkspace, 'function', 'trusted digest helper must exist');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-validation-guest-'));
  try {
    fs.mkdirSync(path.join(root, 'b')); fs.writeFileSync(path.join(root, 'z'), 'Z'); fs.writeFileSync(path.join(root, 'b', 'x'), 'hello');
    assert.equal(guest.digestWorkspace(root), createHash('sha256').update('d:b\0f:b/x\0'+'5\0hello'+'f:z\0'+'1\0Z').digest('hex'));
    fs.writeFileSync(path.join(root, 'b', 'x'), 'changed');
    assert.equal(guest.digestWorkspace(root), createHash('sha256').update('d:b\0f:b/x\0'+'7\0changed'+'f:z\0'+'1\0Z').digest('hex'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('workspace digest frames file byte length so content cannot impersonate another path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-validation-framing-'));
  const first = path.join(root, 'first'); const second = path.join(root, 'second');
  try {
    fs.mkdirSync(first); fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, 'a'), 'xf:b\0y');
    fs.writeFileSync(path.join(second, 'a'), 'x'); fs.writeFileSync(path.join(second, 'b'), 'y');
    assert.notEqual(guest.digestWorkspace(first), guest.digestWorkspace(second));
    // UTF-8 and arbitrary binary bytes remain verbatim; framing uses bytes.
    fs.writeFileSync(path.join(first, 'a'), Buffer.from([0xc3, 0xa9, 0, 0xff]));
    assert.equal(guest.digestWorkspace(first), createHash('sha256').update('f:a\0'+'4\0').update(Buffer.from([0xc3, 0xa9, 0, 0xff])).digest('hex'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('digest rejects hardlinks and excessive files rather than hashing a misleading subset', () => {
  assert.equal(typeof guest.digestWorkspace, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-validation-guest-'));
  try {
    fs.writeFileSync(path.join(root, 'one'), '1'); fs.linkSync(path.join(root, 'one'), path.join(root, 'two'));
    assert.throws(() => guest.digestWorkspace(root), /regular|link/);
    fs.unlinkSync(path.join(root, 'two')); fs.writeFileSync(path.join(root, 'two'), '2');
    assert.throws(() => guest.digestWorkspace(root, { maxEntries: 1 }), /limit/);
    assert.throws(() => guest.digestWorkspace(root, { maxBytes: 1 }), /limit/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('digest rejects directory links without reading their external target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-validation-guest-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-validation-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret'), 'must not hash');
    fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => guest.digestWorkspace(root), /link/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});
