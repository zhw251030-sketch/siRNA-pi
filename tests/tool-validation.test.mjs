import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedOutputMatches,
  validationRunPassed,
  validationCasePassed,
  validationRunsRepeatable,
  toolValidationContract,
} from '../packages/capability-platform/tool-validation.mjs';

function passedRun(overrides = {}) {
  return {
    exitCode: 0, timedOut: false, cancelled: false, protocolValid: true,
    output: { count: 3, statistics: { total: 27 } },
    stdout: '{"count":3,"statistics":{"total":27}}\n', stderr: '', filesDigest: 'digest-a',
    ...overrides,
  };
}

test('expected objects match literal recursive subsets and permit extra actual keys', () => {
  assert.equal(expectedOutputMatches({ a: 1, b: 2 }, { a: 1 }), true);
  assert.equal(expectedOutputMatches({ result: { count: 3, extra: true } }, { result: { count: 3 } }), true);
  assert.equal(expectedOutputMatches({ result: { count: 4 } }, { result: { count: 3 } }), false);
  assert.equal(expectedOutputMatches({ result: {} }, { result: { count: 3 } }), false);
  assert.equal(expectedOutputMatches({}, {}), true);
  assert.equal(expectedOutputMatches([], {}), false);
  assert.equal(expectedOutputMatches(null, {}), false);
});

test('expected keys must exist on actual itself, including prototype-looking literal keys', () => {
  assert.equal(expectedOutputMatches(Object.create({ count: 3 }), { count: 3 }), false);
  assert.equal(expectedOutputMatches({}, { missing: undefined }), false);
  assert.equal(expectedOutputMatches({}, { toString: Object.prototype.toString }), false);
  assert.equal(expectedOutputMatches(JSON.parse('{"__proto__":{"count":3}}'),
    JSON.parse('{"__proto__":{"count":3}}')), true);
  assert.equal(expectedOutputMatches({}, Object.create({ inheritedExpectation: 1 })), true);
});

test('arrays require equal lengths and order while matching each nested object as a subset', () => {
  assert.equal(expectedOutputMatches([{ a: 1, b: 2 }, 3], [{ a: 1 }, 3]), true);
  assert.equal(expectedOutputMatches([1, 2, 3], [1, 2]), false);
  assert.equal(expectedOutputMatches([1], [1, 2]), false);
  assert.equal(expectedOutputMatches([2, 1], [1, 2]), false);
  assert.equal(expectedOutputMatches({ 0: 1, length: 1 }, [1]), false);
  assert.equal(expectedOutputMatches([], []), true);
});

test('primitive matching uses Object.is without coercion or numeric tolerance', () => {
  assert.equal(expectedOutputMatches('3', 3), false);
  assert.equal(expectedOutputMatches(0, -0), false);
  assert.equal(expectedOutputMatches(NaN, NaN), true);
  assert.equal(expectedOutputMatches(null, null), true);
  assert.equal(expectedOutputMatches(false, false), true);
  assert.equal(expectedOutputMatches(0.30000000000000004, 0.3), false);
});

test('dot keys and assertion-looking objects remain literal data', () => {
  assert.equal(expectedOutputMatches({ result: { count: 3 } }, { 'result.count': 3 }), false);
  assert.equal(expectedOutputMatches({ 'result.count': 3 }, { 'result.count': 3 }), true);
  assert.equal(expectedOutputMatches({ count: 3 }, { count: { minimum: 2 } }), false);
});

test('complete successful run records pass without changing the input', () => {
  const run = Object.freeze(passedRun({ output: Object.freeze({ nested: Object.freeze([1, null, true]) }) }));
  assert.equal(validationRunPassed(run), true);
  assert.equal(validationRunPassed(passedRun({ output: {} })), true);
  assert.equal(validationRunPassed(passedRun({ output: Object.assign(Object.create(null), { count: 3 }) })), true);
});

test('nonzero exits, timeout, cancellation and invalid protocols fail independently', () => {
  for (const overrides of [{ exitCode: 1 }, { exitCode: null }, { timedOut: true },
    { cancelled: true }, { protocolValid: false }]) {
    assert.equal(validationRunPassed(passedRun(overrides)), false, JSON.stringify(overrides));
  }
});

test('status fields must use exact types instead of truthiness', () => {
  for (const overrides of [{ exitCode: '0' }, { timedOut: 0 }, { timedOut: null },
    { cancelled: '' }, { cancelled: null }, { protocolValid: 1 }, { protocolValid: 'true' },
    { stdout: null }, { stderr: 0 }, { filesDigest: {} }]) {
    assert.equal(validationRunPassed(passedRun(overrides)), false, JSON.stringify(overrides));
  }
});

test('every required run field must be explicitly present as an own data property', () => {
  for (const field of ['exitCode', 'timedOut', 'cancelled', 'protocolValid', 'output',
    'stdout', 'stderr', 'filesDigest']) {
    const run = passedRun();
    delete run[field];
    assert.equal(validationRunPassed(run), false, `missing ${field}`);
    const inherited = Object.assign(Object.create({ [field]: passedRun()[field] }), run);
    assert.equal(validationRunPassed(inherited), false, `inherited ${field}`);
  }
});

