const MAX_CONTEXT_CHARS = 16_000;
const MAX_EVIDENCE_UNITS = 5;
import {modelEvidenceUnit} from './goal-verification-evidence-resolver.mjs';

function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is required`);
  return value;
}

function sliceText(value, offset, maxChars) {
  const start = boundedInteger(offset, 0, 0, value.length, 'offset');
  const limit = boundedInteger(maxChars, MAX_CONTEXT_CHARS, 1, MAX_CONTEXT_CHARS, 'maxChars');
  const end = Math.min(value.length, start + limit);
  return {offset: start, content: value.slice(start, end), truncated: end < value.length, nextOffset: end};
}

function redactedBundle(bundle) {
  return {
    ...bundle,
    messages: (bundle.messages ?? []).map(({content, ...message}) => ({
      ...message,
      contentCharacters: typeof content === 'string' ? content.length : 0,
    })),
    toolReceipts: (bundle.toolReceipts ?? []).map(({resultPreview, ...receipt}) => ({
      ...receipt,
      hasResultPreview: resultPreview !== undefined,
    })),
  };
}

function messageEvidence(message, content, offset, end) {
  return {
    evidenceId: `message:${message.id}:${offset}-${end}`,
    method: 'message_quote',
    sourceUrl: `message://${message.id}`,
    title: `Task message ${message.sequence}`,
    excerpt: content,
    contentCharacters: content.length,
  };
}

function artifactEvidence(artifact, content, offset, end) {
  return {
    evidenceId: `artifact:${artifact.id}:${offset}-${end}`,
    method: 'artifact_read',
    sourceUrl: `artifact://${artifact.id}`,
    title: artifact.name,
    excerpt: content,
    contentCharacters: content.length,
    contentSha256: artifact.sha256,
  };
}

function summarize(run) {
  const bundle = run?.bundle;
  return {
    id: run.id,
    taskId: run.taskId,
    goalId: run.goalId,
    goalRevision: run.goalRevision,
    trigger: run.trigger,
    status: run.status,
    ...(bundle?.bundleSha256 ? {bundleSha256: bundle.bundleSha256} : {}),
    artifactCount: bundle?.artifacts?.length ?? 0,
    toolReceiptCount: bundle?.toolReceipts?.length ?? 0,
    ...(run.error ? {error: run.error} : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.completedAt ? {completedAt: run.completedAt} : {}),
  };
}

