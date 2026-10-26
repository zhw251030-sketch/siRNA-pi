import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {TaskStore} from '../packages/task-core/task-store.mjs';
import {GoalStore} from '../packages/extensions/goal/goal-store.mjs';
import {GoalVerificationBundleBuilder} from '../packages/extensions/goal/goal-verification-bundle.mjs';
import {GoalVerificationStore} from '../packages/extensions/goal/goal-verification-store.mjs';
import {GoalVerificationCoordinator} from '../packages/extensions/goal/goal-verification-coordinator.mjs';
import {createDeterministicGoalVerifier} from '../packages/extensions/goal/goal-verification-fake.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function fixture(t, objective = '提交报告', {withTool = true} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-goal-coordinator-')));
  const tasks = new TaskStore(path.join(root, 'tasks.sqlite'));
  const goals = new GoalStore({root});
  const task = tasks.createTask({id: randomUUID(), piSessionId: randomUUID()}, randomUUID());
  const created = goals.create(task.id, objective);
  const progressed = goals.updateProgress(task.id, created.plan.items.map(item => item.id));
  const verifying = goals.updateFromAgent(task.id, 'complete', undefined, progressed.revision);
  const user = tasks.appendConversationUserMessage(task.id, objective, `goal:${created.goalId}`);
  tasks.appendAssistantMessage(task.id, '已提交阶段结果', 'complete');
  if (withTool) {
    const runId = randomUUID();
    tasks.appendRunEvent(task.id, user.id, runId, 'tool_start', {
      type: 'tool_start', toolCallId: 'call-1', toolName: 'write_report', args: {name: 'report.md'},
    });
    tasks.appendRunEvent(task.id, user.id, runId, 'tool_end', {
      type: 'tool_end', toolCallId: 'call-1', toolName: 'write_report', isError: false,
      result: {ok: true, path: 'report.md'},
    });
  }
  const content = Buffer.from('# report\n');
  const workspaceFiles = {
    async list() { return {state: 'ready', synchronization: 'current', files: [
      {id: 'output:report.md', kind: 'output', name: 'report.md', size: content.length, sha256: sha256(content), modifiedAt: '2026-10-26T00:00:00.000Z'},
    ]}; },
    async read(_task, kind, name) {
      assert.equal(kind, 'output'); assert.equal(name, 'report.md');
      return {file: {id: 'output:report.md', kind, name, size: content.length, sha256: sha256(content), modifiedAt: '2026-10-26T00:00:00.000Z'}, data: Buffer.from(content)};
    },
  };
  const bundles = new GoalVerificationBundleBuilder(tasks, {workspaceFiles, snapshotRoot: path.join(root, 'snapshots')});
  const store = new GoalVerificationStore({root});
  t.after(() => { store.close(); tasks.close(); goals.close(); fs.rmSync(root, {recursive: true, force: true}); });
  return {root, tasks, goals, task, verifying, bundles, store};
}

test('verification store persists one request per Goal revision and reopens it', t => {
  const f = fixture(t);
  const first = f.store.createRequest(randomUUID(), f.verifying, 'completion_request');
  const duplicate = f.store.getForGoalRevision(f.verifying.goalId, f.verifying.revision, 'completion_request');
  assert.equal(duplicate.id, first.id);
  const reopened = new GoalVerificationStore({root: f.root});
  assert.equal(reopened.get(first.id).status, 'waiting');
  reopened.close();
});

test('coordinator resolves a deterministic pass and completes the Goal', async t => {
  const f = fixture(t);
  const verifier = createDeterministicGoalVerifier();
  const coordinator = new GoalVerificationCoordinator(f.goals, f.store, f.bundles, verifier, {autoRun: false});
  const request = await coordinator.request(f.verifying);
  assert.equal(request.status, 'waiting');
  await coordinator.runVerification(request.id);
  const run = f.store.get(request.id);
  assert.equal(run.status, 'passed');
  assert.equal(f.goals.get(f.task.id).status, 'complete');
  assert.equal(run.evaluation.decision, 'pass');
});

test('policy failure returns the Goal to active with actionable feedback', async t => {
  const f = fixture(t, '运行测试；提交报告', {withTool: false});
  const coordinator = new GoalVerificationCoordinator(f.goals, f.store, f.bundles, createDeterministicGoalVerifier(), {autoRun: false});
  const request = await coordinator.request(f.verifying);
  await coordinator.runVerification(request.id);
  const run = f.store.get(request.id);
  const goal = f.goals.get(f.task.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.evaluation.decision, 'fail');
  assert.equal(goal.status, 'active');
  assert.match(goal.latestVerificationFeedback, /execution|运行|tool/i);
});

test('verifier infrastructure failure pauses the Goal', async t => {
  const f = fixture(t);
  const coordinator = new GoalVerificationCoordinator(f.goals, f.store, f.bundles, {
    async verify() { throw new Error('fake verifier unavailable'); },
  }, {autoRun: false});
  const request = await coordinator.request(f.verifying);
  await coordinator.runVerification(request.id);
  assert.equal(f.store.get(request.id).status, 'error');
  const goal = f.goals.get(f.task.id);
  assert.equal(goal.status, 'paused');
  assert.match(goal.blockedReason, /verifier unavailable/i);
});

test('stale Goal revision fails closed without overwriting the newer Goal state', async t => {
  const f = fixture(t);
  const coordinator = new GoalVerificationCoordinator(f.goals, f.store, f.bundles, createDeterministicGoalVerifier(), {autoRun: false});
  const request = await coordinator.request(f.verifying);
  f.goals.continueAfterVerification(f.task.id, f.verifying.revision, '用户先处理新的反馈');
  await coordinator.runVerification(request.id);
  assert.equal(f.store.get(request.id).status, 'error');
  assert.equal(f.goals.get(f.task.id).status, 'active');
  assert.equal(f.goals.get(f.task.id).latestVerificationFeedback, '用户先处理新的反馈');
});

test('unknown evidence IDs are rejected and become an infrastructure pause', async t => {
  const f = fixture(t);
  const verifier = {
    async verify(run) {
      const criterion = run.bundle.acceptanceCriteria[0];
      return {protocolVersion: 'sirna-goal-verification-review/v1', decision: 'pass', summary: 'fake', feedback: '',
        qualityReview: {internalConsistency: {status: 'pass', rationale: 'ok'}, methodologicalValidity: {status: 'pass', rationale: 'ok'}, sourceRelevance: {status: 'pass', rationale: 'ok'}, unsupportedPrecision: {status: 'pass', rationale: 'ok'}, issues: []},
        claims: [{id: 'claim-1', category: 'artifact', importance: 'major', verdict: 'supported', statement: 'report exists', evidence: [{evidenceId: 'does-not-exist'}]}],
        requirements: [{criterionId: criterion.id, status: 'satisfied', claimIds: ['claim-1']}],
      };
    },
  };
  const coordinator = new GoalVerificationCoordinator(f.goals, f.store, f.bundles, verifier, {autoRun: false});
  const request = await coordinator.request(f.verifying);
  await coordinator.runVerification(request.id);
  assert.equal(f.store.get(request.id).status, 'error');
  assert.equal(f.goals.get(f.task.id).status, 'paused');
});
