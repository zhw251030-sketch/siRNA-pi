import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAppServer } from '../apps/api/router.mjs';
import { createGoalVerifierInternalHandler } from '../apps/api/goal-verifier-internal-listener.mjs';

test('app handler can be reused for an explicitly allowed internal listener', async () => {
  const taskStore = { listTasks: () => [], getTask: () => undefined };
  const app = createAppServer({
    taskStore,
    agentRuntime: { runtimeInfo: () => ({ backend: 'agent-compose' }) },
    allowedHosts: ['172.18.0.1'],
  });
  assert.equal(typeof app.requestHandler, 'function');
  const internal = createServer(createGoalVerifierInternalHandler(app.requestHandler));
  internal.listen(0, '127.0.0.1');
  await once(internal, 'listening');
  const address = internal.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`, { headers: { host: '172.18.0.1:3001' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ready, true);
  await new Promise(resolve => internal.close(resolve));
  await new Promise(resolve => app.close(resolve));
});

test('internal verifier listener refuses unrelated web routes', async () => {
  const app = createAppServer({
    taskStore: { listTasks: () => [], getTask: () => undefined },
    agentRuntime: { runtimeInfo: () => ({ backend: 'agent-compose' }) },
    allowedHosts: ['192.168.1.169'],
  });
  const internal = createServer(createGoalVerifierInternalHandler(app.requestHandler));
  internal.listen(0, '127.0.0.1');
  await once(internal, 'listening');
  const address = internal.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/tasks`, { headers: { host: '192.168.1.169:3001' } });
  assert.equal(response.status, 404);
  await new Promise(resolve => internal.close(resolve));
  await new Promise(resolve => app.close(resolve));
});

test('internal listener forwards only capability-authorized task Goal calls', async () => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const agentTurnId = '22222222-2222-4222-8222-222222222222';
  const token = 'a'.repeat(64);
  const calls = [];
  const goalApi = {handle: async (request, response, receivedTaskId) => {
    calls.push({method: request.method, taskId: receivedTaskId});
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({goal: {taskId: receivedTaskId, status: 'active'}}));
  }};
  const leases = {authorize: ({token: receivedToken, taskId: receivedTaskId, agentTurnId: receivedTurnId, call}) => {
    assert.equal(receivedToken, token);
    assert.equal(receivedTaskId, taskId);
    assert.equal(receivedTurnId, agentTurnId);
    return {run: operation => Promise.resolve().then(operation)};
  }};
  const app = createServer(createGoalVerifierInternalHandler(() => { throw new Error('web handler must not run'); }, {goalApi, leases}));
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const address = app.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/tasks/${taskId}/goal`, {
    headers: {
      host: '192.168.1.169:3001',
      authorization: `Bearer ${token}`,
      'x-sirna-task-id': taskId,
      'x-sirna-agent-turn-id': agentTurnId,
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{method: 'GET', taskId}]);
  const denied = await fetch(`http://127.0.0.1:${address.port}/v1/tasks/${taskId}/goal`, {
    headers: {host: '192.168.1.169:3001', 'x-sirna-task-id': taskId, 'x-sirna-agent-turn-id': agentTurnId},
  });
  assert.equal(denied.status, 401);
  await new Promise(resolve => app.close(resolve));
});
