import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import crypto from 'node:crypto';

const service = await import('../packages/capability-platform/tool-build-service.mjs');
const { buildToolArtifact, executeToolArtifact } = service;
const BASE = 'sha256:e34a8f3fe6b2b74a3fa7f1a6143a126ae1e5414fa8a334c7bba82fe57d28971b';
const IMAGE = `sha256:${'b'.repeat(64)}`;
const SESSION = '1b259aaf-e661-40a3-a372-e166bdff2963';
const COMMAND = ['/usr/bin/node', '/opt/tool/main.mjs'];
const clone = value => structuredClone(value);

function proposal() {
  return {
    name: 'Sequence summary', toolName: 'sequence_summary', description: 'Summarizes sequence length deterministically.',
    runtime: 'node', script: 'const input = JSON.parse(await (async()=>{let s="";for await(const c of process.stdin)s+=c;return s;})());console.log(JSON.stringify({length:input.input.sequence.length}));',
    repeatabilityMode: 'exact', smokeInput: { sequence: 'ACGU' }, dependencies: [],
    testCases: [{ name: 'four bases', input: { sequence: 'ACGU' }, expectedOutput: { length: 4 } },
      { name: 'two bases', input: { sequence: 'AC' }, expectedOutput: { length: 2 } }],
    baseline: { runtime: 'node', script: 'throw new Error("baseline never uploaded");' },
    benchmarkCases: [{ name: 'one base', input: { sequence: 'A' }, expectedOutput: { length: 1 } }],
    permissions: { profile: 'no_external_access' },
  };
}

// Concrete Docker boundary fake. Fixed upload/hash Node programs run against an
// in-memory filesystem; candidate code is never executed on the test host.
class MemoryDocker {
  calls = []; containers = new Map(); images = new Map(); files = new Map(); sequence = 0;
  failAt = null; output = envelope => ({ length: envelope.input.sequence.length });
  constructor() {
    this.images.set(BASE, { Id: BASE, Os: 'linux', Architecture: 'amd64', Config: { Volumes: null, Env: ['SECRET=not-for-events'] } });
    this.containers.set('old-unrelated', { Id: 'old-unrelated', Config: { Labels: { unrelated: 'true' } } });
  }
  hit(method, ...args) {
    this.calls.push({ method, args: clone(args) });
    if (this.failAt === method) { this.failAt = null; throw new Error(`injected ${method}`); }
  }
  async inspectImage(id) { this.hit('inspectImage', id); if (!this.images.has(id)) throw new Error('missing image'); return clone(this.images.get(id)); }
  async createContainer(name, config) {
    this.hit('createContainer', name, config); const id = `container-${++this.sequence}`;
    this.containers.set(id, { Id: id, Config: clone(config), HostConfig: clone(config.HostConfig), Mounts: [], NetworkSettings: { Networks: { none: {} } } });
    return id;
  }
  async inspectContainer(id) {
    this.hit('inspectContainer', id);
    if (!this.containers.has(id)) { const error = new Error('not found'); error.statusCode = 404; throw error; }
    return clone(this.containers.get(id));
  }
  async startContainer(id) { this.hit('startContainer', id); this.containers.get(id).State = { Running: true }; }
  async stopContainer(id) { this.hit('stopContainer', id); this.containers.get(id).State = { Running: false }; }
  async removeContainer(id, force) { this.hit('removeContainer', id, force); this.containers.delete(id); }
  async exec(id, command, options) {
    this.hit('exec', id, command, options);
    if (command[1] === '--check') return { exitCode: 0, stdout: '', stderr: '' };
    if (command[1] === '-e') {
      let stdout = '';
      vm.runInNewContext(command[2], {
        Buffer, process: { argv: [command[0], ...command.slice(3)], stdout: { write: value => { stdout += value; } } },
        require: name => {
          if (name === 'node:crypto') return crypto;
          assert.equal(name, 'node:fs');
          return { mkdirSync: () => {}, chmodSync: () => {},
            writeFileSync: (path, value) => this.files.set(`${id}:${path}`, Buffer.from(value)),
            readFileSync: path => this.files.get(`${id}:${path}`) };
        },
      });
      return { exitCode: 0, stdout, stderr: '' };
    }
    return this.result(command);
  }
  result(command) {
    const envelope = JSON.parse(Buffer.from(command[4], 'base64').toString());
    assert.equal(envelope.protocolVersion, 'sirna-approved-tool-call/v1');
    assert.match(envelope.toolCallId, /^[0-9a-f-]{36}$/);
    return { exitCode: 0, stdout: JSON.stringify(this.output(envelope)), stderr: '' };
  }
  async commitContainer(id, repository, tag, config) {
    this.hit('commitContainer', id, repository, tag, config);
    assert.equal(this.containers.get(id).State.Running, false);
    this.images.set(IMAGE, { Id: IMAGE, Os: 'linux', Architecture: 'amd64', Config: { ...clone(config), Volumes: null } });
    return IMAGE;
  }
  async waitContainer(id, timeoutMs) { this.hit('waitContainer', id, timeoutMs); return 0; }
  async containerLogs(id) { this.hit('containerLogs', id); const { stdout, stderr } = this.result(this.containers.get(id).Config.Cmd); return { stdout, stderr }; }
}

