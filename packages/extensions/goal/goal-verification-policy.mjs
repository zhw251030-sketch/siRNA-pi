function canonicalJson(value) {
  if (value === undefined || value === null) return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export const GOAL_VERIFICATION_REVIEW_PROTOCOL = 'sirna-goal-verification-review/v1';

export class GoalEvidenceReferenceError extends Error {
  constructor(message, findings = []) { super(message); this.name = 'GoalEvidenceReferenceError'; this.findings = findings; }
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; }
function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }

export function verificationEvidenceUnits(bundle) {
  const units = [];
  for (const artifact of bundle.artifacts ?? []) units.push({
    evidenceId: `artifact:${artifact.id}`, method: 'artifact_read', sourceUrl: `artifact://${artifact.id}`,
    title: artifact.name, excerpt: artifact.encoding === 'binary' ? `[binary artifact: ${artifact.name}]` : `[artifact: ${artifact.name}]`,
    fetchedAt: artifact.modifiedAt, contentSha256: artifact.sha256,
  });
  for (const receipt of bundle.toolReceipts ?? []) units.push({
    evidenceId: `tool:${receipt.eventId}`, method: 'tool_receipt', sourceUrl: `tool-receipt://${receipt.eventId}`,
    title: receipt.toolName, excerpt: canonicalJson({toolName: receipt.toolName, isError: receipt.isError, resultPreview: receipt.resultPreview ?? null}),
    fetchedAt: receipt.createdAt, contentSha256: receipt.resultSha256,
  });
  for (const message of bundle.messages ?? []) units.push({
    evidenceId: `message:${message.id}`, method: 'message_quote', sourceUrl: `message://${message.id}`,
    title: `${message.role} message ${message.sequence}`, excerpt: message.content,
    fetchedAt: message.createdAt, contentSha256: message.sha256,
  });
  return units;
}

export function resolveVerificationProposal(bundle, proposal) {
  if (!record(proposal) || proposal.protocolVersion !== GOAL_VERIFICATION_REVIEW_PROTOCOL) throw new Error('verifier proposal protocol is invalid');
  if (!['pass', 'fail'].includes(proposal.decision)) throw new Error('verifier proposal decision is invalid');
  if (!Array.isArray(proposal.claims) || !Array.isArray(proposal.requirements)) throw new Error('verifier proposal must contain claims and requirements');
  const units = new Map(verificationEvidenceUnits(bundle).map(unit => [unit.evidenceId, unit]));
  const findings = [];
  const claims = proposal.claims.map((claim, index) => {
    if (!record(claim) || !text(claim.id) || !Array.isArray(claim.evidence)) throw new Error(`claim ${index + 1} is malformed`);
    const evidence = claim.evidence.map((reference, evidenceIndex) => {
      const evidenceId = text(reference?.evidenceId);
      const unit = evidenceId ? units.get(evidenceId) : undefined;
      if (!unit) {
        findings.push({code: 'INVALID_EVIDENCE_REFERENCE', claimId: claim.id, field: `claims[${index}].evidence[${evidenceIndex}]`, message: `unknown evidenceId ${evidenceId ?? '(missing)'}`});
        return {evidenceId: evidenceId ?? ''};
      }
      return {...unit};
    });
    return {...claim, evidence};
  });
  if (findings.length) throw new GoalEvidenceReferenceError('verifier referenced unknown evidence units', findings);
  return {...proposal, claims};
}

function methodMatches(run, claim) {
  return claim.evidence.every(evidence => {
    if (evidence.method === 'artifact_read') return evidence.sourceUrl?.startsWith('artifact://') && run.bundle.artifacts.some(item => `artifact://${item.id}` === evidence.sourceUrl);
    if (evidence.method === 'message_quote') return evidence.sourceUrl?.startsWith('message://') && run.bundle.messages.some(item => `message://${item.id}` === evidence.sourceUrl);
    if (evidence.method === 'tool_receipt') return evidence.sourceUrl?.startsWith('tool-receipt://') && run.bundle.toolReceipts.some(item => `tool-receipt://${item.eventId}` === evidence.sourceUrl);
    return false;
  });
}
function successfulTool(run, claim) { return claim.evidence.some(e => e.method === 'tool_receipt' && run.bundle.toolReceipts.some(r => `tool-receipt://${r.eventId}` === e.sourceUrl && !r.isError)); }
function artifactEvidence(claim) { return claim.evidence.some(e => e.method === 'artifact_read'); }
function claimAccepted(run, claim) {
  if (claim.verdict !== 'supported' || claim.evidence.length === 0 || !methodMatches(run, claim)) return false;
  if (claim.category === 'external_fact') return claim.evidence.some(e => e.method === 'retrieval');
  if (claim.category === 'tool_result') return successfulTool(run, claim);
  if (claim.category === 'artifact') return artifactEvidence(claim);
  if (claim.category === 'objective') return claim.evidence.some(e => ['artifact_read', 'tool_receipt'].includes(e.method));
  return false;
}

