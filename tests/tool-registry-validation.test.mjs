import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readdirSync, readFileSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../packages/capability-platform/tool-registry.mjs';

const ID = 'e16f631d-6899-4ed7-87bf-c28e22b8f43e';
const FIRST = 'b36a5aba-3724-4c43-ab46-4f45b04eae11';
const SECOND = 'a36a5aba-3724-4c43-ab46-4f45b04eae11';
const SHA = 'a'.repeat(64);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sirna-registry-validation-'));
  const databasePath = join(root, 'registry.sqlite');
  const handles = [];
  t.after(() => {
    for (const handle of handles.reverse()) {
      if (!(handle instanceof DatabaseSync) || handle.isOpen) handle.close();
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, databasePath,
    open(options) { const db = new ToolRegistry(databasePath, options); handles.push(db); return db; },
    raw() { const db = new DatabaseSync(databasePath); handles.push(db); return db; },
    proposal: { id: ID, toolName: 'sequence_summary', artifactPath: join(root, 'proposal'),
      artifactSha256: SHA, permissionProfile: 'no_external_access', imageDigest: `sha256:${SHA}` },
    record: (fields = {}) => ({ id: FIRST, proposalId: ID, passed: true,
      reportPath: join(root, 'report.json'), reportSha256: SHA, ...fields }),
    backups() { return readdirSync(root).filter(name => name.includes('.v1-backup-')).map(name => join(root, name)); },
  };
}

// Independent v1 DDL: using production schema creation would conceal migration bugs.
function legacy(f) {
  const db = f.raw();
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE tool_proposals (
      id TEXT PRIMARY KEY NOT NULL, tool_name TEXT NOT NULL, state TEXT NOT NULL,
      artifact_path TEXT NOT NULL, artifact_sha256 TEXT NOT NULL, permission_profile TEXT NOT NULL,
      image_digest TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tool_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id TEXT NOT NULL REFERENCES tool_proposals(id),
      event_type TEXT NOT NULL, actor TEXT NOT NULL, tool_name TEXT NOT NULL,
      details_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX tool_proposals_created ON tool_proposals(created_at DESC, id DESC);
    CREATE INDEX tool_events_proposal ON tool_events(proposal_id, id);
    PRAGMA application_id = 1397903433; PRAGMA user_version = 1;`);
  db.prepare(`INSERT INTO tool_proposals VALUES (?, 'sequence_summary', 'submitted', ?, ?,
    'no_external_access', ?, '2026-01-01', '2026-01-01')`)
    .run(ID, f.proposal.artifactPath, SHA, `sha256:${SHA}`);
  db.prepare(`INSERT INTO tool_events (proposal_id, event_type, actor, tool_name, details_json, created_at)
    VALUES (?, 'proposal_submitted', 'fixture', 'sequence_summary', '{}', '2026-01-01')`).run(ID);
  return db;
}

test('validation result, latest id, proposal state and validator event survive reopening', t => {
  const f = fixture(t); const registry = f.open(); registry.registerProposal(f.proposal);
  const result = registry.recordValidation(f.record());
  assert.deepEqual(result, { ...f.record(), createdAt: result.createdAt });
  assert.match(result.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  registry.close();
  const reopened = f.open({ readOnly: true });
  assert.deepEqual(reopened.getValidation(FIRST), result);
  assert.deepEqual(reopened.latestValidation(ID), result);
  assert.equal(reopened.getProposal(ID).state, 'verified');
  assert.equal(reopened.getProposal(ID).latestValidationId, FIRST);
  assert.equal(reopened.listProposals()[0].latestValidationId, FIRST);
  const event = reopened.listEvents(ID)[1];
  assert.equal(event.eventType, 'validation_passed');
  assert.equal(event.actor, 'validator');
  assert.equal(event.toolName, 'sequence_summary');
  assert.equal(event.createdAt, result.createdAt);
  assert.equal(event.details.validationId, FIRST);
  assert.equal(event.details.reportSha256, SHA);
  assert.equal(reopened.getValidation(SECOND), undefined);
  assert.equal(reopened.latestValidation(SECOND), undefined);
  assert.throws(() => reopened.recordValidation(f.record({ id: SECOND })), /read.only/i);
});

test('retry can fail then pass and latest follows exact committed id regardless of time ties', t => {
  const f = fixture(t); const registry = f.open(); registry.registerProposal(f.proposal);
  const first = registry.recordValidation(f.record({ passed: false }));
  assert.equal(registry.getProposal(ID).state, 'verification_failed');
  assert.equal(registry.listEvents(ID)[1].eventType, 'validation_failed');
  const second = registry.recordValidation(f.record({ id: SECOND }));
  const raw = f.raw();
  raw.prepare('UPDATE tool_validations SET created_at = ?').run('2026-01-01');
  assert.deepEqual(registry.latestValidation(ID), { ...second, createdAt: '2026-01-01' });
  assert.deepEqual(registry.getValidation(FIRST), { ...first, createdAt: '2026-01-01' });
  assert.equal(registry.getProposal(ID).state, 'verified');
  const third = 'c36a5aba-3724-4c43-ab46-4f45b04eae11';
  registry.recordValidation(f.record({ id: third }));
  assert.equal(registry.latestValidation(ID).id, third);
});

for (const state of ['approved', 'rejected']) {
  test(`validation cannot rewrite terminal ${state} proposal`, t => {
    const f = fixture(t); const registry = f.open(); registry.registerProposal(f.proposal);
    f.raw().prepare('UPDATE tool_proposals SET state = ? WHERE id = ?').run(state, ID);
    assert.throws(() => registry.recordValidation(f.record()), /state|approved|rejected/i);
    assert.equal(registry.getProposal(ID).state, state);
    assert.equal(registry.getValidation(FIRST), undefined);
    assert.equal(registry.listEvents(ID).length, 1);
  });
}

for (const rollback of ['ABORT', 'ROLLBACK']) {
  test(`event trigger ${rollback} rolls back validation index, state and latest id`, t => {
    const f = fixture(t); const registry = f.open(); registry.registerProposal(f.proposal);
    const first = registry.recordValidation(f.record()); const before = registry.getProposal(ID);
    const db = f.raw();
    db.exec(`CREATE TRIGGER deny_validation BEFORE INSERT ON tool_events
      WHEN NEW.actor = 'validator' BEGIN SELECT RAISE(${rollback}, 'event denied'); END`);
    assert.throws(() => registry.recordValidation(f.record({ id: SECOND, passed: false })), /event denied/);
    assert.equal(registry.getValidation(SECOND), undefined);
    assert.deepEqual(registry.latestValidation(ID), first);
    assert.deepEqual(registry.getProposal(ID), before);
    assert.equal(registry.listEvents(ID).length, 2);
    db.exec('DROP TRIGGER deny_validation');
    assert.equal(registry.recordValidation(f.record({ id: SECOND, passed: false })).passed, false);
  });
}

test('duplicate validation id and unknown proposal preserve prior records and events', t => {
  const f = fixture(t); const registry = f.open(); registry.registerProposal(f.proposal);
  const first = registry.recordValidation(f.record()); const before = registry.getProposal(ID);
  assert.throws(() => registry.recordValidation(f.record({ passed: false })), /UNIQUE|duplicate/i);
  assert.throws(() => registry.recordValidation(f.record({ id: SECOND, proposalId: SECOND })), /proposal|exist/i);
  assert.deepEqual(registry.getProposal(ID), before);
  assert.deepEqual(registry.getValidation(FIRST), first);
  assert.equal(registry.listEvents(ID).length, 2);
});

test('ordinary v1 reads never migrate and validation writes require explicit migration', t => {
  const f = fixture(t); const db = legacy(f);
  assert.ok(existsSync(`${f.databasePath}-wal`));
  const before = readFileSync(f.databasePath);
  for (const options of [{ readOnly: true }, { readOnly: true, migrate: true }, {}]) {
    const registry = f.open(options);
    assert.equal(registry.getProposal(ID).state, 'submitted');
    assert.equal(Object.hasOwn(registry.getProposal(ID), 'latestValidationId'), false);
    assert.equal(registry.getValidation(FIRST), undefined);
    assert.equal(registry.latestValidation(ID), undefined);
    assert.throws(() => registry.recordValidation(f.record()), /read.only|migrat|schema/i);
    registry.close();
  }
  assert.deepEqual(readFileSync(f.databasePath), before);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.deepEqual(f.backups(), []);
});

test('explicit v1 migration retains a consistent same-directory v1 backup including committed WAL', t => {
  const f = fixture(t); const db = legacy(f);
  const registry = f.open({ migrate: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(registry.getProposal(ID).state, 'submitted');
  assert.equal(Object.hasOwn(registry.getProposal(ID), 'latestValidationId'), false);
  const backups = f.backups(); assert.equal(backups.length, 1);
  if (process.platform !== 'win32') assert.equal(lstatSync(backups[0]).mode & 0o777, 0o600);
  const backup = new DatabaseSync(backups[0], { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(backup.prepare('SELECT id FROM tool_proposals').get().id, ID);
    assert.equal(backup.prepare('SELECT actor FROM tool_events').get().actor, 'fixture');
    assert.equal(backup.prepare('PRAGMA table_info(tool_proposals)').all().some(c => c.name === 'latest_validation_id'), false);
  } finally { backup.close(); }
  registry.recordValidation(f.record());
  registry.close(); f.open({ migrate: true }).close();
  assert.equal(f.backups().length, 1);
});

test('migration failure rolls back schema alterations and retains the original v1 rows and backup', t => {
  const f = fixture(t); const db = legacy(f);
  db.exec('CREATE TABLE tool_validations (sentinel TEXT); INSERT INTO tool_validations VALUES (\'untouched\')');
  assert.throws(() => f.open({ migrate: true }), /exist|migration/i);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare('PRAGMA table_info(tool_proposals)').all().some(c => c.name === 'latest_validation_id'), false);
  assert.equal(db.prepare('SELECT sentinel FROM tool_validations').get().sentinel, 'untouched');
  assert.equal(db.prepare('SELECT id FROM tool_proposals').get().id, ID);
  assert.equal(f.backups().length, 1);
});

test('unknown schema is rejected even with migrate true without modifying file or creating backups', t => {
  const f = fixture(t); const db = legacy(f); db.exec('PRAGMA user_version = 91'); db.close();
  const before = readFileSync(f.databasePath);
  for (const readOnly of [false, true]) assert.throws(() => f.open({ readOnly, migrate: true }), /version|identity|recogniz/i);
  assert.deepEqual(readFileSync(f.databasePath), before);
  assert.deepEqual(f.backups(), []);
});

for (const version of [1, 2]) {
  test(`matching identity with unknown v${version} table layout is never adopted or migrated`, t => {
    const f = fixture(t); const db = f.raw();
    db.exec(`CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('untouched');
      PRAGMA application_id = 1397903433; PRAGMA user_version = ${version}`);
    db.close(); const before = readFileSync(f.databasePath);
    for (const readOnly of [false, true]) {
      assert.throws(() => f.open({ readOnly, migrate: true }), /schema|recogniz|registry/i);
      assert.deepEqual(readFileSync(f.databasePath), before);
    }
    assert.deepEqual(f.backups(), []);
  });
}

const invalid = [
  ['missing field', v => { delete v.passed; return v; }],
  ['unknown actor', v => ({ ...v, actor: 'operator' })],
  ['unknown createdAt', v => ({ ...v, createdAt: 'forged' })],
  ['invalid id', v => ({ ...v, id: 'invalid' })],
  ['invalid proposalId', v => ({ ...v, proposalId: 'invalid' })],
  ['nonboolean passed', v => ({ ...v, passed: 1 })],
  ['relative path', v => ({ ...v, reportPath: 'relative.json' })],
  ['NUL path', v => ({ ...v, reportPath: `${v.reportPath}\0tail` })],
  ['uppercase sha', v => ({ ...v, reportSha256: 'A'.repeat(64) })],
  ['trailing newline sha', v => ({ ...v, reportSha256: `${SHA}\n` })],
  ['prototype', v => Object.assign(Object.create({}), v)],
  ['symbol field', v => ({ ...v, [Symbol('actor')]: 'operator' })],
  ['array', () => []], ['null', () => null],
];
for (const [label, corrupt] of invalid) {
  test(`validation rejects ${label} without changing SQLite state`, t => {
    const f = fixture(t); const registry = f.open(); registry.registerProposal(f.proposal);
    assert.throws(() => registry.recordValidation(corrupt(f.record())));
    assert.equal(registry.getProposal(ID).state, 'submitted');
    assert.equal(registry.latestValidation(ID), undefined);
    assert.equal(registry.listEvents(ID).length, 1);
  });
}

test('validation input and options reject behavior without invoking getters or proxy traps', t => {
  const f = fixture(t); const registry = f.open(); registry.registerProposal(f.proposal); let calls = 0;
  const value = f.record(); Object.defineProperty(value, 'passed', { enumerable: true, get() { calls++; return true; } });
  assert.throws(() => registry.recordValidation(value));
  assert.throws(() => registry.recordValidation(new Proxy(f.record(), { ownKeys() { calls++; return []; } })));
  const options = { get migrate() { calls++; return true; } };
  assert.throws(() => f.open(options));
  for (const migrate of [null, 0, 1, 'true']) assert.throws(() => f.open({ migrate }), /migrate/i);
  assert.equal(calls, 0);
  assert.equal(registry.listEvents(ID).length, 1);
});
