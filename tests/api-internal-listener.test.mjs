import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAppServer } from '../apps/api/router.mjs';

test('app handler can be reused for an explicitly allowed internal listener', async () => {
  const taskStore = { listTasks: () => [], getTask: () => undefined };
  const app = createAppServer({
    taskStore,
    agentRuntime: { runtimeInfo: () => ({ backend: 'agent-compose' }) },
    allowedHosts: ['172.18.0.1'],
  });
  assert.equal(typeof app.requestHandler, 'function');
  const internal = createServer(app.requestHandler);
  internal.listen(0, '127.0.0.1');
  await once(internal, 'listening');
  const address = internal.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`, { headers: { host: '172.18.0.1:3001' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ready, true);
  await new Promise(resolve => internal.close(resolve));
  await new Promise(resolve => app.close(resolve));
});
