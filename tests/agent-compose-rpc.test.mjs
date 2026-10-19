import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

const definition = loadSync(fileURLToPath(new URL('../proto/agentcompose/v2/agentcompose.proto', import.meta.url)), {
  enums: String, longs: String, defaults: false, oneofs: true,
});
const RunService = grpc.loadPackageDefinition(definition).agentcompose.v2.RunService;
const request = { projectId: 'project-test', agentName: 'designer', sandboxId: 'sandbox-test', prompt: 'Read the sample.' };
const run = { runId: 'run-test', sandboxId: 'sandbox-test', status: 'RUN_STATUS_RUNNING', warnings: ['test warning'] };
const callbacks = { onStarted() {}, onAgentEvent() {}, onTurnCompleted() {} };

async function fixture(t, handlers, options = {}) {
  const { AgentComposeRpcClient } = await import('../packages/agent-runtime/agent-compose-rpc.mjs');
  const server = new grpc.Server();
  const received = { starts: 0, stops: [], lists: [] };
  server.addService(RunService.service, {
    attachAgentRun(call) {
      received.starts++;
      handlers.attach(call, received);
    },
    stopRun(call, reply) {
      received.stops.push({ request: call.request, auth: call.metadata.get('authorization'), deadline: call.getDeadline() });
      if (handlers.stop) return handlers.stop(call, reply);
      reply(null, { run: { summary: { ...run, status: 'RUN_STATUS_CANCELED' }, output: 'Stopped.' }, stopRequested: true });
    },
    listRuns(call, reply) {
      received.lists.push({ request: call.request, auth: call.metadata.get('authorization'), deadline: call.getDeadline() });
      if (handlers.list) return handlers.list(call, reply);
      reply(null, { runs: [], total: 0 });
    },
  });
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(),
    (error, boundPort) => error ? reject(error) : resolve(boundPort)));
  const client = new AgentComposeRpcClient({ address: `127.0.0.1:${port}`, token: 'local-test-token', timeoutMs: 2000, ...options });
  t.after(() => { client.close(); server.forceShutdown(); });
  return { client, received };
}

test('RPC sends authenticated prompt frames and awaits callbacks before returning the final result', { timeout: 5000 }, async t => {
  const sequence = [];
  let first;
  let auth;
  let deadline;
  let sawEOF = false;
  const { client } = await fixture(t, { attach(call) {
    auth = call.metadata.get('authorization');
    deadline = call.getDeadline();
    call.on('data', frame => {
      if (frame.start) {
        first = frame;
        call.write({ started: { run, runId: run.runId, sandboxId: run.sandboxId } });
        call.write({ agentEvent: { name: 'tool_start', text: 'reading', payloadJson: '{"toolName":"read"}' } });
        call.write({ agentTurnCompleted: { runId: run.runId, resultJson: '{"finalText":"Read."}' } });
      } else if (frame.stdinEof) {
        sawEOF = true;
        sequence.push('eof');
      }
    });
    call.on('end', () => {
      sequence.push('half-close');
      call.write({ result: { run: { ...run, status: 'RUN_STATUS_SUCCEEDED' }, success: true, output: 'Read.', resultJson: '{"agentThreadId":"pi-thread"}' } });
      call.end();
    });
  } });
  const result = await client.run(request, {
    async onStarted(task) {
      assert.equal(task.runId, 'run-test');
      assert.equal(task.status, 'running');
      sequence.push('started-begin');
      await setImmediate();
      sequence.push('started-end');
    },
    async onAgentEvent(event) {
      assert.deepEqual(event, { name: 'tool_start', text: 'reading', payload: { toolName: 'read' } });
      sequence.push('event-begin');
      await setImmediate();
      sequence.push('event-end');
    },
    async onTurnCompleted(json) {
      assert.equal(json, '{"finalText":"Read."}');
      sequence.push('turn-begin');
      await setImmediate();
      sequence.push('turn-end');
    },
  });
  sequence.push('resolved');
  assert.deepEqual(auth, ['Bearer local-test-token']);
  assert.ok(Number.isFinite(Number(deadline)), 'each RPC has a deadline');
  assert.equal(first.start.request.projectId, 'project-test');
  assert.equal(first.start.request.sandboxId, 'sandbox-test');
  assert.equal(first.start.request.prompt, 'Read the sample.');
  assert.equal(first.start.request.source, 'RUN_SOURCE_MANUAL');
  assert.equal(first.start.request.cleanupPolicy, 'RUN_SANDBOX_CLEANUP_POLICY_KEEP_RUNNING');
  assert.ok(first.start.request.clientRequestId);
  assert.ok(first.clientFrameId);
  assert.equal(first.start.mode, 'ATTACH_RUN_MODE_PROMPT');
  assert.equal(first.start.attachStdin, true);
  assert.equal(first.start.disconnectPolicy, 'ATTACH_DISCONNECT_POLICY_DETACH');
  assert.equal(sawEOF, true);
  assert.deepEqual(sequence, ['started-begin', 'started-end', 'event-begin', 'event-end', 'turn-begin', 'turn-end', 'eof', 'half-close', 'resolved']);
  assert.deepEqual(result, { runId: 'run-test', sandboxId: 'sandbox-test', status: 'succeeded', output: 'Read.', resultJson: '{"agentThreadId":"pi-thread"}', error: undefined });
});

