import { DatabaseSync } from 'node:sqlite';
import { closeSync, fchmodSync, fsyncSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { types } from 'node:util';
import {toolVersion,versionParts,earlierParent,maintenanceText} from './tool-version.mjs';

const APPLICATION_ID = 1397903433;
const SCHEMA_VERSION = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const PROFILES = ['no_external_access', 'controlled_network', 'controlled_software'];
const INPUT_FIELDS = ['id', 'toolName', 'artifactPath', 'artifactSha256', 'permissionProfile', 'imageDigest'];
const VALIDATION_FIELDS = ['id', 'proposalId', 'passed', 'reportPath', 'reportSha256'];
const VERSION_FIELDS = ['toolId', 'toolName', 'version', 'proposalId', 'packageDirectory',
  'packageSha256', 'imageDigest', 'approvedBy', 'approvedAt', 'validationId', 'reportSha256', 'artifactSha256'];
const PARENT_FIELDS = ['parentToolId','parentVersion','parentPackageSha256'];
const VERSION_COLUMNS = ['tool_id', 'tool_name', 'version', 'state', 'proposal_id', 'package_directory',
  'package_sha256', 'image_digest', 'runtime_state', 'approved_by', 'approved_at', 'updated_at'];
const VERSION4_COLUMNS = [...VERSION_COLUMNS,'parent_tool_id','parent_version'];
const VERSION_SCHEMA = `CREATE TABLE tool_versions (
  tool_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'inactive')),
  proposal_id TEXT NOT NULL REFERENCES tool_proposals(id),
  package_directory TEXT NOT NULL,
  package_sha256 TEXT NOT NULL,
  image_digest TEXT NOT NULL,
  runtime_state TEXT NOT NULL CHECK (runtime_state = 'retained'),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  parent_tool_id TEXT,
  parent_version TEXT,
  PRIMARY KEY (tool_id, version),
  CHECK ((parent_tool_id IS NULL AND parent_version IS NULL) OR (parent_tool_id IS NOT NULL AND parent_version IS NOT NULL)),
  FOREIGN KEY (parent_tool_id, parent_version) REFERENCES tool_versions(tool_id, version)
);
CREATE UNIQUE INDEX tool_versions_name ON tool_versions(tool_name) WHERE state = 'active';
CREATE UNIQUE INDEX tool_versions_name_version ON tool_versions(tool_name, version);
CREATE UNIQUE INDEX tool_versions_proposal ON tool_versions(proposal_id);`;
// The original released v3 table, independent of the v4 DDL. Recognition must
// reject weakened foreign keys, checks and collations before writable opening.
const VERSION3_TABLE = `CREATE TABLE tool_versions (
  tool_id TEXT PRIMARY KEY NOT NULL, tool_name TEXT NOT NULL,
  version TEXT NOT NULL CHECK (version = '1.0.0'),
  state TEXT NOT NULL CHECK (state = 'active'),
  proposal_id TEXT NOT NULL REFERENCES tool_proposals(id),
  package_directory TEXT NOT NULL, package_sha256 TEXT NOT NULL, image_digest TEXT NOT NULL,
  runtime_state TEXT NOT NULL CHECK (runtime_state = 'retained'),
  approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`;
const schemaSQL=value=>value.replace(/'(?:''|[^'])*'|[^']+/g,part=>part.startsWith("'")?part:part.replace(/\s+/g,'').toLowerCase()).replace(/;$/,'');
const VALIDATION_SCHEMA = `CREATE TABLE tool_validations (
  id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES tool_proposals(id),
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  report_path TEXT NOT NULL,
  report_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX tool_validations_proposal ON tool_validations(proposal_id);`;

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

function validationInput(value) {
  const input = plainData(value, VALIDATION_FIELDS, VALIDATION_FIELDS, 'validation');
  proposalId(input.id);
  proposalId(input.proposalId);
  must(typeof input.passed === 'boolean', 'validation passed must be a boolean');
  absolutePath(input.reportPath, 'reportPath');
  must(typeof input.reportSha256 === 'string' && SHA256.test(input.reportSha256), 'Invalid reportSha256');
  return input;
}