test('trusted build uploads candidate, binds immutable image and checks every case in separate clean containers', async () => {
  assert.equal(typeof buildToolArtifact, 'function', 'build service must exist');
  const docker = new MemoryDocker(); const input = proposal(); const before = clone(input); const events = [];
  const result = await buildToolArtifact(input, { docker, sessionId: SESSION, onEvent: async event => events.push(clone(event)) });
  assert.deepEqual(input, before);
  assert.deepEqual([...service.TOOL_COMMAND], COMMAND); assert.equal(Object.isFrozen(service.TOOL_COMMAND), true);
  assert.equal(service.TOOL_BASE_IMAGE, BASE);
  assert.equal(result.artifact.imageDigest, IMAGE); assert.deepEqual(result.artifact.command, COMMAND);
  assert.equal(result.artifact.platform, 'linux/amd64'); assert.equal(result.artifact.buildSessionId, SESSION);
  assert.equal(result.sourceSha256, crypto.createHash('sha256').update(input.script).digest('hex'));
  assert.equal(docker.files.get('container-1:/opt/tool/main.mjs').toString(), input.script);
  assert.equal([...docker.files.values()].some(value => value.toString() === input.baseline.script), false);
  assert.equal(result.checks.length, 2); assert.equal(result.checks.every(check => check.passed), true);
  assert.equal(result.registered, false); assert.equal(result.activated, false); assert.equal(result.verified, false);
  assert.equal('filesDigest' in result.buildSmoke, false);
  assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
  const creates = docker.calls.filter(call => call.method === 'createContainer'); assert.equal(creates.length, 3);
  const build = creates[0].args[1];
  assert.equal(build.Image, BASE); assert.deepEqual(build.Entrypoint, []); assert.equal(build.User, '0:0');
  assert.equal(build.NetworkDisabled, true); assert.deepEqual(build.Env, []); assert.equal(build.HostConfig.NetworkMode, 'none');
  assert.equal(build.HostConfig.Memory, 1073741824); assert.equal(build.HostConfig.PidsLimit, 64);
  assert.deepEqual(build.HostConfig.CapDrop, ['ALL']); assert.deepEqual(build.HostConfig.SecurityOpt, ['no-new-privileges']);
  assert.equal('NanoCpus' in build.HostConfig, false); assert.equal('Binds' in build.HostConfig, false);
  for (const call of creates.slice(1)) {
    const config = call.args[1]; assert.equal(config.Image, IMAGE); assert.equal(config.User, '65534:65534');
    assert.equal(config.HostConfig.ReadonlyRootfs, true); assert.equal(config.HostConfig.Tmpfs['/tmp'], 'rw,nosuid,nodev,size=64m,mode=1777');
    assert.deepEqual(config.Cmd.slice(-2), COMMAND); assert.equal(config.Cmd[2].includes(input.script), false);
  }
  const commit = docker.calls.find(call => call.method === 'commitContainer');
  assert.equal(commit.args[1], 'sirna-learning-tool-runtime'); assert.equal(commit.args[2], SESSION);
  assert.equal(commit.args[3].Labels['sirna.tool.source-sha256'], result.sourceSha256);
  const createdIndex = events.findIndex(event => event.type === 'build_container_created');
  assert.ok(createdIndex >= 0); assert.equal(events[createdIndex].containerId, 'container-1');
  assert.equal(JSON.stringify(events).includes('SECRET='), false);
});

