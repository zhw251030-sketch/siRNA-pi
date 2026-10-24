import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import {ToolApprovalStore} from '../packages/capability-platform/tool-approval-store.mjs';

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-approval-store-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, store: new ToolApprovalStore({root, ...options})};
}

function concurrentWorker(root, mode, shared) {
  const moduleUrl = pathToFileURL(path.resolve('packages/capability-platform/tool-approval-store.mjs')).href;
  const source = `import {parentPort, workerData} from 'node:worker_threads';
import {ToolApprovalStore} from ${JSON.stringify(moduleUrl)};
const state = new Int32Array(workerData.shared);
const store = new ToolApprovalStore({root: workerData.root, isVerified: () => true});
const arrived = Atomics.add(state, 0, 1) + 1;
if (arrived < 2) Atomics.wait(state, 0, 1);
else Atomics.notify(state, 0);
try {
  const value = workerData.mode === 'claim' ? store.claim() : store.finish(workerData.id, {approved: true, activated: true});
  parentPort.postMessage({ok: true, value});
} catch (error) {
  parentPort.postMessage({ok: false, error: error.message});
} finally { store.close(); }`;
  return new Worker(source, {eval: true, workerData: {root, mode, id: shared.id, shared: shared.buffer}});
}

function workerResult(worker) {
  return new Promise((resolve, reject) => {
    let result;
    worker.once('message', value => { result = value; });
    worker.once('exit', () => resolve(result));
    worker.once('error', reject);
  });
}

test('validates UUIDs and admits only verified proposals through the binding', t => {
  const {store} = fixture(t, {isVerified: id => id === verified});
  const verified = randomUUID();
  assert.throws(() => store.enqueue('not-a-uuid', randomUUID(), {approvedBy: 'reviewer'}), /UUID/i);
  assert.throws(() => store.enqueue(randomUUID(), 'not-a-uuid', {approvedBy: 'reviewer'}), /UUID/i);
  assert.throws(() => store.enqueue(randomUUID(), randomUUID(), {approvedBy: 'reviewer'}), /verified/i);
  const result = store.enqueue(verified, randomUUID(), {approvedBy: 'reviewer'});
  assert.equal(result.job.proposalId, verified);
  assert.equal(result.job.requestedBy, 'reviewer');
  store.close();
});

test('deduplicates the same request and rejects binding it to another proposal', t => {
  const {store} = fixture(t, {isVerified: () => true});
  const proposal = randomUUID(), other = randomUUID(), request = randomUUID();
  const first = store.enqueue(proposal, request, {approvedBy: ' reviewer  one '});
  const duplicate = store.enqueue(proposal, request, {approvedBy: 'different'});
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.job.id, first.job.id);
  assert.throws(() => store.enqueue(other, request, {approvedBy: 'reviewer'}), /different proposal/i);
  assert.equal(store.getByRequest(request).id, first.job.id);
  assert.equal(store.latest(proposal).id, first.job.id);
  store.close();
});

test('rechecks verified admission on an idempotent retry', t => {
  let verified = true;
  const {store} = fixture(t, {isVerified: () => verified});
  const proposal = randomUUID(), request = randomUUID();
  store.enqueue(proposal, request, {approvedBy: 'reviewer'});
  verified = false;
  assert.throws(() => store.enqueue(proposal, request, {approvedBy: 'reviewer'}), /verified/i);
  store.close();
});

test('claims one running job globally across two SQLite connections', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-approval-connections-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const first = new ToolApprovalStore({root, isVerified: () => true});
  const second = new ToolApprovalStore({root, isVerified: () => true});
  const a = first.enqueue(randomUUID(), randomUUID(), {approvedBy: 'a'}).job;
  const b = first.enqueue(randomUUID(), randomUUID(), {approvedBy: 'b'}).job;
  assert.equal(first.claim().id, a.id);
  assert.equal(second.claim(), null);
  assert.equal(first.get(b.id).status, 'pending');
  first.close(); second.close();
});

test('two connections race for pending work with exactly one claimant', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-approval-race-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const first = new ToolApprovalStore({root, isVerified: () => true});
  const second = new ToolApprovalStore({root, isVerified: () => true});
  first.enqueue(randomUUID(), randomUUID(), {approvedBy: 'a'});
  second.enqueue(randomUUID(), randomUUID(), {approvedBy: 'b'});
  const claims = [first.claim(), second.claim()];
  assert.equal(claims.filter(Boolean).length, 1);
  first.close(); second.close();
});

