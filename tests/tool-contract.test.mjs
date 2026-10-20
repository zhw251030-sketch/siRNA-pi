import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkToolProposal,
  collectToolContractIssues,
  validateToolProposalInput,
} from '../packages/capability-platform/tool-contract.mjs';

// This complete OCI-shaped fixture tests structure only. No corresponding
// image or build session exists, and no test builds, fetches, or executes it.
function fakeOCI() {
  return {
    protocolVersion: 'sirna-tool-runtime-artifact/v1',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    command: ['/usr/local/bin/node', '/opt/tool/main.mjs'],
    platform: 'linux/amd64',
    createdAt: '2026-10-20T00:00:00.000Z',
    buildSessionId: '12345678-1234-1234-1234-123456789abc',
  };
}

function proposal() {
  return {
    name: 'Sequence summary',
    toolName: 'sequence_summary',
    description: 'Summarizes the length of a supplied RNA sequence.',
    runtime: 'node',
    script: 'throw new Error("candidate source must remain data");',
    repeatabilityMode: 'exact',
    smokeInput: { sequence: 'ACGU' },
    dependencies: [],
    testCases: [{ name: 'four bases', input: { sequence: 'ACGU' }, expectedOutput: { length: 4 } }],
    baseline: { runtime: 'node', script: 'throw new Error("baseline source must remain data");' },
    benchmarkCases: [{ name: 'empty sequence', input: { sequence: '' }, expectedOutput: { length: 0 } }],
    minNetGain: 1,
    permissions: { profile: 'no_external_access' },
  };
}

function fields(value, options) {
  return collectToolContractIssues(value, options).map(issue => issue.field);
}

function assertNoExecution(result, stage) {
  assert.equal(result.stage, stage);
  assert.equal(result.executed, false);
  assert.equal(result.registered, false);
  assert.equal(result.activated, false);
  assert.equal(result.runtimeArtifactVerified, false);
  assert.equal(result.validationContract.expectedOutput.matcher, 'recursive-subset/v1');
}

test('complete draft passes without executing candidate or baseline strings', () => {
  const input = proposal();
  const before = JSON.stringify(input);
  const result = checkToolProposal(input, { requireRuntimeArtifact: false });
  assert.equal(result.ok, true);
  assertNoExecution(result, 'draft');
  assert.equal('code' in result, false);
  assert.equal('missingFields' in result, false);
  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(result).includes(input.script), false);
  assert.equal(JSON.stringify(result).includes(input.baseline.script), false);
});

test('MCP preflight requires an artifact but does not verify an OCI-shaped value', () => {
  const input = proposal();
  const missing = checkToolProposal(input);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'TOOL_CONTRACT_INCOMPLETE');
  assert.deepEqual(missing.missingFields.map(issue => issue.field), ['/runtimeArtifact']);
  assertNoExecution(missing, 'mcp');
  input.runtimeArtifact = fakeOCI();
  const structural = checkToolProposal(input);
  assert.equal(structural.ok, true);
  assertNoExecution(structural, 'mcp');
});

test('completeness collector defaults to draft and locates every absent contract component', () => {
  assert.deepEqual(fields(proposal()), []);
  assert.deepEqual(fields({}), [
    '/name', '/toolName', '/description', '/runtime', '/script', '/repeatabilityMode',
    '/dependencies', '/smokeInput', '/testCases', '/baseline', '/benchmarkCases', '/permissions',
  ]);
  const result = checkToolProposal({});
  assert.equal(result.code, 'TOOL_CONTRACT_INCOMPLETE');
  assertNoExecution(result, 'mcp');
  for (const issue of result.missingFields) {
    assert.equal(issue.problem, 'missing_or_invalid');
    assert.equal(typeof issue.requirement, 'string');
    assert.ok(issue.requirement.length > 0);
    assert.ok(Object.hasOwn(issue, 'example'));
  }
});

