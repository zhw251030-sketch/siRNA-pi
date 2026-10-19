import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleControls, mergeTaskState } from '../public/lifecycle.mjs';

const compose = { backend: 'agent-compose', supportsLifecycle: true };

test('a streaming turn remains stoppable and endable while ordinary controls are busy', () => {
  assert.deepEqual(lifecycleControls({ task: { id: 'a', status: 'running' }, execution: compose, busy: true }),
    { canStop: true, canEnd: true });
});

test('idle and failed Compose tasks can end but cannot stop a settled turn', () => {
  for (const status of ['idle', 'failed']) {
    assert.deepEqual(lifecycleControls({ task: { id: 'a', status }, execution: compose }),
      { canStop: false, canEnd: true });
  }
});

test('unconfirmed interrupted execution can be stopped after reload', () => {
  assert.deepEqual(lifecycleControls({ task: { id: 'a', status: 'failed' }, execution: { ...compose, stopUnconfirmed: true } }),
    { canStop: true, canEnd: true });
});

test('legacy, unknown, explicitly unsupported and stopped tasks expose no lifecycle actions', () => {
  for (const execution of [null, { unavailable: true }, { backend: 'local-pi', supportsLifecycle: true }, { ...compose, supportsLifecycle: false }]) {
    assert.deepEqual(lifecycleControls({ task: { id: 'a', status: 'running' }, execution }),
      { canStop: false, canEnd: false });
  }
  assert.deepEqual(lifecycleControls({ task: { id: 'a', status: 'stopped' }, execution: compose }),
    { canStop: false, canEnd: false });
});

test('duplicate lifecycle calls are blocked without requiring the send request to finish', () => {
  assert.deepEqual(lifecycleControls({ task: { id: 'a', status: 'running' }, execution: compose, lifecycleBusy: 'stop' }),
    { canStop: false, canEnd: false });
  assert.deepEqual(lifecycleControls({ task: { id: 'a', status: 'running' }, execution: compose, stopRequested: true }),
    { canStop: false, canEnd: true });
});

test('Compose backend metadata supports existing session events but submission does not end an idle task', () => {
  assert.deepEqual(lifecycleControls({ task: { id: 'a', status: 'running' }, execution: { backend: 'agent-compose' } }),
    { canStop: true, canEnd: true });
  assert.deepEqual(lifecycleControls({ task: { id: 'a', status: 'idle' }, execution: compose, busy: true }),
    { canStop: false, canEnd: false });
});

test('late stream saves retain new record fields without resurrecting an ended task', () => {
  assert.deepEqual(mergeTaskState({ id: 'a', status: 'stopped', updatedAt: 'later' },
    { id: 'a', status: 'idle', updatedAt: 'earlier', currentRunId: 'saved-run' }),
  { id: 'a', status: 'stopped', updatedAt: 'later', currentRunId: 'saved-run' });
  assert.deepEqual(mergeTaskState({ id: 'a', status: 'stopped' }, { id: 'b', status: 'running' }),
    { id: 'b', status: 'running' });
});

test('an older cancel response cannot replace a newer saved turn with running state', () => {
  assert.deepEqual(mergeTaskState({ id: 'a', status: 'idle', updatedAt: '2026-10-20T12:00:02.000Z' },
    { id: 'a', status: 'running', updatedAt: '2026-10-20T12:00:01.000Z' }),
  { id: 'a', status: 'idle', updatedAt: '2026-10-20T12:00:02.000Z' });
});
test('ending a task releases its unaccepted pending send but keeps unrelated or running sends reserved', async () => {
  const { pendingDisposition } = await import('../public/lifecycle.mjs');
  const pending = { taskId: 'a', requestId: 'message:123', message: 'draft' };
  assert.equal(pendingDisposition(pending, { id: 'a', status: 'stopped' }, []), 'archive');
  assert.equal(pendingDisposition(pending, { id: 'a', status: 'stopped' }, [{ clientRequestId: pending.requestId }]), 'clear');
  assert.equal(pendingDisposition(pending, { id: 'a', status: 'running' }, [{ clientRequestId: pending.requestId }]), 'keep');
  assert.equal(pendingDisposition(pending, { id: 'b', status: 'stopped' }, []), 'keep');
});
