// Independent, bounded Docker validation. Host code treats both sources as data.
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TOOL_BASE_IMAGE, TOOL_COMMAND } from './tool-build-service.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const GUEST = '/tmp/sirna-validator/guest.mjs';
const BASELINE = '/tmp/sirna-validator/baseline.mjs';
const KEEP_ALIVE = ['/usr/bin/node', '-e', 'setInterval(()=>{},2147483647)'];
const TMPFS = { '/tmp': 'rw,nosuid,nodev,size=64m,mode=1777' };
const PREPARE = 'const fs=require("node:fs");const p=JSON.parse(Buffer.from(process.argv.slice(1).join(""),"base64").toString());fs.mkdirSync("/tmp/sirna-validator",{mode:0o755});fs.writeFileSync("/tmp/sirna-validator/guest.mjs",p.helper,{flag:"wx",mode:0o444});fs.writeFileSync("/tmp/sirna-validator/baseline.mjs",p.baseline,{flag:"wx",mode:0o444});fs.chmodSync("/tmp/sirna-validator",0o555);fs.mkdirSync("/tmp/work",{mode:0o777});fs.chmodSync("/tmp/work",0o777);';
const helper = fs.readFileSync(new URL('../../scripts/lib/tool-validation-guest.mjs', import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
function must(value, message) { if (!value) throw new Error(message); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value)); }
function copy(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const array = Array.isArray(value);
  must(plain(value) || (array && Object.getPrototypeOf(value) === Array.prototype), 'Expected finite plain JSON data');
  must(!ancestors.has(value), 'Cyclic JSON data'); ancestors.add(value);
  const keys = Reflect.ownKeys(value); must(!array || keys.length === value.length + 1, 'Expected dense JSON array');
  const result = array ? [] : {};
  for (const key of keys) {
    if (array && key === 'length') continue;
    const prop = Object.getOwnPropertyDescriptor(value, key);
    must(typeof key === 'string' && prop.enumerable && Object.hasOwn(prop, 'value') &&
      (!array || (/^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length)), 'Expected JSON data properties');
    Object.defineProperty(result, key, { value: copy(prop.value, ancestors), enumerable: true, writable: true, configurable: true });
  }
  ancestors.delete(value); return result;
}
function data(manifest, input) {
  manifest = copy(manifest); input = copy(input);
  must(input.runtime === 'node' && input.baseline?.runtime === 'node' && Array.isArray(input.dependencies) && input.dependencies.length === 0 &&
    input.permissions?.profile === 'no_external_access' && input.repeatabilityMode === 'exact', 'Unsupported validation contract');
  for (const cases of [input.testCases, input.benchmarkCases]) must(Array.isArray(cases) && cases.length >= 1 && cases.length <= 10, 'Expected one to ten cases');
  must(typeof input.script === 'string' && typeof input.baseline.script === 'string' &&
    Buffer.byteLength(input.script) <= 200000 && Buffer.byteLength(input.baseline.script) <= 200000, 'Source limit exceeded');
  must(HASH.test(manifest.scriptSha256) && hash(input.script) === manifest.scriptSha256 &&
    HASH.test(manifest.baselineScriptSha256) && hash(input.baseline.script) === manifest.baselineScriptSha256, 'Manifest source digest mismatch');
  const artifact = input.runtimeArtifact;
  must(plain(artifact) && isDeepStrictEqual(artifact, manifest.runtimeArtifact) &&
    artifact.protocolVersion === 'sirna-tool-runtime-artifact/v1' && DIGEST.test(artifact.imageDigest) &&
    artifact.platform === 'linux/amd64' && isDeepStrictEqual(artifact.command, TOOL_COMMAND) && UUID.test(artifact.buildSessionId) &&
    typeof artifact.createdAt === 'string' && Number.isFinite(Date.parse(artifact.createdAt)) &&
    new Date(artifact.createdAt).toISOString() === artifact.createdAt, 'Invalid runtime artifact metadata');
  return { manifest, input, artifact };
}
function noVolumes(image) { return !image.Config?.Volumes || Object.keys(image.Config.Volumes).length === 0; }
function emptyEntrypoint(value) { return value === null || (Array.isArray(value) && value.length === 0); }
function environment(image) {
  const entries = image.Config?.Env ?? []; must(Array.isArray(entries), 'Invalid image environment');
  const clean = new Map();
  for (const entry of entries) {
    must(typeof entry === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(entry), 'Invalid image environment key');
    clean.set(entry.slice(0, entry.indexOf('=')), '');
  }
  for (const [key, value] of Object.entries({ PATH: '/usr/bin:/bin', HOME: '/tmp/work', NODE_OPTIONS: '', NODE_PATH: '', LD_PRELOAD: '', LD_LIBRARY_PATH: '' })) clean.set(key, value);
  return [...clean].map(([key, value]) => `${key}=${value}`);
}
function labels(id, target) { return { 'sirna.learning.project': 'siRNA-pi', 'sirna.tool.validation-run': id, 'sirna.learning.role': 'validation', 'sirna.tool.validation-target': target }; }
function config(image, id, target) {
  return { Image: image.Id, Entrypoint: [], Cmd: [...KEEP_ALIVE], User: '65534:65534', WorkingDir: '/tmp', Env: environment(image),
    NetworkDisabled: true, Labels: labels(id, target), HostConfig: { NetworkMode: 'none', Memory: 1073741824, PidsLimit: 64,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], ReadonlyRootfs: true, Tmpfs: { ...TMPFS } } };
}
function actualPolicy(inspect, expected) {
  const c = inspect.Config ?? {}; const h = inspect.HostConfig ?? {}; const wanted = expected.HostConfig;
  for (const [key, value] of Object.entries(expected.Labels)) must(c.Labels?.[key] === value, 'Container ownership policy differs');
  must(inspect.Image === expected.Image, 'Container image policy differs');
  must(c.User === expected.User && c.WorkingDir === expected.WorkingDir && emptyEntrypoint(c.Entrypoint) && isDeepStrictEqual(c.Cmd, expected.Cmd), 'Container user or command policy differs');
  must(c.NetworkDisabled === true && h.NetworkMode === 'none', 'Container network policy differs');
  must(h.Memory === wanted.Memory && h.PidsLimit === 64 && isDeepStrictEqual(h.CapDrop?.map(v => v.toUpperCase()), ['ALL']) && !h.CapAdd?.length &&
    Array.isArray(h.SecurityOpt) && h.SecurityOpt.length === 1 && /^no-new-privileges(?::true)?$/.test(h.SecurityOpt[0]), 'Container resource or capability policy differs');
  must(h.ReadonlyRootfs === true && isDeepStrictEqual(h.Tmpfs, TMPFS), 'Container readonly filesystem policy differs');
  must(!h.Privileged && !h.Binds?.length && !h.VolumesFrom?.length && !h.Devices?.length && !h.DeviceRequests?.length &&
    !h.Mounts?.length && (!c.Volumes || Object.keys(c.Volumes).length === 0) && !h.PidMode &&
    (!h.IpcMode || h.IpcMode === 'private') && !h.UsernsMode, 'Container mount or privilege policy differs');
  must((inspect.Mounts ?? []).every(m => m.Type === 'tmpfs' && m.Destination === '/tmp'), 'Unexpected container mount');
  must(isDeepStrictEqual([...(c.Env ?? [])].sort(), [...expected.Env].sort()), 'Container environment policy differs');
  return { user: c.User, workingDir: '/tmp/work', controllerWorkingDir: c.WorkingDir, networkDisabled: true, networkMode: 'none', memoryBytes: h.Memory,
    pidsLimit: h.PidsLimit, capDrop: ['ALL'], securityOpt: ['no-new-privileges'], readonlyRootfs: true, tmpfs: { ...TMPFS },
    bindsAbsent: true, privileged: false, hostEnvironmentInherited: false, imageEnvironmentCleared: true, cpuQuotaApplied: false,
    preparationUser: '0:0', executionUser: '65534:65534', digestUser: '0:0', filesDigestScope: '/tmp/work' };
}
function notFound(error) { return error?.statusCode === 404 || error?.status === 404; }
function boundedLogs(raw) {
  must(typeof raw.stdout === 'string' && typeof raw.stderr === 'string', 'Invalid Docker execution logs');
  must(Buffer.byteLength(raw.stdout) + Buffer.byteLength(raw.stderr) <= 65536, 'Docker execution output limit exceeded');
  return raw;
}
function toolLogs(raw) {
  must(typeof raw.stdout === 'string' && typeof raw.stderr === 'string', 'Invalid tool execution logs');
  const length = Buffer.byteLength(raw.stdout) + Buffer.byteLength(raw.stderr);
  function truncate(value, limit) {
    const bytes = Buffer.from(value); if (bytes.length <= limit) return value;
    let end = limit; let result = bytes.subarray(0, end).toString('utf8');
    while (Buffer.byteLength(result) > limit) { end--; result = bytes.subarray(0, end).toString('utf8'); }
    return result;
  }
  const stdout = truncate(raw.stdout, 65536); const stderr = truncate(raw.stderr, 65536 - Buffer.byteLength(stdout));
  return { ...raw, stdout, stderr, outputLimitExceeded: raw.outputLimitExceeded || length > 65536 };
}
function parseRun(raw) {
  let output = null; let protocolValid = false;
  try { output = JSON.parse(raw.stdout.trim()); copy(output); protocolValid = plain(output); } catch { output = null; }
  if (!protocolValid) output = null;
  return { exitCode: raw.exitCode, timedOut: raw.timedOut, cancelled: false, protocolValid: protocolValid && !raw.timedOut && !raw.outputLimitExceeded,
    output, stdout: raw.stdout, stderr: raw.stderr, outputLimitExceeded: raw.outputLimitExceeded };
}

