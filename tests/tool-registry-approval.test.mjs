import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../packages/capability-platform/tool-registry.mjs';

const PROPOSAL = 'e16f631d-6899-4ed7-87bf-c28e22b8f43e';
const VALIDATION = 'b36a5aba-3724-4c43-ab46-4f45b04eae11';
const TOOL = 'a36a5aba-3724-4c43-ab46-4f45b04eae11';
const SHA = 'a'.repeat(64), REPORT = 'b'.repeat(64), PACKAGE = 'c'.repeat(64);
const IMAGE = `sha256:${'d'.repeat(64)}`;
const APPROVED_AT = '2026-10-20T01:02:03.000Z';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sirna-registry-approval-'));
  const path = join(root, 'registry.sqlite'), handles = [];
  t.after(() => {
    for (const handle of handles.reverse()) if (!(handle instanceof DatabaseSync) || handle.isOpen) handle.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, path,
    open(options) { const r = new ToolRegistry(path, options); handles.push(r); return r; },
    raw() { const db = new DatabaseSync(path); handles.push(db); return db; },
    proposal(fields = {}) { return { id: PROPOSAL, toolName: 'sequence_summary',
      artifactPath: join(root, 'proposal'), artifactSha256: SHA,
      permissionProfile: 'no_external_access', imageDigest: IMAGE, ...fields }; },
    validation(fields = {}) { return { id: VALIDATION, proposalId: PROPOSAL, passed: true,
      reportPath: join(root, 'report.json'), reportSha256: REPORT, ...fields }; },
    activation(fields = {}) { return { toolId: TOOL, toolName: 'sequence_summary', version: '1.0.0',
      proposalId: PROPOSAL, packageDirectory: `${TOOL}-1.0.0`, packageSha256: PACKAGE,
      imageDigest: IMAGE, approvedBy: "hanwen's approval", approvedAt: APPROVED_AT,
      validationId: VALIDATION, reportSha256: REPORT, artifactSha256: SHA, ...fields }; },
    verified() { const r = this.open(); r.registerProposal(this.proposal()); r.recordValidation(this.validation()); return r; },
  };
}

test('activation persists the first active version, approved proposal and auditable event on reopen', t => {
  const f = fixture(t), r = f.verified();
  assert.equal(typeof r.activateVersion, 'function');
  const row = r.activateVersion(f.activation());
  const expected = { toolId: TOOL, toolName: 'sequence_summary', version: '1.0.0', state: 'active',
    proposalId: PROPOSAL, packageDirectory: `${TOOL}-1.0.0`, packageSha256: PACKAGE,
    imageDigest: IMAGE, runtimeState: 'retained', approvedBy: "hanwen's approval",
    approvedAt: APPROVED_AT, updatedAt: APPROVED_AT };
  assert.deepEqual(row, expected); r.close();
  const read = f.open({ readOnly: true });
  assert.deepEqual(read.getToolVersion('sequence_summary', '1.0.0'), expected);
  assert.deepEqual(read.getActiveTool('sequence_summary'), expected);
  assert.deepEqual(read.listToolVersions(), [expected]);
  assert.deepEqual(read.listToolVersions('sequence_summary'), [expected]);
  assert.deepEqual(read.listActiveTools(), [expected]);
  assert.equal(read.getProposal(PROPOSAL).state, 'approved');
  assert.equal(read.getProposal(PROPOSAL).updatedAt, APPROVED_AT);
  assert.deepEqual(read.listEvents(PROPOSAL)[2], { id: 3, proposalId: PROPOSAL,
    eventType: 'version_activated', actor: "hanwen's approval", toolName: 'sequence_summary',
    details: { proposalId: PROPOSAL, toolId: TOOL, version: '1.0.0', packageSha256: PACKAGE, imageDigest: IMAGE },
    createdAt: APPROVED_AT });
  assert.equal(read.getToolVersion('missing', '1.0.0'), undefined);
  assert.equal(read.getActiveTool('missing'), undefined);
  assert.deepEqual(read.listToolVersions('missing'), []);
  assert.throws(() => read.activateVersion(f.activation()), /read.only/i);
});

