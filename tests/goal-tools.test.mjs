import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGoalTools} from '../packages/extensions/goal/goal-tools.mjs';

test('Goal tools use task context and expose the three reference contracts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-goal-tools-'));
  const contextPath = path.join(root, '.sirna-task-context.json');
  fs.writeFileSync(contextPath, JSON.stringify({protocolVersion: 'sirna-task-context/v1', taskId: '11111111-1111-4111-8111-111111111111', agentTurnId: '22222222-2222-4222-8222-222222222222'}));
  const calls = [];
  const tools = createGoalTools({
    registryUrl: 'http://127.0.0.1:3000',
    taskContextPath: contextPath,
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return new Response(JSON.stringify({goal: {status: 'active'}}), {status: 200, headers: {'content-type': 'application/json'}});
    },
  });
  assert.deepEqual(tools.map(tool => tool.name), ['get_goal', 'create_goal', 'update_goal']);
  await tools[0].execute('tool-call', {});
  await tools[1].execute('tool-call', {objective: 'x'});
  await tools[2].execute('tool-call', {status: 'progress', completedItemIds: ['step-1']});
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(JSON.parse(calls[1].options.body).objective, 'x');
  assert.equal(JSON.parse(calls[2].options.body).action, 'agent_update');
  fs.rmSync(root, {recursive: true, force: true});
});

test('Goal tools reject invalid task context before network access', async () => {
  await assert.rejects(() => createGoalTools({registryUrl: 'http://localhost'}).at(0).execute(), /taskContextPath/);
});

