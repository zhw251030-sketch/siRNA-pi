import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

// Official v2609.3.0 wire protocol; provenance and unchanged license are in proto/.
const protocol = loadSync(fileURLToPath(new URL('../../proto/agentcompose/v2/agentcompose.proto', import.meta.url)), {
  keepCase: false, enums: String, longs: String, defaults: false, oneofs: true,
});
const RunService = grpc.loadPackageDefinition(protocol).agentcompose.v2.RunService;
const terminalStatuses = new Set(['succeeded', 'failed', 'canceled']);

function summary(value = {}, fallback = {}) {
  const runId = value.runId || fallback.runId;
  if (!runId) throw new Error('Agent Compose response did not include a run id');
  return {
    runId,
    sandboxId: value.sandboxId || fallback.sandboxId,
    status: String(value.status || fallback.status || 'pending').replace(/^RUN_STATUS_/, '').toLowerCase(),
    warnings: value.warnings || fallback.warnings || [],
  };
}

function snapshot(value, run, fallback) {
  const task = summary(run, fallback);
  return {
    runId: task.runId,
    sandboxId: task.sandboxId,
    status: task.status,
    output: value.output || '',
    resultJson: value.resultJson || undefined,
    error: value.error || run?.error || undefined,
    ...((value.exitCode ?? run?.exitCode) !== undefined ? { exitCode: value.exitCode ?? run.exitCode } : {}),
    ...(value.cleanupError?.trim() ? { cleanupError: value.cleanupError } : {}),
  };
}

/** One authenticated, single-turn attachment per run; no retry or model credentials. */
export class AgentComposeRpcClient {
  #client;
  #token;
  #timeoutMs;

  constructor({ address = '127.0.0.1:7410', token, timeoutMs = 600000 }) {
    const endpoint = new URL(`http://${address}`);
    if (endpoint.host !== address || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      throw new Error('Agent Compose RPC address must be a host and port');
    }
    if (typeof token !== 'string' || !token || /\s/.test(token)) throw new Error('Agent Compose control token is required');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('Invalid Agent Compose RPC timeout');
    this.#token = token;
    this.#timeoutMs = timeoutMs;
    this.#client = new RunService(address, grpc.credentials.createInsecure(), { 'grpc.enable_retries': 0 });
  }

