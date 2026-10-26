import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {TaskStore} from '../packages/task-core/task-store.mjs';
import {GoalStore} from '../packages/extensions/goal/goal-store.mjs';
import {GoalVerificationBundleBuilder} from '../packages/extensions/goal/goal-verification-bundle.mjs';
import {GoalVerificationStore} from '../packages/extensions/goal/goal-verification-store.mjs';
import {createGoalVerificationEvidenceAccess} from '../packages/extensions/goal/goal-verification-evidence.mjs';
import {createGoalVerificationAccess} from '../packages/extensions/goal/goal-verification-access.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-goal-access-')));
  const tasks = new TaskStore(path.join(root, 'tasks.sqlite'));
  const goals = new GoalStore({root});
  const task = tasks.createTask({id: randomUUID(), piSessionId: randomUUID()}, randomUUID());
  tasks.appendConversationUserMessage(task.id, '请完成并验证提交报告。', `objective:${randomUUID()}`);
  tasks.appendAssistantMessage(task.id, '已生成报告并准备验证。', 'complete');
  const created = goals.create(task.id, '提交报告');
  const progressed = goals.updateProgress(task.id, created.plan.items.map(item => item.id));
  const verifying = goals.updateFromAgent(task.id, 'complete', undefined, progressed.revision);
  const content = Buffer.from('[{"id":1},{"id":2}]\n');
  const files = {
    async list() { return {state: 'ready', files: [{id: 'output:result.json', kind: 'output', name: 'result.json', size: content.length, sha256: digest(content), modifiedAt: '2026-10-26T00:00:00.000Z'}]}; },
    async read() { return {file: {id: 'output:result.json', kind: 'output', name: 'result.json', size: content.length, sha256: digest(content), modifiedAt: '2026-10-26T00:00:00.000Z'}, data: Buffer.from(content)}; },
  };
  const bundles = new GoalVerificationBundleBuilder(tasks, {workspaceFiles: files, snapshotRoot: path.join(root, 'snapshots')});
  const store = new GoalVerificationStore({root});
  const request = store.createRequest(randomUUID(), verifying);
  const bundle = await bundles.build(request.id, verifying);
  store.attachBundle(request.id, bundle);
  const token = 'access-token-for-test';
  store.begin(request.id, token);
  const evidence = createGoalVerificationEvidenceAccess({store, bundles});
  const access = createGoalVerificationAccess({store, bundles, evidence});
  t.after(() => { store.close(); tasks.close(); goals.close(); fs.rmSync(root, {recursive: true, force: true}); });
  return {root, tasks, goals, store, bundles, evidence, access, request: store.get(request.id), token};
}

test('token-scoped bundle access hides message and tool payload bodies', async t => {
  const f = await fixture(t);
  const body = f.access.bundle({verificationId: f.request.id, accessToken: f.token});
  assert.equal(body.verificationId, f.request.id);
  assert.equal(body.bundle.messages[0].content, undefined);
  assert.equal(typeof body.bundle.messages[0].contentCharacters, 'number');
  assert.equal(body.bundle.toolReceipts.every(item => item.resultPreview === undefined), true);
  assert.throws(() => f.access.bundle({verificationId: f.request.id, accessToken: 'wrong'}), /invalid|expired/i);
});

test('message and artifact access are paginated and bound to the immutable snapshot', async t => {
  const f = await fixture(t);
  const message = f.access.message({verificationId: f.request.id, accessToken: f.token, messageId: f.request.bundle.messages[0].id, offset: 0, maxChars: 1});
  assert.equal(message.content.length, 1);
  assert.equal(message.truncated, true);
  assert.throws(() => f.access.message({verificationId: f.request.id, accessToken: f.token, messageId: f.request.bundle.messages[0].id, maxChars: 16_001}), /integer|16000/i);
  const artifact = await f.access.artifact({verificationId: f.request.id, accessToken: f.token, artifactId: f.request.bundle.artifacts[0].id, maxChars: 1});
  assert.equal(artifact.content.length, 1);
  assert.equal(artifact.truncated, true);
  await assert.rejects(() => f.access.artifact({verificationId: randomUUID(), accessToken: f.token, artifactId: f.request.bundle.artifacts[0].id}), /invalid|expired|not found/i);
});

