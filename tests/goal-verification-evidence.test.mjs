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
import {GoalVerificationEvidenceResolver} from '../packages/extensions/goal/goal-verification-evidence-resolver.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-goal-evidence-')));
  const tasks = new TaskStore(path.join(root, 'tasks.sqlite'));
  const goals = new GoalStore({root});
  const task = tasks.createTask({id: randomUUID(), piSessionId: randomUUID()}, randomUUID());
  const created = goals.create(task.id, '提交报告');
  const progressed = goals.updateProgress(task.id, created.plan.items.map(item => item.id));
  const verifying = goals.updateFromAgent(task.id, 'complete', undefined, progressed.revision);
  const content = Buffer.from('[{"id":1},{"id":2}]\n');
  const files = {
    async list() { return {state: 'ready', files: [{id: 'output:result.json', kind: 'output', name: 'result.json', size: content.length, sha256: requireHash(content), modifiedAt: '2026-10-26T00:00:00.000Z'}]}; },
    async read() { return {file: {id: 'output:result.json', kind: 'output', name: 'result.json', size: content.length, sha256: requireHash(content), modifiedAt: '2026-10-26T00:00:00.000Z'}, data: Buffer.from(content)}; },
  };
  const bundles = new GoalVerificationBundleBuilder(tasks, {workspaceFiles: files, snapshotRoot: path.join(root, 'snapshots')});
  const store = new GoalVerificationStore({root});
  t.after(() => { store.close(); tasks.close(); goals.close(); fs.rmSync(root, {recursive: true, force: true}); });
  return {root, tasks, goals, task, verifying, bundles, store};
}

function requireHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function runningFixture(t) {
  const f = fixture(t);
  const request = f.store.createRequest(randomUUID(), f.verifying);
  const bundle = await f.bundles.build(request.id, f.verifying);
  f.store.attachBundle(request.id, bundle);
  f.store.begin(request.id);
  return {...f, bundle, access: createGoalVerificationEvidenceAccess({store: f.store, bundles: f.bundles})};
}