export function createGoalVerificationAccess({store, bundles, evidence} = {}) {
  if (!store || typeof store.authorize !== 'function') throw new TypeError('Goal verification access requires a token-aware store');
  if (!bundles || typeof bundles.readArtifact !== 'function') throw new TypeError('Goal verification access requires a bundle builder');
  if (!evidence || typeof evidence.checkArtifact !== 'function') throw new TypeError('Goal verification access requires evidence access');
  const resolver = evidence.resolver;

  const authorize = input => {
    const verificationId = requireString(input?.verificationId, 'verificationId');
    const accessToken = requireString(input?.accessToken, 'accessToken');
    return store.authorize(verificationId, accessToken);
  };

  const service = {
    bundle(input) {
      const run = authorize(input);
      const bundle = redactedBundle(run.bundle);
      const evidenceUnitCount = resolver ? resolver.prepareBundle(run).length : (bundle.messages?.length ?? 0)
        + (bundle.artifacts?.length ?? 0)
        + (bundle.toolReceipts?.length ?? 0);
      return {
        // Keep the protocol fields at the top level like the reference
        // Access Service. The nested copy is retained for this learning
        // repository's first direct callers and can be removed at a later
        // compatibility boundary.
        ...bundle,
        verificationId: run.id,
        taskId: run.taskId,
        goalId: run.goalId,
        goalRevision: run.goalRevision,
        trigger: run.trigger,
        status: run.status,
        evidenceUnitCount,
        bundle,
        contentAccess: {
          messages: 'Use message with messageId, offset and maxChars.',
          artifacts: 'Use artifact with artifactId, offset and maxChars.',
          evidence: 'Use evidence with offset and limit.',
          checks: 'Use check with artifactId and deterministic operation.',
        },
      };
    },

    message(input) {
      const run = authorize(input);
      const messageId = requireString(input?.messageId, 'messageId');
      const message = (run.bundle.messages ?? []).find(item => item.id === messageId);
      if (!message) throw new Error('message does not belong to this verification bundle');
      const window = sliceText(message.content ?? '', input?.offset, input?.maxChars);
      const unit = resolver
        ? resolver.materializeMessage(run, message.id, window.content, `chars:${window.offset}-${window.nextOffset}`)
        : messageEvidence(message, window.content, window.offset, window.nextOffset);
      return {
        message: {
          id: message.id, role: message.role, sequence: message.sequence, status: message.status,
          createdAt: message.createdAt, sha256: message.sha256, contentCharacters: message.content.length,
        },
        ...window,
        evidenceUnits: [resolver ? modelEvidenceUnit(unit) : unit],
      };
    },

    async artifact(input) {
      const run = authorize(input);
      const artifactId = requireString(input?.artifactId, 'artifactId');
      const artifact = (run.bundle.artifacts ?? []).find(item => item.id === artifactId);
      if (!artifact) throw new Error('artifact does not belong to this verification bundle');
      const data = await bundles.readArtifact(run.bundle, artifactId);
      if (artifact.encoding === 'binary') return {artifact, encoding: 'binary', metadataOnly: true};
      let content;
      try { content = new TextDecoder('utf-8', {fatal: true}).decode(data); }
      catch { return {artifact, encoding: 'binary', metadataOnly: true}; }
      const window = sliceText(content, input?.offset, input?.maxChars);
      const unit = resolver
        ? resolver.materializeArtifact(run, artifact.id, window.content, `chars:${window.offset}-${window.nextOffset}`)
        : artifactEvidence(artifact, window.content, window.offset, window.nextOffset);
      return {
        artifact,
        encoding: 'utf8',
        ...window,
        evidenceUnits: [resolver ? modelEvidenceUnit(unit) : unit],
      };
    },

    evidence(input) {
      const run = authorize(input);
      if (resolver) resolver.prepareBundle(run);
      const persisted = resolver ? resolver.list(run.id).map(modelEvidenceUnit) : [];
      const retrievals = typeof store.listRetrievals === 'function' ? store.listRetrievals(run.id) : [];
      const checks = typeof store.listChecks === 'function' ? store.listChecks(run.id) : [];
      const units = resolver ? persisted : [
        ...(run.bundle.messages ?? []).map(message => ({evidenceId: `message:${message.id}`, method: 'message_quote', sourceUrl: `message://${message.id}`, contentCharacters: message.content.length})),
        ...(run.bundle.artifacts ?? []).map(artifact => ({evidenceId: `artifact:${artifact.id}`, method: 'artifact_read', sourceUrl: `artifact://${artifact.id}`, title: artifact.name, contentSha256: artifact.sha256})),
        ...(run.bundle.toolReceipts ?? []).map(receipt => ({evidenceId: `tool:${receipt.eventId}`, method: 'tool_receipt', toolName: receipt.toolName, resultSha256: receipt.resultSha256})),
        ...retrievals.map(item => ({id: item.id, evidenceId: `retrieval:${item.id}`, method: 'controlled_retrieval', kind: item.kind, sourceUrl: item.sourceUrl, contentSha256: item.contentSha256})),
        ...checks.map(item => ({id: item.id, evidenceId: `check:${item.id}`, method: 'deterministic_check', artifactId: item.artifactId, operation: item.operation, resultSha256: item.resultSha256})),
      ];
      const offset = boundedInteger(input?.offset, 0, 0, units.length, 'offset');
      const limit = boundedInteger(input?.limit, MAX_EVIDENCE_UNITS, 1, MAX_EVIDENCE_UNITS, 'limit');
      const evidenceUnits = units.slice(offset, offset + limit);
      return {offset, limit, total: units.length, evidenceUnits, truncated: offset + evidenceUnits.length < units.length, nextOffset: offset + evidenceUnits.length};
    },

    async check(input) {
      authorize(input);
      const artifactId = requireString(input?.artifactId, 'artifactId');
      const operation = requireString(input?.operation, 'operation');
      return evidence.checkArtifact({
        verificationId: input.verificationId,
        artifactId,
        operation,
        ...(input.expected === undefined ? {} : {expected: input.expected}),
      });
    },

    attempt(input) {
      const run = authorize(input);
      const attemptNumber = boundedInteger(input?.attemptNumber, 1, 1, 3, 'attemptNumber');
      const attempt = (typeof store.listAttempts === 'function' ? store.listAttempts(run.id) : []).find(item => item.attemptNumber === attemptNumber);
      if (!attempt) throw new Error('verification attempt not found');
      const field = input?.field === undefined ? 'diagnostics' : requireString(input.field, 'field');
      if (!['diagnostics', 'proposal', 'prompt'].includes(field)) throw new Error('attempt field is invalid');
      let content = '';
      if (field === 'diagnostics') content = attempt.diagnostics ?? '';
      else if (field === 'prompt') content = attempt.prompt ?? '';
      else content = attempt.rawProposal === undefined ? (attempt.proposal === undefined ? '' : JSON.stringify(attempt.proposal)) : JSON.stringify(attempt.rawProposal);
      const window = sliceText(content, input?.offset, input?.maxChars);
      return {attempt: {
        verificationId: attempt.verificationId, attemptNumber: attempt.attemptNumber, status: attempt.status,
        ...(attempt.verifierSessionId ? {verifierSessionId: attempt.verifierSessionId} : {}),
        ...(attempt.verifierRunId ? {verifierRunId: attempt.verifierRunId} : {}),
        createdAt: attempt.createdAt, ...(attempt.startedAt ? {startedAt: attempt.startedAt} : {}), ...(attempt.completedAt ? {completedAt: attempt.completedAt} : {}),
      }, field, ...window};
    },

    async search(input, signal) {
      authorize(input);
      if (typeof evidence.search !== 'function') throw new Error('controlled search is not available');
      return evidence.search({
        verificationId: input.verificationId,
        provider: input.provider,
        query: input.query,
        ...(input.limit === undefined ? {} : {limit: input.limit}),
      }, signal);
    },

    async fetchSource(input, signal) {
      authorize(input);
      if (typeof evidence.fetchSource !== 'function') throw new Error('controlled fetch is not available');
      return evidence.fetchSource({verificationId: input.verificationId, url: input.url}, signal);
    },

    handle(kind, input, signal) {
      if (!['bundle', 'message', 'artifact', 'evidence', 'check', 'attempt', 'search', 'fetch'].includes(kind)) throw new Error('verification access operation is not available');
      const operation = kind === 'fetch' ? 'fetchSource' : kind;
      return service[operation](input, signal);
    },

    summary: summarize,
    limits: {maxContextChars: MAX_CONTEXT_CHARS, maxEvidenceUnits: MAX_EVIDENCE_UNITS},
  };
  // Keep the names used by the reference Access Service available while the
  // learning API uses the shorter HTTP operation names.
  service.evidenceInventory = service.evidence;
  service.checkArtifact = service.check;
  return service;
}

export {MAX_CONTEXT_CHARS as GOAL_VERIFICATION_MAX_CONTEXT_CHARS};