test('finishes running jobs only and records terminal result safely', t => {
  const {store} = fixture(t, {isVerified: () => true});
  const job = store.enqueue(randomUUID(), randomUUID(), {approvedBy: 'reviewer'}).job;
  assert.throws(() => store.finish(job.id, {approved: true, activated: true}), /running/i);
  store.claim();
  const done = store.finish(job.id, {approved: true, activated: true});
  assert.deepEqual({approved: done.approved, activated: done.activated}, {approved: true, activated: true});
  assert.throws(() => store.finish(job.id, {approved: true, activated: true}), /running/i);
  const failed = store.enqueue(randomUUID(), randomUUID(), {approvedBy: 'reviewer'}).job;
  store.claim();
  const error = store.finish(failed.id, {error: 'private failure'});
  assert.equal(error.status, 'failed');
  assert.equal(error.error, 'private failure');
  store.close();
});

test('two connections can finish a running job only once', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-approval-finish-race-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const first = new ToolApprovalStore({root, isVerified: () => true});
  const second = new ToolApprovalStore({root, isVerified: () => true});
  const job = first.enqueue(randomUUID(), randomUUID(), {approvedBy: 'reviewer'}).job;
  assert.equal(second.claim().id, job.id);
  const results = [];
  results.push(() => first.finish(job.id, {approved: true, activated: true}));
  results.push(() => second.finish(job.id, {approved: true, activated: true}));
  const outcomes = results.map(run => { try { return {ok: true, value: run()}; } catch (error) { return {ok: false, error}; } });
  assert.equal(outcomes.filter(item => item.ok).length, 1);
  assert.equal(outcomes.filter(item => !item.ok).length, 1);
  assert.equal(first.get(job.id).status, 'succeeded');
  first.close(); second.close();
});

test('two worker threads interleave claim and finish with one winner each', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-approval-workers-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const store = new ToolApprovalStore({root, isVerified: () => true});
  store.enqueue(randomUUID(), randomUUID(), {approvedBy: 'a'});
  store.enqueue(randomUUID(), randomUUID(), {approvedBy: 'b'});
  store.close();
  const claimShared = new Int32Array(new SharedArrayBuffer(4));
  const claimWorkers = [concurrentWorker(root, 'claim', {buffer: claimShared.buffer}), concurrentWorker(root, 'claim', {buffer: claimShared.buffer})];
  const claimResults = await Promise.all(claimWorkers.map(workerResult));
  const claimed = claimResults.filter(result => result.ok && result.value);
  assert.equal(claimed.length, 1);
  const runningId = claimed[0].value.id;
  const finishShared = new Int32Array(new SharedArrayBuffer(4));
  const finishWorkers = [
    concurrentWorker(root, 'finish', {id: runningId, buffer: finishShared.buffer}),
    concurrentWorker(root, 'finish', {id: runningId, buffer: finishShared.buffer}),
  ];
  const finishResults = await Promise.all(finishWorkers.map(workerResult));
  assert.equal(finishResults.filter(result => result.ok).length, 1);
  assert.equal(finishResults.filter(result => !result.ok).length, 1);
});

test('caps request aliases and queue size while retaining idempotent retries', t => {
  const {store} = fixture(t, {isVerified: () => true});
  const proposal = randomUUID(), firstRequest = randomUUID();
  const original = store.enqueue(proposal, firstRequest, {approvedBy: 'reviewer'}).job;
  for (let i = 1; i < 32; i++) store.enqueue(proposal, randomUUID(), {approvedBy: 'reviewer'});
  assert.throws(() => store.enqueue(proposal, randomUUID(), {approvedBy: 'reviewer'}), /alias|capacity/i);
  assert.equal(store.enqueue(proposal, firstRequest, {approvedBy: 'reviewer'}).job.id, original.id);
  for (let i = 0; i < 99; i++) store.enqueue(randomUUID(), randomUUID(), {approvedBy: 'reviewer'});
  assert.throws(() => store.enqueue(randomUUID(), randomUUID(), {approvedBy: 'reviewer'}), /capacity/i);
  assert.ok(store.list().length <= 100);
  store.close();
});

test('interrupts a running job and reopens it as pending', t => {
  const {root, store} = fixture(t, {isVerified: () => true});
  const job = store.enqueue(randomUUID(), randomUUID(), {approvedBy: 'reviewer'}).job;
  store.claim();
  assert.equal(store.interruptRunning(), 1);
  assert.equal(store.get(job.id).status, 'pending');
  store.close();
  const reopened = new ToolApprovalStore({root, isVerified: () => true});
  assert.equal(reopened.get(job.id).status, 'pending');
  reopened.close();
});

