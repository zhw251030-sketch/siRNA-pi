import {randomUUID} from 'node:crypto';
import {resolveVerificationProposal, evaluateVerificationResult, GoalEvidenceReferenceError} from './goal-verification-policy.mjs';
import {GoalVerificationEvidenceResolver} from './goal-verification-evidence-resolver.mjs';
import {GoalVerifierResultProtocolError} from './goal-verification-agent-compose.mjs';

const MAX_ATTEMPTS = 3;

function safeError(error) { return error instanceof Error ? error.message : String(error); }
function repairReference(verificationId, attemptNumber, code, failedStage) {
  return JSON.stringify({protocolVersion: 'sirna-goal-verification-repair-reference/v1', code, failedStage, failedAttempt: attemptNumber,
    correctionContext: {tool: 'read_verification_attempt', arguments: {verificationId, attemptNumber, field: 'diagnostics', offset: 0, maxChars: 16_000}, pagination: 'Repeat with nextOffset while truncated is true; read field=proposal only when diagnostics requires the prior complete proposal.'}}, null, 2);
}
function repairDiagnostics(store, verificationId, attemptNumber, error, response, code, failedStage, rawOutput) {
  const raw = response?.result ?? response;
  const findings = error?.findings ?? [{code: code === 'EVIDENCE_REFERENCE_INVALID' ? 'EVIDENCE_REFERENCE_INVALID' : 'RESULT_SCHEMA_INVALID', field: '$', message: safeError(error)}];
  const evidence = store.listEvidenceUnits(verificationId).map(unit => ({evidenceId: unit.id, method: unit.method, ...(unit.sourceId ? {sourceId: unit.sourceId} : {}), ...(unit.title ? {title: unit.title} : {})}));
  return JSON.stringify({code, failedStage, failedAttempt: attemptNumber, error: safeError(error), findings, ...(rawOutput ? {previousRawOutput: rawOutput} : {}), previousProposal: raw ?? null, availableEvidence: evidence.slice(0, 200), availableEvidenceTotal: evidence.length,
    nextAction: code === 'EVIDENCE_REFERENCE_INVALID' ? 'Replace unknown evidenceId with a backend ID from availableEvidence or mark the claim insufficient_evidence; return a complete replacement review.' : 'Return one complete replacement review object that satisfies the protocol schema.'}, null, 2);
}

