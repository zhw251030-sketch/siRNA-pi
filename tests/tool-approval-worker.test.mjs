import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ToolApprovalStore} from '../packages/capability-platform/tool-approval-store.mjs';
import {createToolApproval} from '../packages/capability-platform/tool-approval-worker.mjs';

function fixture(t, {verified = true, approve = async () => ({approved: true, activated: true}), onSettled, onError} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-approval-worker-')));
  const store = new ToolApprovalStore({root, isVerified: () => verified});
  t.after(() => { store.close(); fs.rmSync(root, {recursive: true, force: true}); });
  return {root, store, worker: createToolApproval({root, store, approve, onSettled, onError})};
}

test('admits verified proposals, claims one job, persists success, and emits bounded terminal notification', async t => {
  const notifications = [], calls = [];
  const {store, worker} = fixture(t, {approve: async (...args) => { calls.push(args); return {approved: true, activated: true}; }, onSettled: value => notifications.push(value)});
  const proposalId = randomUUID(), requestId = randomUUID();
  const accepted = worker.enqueue(proposalId, requestId, {approvedBy: 'reviewer'});
  assert.equal(accepted.job.status, 'pending');
  await worker.start(); await worker.drain();
  assert.deepEqual(calls, [[proposalId, 'reviewer']]);
  assert.equal(store.get(accepted.job.id).status, 'succeeded');
  assert.deepEqual(notifications, [{protocolVersion: 'sirna-tool-approval/v1', jobId: accepted.job.id, proposalId, requestedBy: 'reviewer', status: 'succeeded', approved: true, activated: true}]);
  assert.equal(JSON.stringify(notifications[0]).length < 1000, true);
  await worker.stop();
});

test('rejects unverified admission, records approval failure, and notifies after persistence', async t => {
  const notifications = [], errors = [];
  const {worker} = fixture(t, {verified: false, approve: async () => { throw new Error('should not run'); }, onSettled: value => notifications.push(value), onError: error => errors.push(error)});
  assert.throws(() => worker.enqueue(randomUUID(), randomUUID(), {approvedBy: 'reviewer'}), /verified/i);
  assert.deepEqual(notifications, []);
  assert.deepEqual(errors, []);
});

test('approval failure is terminal and keeps private error out of notification', async t => {
  const notifications = [], errors = [];
  const {store, worker} = fixture(t, {approve: async () => { throw new Error('/private/token=secret'); }, onSettled: value => notifications.push(value), onError: error => errors.push(error)});
  const proposalId = randomUUID(), job = worker.enqueue(proposalId, randomUUID(), {approvedBy: 'operator'}).job;
  await worker.start(); await worker.drain();
  assert.equal(store.get(job.id).status, 'failed');
  assert.equal(store.get(job.id).approved, undefined);
  assert.deepEqual(notifications[0], {protocolVersion: 'sirna-tool-approval/v1', jobId: job.id, proposalId, requestedBy: 'operator', status: 'failed', approved: false, activated: false});
  assert.equal(errors.length, 1); assert.doesNotMatch(JSON.stringify(notifications), /secret|private/);
  await worker.stop();
});

test('duplicate request is idempotent and restart requeues a running job', async t => {
  const calls = [];
  const {store, worker} = fixture(t, {approve: async (...args) => { calls.push(args); return {approved: true, activated: true}; }});
  const proposalId = randomUUID(), requestId = randomUUID();
  const first = worker.enqueue(proposalId, requestId, {approvedBy: 'first'});
  const duplicate = worker.enqueue(proposalId, requestId, {approvedBy: 'second'});
  assert.equal(duplicate.deduplicated, true); assert.equal(duplicate.job.id, first.job.id);
  assert.equal(store.claim().id, first.job.id);
  await worker.start(); await worker.drain();
  assert.equal(store.get(first.job.id).status, 'succeeded'); assert.deepEqual(calls, [[proposalId, 'first']]);
  await worker.stop();
});

test('stop stops admission and drains current approval while leaving pending work queued', async t => {
  let release; const entered = new Promise(resolve => { release = resolve; }); let started;
  const {store, worker} = fixture(t, {approve: async () => { started = true; await entered; return {approved: true, activated: true}; }});
  const first = worker.enqueue(randomUUID(), randomUUID(), {approvedBy: 'operator'}).job;
  const second = worker.enqueue(randomUUID(), randomUUID(), {approvedBy: 'operator'}).job;
  await worker.start(); while (!started) await new Promise(resolve => setImmediate(resolve));
  const stopping = worker.stop(); assert.throws(() => worker.enqueue(randomUUID(), randomUUID(), {approvedBy: 'operator'}), /stopping/i);
  release(); await stopping;
  assert.equal(store.get(first.id).status, 'succeeded'); assert.equal(store.get(second.id).status, 'pending');
});

test('already activated projection error becomes a successful terminal result and reports warning', async t => {
  const notifications = [], errors = [];
  const {store, worker} = fixture(t, {approve: async () => { throw Object.assign(new Error('catalog projection failed'), {approved: true, activated: true, versionActivated: true}); }, onSettled: value => notifications.push(value), onError: error => errors.push(error)});
  const proposalId = randomUUID(), job = worker.enqueue(proposalId, randomUUID(), {approvedBy: 'operator'}).job;
  await worker.start(); await worker.drain();
  assert.equal(store.get(job.id).status, 'succeeded'); assert.deepEqual({approved: store.get(job.id).approved, activated: store.get(job.id).activated}, {approved: true, activated: true});
  assert.equal(notifications[0].status, 'succeeded'); assert.equal(notifications[0].approved, true); assert.equal(notifications[0].activated, true); assert.equal(errors.length, 1);
  await worker.stop();
});
