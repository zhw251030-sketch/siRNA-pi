// Independently implemented from the observable contract at reference checkout
// 67d2754 (application 965c53f). This module checks data; it has no runner.
import { toolValidationContract } from './tool-validation.mjs';
export * from './tool-validation.mjs';

const runtimes = ['bash', 'python', 'node'];
const modes = ['exact', 'contract'];
const profiles = ['no_external_access', 'controlled_network', 'controlled_software'];
const toolNamePattern = /^[a-z][a-z0-9_]{0,63}$/;
const dependencyNamePattern = /^[A-Za-z0-9@._+/-]{1,160}$/;
const systemNamePattern = /^[A-Za-z0-9._+-]{1,160}$/;
const dependencyVersionPattern = /^[A-Za-z0-9._+:-]{1,100}$/;
const hostPattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const executablePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const executionProtocol = 'sirna-approved-tool-call/v1';
const proposalFields = [
  'name', 'toolName', 'description', 'runtime', 'script', 'repeatabilityMode',
  'smokeInput', 'dependencies', 'testCases', 'baseline', 'benchmarkCases',
  'minNetGain', 'parent', 'permissions', 'runtimeArtifact',
];

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Inspect descriptors before values: JSON.stringify would silently erase some
// values and execute user-defined accessors/toJSON hooks. Shared subobjects are
// allowed; only cycles along the current ancestry are rejected.
function jsonData(value, label = 'proposal', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || (!Array.isArray(value) && !record(value))) {
    throw new Error(`${label} must contain only JSON data`);
  }
  if (ancestors.has(value)) throw new Error(`${label} contains a JSON cycle`);
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  const array = Array.isArray(value);
  if (array && (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1)) {
    throw new Error(`${label} must be a dense JSON array without extra properties`);
  }
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
        (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
      throw new Error(`${label} contains a property JSON cannot preserve`);
    }
    jsonData(descriptor.value, `${label}/${key}`, ancestors);
  }
  ancestors.delete(value);
}

function objectFields(value, allowed, label) {
  if (!record(value)) throw new Error(`${label} must be a JSON object`);
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    // Do not echo arbitrary user-controlled keys or source text into summaries.
    throw new Error(`${label} contains an unknown contract field`);
  }
}

function boundedText(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new Error(`${label} must contain ${min} to ${max} characters`);
  }
}

function sourceText(value, label) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 200000) {
    throw new Error(`${label} must contain non-blank source text of at most 200000 UTF-8 bytes`);
  }
}

function member(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of ${allowed.join(', ')}`);
}

function pattern(value, rule, label) {
  if (typeof value !== 'string' || !rule.test(value)) throw new Error(`${label} has an invalid format`);
}

function items(value, label, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} must contain ${min} to ${max} items`);
  }
}

function businessObject(value, label, nonempty = false) {
  if (!record(value) || (nonempty && Object.keys(value).length === 0)) {
    throw new Error(`${label} must be a ${nonempty ? 'non-empty ' : ''}JSON object`);
  }
}

function businessInput(value, label, nonempty = false) {
  businessObject(value, label, nonempty);
  if (value.protocolVersion === executionProtocol && typeof value.toolCallId === 'string' && record(value.input)) {
    throw new Error(`${label} must contain business input, without the execution envelope`);
  }
}

function cases(value, label) {
  items(value, label, 1, 100);
  const names = new Set();
  for (const entry of value) {
    objectFields(entry, ['name', 'input', 'expectedOutput'], label);
    boundedText(entry.name, `${label} name`, 3, 120);
    if (names.has(entry.name)) throw new Error(`${label} case names must be unique`);
    names.add(entry.name);
    businessInput(entry.input, `${label} input`);
    businessObject(entry.expectedOutput, `${label} expectedOutput`, true);
  }
}

function dependencies(value, runtime) {
  items(value, 'dependencies', 0, 100);
  const seen = new Set();
  const selectedCommands = { bash: ['bash', 'sh'], node: ['node', 'nodejs'], python: ['python', 'python3'] };
  for (const entry of value) {
    objectFields(entry, ['manager', 'name', 'version'], 'dependency');
    member(entry.manager, ['npm', 'pip', 'system'], 'dependency manager');
    pattern(entry.name, entry.manager === 'system' ? systemNamePattern : dependencyNamePattern, 'dependency name');
    pattern(entry.version, dependencyVersionPattern, 'dependency exact version');
    if (entry.version === 'latest') throw new Error('dependency version must be exact, not latest');
    const id = `${entry.manager}:${entry.name}`;
    if (seen.has(id)) throw new Error('dependencies contain a duplicate package');
    seen.add(id);
    if (entry.manager === 'system' && selectedCommands[runtime].includes(entry.name.toLowerCase())) {
      throw new Error('the selected runtime must not also be declared as a system dependency');
    }
  }
}

