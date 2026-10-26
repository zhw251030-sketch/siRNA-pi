import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {TaskStore} from '../packages/task-core/task-store.mjs';
import {GoalStore} from '../packages/extensions/goal/goal-store.mjs';
import {createAppServer} from '../apps/api/router.mjs';

async function fixture(t, verification) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-goal-http-')));
  const tasks = new TaskStore(path.join(root, 'tasks.sqlite'));
  const goal = new GoalStore({root});
  const task = tasks.createTask({id: randomUUID(), piSessionId: randomUUID()}, randomUUID());
  const server = createAppServer({taskStore: tasks, agentRuntime: {runtimeInfo: () => ({})}, goalStore: goal, ...(verification ? {goalVerification: verification} : {})});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(() => resolve()));
    tasks.close(); goal.close(); fs.rmSync(root, {recursive: true, force: true});
  });
  const request = (taskId = task.id, method = 'GET', body) => fetch(`${base}/v1/tasks/${taskId}/goal`, {
    method, headers: body === undefined ? {} : {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {task, tasks, goal, request, base};
}

test('Goal HTTP create/get/update exposes durable progress and gates completion', async t => {
  const f = await fixture(t);
  assert.deepEqual((await (await f.request()).json()).goal, null);
  const createdResponse = await f.request(f.task.id, 'POST', {objective: '创建一个工具'});
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.goal.status, 'active');
  assert.equal(created.message.role, 'user');
  const messages = f.tasks.listMessages(f.task.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].clientRequestId, `goal-objective:${created.goal.goalId}`);
  const blockedCompletion = await f.request(f.task.id, 'PATCH', {action: 'agent_update', status: 'complete', expectedRevision: created.goal.revision});
  assert.equal(blockedCompletion.status, 409);
  const first = await f.request(f.task.id, 'PATCH', {action: 'agent_update', status: 'progress', completedItemIds: ['step-1'], expectedRevision: created.goal.revision});
  assert.equal(first.status, 200);
  const goal = (await first.json()).goal;
  assert.equal(goal.plan.items[0].status, 'done');
  const paused = await f.request(f.task.id, 'PATCH', {action: 'pause'});
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).goal.status, 'paused');
  const resumed = await f.request(f.task.id, 'PATCH', {action: 'resume', additionalTurns: 2});
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).goal.status, 'active');
  const messagesResponse = await fetch(`${f.base}/v1/tasks/${f.task.id}/messages`);
  assert.equal((await messagesResponse.json()).goal.status, 'active');
});

test('Goal HTTP rejects unknown task, duplicate unfinished goal and malformed fields', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(randomUUID(), 'GET')).status, 404);
  assert.equal((await f.request(f.task.id, 'POST', {objective: '目标'})).status, 201);
  assert.equal((await f.request(f.task.id, 'POST', {objective: '第二个'})).status, 409);
  assert.equal((await f.request(f.task.id, 'POST', {objective: '目标', extra: true})).status, 409);
  assert.equal((await f.request(f.task.id, 'PATCH', {action: 'agent_update', status: 'progress', completedItemIds: ['bad']})).status, 409);
});

test('Goal HTTP completion request exposes verifying instead of claiming completion', async t => {
  const f = await fixture(t);
  const createdResponse = await f.request(f.task.id, 'POST', {objective: '完成第一阶段；完成第二阶段'});
  const created = await createdResponse.json();
  let goal = created.goal;
  const progressed = await f.request(f.task.id, 'PATCH', {
    action: 'agent_update', status: 'progress', completedItemIds: goal.plan.items.map(item => item.id), expectedRevision: goal.revision,
  });
  goal = (await progressed.json()).goal;
  const completion = await f.request(f.task.id, 'PATCH', {action: 'agent_update', status: 'complete', expectedRevision: goal.revision});
  assert.equal(completion.status, 200);
  assert.equal((await completion.json()).goal.status, 'verifying');
  assert.equal(f.goal.get(f.task.id).status, 'verifying');
});

