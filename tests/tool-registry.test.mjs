import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync,
  lstatSync, linkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../packages/capability-platform/tool-registry.mjs';

const ID = 'e16f631d-6899-4ed7-87bf-c28e22b8f43e';
const OTHER_ID = 'b36a5aba-3724-4c43-ab46-4f45b04eae11';
const SHA = 'a'.repeat(64);
const IMAGE = `sha256:${'b'.repeat(64)}`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sirna-tool-registry-'));
  const databasePath = join(root, 'registry.sqlite');
  const handles = [];
  t.after(() => {
    for (const handle of handles.reverse()) handle.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, databasePath,
    open: (options) => {
      const registry = new ToolRegistry(databasePath, options);
      handles.push(registry);
      return registry;
    },
    raw: () => {
      const db = new DatabaseSync(databasePath);
      handles.push(db);
      return db;
    },
    input: (fields = {}) => ({ id: ID, toolName: 'sequence_summary',
      artifactPath: join(root, 'proposals', ID), artifactSha256: SHA,
      permissionProfile: 'no_external_access', imageDigest: IMAGE, ...fields }),
  };
}

test('submitted proposal and its event survive independent reopening without claiming verification', t => {
  const f = fixture(t);
  const registry = f.open();
  const result = registry.registerProposal(f.input());
  assert.deepEqual(Object.keys(result).sort(), ['id', 'toolName', 'state', 'artifactPath',
    'artifactSha256', 'permissionProfile', 'imageDigest', 'createdAt', 'updatedAt'].sort());
  assert.deepEqual(result, { ...f.input(), state: 'submitted',
    createdAt: result.createdAt, updatedAt: result.createdAt });
  assert.match(result.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  registry.close();
  const reopened = f.open();
  assert.deepEqual(reopened.getProposal(ID), result);
  assert.deepEqual(reopened.listProposals(), [result]);
  const [event] = reopened.listEvents(ID);
  assert.deepEqual(event, { id: 1, proposalId: ID, eventType: 'proposal_submitted',
    actor: 'local-cli', toolName: 'sequence_summary',
    details: { proposalId: ID, artifactSha256: SHA }, createdAt: result.createdAt });
  assert.equal(reopened.getProposal(OTHER_ID), undefined);
  assert.deepEqual(reopened.listEvents(OTHER_ID), []);
});

test('separate connections observe committed proposals and same tool name allows multiple UUIDs', t => {
  const f = fixture(t); const first = f.open(); const second = f.open();
  first.registerProposal(f.input());
  second.registerProposal(f.input({ id: OTHER_ID }), { actor: "operator's local-cli" });
  assert.equal(first.listProposals().length, 2);
  assert.equal(second.getProposal(ID).state, 'submitted');
  assert.equal(first.listEvents(OTHER_ID)[0].actor, "operator's local-cli");
  assert.equal(first.listEvents(OTHER_ID)[0].id, 2);
});

test('duplicate UUID fails without replacing its proposal or adding an event', t => {
  const f = fixture(t); const registry = f.open();
  const original = registry.registerProposal(f.input());
  assert.throws(() => registry.registerProposal(f.input({ toolName: 'other_tool' })));
  assert.deepEqual(registry.getProposal(ID), original);
  assert.equal(registry.listEvents(ID).length, 1);
});

test('event insertion failure rolls back the proposal and leaves the connection usable', t => {
  const f = fixture(t); const registry = f.open(); const db = f.raw();
  db.exec("CREATE TRIGGER deny_event BEFORE INSERT ON tool_events BEGIN SELECT RAISE(ABORT, 'event denied'); END");
  assert.throws(() => registry.registerProposal(f.input()), /event denied/);
  assert.equal(registry.getProposal(ID), undefined);
  assert.deepEqual(registry.listProposals(), []);
  assert.deepEqual(registry.listEvents(ID), []);
  db.exec('DROP TRIGGER deny_event');
  registry.registerProposal(f.input());
  assert.equal(registry.listEvents(ID).length, 1);
});

test('list limits are bounded and ties sort by UUID descending after creation time', t => {
  const f = fixture(t); const registry = f.open();
  registry.registerProposal(f.input());
  registry.registerProposal(f.input({ id: OTHER_ID }));
  const third = 'a36a5aba-3724-4c43-ab46-4f45b04eae11';
  registry.registerProposal(f.input({ id: third }));
  const db = f.raw();
  db.prepare('UPDATE tool_proposals SET created_at = ? WHERE id IN (?, ?)')
    .run('2025-01-01T00:00:00.000Z', ID, OTHER_ID);
  db.prepare('UPDATE tool_proposals SET created_at = ? WHERE id = ?')
    .run('2025-01-02T00:00:00.000Z', third);
  assert.deepEqual(registry.listProposals(2).map(p => p.id), [third, ID]);
  assert.equal(registry.listProposals(1000).length, 3);
  for (const limit of [0, -1, 1001, 1.5, '1', null, NaN, Infinity]) {
    assert.throws(() => registry.listProposals(limit), /limit/i);
  }
});

const invalidInputs = [
  ['unknown state', value => ({ ...value, state: 'verified' })],
  ['unknown validation', value => ({ ...value, validation: { passed: true } })],
  ['unknown version', value => ({ ...value, version: '1.0.0' })],
  ['missing field', value => { delete value.artifactSha256; return value; }],
  ['invalid UUID', value => ({ ...value, id: 'not-a-uuid' })],
  ['invalid UUID variant', value => ({ ...value, id: 'e16f631d-6899-4ed7-17bf-c28e22b8f43e' })],
  ['newline after UUID', value => ({ ...value, id: `${value.id}\n` })],
  ['uppercase tool name', value => ({ ...value, toolName: 'SequenceSummary' })],
  ['newline after tool name', value => ({ ...value, toolName: 'sequence_summary\n' })],
  ['long tool name', value => ({ ...value, toolName: 'a'.repeat(65) })],
  ['SQL in tool name', value => ({ ...value, toolName: "tool'); DROP TABLE tool_events; --" })],
  ['relative artifact path', value => ({ ...value, artifactPath: 'proposals/id' })],
  ['NUL in artifact path', value => ({ ...value, artifactPath: `${value.artifactPath}\0tail` })],
  ['short SHA256', value => ({ ...value, artifactSha256: 'a'.repeat(63) })],
  ['uppercase SHA256', value => ({ ...value, artifactSha256: 'A'.repeat(64) })],
  ['newline after SHA256', value => ({ ...value, artifactSha256: `${SHA}\n` })],
  ['invalid permission', value => ({ ...value, permissionProfile: 'unrestricted' })],
  ['mutable image name', value => ({ ...value, imageDigest: 'node:latest' })],
  ['uppercase image digest', value => ({ ...value, imageDigest: `sha256:${'B'.repeat(64)}` })],
  ['newline after image digest', value => ({ ...value, imageDigest: `${IMAGE}\n` })],
  ['custom prototype', value => Object.assign(Object.create({ ignored: true }), value)],
  ['symbol field', value => ({ ...value, [Symbol('state')]: 'verified' })],
  ['array', () => []], ['null', () => null],
];
for (const [label, corrupt] of invalidInputs) {
  test(`rejects ${label} before writing proposal or event`, t => {
    const f = fixture(t); const registry = f.open();
    assert.throws(() => registry.registerProposal(corrupt(f.input())));
    assert.deepEqual(registry.listProposals(), []);
    assert.equal(f.raw().prepare('SELECT COUNT(*) AS count FROM tool_events').get().count, 0);
  });
}

test('rejects accessors and proxies without invoking user-defined input behavior', t => {
  const f = fixture(t); const registry = f.open(); let calls = 0;
  const input = f.input();
  Object.defineProperty(input, 'toolName', { get() { calls++; return 'bad'; }, enumerable: true });
  assert.throws(() => registry.registerProposal(input));
  const proxy = new Proxy(f.input(), { ownKeys() { calls++; throw new Error('trap called'); } });
  assert.throws(() => registry.registerProposal(proxy));
  assert.equal(calls, 0);
  assert.deepEqual(registry.listProposals(), []);
});

test('all three permission profiles are accepted as declared metadata', t => {
  const f = fixture(t); const registry = f.open();
  for (const permissionProfile of ['no_external_access', 'controlled_network', 'controlled_software']) {
    const proposal = registry.registerProposal(f.input({ id: randomUUID(), permissionProfile }));
    assert.equal(proposal.permissionProfile, permissionProfile);
    assert.equal(proposal.state, 'submitted');
  }
});

test('invalid actors and query UUIDs are rejected', t => {
  const f = fixture(t); const registry = f.open();
  for (const actor of ['', ' ', 'a'.repeat(129), 'line\nbreak', 'NUL\0tail', null, 42]) {
    assert.throws(() => registry.registerProposal(f.input(), { actor }), /actor/i);
  }
  for (const id of ['', "' OR 1=1 --", null, 123, '00000000-0000-0000-0000-000000000000']) {
    assert.throws(() => registry.getProposal(id), /id|uuid/i);
    assert.throws(() => registry.listEvents(id), /id|uuid/i);
  }
  assert.deepEqual(registry.listProposals(), []);
});

test('read-only mode can query existing data but cannot register, and never creates a missing database', t => {
  const f = fixture(t); const writable = f.open();
  const proposal = writable.registerProposal(f.input());
  writable.close();
  const readonly = f.open({ readOnly: true });
  assert.deepEqual(readonly.getProposal(ID), proposal);
  assert.equal(readonly.listEvents(ID).length, 1);
  assert.throws(() => readonly.registerProposal(f.input({ id: OTHER_ID })), /read.?only/i);
  assert.equal(readonly.getProposal(OTHER_ID), undefined);
  const missing = join(f.root, 'missing.sqlite');
  assert.throws(() => new ToolRegistry(missing, { readOnly: true }));
  assert.equal(existsSync(missing), false);
});

test('new databases use the dedicated identity, schema, state constraint, foreign keys, and WAL', t => {
  const f = fixture(t); f.open(); const db = f.raw();
  assert.equal(db.prepare('PRAGMA application_id').get().application_id, 1397903433);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.throws(() => db.prepare(`INSERT INTO tool_proposals
    (id, tool_name, state, artifact_path, artifact_sha256, permission_profile, image_digest, created_at, updated_at)
    VALUES (?, ?, 'published', ?, ?, ?, ?, ?, ?)`).run(ID, 'sequence_summary', f.root, SHA,
    'no_external_access', IMAGE, '2026-01-01', '2026-01-01'), /CHECK/);
  assert.equal(db.prepare('PRAGMA foreign_key_list(tool_events)').all()[0].table, 'tool_proposals');
});

for (const [applicationId, version] of [[0, 0], [1397903433, 4], [1, 1]]) {
  test(`unknown database identity ${applicationId}/${version} is unchanged in both open modes`, t => {
    const f = fixture(t); const db = new DatabaseSync(f.databasePath);
    db.exec(`CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('untouched');
      PRAGMA application_id = ${applicationId}; PRAGMA user_version = ${version}`);
    db.close();
    const before = readFileSync(f.databasePath);
    for (const readOnly of [false, true]) {
      assert.throws(() => new ToolRegistry(f.databasePath, { readOnly }), /identity|recogniz|version|registry/i);
      assert.deepEqual(readFileSync(f.databasePath), before);
      assert.equal(existsSync(`${f.databasePath}-wal`), false);
      assert.equal(existsSync(`${f.databasePath}-journal`), false);
    }
  });
}

test('preexisting empty or non-SQLite files are never initialized or overwritten', t => {
  const f = fixture(t);
  for (const bytes of [Buffer.alloc(0), Buffer.from('not a database')]) {
    writeFileSync(f.databasePath, bytes);
    assert.throws(() => new ToolRegistry(f.databasePath));
    assert.deepEqual(readFileSync(f.databasePath), bytes);
  }
});

test('requires explicit absolute path and an existing ordinary parent directory', t => {
  const f = fixture(t);
  for (const path of [undefined, null, '', ':memory:', 'relative.sqlite', `${f.databasePath}\0tail`]) {
    assert.throws(() => new ToolRegistry(path), /path|absolute/i);
  }
  const missingParent = join(f.root, 'missing', 'registry.sqlite');
  assert.throws(() => new ToolRegistry(missingParent));
  assert.equal(existsSync(join(f.root, 'missing')), false);
  const fileParent = join(f.root, 'file'); writeFileSync(fileParent, 'x');
  assert.throws(() => new ToolRegistry(join(fileParent, 'registry.sqlite')));
  mkdirSync(f.databasePath);
  assert.throws(() => new ToolRegistry(f.databasePath), /file|regular|directory/i);
});

test('rejects multiply linked database files before opening', t => {
  const f = fixture(t); f.open().close();
  const alias = join(f.root, 'registry-alias.sqlite'); linkSync(f.databasePath, alias);
  const before = readFileSync(f.databasePath);
  assert.throws(() => new ToolRegistry(f.databasePath), /link/i);
  assert.deepEqual(readFileSync(f.databasePath), before);
});

for (const suffix of ['-wal', '-shm', '-journal']) {
  test(`rejects multiply linked ${suffix} sidecar even for a new database`, t => {
    const f = fixture(t); const target = join(f.root, 'target');
    writeFileSync(target, 'do not touch'); linkSync(target, `${f.databasePath}${suffix}`);
    assert.throws(() => new ToolRegistry(f.databasePath), /link/i);
    assert.equal(existsSync(f.databasePath), false);
    assert.equal(readFileSync(target, 'utf8'), 'do not touch');
  });
}

function createSymlinkOrSkip(t, target, path, type) {
  try { symlinkSync(target, path, type); return true; }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows symlink privilege unavailable'); return false;
    }
    throw error;
  }
}

