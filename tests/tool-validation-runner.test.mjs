import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { DockerBoundary } from './helpers/validation-docker-boundary.mjs';

const module = await import('../packages/capability-platform/tool-validation-runner.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error;
});
const BASE = 'sha256:e34a8f3fe6b2b74a3fa7f1a6143a126ae1e5414fa8a334c7bba82fe57d28971b';
const IMAGE = `sha256:${'b'.repeat(64)}`;
const SESSION = '1b259aaf-e661-40a3-a372-e166bdff2963';
const COMMAND = ['/usr/bin/node', '/opt/tool/main.mjs'];
const hash = value => createHash('sha256').update(value).digest('hex');
function materials() {
  const runtimeArtifact = { protocolVersion: 'sirna-tool-runtime-artifact/v1', imageDigest: IMAGE,
    command: COMMAND, platform: 'linux/amd64', createdAt: '2026-10-20T00:00:00.000Z', buildSessionId: SESSION };
  const input = { runtime: 'node', dependencies: [], permissions: { profile: 'no_external_access' }, repeatabilityMode: 'exact',
    script: 'console.log("candidate data, never host execute");', baseline: { runtime: 'node', script: 'console.log("baseline snapshot");' },
    testCases: [{ input: {} }], benchmarkCases: [{ input: {} }], runtimeArtifact };
  return { input, manifest: { scriptSha256: hash(input.script), baselineScriptSha256: hash(input.baseline.script), runtimeArtifact } };
}

test('syntax and candidate/baseline runs bind actual image bytes and use separate confined containers', async () => {
  assert.equal(typeof module.createDockerValidationRunner, 'function', 'validation runner must exist');
  const data = materials(); const docker = new DockerBoundary(data); const events = [];
  const runner = module.createDockerValidationRunner({ docker, onEvent: event => { events.push(event); } });
  const check = await runner.checkSources(data);
  assert.equal(check.runtimeArtifactVerified, true); assert.equal(check.syntaxChecks.length, 2);
  assert.deepEqual(check.syntaxChecks.map(c => [c.target, c.passed]), [['candidate', true], ['baseline', true]]);
  const candidate = await runner.run({ ...data, target: 'candidate', caseInput: { sequence: 'AC' }, toolCallId: SESSION });
  docker.filesDigest = hash('f:answer.txt\0changed');
  const baseline = await runner.run({ ...data, target: 'baseline', caseInput: { sequence: 'AC' }, toolCallId: SESSION });
  assert.equal(candidate.protocolValid, true); assert.deepEqual(candidate.output, { ok: true });
  assert.equal(candidate.cancelled, false); assert.equal(candidate.filesDigest, hash('f:answer.txt\0hello'));
  assert.notEqual(candidate.filesDigest, baseline.filesDigest); assert.notEqual(candidate.containerId, baseline.containerId);
  assert.equal(candidate.imageDigest, IMAGE); assert.equal(baseline.imageDigest, BASE);
  for (const [, , config] of docker.calls.filter(c => c[0] === 'createContainer')) {
    assert.equal(config.User, '65534:65534'); assert.deepEqual(config.Entrypoint, []);
    assert.equal(config.NetworkDisabled, true); assert.equal(config.HostConfig.NetworkMode, 'none');
    assert.equal(config.HostConfig.Memory, 1073741824); assert.equal(config.HostConfig.PidsLimit, 64);
    assert.equal(config.HostConfig.ReadonlyRootfs, true); assert.deepEqual(config.HostConfig.CapDrop, ['ALL']);
    assert.deepEqual(config.HostConfig.SecurityOpt, ['no-new-privileges']);
    assert.deepEqual(config.HostConfig.Tmpfs, { '/tmp': 'rw,nosuid,nodev,size=64m,mode=1777' });
    assert.equal(config.HostConfig.Binds, undefined); assert.equal(config.HostConfig.NanoCpus, undefined);
  }
  assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
  assert.equal(JSON.stringify(events).includes('not-for-events'), false);
  assert.equal(JSON.stringify(events).includes('"Env"'), false);
  const execs = docker.calls.filter(c => c[0] === 'exec');
  assert.ok(execs.some(c => c[2][2] === 'digest' && c[3].user === '0:0'));
});

test('label or actual source mismatch blocks candidate execution and cleans the owned container', async () => {
  assert.equal(typeof module.createDockerValidationRunner, 'function');
  for (const kind of ['badLabels', 'sourceMismatch']) {
    const data = materials(); const docker = new DockerBoundary(data); docker[kind] = true;
    await assert.rejects(module.createDockerValidationRunner({ docker }).run({ ...data, target: 'candidate', caseInput: { sequence: 'AC' }, toolCallId: SESSION }), /source/i);
    assert.equal(docker.calls.some(c => c[0] === 'exec' && c[2][2] === 'run'), false);
    assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
  }
});