function permissions(value, lockedDependencies) {
  if (!record(value)) throw new Error('permissions must be a JSON object');
  member(value.profile, profiles, 'permissions.profile');
  const resource = { controlled_network: 'networkHosts', controlled_software: 'executables' }[value.profile];
  objectFields(value, resource ? ['profile', resource] : ['profile'], 'permissions');
  if (!resource) return;
  items(value[resource], `permissions.${resource}`, 1, 20);
  const seen = new Set();
  for (const name of value[resource]) {
    pattern(name, resource === 'networkHosts' ? hostPattern : executablePattern, `permissions.${resource}`);
    if (seen.has(name)) throw new Error(`permissions.${resource} entries must be unique`);
    seen.add(name);
    if (resource === 'executables' && !lockedDependencies.some(entry => entry.manager === 'system' && entry.name === name)) {
      throw new Error('each controlled software executable requires an exact system dependency');
    }
  }
}

function runtimeArtifact(value) {
  objectFields(value, ['protocolVersion', 'imageDigest', 'command', 'platform', 'createdAt', 'buildSessionId'], 'runtimeArtifact');
  member(value.protocolVersion, ['sirna-tool-runtime-artifact/v1'], 'runtimeArtifact protocolVersion');
  pattern(value.imageDigest, /^sha256:[0-9a-f]{64}$/, 'runtimeArtifact imageDigest');
  items(value.command, 'runtimeArtifact command', 1, 32);
  for (const part of value.command) {
    if (typeof part !== 'string' || part.length < 1 || part.length > 1000) {
      throw new Error('runtimeArtifact command parts must contain 1 to 1000 characters');
    }
  }
  if (!value.command[0].startsWith('/')) throw new Error('runtimeArtifact executable requires an absolute image path');
  pattern(value.platform, /^linux\/[a-z0-9_+-]+$/, 'runtimeArtifact platform');
  if (typeof value.createdAt !== 'string' || value.createdAt.length < 1 || value.createdAt.length > 100) {
    throw new Error('runtimeArtifact createdAt must contain 1 to 100 characters');
  }
  pattern(value.buildSessionId, /^[0-9a-f-]{36}$/, 'runtimeArtifact buildSessionId');
}

/** Validate supplied values; completeness for either entry stage is separate. */
export function validateToolProposalInput(value) {
  jsonData(value);
  objectFields(value, proposalFields, 'proposal');
  boundedText(value.name, 'name', 3, 80);
  boundedText(value.description, 'description', 10, 1000);
  member(value.runtime, runtimes, 'runtime');
  sourceText(value.script, 'script');
  if (Object.hasOwn(value, 'toolName')) pattern(value.toolName, toolNamePattern, 'toolName');
  if (Object.hasOwn(value, 'repeatabilityMode')) member(value.repeatabilityMode, modes, 'repeatabilityMode');
  if (Object.hasOwn(value, 'smokeInput')) businessInput(value.smokeInput, 'smokeInput', true);
  if (Object.hasOwn(value, 'dependencies')) dependencies(value.dependencies, value.runtime);
  if (Object.hasOwn(value, 'permissions')) permissions(value.permissions, value.dependencies ?? []);
  if (Object.hasOwn(value, 'runtimeArtifact')) runtimeArtifact(value.runtimeArtifact);
  if (Object.hasOwn(value, 'testCases')) cases(value.testCases, 'testCases');
  if (Object.hasOwn(value, 'baseline')) {
    objectFields(value.baseline, ['runtime', 'script'], 'baseline');
    member(value.baseline.runtime, runtimes, 'baseline runtime');
    sourceText(value.baseline.script, 'baseline script');
  }
  if (Object.hasOwn(value, 'benchmarkCases')) cases(value.benchmarkCases, 'benchmarkCases');
  if (Object.hasOwn(value, 'baseline') !== Object.hasOwn(value, 'benchmarkCases')) {
    throw new Error('baseline and benchmarkCases must be supplied together');
  }
  if (Object.hasOwn(value, 'minNetGain')) {
    if (!Number.isInteger(value.minNetGain) || value.minNetGain < 1 || value.minNetGain > 100) {
      throw new Error('minNetGain must be an integer from 1 to 100');
    }
    if (value.benchmarkCases && value.minNetGain > value.benchmarkCases.length) {
      throw new Error('minNetGain cannot exceed the benchmarkCases count');
    }
  }
  if (Object.hasOwn(value, 'parent')) {
    objectFields(value.parent, ['toolName', 'version'], 'parent');
    pattern(value.parent.toolName, toolNamePattern, 'parent toolName');
    pattern(value.parent.version, /^\d+\.\d+\.\d+$/, 'parent version');
  }
}

