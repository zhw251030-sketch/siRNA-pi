import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {deriveGoalPlan, parseGoalPlan, applyGoalProgress, pendingRequiredWorkItems, formatGoalPlan} from '../packages/extensions/goal/goal-plan.mjs';
import {GoalStore} from '../packages/extensions/goal/goal-store.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-goal-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root};
}

test('derives a bounded plan and gates completion on required work', () => {
  const plan = deriveGoalPlan('先创建工具；然后运行测试；最终通过 MCP 调用');
  assert.equal(plan.protocolVersion, 'sirna-goal-plan/v1');
  assert.equal(plan.items.length, 3);
  assert.deepEqual(pendingRequiredWorkItems(plan).map(item => item.id), ['step-1', 'step-2', 'step-3']);
  const progressed = applyGoalProgress(plan, ['step-1']);
  assert.equal(progressed.items[0].status, 'done');
  assert.equal(pendingRequiredWorkItems(progressed).length, 2);
  assert.match(formatGoalPlan(progressed), /已完成/);
  assert.deepEqual(parseGoalPlan(progressed), progressed);
  assert.throws(() => applyGoalProgress(plan, ['unknown']), /Unknown Goal work item/);
});

test('GoalStore persists creation, progress, completion gates and revision conflicts', t => {
  const {root} = fixture(t);
  const taskId = randomUUID();
  const store = new GoalStore({root});
  const goal = store.create(taskId, '创建一个工具');
  assert.equal(goal.status, 'active');
  assert.equal(goal.plan.items.length, 4);
  assert.equal(goal.revision, 1);
  assert.throws(() => store.completeDirect(taskId), /pending|required|not ready/i);
  const progressed = store.updateProgress(taskId, ['step-1'], 1);
  assert.equal(progressed.revision, 2);
  assert.throws(() => store.updateProgress(taskId, ['step-2'], 1), /revision/i);
  assert.equal(store.updateFromAgent(taskId, 'blocked', '缺少输入').status, 'blocked');
  assert.throws(() => store.updateProgress(taskId, ['step-2']), /blocked/i);
  store.close();
});

test('GoalStore supports pause/resume, budget accounting, leases and restart recovery', t => {
  const {root} = fixture(t);
  const taskId = randomUUID();
  let store = new GoalStore({root});
  const goal = store.create(taskId, '完成一个任务', 2);
  const firstLease = store.acquireLease(taskId, 1000);
  assert.equal(firstLease.automaticTurnNumber, 1);
  assert.equal(store.acquireLease(taskId, 1000), undefined);
  let active = store.completeLease(taskId, firstLease.leaseId, {success: false, productive: false, error: 'timeout'});
  assert.equal(active.status, 'active');
  assert.equal(active.automaticTurnsUsed, 1);
  store.pause(taskId);
  assert.equal(store.resume(taskId, 1).status, 'active');
  const lease = store.acquireLease(taskId, 1000);
  assert.equal(lease.automaticTurnNumber, 2);
  store.close();
  store = new GoalStore({root});
  assert.equal(store.expireLeasesForRecovery(), 1);
  const recovered = store.get(taskId);
  assert.equal(recovered.leaseId, undefined);
  assert.equal(recovered.status, 'active');
  assert.equal(store.acquireLease(taskId, 1000), undefined);
  store.close();

  const limitedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-goal-budget-')));
  t.after(() => fs.rmSync(limitedRoot, {recursive: true, force: true}));
  const limitedStore = new GoalStore({root: limitedRoot});
  const limitedTask = randomUUID();
  limitedStore.create(limitedTask, '预算目标', 1);
  const limitedLease = limitedStore.acquireLease(limitedTask, 1000);
  const limited = limitedStore.completeLease(limitedTask, limitedLease.leaseId, {success: false, productive: false});
  assert.equal(limited.status, 'budget_limited');
  limitedStore.close();
});

test('GoalStore rejects duplicate unfinished goals and only accepts safe statuses', t => {
  const {root} = fixture(t);
  const taskId = randomUUID();
  const store = new GoalStore({root});
  store.create(taskId, '第一个目标');
  assert.throws(() => store.create(taskId, '第二个目标'), /unfinished|already/i);
  assert.throws(() => store.updateFromAgent(taskId, 'complete', '还有工作'), /pending|not ready/i);
  assert.throws(() => store.updateFromAgent(taskId, 'blocked', 'x\ncontrol'), /control|reason/i);
  store.close();
});