test('inspection refuses unsafe mounts/network/user/rootfs before execution', async () => {
  assert.equal(typeof module.createDockerValidationRunner, 'function');
  for (const unsafe of [i => { i.HostConfig.NetworkMode = 'host'; }, i => { i.Config.User = '0:0'; },
    i => { i.HostConfig.ReadonlyRootfs = false; }, i => { i.HostConfig.Binds = ['/host:/work']; },
    i => { i.HostConfig.CapAdd = ['SYS_ADMIN']; }, i => { i.HostConfig.IpcMode = 'container:other'; },
    i => { i.HostConfig.SecurityOpt.push('seccomp=unconfined'); },
    i => { i.Mounts = [{ Type: 'bind', Destination: '/tmp' }]; }]) {
    const data = materials(); const docker = new DockerBoundary(data); docker.unsafe = unsafe;
    await assert.rejects(module.createDockerValidationRunner({ docker }).run({ ...data, target: 'candidate', caseInput: { sequence: 'AC' }, toolCallId: SESSION }), /policy|mount|user|network/i);
    assert.equal(docker.calls.some(c => c[0] === 'startContainer'), false);
  }
});

test('timeout, nonzero, invalid object and output overflow are unsuccessful complete records', async () => {
  assert.equal(typeof module.createDockerValidationRunner, 'function');
  for (const result of [{ timedOut: true, exitCode: null }, { exitCode: 2 }, { stdout: '[]' }, { stdout: '{"x":1e999}' },
    { stdout: '{}\n{}' }, { outputLimitExceeded: true }]) {
    const data = materials(); const docker = new DockerBoundary(data); Object.assign(docker.result, result);
    const run = await module.createDockerValidationRunner({ docker }).run({ ...data, target: 'candidate', caseInput: { sequence: 'AC' }, toolCallId: SESSION });
    assert.ok(run.exitCode !== 0 || !run.protocolValid || run.timedOut);
    assert.equal(typeof run.filesDigest, 'string'); assert.equal(typeof run.stdout, 'string'); assert.equal(run.cancelled, false);
    assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
  }
});

test('cleanup errors or unconfirmed removal cannot return success', async () => {
  assert.equal(typeof module.createDockerValidationRunner, 'function');
  for (const kind of ['removeFailure', 'pretendRemoved']) {
    const data = materials(); const docker = new DockerBoundary(data); docker[kind] = true;
    await assert.rejects(module.createDockerValidationRunner({ docker }).run({ ...data, target: 'candidate', caseInput: { sequence: 'AC' }, toolCallId: SESSION }), /cleanup/i);
    assert.equal(docker.containers.has('old-unrelated'), true);
  }
});

test('unsupported contract, invalid input and source mutation fail before Docker access', async () => {
  assert.equal(typeof module.createDockerValidationRunner, 'function');
  for (const mutate of [d => { d.input.runtime = 'python'; }, d => { d.input.dependencies = ['x']; },
    d => { d.input.script = 'changed'; }, d => { d.input.baseline.script = 'changed'; }]) {
    const data = materials(); mutate(data); const docker = new DockerBoundary(data);
    await assert.rejects(module.createDockerValidationRunner({ docker }).run({ ...data, target: 'candidate', caseInput: { sequence: 'AC' }, toolCallId: SESSION }));
    assert.equal(docker.calls.length, 0);
  }
  const data = materials(); const docker = new DockerBoundary(data);
  await assert.rejects(module.createDockerValidationRunner({ docker }).run({ ...data, target: 'candidate', caseInput: { x: 'x'.repeat(65536) }, toolCallId: SESSION }));
  assert.equal(docker.calls.length, 0);
});

test('baseline bytes are read back from the saved snapshot before syntax or execution', async () => {
  const data = materials(); const docker = new DockerBoundary(data); docker.sourceMismatch = true;
  await assert.rejects(module.createDockerValidationRunner({ docker }).run({ ...data, target: 'baseline', caseInput: { sequence: 'AC' }, toolCallId: SESSION }), /source/i);
  assert.equal(docker.calls.some(c => c[0] === 'exec' && c[2][2] === 'run'), false);
});

test('oversized tool logs and invalid workspace digest are explicit failed records', async () => {
  for (const kind of ['logs', 'files']) {
    const data = materials(); const docker = new DockerBoundary(data);
    if (kind === 'logs') docker.result.stdout = 'x'.repeat(65537);
    else docker.filesDigest = 'not-a-digest';
    const result = await module.createDockerValidationRunner({ docker }).run({ ...data, target: 'candidate', caseInput: { sequence: 'AC' }, toolCallId: SESSION });
    assert.equal(result.protocolValid, false);
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 65536);
    if (kind === 'logs') assert.equal(result.outputLimitExceeded, true);
    else { assert.equal(result.filesDigest, null); assert.match(result.filesDigestError, /digest/i); }
  }
});