export class GoalVerificationCoordinator {
  #running = new Set();
  #timer;
  #tickRunning = false;
  constructor(goals, store, bundles, verifier, options = {}) {
    if (!goals || !store || !bundles || !verifier || typeof verifier.verify !== 'function') throw new TypeError('GoalVerificationCoordinator requires goals, store, bundles and verifier');
    this.goals = goals; this.store = store; this.bundles = bundles; this.verifier = verifier;
    this.evidenceResolver = options.evidenceResolver ?? new GoalVerificationEvidenceResolver(store, bundles);
    this.intervalMs = options.intervalMs ?? 1000; this.autoRun = options.autoRun ?? true; this.onTerminal = options.onTerminal;
  }
  start() { if (this.#timer) return; void this.runOnce(); this.#timer = setInterval(() => void this.runOnce(), this.intervalMs); this.#timer.unref?.(); }
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
  async request(goal, trigger = 'completion_request') {
    if (trigger === 'completion_request' && goal?.status !== 'verifying') throw new Error('Goal completion verification requires verifying state');
    const existing = this.store.getForGoalRevision(goal.goalId, goal.revision, trigger);
    if (existing) { if (this.autoRun) setImmediate(() => void this.runVerification(existing.id)); return existing; }
    const created = this.store.createRequest(randomUUID(), goal, trigger);
    if (this.autoRun) setImmediate(() => void this.runVerification(created.id));
    return created;
  }
  async runOnce() {
    if (this.#tickRunning) return;
    this.#tickRunning = true;
    try { await Promise.all(this.store.listPending().map(run => this.runVerification(run.id))); }
    finally { this.#tickRunning = false; }
  }
  async runVerification(id) {
    if (this.#running.has(id)) return;
    this.#running.add(id);
    let active;
    try {
      let pending = this.store.get(id);
      if (!pending || !['waiting', 'pending', 'running'].includes(pending.status)) return;
      let goal = this.goals.get(pending.taskId);
      if (!goal || goal.goalId !== pending.goalId || goal.revision !== pending.goalRevision || goal.status !== 'verifying') throw new Error('verification request is stale because the Goal changed');
      if (pending.status === 'waiting') {
        const bundle = await this.bundles.build(id, goal, pending.trigger);
        pending = this.store.attachBundle(id, bundle);
        goal = this.goals.get(pending.taskId);
        if (!goal || goal.goalId !== pending.goalId || goal.revision !== pending.goalRevision || goal.status !== 'verifying') throw new Error('Goal changed while verification bundle was being frozen');
      }
      // The verifier receives a one-run capability indirectly through the
      // store. The plaintext token is never persisted; only its hash remains
      // while this verification is running.
      const accessToken = this.store.issueAccessToken();
      active = this.store.begin(id, accessToken);
      this.evidenceResolver.prepareBundle(active);
      // The deterministic learning verifier receives the same backend-generated
      // inventory that a real verifier would obtain through the access service.
      // Real Agent Compose runs still use token-scoped access methods.
      active.evidenceUnits = this.evidenceResolver.list(active.id);
      // The local deterministic verifier has no MCP session. Give it a narrow
      // internal adapter that performs the same immutable artifact read as the
      // verifier-only `read_verification_artifact` path. Do not pre-register
      // artifact metadata: only an actual read may materialize an artifact unit.
      Object.defineProperty(active, 'readArtifactEvidence', {
        enumerable: false,
        value: artifactId => this.evidenceResolver.materializeWholeArtifact(active, artifactId),
      });
      let retryFeedback;
      let lastError;
      const existingAttempts = this.store.listAttempts(id);
      for (const interrupted of existingAttempts.filter(attempt => attempt.status === 'running')) {
        this.store.finishAttempt({verificationId: id, attemptNumber: interrupted.attemptNumber, status: 'error', diagnostics: 'Verifier process ended before this attempt reached a terminal state.'});
      }
      for (let attempt = existingAttempts.length + 1; attempt <= MAX_ATTEMPTS; attempt++) {
        this.store.startAttempt(id, attempt);
        let response;
        let verifierReturned = false;
        let sessionId;
        let runId;
        try {
          response = await this.verifier.verify(active, accessToken, undefined,
            (startedSessionId, startedRunId) => {
              sessionId = startedSessionId; runId = startedRunId;
              this.store.setAttemptIdentity(id, attempt, startedSessionId, startedRunId);
            },
            retryFeedback,
            prompt => this.store.setAttemptPrompt(id, attempt, typeof prompt === 'string' ? prompt.replaceAll(accessToken, '[REDACTED_SHORT_LIVED_ACCESS_TOKEN]') : String(prompt)),
          );
          verifierReturned = true;
          const wrapped = response && typeof response === 'object' && 'result' in response && response.result && typeof response.result === 'object';
          const proposal = wrapped ? response.result : response;
          sessionId = wrapped && typeof response.sessionId === 'string' ? response.sessionId : sessionId;
          runId = wrapped && typeof response.runId === 'string' ? response.runId : runId;
          if (sessionId) this.store.setAttemptIdentity(id, attempt, sessionId, runId);
          const resolved = resolveVerificationProposal(active.bundle, proposal, this.evidenceResolver.list(active.id));
          const evaluation = evaluateVerificationResult(active, resolved, {
            getCheck: checkId => this.store.getCheck(checkId, active.id),
          });
          this.store.finishAttempt({verificationId: id, attemptNumber: attempt, status: 'accepted', proposal: resolved, rawProposal: proposal, sessionId, runId});
          const completed = this.store.finish(id, evaluation);
          if (completed.trigger === 'checkpoint') this.goals.continueAfterCheckpoint(completed.taskId, completed.goalRevision, completed.status === 'failed' ? completed.evaluation.feedback : undefined);
          else if (completed.status === 'passed') this.goals.completeVerified(completed.taskId, completed.goalRevision);
          else this.goals.continueAfterVerification(completed.taskId, completed.goalRevision, completed.evaluation.feedback || '独立验证没有确认 Goal 已完成。');
          this.onTerminal?.(completed);
          return completed;
        } catch (error) {
          lastError = error;
          const protocolFailure = error instanceof GoalVerifierResultProtocolError;
          if (!verifierReturned && !protocolFailure) {
            this.store.finishAttempt({verificationId: id, attemptNumber: attempt, status: 'error', diagnostics: safeError(error), sessionId, runId});
            throw error;
          }
          const evidenceFailure = error instanceof GoalEvidenceReferenceError;
          const code = evidenceFailure ? 'EVIDENCE_REFERENCE_INVALID' : 'VERIFIER_OUTPUT_INVALID';
          const failedStage = evidenceFailure ? 'resolve_evidence' : 'review';
          const rawOutput = protocolFailure ? error.rawOutput.replaceAll(accessToken, '[REDACTED_SHORT_LIVED_ACCESS_TOKEN]') : undefined;
          const diagnostics = repairDiagnostics(this.store, id, attempt, error, response, code, failedStage, rawOutput);
          this.store.finishAttempt({verificationId: id, attemptNumber: attempt, status: attempt === MAX_ATTEMPTS ? 'error' : 'protocol_failed', rawProposal: response?.result ?? response, diagnostics, sessionId, runId});
          if (attempt === MAX_ATTEMPTS) throw error;
          retryFeedback = repairReference(id, attempt, code, failedStage);
        }
      }
      throw lastError ?? new Error('verification failed without a result');
    } catch (error) {
      const failed = this.store.fail(id, safeError(error));
      if (!failed) return;
      const current = this.goals.get(failed.taskId);
      if (current?.status === 'verifying' && current.revision === failed.goalRevision) this.goals.pauseAfterVerification(failed.taskId, failed.goalRevision, safeError(error));
      return failed;
    } finally { this.#running.delete(id); }
  }
}