for (const [label, prepare, change] of [
  ['unvalidated', () => {}, {}],
  ['failed validation', (r, f) => r.recordValidation(f.validation({ passed: false })), {}],
  ['stale validation', (r, f) => { r.recordValidation(f.validation()); r.recordValidation(f.validation({ id: randomUUID() })); }, {}],
  ['report digest mismatch', (r, f) => r.recordValidation(f.validation()), { reportSha256: SHA }],
  ['artifact digest mismatch', (r, f) => r.recordValidation(f.validation()), { artifactSha256: REPORT }],
  ['tool name mismatch', (r, f) => r.recordValidation(f.validation()), { toolName: 'other_tool' }],
  ['image mismatch', (r, f) => r.recordValidation(f.validation()), { imageDigest: `sha256:${SHA}` }],
  ['missing proposal', (r, f) => r.recordValidation(f.validation()), { proposalId: randomUUID() }],
]) test(`activation rejects ${label} without a partial version, state change or event`, t => {
  const f = fixture(t), r = f.open(); r.registerProposal(f.proposal()); prepare(r, f);
  const before = r.getProposal(PROPOSAL), events = r.listEvents(PROPOSAL);
  assert.throws(() => r.activateVersion(f.activation(change)));
  assert.deepEqual(r.getProposal(PROPOSAL), before);
  assert.deepEqual(r.listEvents(PROPOSAL), events);
  assert.deepEqual(r.listToolVersions(), []);
});

for (const rollback of ['ABORT', 'ROLLBACK']) test(`event ${rollback} undoes version insertion and approval then allows retry`, t => {
  const f = fixture(t), r = f.verified(), before = r.getProposal(PROPOSAL), raw = f.raw();
  raw.exec(`CREATE TRIGGER deny_activation BEFORE INSERT ON tool_events WHEN NEW.event_type = 'version_activated'
    BEGIN SELECT RAISE(${rollback}, 'approval denied'); END`);
  assert.throws(() => r.activateVersion(f.activation()), /approval denied/);
  assert.deepEqual(r.getProposal(PROPOSAL), before);
  assert.deepEqual(r.listActiveTools(), []);
  assert.equal(r.listEvents(PROPOSAL).length, 2);
  raw.exec('DROP TRIGGER deny_activation');
  assert.equal(r.activateVersion(f.activation()).state, 'active');
});

test('low-level activation rejects repetition and a second same-name proposal without replacement', t => {
  const f = fixture(t), r = f.verified(), other = f.open();
  const first = r.activateVersion(f.activation());
  assert.throws(() => other.activateVersion(f.activation()), /state|approved|exist|version/i);
  const id = randomUUID(), validationId = randomUUID(), toolId = randomUUID();
  other.registerProposal(f.proposal({ id })); other.recordValidation(f.validation({ id: validationId, proposalId: id }));
  assert.throws(() => other.activateVersion(f.activation({ proposalId: id, validationId,
    toolId, packageDirectory: `${toolId}-1.0.0` })), /exist|first|name|version/i);
  assert.deepEqual(r.listActiveTools(), [first]);
  assert.equal(r.getProposal(id).state, 'verified');
  assert.equal(r.listEvents(id).length, 2);
  assert.equal(r.listEvents(PROPOSAL).length, 3);
});