test('syntax failures are returned without candidate execution', async () => {
  const data = materials(); const docker = new DockerBoundary(data); const exec = docker.exec.bind(docker);
  docker.exec = async (id, command, options) => command[1] === '--check' ?
    { exitCode: 1, stdout: '', stderr: 'SyntaxError' } : exec(id, command, options);
  const result = await module.createDockerValidationRunner({ docker }).checkSources(data);
  assert.equal(result.runtimeArtifactVerified, true);
  assert.ok(result.syntaxChecks.every(check => !check.passed && !check.timedOut));
  assert.equal(docker.calls.some(c => c[0] === 'exec' && c[2][2] === 'run'), false);
});

test('syntax control transport deadlines and output limits propagate with owned cleanup', async () => {
  for (const code of ['DOCKER_TIMEOUT', 'DOCKER_OUTPUT_LIMIT']) {
    const data = materials(); const docker = new DockerBoundary(data); const exec = docker.exec.bind(docker);
    docker.exec = async (id, command, options) => {
      if (command[1] === '--check') throw Object.assign(new Error('syntax control transport interrupted'), { code });
      return exec(id, command, options);
    };
    await assert.rejects(module.createDockerValidationRunner({ docker }).checkSources(data), error => error.code === code);
    assert.equal(docker.calls.some(c => c[0] === 'exec' && c[2][2] === 'run'), false);
    assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
  }
});

test('event callback failure cleans the owned container without starting it', async () => {
  const data = materials(); const docker = new DockerBoundary(data);
  await assert.rejects(module.createDockerValidationRunner({ docker, onEvent: event => {
    if (event.type === 'validation_container_created') throw new Error('event failure');
  } }).checkSources(data), /event failure/);
  assert.equal(docker.calls.some(c => c[0] === 'startContainer'), false);
  assert.deepEqual([...docker.containers.keys()], ['old-unrelated']);
});

test('image command, platform and immutable provenance tampering is rejected before creation', async () => {
  for (const mutate of [image => { image.Architecture = 'arm64'; }, image => { image.Id = BASE; },
    image => { image.Config.Cmd = ['/bin/sh']; }, image => { image.Config.Volumes = { '/unexpected': {} }; },
    image => { image.Config.Labels['sirna.tool.base-image'] = IMAGE; },
    image => { image.Config.Labels['sirna.tool.created-at'] = '2020-01-01T00:00:00.000Z'; },
    image => { image.Config.Labels['sirna.tool.build-session'] = '00000000-0000-4000-8000-000000000000'; }]) {
    const data = materials(); const docker = new DockerBoundary(data); const inspect = docker.inspectImage.bind(docker);
    docker.inspectImage = async id => { const image = await inspect(id); mutate(image); return image; };
    await assert.rejects(module.createDockerValidationRunner({ docker }).checkSources(data));
    assert.equal(docker.calls.some(c => c[0] === 'createContainer'), false);
  }
});

test('callback mutation cannot alter snapshots or execution policy and inherited environment is cleared', async () => {
  const data = materials(); const docker = new DockerBoundary(data);
  const run = await module.createDockerValidationRunner({ docker, onEvent: event => {
    if (event.actualPolicy) event.actualPolicy.user = '0:0';
    data.input.script = 'mutation'; data.input.runtimeArtifact.imageDigest = BASE;
  } }).run({ ...data, target: 'candidate', caseInput: { sequence: 'AC' }, toolCallId: SESSION });
  assert.equal(run.imageDigest, IMAGE); assert.equal(run.actualPolicy.user, '65534:65534');
  const config = docker.calls.find(c => c[0] === 'createContainer')[2];
  assert.ok(config.Env.includes('SECRET=')); assert.equal(config.Env.some(e => e.includes('not-for-events')), false);
});

test('ownership change refuses removal rather than deleting an unrelated resource', async () => {
  const data = materials(); const docker = new DockerBoundary(data);
  const start = docker.startContainer.bind(docker);
  docker.startContainer = async id => {
    await start(id); docker.containers.get(id).Config.Labels['sirna.learning.project'] = 'other';
    throw new Error('start failed');
  };
  await assert.rejects(module.createDockerValidationRunner({ docker }).checkSources(data), error => {
    assert.match(error.message, /cleanup/); assert.match(error.cleanupError.message, /ownership/); return true;
  });
  assert.equal(docker.calls.some(c => c[0] === 'removeContainer'), false);
  assert.equal(docker.containers.has('old-unrelated'), true);
});

test('getters on input data are rejected without invoking host code', async () => {
  const data = materials(); const docker = new DockerBoundary(data); let accessed = false;
  const caseInput = {}; Object.defineProperty(caseInput, 'sequence', { enumerable: true, get() { accessed = true; return 'AC'; } });
  await assert.rejects(module.createDockerValidationRunner({ docker }).run({ ...data, target: 'candidate', caseInput, toolCallId: SESSION }), /JSON/);
  assert.equal(accessed, false); assert.equal(docker.calls.length, 0);
});