test('run records and output must be objects and output must contain JSON data', () => {
  for (const value of [null, undefined, 0, false, 'record', []]) {
    assert.equal(validationRunPassed(value), false);
  }
  for (const output of [undefined, null, [], 'object', 3, new Date(0),
    { count: undefined }, { count: Infinity }, { count: NaN }, { count: 3n },
    { count: () => 3 }, { values: [, 3] }]) {
    assert.equal(validationRunPassed(passedRun({ output })), false);
  }
  const circular = {};
  circular.self = circular;
  assert.equal(validationRunPassed(passedRun({ output: circular })), false);
});

test('checking a run does not invoke accessor fields or output serialization methods', () => {
  let invoked = 0;
  const run = passedRun();
  Object.defineProperty(run, 'output', { get() { invoked += 1; return {}; }, enumerable: true });
  assert.equal(validationRunPassed(run), false);
  const output = { toJSON() { invoked += 1; return {}; } };
  assert.equal(validationRunPassed(passedRun({ output })), false);
  assert.equal(invoked, 0);
});

test('output array subclasses cannot bypass JSON checks through inherited serialization hooks', () => {
  let invoked = 0;
  class Altered extends Array {
    toJSON() { invoked += 1; return ['changed']; }
  }
  const run = passedRun({ output: { values: new Altered(1, 2) } });
  assert.equal(validationRunPassed(run), false);
  assert.equal(invoked, 0);
});

test('output arrays require the ordinary Array prototype', () => {
  const values = Object.setPrototypeOf([1, 2], null);
  assert.equal(validationRunPassed(passedRun({ output: { values } })), false);
});

test('a case needs both successful execution and a matching expected subset', () => {
  assert.equal(validationCasePassed(passedRun(), { statistics: { total: 27 } }), true);
  assert.equal(validationCasePassed(passedRun(), { count: 4 }), false);
  assert.equal(validationCasePassed(passedRun({ exitCode: 1 }), { count: 3 }), false);
  assert.equal(validationCasePassed(passedRun({ protocolValid: false }), {}), false);
});

test('exact repeatability defaults to equality of stdout, stderr and file digest', () => {
  assert.equal(validationRunsRepeatable(passedRun(), passedRun()), true);
  assert.equal(validationRunsRepeatable(passedRun(), passedRun(), 'exact'), true);
  for (const overrides of [{ stdout: 'different output' }, { stderr: 'different warning' },
    { filesDigest: 'digest-b' }]) {
    assert.equal(validationRunsRepeatable(passedRun(), passedRun(overrides)), false);
  }
});

test('contract mode relaxes equality of successful run records', () => {
  const changed = passedRun({ output: { count: 4 }, stdout: '{"count":4}',
    stderr: 'changed warning', filesDigest: 'digest-b' });
  assert.equal(validationRunsRepeatable(passedRun(), changed, 'contract'), true);
  assert.equal(validationCasePassed(changed, { count: 3 }), false);
});

test('both repeatability modes still require each run to pass and have complete evidence', () => {
  for (const mode of ['exact', 'contract']) {
    for (const overrides of [{ exitCode: 1 }, { timedOut: true }, { cancelled: true },
      { protocolValid: false }, { output: null }, { stdout: undefined }, { filesDigest: undefined }]) {
      const failed = passedRun(overrides);
      assert.equal(validationRunsRepeatable(failed, passedRun(), mode), false);
      assert.equal(validationRunsRepeatable(passedRun(), failed, mode), false);
      assert.equal(validationRunsRepeatable(failed, failed, mode), false);
    }
  }
});

test('unknown repeatability modes cannot silently become exact mode', () => {
  for (const mode of ['EXACT', 'unknown', '', null, false, {}]) {
    assert.equal(validationRunsRepeatable(passedRun(), passedRun(), mode), false);
  }
});

test('contract metadata is a serializable preflight description, not a validation result', () => {
  const contract = toolValidationContract();
  assert.equal(contract.version, 'sirna-tool-validation-contract/v2');
  assert.equal(contract.stage, 'contract-preflight');
  assert.equal(contract.executed, false);
  assert.equal(contract.expectedOutput.matcher, 'recursive-subset/v1');
  assert.equal(contract.expectedOutput.dotSeparatedKeys, 'literal-keys-not-paths');
  assert.deepEqual(Object.keys(contract.repeatability.supportedModes), ['exact', 'contract']);
  assert.equal(contract.repeatability.legacyDefault, 'exact');
  assert.equal(contract.benchmark.caseMatcher, 'same-as-expectedOutput');
  assert.deepEqual(contract.prerequisites.executionRequires, ['staticCheck', 'syntax', 'dependencies']);
  assert.deepEqual(contract.prerequisites.finalPassRequires,
    ['artifactIntegrity', 'staticCheck', 'syntax', 'dependencies', 'repeatability', 'domainCases', 'benchmark']);
  assert.deepEqual(JSON.parse(JSON.stringify(contract)), contract);
  contract.prerequisites.executionRequires.push('mutated-by-caller');
  assert.equal(toolValidationContract().prerequisites.executionRequires.includes('mutated-by-caller'), false);
});
