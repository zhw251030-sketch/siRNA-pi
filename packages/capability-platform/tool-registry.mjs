import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { types } from 'node:util';

const APPLICATION_ID = 1397903433;
const SCHEMA_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const PROFILES = ['no_external_access', 'controlled_network', 'controlled_software'];
const INPUT_FIELDS = ['id', 'toolName', 'artifactPath', 'artifactSha256', 'permissionProfile', 'imageDigest'];

function must(condition, message) {
  if (!condition) throw new Error(message);
}

// Inspect descriptors before reading values: getters, custom prototypes and proxies
// are not proposal data and must not execute during validation.
function plainData(value, allowed, required, label) {
  must(value !== null && typeof value === 'object' && !types.isProxy(value), `${label} must be a plain data object`);
  const prototype = Object.getPrototypeOf(value);
  must(prototype === Object.prototype || prototype === null, `${label} must have a plain prototype`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    must(typeof key === 'string' && allowed.includes(key), `${label} has an unknown field`);
    must(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, `${label} fields must be enumerable data properties`);
  }
  for (const key of required) must(Object.hasOwn(descriptors, key), `${label} is missing ${key}`);
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function absolutePath(value, label) {
  must(typeof value === 'string' && value.length > 0 && !value.includes('\0') && isAbsolute(value), `${label} must be an explicit absolute path`);
  if (process.platform === 'win32') {
    must(/^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(value), `${label} must include an explicit drive or UNC share`);
  }
  return resolve(value);
}

function proposalId(value) {
  must(typeof value === 'string' && UUID.test(value), 'proposal id must be a canonical UUID');
  return value;
}

function proposalInput(value) {
  const input = plainData(value, INPUT_FIELDS, INPUT_FIELDS, 'proposal');
  proposalId(input.id);
  must(typeof input.toolName === 'string' && TOOL_NAME.test(input.toolName), 'Invalid toolName');
  absolutePath(input.artifactPath, 'artifactPath');
  must(typeof input.artifactSha256 === 'string' && SHA256.test(input.artifactSha256), 'Invalid artifactSha256');
  must(PROFILES.includes(input.permissionProfile), 'Invalid permissionProfile');
  must(typeof input.imageDigest === 'string' && IMAGE_DIGEST.test(input.imageDigest), 'Invalid imageDigest');
  return input;
}

function statIfPresent(path) {
  try { return lstatSync(path); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function ordinaryFile(path, stat) {
  must(!stat.isSymbolicLink() && stat.isFile(), 'Database and sidecars must be ordinary files without symbolic links');
  must(stat.nlink === 1, 'Database and sidecars must have a single hard link');
  must(realpathSync(path) === resolve(path), 'Database file real path must match its canonical path');
}

function inspectPaths(path) {
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  must(!parentStat.isSymbolicLink() && parentStat.isDirectory(), 'Database parent must be an existing ordinary directory without links');
  must(realpathSync(parent) === parent, 'Database parent real path must match its canonical path');
  const databaseStat = statIfPresent(path);
  if (databaseStat) ordinaryFile(path, databaseStat);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${path}${suffix}`;
    const stat = statIfPresent(sidecar);
    if (stat) ordinaryFile(sidecar, stat);
  }
  return databaseStat !== undefined;
}

function recognize(db) {
  const applicationId = db.prepare('PRAGMA application_id').get().application_id;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  must(applicationId === APPLICATION_ID && version === SCHEMA_VERSION,
    'Unrecognized tool registry database identity or schema version; no migration performed');
}

function createSchema(db) {
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE tool_proposals (
      id TEXT PRIMARY KEY NOT NULL,
      tool_name TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('submitted', 'verification_failed', 'verified', 'approved', 'rejected')),
      artifact_path TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      permission_profile TEXT NOT NULL,
      image_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tool_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL REFERENCES tool_proposals(id),
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX tool_proposals_created ON tool_proposals(created_at DESC, id DESC);
    CREATE INDEX tool_events_proposal ON tool_events(proposal_id, id);
    PRAGMA application_id = ${APPLICATION_ID};
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT;`);
}

function proposalRow(row) {
  if (row === undefined) return undefined;
  return { id: row.id, toolName: row.tool_name, state: row.state,
    artifactPath: row.artifact_path, artifactSha256: row.artifact_sha256,
    permissionProfile: row.permission_profile, imageDigest: row.image_digest,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Stores submitted metadata only; registration does not verify an artifact or image. */
export class ToolRegistry {
  #db;
  #readOnly;

  constructor(databasePath, options = {}) {
    const settings = plainData(options, ['readOnly'], [], 'registry options');
    const readOnly = settings.readOnly === undefined ? false : settings.readOnly;
    must(typeof readOnly === 'boolean', 'readOnly must be a boolean');
    const path = absolutePath(databasePath, 'databasePath');
    const existed = inspectPaths(path);
    must(existed || !readOnly, 'Read-only registry database does not exist');

    // Probe existing files in SQLite read-only mode before any writable open or PRAGMA.
    // Unknown files (including empty files) are never adopted or migrated.
    if (existed) {
      const probe = new DatabaseSync(path, { readOnly: true });
      try {
        probe.exec('PRAGMA busy_timeout = 5000');
        recognize(probe);
      } finally { probe.close(); }
      inspectPaths(path);
    } else {
      // Exclusive creation avoids accidentally adopting a file that appeared since inspection.
      const fd = openSync(path, 'wx', 0o600);
      closeSync(fd);
    }

    this.#readOnly = readOnly;
    try {
      this.#db = new DatabaseSync(path, { readOnly });
      this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
      if (!existed) createSchema(this.#db);
      recognize(this.#db);
      if (!readOnly) this.#db.exec('PRAGMA journal_mode = WAL');
    } catch (error) {
      this.#db?.close();
      this.#db = undefined;
      if (!existed) throw new Error('New tool registry initialization failed; created database was retained', { cause: error });
      throw error;
    }
  }

  #connection() {
    must(this.#db !== undefined, 'Tool registry is closed');
    return this.#db;
  }

  registerProposal(value, options = {}) {
    const db = this.#connection();
    must(!this.#readOnly, 'Tool registry is read-only');
    const input = proposalInput(value);
    const settings = plainData(options, ['actor'], [], 'registration options');
    const actor = settings.actor === undefined ? 'local-cli' : settings.actor;
    must(typeof actor === 'string' && actor.trim().length > 0 && actor.length <= 128 &&
      !/[\u0000-\u001f\u007f]/.test(actor), 'actor must be nonempty short text without control characters');
    const createdAt = new Date().toISOString();
    const details = JSON.stringify({ proposalId: input.id, artifactSha256: input.artifactSha256 });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO tool_proposals
        (id, tool_name, state, artifact_path, artifact_sha256, permission_profile, image_digest, created_at, updated_at)
        VALUES (?, ?, 'submitted', ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.toolName, input.artifactPath, input.artifactSha256,
          input.permissionProfile, input.imageDigest, createdAt, createdAt);
      db.prepare(`INSERT INTO tool_events (proposal_id, event_type, actor, tool_name, details_json, created_at)
        VALUES (?, 'proposal_submitted', ?, ?, ?, ?)`)
        .run(input.id, actor, input.toolName, details, createdAt);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) {
        // SQLite may already have rolled back the transaction (e.g. RAISE(ROLLBACK)).
        // Preserve its original failure, but close on any other cleanup failure.
        if (!rollbackError.message.includes('no transaction is active')) {
          this.close();
          throw new AggregateError([error, rollbackError], 'Proposal registration and rollback failed; registry closed', { cause: error });
        }
      }
      throw error;
    }
    return { ...input, state: 'submitted', createdAt, updatedAt: createdAt };
  }

  getProposal(id) {
    const db = this.#connection();
    proposalId(id);
    return proposalRow(db.prepare('SELECT * FROM tool_proposals WHERE id = ?').get(id));
  }

  listProposals(limit = 100) {
    const db = this.#connection();
    must(Number.isInteger(limit) && limit >= 1 && limit <= 1000, 'limit must be an integer between 1 and 1000');
    return db.prepare('SELECT * FROM tool_proposals ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit).map(proposalRow);
  }

  listEvents(id) {
    const db = this.#connection();
    proposalId(id);
    return db.prepare('SELECT * FROM tool_events WHERE proposal_id = ? ORDER BY id ASC').all(id)
      .map(row => ({ id: row.id, proposalId: row.proposal_id, eventType: row.event_type,
        actor: row.actor, toolName: row.tool_name, details: JSON.parse(row.details_json), createdAt: row.created_at }));
  }

  close() {
    if (this.#db !== undefined) {
      this.#db.close();
      this.#db = undefined;
    }
  }
}