const invalid = [
  ['same proposal/tool identity', v => ({ ...v, toolId: PROPOSAL, packageDirectory: `${PROPOSAL}-1.0.0` })],
  ['replacement version', v => ({ ...v, version: '1.0.1' })],
  ['absolute package path', v => ({ ...v, packageDirectory: join(tmpdir(), `${TOOL}-1.0.0`) })],
  ['package traversal', v => ({ ...v, packageDirectory: `../${TOOL}-1.0.0` })],
  ['different package identity', v => ({ ...v, packageDirectory: `${PROPOSAL}-1.0.0` })],
  ['bad tool id', v => ({ ...v, toolId: 'not-a-uuid' })],
  ['bad validation id', v => ({ ...v, validationId: 'not-a-uuid' })],
  ['bad package digest', v => ({ ...v, packageSha256: 'A'.repeat(64) })],
  ['bad report digest', v => ({ ...v, reportSha256: 'bad' })],
  ['empty approver', v => ({ ...v, approvedBy: ' ' })],
  ['long approver', v => ({ ...v, approvedBy: 'a'.repeat(121) })],
  ['control approver', v => ({ ...v, approvedBy: 'a\nb' })],
  ['bad timestamp', v => ({ ...v, approvedAt: '2026-02-30T01:02:03.000Z' })],
  ['missing binding', v => { delete v.validationId; return v; }],
  ['extra state', v => ({ ...v, state: 'active' })],
];
for (const [label, corrupt] of invalid) test(`activation rejects ${label} before mutation`, t => {
  const f = fixture(t), r = f.verified();
  assert.throws(() => r.activateVersion(corrupt(f.activation())));
  assert.equal(r.getProposal(PROPOSAL).state, 'verified');
  assert.equal(r.listEvents(PROPOSAL).length, 2);
});

test('activation rejects accessors/proxies without invoking them and bounds name/version queries', t => {
  const f = fixture(t), r = f.verified(); let calls = 0;
  const input = f.activation(); Object.defineProperty(input, 'toolId', { enumerable: true, get() { calls++; return TOOL; } });
  assert.throws(() => r.activateVersion(input));
  assert.throws(() => r.activateVersion(new Proxy(f.activation(), { ownKeys() { calls++; return []; } })));
  assert.equal(calls, 0);
  for (const name of [null, '', 'bad-name', "name'); DROP TABLE tool_versions; --"]) {
    assert.throws(() => r.getActiveTool(name)); assert.throws(() => r.listToolVersions(name));
    assert.throws(() => r.getToolVersion(name, '1.0.0'));
  }
  assert.throws(() => r.getToolVersion('sequence_summary', '2.0.0'));
  assert.deepEqual(r.listActiveTools(), []);
});