test('rejects symlink database and symlink parents including ancestor aliases', t => {
  const f = fixture(t); f.open().close();
  const alias = join(f.root, 'alias.sqlite');
  if (!createSymlinkOrSkip(t, f.databasePath, alias, 'file')) return;
  assert.throws(() => new ToolRegistry(alias), /link|real|canonical/i);
  const actual = join(f.root, 'actual'); mkdirSync(actual); mkdirSync(join(actual, 'nested'));
  const parentAlias = join(f.root, 'parent-alias');
  if (!createSymlinkOrSkip(t, actual, parentAlias, 'dir')) return;
  assert.throws(() => new ToolRegistry(join(parentAlias, 'new.sqlite')), /link|real|canonical/i);
  assert.throws(() => new ToolRegistry(join(parentAlias, 'nested', 'new.sqlite')), /link|real|canonical/i);
  assert.equal(existsSync(join(actual, 'new.sqlite')), false);
});

for (const suffix of ['-wal', '-shm', '-journal']) {
  test(`rejects symbolic ${suffix} sidecar`, t => {
    const f = fixture(t); const target = join(f.root, 'target'); writeFileSync(target, 'untouched');
    if (!createSymlinkOrSkip(t, target, `${f.databasePath}${suffix}`, 'file')) return;
    assert.throws(() => new ToolRegistry(f.databasePath), /link/i);
    assert.equal(existsSync(f.databasePath), false);
    assert.equal(readFileSync(target, 'utf8'), 'untouched');
  });
}

