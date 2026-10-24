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
  const notifications = [], calls = []; let callbackState;
  const {store, worker} = fixture(t, {approve: async (...args) => { calls.push(args); return {approved: true, activated: true}; }, onSettled: value => { callbackState = store.get(value.jobId); notifications.push(value); }});
  const proposalId = randomUUID(), requestId = randomUUID();
  const accepted = worker.enqueue(proposalId, requestId, {approvedBy: 'reviewer'});
  assert.equal(accepted.job.status, 'pending');
  await worker.start(); await worker.drain();
  assert.deepEqual(calls, [[proposalId, 'reviewer']]);
  assert.equal(store.get(accepted.job.id).status, 'succeeded');
  assert.equal(callbackState.status, 'succeeded');
  assert.deepEqual(notifications, [{protocolVersion: 'sirna-tool-approval/v1', jobId: accepted.job.id, proposalId, requestedBy: 'reviewer', status: 'succeeded', approved: true, activated: true}]);
  assert.equal(JSON.stringify(notifications[0]).length < 1000, true);
  await worker.stop();
});

test('rejects unverified admission without creating a queue row', async t => {
  const notifications = [], errors = [];
  const {store, worker} = fixture(t, {verified: false, approve: async () => { throw new Error('should not run'); }, onSettled: value => notifications.push(value), onError: error => errors.push(error)});
  assert.throws(() => worker.enqueue(randomUUID(), randomUUID(), {approvedBy: 'reviewer'}), /verified/i);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(notifications, []);
  assert.deepEqual(errors, []);
});

test('halts admission, including duplicate request retries, before touching the store', t => {
  const {store, worker} = fixture(t);
  const proposalId = randomUUID(), requestId = randomUUID();
  worker.enqueue(proposalId, requestId, {approvedBy: 'operator'});
  store.halt();
  assert.throws(() => worker.enqueue(proposalId, requestId, {approvedBy: 'operator'}), /halted/i);
  assert.throws(() => worker.enqueue(randomUUID(), randomUUID(), {approvedBy: 'operator'}), /halted/i);
  assert.equal(store.list().length, 1);
});

test('approval failure is terminal and keeps private error out of notification', async t => {
  const notifications = [], errors = [];
  let callbackState;
  const {store, worker} = fixture(t, {approve: async () => { throw new Error('/private/token=secret'); }, onSettled: value => { callbackState = store.get(value.jobId); notifications.push(value); }, onError: error => errors.push(error)});
  const proposalId = randomUUID(), job = worker.enqueue(proposalId, randomUUID(), {approvedBy: 'operator'}).job;
  await worker.start(); await worker.drain();
  assert.equal(store.get(job.id).status, 'failed');
  assert.equal(callbackState.status, 'failed');
  assert.equal(store.get(job.id).approved, undefined);
  assert.deepEqual(notifications[0], {protocolVersion: 'sirna-tool-approval/v1', jobId: job.id, proposalId, requestedBy: 'operator', status: 'failed', approved: false, activated: false});
  assert.equal(errors.length, 1); assert.doesNotMatch(JSON.stringify(notifications), /secret|private/);
  await worker.stop();
});

test('duplicate request is idempotent', async t => {
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

test('restart closes and reopens the store, requeues running work, and approves it with a fresh worker', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-approval-worker-restart-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const firstStore = new ToolApprovalStore({root, isVerified: () => true});
  const proposalId = randomUUID(), requestId = randomUUID();
  const queued = firstStore.enqueue(proposalId, requestId, {approvedBy: 'operator'}).job;
  assert.equal(firstStore.claim().status, 'running');
  firstStore.close();
  const secondStore = new ToolApprovalStore({root, isVerified: () => true});
  t.after(() => secondStore.close());
  const calls = [], worker = createToolApproval({root, store: secondStore, approve: async (...args) => { calls.push(args); return {approved: true, activated: true}; }});
  assert.equal(secondStore.get(queued.id).status, 'running');
  assert.equal(secondStore.interruptRunning(), 1);
  assert.equal(secondStore.get(queued.id).status, 'pending');
  await worker.start();
  await worker.drain();
  assert.equal(secondStore.get(queued.id).status, 'succeeded');
  assert.deepEqual(calls, [[proposalId, 'operator']]);
  await worker.stop();
  secondStore.close();
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
  let callbackState;
  const {store, worker} = fixture(t, {approve: async () => { throw Object.assign(new Error('catalog projection failed'), {approved: true, activated: true, versionActivated: true}); }, onSettled: value => { callbackState = store.get(value.jobId); notifications.push(value); }, onError: error => errors.push(error)});
  const proposalId = randomUUID(), job = worker.enqueue(proposalId, randomUUID(), {approvedBy: 'operator'}).job;
  await worker.start(); await worker.drain();
  assert.equal(store.get(job.id).status, 'succeeded'); assert.deepEqual({approved: store.get(job.id).approved, activated: store.get(job.id).activated}, {approved: true, activated: true});
  assert.equal(callbackState.status, 'succeeded');
  assert.equal(notifications[0].status, 'succeeded'); assert.equal(notifications[0].approved, true); assert.equal(notifications[0].activated, true); assert.equal(errors.length, 1);
  await worker.stop();
});

test('non-affirmative approval results are recorded as failed terminal jobs', async t => {
  for (const result of [{approved: false, activated: false}, {approved: true, activated: false}]) {
    await t.test(JSON.stringify(result), async t2 => {
      let callbackState;
      const {store, worker} = fixture(t2, {approve: async () => result, onSettled: value => { callbackState = store.get(value.jobId); }});
      const job = worker.enqueue(randomUUID(), randomUUID(), {approvedBy: 'operator'}).job;
      await worker.start(); await worker.drain();
      assert.equal(store.get(job.id).status, 'failed');
      assert.equal(callbackState.status, 'failed');
      await worker.stop();
    });
  }
});

test('partial projection markers do not claim committed activation', async t => {
  const {store, worker} = fixture(t, {approve: async () => { throw Object.assign(new Error('projection incomplete'), {approved: true, activated: false, versionActivated: true}); }});
  const job = worker.enqueue(randomUUID(), randomUUID(), {approvedBy: 'operator'}).job;
  await worker.start(); await worker.drain();
  assert.equal(store.get(job.id).status, 'failed');
  await worker.stop();
});
