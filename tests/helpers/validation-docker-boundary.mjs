import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const BASE = 'sha256:e34a8f3fe6b2b74a3fa7f1a6143a126ae1e5414fa8a334c7bba82fe57d28971b';
const COMMAND = ['/usr/bin/node', '/opt/tool/main.mjs'];
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);

// Only Docker transport is substituted. The real runner validates contracts,
// image/source binding, container policy, result parsing and owned cleanup.
// Source is always data here: neither candidate nor baseline executes on host.
export class DockerBoundary {
  calls = []; containers = new Map([['old-unrelated', { Config: { Labels: {} } }]]); next = 0;
  sourceMismatch = false; badLabels = false; unsafe = null; removeFailure = false; pretendRemoved = false;
  result = { exitCode: 0, timedOut: false, outputLimitExceeded: false, stdout: '{"ok":true}\n', stderr: '' };
  filesDigest = hash('f:answer.txt\0hello');
  constructor(data, { runResult } = {}) { this.data = data; this.runResult = runResult; }
  async inspectImage(id) {
    this.calls.push(['inspectImage', id]);
    if (id === BASE) return { Id: BASE, Os: 'linux', Architecture: 'amd64', Config: { Volumes: null, Env: ['PATH=/usr/bin:/bin'] } };
    const artifact = this.data.manifest.runtimeArtifact;
    return { Id: artifact.imageDigest, Os: 'linux', Architecture: 'amd64', Config: { User: '65534:65534', WorkingDir: '/tmp', Entrypoint: [], Cmd: COMMAND,
      Volumes: null, Env: ['PATH=/usr/bin:/bin', 'SECRET=not-for-events'], Labels: { 'sirna.learning.project': 'siRNA-pi', 'sirna.tool.runtime': 'true',
        'sirna.tool.build-session': artifact.buildSessionId, 'sirna.tool.base-image': BASE, 'sirna.tool.created-at': artifact.createdAt,
        'sirna.tool.source-sha256': this.badLabels ? '0'.repeat(64) : this.data.manifest.scriptSha256 } } };
  }
  async createContainer(name, config) {
    const id = `validation-${++this.next}`; this.calls.push(['createContainer', name, clone(config)]);
    this.containers.set(id, { Id: id, Image: config.Image, Config: clone(config), HostConfig: clone(config.HostConfig), Mounts: [] }); return id;
  }
  async inspectContainer(id) {
    this.calls.push(['inspectContainer', id]);
    if (!this.containers.has(id)) throw Object.assign(new Error('absent'), { statusCode: 404 });
    const inspect = clone(this.containers.get(id)); if (this.unsafe) this.unsafe(inspect); return inspect;
  }
  async startContainer(id) { this.calls.push(['startContainer', id]); }
  async removeContainer(id, force) {
    this.calls.push(['removeContainer', id, force]); if (this.removeFailure) throw new Error('delete unavailable');
    if (!this.pretendRemoved) this.containers.delete(id);
  }
  async exec(id, command, options) {
    this.calls.push(['exec', id, clone(command), clone(options)]);
    if (command[1] === '-e') {
      const payload = JSON.parse(Buffer.from(command.slice(3).join(''), 'base64').toString());
      assert.match(payload.helper, /digestWorkspace/);
      assert.equal(payload.baseline, this.data.input.baseline.script);
      assert.equal(Object.hasOwn(payload, 'candidate'), false);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command[2] === 'source-hash') return { exitCode: 0, stdout: this.sourceMismatch ? '0'.repeat(64) :
      command[3] === '/tmp/sirna-validator/baseline.mjs' ? this.data.manifest.baselineScriptSha256 : this.data.manifest.scriptSha256, stderr: '' };
    if (command[1] === '--check') return { exitCode: 0, stdout: '', stderr: '' };
    if (command[2] === 'run') {
      assert.equal(options.user, '65534:65534');
      assert.ok(['/opt/tool/main.mjs', '/tmp/sirna-validator/baseline.mjs'].includes(command[3]));
      const envelope = JSON.parse(Buffer.from(command[4], 'base64').toString());
      assert.equal(envelope.protocolVersion, 'sirna-approved-tool-call/v1');
      if (!this.runResult) assert.deepEqual(envelope.input, { sequence: 'AC' });
      const result = this.runResult ? await this.runResult({ envelope, target: command[3] === '/opt/tool/main.mjs' ? 'candidate' : 'baseline' }) : this.result;
      return { exitCode: 0, stdout: JSON.stringify(result), stderr: '' };
    }
    if (command[2] === 'quiesce') return { exitCode: 0, stdout: '', stderr: '' };
    if (command[2] === 'digest') return { exitCode: 0, stdout: this.filesDigest, stderr: '' };
    throw new Error('Unexpected Docker exec');
  }
}