for (const value of [null, [], 'proposal', 1]) {
  test(`non-object proposal ${JSON.stringify(value)} is incomplete at the root`, () => {
    assert.deepEqual(fields(value), ['/']);
    assert.equal(checkToolProposal(value).ok, false);
    assert.throws(() => validateToolProposalInput(value), /proposal/i);
  });
}

const incompleteCases = [
  ['blank stable name', value => { value.toolName = ' '; }, '/toolName'],
  ['unknown runtime', value => { value.runtime = 'ruby'; }, '/runtime'],
  ['unknown repeatability', value => { value.repeatabilityMode = 'sometimes'; }, '/repeatabilityMode'],
  ['empty smoke input', value => { value.smokeInput = {}; }, '/smokeInput'],
  ['dependencies not declared', value => { delete value.dependencies; }, '/dependencies'],
  ['empty cases', value => { value.testCases = []; }, '/testCases'],
  ['non-object case', value => { value.testCases = [null]; }, '/testCases/0'],
  ['non-object case input', value => { value.testCases[0].input = []; }, '/testCases/0/input'],
  ['empty case assertion', value => { value.testCases[0].expectedOutput = {}; }, '/testCases/0/expectedOutput'],
  ['missing baseline', value => { delete value.baseline; }, '/baseline'],
  ['invalid baseline runtime', value => { value.baseline.runtime = 'ruby'; }, '/baseline/runtime'],
  ['blank baseline source', value => { value.baseline.script = ' '; }, '/baseline/script'],
  ['empty benchmarks', value => { value.benchmarkCases = []; }, '/benchmarkCases'],
  ['missing benchmark assertion', value => { delete value.benchmarkCases[0].expectedOutput; }, '/benchmarkCases/0/expectedOutput'],
  ['missing permissions', value => { delete value.permissions; }, '/permissions'],
  ['unknown permission profile', value => { value.permissions.profile = 'all'; }, '/permissions/profile'],
  ['network without hosts', value => { value.permissions = { profile: 'controlled_network' }; }, '/permissions/networkHosts'],
  ['software without executables', value => { value.permissions = { profile: 'controlled_software' }; }, '/permissions/executables'],
];

for (const [name, mutate, path] of incompleteCases) {
  test(`completeness locates ${name}`, () => {
    const input = proposal();
    mutate(input);
    assert.ok(fields(input).includes(path));
    const result = checkToolProposal(input, { requireRuntimeArtifact: false });
    assert.equal(result.code, 'TOOL_CONTRACT_INCOMPLETE');
    assert.equal(result.ok, false);
  });
}

const invalidCases = [
  ['short name', value => { value.name = 'ab'; }],
  ['long name', value => { value.name = 'a'.repeat(81); }],
  ['short description', value => { value.description = '123456789'; }],
  ['long description', value => { value.description = 'a'.repeat(1001); }],
  ['invalid stable name', value => { value.toolName = 'UpperCase'; }],
  ['long stable name', value => { value.toolName = 'a'.repeat(65); }],
  ['candidate UTF-8 byte limit', value => { value.script = '字'.repeat(66667); }],
  ['baseline UTF-8 byte limit', value => { value.baseline.script = '字'.repeat(66667); }],
  ['too many test cases', value => { value.testCases = Array.from({ length: 101 }, (_, i) => ({ ...value.testCases[0], name: `case ${i}` })); }],
  ['duplicate case names', value => { value.testCases.push(structuredClone(value.testCases[0])); }],
  ['short case name', value => { value.testCases[0].name = 'ab'; }],
  ['long case name', value => { value.testCases[0].name = 'a'.repeat(121); }],
  ['fractional gain', value => { value.minNetGain = 1.5; }],
  ['zero gain', value => { value.minNetGain = 0; }],
  ['gain beyond limit', value => { value.minNetGain = 101; }],
  ['gain exceeds benchmark count', value => { value.minNetGain = 2; }],
  ['bad parent tool name', value => { value.parent = { toolName: 'Bad', version: '1.2.3' }; }],
  ['bad parent version', value => { value.parent = { toolName: 'prior_tool', version: '1.2' }; }],
  ['unknown proposal field', value => { value.runNow = true; }],
  ['unknown test case field', value => { value.testCases[0].timeout = 10; }],
  ['unknown baseline field', value => { value.baseline.dependencies = []; }],
  ['unknown parent field', value => { value.parent = { toolName: 'prior_tool', version: '1.2.3', approved: true }; }],
  ['unknown permission field', value => { value.permissions.allowAll = true; }],
  ['no-access empty network declaration', value => { value.permissions.networkHosts = []; }],
];

