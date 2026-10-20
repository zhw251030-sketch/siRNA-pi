// Independent local proposal-package format. Source strings remain data only;
// this module never builds, executes, approves or publishes a tool.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { checkToolProposal } from './tool-contract.mjs';

const protocolVersion = 'sirna-tool-proposal/v1';
const extensions = { node: 'mjs', python: 'py', bash: 'sh' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const sourceLimit = 200000;
const manifestLimit = 1024 * 1024;
const manifestFields = [
  'protocolVersion', 'id', 'version', 'status', 'name', 'toolName', 'description',
  'runtime', 'scriptFile', 'scriptSha256', 'repeatabilityMode', 'smokeInput',
  'dependencies', 'testCases', 'baselineRuntime', 'baselineScriptFile',
  'baselineScriptSha256', 'benchmarkCases', 'permissions', 'runtimeArtifact', 'createdAt',
];
const inputFields = [
  'name', 'toolName', 'description', 'runtime', 'repeatabilityMode', 'smokeInput',
  'dependencies', 'testCases', 'benchmarkCases', 'permissions', 'runtimeArtifact',
];

function requireContract(input) {
  const result = checkToolProposal(input);
  if (!result.ok) throw new Error(result.error);
  if (Object.hasOwn(input, 'parent')) throw new Error('parent proposals are not supported');
}

function requireRoot(proposalsRoot) {
  if (typeof proposalsRoot !== 'string' || !path.isAbsolute(proposalsRoot)) {
    throw new Error('proposalsRoot must be an absolute existing directory');
  }
  const root = path.resolve(proposalsRoot);
  requireDirectory(root);
  return root;
}

function requireDirectory(directory) {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) {
    throw new Error('proposal directory must be a real directory without links');
  }
  return stat;
}

function sameFile(before, after) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].every(key => before[key] === after[key]);
}

function requireStable(before, after) {
  if (!sameFile(before, after)) throw new Error('proposal file or directory changed while reading');
}

function requireRegular(stat, limit) {
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(limit)) {
    throw new Error('proposal file must be regular, unlinked and within its byte limit');
  }
}

function readBytes(file, limit) {
  const before = fs.lstatSync(file, { bigint: true });
  requireRegular(before, limit);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    requireRegular(opened, limit);
    requireStable(before, opened);
    // Allocate at most the established bound plus one byte, so growth does not
    // turn a checked stat into an unbounded readFileSync allocation.
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== Number(opened.size)) throw new Error('proposal file size changed while reading');
    requireStable(opened, fs.fstatSync(descriptor, { bigint: true }));
    requireStable(before, fs.lstatSync(file, { bigint: true }));
    return { bytes: bytes.subarray(0, length), stat: before };
  } finally {
    fs.closeSync(descriptor);
  }
}

function utf8(bytes) {
  // Preserve an initial BOM in source rather than silently deleting a byte.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function packageHash(files) {
  const digest = createHash('sha256');
  for (const name of Object.keys(files).sort()) {
    digest.update(`${name}\0`);
    digest.update(files[name]);
  }
  return digest.digest('hex');
}

function requireManifest(manifest, id) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('invalid proposal manifest');
  const fields = Object.keys(manifest);
  if (manifestFields.some(field => !Object.hasOwn(manifest, field)) ||
      fields.some(field => !manifestFields.includes(field) && field !== 'minNetGain')) {
    throw new Error('manifest must contain exactly the proposal protocol fields');
  }
  if (manifest.protocolVersion !== protocolVersion || manifest.id !== id ||
      manifest.version !== '0.1.0-draft' || manifest.status !== 'draft') {
    throw new Error('invalid proposal manifest identity, version or status');
  }
  if (!Object.hasOwn(extensions, manifest.runtime) || !Object.hasOwn(extensions, manifest.baselineRuntime) ||
      manifest.scriptFile !== `tool.${extensions[manifest.runtime]}` ||
      manifest.baselineScriptFile !== `baseline.${extensions[manifest.baselineRuntime]}`) {
    throw new Error('manifest source filenames must match the selected runtimes');
  }
  if (typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      new Date(manifest.createdAt).toISOString() !== manifest.createdAt) {
    throw new Error('manifest createdAt must be a canonical ISO timestamp');
  }
  for (const field of ['scriptSha256', 'baselineScriptSha256']) {
    if (typeof manifest[field] !== 'string' || !sha256.test(manifest[field])) throw new Error('invalid manifest source digest');
  }
}

function addContext(error, id, artifactPath) {
  const failure = error instanceof Error ? error : new Error('proposal package operation failed');
  failure.proposalId = id;
  failure.artifactPath = artifactPath;
  return failure;
}

