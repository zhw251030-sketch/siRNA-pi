import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateVerificationResult} from '../packages/extensions/goal/goal-verification-policy.mjs';

const review = (evidence, {category = 'artifact'} = {}) => ({
  protocolVersion: 'sirna-goal-verification-review/v1', decision: 'pass', summary: 'ok', feedback: '',
  qualityReview: {
    internalConsistency: {status: 'pass', rationale: 'ok'},
    methodologicalValidity: {status: 'pass', rationale: 'ok'},
    sourceRelevance: {status: 'pass', rationale: 'ok'},
    unsupportedPrecision: {status: 'pass', rationale: 'ok'}, issues: [],
  },
  claims: [{id: 'claim-1', claim: 'check passed', selfContainedClaim: 'deterministic check passed', category, importance: 'major', verdict: 'supported', rationale: 'check passed', evidence}],
  requirements: [{criterionId: 'criterion-1', requirement: 'check is valid', status: 'satisfied', rationale: 'check passed', artifactIds: category === 'artifact' ? ['output:sample.csv'] : [], claimIds: ['claim-1']}],
});

test('passed deterministic checks support artifact claims', () => {
  const run = {bundle: {artifacts: [{id: 'output:sample.csv'}], toolReceipts: [], messages: [], acceptanceCriteria: [{id: 'criterion-1', text: 'artifact is valid', requiredEvidence: ['artifact']}]}};
  const result = evaluateVerificationResult(run, review([{method: 'deterministic_check', sourceUrl: 'check://check-1'}]), {
    getCheck: id => id === 'check-1' ? {id, result: {passed: true}} : undefined,
  });
  assert.equal(result.decision, 'pass');
  assert.deepEqual(result.findings, []);
});

test('passed deterministic checks can satisfy objective and execution evidence', () => {
  const run = {bundle: {artifacts: [], toolReceipts: [], messages: [], acceptanceCriteria: [{id: 'criterion-1', text: 'execution occurred', requiredEvidence: ['execution']}]}};
  const result = evaluateVerificationResult(run, review([{method: 'deterministic_check', sourceUrl: 'check://check-2'}], {category: 'objective'}), {
    getCheck: id => id === 'check-2' ? {id, result: {passed: true}} : undefined,
  });
  assert.equal(result.decision, 'pass');
  assert.deepEqual(result.findings, []);
});

test('deterministic evidence carrying a retrieval id fails closed', () => {
  const run = {bundle: {artifacts: [{id: 'output:sample.csv'}], toolReceipts: [], messages: [], acceptanceCriteria: [{id: 'criterion-1', text: 'artifact is valid', requiredEvidence: ['artifact']}]}};
  const result = evaluateVerificationResult(run, review([{method: 'deterministic_check', sourceUrl: 'check://check-3', retrievalId: 'retrieval-1'}]), {
    getCheck: id => id === 'check-3' ? {id, result: {passed: true}} : undefined,
  });
  assert.equal(result.decision, 'fail');
  assert.ok(result.findings.some(item => item.code === 'EVIDENCE_METHOD_MISMATCH'));
});

test('unknown deterministic checks fail closed', () => {
  const run = {bundle: {artifacts: [{id: 'output:sample.csv'}], toolReceipts: [], messages: [], acceptanceCriteria: [{id: 'criterion-1', text: 'artifact is valid', requiredEvidence: ['artifact']}]}};
  const result = evaluateVerificationResult(run, review([{method: 'deterministic_check', sourceUrl: 'check://missing'}]), {getCheck: () => undefined});
  assert.equal(result.decision, 'fail');
  assert.ok(result.findings.some(item => item.code === 'EVIDENCE_METHOD_MISMATCH'));
});