for (const [name, mutate] of invalidCases) {
  test(`value validator rejects ${name}`, () => {
    const input = proposal();
    mutate(input);
    assert.throws(() => validateToolProposalInput(input));
    const result = checkToolProposal(input, { requireRuntimeArtifact: false });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TOOL_PROPOSAL_INVALID');
    assert.equal(typeof result.error, 'string');
    assert.equal('missingFields' in result, false);
    assertNoExecution(result, 'draft');
  });
}

test('inclusive field bounds and all three source runtimes remain valid', () => {
  for (const runtime of ['bash', 'python', 'node']) {
    const value = proposal();
    value.runtime = runtime;
    value.baseline.runtime = runtime;
    value.name = 'abc';
    value.description = '1234567890';
    value.script = '字'.repeat(66666) + 'ab';
    value.baseline.script = 'a'.repeat(200000);
    value.toolName = 'a'.repeat(64);
    value.parent = { toolName: 'prior_tool', version: '1.2.3' };
    value.testCases = Array.from({ length: 100 }, (_, i) => ({ name: `case ${i}`, input: {}, expectedOutput: { ok: true } }));
    value.benchmarkCases = structuredClone(value.testCases);
    value.minNetGain = 100;
    assert.equal(checkToolProposal(value, { requireRuntimeArtifact: false }).ok, true);
  }
});

test('the low-level validator permits absent optional fields but preflight still requires the full contract', () => {
  const input = { name: 'Minimal tool', description: 'A descriptive tool boundary.', runtime: 'node', script: 'source text' };
  assert.doesNotThrow(() => validateToolProposalInput(input));
  assert.equal(checkToolProposal(input, { requireRuntimeArtifact: false }).code, 'TOOL_CONTRACT_INCOMPLETE');
  assert.throws(() => validateToolProposalInput({ ...input, baseline: { runtime: 'node', script: 'source' } }), /baseline|benchmark/i);
  assert.throws(() => validateToolProposalInput({ ...input, benchmarkCases: proposal().benchmarkCases }), /baseline|benchmark/i);
});

test('permission profiles accept their own exact resources and software requires locked system dependencies', () => {
  const network = proposal();
  network.permissions = { profile: 'controlled_network', networkHosts: ['api.example.org'] };
  network.repeatabilityMode = 'contract';
  assert.equal(checkToolProposal(network, { requireRuntimeArtifact: false }).ok, true);
  const software = proposal();
  software.permissions = { profile: 'controlled_software', executables: ['seqkit'] };
  software.dependencies = [{ manager: 'system', name: 'seqkit', version: '2.8.2' }];
  assert.equal(checkToolProposal(software, { requireRuntimeArtifact: false }).ok, true);
  software.dependencies = [{ manager: 'npm', name: 'seqkit', version: '2.8.2' }];
  assert.throws(() => validateToolProposalInput(software), /system dependency/i);
});

for (const host of ['https://api.example.org', 'api.example.org/path', 'API.example.org', 'api.example.org:443', '*.example.org']) {
  test(`network host syntax rejects ${host}`, () => {
    const input = proposal();
    input.permissions = { profile: 'controlled_network', networkHosts: [host] };
    assert.equal(checkToolProposal(input, { requireRuntimeArtifact: false }).code, 'TOOL_PROPOSAL_INVALID');
  });
}