function toolName(value) {
  must(typeof value === 'string' && TOOL_NAME.test(value), 'Invalid toolName');
  return value;
}

function activationInput(value) {
  const input = plainData(value, [...VERSION_FIELDS,...PARENT_FIELDS], VERSION_FIELDS, 'version activation');
  proposalId(input.toolId); proposalId(input.proposalId); proposalId(input.validationId);
  must(input.toolId !== input.proposalId, 'First toolId must differ from proposalId');
  toolName(input.toolName); toolVersion(input.version);
  must(input.packageDirectory === `${input.toolId}-${input.version}`, 'packageDirectory must be the toolId-version basename');
  const hasParent=PARENT_FIELDS.some(field=>Object.hasOwn(input,field));
  if(hasParent){
    must(PARENT_FIELDS.every(field=>Object.hasOwn(input,field)),'Complete parent binding required');
    proposalId(input.parentToolId);toolVersion(input.parentVersion);
    must(input.parentToolId===input.toolId&&earlierParent(input.parentVersion,input.version),'Invalid parent tool identity or version order');
    must(typeof input.parentPackageSha256==='string'&&SHA256.test(input.parentPackageSha256),'Invalid parent package digest');
  }else must(input.version==='1.0.0','First version must be 1.0.0 without a parent');
  for (const field of ['packageSha256', 'reportSha256', 'artifactSha256']) {
    must(typeof input[field] === 'string' && SHA256.test(input[field]), `Invalid ${field}`);
  }
  must(typeof input.imageDigest === 'string' && IMAGE_DIGEST.test(input.imageDigest), 'Invalid imageDigest');
  must(typeof input.approvedBy === 'string' && input.approvedBy.trim().length > 0 &&
    input.approvedBy.length <= 120 && !/[\u0000-\u001f\u007f]/.test(input.approvedBy),
  'approvedBy must be nonempty text of at most 120 characters without controls');
  must(typeof input.approvedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.approvedAt) &&
    Number.isFinite(Date.parse(input.approvedAt)) && new Date(input.approvedAt).toISOString() === input.approvedAt,
  'approvedAt must be a canonical ISO timestamp');
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
  must(applicationId === APPLICATION_ID && [1, 2, 3, SCHEMA_VERSION].includes(version),
    'Unrecognized tool registry database identity or schema version; no migration performed');
  const layouts = {
    tool_proposals: ['id', 'tool_name', 'state', 'artifact_path', 'artifact_sha256',
      'permission_profile', 'image_digest', 'created_at', 'updated_at',
      ...(version >= 2 ? ['latest_validation_id'] : [])],
    tool_events: ['id', 'proposal_id', 'event_type', 'actor', 'tool_name', 'details_json', 'created_at'],
    ...(version >= 2 ? { tool_validations: ['id', 'proposal_id', 'passed', 'report_path', 'report_sha256', 'created_at'] } : {}),
    ...(version >= 3 ? { tool_versions: version===3?VERSION_COLUMNS:VERSION4_COLUMNS } : {}),
  };
  for (const [table, names] of Object.entries(layouts)) {
    // Table names are fixed above, never caller-controlled SQL identifiers.
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    must(columns.length === names.length && columns.every((column, index) =>
      column.name === names[index] &&
      column.type === ((table === 'tool_events' && column.name === 'id') ||
        (table === 'tool_validations' && column.name === 'passed') ? 'INTEGER' : 'TEXT') &&
      column.pk === (table==='tool_versions'&&version===4?(index===0?1:index===2?2:0):index === 0 ? 1 : 0) &&
      column.notnull === ((table === 'tool_events' && index === 0) || column.name === 'latest_validation_id' ||
        table==='tool_versions'&&['parent_tool_id','parent_version'].includes(column.name) ? 0 : 1)),
    'Unrecognized tool registry schema table layout; no migration performed');
  }
  if (version >= 3) {
    const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_versions'").get().sql;
    must(schemaSQL(sql)===schemaSQL(version===3?VERSION3_TABLE:VERSION_SCHEMA.slice(0,VERSION_SCHEMA.indexOf(';'))),
      'Unrecognized tool registry schema constraints; no migration performed');
    const indexes = db.prepare('PRAGMA index_list(tool_versions)').all();
    for (const [indexName, names] of [
      ['tool_versions_name', ['tool_name']],
      ['tool_versions_name_version', ['tool_name', 'version']],
      ['tool_versions_proposal', ['proposal_id']],
    ]) {
      const index = indexes.find(entry => entry.name === indexName);
      const columns = db.prepare(`PRAGMA index_info(${indexName})`).all();
      must(index?.unique === 1 && index.partial === (version===4&&indexName==='tool_versions_name'?1:0) && columns.length === names.length &&
        columns.every((column, offset) => column.name === names[offset]),
      'Unrecognized tool registry schema unique index layout; no migration performed');
      const indexSQL=db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(indexName).sql;
      const expected=`CREATE UNIQUE INDEX ${indexName} ON tool_versions(${names.join(',')})${version===4&&indexName==='tool_versions_name'?" WHERE state = 'active'":''}`;
      must(schemaSQL(indexSQL)===schemaSQL(expected),'Unrecognized tool registry schema index constraints; no migration performed');
    }
  }
  return version;
}