test('new SQLite files are private on Linux', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t); f.open();
  assert.equal(lstatSync(f.databasePath).mode & 0o777, 0o600);
});

test('close is idempotent and operations after close fail clearly', t => {
  const f = fixture(t); const registry = f.open();
  registry.close(); registry.close();
  assert.throws(() => registry.listProposals(), /closed/i);
});

test('transaction-level trigger rollback preserves the event failure and permits retry', t => {
  const f = fixture(t); const registry = f.open(); const db = f.raw();
  db.exec("CREATE TRIGGER deny_transaction BEFORE INSERT ON tool_events BEGIN SELECT RAISE(ROLLBACK, 'event denied'); END");
  assert.throws(() => registry.registerProposal(f.input()), /event denied/);
  assert.deepEqual(registry.listProposals(), []);
  assert.deepEqual(registry.listEvents(ID), []);
  db.exec('DROP TRIGGER deny_transaction');
  assert.equal(registry.registerProposal(f.input()).state, 'submitted');
});

test('options reject accessors and invalid readOnly values without creating a database', t => {
  const f = fixture(t); let calls = 0;
  for (const readOnly of [null, 'false', 0, 1]) {
    assert.throws(() => new ToolRegistry(f.databasePath, { readOnly }), /readOnly/i);
  }
  const options = { get readOnly() { calls++; return false; } };
  assert.throws(() => new ToolRegistry(f.databasePath, options));
  assert.equal(calls, 0);
  assert.equal(existsSync(f.databasePath), false);
});

test('Windows drive-root-relative paths do not count as explicit absolute paths', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  assert.throws(() => new ToolRegistry(f.databasePath.slice(2)), /absolute|path/i);
  const registry = f.open();
  assert.throws(() => registry.registerProposal(f.input({ artifactPath: f.root.slice(2) })), /absolute|path/i);
  assert.deepEqual(registry.listProposals(), []);
});

test('explicit undefined actor uses the documented local-cli default', t => {
  const f = fixture(t); const registry = f.open();
  registry.registerProposal(f.input(), { actor: undefined });
  assert.equal(registry.listEvents(ID)[0].actor, 'local-cli');
});

test('Windows junction parents and their ancestor aliases are rejected', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); const actual = join(f.root, 'actual');
  mkdirSync(actual); mkdirSync(join(actual, 'nested'));
  const alias = join(f.root, 'alias'); symlinkSync(actual, alias, 'junction');
  assert.throws(() => new ToolRegistry(join(alias, 'new.sqlite')), /link|real|canonical/i);
  assert.throws(() => new ToolRegistry(join(alias, 'nested', 'new.sqlite')), /link|real|canonical/i);
  assert.equal(existsSync(join(actual, 'new.sqlite')), false);
});
