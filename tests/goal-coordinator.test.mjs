import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {GoalCoordinator, goalContinuationPrompt} from '../packages/extensions/goal/goal-coordinator.mjs';

function plan() {
  return {protocolVersion:'sirna-goal-plan/v1', items:[
    {id:'step-1', title:'执行第一项', required:true, status:'pending'},
    {id:'step-2', title:'执行第二项', required:true, status:'pending'},
  ]};
}
function fixture({status='active', maxAutomaticTurns=4} = {}) {
  const taskId = randomUUID();
  const goal = {taskId, goalId:randomUUID(), objective:'完成协调器学习任务', status, maxAutomaticTurns,
    automaticTurnsUsed:0, consecutiveFailedTurns:0, consecutiveStalledTurns:0, plan:plan(), revision:1};
  let current = {...goal};
  let lease;
  const calls = {expired:0, acquired:0, released:[], completed:[]};
  const store = {
    listActive: () => current.status === 'active' ? [current] : [],
    get: id => id === taskId ? current : undefined,
    expireLeasesForRecovery: () => { calls.expired++; if (current.leaseId) { current = {...current, leaseId:undefined, leaseExpiresAt:undefined}; } return 1; },
    acquireLease: () => {
      if (current.status !== 'active' || current.leaseId || current.automaticTurnsUsed >= current.maxAutomaticTurns) return undefined;
      const leaseId = randomUUID(); current = {...current, leaseId, leaseExpiresAt:new Date(Date.now()+10000).toISOString(), automaticTurnsUsed:current.automaticTurnsUsed+1, revision:current.revision+1};
      lease = {goal:current, leaseId, automaticTurnNumber:current.automaticTurnsUsed}; calls.acquired++; return lease;
    },
    releaseLease: (id, leaseId, refund) => { calls.released.push({id,leaseId,refund}); current = {...current, automaticTurnsUsed:refund ? current.automaticTurnsUsed-1 : current.automaticTurnsUsed, leaseId:undefined, leaseExpiresAt:undefined, revision:current.revision+1}; return current; },
    completeLease: (id, leaseId, outcome) => { calls.completed.push({id,leaseId,outcome}); current = {...current, leaseId:undefined, leaseExpiresAt:undefined, consecutiveFailedTurns:outcome.success ? 0 : current.consecutiveFailedTurns+1, revision:current.revision+1, status:current.automaticTurnsUsed >= current.maxAutomaticTurns ? 'budget_limited' : 'active'}; return current; },
  };
  return {taskId, goal, store, calls, get current(){return current;}, get lease(){return lease;}};
}

test('continuation prompt states bounded work and includes verifier feedback', () => {
  const f = fixture();
  const prompt = goalContinuationPrompt({goal:{...f.goal, latestVerificationFeedback:'缺少输出文件'}, automaticTurnNumber:1});
  assert.match(prompt, /完成协调器学习任务/);
  assert.match(prompt, /第 1\/4 个自动回合/);
  assert.match(prompt, /step-1/);
  assert.match(prompt, /缺少输出文件/);
  assert.match(prompt, /update_goal status=complete/);
  assert.match(prompt, /独立 verifier/);
  assert.match(prompt, /search_verification_sources/);
  assert.match(prompt, /不要伪造 retrievalId 或 evidenceId/);
  assert.match(prompt, /来源线索/);
});

test('dispatches only when idle and records a successful accepted lease', async () => {
  const f = fixture({maxAutomaticTurns:1});
  const seen = [];
  const coordinator = new GoalCoordinator(f.store, {isIdle:async()=>true, hasPendingUserInput:async()=>false, run:async(...args)=>{seen.push(args); return {accepted:true,success:true,productive:true};}});
  await coordinator.runTask(f.taskId);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][2], `goal:${f.goal.goalId}:1`);
  assert.equal(f.calls.completed.length, 1);
  assert.equal(f.current.status, 'budget_limited');
});

test('does not acquire a lease for a busy task or pending user input', async () => {
  for (const port of [
    {isIdle:async()=>false, hasPendingUserInput:async()=>false},
    {isIdle:async()=>true, hasPendingUserInput:async()=>true},
  ]) {
    const f = fixture(); let runs = 0;
    const coordinator = new GoalCoordinator(f.store, {...port, run:async()=>{runs++; return {accepted:true,success:true,productive:true};}});
    await coordinator.runTask(f.taskId);
    assert.equal(runs, 0); assert.equal(f.calls.acquired, 0); assert.equal(f.current.automaticTurnsUsed, 0);
  }
});

test('returns an unaccepted dispatch lease and refunds its automatic-turn budget', async () => {
  const f = fixture();
  const coordinator = new GoalCoordinator(f.store, {isIdle:()=>true, hasPendingUserInput:()=>false, run:async()=>({accepted:false,success:false,productive:false})});
  await coordinator.runTask(f.taskId);
  assert.deepEqual(f.calls.released.map(item => item.refund), [true]);
  assert.equal(f.current.automaticTurnsUsed, 0);
  assert.equal(f.current.leaseId, undefined);
});

test('backs off after an accepted failed turn', async () => {
  const f = fixture(); let runs = 0;
  const coordinator = new GoalCoordinator(f.store, {isIdle:()=>true, hasPendingUserInput:()=>false, run:async()=>{runs++; return {accepted:true,success:false,productive:false,error:'runtime failed'};}}, {failureBackoffMs:60000});
  await coordinator.runTask(f.taskId); await coordinator.runTask(f.taskId);
  assert.equal(runs, 1);
  assert.equal(f.calls.completed[0].outcome.error, 'runtime failed');
});

test('restart recovery expires a prior lease before scanning active goals', async () => {
  const f = fixture(); f.store.acquireLease(f.taskId, 1000);
  const coordinator = new GoalCoordinator(f.store, {isIdle:()=>false, hasPendingUserInput:()=>false, run:async()=>({accepted:true,success:true,productive:true})}, {intervalMs:60000});
  coordinator.start(); await new Promise(resolve=>setImmediate(resolve)); coordinator.stop();
  assert.equal(f.calls.expired, 1); assert.equal(f.current.leaseId, undefined);
});

test('coalesces concurrent dispatches for one task', async () => {
  const f = fixture({maxAutomaticTurns:1}); let runs = 0;
  let release; const entered = new Promise(resolve => { release = resolve; });
  const coordinator = new GoalCoordinator(f.store, {isIdle:()=>true, hasPendingUserInput:()=>false, run:async()=>{runs++; await entered; return {accepted:true,success:true,productive:true};}});
  const first = coordinator.runTask(f.taskId); const second = coordinator.runTask(f.taskId); release(); await Promise.all([first, second]);
  assert.equal(runs, 1);
});

