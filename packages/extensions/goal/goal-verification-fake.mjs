import {GOAL_VERIFICATION_REVIEW_PROTOCOL} from './goal-verification-policy.mjs';

const qualityReview = {
  internalConsistency: {status: 'pass', rationale: '结构化证据之间没有发现矛盾。'},
  methodologicalValidity: {status: 'pass', rationale: '本地确定性 verifier 只使用已冻结材料。'},
  sourceRelevance: {status: 'pass', rationale: '证据与验收项直接关联。'},
  unsupportedPrecision: {status: 'pass', rationale: '没有提出未由证据支持的精确数值。'},
  issues: [],
};

export function createDeterministicGoalVerifier() {
  return {
    async verify(run) {
      const claims = [];
      const requirements = [];
      const successfulTool = run.bundle.toolReceipts.find(receipt => !receipt.isError);
      const output = run.bundle.artifacts.find(artifact => artifact.kind === 'output');
      const evidenceUnits = run.evidenceUnits ?? [];
      const successfulToolEvidence = successfulTool && evidenceUnits.find(unit => unit.method === 'tool_receipt' && unit.sourceUrl === `tool-receipt://${successfulTool.eventId}`);
      let outputEvidence = output && evidenceUnits.find(unit => unit.method === 'artifact_read' && unit.sourceUrl === `artifact://${output.id}`);
      if (!outputEvidence && output && typeof run.readArtifactEvidence === 'function') {
        const materialized = await run.readArtifactEvidence(output.id);
        outputEvidence = materialized.find(unit => unit.method === 'artifact_read' && unit.sourceUrl === `artifact://${output.id}`);
      }
      let allSatisfied = true;
      for (const criterion of run.bundle.acceptanceCriteria) {
        const needsExternal = criterion.requiredEvidence.includes('external');
        const needsExecution = criterion.requiredEvidence.includes('execution');
        const needsArtifact = criterion.requiredEvidence.includes('artifact');
        const claimIds = [];
        if (needsExternal) {
          allSatisfied = false;
          const id = `claim-${criterion.id}-external`;
          claims.push({id, category: 'external_fact', importance: 'major', verdict: 'insufficient_evidence', statement: criterion.text, evidence: []});
          claimIds.push(id);
        } else if (needsExecution) {
          const id = `claim-${criterion.id}-execution`;
          claims.push({id, category: 'tool_result', importance: 'major', verdict: successfulToolEvidence ? 'supported' : 'insufficient_evidence', statement: criterion.text, evidence: successfulToolEvidence ? [{evidenceId: successfulToolEvidence.id}] : []});
          claimIds.push(id); if (!successfulToolEvidence) allSatisfied = false;
        } else if (needsArtifact || output) {
          const id = `claim-${criterion.id}-artifact`;
          claims.push({id, category: 'artifact', importance: 'major', verdict: outputEvidence ? 'supported' : 'insufficient_evidence', statement: criterion.text, evidence: outputEvidence ? [{evidenceId: outputEvidence.id}] : []});
          claimIds.push(id); if (!outputEvidence) allSatisfied = false;
        } else {
          allSatisfied = false;
          const id = `claim-${criterion.id}-independent`;
          claims.push({id, category: 'objective', importance: 'major', verdict: 'insufficient_evidence', statement: criterion.text, evidence: []});
          claimIds.push(id);
        }
        requirements.push({criterionId: criterion.id, status: allSatisfied && claims.at(-1)?.verdict === 'supported' ? 'satisfied' : 'unsatisfied', claimIds});
      }
      const decision = allSatisfied ? 'pass' : 'fail';
      return {protocolVersion: GOAL_VERIFICATION_REVIEW_PROTOCOL, decision, summary: decision === 'pass' ? '所有本地验收项均有可追溯证据。' : '当前冻结证据不足以支持所有验收项。', feedback: decision === 'pass' ? '' : '请补充未满足的执行或产物证据。', qualityReview, claims, requirements};
    },
  };
}