function migrateSchema(db, path, originalVersion) {
  // VACUUM INTO reads SQLite's consistent snapshot, including committed WAL rows.
  // Reserve the destination exclusively and restrict it before SQLite writes bytes.
  const backupPath = `${path}.v${originalVersion}-backup-${randomUUID()}.sqlite`;
  const fd = openSync(backupPath, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    db.prepare('VACUUM INTO ?').run(backupPath);
    fsyncSync(fd);
  } catch (error) {
    throw new Error(`Registry backup failed; retained backup at ${backupPath}`, { cause: error });
  } finally { closeSync(fd); }
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another connection may have migrated while the backup was being made.
    const version = recognize(db);
    if (version === 1) {
      db.exec(`ALTER TABLE tool_proposals ADD COLUMN latest_validation_id TEXT REFERENCES tool_validations(id);
        ${VALIDATION_SCHEMA}`);
    }
    if(version===3){
      db.exec(`DROP INDEX tool_versions_name; DROP INDEX tool_versions_name_version; DROP INDEX tool_versions_proposal;
        ALTER TABLE tool_versions RENAME TO tool_versions_v3;
        ${VERSION_SCHEMA}
        INSERT INTO tool_versions (${VERSION_COLUMNS.join(',')}) SELECT ${VERSION_COLUMNS.join(',')} FROM tool_versions_v3;
        DROP TABLE tool_versions_v3;`);
    }else if (version < 3) {
      db.exec(VERSION_SCHEMA);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    recognize(db);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); }
    catch (rollbackError) {
      if (!rollbackError.message.includes('no transaction is active')) {
        throw new AggregateError([error, rollbackError], `Registry migration and rollback failed; backup at ${backupPath}`, { cause: error });
      }
    }
    throw new Error(`Registry migration failed; backup retained at ${backupPath}`, { cause: error });
  }
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
      updated_at TEXT NOT NULL,
      latest_validation_id TEXT REFERENCES tool_validations(id)
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
    ${VALIDATION_SCHEMA}
    ${VERSION_SCHEMA}
    PRAGMA application_id = ${APPLICATION_ID};
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT;`);
}

function proposalRow(row) {
  if (row === undefined) return undefined;
  return { id: row.id, toolName: row.tool_name, state: row.state,
    artifactPath: row.artifact_path, artifactSha256: row.artifact_sha256,
    permissionProfile: row.permission_profile, imageDigest: row.image_digest,
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.latest_validation_id ? { latestValidationId: row.latest_validation_id } : {}) };
}

function validationRow(row) {
  if (row === undefined) return undefined;
  return { id: row.id, proposalId: row.proposal_id, passed: row.passed === 1,
    reportPath: row.report_path, reportSha256: row.report_sha256, createdAt: row.created_at };
}

function versionRow(row) {
  if (row === undefined) return undefined;
  return { toolId: row.tool_id, toolName: row.tool_name, version: row.version, state: row.state,
    proposalId: row.proposal_id, packageDirectory: row.package_directory, packageSha256: row.package_sha256,
    imageDigest: row.image_digest, runtimeState: row.runtime_state, approvedBy: row.approved_by,
    approvedAt: row.approved_at, updatedAt: row.updated_at,
    ...(row.parent_tool_id!==undefined&&row.parent_tool_id!==null?{parentToolId:row.parent_tool_id,parentVersion:row.parent_version}:{}) };
}

/** Stores proposal metadata and independent validation indexes; registration performs no verification. */
export class ToolRegistry {
  #db;
  #readOnly;
  #version;

  constructor(databasePath, options = {}) {
    const settings = plainData(options, ['readOnly', 'migrate'], [], 'registry options');
    const readOnly = settings.readOnly === undefined ? false : settings.readOnly;
    const migrate = settings.migrate === undefined ? false : settings.migrate;
    must(typeof readOnly === 'boolean', 'readOnly must be a boolean');
    must(typeof migrate === 'boolean', 'migrate must be a boolean');
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
      this.#version = recognize(this.#db);
      if (!readOnly && migrate && this.#version < SCHEMA_VERSION) {
        migrateSchema(this.#db, path, this.#version);
        this.#version = recognize(this.#db);
      }
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

  recordValidation(value) {
    const db = this.#connection();
    must(!this.#readOnly, 'Tool registry is read-only');
    must(this.#version >= 2, 'Validation writes require schema v2 or newer; reopen with migrate: true');
    const input = validationInput(value);
    const createdAt = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      // Read state only after acquiring the write transaction: a competing approval
      // or rejection must not be overwritten using a stale pre-transaction read.
      const proposal = db.prepare('SELECT state, tool_name FROM tool_proposals WHERE id = ?').get(input.proposalId);
      must(proposal !== undefined, 'Validation proposal does not exist');
      must(['submitted', 'verification_failed', 'verified'].includes(proposal.state),
        `Proposal state ${proposal.state} does not permit validation`);
      db.prepare(`INSERT INTO tool_validations (id, proposal_id, passed, report_path, report_sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(input.id, input.proposalId, input.passed ? 1 : 0,
        input.reportPath, input.reportSha256, createdAt);
      db.prepare('UPDATE tool_proposals SET state = ?, latest_validation_id = ?, updated_at = ? WHERE id = ?')
        .run(input.passed ? 'verified' : 'verification_failed', input.id, createdAt, input.proposalId);
      const details = JSON.stringify({ validationId: input.id, proposalId: input.proposalId,
        passed: input.passed, reportPath: input.reportPath, reportSha256: input.reportSha256 });
      db.prepare(`INSERT INTO tool_events (proposal_id, event_type, actor, tool_name, details_json, created_at)
        VALUES (?, ?, 'validator', ?, ?, ?)`).run(input.proposalId,
        input.passed ? 'validation_passed' : 'validation_failed', proposal.tool_name, details, createdAt);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) {
        if (!rollbackError.message.includes('no transaction is active')) {
          this.close();
          throw new AggregateError([error, rollbackError], 'Validation recording and rollback failed; registry closed', { cause: error });
        }
      }
      throw error;
    }
    return { ...input, createdAt };
  }

  getValidation(id) {
    const db = this.#connection();
    proposalId(id);
    if (this.#version === 1) return undefined;
    return validationRow(db.prepare('SELECT * FROM tool_validations WHERE id = ?').get(id));
  }

  latestValidation(id) {
    const db = this.#connection();
    proposalId(id);
    if (this.#version === 1) return undefined;
    return validationRow(db.prepare(`SELECT v.* FROM tool_proposals p JOIN tool_validations v
      ON v.id = p.latest_validation_id AND v.proposal_id = p.id WHERE p.id = ?`).get(id));
  }

  nextVersion(name,parentVersion) {
    const db=this.#connection();toolName(name);
    const versions=this.listToolVersions(name);
    if(parentVersion===undefined){
      must(versions.length===0,'Existing tool name requires a parent version');
      return {toolId:randomUUID(),version:'1.0.0'};
    }
    toolVersion(parentVersion);
    const parent=this.getToolVersion(name,parentVersion);
    must(parent&&['active','inactive'].includes(parent.state)&&parent.runtimeState==='retained','Unknown retained parent version');
    const [major,minor]=versionParts(parentVersion);
    const patches=versions.filter(item=>{const p=versionParts(item.version);return p[0]===major&&p[1]===minor;}).map(item=>versionParts(item.version)[2]);
    const patch=Math.max(...patches)+1;
    must(Number.isSafeInteger(patch),'Tool patch version exhausted');
    return {toolId:parent.toolId,version:`${major}.${minor}.${patch}`};
  }

  activateVersion(value,{verifyEvidence}={}) {
    const db = this.#connection();
    must(!this.#readOnly, 'Tool registry is read-only');
    must(this.#version === SCHEMA_VERSION, 'Version activation requires schema v4; reopen with migrate: true');
    const input = activationInput(value);
    must(verifyEvidence===undefined||typeof verifyEvidence==='function','verifyEvidence must be a synchronous function');
    db.exec('BEGIN IMMEDIATE');
    try {
      // Evidence and conflicts are checked under the same write lock as all three writes.
      const proposal = db.prepare('SELECT * FROM tool_proposals WHERE id = ?').get(input.proposalId);
      must(proposal !== undefined, 'Activation proposal does not exist');
      must(proposal.state === 'verified', 'Only a verified proposal permits version activation');
      must(proposal.latest_validation_id === input.validationId, 'Latest validation id changed');
      const validation = db.prepare('SELECT * FROM tool_validations WHERE id = ? AND proposal_id = ?')
        .get(input.validationId, input.proposalId);
      must(validation !== undefined && validation.passed === 1, 'Latest passing validation is required');
      must(validation.report_sha256 === input.reportSha256, 'Validation report digest changed');
      must(proposal.artifact_sha256 === input.artifactSha256, 'Proposal artifact digest changed');
      must(proposal.tool_name === input.toolName, 'Proposal tool name mismatch');
      must(proposal.image_digest === input.imageDigest, 'Proposal image digest mismatch');
      must(proposal.permission_profile === 'no_external_access', 'Activation requires no_external_access');
      const existing = db.prepare('SELECT tool_id FROM tool_versions WHERE proposal_id = ?').get(input.proposalId);
      must(existing === undefined, 'Proposal already has a tool version');
      if(input.parentVersion!==undefined){
        const parent=this.getToolVersion(input.toolName,input.parentVersion);
        must(parent&&parent.toolId===input.parentToolId&&parent.packageSha256===input.parentPackageSha256&&
          parent.runtimeState==='retained'&&['active','inactive'].includes(parent.state),'Parent identity or package changed');
        const next=this.nextVersion(input.toolName,input.parentVersion);
        must(next.toolId===input.toolId&&next.version===input.version,'Allocated child version changed');
        must(!this.listToolVersions().some(v=>v.toolId===input.toolId&&v.toolName!==input.toolName),'Tool identity belongs to a different name');
      }else{
        must(this.listToolVersions(input.toolName).length===0&&!this.listToolVersions().some(v=>v.toolId===input.toolId),
          'First version already exists for this tool name or toolId');
      }
      if(verifyEvidence){const result=verifyEvidence();must(!result||typeof result.then!=='function','Evidence verification must be synchronous');}
      db.prepare("UPDATE tool_versions SET state='inactive',updated_at=? WHERE tool_name=? AND state='active'").run(input.approvedAt,input.toolName);
      db.prepare(`INSERT INTO tool_versions (${VERSION4_COLUMNS.join(', ')})
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?, 'retained', ?, ?, ?, ?, ?)`)
        .run(input.toolId, input.toolName, input.version, input.proposalId, input.packageDirectory,
          input.packageSha256, input.imageDigest, input.approvedBy, input.approvedAt, input.approvedAt,input.parentToolId??null,input.parentVersion??null);
      db.prepare("UPDATE tool_proposals SET state = 'approved', updated_at = ? WHERE id = ?")
        .run(input.approvedAt, input.proposalId);
      const details = JSON.stringify({ proposalId: input.proposalId, toolId: input.toolId,
        version: input.version, packageSha256: input.packageSha256, imageDigest: input.imageDigest });
      db.prepare(`INSERT INTO tool_events (proposal_id, event_type, actor, tool_name, details_json, created_at)
        VALUES (?, 'version_activated', ?, ?, ?, ?)`)
        .run(input.proposalId, input.approvedBy, input.toolName, details, input.approvedAt);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) {
        if (!rollbackError.message.includes('no transaction is active')) {
          this.close();
          throw new AggregateError([error, rollbackError], 'Version activation and rollback failed; registry closed', { cause: error });
        }
      }
      throw error;
    }
    return this.getToolVersion(input.toolName, input.version);
  }

  getToolVersion(name, version) {
    const db = this.#connection(); toolName(name); toolVersion(version);
    if (this.#version < 3) return undefined;
    return versionRow(db.prepare('SELECT * FROM tool_versions WHERE tool_name = ? AND version = ?').get(name, version));
  }

  rollbackTool(name,version,actor,reason,{verifyEvidence}={}) {
    const db=this.#connection();toolName(name);toolVersion(version);
    actor=maintenanceText(actor,'actor');reason=maintenanceText(reason,'reason',1000);
    must(!this.#readOnly,'Tool registry is read-only');
    must(this.#version===SCHEMA_VERSION,'Rollback requires schema v4; reopen with migrate: true');
    must(verifyEvidence===undefined||typeof verifyEvidence==='function','verifyEvidence must be a synchronous function');
    db.exec('BEGIN IMMEDIATE');
    try{
      const target=this.getToolVersion(name,version),source=this.getActiveTool(name);
      must(target&&['active','inactive'].includes(target.state)&&target.runtimeState==='retained','Unknown retained rollback target');
      must(source&&source.toolId===target.toolId,'Rollback tool identity differs from current active version');
      if(verifyEvidence){const result=verifyEvidence();must(!result||typeof result.then!=='function','Evidence verification must be synchronous');}
      if(source.version!==version){
        const now=new Date().toISOString();
        db.prepare("UPDATE tool_versions SET state='inactive',updated_at=? WHERE tool_name=? AND state='active'").run(now,name);
        db.prepare("UPDATE tool_versions SET state='active',updated_at=? WHERE tool_name=? AND version=?").run(now,name,version);
        db.prepare(`INSERT INTO tool_events (proposal_id,event_type,actor,tool_name,details_json,created_at)
          VALUES (?,'tool_rolled_back',?,?,?,?)`).run(target.proposalId,actor,name,
            JSON.stringify({toolId:target.toolId,fromVersion:source.version,toVersion:version,reason}),now);
      }
      db.exec('COMMIT');
    }catch(error){
      try{db.exec('ROLLBACK');}catch(rollbackError){
        if(!rollbackError.message.includes('no transaction is active')){this.close();throw new AggregateError([error,rollbackError],'Tool rollback transaction failed; registry closed',{cause:error});}
      }
      throw error;
    }
    return this.getToolVersion(name,version);
  }

  getActiveTool(name) {
    const db = this.#connection(); toolName(name);
    if (this.#version < 3) return undefined;
    return versionRow(db.prepare("SELECT * FROM tool_versions WHERE tool_name = ? AND state = 'active'").get(name));
  }

  listToolVersions(name) {
    const db = this.#connection(); if (name !== undefined) toolName(name);
    if (this.#version < 3) return [];
    return (name === undefined ? db.prepare('SELECT * FROM tool_versions ORDER BY tool_name, version').all() :
      db.prepare('SELECT * FROM tool_versions WHERE tool_name = ? ORDER BY version').all(name)).map(versionRow);
  }

  listActiveTools() {
    const db = this.#connection();
    if (this.#version < 3) return [];
    return db.prepare("SELECT * FROM tool_versions WHERE state = 'active' ORDER BY tool_name").all().map(versionRow);
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
