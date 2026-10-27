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

export class GoalVerificationProtocolError extends Error {
  constructor(message, findings = []) { super(message); this.name = 'GoalVerificationProtocolError'; this.findings = findings; }
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; }
function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }

const claimCategories = new Set(['objective', 'artifact', 'tool_result', 'external_fact']);
const claimImportance = new Set(['critical', 'major', 'minor']);
const claimVerdicts = new Set(['supported', 'contradicted', 'insufficient_evidence', 'unverifiable', 'irrelevant']);
const requirementStatuses = new Set(['satisfied', 'partial', 'missing', 'unsatisfied']);

/**
 * Check the field-level shape before resolving evidence.  This is deliberately
 * separate from the evidence policy: a malformed review must be repaired by
 * the verifier, while a well-formed review that cites an unknown ID belongs to
 * the evidence-resolution retry path.
 */
export function validateVerificationProposal(proposal) {
  const findings = [];
  if (!record(proposal) || proposal.protocolVersion !== GOAL_VERIFICATION_REVIEW_PROTOCOL) {
    findings.push({code: 'RESULT_SCHEMA_INVALID', field: 'protocolVersion', message: 'protocolVersion must match the Goal verification review protocol'});
  }
  if (!record(proposal) || !['pass', 'fail'].includes(proposal.decision)) {
    findings.push({code: 'RESULT_SCHEMA_INVALID', field: 'decision', message: 'decision must be pass or fail'});
  }
  if (!Array.isArray(proposal?.claims)) findings.push({code: 'RESULT_SCHEMA_INVALID', field: 'claims', message: 'claims must be an array'});
  if (!Array.isArray(proposal?.requirements)) findings.push({code: 'RESULT_SCHEMA_INVALID', field: 'requirements', message: 'requirements must be an array'});
  for (const [index, claim] of (proposal?.claims ?? []).entries()) {
    const field = `claims[${index}]`;
    if (!record(claim)) { findings.push({code: 'RESULT_SCHEMA_INVALID', field, message: 'claim must be an object'}); continue; }
    if (!text(claim.id)) findings.push({code: 'RESULT_SCHEMA_INVALID', field: `${field}.id`, message: 'claim id must be non-empty'});
    if (!claimCategories.has(claim.category)) findings.push({code: 'RESULT_SCHEMA_INVALID', field: `${field}.category`, message: `category must be one of ${[...claimCategories].join(', ')}`});
    if (!claimImportance.has(claim.importance)) findings.push({code: 'RESULT_SCHEMA_INVALID', field: `${field}.importance`, message: `importance must be one of ${[...claimImportance].join(', ')}`});
    if (!claimVerdicts.has(claim.verdict)) findings.push({code: 'RESULT_SCHEMA_INVALID', field: `${field}.verdict`, message: `verdict must be one of ${[...claimVerdicts].join(', ')}`});
    if (!Array.isArray(claim.evidence)) { findings.push({code: 'RESULT_SCHEMA_INVALID', field: `${field}.evidence`, message: 'evidence must be an array of objects with evidenceId'}); continue; }
    for (const [evidenceIndex, reference] of claim.evidence.entries()) {
      if (!record(reference) || !text(reference.evidenceId)) findings.push({code: 'RESULT_SCHEMA_INVALID', field: `${field}.evidence[${evidenceIndex}]`, message: 'each evidence item must be {evidenceId: string}; do not use a bare string'});
    }
  }
  for (const [index, requirement] of (proposal?.requirements ?? []).entries()) {
    const field = `requirements[${index}]`;
    if (!record(requirement)) { findings.push({code: 'RESULT_SCHEMA_INVALID', field, message: 'requirement must be an object'}); continue; }
    if (!text(requirement.criterionId)) findings.push({code: 'RESULT_SCHEMA_INVALID', field: `${field}.criterionId`, message: 'criterionId must be copied from acceptanceCriteria[].id'});
    if (!requirementStatuses.has(requirement.status)) findings.push({code: 'RESULT_SCHEMA_INVALID', field: `${field}.status`, message: 'status must be satisfied, partial, missing, or unsatisfied'});
    if (!Array.isArray(requirement.claimIds) || requirement.claimIds.some(id => !text(id))) findings.push({code: 'RESULT_SCHEMA_INVALID', field: `${field}.claimIds`, message: 'claimIds must be an array of non-empty claim IDs'});
  }
  if (findings.length) throw new GoalVerificationProtocolError('verifier proposal does not match the field-level protocol', findings);
  return proposal;
}

export function verificationEvidenceUnits(bundle, persisted = []) {
  if (Array.isArray(persisted) && persisted.length) return persisted.map(unit => ({
    evidenceId: unit.id, method: unit.method, ...(unit.retrievalId ? {retrievalId: unit.retrievalId} : {}),
    sourceUrl: unit.sourceUrl, ...(unit.sourceId ? {sourceId: unit.sourceId} : {}), ...(unit.title ? {title: unit.title} : {}),
    excerpt: unit.excerpt, fetchedAt: unit.fetchedAt, contentSha256: unit.contentSha256, ...(unit.locator ? {locator: unit.locator} : {}),
  }));
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

export function resolveVerificationProposal(bundle, proposal, persistedEvidenceUnits = []) {
  validateVerificationProposal(proposal);
  const units = new Map(verificationEvidenceUnits(bundle, persistedEvidenceUnits).map(unit => [unit.evidenceId, unit]));
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
    if (evidence.method === 'retrieval') return Boolean(evidence.retrievalId && evidence.sourceUrl?.startsWith('https://'));
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
    if (min) {
      const sourceIds = new Set();
      let sourceSpecificClaims = 0;
      for (const claim of linked) {
        if (!accepted.has(claim.id) || claim.category !== 'external_fact') continue;
        const claimSources = new Set((claim.evidence ?? []).filter(evidence => evidence.method === 'retrieval' && evidence.sourceId).map(evidence => evidence.sourceId));
        if (claimSources.size) { sourceSpecificClaims++; for (const source of claimSources) sourceIds.add(source); }
      }
      const observedCount = Math.min(sourceIds.size, sourceSpecificClaims);
      if (observedCount < min) add('EXTERNAL_SOURCE_COVERAGE_INSUFFICIENT', `验收项 ${requirement.criterionId} 要求至少 ${min} 个独立外部来源，当前可计入 ${observedCount} 个。`, {criterionId: requirement.criterionId, expectedCount: min, observedCount});
    }
  }
  for (const criterion of criteria.values()) if (!seen.has(criterion.id)) add('MISSING_OBJECTIVE_CRITERION', `未验收目标条目 ${criterion.id}：${criterion.text}`, {criterionId: criterion.id});
  const unique = [...new Map(findings.map(finding => [`${finding.code}\0${finding.criterionId ?? ''}\0${finding.claimId ?? ''}\0${finding.field ?? ''}`, finding])).values()];
  const decision = result.decision === 'pass' && unique.length === 0 ? 'pass' : 'fail';
  return {proposedDecision: result.decision, decision, findings: unique, feedback: decision === 'pass' ? '' : [text(result.feedback) ?? '', ...unique.map(f => f.message)].filter(Boolean).join(' ').slice(0, 8000)};
}