test('unsupported proposals and controls are rejected before any Docker access', async () => {
  assert.equal(typeof buildToolArtifact, 'function');
  for (const mutate of [p => { p.runtime = 'python'; }, p => { p.dependencies = [{ manager: 'npm', name: 'a', version: '1.0.0' }]; },
    p => { p.repeatabilityMode = 'contract'; }, p => { p.permissions = { profile: 'controlled_network', networkHosts: ['example.org'] }; },
    p => { p.smokeInput = { sequence: 'mismatch' }; }, p => { p.testCases = Array.from({ length: 11 }, (_, i) => ({ name: `case ${i}`, input: {}, expectedOutput: { ok: true } })); }]) {
    const docker = new MemoryDocker(); const input = proposal(); mutate(input);
    await assert.rejects(buildToolArtifact(input, { docker, sessionId: SESSION })); assert.equal(docker.calls.length, 0);
  }
  for (const controls of [{ sessionId: '../bad' }, { timeoutMs: 99 }, { timeoutMs: 30001 }, { timeoutMs: 100.5 }]) {
    const docker = new MemoryDocker(); await assert.rejects(buildToolArtifact(proposal(), { docker, ...controls })); assert.equal(docker.calls.length, 0);
  }
});

test('each failure stage preserves old resources and cleans only its owned container without false success', async () => {
  assert.equal(typeof buildToolArtifact, 'function');
  for (const stage of ['startContainer', 'exec', 'stopContainer', 'commitContainer', 'waitContainer', 'containerLogs']) {
    const docker = new MemoryDocker(); docker.failAt = stage;
    await assert.rejects(buildToolArtifact(proposal(), { docker, sessionId: SESSION }), /injected/);
    assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
    if (['startContainer', 'exec', 'stopContainer'].includes(stage)) assert.equal(docker.calls.some(call => call.method === 'commitContainer'), false);
  }
});

test('onEvent failure immediately after create still cleans before container start', async () => {
  assert.equal(typeof buildToolArtifact, 'function');
  const docker = new MemoryDocker();
  await assert.rejects(buildToolArtifact(proposal(), { docker, sessionId: SESSION,
    onEvent: async event => { if (event.type === 'build_container_created') throw new Error('event disk failed'); } }), /event disk failed/);
  assert.equal(docker.calls.some(call => call.method === 'startContainer'), false);
  assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
});

test('bad smoke prevents commit and later bad image case cannot return a successful artifact', async () => {
  assert.equal(typeof buildToolArtifact, 'function');
  for (const sequence of ['ACGU', 'AC']) {
    const docker = new MemoryDocker(); docker.output = envelope => ({ length: envelope.input.sequence === sequence ? 999 : envelope.input.sequence.length });
    await assert.rejects(buildToolArtifact(proposal(), { docker, sessionId: SESSION }), /assertion|case|smoke/i);
    assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
    assert.equal(docker.calls.some(call => call.method === 'commitContainer'), sequence !== 'ACGU');
    if (sequence === 'AC') assert.equal(docker.images.has(IMAGE), true);
  }
});

test('cleanup failures expose the exact ID and preserve the original error cause', async () => {
  assert.equal(typeof buildToolArtifact, 'function');
  const docker = new MemoryDocker(); const remove = docker.removeContainer.bind(docker);
  docker.removeContainer = async id => { if (id === 'container-1') throw new Error('daemon cleanup refused'); return remove(id); };
  docker.failAt = 'exec';
  await assert.rejects(buildToolArtifact(proposal(), { docker, sessionId: SESSION }), error => {
    assert.match(error.message, /container-1/); assert.match(error.cause.message, /injected exec/); return true;
  });
  assert.equal(docker.containers.has('old-unrelated'), true);
});