export function createDockerValidationRunner({ docker, timeoutMs = 10000, onEvent = async () => {} } = {}) {
  must(docker && ['inspectImage', 'createContainer', 'inspectContainer', 'startContainer', 'exec', 'removeContainer'].every(name => typeof docker[name] === 'function'), 'Docker validation adapter is required');
  must(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 30000, 'timeoutMs must be an integer from 100 to 30000');
  must(typeof onEvent === 'function', 'onEvent must be a function');
  const emit = event => onEvent(copy(event));
  async function imageFor(materials, target) {
    const { artifact, manifest } = materials;
    const image = await docker.inspectImage(target === 'candidate' ? artifact.imageDigest : TOOL_BASE_IMAGE);
    must(image.Id === (target === 'candidate' ? artifact.imageDigest : TOOL_BASE_IMAGE) && image.Os === 'linux' && image.Architecture === 'amd64' && noVolumes(image), 'Immutable image identity, platform or volumes differ');
    if (target === 'candidate') {
      const c = image.Config ?? {}; const l = c.Labels ?? {};
      must(c.User === '65534:65534' && c.WorkingDir === '/tmp' && emptyEntrypoint(c.Entrypoint) && isDeepStrictEqual(c.Cmd, TOOL_COMMAND), 'Runtime image command metadata differs');
      must(l['sirna.learning.project'] === 'siRNA-pi' && l['sirna.tool.runtime'] === 'true' && l['sirna.tool.build-session'] === artifact.buildSessionId &&
        l['sirna.tool.base-image'] === TOOL_BASE_IMAGE && l['sirna.tool.created-at'] === artifact.createdAt && l['sirna.tool.source-sha256'] === manifest.scriptSha256, 'Runtime image source provenance differs');
    }
    return image;
  }
  async function inContainer(materials, target, operation) {
    const image = await imageFor(materials, target); const id = randomUUID(); const expected = config(image, id, target);
    let containerId; let originalError;
    try {
      containerId = await docker.createContainer(`sirna-tool-validation-${id}`, expected);
      must(typeof containerId === 'string' && containerId.length > 0, 'Docker returned no container ID');
      const policy = actualPolicy(await docker.inspectContainer(containerId), expected);
      await emit({ type: 'validation_container_created', containerId, imageDigest: image.Id, target, actualPolicy: policy });
      await docker.startContainer(containerId);
      const exec = (command, user = '0:0', duration = timeoutMs) => docker.exec(containerId, command, { user, timeoutMs: duration });
      const encoded = Buffer.from(JSON.stringify({ helper, baseline: materials.input.baseline.script })).toString('base64');
      const prepared = boundedLogs(await exec(['/usr/bin/node', '-e', PREPARE, ...encoded.match(/.{1,60000}/g)]));
      must(prepared.exitCode === 0, 'Trusted helper preparation failed');
      const source = target === 'candidate' ? '/opt/tool/main.mjs' : BASELINE;
      const sourceDigest = target === 'candidate' ? materials.manifest.scriptSha256 : materials.manifest.baselineScriptSha256;
      const actual = boundedLogs(await exec(['/usr/bin/node', GUEST, 'source-hash', source]));
      must(actual.exitCode === 0 && actual.stdout.trim() === sourceDigest, 'Actual container source digest differs from manifest');
      return await operation({ exec, containerId, imageDigest: image.Id, actualPolicy: policy, source: target === 'candidate' ? '/opt/tool/main.mjs' : BASELINE });
    } catch (error) { originalError = error; throw error; }
    finally {
      if (containerId) {
        try {
          let inspect;
          try { inspect = await docker.inspectContainer(containerId); } catch (error) { if (!notFound(error)) throw error; }
          if (inspect) {
            for (const [key, value] of Object.entries(expected.Labels)) must(inspect.Config?.Labels?.[key] === value, 'Refusing cleanup: container ownership differs');
            await docker.removeContainer(containerId, true);
            let absent = false;
            try { await docker.inspectContainer(containerId); } catch (error) { if (!notFound(error)) throw error; absent = true; }
            must(absent, 'Container removal was not confirmed');
          }
          await emit({ type: 'validation_container_cleaned', containerId, imageDigest: image.Id, target });
        } catch (error) { throw Object.assign(new Error(`Validation cleanup failed for ${containerId}`, { cause: originalError ?? error }), { containerId, cleanupError: error }); }
      }
    }
  }
  return {
    async checkSources({ manifest, input }) {
      const materials = data(manifest, input); const syntaxChecks = []; const policies = {};
      for (const target of ['candidate', 'baseline']) {
        syntaxChecks.push(await inContainer(materials, target, async ({ exec, source, actualPolicy: policy }) => {
          const command = ['/usr/bin/node', '--check', source];
          const raw = boundedLogs(await exec(command, '65534:65534'));
          policies[target] = policy;
          return { target, command, exitCode: raw.exitCode, timedOut: false, stdout: raw.stdout, stderr: raw.stderr, passed: raw.exitCode === 0 };
        }));
      }
      return { syntaxChecks, runtimeArtifactVerified: true, executionPolicy: policies };
    },
    async run({ target, manifest, input, caseInput, toolCallId }) {
      must(['candidate', 'baseline'].includes(target), 'Invalid validation target');
      const materials = data(manifest, input); const business = copy(caseInput);
      must(plain(business) && Buffer.byteLength(JSON.stringify(business)) <= 65536, 'Business input must be an object within 64KiB');
      must(!(business.protocolVersion === 'sirna-approved-tool-call/v1' && typeof business.toolCallId === 'string' && plain(business.input)), 'Business input must not be a protocol envelope');
      must(typeof toolCallId === 'string' && UUID.test(toolCallId), 'toolCallId must be a strict UUID');
      const envelope = Buffer.from(JSON.stringify({ protocolVersion: 'sirna-approved-tool-call/v1', toolCallId, input: business })).toString('base64');
      return inContainer(materials, target, async ({ exec, source, ...evidence }) => {
        // Docker deadlines/limits cover control transport too; only the trusted
        // guest's JSON can establish a scored tool timeout or output overflow.
        const response = await exec(['/usr/bin/node', GUEST, 'run', source, envelope, String(timeoutMs)], '65534:65534', timeoutMs + 2000);
        must(response.exitCode === 0 && typeof response.stdout === 'string' && response.stdout.length <= 512 * 1024, 'Trusted execution helper failed');
        let raw;
        try { raw = JSON.parse(response.stdout); } catch { throw new Error('Trusted execution helper returned invalid JSON'); }
        must((Number.isInteger(raw.exitCode) || raw.exitCode === null) && typeof raw.timedOut === 'boolean' && typeof raw.outputLimitExceeded === 'boolean', 'Invalid trusted execution result');
        raw = toolLogs(raw);
        const stopped = boundedLogs(await exec(['/usr/bin/node', GUEST, 'quiesce'], '65534:65534'));
        must(stopped.exitCode === 0, 'Could not quiesce tool processes before hashing');
        const digest = boundedLogs(await exec(['/usr/bin/node', GUEST, 'digest']));
        const digestValid = digest.exitCode === 0 && HASH.test(digest.stdout.trim());
        const result = { ...parseRun(raw), filesDigest: digestValid ? digest.stdout.trim() : null, ...evidence };
        if (!digestValid) { result.protocolValid = false; result.filesDigestError = 'Workspace digest failed (links, special files, mutation or resource bounds)'; }
        return result;
      });
    },
  };
}