  #metadata() {
    const metadata = new grpc.Metadata();
    metadata.set('authorization', `Bearer ${this.#token}`);
    return metadata;
  }

  #error(value) {
    const error = new Error(String(value?.details || value?.message || value).replaceAll(this.#token, '[REDACTED]'));
    if (value?.code !== undefined) error.code = value.code;
    return error;
  }

  async run(request, { onStarted, onAgentEvent, onTurnCompleted, signal } = {}) {
    for (const name of ['projectId', 'agentName', 'sandboxId', 'prompt']) {
      if (typeof request?.[name] !== 'string' || !request[name].trim()) throw new Error(`Agent Compose ${name} is required`);
    }
    if (signal?.aborted) throw Object.assign(new Error('Agent Compose run was canceled before starting'), { name: 'AbortError', code: 'ABORT_ERR' });
    return new Promise((resolve, reject) => {
      const call = this.#client.attachAgentRun(this.#metadata(), { deadline: Date.now() + this.#timeoutMs });
      let current = { sandboxId: request.sandboxId, status: 'pending', warnings: [] };
      let result;
      let callbacks = Promise.resolve();
      let settled = false;
      let finishing = false;
      let failing = false;
      let callbackError;
      let inputClosed = false;
      let stopRequested = false;
      let stopOperation;
      let transportEnded = false;
      const verification = new AbortController();

      const cleanup = () => {
        settled = true;
        signal?.removeEventListener('abort', abort);
        verification.abort();
        call.cancel();
      };
      const identify = value => {
        const error = this.#error(value);
        error.runId = current.runId;
        error.sandboxId = current.sandboxId;
        if (value?.stopError) error.stopError = this.#error(value.stopError).message;
        return error;
      };
      const stop = () => {
        // The daemon ID arrives after preparation. A local request UUID cannot
        // identify DETACH work, so keep the stop intent until started arrives.
        if (!current.runId) return undefined;
        stopOperation ??= this.stopRunAndWait(current.runId, { signal: verification.signal });
        return stopOperation;
      };
      const finish = async value => {
        if (settled || finishing || failing) return;
        finishing = true;
        await callbacks;
        if (settled || failing) return;
        if (callbackError) return fail(callbackError);
        cleanup();
        resolve(value);
      };

      // DETACH survives connection loss. Explicitly stop known unfinished work on
      // deadline, transport/protocol failure, or a failed persistence callback.
      const fail = async (value, stopWork = true) => {
        if (settled || failing) return;
        failing = true;
        const error = identify(value);
        if (stopRequested && !current.runId) error.stopError = 'Cannot confirm stop without the daemon run id';
        call.cancel();
        if (stopWork && current.runId && !terminalStatuses.has(current.status)) {
          try {
            await stop();
          } catch (stopError) {
            error.stopError = this.#error(stopError.stopError || stopError).message;
          }
        }
        await callbacks;
        cleanup();
        reject(error);
      };
      const confirmStop = () => {
        const operation = stop();
        if (!operation) return;
        void operation.then(stopped => {
          // An abort racing normal completion never changes succeeded to
          // canceled. All already-received callbacks still finish in order.
          if (stopped.status !== 'succeeded' || result || transportEnded) void finish(result || stopped);
        }, error => {
          if (settled || failing) return;
          if (result) void finish(result);
          else void fail(error, false);
        });
      };
      const abort = () => {
        if (settled || finishing || failing) return;
        stopRequested = true;
        if (result) void finish(result);
        else confirmStop();
      };
      const enqueue = operation => {
        callbacks = callbacks.then(async () => { if (!settled && !callbackError && !failing) await operation(); }).catch(error => {
          callbackError = error;
          void fail(error);
        });
      };

      call.on('data', message => {
        if (settled || failing || finishing) return;
        try {
          if (message.started) {
            current = summary(message.started.run, { ...current, ...message.started, status: 'running' });
            const started = current;
            enqueue(() => onStarted?.(started));
            if (stopRequested) confirmStop();
          } else if (message.agentEvent) {
            const event = message.agentEvent;
            const payload = event.payloadJson ? JSON.parse(event.payloadJson) : undefined;
            enqueue(() => onAgentEvent?.({ name: event.name || 'agent_event', text: event.text || undefined, payload }));
          } else if (message.agentTurnCompleted) {
            enqueue(async () => {
              await onTurnCompleted?.(message.agentTurnCompleted.resultJson || '');
              if (settled || inputClosed) return;
              // DETACH does not translate a half-close into EOF. The wrapper
              // produces its final result only after this explicit stdin EOF.
              call.write({ clientFrameId: randomUUID(), stdinEof: {} });
              inputClosed = true;
              call.end();
            });
          } else if (message.result) {
            result = snapshot(message.result, message.result.run, current);
            current = result;
            if (!terminalStatuses.has(result.status)) throw new Error('Agent Compose final result has a nonterminal status');
          } else if (message.error?.terminal === true) {
            if (stopRequested && current.runId) { transportEnded = true; confirmStop(); }
            else void fail(new Error(message.error.message || message.error.code || 'Agent Compose attach failed'));
          }
          // output contains diagnostics; agentEvent carries the chat protocol.
          // A nonterminal AttachError has no terminal flag in proto3 wire data.
        } catch (error) {
          void fail(error);
        }
      });
      call.on('error', error => {
        if (settled || finishing || failing) return;
        transportEnded = true;
        if (stopRequested && current.runId) confirmStop();
        else void fail(error);
      });
      call.on('end', () => {
        transportEnded = true;
        void callbacks.then(() => {
          if (settled) return;
          if (!result) {
            if (stopRequested && current.runId) return confirmStop();
            return fail(new Error('Agent Compose attach stream ended without a final result'));
          }
          void finish(result);
        });
      });
      signal?.addEventListener('abort', abort, { once: true });
      call.write({
        clientFrameId: randomUUID(),
        start: {
          request: {
            projectId: request.projectId,
            agentName: request.agentName,
            sandboxId: request.sandboxId,
            prompt: request.prompt,
            source: 'RUN_SOURCE_MANUAL',
            cleanupPolicy: 'RUN_SANDBOX_CLEANUP_POLICY_KEEP_RUNNING',
            clientRequestId: request.clientRequestId || randomUUID(),
          },
          mode: 'ATTACH_RUN_MODE_PROMPT',
          attachStdin: true,
          tty: false,
          disconnectPolicy: 'ATTACH_DISCONNECT_POLICY_DETACH',
        },
      });
    });
  }

  async #runDetail(method, runId, { timeoutMs = 10000, signal } = {}) {
    if (typeof runId !== 'string' || !runId.trim()) throw new Error('Agent Compose runId is required');
    if (signal?.aborted) throw Object.assign(new Error('Agent Compose status request canceled'), { name: 'AbortError' });
    return new Promise((resolve, reject) => {
      const call = this.#client[method]({ runId, ...(method === 'stopRun' ? { reason: 'siRNA web request stopped' } : {}) }, this.#metadata(),
        { deadline: Date.now() + Math.min(timeoutMs, 10000) }, (error, response) => {
          signal?.removeEventListener('abort', abort);
          if (error) return reject(this.#error(error));
          try {
            const detail = response?.run;
            if (!detail?.summary) throw new Error('Agent Compose response did not include run details');
            if (detail.summary.runId !== runId) throw new Error('Agent Compose response run identity does not match the requested run id');
            resolve(snapshot(detail, detail.summary, { runId }));
          } catch (parseError) {
            reject(parseError);
          }
        });
      const abort = () => call.cancel();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  stopRun(runId, options) { return this.#runDetail('stopRun', runId, options); }
  getRun(runId, options) { return this.#runDetail('getRun', runId, options); }

  async stopRunAndWait(runId, { timeoutMs = 15000, signal } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('Invalid Agent Compose stop timeout');
    const deadline = Date.now() + timeoutMs;
    let current;
    try {
      current = await this.stopRun(runId, { timeoutMs: Math.min(timeoutMs, 10000), signal });
      while (!terminalStatuses.has(current.status)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Agent Compose stop timed out before a terminal run was confirmed');
        current = await this.getRun(runId, { timeoutMs: remaining, signal });
        if (!terminalStatuses.has(current.status)) {
          await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
        }
      }
      return current;
    } catch (value) {
      const error = this.#error(value);
      error.runId = runId;
      error.sandboxId = current?.sandboxId;
      error.stopError = error.message;
      throw error;
    }
  }

  async hasActiveRuns(sandboxId) {
    if (typeof sandboxId !== 'string' || !sandboxId.trim()) throw new Error('Agent Compose sandboxId is required');
    const results = [];
    // Ordered snapshots cannot miss an existing pending -> running transition.
    for (const status of ['RUN_STATUS_PENDING', 'RUN_STATUS_RUNNING']) results.push(await new Promise((resolve, reject) => {
      this.#client.listRuns({ sandboxId, status, limit: 1 }, this.#metadata(),
        { deadline: Date.now() + Math.min(this.#timeoutMs, 10000) }, (error, response) => {
          if (error) return reject(this.#error(error));
          resolve(Boolean(response?.runs?.length || response?.total));
        });
    }));
    return results.some(Boolean);
  }

  // The owner drains accepted tasks before shutting down its transport.
  close() { this.#client.close(); }
}