test('execute rejects forged identity, command, provenance and image runtime config before creating runs', async () => {
  assert.equal(typeof executeToolArtifact, 'function');
  const docker = new MemoryDocker(); const result = await buildToolArtifact(proposal(), { docker, sessionId: SESSION });
  for (const mutate of [a => { a.command[0] = '/bin/sh'; }, a => { a.createdAt = '2020-01-01T00:00:00.000Z'; },
    a => { a.buildSessionId = '2b259aaf-e661-40a3-a372-e166bdff2963'; }, a => { a.platform = 'linux/arm64'; }]) {
    const a = clone(result.artifact); mutate(a); const count = docker.sequence;
    await assert.rejects(executeToolArtifact(a, { sequence: 'A' }, { docker })); assert.equal(docker.sequence, count);
  }
  for (const mutate of [image => { image.Id = BASE; }, image => { image.Config.User = '0:0'; },
    image => { image.Config.Entrypoint = ['/bin/sh']; }, image => { image.Config.WorkingDir = '/'; },
    image => { image.Config.Labels['sirna.tool.source-sha256'] = 'wrong'; }, image => { image.Config.Labels['sirna.tool.base-image'] = 'wrong'; },
    image => { image.Config.Volumes = { '/opt/tool': {} }; }]) {
    const image = clone(docker.images.get(IMAGE)); mutate(docker.images.get(IMAGE)); const count = docker.sequence;
    await assert.rejects(executeToolArtifact(result.artifact, { sequence: 'A' }, { docker })); assert.equal(docker.sequence, count);
    docker.images.set(IMAGE, image);
  }
});

test('run timeout reports timeout and precisely removes its run container', async () => {
  assert.equal(typeof executeToolArtifact, 'function');
  const docker = new MemoryDocker(); const { artifact } = await buildToolArtifact(proposal(), { docker, sessionId: SESSION });
  docker.waitContainer = async () => { const error = new Error('request timed out'); error.code = 'ETIMEDOUT'; throw error; };
  const result = await executeToolArtifact(artifact, { sequence: 'ACGU' }, { docker });
  assert.equal(result.timedOut, true); assert.equal(result.exitCode, null); assert.equal(result.protocolValid, false);
  assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
});

test('source, proposal and input snapshots remain bound if the caller mutates during awaited events', async () => {
  const docker = new MemoryDocker(); const draft = proposal(); const source = draft.script;
  const { artifact } = await buildToolArtifact(draft, { docker, sessionId: SESSION, onEvent: async event => {
    if (event.type === 'build_preflight') { draft.script = 'throw new Error("changed")'; draft.smokeInput.sequence = 'longer'; draft.testCases[0].expectedOutput.length = 999; }
  } });
  assert.equal(docker.files.get('container-1:/opt/tool/main.mjs').toString(), source);
  const businessInput = { sequence: 'AC' }; const callArtifact = clone(artifact);
  const result = await executeToolArtifact(callArtifact, businessInput, { docker, onEvent: async event => {
    if (event.type === 'artifact_image_checked') { businessInput.sequence = 'longer'; callArtifact.command[0] = '/bin/sh'; }
  } });
  assert.deepEqual(result.output, { length: 2 });
});

test('actual inspection rejects unsafe resource or mount settings before candidate execution', async () => {
  for (const mutate of [inspect => { inspect.HostConfig.NetworkMode = 'host'; }, inspect => { inspect.Config.NetworkDisabled = false; },
    inspect => { inspect.HostConfig.Memory = 0; }, inspect => { inspect.HostConfig.PidsLimit = 0; },
    inspect => { inspect.HostConfig.CapDrop = []; }, inspect => { inspect.HostConfig.SecurityOpt = []; },
    inspect => { inspect.HostConfig.Privileged = true; }, inspect => { inspect.HostConfig.Binds = ['/var/run/docker.sock:/socket']; },
    inspect => { inspect.Mounts = [{ Type: 'bind', Source: '/host', Destination: '/opt/tool' }]; }]) {
    const docker = new MemoryDocker(); const inspect = docker.inspectContainer.bind(docker);
    docker.inspectContainer = async id => { const result = await inspect(id); mutate(result); return result; };
    await assert.rejects(buildToolArtifact(proposal(), { docker, sessionId: SESSION }), /Actual/);
    assert.equal(docker.calls.some(call => call.method === 'startContainer'), false);
    assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
  }
});

test('a source readback mismatch cannot be committed', async () => {
  const docker = new MemoryDocker(); const exec = docker.exec.bind(docker); let callCount = 0;
  docker.exec = async (...args) => { const result = await exec(...args); callCount += 1;
    if (callCount === 3) return { ...result, stdout: '0'.repeat(64) }; return result; };
  await assert.rejects(buildToolArtifact(proposal(), { docker, sessionId: SESSION }), /hash differs/);
  assert.equal(docker.calls.some(call => call.method === 'commitContainer'), false);
  assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
});