/** Read bounded real files and validate their contract and optional trusted digest. */
export function readToolProposal(id, { proposalsRoot, expectedArtifactSha256 } = {}) {
  if (typeof id !== 'string' || !uuid.test(id)) throw new Error('proposal id must be a lowercase UUID v4');
  const root = requireRoot(proposalsRoot);
  const artifactPath = path.join(root, id);
  try {
    if (expectedArtifactSha256 !== undefined &&
        (typeof expectedArtifactSha256 !== 'string' || !sha256.test(expectedArtifactSha256))) {
      throw new Error('expectedArtifactSha256 must be a lowercase SHA-256 hex digest');
    }
    const rootBefore = requireDirectory(root);
    const directoryBefore = requireDirectory(artifactPath);
    const snapshots = new Map();
    const read = (name, limit) => {
      const file = path.join(artifactPath, name);
      const result = readBytes(file, limit);
      snapshots.set(file, result.stat);
      return result.bytes;
    };
    const manifestBytes = read('manifest.json', manifestLimit);
    let manifest;
    try {
      manifest = JSON.parse(utf8(manifestBytes));
    } catch {
      // Native JSON parse errors may quote untrusted manifest source bytes.
      throw new Error('proposal manifest must be valid UTF-8 JSON');
    }
    requireManifest(manifest, id);
    const names = ['manifest.json', manifest.scriptFile, manifest.baselineScriptFile].sort();
    const entries = fs.readdirSync(artifactPath).sort();
    if (entries.length !== names.length || entries.some((entry, index) => entry !== names[index])) {
      throw new Error('proposal package must contain exactly manifest, source and baseline');
    }
    const files = { 'manifest.json': manifestBytes };
    files[manifest.scriptFile] = read(manifest.scriptFile, sourceLimit);
    files[manifest.baselineScriptFile] = read(manifest.baselineScriptFile, sourceLimit);
    if (hash(files[manifest.scriptFile]) !== manifest.scriptSha256 ||
        hash(files[manifest.baselineScriptFile]) !== manifest.baselineScriptSha256) {
      throw new Error('proposal source digest mismatch');
    }
    const input = Object.fromEntries(inputFields.map(field => [field, manifest[field]]));
    input.script = utf8(files[manifest.scriptFile]);
    input.baseline = { runtime: manifest.baselineRuntime, script: utf8(files[manifest.baselineScriptFile]) };
    if (Object.hasOwn(manifest, 'minNetGain')) input.minNetGain = manifest.minNetGain;
    requireContract(input);
    // Recheck every file after the whole package has been read as well: an
    // earlier file can change while a later file is being read.
    for (const [file, stat] of snapshots) requireStable(stat, fs.lstatSync(file, { bigint: true }));
    requireStable(directoryBefore, requireDirectory(artifactPath));
    requireStable(rootBefore, requireDirectory(root));
    const artifactSha256 = packageHash(files);
    if (expectedArtifactSha256 !== undefined && artifactSha256 !== expectedArtifactSha256) {
      throw new Error('proposal package digest mismatch');
    }
    return { manifest, input, artifactPath, artifactSha256 };
  } catch (error) {
    throw addContext(error, id, artifactPath);
  }
}

/** Store one new draft. A partial failure is retained for lifecycle diagnosis. */
export function createToolProposal(input, { proposalsRoot } = {}) {
  requireContract(input);
  const snapshot = JSON.parse(JSON.stringify(input));
  const root = requireRoot(proposalsRoot);
  const id = randomUUID();
  const artifactPath = path.join(root, id);
  try {
    const source = Buffer.from(snapshot.script, 'utf8');
    const baseline = Buffer.from(snapshot.baseline.script, 'utf8');
    if (utf8(source) !== snapshot.script || utf8(baseline) !== snapshot.baseline.script) {
      throw new Error('source must round-trip through UTF-8 without replacement');
    }
    const manifest = {
      protocolVersion, id, version: '0.1.0-draft', status: 'draft',
      ...Object.fromEntries(inputFields.map(field => [field, snapshot[field]])),
      scriptFile: `tool.${extensions[snapshot.runtime]}`, scriptSha256: hash(source),
      baselineRuntime: snapshot.baseline.runtime,
      baselineScriptFile: `baseline.${extensions[snapshot.baseline.runtime]}`,
      baselineScriptSha256: hash(baseline), createdAt: new Date().toISOString(),
      ...(Object.hasOwn(snapshot, 'minNetGain') ? { minNetGain: snapshot.minNetGain } : {}),
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    if (manifestBytes.length > manifestLimit) throw new Error('proposal manifest exceeds 1 MiB');
    const files = {
      [manifest.scriptFile]: source,
      [manifest.baselineScriptFile]: baseline,
      'manifest.json': manifestBytes,
    };
    fs.mkdirSync(artifactPath, { mode: 0o700 });
    for (const [name, bytes] of Object.entries(files)) {
      fs.writeFileSync(path.join(artifactPath, name), bytes, { flag: 'wx', mode: 0o600 });
    }
    if (process.platform !== 'win32') {
      for (const name of Object.keys(files)) fs.chmodSync(path.join(artifactPath, name), 0o400);
      fs.chmodSync(artifactPath, 0o500);
    }
    // Freezing does not prove integrity. Read back every byte and compare a
    // digest derived from the exact data this call intended to write.
    return readToolProposal(id, { proposalsRoot: root, expectedArtifactSha256: packageHash(files) });
  } catch (error) {
    throw addContext(error, id, artifactPath);
  }
}
