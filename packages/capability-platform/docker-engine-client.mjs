import http from 'node:http';

const RESPONSE_LIMIT = 2 * 1024 * 1024;
const OUTPUT_LIMIT = 1024 * 1024;
const DEFAULT_TIMEOUT = 10_000;

function dockerError(message, properties = {}) {
  return Object.assign(new Error(message), properties);
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Docker ${field} must be a nonempty string`);
  return value;
}

function timeout(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError('Docker timeout must be a positive finite duration');
  }
  return value;
}

function encoded(value) {
  return encodeURIComponent(requiredString(value, 'identifier'));
}

function resultField(valid, statusCode) {
  if (!valid) throw dockerError('Invalid Docker response fields', { statusCode });
}

export function demultiplexDockerStream(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Docker stream must be a Buffer');
  const stdout = [];
  const stderr = [];
  let offset = 0;
  let outputBytes = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) throw new Error('Truncated Docker stream header');
    const stream = bytes[offset];
    if ((stream !== 1 && stream !== 2) || bytes[offset + 1] || bytes[offset + 2] || bytes[offset + 3]) {
      throw new Error('Invalid Docker stream header');
    }
    const length = bytes.readUInt32BE(offset + 4);
    offset += 8;
    if (length > bytes.length - offset) throw new Error('Truncated Docker stream payload');
    outputBytes += length;
    if (outputBytes > OUTPUT_LIMIT) throw dockerError('Docker output limit exceeded', { code: 'DOCKER_OUTPUT_LIMIT' });
    (stream === 1 ? stdout : stderr).push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
}

// An explicit project socket is mandatory: never consult DOCKER_HOST or a shared default daemon.
export class DockerEngineClient {
  #socketPath;

  constructor(socketPath) {
    this.#socketPath = requiredString(socketPath, 'socket path');
  }

  async createContainer(name, config) {
    const query = new URLSearchParams({ name: requiredString(name, 'container name') });
    const { value, statusCode } = await this.#json('POST', `/containers/create?${query}`, config);
    resultField(typeof value.Id === 'string' && value.Id.trim().length > 0, statusCode);
    return value.Id;
  }

  async startContainer(id) {
    await this.#request('POST', `/containers/${encoded(id)}/start`);
  }

  async stopContainer(id) {
    // Leave transport time after Docker's grace period to report the forced stop.
    await this.#request('POST', `/containers/${encoded(id)}/stop?t=2`);
  }

  async removeContainer(id, force = true) {
    if (typeof force !== 'boolean') throw new TypeError('Docker force must be boolean');
    await this.#request('DELETE', `/containers/${encoded(id)}?force=${force}`);
  }

  async inspectContainer(id) {
    return (await this.#json('GET', `/containers/${encoded(id)}/json`)).value;
  }

  async inspectImage(image) {
    return (await this.#json('GET', `/images/${encoded(image)}/json`)).value;
  }

  async exec(id, command, { timeoutMs = DEFAULT_TIMEOUT, user = '0:0' } = {}) {
    if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string')) {
      throw new TypeError('Docker command must be a nonempty string array');
    }
    requiredString(user, 'exec user');
    const deadline = performance.now() + timeout(timeoutMs);
    const remaining = () => {
      const duration = deadline - performance.now();
      if (duration <= 0) throw dockerError('Docker request timed out', { code: 'DOCKER_TIMEOUT' });
      return duration;
    };
    const created = await this.#json('POST', `/containers/${encoded(id)}/exec`, {
      AttachStdout: true, AttachStderr: true, Tty: false, Cmd: command, User: user,
    }, remaining());
    resultField(typeof created.value.Id === 'string' && created.value.Id.trim().length > 0, created.statusCode);
    const execId = encoded(created.value.Id);
    const output = await this.#stream('POST', `/exec/${execId}/start`, { Detach: false, Tty: false }, remaining());
    const inspected = await this.#json('GET', `/exec/${execId}/json`, undefined, remaining());
    resultField(inspected.value.Running === false && Number.isInteger(inspected.value.ExitCode), inspected.statusCode);
    return { exitCode: inspected.value.ExitCode, ...output };
  }

  async commitContainer(id, repository, tag, config) {
    const query = new URLSearchParams({
      container: requiredString(id, 'container ID'),
      repo: requiredString(repository, 'repository'), tag: requiredString(tag, 'tag'), pause: '1',
    });
    const { value, statusCode } = await this.#json('POST', `/commit?${query}`, config, 120_000);
    resultField(typeof value.Id === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.Id), statusCode);
    return value.Id;
  }

  async waitContainer(id, timeoutMs = DEFAULT_TIMEOUT) {
    const { value, statusCode } = await this.#json('POST', `/containers/${encoded(id)}/wait?condition=not-running`, undefined, timeoutMs);
    resultField(Number.isInteger(value.StatusCode) && value.Error == null, statusCode);
    return value.StatusCode;
  }

  async containerLogs(id) {
    return this.#stream('GET', `/containers/${encoded(id)}/logs?stdout=true&stderr=true`);
  }

  async #json(method, path, body, timeoutMs) {
    const { bytes, statusCode } = await this.#request(method, path, body, timeoutMs);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw dockerError('Invalid Docker JSON response', { statusCode }); }
    resultField(value !== null && typeof value === 'object' && !Array.isArray(value), statusCode);
    return { value, statusCode };
  }

  async #stream(method, path, body, timeoutMs) {
    const { bytes, statusCode } = await this.#request(method, path, body, timeoutMs);
    try { return demultiplexDockerStream(bytes); }
    catch (error) { throw Object.assign(error, { statusCode }); }
  }

  #request(method, path, body, timeoutMs = DEFAULT_TIMEOUT) {
    timeout(timeoutMs);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      let settled = false;
      let response;
      let timer;
      let request;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (response) error.statusCode = response.statusCode;
        response?.destroy();
        request?.destroy();
        reject(error);
      };
      try {
        request = http.request({
          socketPath: this.#socketPath, path: `/v1.43${path}`, method, agent: false,
          headers: payload === undefined ? {} : {
            'Content-Type': 'application/json', 'Content-Length': payload.length,
          },
        }, (incoming) => {
          response = incoming;
          const chunks = [];
          let received = 0;
          incoming.on('data', (chunk) => {
            received += chunk.length;
            if (received > RESPONSE_LIMIT) {
              fail(dockerError('Docker response limit exceeded', { code: 'DOCKER_OUTPUT_LIMIT' }));
            } else if (!settled) chunks.push(chunk);
          });
          incoming.on('aborted', () => fail(new Error('Docker response aborted')));
          incoming.on('error', () => fail(new Error('Docker response stream failed')));
          incoming.on('close', () => {
            if (!incoming.complete) fail(new Error('Docker response truncated'));
          });
          incoming.on('end', () => {
            if (settled) return;
            if (!incoming.complete) return fail(new Error('Docker response truncated'));
            if (incoming.statusCode < 200 || incoming.statusCode >= 300) {
              return fail(dockerError(`Docker HTTP error ${incoming.statusCode}`));
            }
            settled = true;
            clearTimeout(timer);
            resolve({ bytes: Buffer.concat(chunks), statusCode: incoming.statusCode });
          });
        });
        request.on('error', (error) => fail(dockerError('Docker transport failed', { code: error.code })));
        request.on('close', () => {
          if (!response) fail(new Error('Docker connection closed without a response'));
        });
        timer = setTimeout(() => fail(dockerError('Docker request timed out', { code: 'DOCKER_TIMEOUT' })), timeoutMs);
        request.end(payload);
      } catch (error) { fail(error); }
    });
  }
}
