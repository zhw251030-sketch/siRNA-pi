import {randomUUID} from 'node:crypto';
import {resolveVerificationProposal, evaluateVerificationResult} from './goal-verification-policy.mjs';

const MAX_ATTEMPTS = 3;

function safeError(error) { return error instanceof Error ? error.message : String(error); }

export class GoalVerificationCoordinator {
  #running = new Set();
  #timer;
  #tickRunning = false;
  constructor(goals, store, bundles, verifier, options = {}) {
    if (!goals || !store || !bundles || !verifier || typeof verifier.verify !== 'function') throw new TypeError('GoalVerificationCoordinator requires goals, store, bundles and verifier');
    this.goals = goals; this.store = store; this.bundles = bundles; this.verifier = verifier;
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
      let lastError;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        this.store.startAttempt(id, attempt);
        try {
          const proposal = await this.verifier.verify(active, accessToken);
          const resolved = resolveVerificationProposal(active.bundle, proposal);
          const evaluation = evaluateVerificationResult(active, resolved);
          this.store.finishAttempt({verificationId: id, attemptNumber: attempt, status: 'accepted', proposal: resolved});
          const completed = this.store.finish(id, evaluation);
          if (completed.trigger === 'checkpoint') this.goals.continueAfterCheckpoint(completed.taskId, completed.goalRevision, completed.status === 'failed' ? completed.evaluation.feedback : undefined);
          else if (completed.status === 'passed') this.goals.completeVerified(completed.taskId, completed.goalRevision);
          else this.goals.continueAfterVerification(completed.taskId, completed.goalRevision, completed.evaluation.feedback || '独立验证没有确认 Goal 已完成。');
          this.onTerminal?.(completed);
          return completed;
        } catch (error) {
          lastError = error;
          this.store.finishAttempt({verificationId: id, attemptNumber: attempt, status: 'error', diagnostics: safeError(error)});
          if (attempt === MAX_ATTEMPTS) throw error;
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
