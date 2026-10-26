import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = new Set(['waiting', 'pending', 'running', 'passed', 'failed', 'error']);
const triggers = new Set(['completion_request', 'checkpoint']);
const now = () => new Date().toISOString();
const fail = message => { throw new Error(message); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => {
  if (value === undefined || value === null) return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const hashJson = value => sha256(canonical(value));
function checkId(value, label = 'verificationId') { if (typeof value !== 'string' || !uuid.test(value)) fail(`${label} must be a UUID v4`); return value; }
function text(value, label, max = 8000) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} must be bounded text`); return value.replace(/\s+/g, ' ').trim(); }
function json(value) { return value == null ? undefined : JSON.parse(value); }
function hash(value, label = 'sha256') { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) fail(`${label} must be a SHA-256 hex digest`); return value.toLowerCase(); }
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
      );
      CREATE TABLE IF NOT EXISTS verification_retrievals (
        id TEXT PRIMARY KEY NOT NULL,
        verification_id TEXT NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('search','fetch')),
        provider TEXT NOT NULL,
        query TEXT,
        source_url TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        content_type TEXT,
        content_sha256 TEXT NOT NULL,
        response_text TEXT NOT NULL,
        UNIQUE(verification_id, kind, source_url, content_sha256)
      );
      CREATE TABLE IF NOT EXISTS verification_checks (
        id TEXT PRIMARY KEY NOT NULL,
        verification_id TEXT NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('exists','text_stats','json_valid','json_array_length','csv_row_count')),
        executed_at TEXT NOT NULL,
        artifact_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL,
        result_sha256 TEXT NOT NULL
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
  #running(id) {
    const run = this.get(id);
    if (!run) fail('verification request not found');
    if (run.status !== 'running') fail(`verification request is ${run.status}`);
    if (!run.bundle) fail('verification bundle is missing');
    return run;
  }
  recordRetrieval({verificationId, kind, provider, query, sourceUrl, fetchedAt, contentType, responseText} = {}) {
    checkId(verificationId);
    this.#running(verificationId);
    if (!['search', 'fetch'].includes(kind)) fail('retrieval kind is invalid');
    const providerText = text(provider, 'retrieval provider', 100);
    const url = text(sourceUrl, 'retrieval sourceUrl', 4000);
    const fetched = text(fetchedAt, 'retrieval fetchedAt', 100);
    if (typeof responseText !== 'string' || Buffer.byteLength(responseText, 'utf8') > 1_500_000) fail('retrieval response exceeds 1500000 bytes');
    const id = randomUUID();
    const contentSha256 = sha256(Buffer.from(responseText, 'utf8'));
    this.#db.prepare(`INSERT OR IGNORE INTO verification_retrievals
      (id, verification_id, kind, provider, query, source_url, fetched_at, content_type, content_sha256, response_text)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, verificationId, kind, providerText, query === undefined ? null : text(query, 'retrieval query', 1000), url, fetched, contentType === undefined ? null : text(contentType, 'retrieval contentType', 200), contentSha256, responseText);
    const stored = this.#db.prepare('SELECT * FROM verification_retrievals WHERE verification_id=? AND kind=? AND source_url=? AND content_sha256=?').get(verificationId, kind, url, contentSha256);
    if (!stored) fail('retrieval receipt could not be persisted');
    return {
      id: stored.id, verificationId: stored.verification_id, kind: stored.kind, provider: stored.provider,
      ...(stored.query ? {query: stored.query} : {}), sourceUrl: stored.source_url, fetchedAt: stored.fetched_at,
      ...(stored.content_type ? {contentType: stored.content_type} : {}), contentSha256: stored.content_sha256,
      responseText: stored.response_text,
    };
  }
  getRetrieval(id, verificationId) {
    checkId(id); checkId(verificationId);
    const row = this.#db.prepare('SELECT * FROM verification_retrievals WHERE id=? AND verification_id=?').get(id, verificationId);
    if (!row) return undefined;
    return {id: row.id, verificationId: row.verification_id, kind: row.kind, provider: row.provider,
      ...(row.query ? {query: row.query} : {}), sourceUrl: row.source_url, fetchedAt: row.fetched_at,
      ...(row.content_type ? {contentType: row.content_type} : {}), contentSha256: row.content_sha256, responseText: row.response_text};
  }
  listRetrievals(verificationId) {
    checkId(verificationId);
    return this.#db.prepare('SELECT id FROM verification_retrievals WHERE verification_id=? ORDER BY fetched_at,id').all(verificationId).map(row => this.getRetrieval(row.id, verificationId));
  }
  recordCheck({verificationId, artifactId, operation, executedAt, artifactSha256, result} = {}) {
    checkId(verificationId); this.#running(verificationId); text(artifactId, 'artifactId', 500); text(executedAt, 'executedAt', 100); hash(artifactSha256, 'artifactSha256');
    if (!['exists', 'text_stats', 'json_valid', 'json_array_length', 'csv_row_count'].includes(operation)) fail('check operation is invalid');
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail('check result must be an object');
    const check = {id: randomUUID(), verificationId, artifactId, operation, executedAt, artifactSha256: artifactSha256.toLowerCase(), result, resultSha256: hashJson(result)};
    this.#db.prepare(`INSERT INTO verification_checks
      (id, verification_id, artifact_id, operation, executed_at, artifact_sha256, result_json, result_sha256)
      VALUES (?,?,?,?,?,?,?,?)`).run(check.id, verificationId, artifactId, operation, executedAt, check.artifactSha256, JSON.stringify(result), check.resultSha256);
    return check;
  }
  getCheck(id, verificationId) {
    checkId(id); checkId(verificationId);
    const row = this.#db.prepare('SELECT * FROM verification_checks WHERE id=? AND verification_id=?').get(id, verificationId);
    if (!row) return undefined;
    return {id: row.id, verificationId: row.verification_id, artifactId: row.artifact_id, operation: row.operation, executedAt: row.executed_at, artifactSha256: row.artifact_sha256, result: JSON.parse(row.result_json), resultSha256: row.result_sha256};
  }
  listChecks(verificationId) {
    checkId(verificationId);
    return this.#db.prepare('SELECT id FROM verification_checks WHERE verification_id=? ORDER BY executed_at,id').all(verificationId).map(row => this.getCheck(row.id, verificationId));
  }
}