test('halt blocks claims until resume and malformed finish leaves a job running', t => {
  const {store} = fixture(t, {isVerified: () => true});
  const job = store.enqueue(randomUUID(), randomUUID(), {approvedBy: 'reviewer'}).job;
  store.halt();
  assert.equal(store.halted(), true);
  assert.equal(store.claim(), null);
  store.resume();
  assert.equal(store.halted(), false);
  assert.equal(store.claim().id, job.id);
  assert.throws(() => store.finish(job.id, {approved: true, activated: 'yes'}), /Invalid approval result/);
  assert.equal(store.get(job.id).status, 'running');
  const failed = store.finish(job.id, {error: 'x'.repeat(10000)});
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.length, 2000);
  store.close();
});

test('rejects an existing database with the wrong application identity', t => {
  const {root, store} = fixture(t, {isVerified: () => true});
  store.close();
  const file = path.join(root, 'runtime', 'tool-approval', 'jobs.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA application_id=123');
  db.close();
  assert.throws(() => new ToolApprovalStore({root}), /Unknown approval database/);
});

test('rejects an existing database with the wrong user version', t => {
  const {root, store} = fixture(t, {isVerified: () => true});
  store.close();
  const file = path.join(root, 'runtime', 'tool-approval', 'jobs.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=99');
  db.close();
  assert.throws(() => new ToolApprovalStore({root}), /Unknown approval database/);
});

test('rejects an existing database with an unknown schema', t => {
  const {root, store} = fixture(t, {isVerified: () => true});
  store.close();
  const file = path.join(root, 'runtime', 'tool-approval', 'jobs.sqlite');
  const db = new DatabaseSync(file);
  db.exec('DROP TABLE control');
  db.close();
  assert.throws(() => new ToolApprovalStore({root}), /Unknown approval schema/);
});

test('rejects a hardlinked approval database', t => {
  const {root, store} = fixture(t, {isVerified: () => true});
  store.close();
  const folder = path.join(root, 'runtime', 'tool-approval');
  const file = path.join(folder, 'jobs.sqlite');
  const linked = path.join(folder, 'jobs-copy.sqlite');
  fs.linkSync(file, linked);
  assert.throws(() => new ToolApprovalStore({root}), /Unsafe approval database file/);
});

test('rejects a symlinked approval directory when the platform permits symlinks', t => {
  const {root, store} = fixture(t, {isVerified: () => true});
  store.close();
  const runtime = path.join(root, 'runtime');
  const folder = path.join(runtime, 'tool-approval');
  const target = path.join(runtime, 'tool-approval-target');
  fs.renameSync(folder, target);
  try { fs.symlinkSync(target, folder, 'junction'); }
  catch (error) { fs.renameSync(target, folder); t.skip(`symlink unavailable: ${error.code}`); return; }
  assert.throws(() => new ToolApprovalStore({root}), /Unsafe approval directory/);
});

test('rejects a symlinked database sidecar when the platform permits symlinks', t => {
  const {root, store} = fixture(t, {isVerified: () => true});
  store.close();
  const folder = path.join(root, 'runtime', 'tool-approval');
  const sidecar = path.join(folder, 'jobs.sqlite-wal');
  const target = path.join(folder, 'sidecar-target');
  fs.writeFileSync(target, 'sidecar');
  try { fs.symlinkSync(target, sidecar, 'file'); }
  catch (error) { fs.rmSync(target); t.skip(`symlink unavailable: ${error.code}`); return; }
  assert.throws(() => new ToolApprovalStore({root}), /Unsafe approval database file/);
});

test('rejects hardlinked database sidecars for WAL, SHM, and rollback journal files', t => {
  const {root, store} = fixture(t, {isVerified: () => true});
  store.close();
  const folder = path.join(root, 'runtime', 'tool-approval');
  const file = path.join(folder, 'jobs.sqlite');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const target = path.join(folder, `sidecar-target${suffix}`);
    const sidecar = file + suffix;
    fs.writeFileSync(target, 'sidecar');
    fs.linkSync(target, sidecar);
    assert.throws(() => new ToolApprovalStore({root}), /Unsafe approval database file/, suffix);
    fs.rmSync(sidecar);
    fs.rmSync(target);
  }
});

test('reopens a valid database while SQLite has an active WAL sidecar', t => {
  const {root, store} = fixture(t, {isVerified: () => true});
  store.close();
  const file = path.join(root, 'runtime', 'tool-approval', 'jobs.sqlite');
  const writer = new DatabaseSync(file);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE control SET halted=1 WHERE id=1;');
    if (!fs.existsSync(`${file}-wal`)) {
      t.skip('SQLite did not leave a WAL sidecar on this platform');
      return;
    }
    const reopened = new ToolApprovalStore({root, isVerified: () => true});
    assert.equal(reopened.halted(), true);
    reopened.close();
  } finally {
    writer.close();
  }
});
