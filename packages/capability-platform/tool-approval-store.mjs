import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const applicationId = 1397903955;
const schema = `CREATE TABLE jobs (
  id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed')),
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved INTEGER CHECK(approved IN (0,1)),
  activated INTEGER CHECK(activated IN (0,1)),
  error TEXT
);
CREATE UNIQUE INDEX one_active_proposal ON jobs(proposal_id) WHERE status IN ('pending','running');
CREATE UNIQUE INDEX one_running_job ON jobs(status) WHERE status='running';
CREATE TABLE requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id)
);
CREATE TABLE control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  halted INTEGER NOT NULL CHECK(halted IN (0,1))
);`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = message => { throw new Error(message); };

function checkedId(value, label = 'ID') {
  if (typeof value !== 'string' || !uuid.test(value)) fail(`${label} must be a lowercase UUID v4`);
  return value;
}

function directory(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('Explicit approval root required');
  let current = path.resolve(root);
  for (const name of [null, 'runtime', 'tool-approval']) {
    if (name) {
      current = path.join(current, name);
      try { fs.mkdirSync(current, {mode: 0o700}); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) fail('Unsafe approval directory');
  }
  return current;
}

function inspect(file) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const target = file + suffix;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(target) !== target) fail('Unsafe approval database file');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function recognize(db) {
  if (db.prepare('PRAGMA application_id').get().application_id !== applicationId ||
      db.prepare('PRAGMA user_version').get().user_version !== 1) fail('Unknown approval database');
  const expected = schema.split(';').map(value => value.trim()).filter(Boolean).sort();
  const actual = db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY sql")
    .all().map(row => row.sql.trim()).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('Unknown approval schema');
}

function row(value) {
  if (!value) return null;
  return {
    id: value.id,
    proposalId: value.proposal_id,
    status: value.status,
    requestedBy: value.requested_by,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    ...(value.approved === null ? {} : {approved: Number(value.approved) === 1}),
    ...(value.activated === null ? {} : {activated: Number(value.activated) === 1}),
    ...(value.error === null ? {} : {error: value.error}),
  };
}