/** Locate missing or structurally incomplete contract components. */
export function collectToolContractIssues(value, { requireRuntimeArtifact = false } = {}) {
  const issues = [];
  const add = (field, requirement, example) => issues.push({ field, problem: 'missing_or_invalid', requirement, example });
  const caseExample = { name: 'successful example', input: { sequence: 'ACGU' }, expectedOutput: { length: 4 } };
  if (!record(value)) {
    add('/', 'Supply one JSON object describing the reusable tool contract.', { name: 'Sequence summary', toolName: 'sequence_summary' });
    return issues;
  }
  jsonData(value);
  const requiredText = (field, requirement, example) => {
    if (typeof value[field] !== 'string' || !value[field].trim()) add(`/${field}`, requirement, example);
  };
  requiredText('name', 'Give the tool a human-readable name.', 'Sequence summary');
  requiredText('toolName', 'Give the tool a stable lowercase identifier.', 'sequence_summary');
  requiredText('description', 'Describe the capability and the meaning and limits of its result.', 'Reports sequence length without predicting biological activity.');
  if (!runtimes.includes(value.runtime)) add('/runtime', 'Select bash, python, or node.', 'node');
  requiredText('script', 'Supply the complete candidate source as text.', '<candidate source>');
  if (!modes.includes(value.repeatabilityMode)) add('/repeatabilityMode', 'Select exact or contract; both still require successful runs and case checks.', 'exact');
  if (!Array.isArray(value.dependencies)) add('/dependencies', 'Declare locked dependencies, using an empty array when none are required.', []);
  if (!record(value.smokeInput) || Object.keys(value.smokeInput).length === 0) {
    add('/smokeInput', 'Supply a non-empty example of business input.', { sequence: 'ACGU' });
  }
  const caseIssues = field => {
    if (!Array.isArray(value[field]) || value[field].length === 0) {
      add(`/${field}`, 'Supply at least one case with input and a literal expected output.', [caseExample]);
      return;
    }
    value[field].forEach((entry, index) => {
      const path = `/${field}/${index}`;
      if (!record(entry)) {
        add(path, 'Supply an object describing this case.', caseExample);
        return;
      }
      if (!record(entry.input)) add(`${path}/input`, 'Supply the case business input as an object.', { sequence: 'ACGU' });
      if (!record(entry.expectedOutput) || Object.keys(entry.expectedOutput).length === 0) {
        add(`${path}/expectedOutput`, 'Supply a non-empty literal recursive-subset assertion, not an output schema.', { length: 4 });
      }
    });
  };
  caseIssues('testCases');
  if (!record(value.baseline)) {
    add('/baseline', 'Supply a prior or limited implementation for comparison.', { runtime: 'node', script: '<baseline source>' });
  } else {
    if (!runtimes.includes(value.baseline.runtime)) add('/baseline/runtime', 'Select the baseline runtime.', 'node');
    if (typeof value.baseline.script !== 'string' || !value.baseline.script.trim()) add('/baseline/script', 'Supply complete baseline source as text.', '<baseline source>');
  }
  caseIssues('benchmarkCases');
  if (!record(value.permissions)) {
    add('/permissions', 'Declare a tool permission profile; declaring it does not grant access.', { profile: 'no_external_access' });
  } else if (!profiles.includes(value.permissions.profile)) {
    add('/permissions/profile', 'Select no_external_access, controlled_network, or controlled_software.', 'no_external_access');
  } else {
    const resource = { controlled_network: 'networkHosts', controlled_software: 'executables' }[value.permissions.profile];
    if (resource && (!Array.isArray(value.permissions[resource]) || value.permissions[resource].length === 0)) {
      add(`/permissions/${resource}`, 'Declare at least one exact resource for the selected profile.', resource === 'networkHosts' ? ['api.example.org'] : ['seqkit']);
    }
  }
  if (requireRuntimeArtifact) {
    try {
      runtimeArtifact(value.runtimeArtifact);
    } catch {
      add('/runtimeArtifact', 'Supply the unchanged artifact returned by a completed build. Preflight checks structure only.', {
        protocolVersion: 'sirna-tool-runtime-artifact/v1', imageDigest: 'sha256:<64 lowercase hex characters>',
        command: ['/absolute/image/executable', '/opt/tool/main.mjs'], platform: 'linux/amd64',
        createdAt: '<build timestamp>', buildSessionId: '<build session identifier>',
      });
    }
  }
  return issues;
}

/** Pure preflight: no code execution, installation, registration, or approval. */
export function checkToolProposal(value, { requireRuntimeArtifact = true } = {}) {
  const summary = {
    ok: false,
    stage: requireRuntimeArtifact ? 'mcp' : 'draft',
    executed: false,
    registered: false,
    activated: false,
    runtimeArtifactVerified: false,
    validationContract: toolValidationContract(),
  };
  try {
    jsonData(value);
    const missingFields = collectToolContractIssues(value, { requireRuntimeArtifact });
    if (missingFields.length) {
      return {
        ...summary, code: 'TOOL_CONTRACT_INCOMPLETE',
        error: `Incomplete tool contract: ${missingFields.map(issue => issue.field).join(', ')}`,
        missingFields,
      };
    }
    validateToolProposalInput(value);
    return { ...summary, ok: true };
  } catch (error) {
    return { ...summary, code: 'TOOL_PROPOSAL_INVALID', error: error instanceof Error ? error.message : 'Invalid tool proposal' };
  }
}
