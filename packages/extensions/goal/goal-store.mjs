import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {deriveGoalPlan, parseGoalPlan, applyGoalProgress, pendingRequiredWorkItems} from './goal-plan.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = new Set(['active', 'paused', 'blocked', 'verifying', 'complete', 'budget_limited']);
const MAX_TURNS = 100;
const now = () => new Date().toISOString();
const fail = message => { throw new Error(message); };

function checkId(value, label = 'taskId') {
  if (typeof value !== 'string' || !uuid.test(value)) fail(`${label} must be a UUID v4`);
  return value;
}
function safeText(value, label, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${label} must be nonempty text without control characters`);
  }
  return value.replace(/\s+/g, ' ').trim();
}
function rootDirectory(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('Explicit Goal root required');
  const base = path.resolve(root);
  const runtime = path.join(base, 'runtime');
  const goal = path.join(runtime, 'goal');
  for (const directory of [runtime, goal]) {
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail('Unsafe Goal directory');
  }
  return goal;
}
function inspect(file) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const target = file + suffix;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(target) !== target) fail('Unsafe Goal database file');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
function asGoal(row) {
  if (!row) return undefined;
  const optional = (key, value) => value == null ? {} : {[key]: value};
  return {
    taskId: row.task_id, goalId: row.goal_id, objective: row.objective, status: row.status,
    maxAutomaticTurns: Number(row.max_automatic_turns), automaticTurnsUsed: Number(row.automatic_turns_used),
    consecutiveFailedTurns: Number(row.consecutive_failed_turns), consecutiveStalledTurns: Number(row.consecutive_stalled_turns),
    plan: parseGoalPlan(JSON.parse(row.plan_json)), revision: Number(row.revision),
    ...optional('leaseId', row.lease_id), ...optional('leaseExpiresAt', row.lease_expires_at),
    ...optional('blockedReason', row.blocked_reason), ...optional('latestVerificationFeedback', row.verification_feedback),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export class GoalStore {
  #db;
  constructor({root, databasePath} = {}) {
    const file = databasePath ? path.resolve(databasePath) : path.join(rootDirectory(root), 'goals.sqlite');
    if (!path.isAbsolute(file)) fail('Absolute Goal database path required');
    if (fs.existsSync(file)) inspect(file);
    else {
      fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
      const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd);
    }
    this.databasePath = file;
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS task_goals (
        task_id TEXT PRIMARY KEY NOT NULL,
        goal_id TEXT NOT NULL UNIQUE,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','paused','blocked','verifying','complete','budget_limited')),
        max_automatic_turns INTEGER NOT NULL CHECK(max_automatic_turns BETWEEN 1 AND 100),
        automatic_turns_used INTEGER NOT NULL DEFAULT 0 CHECK(automatic_turns_used >= 0),
        consecutive_failed_turns INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failed_turns >= 0),
        consecutive_stalled_turns INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_stalled_turns >= 0),
        plan_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        lease_id TEXT,
        lease_expires_at TEXT,
        blocked_reason TEXT,
        verification_feedback TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_goals_status ON task_goals(status, updated_at);
    `);
  }
  close() { if (this.#db) { this.#db.close(); this.#db = undefined; } }
  #transaction(work) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.#db.exec('COMMIT'); return result; }
    catch (error) { try { this.#db.exec('ROLLBACK'); } catch {} throw error; }
  }
  get(taskId) { checkId(taskId); return asGoal(this.#db.prepare('SELECT * FROM task_goals WHERE task_id=?').get(taskId)); }
  getByGoalId(goalId) { checkId(goalId, 'goalId'); return asGoal(this.#db.prepare('SELECT * FROM task_goals WHERE goal_id=?').get(goalId)); }
  listActive() { return this.#db.prepare("SELECT * FROM task_goals WHERE status='active' ORDER BY updated_at, task_id").all().map(asGoal); }
  create(taskId, objective, maxAutomaticTurns = 12, plan) {
    checkId(taskId); const text = safeText(objective, 'objective');
    if (!Number.isSafeInteger(maxAutomaticTurns) || maxAutomaticTurns < 1 || maxAutomaticTurns > MAX_TURNS) fail(`maxAutomaticTurns must be 1..${MAX_TURNS}`);
    const normalizedPlan = parseGoalPlan(plan ?? deriveGoalPlan(text));
    if (!normalizedPlan.items.length) fail('Goal plan must contain at least one work item');
    return this.#transaction(() => {
      const existing = this.get(taskId);
      if (existing && ['active','paused','blocked','verifying','budget_limited'].includes(existing.status)) fail('This task already has an unfinished Goal');
      if (existing) this.#db.prepare('DELETE FROM task_goals WHERE task_id=?').run(taskId);
      const timestamp = now(), goalId = randomUUID();
      this.#db.prepare("INSERT INTO task_goals(task_id,goal_id,objective,status,max_automatic_turns,plan_json,created_at,updated_at) VALUES (?,?,?,'active',?,?,?,?)")
        .run(taskId, goalId, text, maxAutomaticTurns, JSON.stringify(normalizedPlan), timestamp, timestamp);
      return this.get(taskId);
    });
  }
  clear(taskId) { checkId(taskId); return Number(this.#db.prepare('DELETE FROM task_goals WHERE task_id=?').run(taskId).changes) === 1; }
  updateProgress(taskId, ids, expectedRevision) {
    checkId(taskId); if (!Array.isArray(ids) || ids.length === 0) fail('completedItemIds must contain at least one Goal work item ID');
    return this.#transaction(() => {
      const goal = this.get(taskId); if (!goal) fail('This task does not have a Goal');
      if (goal.status !== 'active') fail(`A Goal in ${goal.status} state cannot update progress`);
      if (expectedRevision !== undefined && goal.revision !== expectedRevision) fail(`Goal revision changed from ${expectedRevision} to ${goal.revision}; retry`);
      const plan = applyGoalProgress(goal.plan, ids);
      const timestamp = now();
      this.#db.prepare("UPDATE task_goals SET plan_json=?, revision=revision+1, updated_at=? WHERE task_id=? AND status='active'")
        .run(JSON.stringify(plan), timestamp, taskId);
      return this.get(taskId);
    });
  }
  updateFromAgent(taskId, status, reason, expectedRevision) {
    checkId(taskId);
    if (!['progress','complete','blocked'].includes(status)) fail('status must be progress, complete, or blocked');
    if (status === 'progress') return this.updateProgress(taskId, reason, expectedRevision);
    if (status === 'complete') return this.completeDirect(taskId, expectedRevision);
    return this.#transaction(() => {
      const goal = this.get(taskId); if (!goal) fail('This task does not have a Goal');
      if (expectedRevision !== undefined && goal.revision !== expectedRevision) fail(`Goal revision changed from ${expectedRevision} to ${goal.revision}; retry`);
      const text = safeText(reason ?? 'blocked without a reason', 'reason', 1000);
      if (goal.status !== 'active') fail(`A Goal in ${goal.status} state cannot become blocked`);
      const timestamp = now();
      this.#db.prepare("UPDATE task_goals SET status='blocked', blocked_reason=?, revision=revision+1, updated_at=? WHERE task_id=? AND status='active'")
        .run(text, timestamp, taskId);
      return this.get(taskId);
    });
  }
  completeDirect(taskId, expectedRevision) {
    checkId(taskId);
    return this.#transaction(() => {
      const goal = this.get(taskId); if (!goal) fail('This task does not have a Goal');
      if (goal.status !== 'active') fail(`A Goal in ${goal.status} state cannot complete`);
      if (expectedRevision !== undefined && goal.revision !== expectedRevision) fail(`Goal revision changed from ${expectedRevision} to ${goal.revision}; retry`);
      const pending = pendingRequiredWorkItems(goal.plan);
      if (pending.length) fail(`Goal completion is not ready; pending work: ${pending.map(item => item.id).join(', ')}`);
      const timestamp = now();
      this.#db.prepare("UPDATE task_goals SET status='complete', lease_id=NULL, lease_expires_at=NULL, revision=revision+1, updated_at=? WHERE task_id=? AND status='active'")
        .run(timestamp, taskId);
      return this.get(taskId);
    });
  }
  pause(taskId) {
    checkId(taskId);
    return this.#transaction(() => {
      const goal = this.get(taskId); if (!goal) fail('This task does not have a Goal');
      if (goal.status !== 'active') fail(`A Goal in ${goal.status} state cannot pause`);
      const timestamp = now(); this.#db.prepare("UPDATE task_goals SET status='paused', lease_id=NULL, lease_expires_at=NULL, revision=revision+1, updated_at=? WHERE task_id=? AND status='active'").run(timestamp, taskId);
      return this.get(taskId);
    });
  }
  resume(taskId, additionalTurns = 12) {
    checkId(taskId);
    if (!Number.isSafeInteger(additionalTurns) || additionalTurns < 1 || additionalTurns > MAX_TURNS) fail('additionalTurns must be 1..100');
    return this.#transaction(() => {
      const goal = this.get(taskId); if (!goal) fail('This task does not have a Goal');
      if (goal.status === 'complete') fail('A completed Goal cannot be resumed');
      if (goal.status === 'active') return goal;
      if (goal.status === 'verifying') fail('A Goal awaiting verification cannot be resumed');
      const budget = goal.status === 'budget_limited';
      const timestamp = now();
      this.#db.prepare("UPDATE task_goals SET status='active', max_automatic_turns=max_automatic_turns+?, blocked_reason=NULL, lease_id=NULL, lease_expires_at=NULL, revision=revision+1, updated_at=? WHERE task_id=?")
        .run(budget ? additionalTurns : 0, timestamp, taskId);
      return this.get(taskId);
    });
  }
  recordExternalFeedback(taskId, feedback) {
    checkId(taskId); const text = safeText(feedback, 'feedback', 2000);
    this.#db.prepare('UPDATE task_goals SET verification_feedback=?, revision=revision+1, updated_at=? WHERE task_id=?').run(text, now(), taskId);
    return this.get(taskId);
  }
  acquireLease(taskId, durationMs = 30 * 60 * 1000) {
    checkId(taskId);
    if (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 24 * 60 * 60 * 1000) fail('Invalid Goal lease duration');
    return this.#transaction(() => {
      const goal = this.get(taskId);
      if (!goal || goal.status !== 'active' || goal.automaticTurnsUsed >= goal.maxAutomaticTurns) return undefined;
      if (goal.leaseId && goal.leaseExpiresAt && Date.parse(goal.leaseExpiresAt) > Date.now()) return undefined;
      const leaseId = randomUUID(), turn = goal.automaticTurnsUsed + 1;
      const expires = new Date(Date.now() + durationMs).toISOString(), timestamp = now();
      this.#db.prepare("UPDATE task_goals SET lease_id=?, lease_expires_at=?, automatic_turns_used=?, revision=revision+1, updated_at=? WHERE task_id=? AND status='active' AND automatic_turns_used < max_automatic_turns")
        .run(leaseId, expires, turn, timestamp, taskId);
      const updated = this.get(taskId);
      return {goal: updated, leaseId, automaticTurnNumber: turn};
    });
  }
  releaseLease(taskId, leaseId, refundTurn = false) {
    checkId(taskId); checkId(leaseId, 'leaseId');
    if (typeof refundTurn !== 'boolean') fail('refundTurn must be boolean');
    return this.#transaction(() => {
      const goal = this.get(taskId);
      if (!goal || goal.leaseId !== leaseId) return goal;
      const automaticTurns = refundTurn ? Math.max(0, goal.automaticTurnsUsed - 1) : goal.automaticTurnsUsed;
      const timestamp = now();
      this.#db.prepare('UPDATE task_goals SET automatic_turns_used=?, lease_id=NULL, lease_expires_at=NULL, revision=revision+1, updated_at=? WHERE task_id=? AND lease_id=?')
        .run(automaticTurns, timestamp, taskId, leaseId);
      return this.get(taskId);
    });
  }
  completeLease(taskId, leaseId, outcome) {
    checkId(taskId); checkId(leaseId, 'leaseId');
    if (!outcome || typeof outcome !== 'object' || typeof outcome.success !== 'boolean' || typeof outcome.productive !== 'boolean') fail('Invalid Goal turn outcome');
    return this.#transaction(() => {
      const goal = this.get(taskId);
      if (!goal || goal.leaseId !== leaseId) return undefined;
      const timestamp = now();
      const error = outcome.error === undefined ? undefined : safeText(outcome.error, 'error', 2000);
      const failure = !outcome.success;
      const stalled = outcome.success && !outcome.productive;
      const nextFailed = failure ? goal.consecutiveFailedTurns + 1 : 0;
      const nextStalled = stalled ? goal.consecutiveStalledTurns + 1 : 0;
      const nextStatus = goal.automaticTurnsUsed >= goal.maxAutomaticTurns && pendingRequiredWorkItems(goal.plan).length ? 'budget_limited' : goal.status;
      this.#db.prepare('UPDATE task_goals SET lease_id=NULL, lease_expires_at=NULL, consecutive_failed_turns=?, consecutive_stalled_turns=?, status=?, blocked_reason=?, revision=revision+1, updated_at=? WHERE task_id=? AND lease_id=?')
        .run(nextFailed, nextStalled, nextStatus, error ?? null, timestamp, taskId, leaseId);
      return this.get(taskId);
    });
  }
  expireLeasesForRecovery() {
    const timestamp = now();
    return Number(this.#db.prepare("UPDATE task_goals SET lease_id=NULL, lease_expires_at=?, revision=revision+1, updated_at=? WHERE status='active' AND lease_id IS NOT NULL").run(timestamp, timestamp).changes);
  }
}