export class ToolApprovalStore {
  #db;
  #isVerified;
  constructor({root, isVerified, verifyProposal} = {}) {
    const file = path.join(directory(root), 'jobs.sqlite');
    this.databasePath = file;
    this.#isVerified = isVerified ?? verifyProposal;
    if (this.#isVerified !== undefined && typeof this.#isVerified !== 'function') fail('isVerified must be a function');
    inspect(file);
    if (fs.existsSync(file)) {
      const probe = new DatabaseSync(file, {readOnly: true});
      try { recognize(probe); } finally { probe.close(); }
    } else {
      const fd = fs.openSync(file, 'wx', 0o600); fs.closeSync(fd);
      const db = new DatabaseSync(file);
      try {
        db.exec(`BEGIN IMMEDIATE;${schema}INSERT INTO control VALUES(1,0);PRAGMA application_id=${applicationId};PRAGMA user_version=1;COMMIT;`);
      } finally { db.close(); }
    }
    inspect(file);
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    recognize(this.#db);
  }
  #transaction(work) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.#db.exec('COMMIT'); return result; }
    catch (error) { try { this.#db.exec('ROLLBACK'); } catch {} throw error; }
  }
  get(id) { return row(this.#db.prepare('SELECT * FROM jobs WHERE id=?').get(checkedId(id))); }
  getByRequest(requestId) { return row(this.#db.prepare('SELECT j.* FROM jobs j JOIN requests r ON r.job_id=j.id WHERE r.request_id=?').get(checkedId(requestId, 'Request ID'))); }
  latest(proposalId) { return row(this.#db.prepare('SELECT * FROM jobs WHERE proposal_id=? ORDER BY rowid DESC LIMIT 1').get(checkedId(proposalId, 'Proposal ID'))); }
  list(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('Approval list limit must be from 1 to 100');
    return this.#db.prepare('SELECT * FROM jobs ORDER BY rowid DESC LIMIT ?').all(limit).map(row);
  }
  halted() { return this.#db.prepare('SELECT halted FROM control WHERE id=1').get()?.halted !== 0; }
  halt() { this.#db.prepare('UPDATE control SET halted=1 WHERE id=1').run(); }
  resume() { this.#db.prepare('UPDATE control SET halted=0 WHERE id=1').run(); }
  enqueue(proposalId, requestId, {approvedBy} = {}) {
    checkedId(proposalId, 'Proposal ID'); checkedId(requestId, 'Request ID');
    const actor = typeof approvedBy === 'string' ? approvedBy.replace(/\s+/g, ' ').trim() : '';
    if (!actor || actor.length > 120) fail('approvedBy must contain 1 to 120 characters');
    return this.#transaction(() => {
      const existing = this.getByRequest(requestId);
      if (existing) {
        if (existing.proposalId !== proposalId) fail('Request key belongs to a different proposal');
        return {job: existing, deduplicated: true};
      }
      if (this.#isVerified && !this.#isVerified(proposalId)) fail('Only a verified proposal can be approved');
      let job = row(this.#db.prepare("SELECT * FROM jobs WHERE proposal_id=? AND status IN ('pending','running')").get(proposalId));
      const deduplicated = !!job;
      if (!job) {
        if (this.#db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('pending','running')").get().n >= 100) fail('Approval queue capacity reached');
        const id = randomUUID(), now = new Date().toISOString();
        this.#db.prepare("INSERT INTO jobs(id,proposal_id,status,requested_by,created_at,updated_at,approved,activated,error) VALUES (?,?,'pending',?,?,?,NULL,NULL,NULL)").run(id, proposalId, actor, now, now);
        job = this.get(id);
      }
      if (this.#db.prepare('SELECT count(*) AS n FROM requests WHERE job_id=?').get(job.id).n >= 32) fail('Approval request alias capacity reached');
      this.#db.prepare('INSERT INTO requests(request_id,job_id) VALUES (?,?)').run(requestId, job.id);
      return {job, deduplicated};
    });
  }
  claim() {
    return this.#transaction(() => {
      if (this.halted() || this.#db.prepare("SELECT 1 FROM jobs WHERE status='running'").get()) return null;
      const next = this.#db.prepare("SELECT id FROM jobs WHERE status='pending' ORDER BY rowid LIMIT 1").get();
      if (!next) return null;
      this.#db.prepare("UPDATE jobs SET status='running',updated_at=?,error=NULL WHERE id=? AND status='pending'").run(new Date().toISOString(), next.id);
      return this.get(next.id);
    });
  }
  finish(id, result) {
    checkedId(id);
    const terminal = result && typeof result === 'object' && Object.hasOwn(result, 'approved');
    if (terminal && (typeof result.approved !== 'boolean' || typeof result.activated !== 'boolean')) fail('Invalid approval result');
    const succeeded = terminal && !result.error;
    const error = succeeded ? null : String(result?.error ?? 'Approval job failed').slice(0, 2000);
    const changed = this.#db.prepare("UPDATE jobs SET status=?,updated_at=?,approved=?,activated=?,error=? WHERE id=? AND status='running'")
      .run(succeeded ? 'succeeded' : 'failed', new Date().toISOString(), succeeded ? Number(result.approved) : null, succeeded ? Number(result.activated) : null, error, id);
    if (changed.changes !== 1) fail('Only a running approval job can finish');
    return this.get(id);
  }
  interruptRunning() {
    return this.#transaction(() => this.#db.prepare("UPDATE jobs SET status='pending',updated_at=?,error=NULL WHERE status='running'").run(new Date().toISOString()).changes);
  }
  close() { if (this.#db) { this.#db.close(); this.#db = undefined; } }
}
