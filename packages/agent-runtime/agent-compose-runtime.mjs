import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ComposeSessionStore, sandboxIdPattern } from './compose-session-store.mjs';
import { createComposeEventProjector } from './compose-events.mjs';

const safeFailure = '本轮容器执行未完成，已保留记录；请检查运行状态后再试。';
const now = () => new Date().toISOString();

export class AgentComposeRuntime {
  constructor({ root, executor, rpc }) {
    this.root = path.resolve(root);
    this.store = new ComposeSessionStore(this.root);
    this.executor = executor;
    this.rpc = rpc;
    this.active = new Set();
    this.preparing = new Map();
  }
  runtimeInfo() {
    return { backend: 'agent-compose', structuredToolEvents: true, reasoningExposed: false, taskContainers: true };
  }
  owns(id) { return this.store.has(id); }
  async status(id) { return this.store.load(id); }
  async create() {
    const session = { id: randomUUID(), backend: 'agent-compose', status: 'idle', runs: [] };
    this.store.save(session);
    return session;
  }
  async describe(id) {
    const session = await this.status(id);
    return { backend: session.backend, sandboxId: session.sandboxId,
      workspacePath: session.workspacePath ?? null, eventLogPath: session.eventLogPath ?? null };
  }
  async ensureWorkspace(id) {
    if (this.preparing.has(id)) return this.preparing.get(id);
    const operation = this.prepare(id);
    this.preparing.set(id, operation);
    try { return await operation; } finally { this.preparing.delete(id); }
  }
  async prepare(id) {
    const session = await this.status(id);
    if (!session.projectId) {
      const project = await this.executor.up();
      if (typeof project.project?.id !== 'string') throw new Error('Missing project ID');
      session.projectId = project.project.id;
      this.store.save(session);
    }
    if (!session.workspaceReady) {
      const remember = run => {
        session.bootstrapRunId = run.id;
        if (run.sandbox_id) {
          if (!sandboxIdPattern.test(run.sandbox_id)) throw new Error('Invalid sandbox ID');
          if (session.sandboxId && session.sandboxId !== run.sandbox_id) throw new Error('Sandbox identity changed');
          session.sandboxId = run.sandbox_id;
        }
        this.store.save(session);
      };
      if (session.bootstrapRunId) await this.executor.wait(session.bootstrapRunId, remember);
      else await this.executor.bootstrap(remember);
    }
    const sandbox = await this.executor.inspectSandbox(session.sandboxId);
    if (sandbox.sandbox_id !== session.sandboxId) throw new Error('Sandbox identity mismatch');
    const workspacePath = this.store.workspace(sandbox);
    if (session.workspacePath && session.workspacePath !== workspacePath) throw new Error('Workspace changed unexpectedly');
    session.workspacePath = workspacePath;
    if (!session.workspaceReady) {
      const sample = path.join(this.root, workspacePath, 'input/numbers.csv');
      const contents = 'value\n10\n20\n30\n40\n';
      try { fs.writeFileSync(sample, contents, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST' || fs.realpathSync(sample) !== sample || !fs.statSync(sample).isFile() ||
            fs.readFileSync(sample, 'utf8') !== contents) throw new Error('Workspace sample initialization conflicts with existing data');
      }
      session.workspaceReady = true;
    }
    this.store.save(session);
    return session;
  }
  async run(request, emit) {
    const id = request.sessionId;
    if (this.active.has(id)) throw new Error('Execution session is already running');
    this.active.add(id);
    let session;
    let run;
    let log;
    const send = event => {
      if (run && log === undefined) {
        if (!/^[A-Za-z0-9_-]+$/.test(run.runId)) throw new Error('Invalid run ID');
        session.eventLogPath = `runtime/compose-web/${id}.${run.runId}.events.jsonl`;
        log = fs.openSync(path.join(this.root, session.eventLogPath), 'wx', 0o600);
        run.eventLogPath = session.eventLogPath;
        this.store.save(session);
      }
      const projected = { ...event, sessionId: id, backend: 'agent-compose', runId: run?.runId };
      if (log !== undefined) fs.writeSync(log, JSON.stringify(projected) + '\n');
      emit(projected);
    };
    try {
      session = await this.ensureWorkspace(id);
      if (await this.rpc.hasActiveRuns(session.sandboxId)) throw new Error('A detached Agent Compose run is still active');
      this.store.recoverConversation(session);
      this.store.assertConversation(session);
      for (const previous of session.runs) {
        if (previous.status === 'running') Object.assign(previous, { status: 'failed', completedAt: now(), outcomeUnconfirmed: true });
      }
      run = { runId: randomUUID(), status: 'running', startedAt: now(), outputCharacters: 0 };
      session.runs.push(run);
      session.status = 'running';
      session.currentRunId = run.runId;
      this.store.save(session);
      const projector = createComposeEventProjector(send);
      const snapshot = await this.rpc.run({ projectId: session.projectId, agentName: 'designer', sandboxId: session.sandboxId,
        prompt: '当前任务工作目录是 /workspace。样例在 input/numbers.csv，结果请写入 output/。本阶段仅使用 read/write，保留其他文件。\n\n用户消息：\n' + request.message }, {
        onStarted: task => {
          if (task.sandboxId !== session.sandboxId || !/^[A-Za-z0-9_-]+$/.test(task.runId)) throw new Error('Unexpected RPC run identity');
          run.runId = task.runId;
          run.accepted = true;
          session.currentRunId = task.runId;
          send({ type: 'session', mode: 'model', sandboxId: session.sandboxId, piSessionId: session.piSessionId,
            workspacePath: session.workspacePath, eventLogPath: `runtime/compose-web/${id}.${task.runId}.events.jsonl` });
          send({ type: 'run_status', status: 'running' });
        },
        onAgentEvent: event => projector.onAgentEvent(event),
        onTurnCompleted: raw => projector.onTurnCompleted(raw),
      });
      if (snapshot.runId !== run.runId || snapshot.sandboxId !== session.sandboxId || !run.accepted) throw new Error('Unexpected final run identity');
      const result = projector.finish(snapshot);
      if (session.piSessionId && session.piSessionId !== result.piSessionId) throw new Error('Pi conversation unexpectedly replaced');
      session.piSessionId = result.piSessionId;
      this.store.assertConversation(session);
      Object.assign(run, { status: 'succeeded', completedAt: now(), outputCharacters: result.answer.length,
        piSessionId: result.piSessionId, modelResponses: result.modelResponses, toolCalls: result.toolCalls });
      session.status = 'idle';
      this.store.save(session);
      send({ type: 'assistant_message', text: result.answer });
      send({ type: 'run_status', status: 'succeeded', piSessionId: session.piSessionId });
      send({ type: 'done', status: 'succeeded', piSessionId: session.piSessionId });
    } catch (error) {
      session ??= await this.status(id);
      if (!run) {
        run = { runId: randomUUID(), startedAt: now(), outputCharacters: 0 };
        session.runs.push(run);
      }
      Object.assign(run, { status: 'failed', completedAt: now(),
        ...(run.accepted ? { outcomeUnconfirmed: true } : {}),
        ...(error.stopError ? { stopUnconfirmed: true } : {}) });
      session.status = 'failed';
      session.currentRunId = run.runId;
      this.store.save(session);
      send({ type: 'error', error: safeFailure });
      send({ type: 'done', status: 'failed', piSessionId: session.piSessionId });
    } finally {
      if (log !== undefined) fs.closeSync(log);
      this.active.delete(id);
    }
  }
}
