// Independent implementation of the observable validation contract in reference
// application 965c53f (checkout 67d2754). No runner, registry or source execution.

export function expectedOutputMatches(actual, expected) {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (actual === null || typeof actual !== 'object') return false;

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
      if (!expectedOutputMatches(actual[index], expected[index])) return false;
    }
    return true;
  }

  if (Array.isArray(actual)) return false;
  for (const key of Object.keys(expected)) {
    if (!Object.hasOwn(actual, key) || !expectedOutputMatches(actual[key], expected[key])) return false;
  }
  return true;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

// Inspect data descriptors instead of JSON.stringify: toJSON and getters are not run.
function isJsonData(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const array = Array.isArray(value);
  if (array && Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (!array && !isPlainObject(value)) return false;

  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) return false;
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string') return false;
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) return false;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property.enumerable || !Object.hasOwn(property, 'value') || !isJsonData(property.value, ancestors)) {
      return false;
    }
  }
  ancestors.delete(value);
  return true;
}

export function validationRunPassed(run) {
  if (!isPlainObject(run)) return false;
  const fields = ['exitCode', 'timedOut', 'cancelled', 'protocolValid', 'output',
    'stdout', 'stderr', 'filesDigest'];
  for (const field of fields) {
    const property = Object.getOwnPropertyDescriptor(run, field);
    if (!property || !Object.hasOwn(property, 'value')) return false;
  }
  return run.exitCode === 0 && run.timedOut === false && run.cancelled === false &&
    run.protocolValid === true && isPlainObject(run.output) && isJsonData(run.output) &&
    typeof run.stdout === 'string' && typeof run.stderr === 'string' && typeof run.filesDigest === 'string';
}

export function validationCasePassed(run, expectedOutput) {
  if (!validationRunPassed(run)) return false;
  return expectedOutputMatches(run.output, expectedOutput);
}

export function validationRunsRepeatable(firstRun, secondRun, mode = 'exact') {
  if (mode !== 'exact' && mode !== 'contract') return false;
  if (!validationRunPassed(firstRun) || !validationRunPassed(secondRun)) return false;
  if (mode === 'contract') return true;
  for (const field of ['stdout', 'stderr', 'filesDigest']) {
    if (firstRun[field] !== secondRun[field]) return false;
  }
  return true;
}

export function toolValidationContract() {
  return {
    version: 'sirna-tool-validation-contract/v2',
    stage: 'contract-preflight',
    executed: false,
    scope: 'Describes future validation requirements and predicates over supplied records; no execution gate is performed by preflight.',
    executionProtocol: {
      inputEnvelope: '{"protocolVersion":"sirna-approved-tool-call/v1","toolCallId":"<changes-per-run>","input":<business-input>}',
      stdout: 'A future executor must trim stdout and parse exactly one JSON object, then record protocolValid. Exit code must be 0 with no timeout or cancellation.',
      runPassFunction: validationRunPassed.toString(),
      recordRule: 'Required own data fields: exitCode=0, timedOut=false, cancelled=false, protocolValid=true, JSON-object output, and string stdout/stderr/filesDigest. Missing fields fail in both repeatability modes.',
      outputRule: 'Output must contain finite JSON data in plain objects or dense arrays. Accessors, custom objects, cycles and data lost by JSON serialization are rejected without invoking getters or toJSON.',
      evidenceBoundary: 'These predicates inspect a supplied record; they do not independently reparse stdout, authenticate the record or verify filesystem contents.',
    },
    expectedOutput: {
      matcher: 'recursive-subset/v1',
      comparisonFunction: expectedOutputMatches.toString(),
      casePassFunction: validationCasePassed.toString(),
      objectRule: 'Expected own enumerable keys must also be own keys of actual, with recursive matching; additional actual keys are accepted.',
      arrayRule: 'Actual and expected arrays need identical length and element order; object elements still use recursive subset matching.',
      primitiveRule: 'Primitive values use Object.is, without type coercion or tolerance.',
      dotSeparatedKeys: 'literal-keys-not-paths',
      unsupportedAssertions: ['JSONPath and dot-path expressions', 'minimum/maximum comparisons',
        'wildcard matching', 'partial arrays or ignored array order'],
    },
    repeatability: {
      selectionField: 'repeatabilityMode',
      supportedModes: {
        exact: 'Require two passing records and equality of stdout, stderr and filesDigest.',
        contract: 'Require two passing records; their stdout, stderr and filesDigest may differ. Case assertions and all other validation gates remain required.',
      },
      legacyDefault: 'exact',
      input: 'A future validator must run the same smokeInput twice using separate clean working directories.',
      toolCallIds: 'Each future run receives a different toolCallId; deterministic output must not copy that identifier.',
      comparisonFunction: validationRunsRepeatable.toString(),
      exactRule: "validationRunsRepeatable(firstRun, secondRun, 'exact')",
      contractRule: "validationRunsRepeatable(firstRun, secondRun, 'contract')",
      unknownMode: 'Rejected with false; only an omitted or undefined mode selects the exact default.',
    },
    benchmark: {
      caseMatcher: 'same-as-expectedOutput',
      candidateScore: 'Number of candidate benchmark runs accepted by validationCasePassed.',
      baselineScore: 'Number of baseline benchmark runs accepted by validationCasePassed.',
      netGain: 'candidateScore - baselineScore',
      passCondition: 'Require at least one benchmark case and netGain >= minNetGain.',
    },
    prerequisites: {
      executionRequires: ['staticCheck', 'syntax', 'dependencies'],
      finalPassRequires: ['artifactIntegrity', 'staticCheck', 'syntax', 'dependencies',
        'repeatability', 'domainCases', 'benchmark'],
    },
    gateRules: {
      artifactIntegrity: 'Future validation must compare the proposal directory digest with its registered digest before and after execution.',
      staticCheck: 'Future validation must check both candidate and baseline source against the declared permission profile.',
      syntax: 'Future validation must check syntax with bash -n, compilation without execution for Python, or node --check.',
      dependencies: 'Future validation must inspect npm/pip package metadata; system version probes try --version, version, -version and -V, with successful output containing the locked version string.',
      repeatability: 'Future validation must obtain two passing smoke records and apply the selected mode. contract removes only equality checks between those runs.',
      domainCases: 'Future validation must evaluate at least one domain case and require validationCasePassed for every candidate case.',
      benchmark: 'Future validation must evaluate at least one benchmark case against candidate and baseline; their score difference must meet minNetGain.',
    },
  };
}