test('check access returns a persisted deterministic receipt and token expires at terminal state', async t => {
  const f = await fixture(t);
  const check = await f.access.check({verificationId: f.request.id, accessToken: f.token, artifactId: f.request.bundle.artifacts[0].id, operation: 'json_array_length', expected: {equals: 2}});
  assert.equal(check.check.result.passed, true);
  assert.equal(f.store.getCheck(check.check.id, f.request.id).resultSha256, check.check.resultSha256);
  f.store.finish(f.request.id, {decision: 'fail'});
  assert.throws(() => f.access.evidence({verificationId: f.request.id, accessToken: f.token}), /invalid|expired|failed/i);
});

test('attempt access pages protocol diagnostics and never exposes the short-lived token', async t => {
  const f = await fixture(t);
  f.store.startAttempt(f.request.id, 1);
  f.store.setAttemptIdentity(f.request.id, 1, 'session-1', 'run-1');
  f.store.setAttemptPrompt(f.request.id, 1, 'prompt [REDACTED_SHORT_LIVED_ACCESS_TOKEN]');
  f.store.finishAttempt({verificationId: f.request.id, attemptNumber: 1, status: 'protocol_failed', rawProposal: {bad: true}, diagnostics: '{"code":"VERIFIER_OUTPUT_INVALID"}'});
  const page = f.access.attempt({verificationId: f.request.id, accessToken: f.token, attemptNumber: 1, field: 'diagnostics'});
  assert.equal(page.attempt.status, 'protocol_failed');
  assert.match(page.content, /VERIFIER_OUTPUT_INVALID/);
  const prompt = f.access.attempt({verificationId: f.request.id, accessToken: f.token, attemptNumber: 1, field: 'prompt'});
  assert.match(prompt.content, /REDACTED_SHORT_LIVED_ACCESS_TOKEN/);
  assert.doesNotMatch(prompt.content, new RegExp(f.token));
});

test('controlled search and fetch use bounded scholarly routes and return no raw response body', async t => {
  const f = await fixture(t);
  const calls = [];
  const responses = [
    new Response(JSON.stringify({results: [{id: 'https://openalex.org/W1', title: 'RNA interference'}]}), {status: 200, headers: {'content-type': 'application/json'}}),
    new Response(null, {status: 302, headers: {location: 'https://doi.org/10.1000/example'}}),
    new Response('retrieved abstract', {status: 200, headers: {'content-type': 'text/plain'}}),
  ];
  const controlledEvidence = createGoalVerificationEvidenceAccess({
    store: f.store,
    bundles: f.bundles,
    fetchImpl: async (url, options) => { calls.push({url: String(url), options}); return responses.shift(); },
  });
  const access = createGoalVerificationAccess({store: f.store, bundles: f.bundles, evidence: controlledEvidence});
  const search = await access.search({verificationId: f.request.id, accessToken: f.token, provider: 'openalex', query: 'RNA interference', limit: 1});
  assert.equal(search.responseText, undefined);
  assert.equal(search.evidenceStatus, 'available');
  assert.equal(search.evidenceUnits.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.openalex\.org\/works\?/);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.method, 'GET');
  const fetched = await access.fetchSource({verificationId: f.request.id, accessToken: f.token, url: 'https://doi.org/10.1000/example'});
  assert.equal(fetched.responseText, undefined);
  assert.equal(fetched.evidenceStatus, 'available');
  assert.equal(calls.length, 3);
  assert.equal(f.store.listRetrievals(f.request.id).length, 2);
});

test('controlled fetch rejects outside hosts, excessive redirects and oversized bodies', async t => {
  const f = await fixture(t);
  const outside = createGoalVerificationEvidenceAccess({store: f.store, bundles: f.bundles, fetchImpl: async () => new Response('x')});
  await assert.rejects(() => createGoalVerificationAccess({store: f.store, bundles: f.bundles, evidence: outside}).fetchSource({verificationId: f.request.id, accessToken: f.token, url: 'https://example.com/a'}), /allowlist|host/i);
  const redirect = createGoalVerificationEvidenceAccess({store: f.store, bundles: f.bundles, fetchImpl: async () => new Response(null, {status: 302, headers: {location: 'https://doi.org/next'}})});
  await assert.rejects(() => createGoalVerificationAccess({store: f.store, bundles: f.bundles, evidence: redirect}).fetchSource({verificationId: f.request.id, accessToken: f.token, url: 'https://doi.org/start'}), /redirect/i);
  const oversized = createGoalVerificationEvidenceAccess({store: f.store, bundles: f.bundles, fetchImpl: async () => new Response('x'.repeat(1_500_001), {status: 200})});
  await assert.rejects(() => createGoalVerificationAccess({store: f.store, bundles: f.bundles, evidence: oversized}).fetchSource({verificationId: f.request.id, accessToken: f.token, url: 'https://doi.org/large'}), /1500000/i);
});
