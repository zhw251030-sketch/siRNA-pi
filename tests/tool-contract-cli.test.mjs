import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const command = path.join(root, 'scripts/check-tool-contract.mjs');
const sample = path.join(root, 'examples/04-tool-contract/proposal.draft.json');
const run = (...args) => spawnSync(process.execPath, [command, ...args], { encoding: 'utf8', cwd: root, windowsHide: true });
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function temporary(t) {
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'runtime/contract-cli-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('draft CLI checks the complete real example without claiming execution or activation', () => {
  const before = digest(sample);
  const result = run(sample, '--draft');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.stage, 'draft');
  for (const field of ['executed', 'registered', 'activated', 'runtimeArtifactVerified']) assert.equal(report[field], false);
  assert.equal(digest(sample), before);
  assert.ok(!result.stdout.includes('fs.readFileSync'), 'CLI must not echo script source');
});

test('default CLI exposes the missing real OCI artifact instead of inventing one', () => {
  const result = run(sample);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'mcp');
  assert.equal(report.code, 'TOOL_CONTRACT_INCOMPLETE');
  assert.deepEqual(report.missingFields.map(issue => issue.field), ['/runtimeArtifact']);
  assert.equal(report.registered, false);
});

test('preflight never executes candidate or baseline strings and creates no artifacts', t => {
  const directory = temporary(t);
  const marker = path.join(directory, 'must-not-exist');
  const fixture = JSON.parse(fs.readFileSync(sample));
  const source = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'EXECUTED');`;
  fixture.script = source;
  fixture.baseline.script = source;
  const filename = path.join(directory, 'proposal.json');
  fs.writeFileSync(filename, JSON.stringify(fixture));
  const before = digest(filename);
  const result = spawnSync(process.execPath, [command, filename, '--draft'], { cwd: directory, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(fs.readdirSync(directory), ['proposal.json']);
  assert.equal(digest(filename), before);
  assert.equal(fs.existsSync(marker), false);
  assert.ok(!result.stdout.includes('EXECUTED'));
});

test('CLI reports invalid contract separately from incomplete fields', t => {
  const directory = temporary(t);
  const fixture = JSON.parse(fs.readFileSync(sample));
  fixture.dependencies = [{ manager: 'npm', name: 'some-package', version: 'latest' }];
  const filename = path.join(directory, 'invalid.json');
  fs.writeFileSync(filename, JSON.stringify(fixture));
  const result = run(filename, '--draft');
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).code, 'TOOL_PROPOSAL_INVALID');
});

for (const [name, content] of [['malformed JSON', '{bad'], ['oversized input', ' '.repeat(1_048_577)]]) {
  test(`CLI rejects ${name} without leaking input`, t => {
    const filename = path.join(temporary(t), 'bad.json');
    fs.writeFileSync(filename, content);
    const result = run(filename);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'PREFLIGHT_INPUT_ERROR');
    assert.ok(result.stdout.length < 1000);
  });
}

test('CLI reports a missing file and rejects a directory as input', t => {
  const directory = temporary(t);
  for (const filename of [directory, path.join(directory, 'missing.json')]) {
    const result = run(filename);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'PREFLIGHT_INPUT_ERROR');
  }
});

test('CLI rejects unknown options and ambiguous positional files', () => {
  for (const args of [[], ['--execute', sample], [sample, sample], [sample, '--draft', '--draft']]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'PREFLIGHT_INPUT_ERROR');
  }
});
