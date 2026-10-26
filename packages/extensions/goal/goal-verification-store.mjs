import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = new Set(['waiting', 'pending', 'running', 'passed', 'failed', 'error']);
const triggers = new Set(['completion_request', 'checkpoint']);
const now = () => new Date().toISOString();
const fail = message => { throw new Error(message); };
function checkId(value, label = 'verificationId') { if (typeof value !== 'string' || !uuid.test(value)) fail(`${label} must be a UUID v4`); return value; }
function text(value, label, max = 8000) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} must be bounded text`); return value.replace(/\s+/g, ' ').trim(); }
function json(value) { return value == null ? undefined : JSON.parse(value); }
function record(row) {
  if (!row) return undefined;
  return {
    id: row.id, taskId: row.task_id, goalId: row.goal_id, goalRevision: Number(row.goal_revision), trigger: row.trigger,
    status: row.status, bundle: json(row.bundle_json), evaluation: json(row.evaluation_json), error: row.error ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at ?? undefined,
  };
}
function attemptRecord(row) {
  if (!row) return undefined;
  return {verificationId: row.verification_id, attemptNumber: Number(row.attempt_number), status: row.status,
    proposal: json(row.proposal_json), diagnostics: row.diagnostics ?? undefined, createdAt: row.created_at, completedAt: row.completed_at ?? undefined};
}

export class GoalVerificationStore {
  #db;
  constructor({root, databasePath} = {}) {
    const file = path.resolve(databasePath ?? path.join(root, 'runtime', 'goal-verification', 'verifications.sqlite'));
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    if (!fs.existsSync(file)) { const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd); }
    this.databasePath = file;
    this.#db = new DatabaseSync(file);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS verification_runs (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        goal_revision INTEGER NOT NULL,
        trigger TEXT NOT NULL CHECK(trigger IN ('completion_request','checkpoint')),
        status TEXT NOT NULL CHECK(status IN ('waiting','pending','running','passed','failed','error')),
        bundle_json TEXT,
        evaluation_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(goal_id, goal_revision, trigger)
      );
      CREATE INDEX IF NOT EXISTS verification_runs_pending ON verification_runs(status, updated_at);
      CREATE TABLE IF NOT EXISTS verification_attempts (
        verification_id TEXT NOT NULL REFERENCES verification_runs(id), attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','accepted','error')),
        proposal_json TEXT, diagnostics TEXT, created_at TEXT NOT NULL, completed_at TEXT,
        PRIMARY KEY(verification_id, attempt_number)
      );`);
  }
  close() { if (this.#db) { this.#db.close(); this.#db = undefined; } }
  #transaction(work) { this.#db.exec('BEGIN IMMEDIATE'); try { const result = work(); this.#db.exec('COMMIT'); return result; } catch (error) { try { this.#db.exec('ROLLBACK'); } catch {} throw error; } }
  get(id) { checkId(id); return record(this.#db.prepare('SELECT * FROM verification_runs WHERE id=?').get(id)); }
  listForTask(taskId) { checkId(taskId, 'taskId'); return this.#db.prepare('SELECT * FROM verification_runs WHERE task_id=? ORDER BY created_at DESC,id DESC').all(taskId).map(record); }
  getForGoalRevision(goalId, goalRevision, trigger) {
    checkId(goalId, 'goalId'); if (!Number.isSafeInteger(goalRevision) || goalRevision < 1 || !triggers.has(trigger)) fail('invalid verification lookup');
    return record(this.#db.prepare('SELECT * FROM verification_runs WHERE goal_id=? AND goal_revision=? AND trigger=?').get(goalId, goalRevision, trigger));
  }
  listPending() { return this.#db.prepare("SELECT * FROM verification_runs WHERE status IN ('waiting','pending','running') ORDER BY created_at,id").all().map(record); }
  createRequest(id, goal, trigger = 'completion_request') {
    checkId(id); checkId(goal?.taskId, 'taskId'); checkId(goal?.goalId, 'goalId');
    if (!Number.isSafeInteger(goal.revision) || goal.revision < 1 || !triggers.has(trigger)) fail('invalid verification request');
    return this.#transaction(() => {
      const existing = this.getForGoalRevision(goal.goalId, goal.revision, trigger);
      if (existing) return existing;
      const timestamp = now();
      this.#db.prepare('INSERT INTO verification_runs(id,task_id,goal_id,goal_revision,trigger,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, goal.taskId, goal.goalId, goal.revision, trigger, 'waiting', timestamp, timestamp);
      return this.get(id);
    });
  }
  attachBundle(id, bundle) {
    checkId(id); if (!bundle || bundle.verificationId !== id) fail('verification bundle identity mismatch');
    return this.#transaction(() => {
      const current = this.get(id); if (!current) fail('verification request not found');
      if (current.bundle) return current;
      if (current.status !== 'waiting') fail(`verification request is ${current.status}`);
      this.#db.prepare("UPDATE verification_runs SET bundle_json=?, status='pending', updated_at=? WHERE id=? AND status='waiting'")
        .run(JSON.stringify(bundle), now(), id);
      return this.get(id);
    });
  }
  begin(id) {
    checkId(id);
    return this.#transaction(() => {
      const current = this.get(id); if (!current) fail('verification request not found');
      if (!current.bundle) fail('verification bundle is missing');
      if (!['pending', 'running'].includes(current.status)) fail(`verification request is ${current.status}`);
      this.#db.prepare("UPDATE verification_runs SET status='running', updated_at=? WHERE id=? AND status IN ('pending','running')").run(now(), id);
      return this.get(id);
    });
  }
  finish(id, evaluation) {
    checkId(id); if (!evaluation || !['pass', 'fail'].includes(evaluation.decision)) fail('invalid verification evaluation');
    return this.#transaction(() => {
      const current = this.get(id); if (!current || !['running', 'pending'].includes(current.status)) fail('verification request is not running');
      const timestamp = now(); const status = evaluation.decision === 'pass' ? 'passed' : 'failed';
      this.#db.prepare('UPDATE verification_runs SET status=?, evaluation_json=?, error=NULL, updated_at=?, completed_at=? WHERE id=? AND status IN (\'running\',\'pending\')')
        .run(status, JSON.stringify(evaluation), timestamp, timestamp, id);
      return this.get(id);
    });
  }
  fail(id, error) {
    checkId(id); const message = text(error, 'verification error');
    return this.#transaction(() => {
      const current = this.get(id); if (!current || statuses.has(current.status) && ['passed','failed','error'].includes(current.status)) return current;
      const timestamp = now();
      this.#db.prepare("UPDATE verification_runs SET status='error', error=?, updated_at=?, completed_at=? WHERE id=? AND status IN ('waiting','pending','running')")
        .run(message, timestamp, timestamp, id);
      return this.get(id);
    });
  }
  startAttempt(id, attemptNumber) {
    checkId(id); if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 3) fail('invalid verification attempt');
    const timestamp = now();
    this.#db.prepare('INSERT INTO verification_attempts(verification_id,attempt_number,status,created_at) VALUES (?,?,?,?)').run(id, attemptNumber, 'running', timestamp);
    return this.listAttempts(id).find(item => item.attemptNumber === attemptNumber);
  }
  finishAttempt({verificationId, attemptNumber, status, proposal, diagnostics}) {
    checkId(verificationId); if (!['accepted','error'].includes(status)) fail('invalid verification attempt status');
    this.#db.prepare('UPDATE verification_attempts SET status=?, proposal_json=?, diagnostics=?, completed_at=? WHERE verification_id=? AND attempt_number=? AND status=\'running\'')
      .run(status, proposal ? JSON.stringify(proposal) : null, diagnostics ?? null, now(), verificationId, attemptNumber);
    return this.listAttempts(verificationId).find(item => item.attemptNumber === attemptNumber);
  }
  listAttempts(id) { checkId(id); return this.#db.prepare('SELECT * FROM verification_attempts WHERE verification_id=? ORDER BY attempt_number').all(id).map(attemptRecord); }
}
