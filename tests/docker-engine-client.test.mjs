import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerEngineClient, demultiplexDockerStream } from '../packages/capability-platform/docker-engine-client.mjs';

const runtimePath = fileURLToPath(new URL('../runtime/', import.meta.url));
const imageId = `sha256:${'a'.repeat(64)}`;

function frame(stream, payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

async function daemon(t, handler) {
  const directory = await mkdtemp(join(runtimePath, 'docker-client-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\${basename(directory)}` : join(directory, 'engine.sock');
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const record = {
      method: request.method, url: request.url,
      body: bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined,
    };
    requests.push(record);
    handler(record, response, request);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return { client: new DockerEngineClient(socketPath), requests, sockets };
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

test('constructor rejects missing or empty explicit socket paths', () => {
  for (const path of [undefined, null, '', '  ', 42]) {
    assert.throws(() => new DockerEngineClient(path), /socket/i);
  }
});

test('multiplexed streams preserve binary frame boundaries and split UTF-8 characters', () => {
  const bytes = Buffer.concat([
    frame(1, Buffer.from([0xe4])), frame(2, 'warning\n'),
    frame(1, Buffer.from([0xbd, 0xa0, 0x00])), frame(2, 'last'), frame(1, ''),
  ]);
  assert.deepEqual(demultiplexDockerStream(bytes), { stdout: '你\u0000', stderr: 'warning\nlast' });
  assert.deepEqual(demultiplexDockerStream(Buffer.alloc(0)), { stdout: '', stderr: '' });
});

for (const [name, bytes] of [
  ['unknown stream', frame(3, 'x')],
  ['stdin stream', frame(0, 'x')],
  ['reserved header byte', Buffer.from([1, 1, 0, 0, 0, 0, 0, 0])],
  ['second reserved header byte', Buffer.from([1, 0, 1, 0, 0, 0, 0, 0])],
  ['third reserved header byte', Buffer.from([1, 0, 0, 1, 0, 0, 0, 0])],
  ['short header', Buffer.from([1, 0, 0])],
  ['short payload', Buffer.from([1, 0, 0, 0, 0, 0, 0, 2, 120])],
  ['raw stdout fallback', Buffer.from('plain daemon output')],
]) {
  test(`multiplexer rejects ${name}`, () => {
    assert.throws(() => demultiplexDockerStream(bytes));
  });
}

test('multiplexer bounds combined stdout and stderr to one MiB', () => {
  assert.equal(demultiplexDockerStream(frame(1, Buffer.alloc(1024 * 1024))).stdout.length, 1024 * 1024);
  assert.throws(() => demultiplexDockerStream(Buffer.concat([
    frame(1, Buffer.alloc(600_000)), frame(2, Buffer.alloc(600_000)),
  ])), { code: 'DOCKER_OUTPUT_LIMIT' });
});

test('create sends isolation config unchanged to the explicit daemon and encodes the name', async (t) => {
  const { client, requests } = await daemon(t, (_, response) => json(response, { Id: 'created-id', Warnings: [] }, 201));
  const config = {
    Image: 'base@sha256:abc', Cmd: ['sleep', 'infinity'], User: '0:0',
    HostConfig: { NetworkMode: 'none', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      Memory: 268435456, PidsLimit: 64, ReadonlyRootfs: false, Binds: [] },
    Labels: { 'sirna.tool': 'teaching' },
  };
  assert.equal(await client.createContainer('tool name&other=x', config), 'created-id');
  assert.deepEqual(requests, [{
    method: 'POST', url: '/v1.43/containers/create?name=tool+name%26other%3Dx', body: config,
  }]);
});

test('lifecycle methods encode IDs and accept empty successful response bodies', async (t) => {
  const { client, requests } = await daemon(t, (_, response) => { response.writeHead(204); response.end(); });
  await client.startContainer('id/one');
  await client.stopContainer('id/one');
  await client.removeContainer('id/one');
  await client.removeContainer('id/one', false);
  assert.deepEqual(requests, [
    { method: 'POST', url: '/v1.43/containers/id%2Fone/start', body: undefined },
    { method: 'POST', url: '/v1.43/containers/id%2Fone/stop?t=2', body: undefined },
    { method: 'DELETE', url: '/v1.43/containers/id%2Fone?force=true', body: undefined },
    { method: 'DELETE', url: '/v1.43/containers/id%2Fone?force=false', body: undefined },
  ]);
});

test('inspect container and image return actual daemon objects', async (t) => {
  const { client, requests } = await daemon(t, (request, response) => {
    json(response, request.url.includes('/images/')
      ? { Id: imageId, Config: { User: '1000:1000' } }
      : { Id: 'container-id', Image: imageId, State: { Running: false } });
  });
  assert.deepEqual(await client.inspectContainer('container-id'), {
    Id: 'container-id', Image: imageId, State: { Running: false },
  });
  assert.deepEqual(await client.inspectImage('repo/tool:one'), { Id: imageId, Config: { User: '1000:1000' } });
  assert.equal(requests[0].url, '/v1.43/containers/container-id/json');
  assert.equal(requests[1].url, '/v1.43/images/repo%2Ftool%3Aone/json');
});

test('exec sends argv without a host shell and reads final exit status and chunked output', async (t) => {
  const { client, requests } = await daemon(t, (request, response) => {
    if (request.url.endsWith('/exec')) return json(response, { Id: 'exec/id' }, 201);
    if (request.url.endsWith('/start')) {
      const bytes = Buffer.concat([frame(1, 'hello\n'), frame(2, 'error\n'), frame(1, 'world')]);
      response.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
      response.write(bytes.subarray(0, 3));
      response.write(bytes.subarray(3, 11));
      return response.end(bytes.subarray(11));
    }
    json(response, { Id: 'exec/id', Running: false, ExitCode: 7 });
  });
  const command = ['sh', '-c', 'printf "%s" "$1"', '--', '$(no-host-shell); secret'];
  assert.deepEqual(await client.exec('container', command), { exitCode: 7, stdout: 'hello\nworld', stderr: 'error\n' });
  assert.deepEqual(requests, [
    { method: 'POST', url: '/v1.43/containers/container/exec', body: {
      AttachStdout: true, AttachStderr: true, Tty: false, Cmd: command, User: '0:0',
    } },
    { method: 'POST', url: '/v1.43/exec/exec%2Fid/start', body: { Detach: false, Tty: false } },
    { method: 'GET', url: '/v1.43/exec/exec%2Fid/json', body: undefined },
  ]);
});

test('exec honors an explicit user and empty multiplexed output', async (t) => {
  const { client, requests } = await daemon(t, (request, response) => {
    if (request.url.endsWith('/exec')) return json(response, { Id: 'exec' });
    if (request.url.endsWith('/start')) return response.end();
    json(response, { Running: false, ExitCode: 0 });
  });
  assert.deepEqual(await client.exec('container', ['true'], { user: '1000:1000' }), { exitCode: 0, stdout: '', stderr: '' });
  assert.equal(requests[0].body.User, '1000:1000');
});

for (const value of [
  { Running: true, ExitCode: 0 }, { Running: false, ExitCode: null },
  { Running: false, ExitCode: 0.5 }, { ExitCode: 0 },
]) {
  test(`exec rejects nonterminal or invalid final status ${JSON.stringify(value)}`, async (t) => {
    const { client } = await daemon(t, (request, response) => {
      if (request.url.endsWith('/exec')) return json(response, { Id: 'exec' });
      if (request.url.endsWith('/start')) return response.end();
      json(response, value);
    });
    await assert.rejects(client.exec('container', ['true']));
  });
}

test('commit sends Cmd/User/Labels as config and returns a verified image ID', async (t) => {
  const { client, requests } = await daemon(t, (_, response) => json(response, { Id: imageId }, 201));
  const config = { Cmd: ['node', '/tool/main.mjs'], User: '1000:1000', Labels: { 'tool.digest': 'abc' } };
  assert.equal(await client.commitContainer('container/id', 'repo/tool', 'v1', config), imageId);
  assert.deepEqual(requests, [{
    method: 'POST', url: '/v1.43/commit?container=container%2Fid&repo=repo%2Ftool&tag=v1&pause=1', body: config,
  }]);
});

test('stop gives the daemon two seconds of grace while retaining a longer HTTP deadline', async (t) => {
  const { client, requests } = await daemon(t, (_, response) => {
    const timer = setTimeout(() => { response.writeHead(204); response.end(); }, 2_200);
    response.once('close', () => clearTimeout(timer));
  });
  await client.stopContainer('container');
  assert.equal(requests[0].url, '/v1.43/containers/container/stop?t=2');
});

test('wait returns integer exitCode and logs split stdout/stderr', async (t) => {
  const { client, requests } = await daemon(t, (request, response) => {
    if (request.url.includes('/wait')) return json(response, { StatusCode: 23 });
    response.end(Buffer.concat([frame(2, 'notice'), frame(1, 'result\n')]));
  });
  assert.equal(await client.waitContainer('container', 200), 23);
  assert.deepEqual(await client.containerLogs('container'), { stdout: 'result\n', stderr: 'notice' });
  assert.equal(requests[0].url, '/v1.43/containers/container/wait?condition=not-running');
  assert.equal(requests[1].url, '/v1.43/containers/container/logs?stdout=true&stderr=true');
});

for (const [operation, responseValue] of [
  ['createContainer', {}], ['createContainer', { Id: '' }],
  ['inspectContainer', null], ['inspectContainer', []],
  ['inspectImage', 'image'], ['commitContainer', { Id: 'not-sha256' }],
  ['waitContainer', { StatusCode: '0' }], ['waitContainer', { StatusCode: 0.1 }],
]) {
  test(`${operation} rejects malformed result ${JSON.stringify(responseValue)}`, async (t) => {
    const { client, requests } = await daemon(t, (_, response) => json(response, responseValue));
    const args = operation === 'waitContainer' ? ['id', 200]
      : operation === 'commitContainer' ? ['id', 'repository', 'tag', {}]
        : operation === 'createContainer' ? ['name', {}] : ['id'];
    await assert.rejects(client[operation](...args), { statusCode: 200 });
    assert.equal(requests.length, 1);
  });
}

test('wait rejects daemon Error even when StatusCode looks successful', async (t) => {
  const { client } = await daemon(t, (_, response) => json(response, {
    StatusCode: 0, Error: { Message: 'failed to wait for the container' },
  }));
  await assert.rejects(client.waitContainer('id', 200), { statusCode: 200 });
});

test('exec rejects a missing daemon exec ID before issuing a start request', async (t) => {
  const { client, requests } = await daemon(t, (_, response) => json(response, { Id: null }));
  await assert.rejects(client.exec('id', ['true']), { statusCode: 200 });
  assert.equal(requests.length, 1);
});

test('HTTP errors expose statusCode without echoing secret request or daemon body and never retry create', async (t) => {
  const { client, requests } = await daemon(t, (_, response) => {
    response.writeHead(500);
    response.end('secret request from daemon');
  });
  await assert.rejects(client.createContainer('private-name', { Env: ['SECRET=do-not-echo'] }), (error) => {
    assert.equal(error.statusCode, 500);
    assert.doesNotMatch(error.message, /private-name|SECRET|do-not-echo|secret request/);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('invalid and empty JSON reject with HTTP status', async (t) => {
  const { client } = await daemon(t, (request, response) => response.end(request.url.includes('/images/') ? '' : '{bad json'));
  await assert.rejects(client.inspectContainer('id'), { statusCode: 200 });
  await assert.rejects(client.inspectImage('image'), { statusCode: 200 });
});

test('response body over two MiB rejects and closes the transport', async (t) => {
  let responseClosed;
  const closed = new Promise((resolve) => { responseClosed = resolve; });
  const { client } = await daemon(t, (_, response) => {
    response.once('close', responseClosed);
    response.writeHead(200);
    response.write(Buffer.alloc(2 * 1024 * 1024 + 1, 32));
  });
  await assert.rejects(client.inspectContainer('id'), { code: 'DOCKER_OUTPUT_LIMIT', statusCode: 200 });
  await closed;
});

test('logs enforce one MiB combined output even below the response limit', async (t) => {
  const { client } = await daemon(t, (_, response) => response.end(Buffer.concat([
    frame(1, Buffer.alloc(600_000)), frame(2, Buffer.alloc(600_000)),
  ])));
  await assert.rejects(client.containerLogs('id'), { code: 'DOCKER_OUTPUT_LIMIT', statusCode: 200 });
});

test('wait timeout closes a nonresponding daemon request', async (t) => {
  let responseClosed;
  const closed = new Promise((resolve) => { responseClosed = resolve; });
  const { client, requests } = await daemon(t, (_, response) => response.once('close', responseClosed));
  await assert.rejects(client.waitContainer('id', 40), { code: 'DOCKER_TIMEOUT' });
  await closed;
  assert.equal(requests.length, 1);
});

test('exec timeout is an elapsed deadline even when the daemon keeps writing', async (t) => {
  const { client, requests } = await daemon(t, (request, response) => {
    if (request.url.endsWith('/exec')) return json(response, { Id: 'exec' });
    response.writeHead(200);
    const timer = setInterval(() => response.write(frame(1, 'x')), 10);
    response.once('close', () => clearInterval(timer));
  });
  await assert.rejects(client.exec('id', ['sleep', 'infinity'], { timeoutMs: 70 }), { code: 'DOCKER_TIMEOUT' });
  assert.equal(requests.length, 2);
});

test('exec shares one timeout budget across create and start requests', async (t) => {
  const { client, requests } = await daemon(t, (request, response) => {
    const timer = setTimeout(() => {
      if (request.url.endsWith('/exec')) json(response, { Id: 'exec' });
      else if (request.url.endsWith('/start')) response.end();
      else json(response, { Running: false, ExitCode: 0 });
    }, 90);
    response.once('close', () => clearTimeout(timer));
  });
  await assert.rejects(client.exec('id', ['true'], { timeoutMs: 150 }), { code: 'DOCKER_TIMEOUT' });
  assert.equal(requests.length, 2);
});

test('timeout after HTTP headers includes the response status and closes it', async (t) => {
  let responseClosed;
  const closed = new Promise((resolve) => { responseClosed = resolve; });
  const { client } = await daemon(t, (_, response) => {
    response.once('close', responseClosed);
    response.writeHead(200);
    response.flushHeaders();
  });
  await assert.rejects(client.waitContainer('id', 40), { code: 'DOCKER_TIMEOUT', statusCode: 200 });
  await closed;
});

test('default request timeout bounds a daemon that never responds', { timeout: 15_000 }, async (t) => {
  const { client } = await daemon(t, () => {});
  const started = Date.now();
  await assert.rejects(client.inspectContainer('id'), { code: 'DOCKER_TIMEOUT' });
  assert.ok(Date.now() - started >= 9_500);
});

test('truncated HTTP bodies settle with an error instead of accepting partial output', async (t) => {
  const { client } = await daemon(t, (_, response) => {
    response.writeHead(200, { 'Content-Length': '100' });
    response.write('{"Id":"partial"}');
    response.flushHeaders();
    setImmediate(() => response.socket.destroy());
  });
  await assert.rejects(client.inspectContainer('id'), { statusCode: 200 });
});

test('connection stream failure rejects without automatic commit retry', async (t) => {
  const { client, requests } = await daemon(t, (_, response) => response.socket.destroy());
  await assert.rejects(client.commitContainer('id', 'repo', 'tag', {}));
  assert.equal(requests.length, 1);
});

test('corrupted HTTP multiplexing rejects rather than treating it as stdout', async (t) => {
  const { client } = await daemon(t, (_, response) => response.end('unframed output'));
  await assert.rejects(client.containerLogs('id'), { statusCode: 200 });
});