for (const [name, permissions] of [
  ['duplicate hosts', { profile: 'controlled_network', networkHosts: ['api.example.org', 'api.example.org'] }],
  ['too many hosts', { profile: 'controlled_network', networkHosts: Array.from({ length: 21 }, (_, i) => `api${i}.example.org`) }],
  ['network with empty software list', { profile: 'controlled_network', networkHosts: ['api.example.org'], executables: [] }],
  ['software with empty host list', { profile: 'controlled_software', executables: ['seqkit'], networkHosts: [] }],
  ['executable path', { profile: 'controlled_software', executables: ['/bin/seqkit'] }],
  ['duplicate executables', { profile: 'controlled_software', executables: ['seqkit', 'seqkit'] }],
]) {
  test(`permission validation rejects ${name}`, () => {
    const input = proposal();
    input.permissions = permissions;
    input.dependencies = [{ manager: 'system', name: 'seqkit', version: '2.8.2' }];
    assert.equal(checkToolProposal(input, { requireRuntimeArtifact: false }).code, 'TOOL_PROPOSAL_INVALID');
  });
}

for (const [name, dependencies] of [
  ['range', [{ manager: 'npm', name: 'pkg', version: '^1.2.3' }]],
  ['wildcard', [{ manager: 'npm', name: 'pkg', version: '*' }]],
  ['latest', [{ manager: 'pip', name: 'pkg', version: 'latest' }]],
  ['URL', [{ manager: 'npm', name: 'pkg', version: 'https://example.org/pkg' }]],
  ['unsupported manager', [{ manager: 'apt', name: 'pkg', version: '1.0' }]],
  ['unknown metadata', [{ manager: 'npm', name: 'pkg', version: '1.0.0', install: true }]],
  ['system path', [{ manager: 'system', name: '/bin/pkg', version: '1.0' }]],
  ['duplicate package', [{ manager: 'npm', name: 'pkg', version: '1.0.0' }, { manager: 'npm', name: 'pkg', version: '2.0.0' }]],
  ['selected runtime', [{ manager: 'system', name: 'NodeJS', version: '24.16.0' }]],
  ['too many entries', Array.from({ length: 101 }, (_, i) => ({ manager: 'npm', name: `pkg${i}`, version: '1.0.0' }))],
]) {
  test(`dependency validation rejects ${name}`, () => {
    const input = proposal();
    input.dependencies = dependencies;
    assert.equal(checkToolProposal(input, { requireRuntimeArtifact: false }).code, 'TOOL_PROPOSAL_INVALID');
  });
}

test('dependency strings retain valid scoped packages and exact system version suffixes', () => {
  const input = proposal();
  input.dependencies = [
    { manager: 'npm', name: '@scope/pkg', version: '1.2.3-beta.1' },
    { manager: 'pip', name: 'some_package', version: '1.2.3+cpu' },
    { manager: 'system', name: 'seqkit', version: '1:2.8.2-1' },
  ];
  assert.equal(checkToolProposal(input, { requireRuntimeArtifact: false }).ok, true);
});

for (const location of ['smokeInput', 'testCases', 'benchmarkCases']) {
  test(`${location} rejects the execution envelope while preserving literal business keys`, () => {
    const input = proposal();
    const envelope = { protocolVersion: 'sirna-approved-tool-call/v1', toolCallId: 'call-one', input: { sequence: 'A' } };
    if (location === 'smokeInput') input.smokeInput = envelope;
    else input[location][0].input = envelope;
    assert.equal(checkToolProposal(input, { requireRuntimeArtifact: false }).code, 'TOOL_PROPOSAL_INVALID');
    delete envelope.toolCallId;
    assert.equal(checkToolProposal(input, { requireRuntimeArtifact: false }).ok, true);
  });
}

