import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {approvalFixture} from './helpers/approval-fixture.mjs';
import {getRegisteredToolProposal} from '../packages/capability-platform/tool-lifecycle.mjs';
import {approveRegisteredToolProposal, listRegisteredToolVersions} from '../packages/capability-platform/tool-approval-service.mjs';
import {ToolApprovalStore} from '../packages/capability-platform/tool-approval-store.mjs';
import {createToolApproval} from '../packages/capability-platform/tool-approval-worker.mjs';
import {ToolAutomationStore} from '../packages/capability-platform/tool-automation-store.mjs';
import {createToolCurationCoordinator} from '../packages/extensions/tool-curation/tool-curation-coordinator.mjs';

function coordinatorFixture(f, {approval, onSettled} = {}) {
  const worker = createToolApproval({
    root: f.root,
    store: approval,
    approve: (proposalId, actor) => approveRegisteredToolProposal(proposalId, actor, {root: f.root}),
    onSettled: notification => onSettled?.(notification),
  });
  return worker;
}

async function setup(t) {
  const fixtureHooks = [];
  const f = await approvalFixture({after: hook => fixtureHooks.push(hook)});
  const automation = new ToolAutomationStore({root: f.root});
  const approval = new ToolApprovalStore({
    root: f.root,
    isVerified: proposalId => {
      if (proposalId !== f.id) return false;
      const detail = getRegisteredToolProposal(proposalId, {root: f.root});
      return ['verified', 'approved'].includes(detail.registry.state) && detail.validation?.passed === true;
    },
  });
  const sourceTaskId = randomUUID();
  const curationId = randomUUID();
  automation.registerProposal({
    proposalId: f.id,
    sourceTaskId,
    curationId,
    toolName: f.input.toolName,
    artifactSha256: f.saved.registry.artifactSha256,
  });
  automation.setPhase(f.id, 'validating');
  t.after(async () => {
    automation.close();
    approval.close();
    for (const hook of fixtureHooks.toReversed()) {
      try { await hook(); } catch { fs.rmSync(f.root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}); }
    }
  });
  return {f, automation, approval, sourceTaskId, curationId};
}

test('real coordinator approval worker activates a verified proposal and completes durable automation', async t => {
  const s = await setup(t);
  let coordinator;
  const worker = coordinatorFixture(s.f, {
    approval: s.approval,
    automation: s.automation,
    onSettled: notification => coordinator.observeApproval(notification),
  });
  coordinator = createToolCurationCoordinator({
    root: s.f.root,
    taskStore: {}, preview: {}, curation: {},
    toolAutomation: s.automation, toolApproval: worker,
    automaticApproval: true, approvalActor: 'e2e-operator', maxReviews: 1, maxApprovals: 1,
    isReady: () => true,
  });
  await worker.start(); coordinator.start(); coordinator.configure({enabled: true});
  coordinator.observeMaintenance({proposalId: s.f.id, status: 'succeeded', passed: true});
  await worker.drain();
  const run = s.automation.get(s.f.id);
  assert.equal(run.phase, 'completed');
  assert.equal(s.approval.latest(s.f.id).status, 'succeeded');
  assert.equal(s.approval.latest(s.f.id).approved, true);
  assert.equal(s.approval.latest(s.f.id).activated, true);
  assert.equal(listRegisteredToolVersions({root: s.f.root})[0].state, 'active');
  await coordinator.stop(); await worker.stop();
});

test('real approval service failure reaches coordinator failed terminal state', async t => {
  const s = await setup(t);
  const detail = getRegisteredToolProposal(s.f.id, {root: s.f.root});
  let coordinator;
  const worker = coordinatorFixture(s.f, {
    approval: s.approval,
    automation: s.automation,
    onSettled: notification => coordinator.observeApproval(notification),
  });
  coordinator = createToolCurationCoordinator({
    root: s.f.root, taskStore: {}, preview: {}, curation: {},
    toolAutomation: s.automation, toolApproval: worker,
    automaticApproval: true, approvalActor: 'e2e-operator', maxReviews: 1, maxApprovals: 1,
    isReady: () => true,
  });
  coordinator.start(); coordinator.configure({enabled: true});
  coordinator.observeMaintenance({proposalId: s.f.id, status: 'succeeded', passed: true});
  fs.appendFileSync(detail.validation.reportPath, '\n');
  await worker.start();
  await worker.drain();
  assert.equal(s.automation.get(s.f.id).phase, 'failed');
  assert.equal(s.approval.latest(s.f.id).status, 'failed');
  assert.equal(listRegisteredToolVersions({root: s.f.root}).length, 0);
  await coordinator.stop(); await worker.stop();
});

test('restarted real approval worker resumes a pending coordinator job', async t => {
  const s = await setup(t);
  let firstCoordinator;
  const firstWorker = coordinatorFixture(s.f, {
    approval: s.approval,
    automation: s.automation,
    onSettled: notification => firstCoordinator.observeApproval(notification),
  });
  firstCoordinator = createToolCurationCoordinator({
    root:s.f.root,taskStore:{},preview:{},curation:{},toolAutomation:s.automation,toolApproval:firstWorker,
    automaticApproval:true,approvalActor:'e2e-operator',maxReviews:1,maxApprovals:1,isReady:()=>true,
  });
  firstCoordinator.start(); firstCoordinator.configure({enabled: true});
  firstCoordinator.observeMaintenance({proposalId: s.f.id, status: 'succeeded', passed: true});
  assert.equal(s.approval.latest(s.f.id).status, 'pending');
  await firstCoordinator.stop(); await firstWorker.stop();
  s.approval.close();

  const reopened = new ToolApprovalStore({
    root: s.f.root,
    isVerified: proposalId => {
      const detail = getRegisteredToolProposal(proposalId, {root: s.f.root});
      return ['verified', 'approved'].includes(detail.registry.state) && detail.validation?.passed === true;
    },
  });
  let restartedCoordinator;
  const restarted = createToolApproval({
    root: s.f.root,
    store: reopened,
    approve: (proposalId, actor) => approveRegisteredToolProposal(proposalId, actor, {root: s.f.root}),
    onSettled: notification => restartedCoordinator.observeApproval(notification),
  });
  restartedCoordinator = createToolCurationCoordinator({
    root: s.f.root, taskStore: {}, preview: {}, curation: {},
    toolAutomation: s.automation, toolApproval: restarted,
    automaticApproval: true, approvalActor: 'e2e-operator', maxReviews: 1, maxApprovals: 1,
    isReady: () => true,
  });
  t.after(async () => { await restartedCoordinator.stop(); await restarted.stop(); reopened.close(); });
  restartedCoordinator.start(); restartedCoordinator.configure({enabled: true}); await restarted.start(); await restarted.drain();
  assert.equal(s.automation.get(s.f.id).phase, 'completed');
  assert.equal(listRegisteredToolVersions({root: s.f.root})[0].state, 'active');
  await restartedCoordinator.stop(); await restarted.stop(); reopened.close();
});
