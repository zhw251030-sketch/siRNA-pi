import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeRouter } from '../packages/agent-runtime/runtime-router.mjs';

test('new tasks use Compose while existing SDK tasks retain their original executor', async () => {
  const calls = [];
  const compose = { owns: id => id === 'new', create: async () => ({ id: 'new' }),
    run: async r => { calls.push(`compose:${r.sessionId}`); },
    describe: async () => ({ backend: 'agent-compose', workspacePath: null }),
    runtimeInfo: () => ({ backend: 'agent-compose', taskContainers: true }) };
  const legacy = { status: async id => { if (id !== 'old') throw new Error('missing'); return { id, currentRunId: 'r1' }; },
    run: async r => { calls.push(`sdk:${r.sessionId}`); } };
  const router = new RuntimeRouter({ compose, legacy });
  assert.equal((await router.create()).id, 'new');
  await router.run({ sessionId: 'new' }, () => {});
  await router.run({ sessionId: 'old' }, () => {});
  assert.deepEqual(calls, ['compose:new', 'sdk:old']);
  assert.equal((await router.describe('old')).workspacePath, 'workspaces/web/old');
  assert.equal((await router.describe('new')).backend, 'agent-compose');
  await assert.rejects(router.run({ sessionId: 'unknown' }, () => {}), /missing/);
  compose.run = async () => { throw new Error('compose unavailable'); };
  await assert.rejects(router.run({ sessionId: 'new' }, () => {}), /compose unavailable/);
  assert.equal(calls.length, 2);
});