test('a failed final run remains failed even after an agent turn completed', { timeout: 5000 }, async t => {
  const { client } = await fixture(t, { attach(call) {
    call.on('data', frame => {
      if (frame.start) {
        call.write({ started: { run } });
        call.write({ agentTurnCompleted: { runId: run.runId, resultJson: '{"finalText":"Partial"}' } });
      }
    });
    call.on('end', () => {
      call.write({ result: { run: { ...run, status: 'RUN_STATUS_FAILED', error: 'Provider failed' }, output: 'Partial', error: 'Provider failed' } });
      call.end();
    });
  } });
  const result = await client.run(request, callbacks);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'Provider failed');
});

test('stream end without result rejects and stops an accepted detached run', { timeout: 5000 }, async t => {
  const { client, received } = await fixture(t, { attach(call) {
    call.on('data', frame => {
      if (!frame.start) return;
      call.write({ started: { run } });
      call.end();
    });
  } });
  await assert.rejects(client.run(request, callbacks), error => {
    assert.match(error.message, /without.*result/i);
    assert.equal(error.runId, 'run-test');
    return true;
  });
  assert.equal(received.stops.length, 1);
  assert.equal(received.starts, 1);
});

test('terminal protocol error rejects and never becomes a successful answer', { timeout: 5000 }, async t => {
  const { client, received } = await fixture(t, { attach(call) {
    call.on('data', frame => {
      if (!frame.start) return;
      call.write({ error: { terminal: true, code: 'runtime_error', message: 'Runtime failed' } });
      call.end();
    });
  } });
  await assert.rejects(client.run(request, callbacks), /Runtime failed/);
  assert.equal(received.starts, 1);
});

test('callback rejection promptly stops accepted work without waiting for stream completion', { timeout: 5000 }, async t => {
  const { client, received } = await fixture(t, { attach(call) {
    call.on('data', frame => {
      if (!frame.start) return;
      call.write({ started: { run } });
      call.write({ agentEvent: { name: 'tool_start', payloadJson: '{"toolName":"read"}' } });
    });
  } });
  let laterCallback = false;
  await assert.rejects(client.run(request, {
    ...callbacks,
    async onStarted() { await setImmediate(); throw new Error('Task persistence failed'); },
    onAgentEvent() { laterCallback = true; },
  }), /Task persistence failed/);
  assert.equal(laterCallback, false);
  assert.equal(received.stops.length, 1);
  assert.deepEqual(received.stops[0].auth, ['Bearer local-test-token']);
});

