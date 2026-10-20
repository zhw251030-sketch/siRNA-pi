// Independently implemented against the observable controller protocol; this
// bounded learning service does not register, activate or fully validate tools.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { checkToolProposal, expectedOutputMatches } from './tool-contract.mjs';

export const TOOL_BASE_IMAGE = 'sha256:e34a8f3fe6b2b74a3fa7f1a6143a126ae1e5414fa8a334c7bba82fe57d28971b';
export const TOOL_COMMAND = Object.freeze(['/usr/bin/node', '/opt/tool/main.mjs']);
const PROJECT = 'siRNA-pi';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const SHELL = 'encoded="$1"; shift; printf \'%s\' "$encoded" | base64 -d | exec "$@"';
const WRITE_SOURCE = 'const fs=require("node:fs");fs.mkdirSync("/opt/tool",{recursive:true,mode:0o755});fs.chmodSync("/opt/tool",0o755);fs.writeFileSync("/opt/tool/main.mjs",Buffer.from(process.argv.slice(1).join(""),"base64"),{mode:0o644});fs.chmodSync("/opt/tool/main.mjs",0o644);';
const READ_HASH = 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync("/opt/tool/main.mjs")).digest("hex"));';

function must(condition, message) { if (!condition) throw new Error(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }

// Inspect descriptors before cloning so getters, toJSON hooks and omitted JSON
// properties cannot alter an artifact or business input during validation.
function jsonCopy(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const array = Array.isArray(value);
  must(typeof value === 'object' && (object(value) || (array && Object.getPrototypeOf(value) === Array.prototype)), 'Expected JSON data');
  must(!ancestors.has(value), 'JSON data contains a cycle');
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  must(!array || keys.length === value.length + 1, 'Expected a dense JSON array');
  const result = array ? [] : Object.create(null);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    must(typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value') &&
      (!array || (/^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length)), 'Expected JSON data properties');
    Object.defineProperty(result, key, { value: jsonCopy(descriptor.value, ancestors), enumerable: true, writable: true, configurable: true });
  }
  ancestors.delete(value);
  return result;
}
function controls(timeoutMs, sessionId) {
  must(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 30000, 'timeoutMs must be an integer from 100 to 30000');
  if (sessionId !== undefined) must(typeof sessionId === 'string' && UUID.test(sessionId), 'sessionId must be a strict UUID');
}
function eventSink(callback) {
  must(typeof callback === 'function', 'onEvent must be a function');
  return event => callback(JSON.parse(JSON.stringify(event)));
}
function labels(sessionId, role) {
  return { 'sirna.learning.project': PROJECT, 'sirna.tool.build-session': sessionId, 'sirna.learning.role': role };
}
function policy(run) {
  return {
    user: run ? '65534:65534' : '0:0', workingDir: '/tmp', networkDisabled: true,
    networkMode: 'none', memoryBytes: 1073741824, pidsLimit: 64,
    capDrop: ['ALL'], securityOpt: ['no-new-privileges'], readonlyRootfs: run,
    tmpfs: run ? { '/tmp': 'rw,nosuid,nodev,size=64m,mode=1777' } : {},
    binds: false, privileged: false, hostEnvironmentInherited: false,
  };
}
function configuration(image, sessionId, role, command) {
  const run = role === 'run';
  return {
    Image: image, Entrypoint: [], Cmd: [...command], User: run ? '65534:65534' : '0:0',
    WorkingDir: '/tmp', Env: [], NetworkDisabled: true, Labels: labels(sessionId, role),
    HostConfig: {
      NetworkMode: 'none', Memory: 1073741824, PidsLimit: 64,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      ...(run ? { ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=64m,mode=1777' } } : {}),
    },
  };
}
function noVolumes(image) { return !image.Config?.Volumes || Object.keys(image.Config.Volumes).length === 0; }
function emptyEntrypoint(value) { return value === null || (Array.isArray(value) && value.length === 0); }
function boundInput(input) {
  must(Buffer.byteLength(JSON.stringify(input), 'utf8') <= 65536, 'Business input exceeds the 64KiB (65536 bytes) JSON limit');
}
function imageSummary(image) {
  return { imageDigest: image.Id, platform: `${image.Os}/${image.Architecture}`, volumesAbsent: noVolumes(image) };
}
function inspectPolicy(inspect, sessionId, role, imageDigest, expectedCommand) {
  const config = inspect.Config ?? {}; const host = inspect.HostConfig ?? {}; const run = role === 'run';
  for (const [key, value] of Object.entries(labels(sessionId, role))) must(config.Labels?.[key] === value, 'Container ownership labels do not match');
  must(emptyEntrypoint(config.Entrypoint) && isDeepStrictEqual(config.Cmd, expectedCommand), 'Actual container command or entrypoint differs');
  must(config.User === (run ? '65534:65534' : '0:0') && config.WorkingDir === '/tmp', 'Actual container user or working directory is unsafe');
  must(config.NetworkDisabled === true && host.NetworkMode === 'none', 'Actual container network policy is unsafe');
  must(host.Memory === 1073741824 && host.PidsLimit === 64, 'Actual container resource limits differ');
  must(Array.isArray(host.CapDrop) && host.CapDrop.length === 1 && host.CapDrop[0].toUpperCase() === 'ALL', 'Actual container capabilities differ');
  must(Array.isArray(host.SecurityOpt) && host.SecurityOpt.some(value => /^no-new-privileges(?::true)?$/.test(value)), 'Actual no-new-privileges policy missing');
  must(!host.Privileged && (!host.Binds || host.Binds.length === 0) && (!host.VolumesFrom || host.VolumesFrom.length === 0) &&
    (!host.Devices || host.Devices.length === 0) && (!config.Volumes || Object.keys(config.Volumes).length === 0), 'Actual container has forbidden mounts or privilege');
  must((inspect.Mounts ?? []).every(mount => run && mount.Type === 'tmpfs' && mount.Destination === '/tmp'), 'Actual container has an unexpected mount');
  must(!inspect.Image || inspect.Image === imageDigest, 'Actual container image differs');
  if (run) {
    must(host.ReadonlyRootfs === true && host.Tmpfs?.['/tmp'] === 'rw,nosuid,nodev,size=64m,mode=1777' && Object.keys(host.Tmpfs).length === 1, 'Actual readonly filesystem policy differs');
  }
  return { user: config.User, workingDir: config.WorkingDir, networkDisabled: config.NetworkDisabled,
    hostConfig: { networkMode: host.NetworkMode, memory: host.Memory, pidsLimit: host.PidsLimit,
      capDrop: [...host.CapDrop], securityOpt: [...host.SecurityOpt], readonlyRootfs: host.ReadonlyRootfs === true,
      tmpfs: { ...(host.Tmpfs ?? {}) }, privileged: host.Privileged === true, bindsAbsent: !host.Binds?.length },
    mounts: (inspect.Mounts ?? []).map(mount => ({ type: mount.Type, destination: mount.Destination })) };
}
function notFound(error) { return error?.statusCode === 404 || error?.status === 404; }
async function cleanup(docker, owned, onEvent, originalError) {
  if (!owned.containerId) return;
  try {
    let inspect;
    try { inspect = await docker.inspectContainer(owned.containerId); }
    catch (error) { if (!notFound(error)) throw error; }
    if (inspect) {
      for (const [key, value] of Object.entries(labels(owned.sessionId, owned.role))) {
        must(inspect.Config?.Labels?.[key] === value, 'Refusing cleanup: container ownership differs');
      }
      await docker.removeContainer(owned.containerId, true);
    }
    await onEvent({ type: 'container_cleaned', sessionId: owned.sessionId, containerId: owned.containerId,
      ...(owned.imageDigest ? { imageDigest: owned.imageDigest } : {}), alreadyAbsent: !inspect });
    owned.containerId = null;
  } catch (error) {
    const failure = new Error(`Cleanup failed for container ${owned.containerId}: ${error.message}`, { cause: originalError ?? error });
    failure.containerId = owned.containerId; failure.cleanupError = error; throw failure;
  }
}
function envelopeCommand(input) {
  const envelope = { protocolVersion: 'sirna-approved-tool-call/v1', toolCallId: randomUUID(), input };
  return ['/bin/sh', '-c', SHELL, 'sirna-tool-call', Buffer.from(JSON.stringify(envelope)).toString('base64'), ...TOOL_COMMAND];
}
function parsedRun(raw, timedOut = false) {
  must(Number.isInteger(raw.exitCode) || (timedOut && raw.exitCode === null), 'Docker returned invalid exit code');
  must(typeof raw.stdout === 'string' && typeof raw.stderr === 'string', 'Docker returned invalid logs');
  let output = null; let protocolValid = false;
  try { output = JSON.parse(raw.stdout.trim()); jsonCopy(output); protocolValid = object(output); }
  catch { output = null; /* Invalid protocol remains an execution result. */ }
  if (!protocolValid) output = null;
  return { exitCode: raw.exitCode, timedOut, stdout: raw.stdout, stderr: raw.stderr, protocolValid: protocolValid && !timedOut, output };
}
function requirePassed(run, expected, label) {
  must(run.exitCode === 0 && !run.timedOut && run.protocolValid && expectedOutputMatches(run.output, expected), `${label} assertion failed`);
}
function artifactData(value) {
  const artifact = jsonCopy(value);
  const fields = ['protocolVersion', 'imageDigest', 'command', 'platform', 'createdAt', 'buildSessionId'];
  must(object(artifact) && Object.keys(artifact).length === fields.length && fields.every(field => Object.hasOwn(artifact, field)), 'Invalid runtime artifact fields');
  must(artifact.protocolVersion === 'sirna-tool-runtime-artifact/v1' && DIGEST.test(artifact.imageDigest), 'Invalid runtime artifact protocol or image digest');
  must(isDeepStrictEqual(artifact.command, TOOL_COMMAND), 'Artifact command differs from the fixed tool command');
  must(artifact.platform === 'linux/amd64' && typeof artifact.createdAt === 'string' &&
    Number.isFinite(Date.parse(artifact.createdAt)) && new Date(artifact.createdAt).toISOString() === artifact.createdAt &&
    typeof artifact.buildSessionId === 'string' && UUID.test(artifact.buildSessionId), 'Invalid runtime artifact metadata');
  return artifact;
}
function verifyImage(image, artifact) {
  must(image.Id === artifact.imageDigest && image.Os === 'linux' && image.Architecture === 'amd64' && noVolumes(image), 'Runtime image identity or platform differs');
  const config = image.Config ?? {}; const provenance = config.Labels ?? {};
  must(config.User === '65534:65534' && config.WorkingDir === '/tmp' && emptyEntrypoint(config.Entrypoint) &&
    isDeepStrictEqual(config.Cmd, TOOL_COMMAND), 'Runtime image command, user or entrypoint differs');
  must(provenance['sirna.learning.project'] === PROJECT && provenance['sirna.tool.runtime'] === 'true' &&
    provenance['sirna.tool.build-session'] === artifact.buildSessionId && provenance['sirna.tool.base-image'] === TOOL_BASE_IMAGE &&
    provenance['sirna.tool.created-at'] === artifact.createdAt && HASH.test(provenance['sirna.tool.source-sha256']), 'Runtime image provenance differs');
  return { ...imageSummary(image), sourceSha256: provenance['sirna.tool.source-sha256'],
    command: [...config.Cmd], user: config.User, workingDir: config.WorkingDir, entrypoint: [],
    createdAt: artifact.createdAt, buildSessionId: artifact.buildSessionId };
}

export async function buildToolArtifact(proposal, { docker, sessionId = randomUUID(), onEvent = async () => {}, timeoutMs = 10000 } = {}) {
  const preflight = checkToolProposal(proposal, { requireRuntimeArtifact: false });
  must(preflight.ok, preflight.error ?? 'Invalid tool proposal');
  controls(timeoutMs, sessionId);
  onEvent = eventSink(onEvent);
  // checkToolProposal already established plain JSON data without accessors.
  const draft = JSON.parse(JSON.stringify(proposal));
  must(draft.runtime === 'node' && draft.dependencies.length === 0 && draft.permissions.profile === 'no_external_access' &&
    draft.repeatabilityMode === 'exact' && !Object.hasOwn(draft, 'runtimeArtifact') && draft.testCases.length <= 10,
  'Build supports only node, no dependencies, no_external_access, exact and no existing artifact, with at most ten test cases');
  const smokeCase = draft.testCases.find(entry => isDeepStrictEqual(entry.input, draft.smokeInput));
  must(smokeCase, 'smokeInput must match a test case input');
  boundInput(draft.smokeInput);
  for (const entry of draft.testCases) boundInput(entry.input);
  const sourceSha256 = createHash('sha256').update(draft.script).digest('hex');
  const executionPolicy = { build: policy(false), run: policy(true) };
  await onEvent({ type: 'build_preflight', sessionId, sourceSha256, baseImage: TOOL_BASE_IMAGE, policy: executionPolicy });
  const base = await docker.inspectImage(TOOL_BASE_IMAGE);
  must(base.Id === TOOL_BASE_IMAGE && base.Os === 'linux' && base.Architecture === 'amd64' && noVolumes(base), 'Fixed base image identity, platform or volumes differ');
  await onEvent({ type: 'base_image_checked', sessionId, ...imageSummary(base) });
  const owned = { sessionId, role: 'build', containerId: null, imageDigest: TOOL_BASE_IMAGE };
  let originalError; let artifact; let buildSmoke;
  try {
    const command = ['/bin/sh', '-c', 'while :; do sleep 3600; done'];
    owned.containerId = await docker.createContainer(`sirna-learning-tool-build-${sessionId}`, configuration(TOOL_BASE_IMAGE, sessionId, 'build', command));
    must(typeof owned.containerId === 'string' && owned.containerId.length > 0, 'Docker returned no build container ID');
    await onEvent({ type: 'build_container_created', sessionId, containerId: owned.containerId, imageDigest: TOOL_BASE_IMAGE, policy: executionPolicy.build });
    const actualPolicy = inspectPolicy(await docker.inspectContainer(owned.containerId), sessionId, 'build', TOOL_BASE_IMAGE, command);
    await onEvent({ type: 'build_policy_checked', sessionId, containerId: owned.containerId, imageDigest: TOOL_BASE_IMAGE, actualPolicy });
    await docker.startContainer(owned.containerId);
    const exec = command => docker.exec(owned.containerId, command, { timeoutMs, user: '0:0' });
    const sourceChunks = Buffer.from(draft.script).toString('base64').match(/.{1,60000}/g);
    const upload = await exec(['/usr/bin/node', '-e', WRITE_SOURCE, ...sourceChunks]);
    must(upload.exitCode === 0, 'Source upload failed');
    const syntax = await exec(['/usr/bin/node', '--check', '/opt/tool/main.mjs']);
    await onEvent({ type: 'syntax_checked', sessionId, containerId: owned.containerId, imageDigest: TOOL_BASE_IMAGE,
      passed: syntax.exitCode === 0, result: { exitCode: syntax.exitCode, stdout: syntax.stdout, stderr: syntax.stderr } });
    must(syntax.exitCode === 0, 'Candidate syntax check failed');
    const readback = await exec(['/usr/bin/node', '-e', READ_HASH]);
    must(readback.exitCode === 0 && readback.stdout.trim() === sourceSha256, 'Candidate source readback hash differs');
    await onEvent({ type: 'source_checked', sessionId, containerId: owned.containerId, imageDigest: TOOL_BASE_IMAGE, sourceSha256, syntaxPassed: true, readbackMatched: true });
    buildSmoke = parsedRun(await docker.exec(owned.containerId, envelopeCommand(draft.smokeInput), { timeoutMs, user: '65534:65534' }));
    const smokePassed = buildSmoke.exitCode === 0 && !buildSmoke.timedOut && buildSmoke.protocolValid && expectedOutputMatches(buildSmoke.output, smokeCase.expectedOutput);
    await onEvent({ type: 'build_smoke_checked', sessionId, containerId: owned.containerId, imageDigest: TOOL_BASE_IMAGE, passed: smokePassed, result: buildSmoke });
    requirePassed(buildSmoke, smokeCase.expectedOutput, 'Build smoke');
    const afterSmoke = await exec(['/usr/bin/node', '-e', READ_HASH]);
    must(afterSmoke.exitCode === 0 && afterSmoke.stdout.trim() === sourceSha256, 'Candidate source changed during smoke');
    await docker.stopContainer(owned.containerId);
    const createdAt = new Date().toISOString();
    const config = { Entrypoint: [], Cmd: [...TOOL_COMMAND], User: '65534:65534', WorkingDir: '/tmp', Env: [],
      Labels: { ...labels(sessionId, 'runtime'), 'sirna.tool.runtime': 'true', 'sirna.tool.source-sha256': sourceSha256,
        'sirna.tool.base-image': TOOL_BASE_IMAGE, 'sirna.tool.created-at': createdAt } };
    const imageDigest = await docker.commitContainer(owned.containerId, 'sirna-learning-tool-runtime', sessionId, config);
    must(typeof imageDigest === 'string' && DIGEST.test(imageDigest), 'Docker commit returned no immutable image ID');
    artifact = { protocolVersion: 'sirna-tool-runtime-artifact/v1', imageDigest, command: [...TOOL_COMMAND], platform: `${base.Os}/${base.Architecture}`, createdAt, buildSessionId: sessionId };
    await onEvent({ type: 'image_committed', sessionId, containerId: owned.containerId, imageDigest, sourceSha256, artifact });
  } catch (error) { originalError = error; throw error; }
  finally { await cleanup(docker, owned, onEvent, originalError); }
  const checks = [];
  for (const entry of draft.testCases) {
    const run = await executeToolArtifact(artifact, entry.input, { docker, onEvent, timeoutMs });
    const passed = run.exitCode === 0 && !run.timedOut && run.protocolValid && expectedOutputMatches(run.output, entry.expectedOutput);
    checks.push({ name: entry.name, passed, ...run });
    await onEvent({ type: 'artifact_case_checked', sessionId, containerId: run.containerId, imageDigest: artifact.imageDigest, caseName: entry.name, passed, result: run });
    must(passed, `Artifact case ${entry.name} assertion failed`);
  }
  const result = { artifact, sourceSha256, baseImage: TOOL_BASE_IMAGE, buildSmoke, checks, executionPolicy, registered: false, activated: false, verified: false };
  await onEvent({ type: 'build_completed', sessionId, imageDigest: artifact.imageDigest, sourceSha256, caseCount: checks.length, registered: false, activated: false, verified: false });
  return result;
}

export async function executeToolArtifact(value, input, { docker, onEvent = async () => {}, timeoutMs = 10000 } = {}) {
  controls(timeoutMs);
  onEvent = eventSink(onEvent);
  const artifact = artifactData(value); const businessInput = jsonCopy(input);
  must(object(businessInput), 'Tool input must be a JSON object');
  boundInput(businessInput);
  must(!(businessInput.protocolVersion === 'sirna-approved-tool-call/v1' && typeof businessInput.toolCallId === 'string' && object(businessInput.input)), 'Tool input must not be a protocol envelope');
  const sessionId = artifact.buildSessionId; const imageDigest = artifact.imageDigest;
  const inspectedImage = verifyImage(await docker.inspectImage(imageDigest), artifact);
  await onEvent({ type: 'artifact_image_checked', sessionId, imageDigest, actualImage: inspectedImage });
  const owned = { sessionId, role: 'run', containerId: null, imageDigest };
  let originalError;
  try {
    const command = envelopeCommand(businessInput);
    owned.containerId = await docker.createContainer(`sirna-learning-tool-run-${randomUUID()}`, configuration(imageDigest, sessionId, 'run', command));
    must(typeof owned.containerId === 'string' && owned.containerId.length > 0, 'Docker returned no run container ID');
    await onEvent({ type: 'run_container_created', sessionId, containerId: owned.containerId, imageDigest, policy: policy(true) });
    const actualPolicy = inspectPolicy(await docker.inspectContainer(owned.containerId), sessionId, 'run', imageDigest, command);
    await onEvent({ type: 'run_policy_checked', sessionId, containerId: owned.containerId, imageDigest, actualPolicy });
    await docker.startContainer(owned.containerId);
    let exitCode = null; let timedOut = false;
    try { exitCode = await docker.waitContainer(owned.containerId, timeoutMs); }
    catch (error) {
      if (error?.code === 'ETIMEDOUT' || error?.code === 'DOCKER_TIMEOUT' || /timed out|timeout/i.test(error?.message ?? '')) timedOut = true;
      else throw error;
    }
    const logs = await docker.containerLogs(owned.containerId);
    const result = { ...parsedRun({ exitCode, ...logs }, timedOut), containerId: owned.containerId, imageDigest, policy: policy(true), actualPolicy };
    await onEvent({ type: 'run_completed', sessionId, containerId: owned.containerId, imageDigest, result });
    return result;
  } catch (error) { originalError = error; throw error; }
  finally { await cleanup(docker, owned, onEvent, originalError); }
}
