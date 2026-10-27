import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AgentComposeRuntime} from '../packages/agent-runtime/agent-compose-runtime.mjs';
import {createAgentComposeGoalVerifier, createRuntimeGoalVerifier, verificationPrompt} from '../packages/extensions/goal/goal-verification-agent-compose.mjs';

const review = () => ({
  protocolVersion: 'sirna-goal-verification-review/v1', decision: 'fail', summary: '证据不足', feedback: '请补充证据',
  qualityReview: {
    internalConsistency: {status: 'uncertain', rationale: '待检查'},
    methodologicalValidity: {status: 'uncertain', rationale: '待检查'},
    sourceRelevance: {status: 'uncertain', rationale: '待检查'},
    unsupportedPrecision: {status: 'uncertain', rationale: '待检查'}, issues: [],
  }, requirements: [{criterionId: 'criterion-1', status: 'missing', claimIds: []}], claims: [],
});

function run() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    bundle: {
      objective: '提交报告',
      acceptanceCriteria: [{id: 'criterion-1', text: '报告存在', requiredEvidence: ['artifact']}],
    },
    evidenceUnits: [{id: 'evidence-1', method: 'artifact_read', sourceUrl: 'artifact://output:report.md'}],
  };
}

test('Agent Compose verifier creates, runs, reports identity, redacts prompt, and removes session', async () => {
  const calls = [];
  const chat = {
    async create() { calls.push(['create']); return {id: 'session-1'}; },
    async run(request, emit) {
      calls.push(['run', request]);
      emit({type: 'run_status', runId: 'run-1', status: 'running'});
      emit({type: 'assistant_message', runId: 'run-1', text: JSON.stringify(review())});
    },
    async remove(id) { calls.push(['remove', id]); },
  };
  const verifier = createAgentComposeGoalVerifier(chat);
  let started;
  let savedPrompt;
  const response = await verifier.verify(run(), 'short-lived-secret-123456', undefined,
    (sessionId, runId) => { started = {sessionId, runId}; }, undefined,
    prompt => { savedPrompt = prompt; });
  assert.deepEqual(started, {sessionId: 'session-1', runId: 'run-1'});
  assert.equal(response.sessionId, 'session-1');
  assert.equal(response.runId, 'run-1');
  assert.equal(response.result.decision, 'fail');
  assert.match(calls[1][1].message, /short-lived-secret-123456/);
  assert.doesNotMatch(savedPrompt, /short-lived-secret-123456/);
  assert.match(savedPrompt, /REDACTED_SHORT_LIVED_ACCESS_TOKEN/);
  assert.deepEqual(calls.at(-1), ['remove', 'session-1']);
});

test('Agent Compose verifier sends retry feedback and rejects ambiguous model output', async () => {
  let request;
  const chat = {
    async create() { return {id: 'session-2'}; },
    async run(value, emit) { request = value; emit({type: 'assistant_message', text: `${JSON.stringify(review())}\n${JSON.stringify(review())}`}); },
    async remove() {},
  };
  const verifier = createAgentComposeGoalVerifier(chat);
  await assert.rejects(
    verifier.verify(run(), 'short-lived-secret-123456', undefined, undefined, '{"code":"EVIDENCE_REFERENCE_INVALID"}'),
    /exactly one complete JSON object/,
  );
  assert.match(request.message, /EVIDENCE_REFERENCE_INVALID/);
  assert.match(request.message, /read_verification_attempt/);
});

test('verification prompt exposes backend evidence IDs but forbids model-created locators', () => {
  const prompt = verificationPrompt(run(), 'token-1234567890');
  assert.match(prompt, /evidence-1/);
  assert.match(prompt, /evidenceId/);
  assert.match(prompt, /Never construct/);
  assert.match(prompt, /token-1234567890/);
});

test('verification prompt publishes the exact claim and requirement field contract', () => {
  const prompt = verificationPrompt(run(), 'token-1234567890');
  assert.match(prompt, /criterionId/);
  assert.match(prompt, /claimIds/);
  assert.match(prompt, /verdict.*supported \| contradicted \| insufficient_evidence \| unverifiable \| irrelevant/s);
  assert.match(prompt, /category.*objective \| artifact \| tool_result \| external_fact/s);
  assert.match(prompt, /forbiddenNearMissFields/);
});

test('verification prompt spells out policy field names instead of ambiguous near-miss fields', () => {
  const prompt = verificationPrompt(run(), 'token-1234567890');
  assert.match(prompt, /"criterionId":\s*"copy exactly one backend acceptanceCriteria/);
  assert.match(prompt, /"claimIds":\s*\[\s*"claim-1"/);
  assert.match(prompt, /"verdict":\s*"supported \| contradicted/);
  assert.match(prompt, /forbiddenNearMissFields/);
  assert.match(prompt, /claims\[\]\.supported/);
  assert.match(prompt, /claims\[\]\.criterionIds/);
  assert.match(prompt, /qualityReview\.issues.*空数组/);
});

test('runtime adapter translates AgentComposeRuntime events and keeps sandbox cleanup in finally', async () => {
  const calls = [];
  const runtime = {
    async create() { calls.push('create'); return {id: 'runtime-session'}; },
    async run(request, emit) {
      calls.push(request);
      emit({type: 'session', runId: 'runtime-run'});
      emit({type: 'assistant_message', runId: 'runtime-run', text: JSON.stringify(review())});
    },
    async remove(id) { calls.push(`remove:${id}`); },
  };
  const response = await createRuntimeGoalVerifier(runtime).verify(run(), 'runtime-token-123456', undefined);
  assert.equal(response.sessionId, 'runtime-session');
  assert.equal(response.runId, 'runtime-run');
  assert.deepEqual(calls, ['create', {sessionId: 'runtime-session', message: calls[1]?.message}, 'remove:runtime-session']);
});

test('goal-verifier Agent Compose role has isolated storage and cannot receive task tool leases', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-goal-verifier-role-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const executor = {up: async () => ({project: {id: 'p'.repeat(64)}})};
  const rpc = {};
  const runtime = new AgentComposeRuntime({root, executor, rpc, agentName: 'goal-verifier'});
  const session = await runtime.create();
  assert.equal(session.agentName, 'goal-verifier');
  assert.ok(fs.existsSync(path.join(root, 'runtime/goal-verifier/sessions', `${session.id}.json`)));
  assert.throws(() => new AgentComposeRuntime({root, executor, rpc, agentName: 'goal-verifier', toolCallLeases: {}}), /goal-verifier|lease/i);
});

test('goal-verifier guest guard permits MCP and blocks built-in mutation tools', async () => {
  const previous = process.env.SIRNA_GOAL_VERIFIER;
  process.env.SIRNA_GOAL_VERIFIER = '1';
  try {
    const {default: guard} = await import(`../containers/agent-compose-guest/goal-verifier-guard.mjs?test=${Date.now()}`);
    const hooks = new Map(); let active;
    guard({on: (name, callback) => hooks.set(name, callback), setActiveTools: names => { active = names; }});
    await hooks.get('session_start')();
    assert.deepEqual(active, ['mcp']);
    assert.equal((await hooks.get('tool_call')({toolName: 'mcp'}, {abort() {}})), undefined);
    let aborted = false;
    const blocked = await hooks.get('tool_call')({toolName: 'bash'}, {abort() { aborted = true; }});
    assert.equal(blocked.block, true); assert.equal(blocked.terminate, true); assert.equal(aborted, true);
  } finally {
    if (previous === undefined) delete process.env.SIRNA_GOAL_VERIFIER;
    else process.env.SIRNA_GOAL_VERIFIER = previous;
  }
});