test('deadline stops known detached run with a separate authenticated unary deadline and never retries', { timeout: 5000 }, async t => {
  const { client, received } = await fixture(t, { attach(call) {
    call.on('data', frame => { if (frame.start) call.write({ started: { run } }); });
  } }, { timeoutMs: 150 });
  await assert.rejects(client.run(request, callbacks), error => {
    assert.equal(error.code, grpc.status.DEADLINE_EXCEEDED);
    assert.equal(error.runId, 'run-test');
    assert.equal(error.sandboxId, 'sandbox-test');
    assert.equal(error.stopError, undefined);
    return true;
  });
  assert.equal(received.starts, 1);
  assert.equal(received.stops.length, 1);
  assert.equal(received.stops[0].request.runId, 'run-test');
  assert.deepEqual(received.stops[0].auth, ['Bearer local-test-token']);
  assert.ok(Number.isFinite(Number(received.stops[0].deadline)));
});

test('failed timeout cleanup preserves run identity and reports that stop was not confirmed', { timeout: 5000 }, async t => {
  const { client, received } = await fixture(t, {
    attach(call) { call.on('data', frame => { if (frame.start) call.write({ started: { run } }); }); },
    stop(_call, reply) { reply({ code: grpc.status.UNAVAILABLE, details: 'Controller unavailable' }); },
  }, { timeoutMs: 150 });
  await assert.rejects(client.run(request, callbacks), error => {
    assert.equal(error.runId, 'run-test');
    assert.match(error.stopError, /Controller unavailable/);
    return true;
  });
  assert.equal(received.starts, 1);
  assert.equal(received.stops.length, 1);
});

test('authentication failure reaches the caller without automatic retry', { timeout: 5000 }, async t => {
  const { client, received } = await fixture(t, { attach(call) {
    call.on('data', () => call.emit('error', { code: grpc.status.UNAUTHENTICATED, details: 'Token rejected' }));
  } });
  await assert.rejects(client.run(request, callbacks), error => error.code === grpc.status.UNAUTHENTICATED);
  assert.equal(received.starts, 1);
  assert.equal(received.stops.length, 0);
});

test('stopRun returns normalized terminal state using bearer metadata', { timeout: 5000 }, async t => {
  const { client, received } = await fixture(t, { attach() {} });
  const result = await client.stopRun('run-test');
  assert.equal(result.runId, 'run-test');
  assert.equal(result.status, 'canceled');
  assert.equal(result.output, 'Stopped.');
  assert.deepEqual(received.stops[0].auth, ['Bearer local-test-token']);
});

for (const activeStatus of [undefined, 'RUN_STATUS_PENDING', 'RUN_STATUS_RUNNING']) {
  test(`active-run check queries both states for the exact sandbox (${activeStatus || 'idle'})`, { timeout: 5000 }, async t => {
    const { client, received } = await fixture(t, { attach() {}, list(call, reply) {
      reply(null, { runs: call.request.status === activeStatus ? [run] : [] });
    } });
    assert.equal(await client.hasActiveRuns('sandbox-test'), Boolean(activeStatus));
    assert.deepEqual(received.lists.map(item => item.request).sort((a, b) => a.status.localeCompare(b.status)), [
      { status: 'RUN_STATUS_PENDING', limit: 1, sandboxId: 'sandbox-test' },
      { status: 'RUN_STATUS_RUNNING', limit: 1, sandboxId: 'sandbox-test' },
    ]);
    for (const item of received.lists) {
      assert.deepEqual(item.auth, ['Bearer local-test-token']);
      assert.ok(Number.isFinite(Number(item.deadline)));
    }
  });
}

test('active-run query failure is an error, never a claim that a sandbox is idle', { timeout: 5000 }, async t => {
  const { client } = await fixture(t, { attach() {}, list(_call, reply) {
    reply({ code: grpc.status.UNAVAILABLE, details: 'Status unavailable' });
  } });
  await assert.rejects(client.hasActiveRuns('sandbox-test'), /Status unavailable/);
});

test('pending snapshot completes before running query to avoid the transition race', { timeout: 5000 }, async t => {
  let pendingFinished = false;
  const { client } = await fixture(t, { attach() {}, list(call, reply) {
    if (call.request.status === 'RUN_STATUS_PENDING') {
      setImmediate().then(() => { pendingFinished = true; reply(null, { runs: [] }); });
    } else {
      reply(null, { runs: pendingFinished ? [run] : [] });
    }
  } });
  assert.equal(await client.hasActiveRuns('sandbox-test'), true);
});