for (const [name, mutate] of [
  ['wrong protocol', artifact => { artifact.protocolVersion = 'other/v1'; }],
  ['wrong digest', artifact => { artifact.imageDigest = 'sha256:abc'; }],
  ['relative executable', artifact => { artifact.command[0] = 'node'; }],
  ['empty command', artifact => { artifact.command = []; }],
  ['too many arguments', artifact => { artifact.command = ['/bin/node', ...Array(32).fill('x')]; }],
  ['long argument', artifact => { artifact.command[1] = 'x'.repeat(1001); }],
  ['non-Linux platform', artifact => { artifact.platform = 'windows/amd64'; }],
  ['empty provenance time', artifact => { artifact.createdAt = ''; }],
  ['long provenance time', artifact => { artifact.createdAt = 'x'.repeat(101); }],
  ['bad build identifier', artifact => { artifact.buildSessionId = 'session'; }],
  ['unknown field', artifact => { artifact.verified = true; }],
]) {
  test(`artifact ${name} cannot pass in either stage`, () => {
    const input = proposal();
    input.runtimeArtifact = fakeOCI();
    mutate(input.runtimeArtifact);
    assert.throws(() => validateToolProposalInput(input));
    assert.equal(checkToolProposal(input, { requireRuntimeArtifact: false }).code, 'TOOL_PROPOSAL_INVALID');
    assert.equal(checkToolProposal(input).ok, false);
    assert.deepEqual(fields(input, { requireRuntimeArtifact: true }), ['/runtimeArtifact']);
  });
}

for (const [name, item] of [
  ['undefined', undefined], ['function', () => {}], ['bigint', 1n],
  ['NaN', NaN], ['infinity', Infinity], ['Date', new Date('2026-10-20')],
  ['symbol', Symbol('value')], ['sparse array', Array(1)],
]) {
  test(`JSON-strict input rejects ${name} without silently losing data`, () => {
    const input = proposal();
    input.smokeInput.item = item;
    assert.throws(() => validateToolProposalInput(input), /JSON/i);
    const result = checkToolProposal(input, { requireRuntimeArtifact: false });
    assert.equal(result.code, 'TOOL_PROPOSAL_INVALID');
  });
}

test('JSON-strict input rejects cycles, symbol keys, hidden properties, and custom prototypes', () => {
  const cycle = {};
  cycle.self = cycle;
  const symbolKey = { [Symbol('key')]: 1 };
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  const inherited = Object.create({ inherited: 1 });
  inherited.visible = 2;
  for (const item of [cycle, symbolKey, hidden, inherited]) {
    const input = proposal();
    input.smokeInput.item = item;
    assert.equal(checkToolProposal(input, { requireRuntimeArtifact: false }).code, 'TOOL_PROPOSAL_INVALID');
  }
});

test('JSON-strict checks never invoke accessors or toJSON hooks', () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, 'danger', { enumerable: true, get() { calls += 1; return 1; } });
  const hook = { toJSON() { calls += 1; return {}; } };
  for (const item of [accessor, hook]) {
    const input = proposal();
    input.smokeInput.item = item;
    assert.equal(checkToolProposal(input, { requireRuntimeArtifact: false }).code, 'TOOL_PROPOSAL_INVALID');
  }
  const topAccessor = proposal();
  Object.defineProperty(topAccessor, 'script', { enumerable: true, get() { calls += 1; return 'source'; } });
  assert.equal(checkToolProposal(topAccessor, { requireRuntimeArtifact: false }).code, 'TOOL_PROPOSAL_INVALID');
  assert.equal(calls, 0);
});

test('literal business objects retain arbitrary own keys, nulls, and repeated references', () => {
  const input = proposal();
  const shared = { value: null };
  input.smokeInput = JSON.parse('{"__proto__":{"value":1},"a.b":[true,null,3]}');
  input.smokeInput.first = shared;
  input.smokeInput.second = shared;
  input.testCases[0].expectedOutput = { 'result.length': 4 };
  assert.equal(checkToolProposal(input, { requireRuntimeArtifact: false }).ok, true);
});