test('controlled retrieval receipts are hash-linked, scoped and persisted', async t => {
  const f = await runningFixture(t);
  const receipt = f.access.recordRetrieval({
    verificationId: f.bundle.verificationId,
    kind: 'search',
    provider: 'openalex',
    query: 'RNA interference',
    sourceUrl: 'https://api.openalex.org/works?search=RNA%20interference',
    fetchedAt: '2026-10-26T00:00:00.000Z',
    contentType: 'application/json',
    responseText: '{"results":[{"id":"https://doi.org/10.1/example","title":"Example"}]}',
  });
  assert.match(receipt.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(f.access.getRetrieval(f.bundle.verificationId, receipt.id).responseText, receipt.responseText);
  const reopened = new GoalVerificationStore({root: f.root});
  assert.equal(reopened.getRetrieval(receipt.id, f.bundle.verificationId).contentSha256, receipt.contentSha256);
  reopened.close();
  assert.throws(() => f.access.recordRetrieval({verificationId: f.bundle.verificationId, kind: 'fetch', provider: 'custom', sourceUrl: 'https://example.com/a', fetchedAt: new Date().toISOString(), responseText: 'x'}), /allowlist/i);
  assert.throws(() => f.access.recordRetrieval({verificationId: f.bundle.verificationId, kind: 'fetch', provider: 'custom', sourceUrl: 'https://doi.org/a', fetchedAt: new Date().toISOString(), responseText: 'x'.repeat(1_500_001)}), /1500000/);
});

test('artifact checks read only the immutable snapshot and save deterministic receipts', async t => {
  const f = await runningFixture(t);
  const artifactId = f.bundle.artifacts[0].id;
  const checked = await f.access.checkArtifact({verificationId: f.bundle.verificationId, artifactId, operation: 'json_array_length', expected: {equals: 2}});
  assert.equal(checked.check.result.passed, true);
  assert.match(checked.evidence.evidenceId, /^[0-9a-f-]{36}$/);
  assert.equal(checked.evidence.method, 'deterministic_check');
  assert.equal(f.store.getCheck(checked.check.id, f.bundle.verificationId).resultSha256, checked.check.resultSha256);
  const snapshot = path.join(f.root, 'snapshots', f.bundle.verificationId, f.bundle.artifacts[0].snapshotPath);
  fs.chmodSync(snapshot, 0o600);
  fs.writeFileSync(snapshot, 'tampered');
  await assert.rejects(() => f.access.checkArtifact({verificationId: f.bundle.verificationId, artifactId, operation: 'exists'}), /no longer matches/i);
});

test('evidence access refuses records outside a running verification', async t => {
  const f = fixture(t);
  const request = f.store.createRequest(randomUUID(), f.verifying);
  const bundle = await f.bundles.build(request.id, f.verifying);
  f.store.attachBundle(request.id, bundle);
  const access = createGoalVerificationEvidenceAccess({store: f.store, bundles: f.bundles});
  await assert.rejects(() => access.checkArtifact({verificationId: request.id, artifactId: bundle.artifacts[0].id, operation: 'exists'}), /pending/i);
});

test('evidence resolver persists random stable units for bundle content', async t => {
  const f = await runningFixture(t);
  const resolver = new GoalVerificationEvidenceResolver(f.store, f.bundles);
  const first = resolver.prepareBundle(f.store.get(f.bundle.verificationId));
  const second = resolver.prepareBundle(f.store.get(f.bundle.verificationId));
  assert.deepEqual(first.map(unit => unit.id), second.map(unit => unit.id));
  assert.equal(first.length, 1);
  assert.match(first[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(first[0].method, 'artifact_read');
  const artifact = resolver.materializeArtifact(f.store.get(f.bundle.verificationId), f.bundle.artifacts[0].id, '[artifact excerpt]', 'chars:0-17');
  assert.match(artifact.id, /^[0-9a-f-]{36}$/);
  assert.equal(artifact.id.startsWith('artifact:'), false);
  assert.equal(f.store.getEvidenceUnit(artifact.id, f.bundle.verificationId).dedupeKey, artifact.dedupeKey);
});

test('evidence excerpts preserve ordinary line breaks from task messages', async t => {
  const f = fixture(t);
  f.tasks.appendAssistantMessage(f.task.id, '第一行\n第二行', 'complete');
  const request = f.store.createRequest(randomUUID(), f.verifying);
  const bundle = await f.bundles.build(request.id, f.verifying);
  f.store.attachBundle(request.id, bundle);
  f.store.begin(request.id);
  const resolver = new GoalVerificationEvidenceResolver(f.store, f.bundles);
  const unit = resolver.prepareBundle(f.store.get(request.id)).find(item => item.method === 'message_quote');
  assert.ok(unit);
  assert.match(unit.excerpt, /第一行\n第二行/);
});

test('evidence resolver materializes scholarly records and deterministic checks with deduplication', async t => {
  const f = await runningFixture(t);
  const resolver = new GoalVerificationEvidenceResolver(f.store, f.bundles);
  const retrieval = f.store.recordRetrieval({
    verificationId: f.bundle.verificationId,
    kind: 'search', provider: 'openalex', query: 'RNA interference',
    sourceUrl: 'https://api.openalex.org/works?search=RNA%20interference',
    fetchedAt: '2026-10-26T00:00:00.000Z', contentType: 'application/json',
    responseText: JSON.stringify({results: [{doi: 'https://doi.org/10.1000/Example', title: 'Example'}]}),
  });
  const first = resolver.materializeRetrieval(retrieval);
  const second = resolver.materializeRetrieval(retrieval);
  assert.equal(first.length, 1);
  assert.deepEqual(first.map(unit => unit.id), second.map(unit => unit.id));
  assert.equal(first[0].sourceId, 'DOI:10.1000/example');
  assert.equal(first[0].locator, '/results/0');
  const check = f.store.recordCheck({verificationId: f.bundle.verificationId, artifactId: f.bundle.artifacts[0].id, operation: 'exists', executedAt: '2026-10-26T00:00:00.000Z', artifactSha256: f.bundle.artifacts[0].sha256, result: {passed: true}});
  const checkUnit = resolver.materializeCheck(check);
  assert.match(checkUnit.id, /^[0-9a-f-]{36}$/);
  assert.equal(f.store.listEvidenceUnits(f.bundle.verificationId).length, first.length + 1);
});
