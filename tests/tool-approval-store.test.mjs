import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ToolApprovalStore} from '../packages/capability-platform/tool-approval-store.mjs';

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-approval-store-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, store: new ToolApprovalStore({root, ...options})};
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