export function evaluateVerificationResult(run, result) {
  const findings = [];
  const add = (code, message, extra = {}) => findings.push({code, message, ...extra});
  const claims = new Map((result.claims ?? []).map(claim => [claim.id, claim]));
  const accepted = new Set((result.claims ?? []).filter(claim => claimAccepted(run, claim)).map(claim => claim.id));
  if (result.decision === 'pass') {
    for (const [field, label] of [['internalConsistency', '内部一致性'], ['methodologicalValidity', '方法学有效性'], ['sourceRelevance', '来源相关性'], ['unsupportedPrecision', '数值精度支持']]) {
      if (result.qualityReview?.[field]?.status !== 'pass') add('QUALITY_REVIEW_FAILED', `${label}检查未通过`, {field: `qualityReview.${field}`});
    }
    if ((result.qualityReview?.issues ?? []).length) add('QUALITY_REVIEW_FAILED', `质量审查仍有未解决问题：${result.qualityReview.issues.join('；')}`, {field: 'qualityReview.issues'});
  }
  for (const artifact of run.bundle.artifacts ?? []) if (artifact.kind === 'output' && artifact.qualityFlags?.includes('embedded_verifier_instructions')) add('ARTIFACT_CONTAINS_VERIFIER_INSTRUCTIONS', `输出文件 ${artifact.name} 包含面向 verifier 的协议指令。`, {artifactId: artifact.id});
  for (const claim of result.claims ?? []) {
    if (!methodMatches(run, claim)) add('EVIDENCE_METHOD_MISMATCH', `事实 ${claim.id} 的证据来源与方法不一致。`, {claimId: claim.id});
    if (claim.importance !== 'minor' && claim.verdict !== 'supported') add('UNSUPPORTED_IMPORTANT_CLAIM', `关键事实 ${claim.id} 的判定为 ${claim.verdict}。`, {claimId: claim.id});
    if (claim.verdict !== 'supported') continue;
    if (claim.category === 'external_fact') add('EXTERNAL_FACT_WITHOUT_RETRIEVAL', `外部事实 ${claim.id} 没有受控检索证据。`, {claimId: claim.id});
    if (claim.category === 'tool_result' && !successfulTool(run, claim)) add('TOOL_RESULT_WITHOUT_SUCCESSFUL_RECEIPT', `工具结果 ${claim.id} 没有关联成功回执。`, {claimId: claim.id});
    if (claim.category === 'artifact' && !artifactEvidence(claim)) add('ARTIFACT_CLAIM_WITHOUT_IMMUTABLE_CHECK', `产物事实 ${claim.id} 没有冻结产物证据。`, {claimId: claim.id});
  }
  const criteria = new Map((run.bundle.acceptanceCriteria ?? []).map(item => [item.id, item]));
  const seen = new Set();
  for (const requirement of result.requirements ?? []) {
    if (!criteria.has(requirement.criterionId)) { add('UNKNOWN_OBJECTIVE_CRITERION', `引用了未知验收项 ${requirement.criterionId}。`, {criterionId: requirement.criterionId}); continue; }
    if (seen.has(requirement.criterionId)) add('DUPLICATE_OBJECTIVE_CRITERION', `验收项 ${requirement.criterionId} 被重复提交。`, {criterionId: requirement.criterionId});
    seen.add(requirement.criterionId);
    if (requirement.status !== 'satisfied') add('UNSATISFIED_REQUIREMENT', `验收项 ${requirement.criterionId} 未满足。`, {criterionId: requirement.criterionId});
    const linked = (requirement.claimIds ?? []).map(id => claims.get(id)).filter(Boolean);
    if (!linked.length || (requirement.claimIds ?? []).some(id => !accepted.has(id))) add('REQUIREMENT_WITHOUT_SUPPORTED_CLAIM', `验收项 ${requirement.criterionId} 没有完整映射到合格事实。`, {criterionId: requirement.criterionId});
    for (const evidenceClass of criteria.get(requirement.criterionId).requiredEvidence ?? []) {
      const matched = linked.some(claim => accepted.has(claim.id) && (evidenceClass === 'external' ? claim.category === 'external_fact' : evidenceClass === 'execution' ? claim.category === 'tool_result' : evidenceClass === 'artifact' ? claim.category === 'artifact' : true));
      if (!matched) add('REQUIREMENT_EVIDENCE_CLASS_MISMATCH', `验收项 ${requirement.criterionId} 需要 ${evidenceClass} 类证据。`, {criterionId: requirement.criterionId, evidenceClass});
    }
    const min = criteria.get(requirement.criterionId).minimumExternalSources;
    if (min) add('EXTERNAL_SOURCE_COVERAGE_INSUFFICIENT', `验收项 ${requirement.criterionId} 要求 ${min} 个外部来源，但当前没有受控检索。`, {criterionId: requirement.criterionId, expectedCount: min, observedCount: 0});
  }
  for (const criterion of criteria.values()) if (!seen.has(criterion.id)) add('MISSING_OBJECTIVE_CRITERION', `未验收目标条目 ${criterion.id}：${criterion.text}`, {criterionId: criterion.id});
  const unique = [...new Map(findings.map(finding => [`${finding.code}\0${finding.criterionId ?? ''}\0${finding.claimId ?? ''}\0${finding.field ?? ''}`, finding])).values()];
  const decision = result.decision === 'pass' && unique.length === 0 ? 'pass' : 'fail';
  return {proposedDecision: result.decision, decision, findings: unique, feedback: decision === 'pass' ? '' : [text(result.feedback) ?? '', ...unique.map(f => f.message)].filter(Boolean).join(' ').slice(0, 8000)};
}