test('enabled verification port returns 202 and exposes task verification status', async t => {
  const verificationId = randomUUID();
  const submitted = [];
  const verification = {
    request: async goal => { submitted.push(goal); return {id: verificationId, status: 'waiting'}; },
    list: taskId => submitted.filter(goal => goal.taskId === taskId).map(goal => ({id: verificationId, taskId, status: 'waiting', goalRevision: goal.revision})),
    get: (taskId, id) => id === verificationId ? {id, taskId, status: 'waiting'} : undefined,
  };
  const f = await fixture(t, verification);
  const created = await (await f.request(f.task.id, 'POST', {objective: '完成报告'})).json();
  const progressed = await f.request(f.task.id, 'PATCH', {action: 'agent_update', status: 'progress', completedItemIds: created.goal.plan.items.map(item => item.id), expectedRevision: created.goal.revision});
  const current = (await progressed.json()).goal;
  const completion = await f.request(f.task.id, 'PATCH', {action: 'agent_update', status: 'complete', expectedRevision: current.revision});
  assert.equal(completion.status, 202);
  const body = await completion.json();
  assert.equal(body.goal.status, 'verifying');
  assert.deepEqual(body.verification, {id: verificationId, status: 'waiting'});
  assert.equal((await (await fetch(`${f.base}/v1/tasks/${f.task.id}/goal-verifications`)).json()).verifications.length, 1);
  assert.equal((await (await fetch(`${f.base}/v1/tasks/${f.task.id}/goal-verifications/${verificationId}`)).json()).verification.id, verificationId);
});

test('token-scoped verification access uses POST-only route and binds the path identity', async t => {
  const verificationId = randomUUID();
  const calls = [];
  const verification = {
    request: async () => ({id: verificationId, status: 'waiting'}),
    access: {handle: async (kind, input) => { calls.push({kind, input}); return {kind, verificationId: input.verificationId}; }},
  };
  const f = await fixture(t, verification);
  const bundle = await fetch(`${f.base}/v1/goal-verifications/${verificationId}/bundle`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({accessToken: 'access-token-for-test'}),
  });
  assert.equal(bundle.status, 200);
  assert.deepEqual(await bundle.json(), {kind: 'bundle', verificationId});
  assert.equal(calls[0].input.verificationId, verificationId);
  const search = await fetch(`${f.base}/v1/goal-verifications/${verificationId}/search`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({accessToken: 'access-token-for-test', provider: 'openalex', query: 'RNA interference'}),
  });
  assert.equal(search.status, 200);
  assert.equal((await search.json()).kind, 'search');
  const mismatch = await fetch(`${f.base}/v1/goal-verifications/${verificationId}/bundle`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({verificationId: randomUUID(), accessToken: 'access-token-for-test'}),
  });
  assert.equal(mismatch.status, 400);
  const get = await fetch(`${f.base}/v1/goal-verifications/${verificationId}/bundle`);
  assert.equal(get.status, 405);
});

test('failed verification request returns an error and restores the Goal to active', async t => {
  const verification = {request: async () => { throw new Error('verification backend unavailable'); }};
  const f = await fixture(t, verification);
  const created = await (await f.request(f.task.id, 'POST', {objective: '完成报告'})).json();
  const progressed = await f.request(f.task.id, 'PATCH', {
    action: 'agent_update',
    status: 'progress',
    completedItemIds: created.goal.plan.items.map(item => item.id),
    expectedRevision: created.goal.revision,
  });
  const current = (await progressed.json()).goal;
  const completion = await f.request(f.task.id, 'PATCH', {action: 'agent_update', status: 'complete', expectedRevision: current.revision});
  assert.equal(completion.status, 409);
  assert.match((await completion.json()).error, /verification backend unavailable/);
  const restored = f.goal.get(f.task.id);
  assert.equal(restored.status, 'active');
  assert.match(restored.latestVerificationFeedback, /验证请求未能建立/);
});