test('an invalid JSON object response and a nonzero exit are honest unsuccessful execution results', async () => {
  const docker = new MemoryDocker(); const { artifact } = await buildToolArtifact(proposal(), { docker, sessionId: SESSION });
  for (const stdout of ['[]', 'null', '{}\n{}', 'notice\n{}', '{"x":1e999}']) {
    docker.containerLogs = async () => ({ stdout, stderr: '' });
    const result = await executeToolArtifact(artifact, { sequence: 'A' }, { docker });
    assert.equal(result.protocolValid, false, stdout);
    assert.equal('filesDigest' in result, false);
  }
  docker.containerLogs = async () => ({ stdout: '{"length":1}', stderr: 'candidate failure' });
  docker.waitContainer = async () => 2;
  const result = await executeToolArtifact(artifact, { sequence: 'A' }, { docker });
  assert.equal(result.exitCode, 2); assert.equal(result.protocolValid, true);
  assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
});

test('cleanup refuses a changed ownership label rather than touching another container', async () => {
  const docker = new MemoryDocker(); const start = docker.startContainer.bind(docker);
  docker.startContainer = async id => {
    await start(id); docker.containers.get(id).Config.Labels['sirna.learning.project'] = 'other-project';
    throw new Error('start failed after ownership changed');
  };
  await assert.rejects(buildToolArtifact(proposal(), { docker, sessionId: SESSION }), error => {
    assert.equal(error.containerId, 'container-1'); assert.match(error.cause.message, /start failed/);
    assert.match(error.cleanupError.message, /ownership differs/); return true;
  });
  assert.equal(docker.calls.some(call => call.method === 'removeContainer'), false);
  assert.equal(docker.containers.has('old-unrelated'), true);
});

test('already-deleted 404 cleanup is accepted while non-404 inspection failure is explicit', async () => {
  for (const absent of [true, false]) {
    const docker = new MemoryDocker(); const inspect = docker.inspectContainer.bind(docker); let seen = false;
    docker.inspectContainer = async id => {
      if (!seen) { seen = true; return inspect(id); }
      const error = new Error('inspect failure'); error.statusCode = absent ? 404 : 500; throw error;
    };
    docker.startContainer = async id => { if (absent) docker.containers.delete(id); throw new Error('original start failure'); };
    await assert.rejects(buildToolArtifact(proposal(), { docker, sessionId: SESSION }), error => {
      if (absent) assert.equal(error.message, 'original start failure');
      else { assert.equal(error.containerId, 'container-1'); assert.equal(error.cause.message, 'original start failure'); }
      return true;
    });
    assert.equal(docker.calls.some(call => call.method === 'removeContainer'), false);
  }
});

test('evidence callback mutation cannot change internal artifact or declared policy', async () => {
  const docker = new MemoryDocker();
  const result = await buildToolArtifact(proposal(), { docker, sessionId: SESSION, onEvent: async event => {
    if (event.type === 'build_preflight') event.policy.run.user = '0:0';
    if (event.type === 'image_committed') event.artifact.command[0] = '/bin/sh';
  } });
  assert.deepEqual(result.artifact.command, COMMAND); assert.equal(result.executionPolicy.run.user, '65534:65534');
});

test('invalid protocol output remains null so events contain only faithful finite JSON data', async () => {
  const docker = new MemoryDocker(); const { artifact } = await buildToolArtifact(proposal(), { docker, sessionId: SESSION });
  docker.containerLogs = async () => ({ stdout: '{"x":1e999}', stderr: '' });
  const result = await executeToolArtifact(artifact, { sequence: 'A' }, { docker });
  assert.equal(result.protocolValid, false); assert.equal(result.output, null);
});

test('the actual container command and entrypoint must agree with its trusted creation request', async () => {
  const docker = new MemoryDocker(); const inspect = docker.inspectContainer.bind(docker);
  docker.inspectContainer = async id => { const value = await inspect(id); value.Config.Entrypoint = ['/bin/sh']; return value; };
  await assert.rejects(buildToolArtifact(proposal(), { docker, sessionId: SESSION }), /command|entrypoint/);
  assert.equal(docker.calls.some(call => call.method === 'startContainer'), false);
  assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
});

test('Docker null entrypoint normalization is accepted while fixed commands remain checked', async () => {
  const docker = new MemoryDocker(); const inspectContainer = docker.inspectContainer.bind(docker); const inspectImage = docker.inspectImage.bind(docker);
  docker.inspectContainer = async id => { const inspect = await inspectContainer(id); inspect.Config.Entrypoint = null; return inspect; };
  docker.inspectImage = async id => { const inspect = await inspectImage(id); if (id !== BASE) inspect.Config.Entrypoint = null; return inspect; };
  const result = await buildToolArtifact(proposal(), { docker, sessionId: SESSION });
  assert.equal(result.checks.every(check => check.passed), true);
});