// Independent historical DDL avoids letting production schema creation hide a migration defect.
function legacy(f, version) {
  const db = f.raw();
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE tool_proposals (id TEXT PRIMARY KEY NOT NULL, tool_name TEXT NOT NULL, state TEXT NOT NULL,
      artifact_path TEXT NOT NULL, artifact_sha256 TEXT NOT NULL, permission_profile TEXT NOT NULL,
      image_digest TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ${version === 2 ? ', latest_validation_id TEXT REFERENCES tool_validations(id)' : ''});
    CREATE TABLE tool_events (id INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id TEXT NOT NULL REFERENCES tool_proposals(id),
      event_type TEXT NOT NULL, actor TEXT NOT NULL, tool_name TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL);
    ${version === 2 ? `CREATE TABLE tool_validations (id TEXT PRIMARY KEY NOT NULL,
      proposal_id TEXT NOT NULL REFERENCES tool_proposals(id), passed INTEGER NOT NULL CHECK (passed IN (0,1)),
      report_path TEXT NOT NULL, report_sha256 TEXT NOT NULL, created_at TEXT NOT NULL);` : ''}
    PRAGMA application_id = 1397903433; PRAGMA user_version = ${version};`);
  db.prepare(`INSERT INTO tool_proposals (id, tool_name, state, artifact_path, artifact_sha256,
    permission_profile, image_digest, created_at, updated_at) VALUES (?, 'sequence_summary', 'submitted', ?, ?,
    'no_external_access', ?, '2026-01-01', '2026-01-01')`).run(PROPOSAL, f.proposal().artifactPath, SHA, IMAGE);
  return db;
}

for (const version of [1, 2]) test(`v${version} reads stay unmigrated and explicit upgrade retains a WAL-consistent backup`, t => {
  const f = fixture(t), db = legacy(f, version);
  const old = f.open();
  if (version === 2) old.recordValidation(f.validation());
  for (const options of [{ readOnly: true }, { readOnly: true, migrate: true }, {}]) {
    const reader = f.open(options);
    assert.deepEqual(reader.listToolVersions(), []); assert.deepEqual(reader.listActiveTools(), []);
    assert.equal(reader.getActiveTool('sequence_summary'), undefined);
    assert.equal(reader.getToolVersion('sequence_summary', '1.0.0'), undefined);
    assert.throws(() => reader.activateVersion(f.activation()), /schema|migrat|read.only/i);
    reader.close();
  }
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
  assert.equal(readdirSync(f.root).filter(n => n.includes('-backup-')).length, 0);
  old.close();
  const upgraded = f.open({ migrate: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  const backups = readdirSync(f.root).filter(n => n.includes(`.v${version}-backup-`));
  assert.equal(backups.length, 1);
  const backupPath = join(f.root, backups[0]);
  if (process.platform !== 'win32') assert.equal(lstatSync(backupPath).mode & 0o777, 0o600);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, version);
    assert.equal(backup.prepare('SELECT id FROM tool_proposals').get().id, PROPOSAL);
    assert.equal(backup.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'tool_versions'").get().n, 0);
    if (version === 2) assert.equal(backup.prepare('SELECT report_sha256 FROM tool_validations').get().report_sha256, REPORT);
  } finally { backup.close(); }
  if (version === 1) upgraded.recordValidation(f.validation());
  assert.equal(upgraded.activateVersion(f.activation()).state, 'active');
  upgraded.close(); f.open({ migrate: true }).close();
  assert.equal(readdirSync(f.root).filter(n => n.includes('-backup-')).length, 1);
});

test('v2 migration failure leaves its committed validation and layout intact with backup retained', t => {
  const f = fixture(t), db = legacy(f, 2), r = f.open(); r.recordValidation(f.validation()); r.close();
  db.exec('CREATE TABLE tool_versions (sentinel TEXT)');
  assert.throws(() => f.open({ migrate: true }), /migration|exist/i);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(db.prepare('SELECT report_sha256 FROM tool_validations').get().report_sha256, REPORT);
  assert.deepEqual(db.prepare('PRAGMA table_info(tool_versions)').all().map(c => c.name), ['sentinel']);
  assert.equal(readdirSync(f.root).filter(n => n.includes('.v2-backup-')).length, 1);
});

test('unknown v3 layout is rejected before writes or backups', t => {
  const f = fixture(t), db = legacy(f, 2); db.exec('PRAGMA user_version = 3'); db.close();
  const before = readFileSync(f.path);
  for (const readOnly of [false, true]) assert.throws(() => f.open({ readOnly, migrate: true }), /layout|schema|recogniz/i);
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(readdirSync(f.root).filter(n => n.includes('-backup-')).length, 0);
});

test('v3 registry missing a first-version unique constraint is rejected without adopting its layout', t => {
  const f = fixture(t), r = f.verified(); r.close();
  const db = f.raw(); db.exec('DROP INDEX tool_versions_name'); db.close();
  const before = readFileSync(f.path);
  for (const readOnly of [true, false]) assert.throws(() => f.open({ readOnly, migrate: true }), /schema|index|constraint|recogniz/i);
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(readdirSync(f.root).filter(n => n.includes('-backup-')).length, 0);
});

for (const [label, sql] of [
  ['absent latest record', 'DELETE FROM tool_validations'],
  ['latest record belongs to another proposal', 'UPDATE tool_validations SET proposal_id = ?'],
  ['failed latest record with stale verified state', 'UPDATE tool_validations SET passed = 0'],
]) test(`activation rechecks ${label} instead of relying only on proposal state`, t => {
  const f = fixture(t), r = f.verified(), db = f.raw(), id = randomUUID();
  r.registerProposal(f.proposal({ id, toolName: 'another_tool' }));
  db.exec('PRAGMA foreign_keys = OFF'); // Deliberately corrupt persisted evidence as an external writer.
  if (sql.includes('?')) db.prepare(sql).run(id); else db.exec(sql);
  const before = r.getProposal(PROPOSAL);
  assert.throws(() => r.activateVersion(f.activation()), /validation|Latest|passing/i);
  assert.deepEqual(r.getProposal(PROPOSAL), before);
  assert.deepEqual(r.listActiveTools(), []);
  assert.equal(r.listEvents(PROPOSAL).length, 2);
});
