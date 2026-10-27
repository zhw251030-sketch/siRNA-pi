import {formatGoalPlan} from './goal-plan.mjs';

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_LEASE_DURATION_MS = 30 * 60 * 1000;
const DEFAULT_FAILURE_BACKOFF_MS = 5000;

export function goalContinuationPrompt(lease) {
  const feedback = lease.goal.latestVerificationFeedback ? [
    '',
    '上一次完成申请或阶段检查发现了可检查缺口。只修复以下缺口；不要重复已经完成的工作：',
    lease.goal.latestVerificationFeedback,
  ] : [];
  return [
    `继续处理当前 Goal：${lease.goal.objective}`,
    '',
    `这是第 ${lease.automaticTurnNumber}/${lease.goal.maxAutomaticTurns} 个自动回合。先检查当前证据：`,
    '当前执行计划：',
    formatGoalPlan(lease.goal.plan),
    '- 先执行一个待完成的工作项，不要只描述计划。',
    '- 一个工作项真正完成后，调用 update_goal status=progress，并提交 completedItemIds。',
    '- 只有所有必需工作项完成后，才调用 update_goal status=complete。完成申请会经过后端完成门控。',
    '- 确实无法继续则调用 update_goal，将状态设为 blocked 并说明原因。',
    '- 你是执行 Agent；当前回合只使用已注册的 sirna-tools。独立 verifier 才能使用受控学术检索工具。',
    '- 不要调用 search_verification_sources、fetch_verification_source、verify_controlled_retrieval_record 或其他 verifier-only 工具；不要伪造 retrievalId 或 evidenceId。',
    '- 如果外部事实是任务要求的一部分，把来源线索（例如 DOI、PMID、来源 URL、标题和对应结论）写入可检查的输出产物或报告，并说明每条线索支持哪条结论；独立 verifier 会重新检索并绑定后端证据。',
    ...feedback,
  ].join('\n');
}

export class GoalCoordinator {
  #timer;
  #runningTasks = new Set();
  #retryAfter = new Map();
  #tickRunning = false;
  constructor(store, port, options = {}) {
    this.store = store;
    this.port = port;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.failureBackoffMs = options.failureBackoffMs ?? DEFAULT_FAILURE_BACKOFF_MS;
  }
  start() {
    if (this.#timer) return;
    this.store.expireLeasesForRecovery();
    void this.runOnce();
    this.#timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.#timer.unref?.();
  }
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
  wake(taskId, resetBackoff = false) {
    if (resetBackoff) this.#retryAfter.delete(taskId);
    setImmediate(() => void this.runTask(taskId));
  }
  async runOnce() {
    if (this.#tickRunning) return;
    this.#tickRunning = true;
    try {
      await Promise.all(this.store.listActive().map(goal => this.runTask(goal.taskId)));
    } finally {
      this.#tickRunning = false;
    }
  }
  async runTask(taskId) {
    if (this.#runningTasks.has(taskId)) return;
    this.#runningTasks.add(taskId);
    try {
      const goal = this.store.get(taskId);
      if (!goal || goal.status !== 'active') return;
      if ((this.#retryAfter.get(taskId) ?? 0) > Date.now()) return;
      if (!await this.port.isIdle(taskId) || await this.port.hasPendingUserInput(taskId)) return;
      const lease = this.store.acquireLease(taskId, this.leaseDurationMs);
      if (!lease) return;
      const requestId = `goal:${lease.goal.goalId}:${lease.automaticTurnNumber}`;
      try {
        const result = await this.port.run(taskId, goalContinuationPrompt(lease), requestId);
        if (!result.accepted) {
          this.store.releaseLease(taskId, lease.leaseId, true);
          return;
        }
        const updated = this.store.completeLease(taskId, lease.leaseId, result);
        if (result.success) this.#retryAfter.delete(taskId);
        else if (updated?.status === 'active') {
          this.#retryAfter.set(taskId, Date.now() + this.failureBackoffMs * Math.max(1, updated.consecutiveFailedTurns));
        }
        if (updated?.status === 'active' && result.success) this.wake(taskId);
      } catch (error) {
        const updated = this.store.completeLease(taskId, lease.leaseId, {
          success: false,
          productive: false,
          error: error instanceof Error ? error.message : String(error),
        });
        if (updated?.status === 'active') {
          this.#retryAfter.set(taskId, Date.now() + this.failureBackoffMs * Math.max(1, updated.consecutiveFailedTurns));
        }
      }
    } finally {
      this.#runningTasks.delete(taskId);
    }
  }
}