test('the full 200000-byte source allowance is uploaded in OS-safe argument chunks', async () => {
  const docker = new MemoryDocker(); const draft = proposal(); draft.script += `\n//${'x'.repeat(200000 - Buffer.byteLength(draft.script) - 3)}`;
  await buildToolArtifact(draft, { docker, sessionId: SESSION });
  assert.equal(docker.files.get('container-1:/opt/tool/main.mjs').toString(), draft.script);
  const upload = docker.calls.find(call => call.method === 'exec').args[1];
  assert.ok(upload.slice(3).length > 1); assert.ok(upload.slice(3).every(chunk => chunk.length <= 60000));
});

test('business inputs above 64KiB are rejected before any Docker access including later build cases', async () => {
  const docker = new MemoryDocker(); const draft = proposal(); draft.testCases[1].input.sequence = 'A'.repeat(65536);
  await assert.rejects(buildToolArtifact(draft, { docker, sessionId: SESSION }), /64.*KiB|65536/);
  assert.equal(docker.calls.length, 0);
  const ready = new MemoryDocker(); const { artifact } = await buildToolArtifact(proposal(), { docker: ready, sessionId: SESSION });
  ready.calls = [];
  await assert.rejects(executeToolArtifact(artifact, { sequence: 'A'.repeat(65536) }, { docker: ready }), /64.*KiB|65536/);
  assert.equal(ready.calls.length, 0);
});

test('syntax failure diagnostics persist before rejection and exact cleanup without commit', async () => {
  const docker = new MemoryDocker(); const exec = docker.exec.bind(docker); const events = [];
  docker.exec = async (id, command, options) => command[1] === '--check'
    ? { exitCode: 1, stdout: 'syntax stdout marker', stderr: 'syntax stderr marker' }
    : exec(id, command, options);
  await assert.rejects(buildToolArtifact(proposal(), { docker, sessionId: SESSION, onEvent: async event => events.push(event) }), /syntax check failed/);
  const syntax = events.find(event => event.type === 'syntax_checked');
  assert.ok(syntax, 'failed syntax stage must leave an event');
  assert.equal(syntax.passed, false);
  assert.deepEqual(syntax.result, { exitCode: 1, stdout: 'syntax stdout marker', stderr: 'syntax stderr marker' });
  assert.equal(syntax.containerId, 'container-1'); assert.equal(syntax.imageDigest, BASE);
  assert.ok(events.indexOf(syntax) < events.findIndex(event => event.type === 'container_cleaned'));
  assert.equal(docker.calls.some(call => call.method === 'commitContainer'), false);
  assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
});

test('every failed smoke result persists protocol and stderr evidence before rejection and cleanup', async () => {
  for (const raw of [
    { exitCode: 1, stdout: '{"length":4}', stderr: 'nonzero smoke marker' },
    { exitCode: 0, stdout: 'not json', stderr: 'protocol smoke marker' },
    { exitCode: 0, stdout: '{"length":999}', stderr: 'assertion smoke marker' },
  ]) {
    const docker = new MemoryDocker(); const exec = docker.exec.bind(docker); const events = [];
    docker.exec = async (id, command, options) => command[0] === '/bin/sh' ? clone(raw) : exec(id, command, options);
    await assert.rejects(buildToolArtifact(proposal(), { docker, sessionId: SESSION, onEvent: async event => events.push(event) }), /Build smoke assertion failed/);
    const smoke = events.find(event => event.type === 'build_smoke_checked');
    assert.ok(smoke, 'failed smoke stage must leave an event');
    assert.equal(smoke.passed, false); assert.equal(smoke.result.exitCode, raw.exitCode);
    assert.equal(smoke.result.stdout, raw.stdout); assert.equal(smoke.result.stderr, raw.stderr);
    assert.equal(smoke.result.protocolValid, raw.stdout !== 'not json');
    assert.equal(smoke.result.timedOut, false);
    assert.ok(events.indexOf(smoke) < events.findIndex(event => event.type === 'container_cleaned'));
    assert.equal(docker.calls.some(call => call.method === 'commitContainer'), false);
    assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
  }
});
