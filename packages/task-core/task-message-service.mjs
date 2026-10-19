import { randomUUID } from "node:crypto";

// Follows the reference service's task-scoped turn and event contracts, without
// its container synchronization, revisions, or capability-coordinator features.
const persistedEventTypes = new Set(["progress_message", "tool_start", "tool_end", "run_status", "done", "error"]);
const safeFailure = "本轮执行失败，请稍后重试；服务端已保留任务记录。";

export class TaskMessageSubmissionError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "TaskMessageSubmissionError";
    this.statusCode = statusCode;
  }
}

function validateRequestId(value) {
  if (value !== undefined && (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(value))) {
    throw new TaskMessageSubmissionError(400, "requestId must contain 16 to 128 URL-safe characters");
  }
}

function safeSend(emit, event) {
  try { emit(event); } catch { /* Browser disconnection does not cancel execution. */ }
}

export class TaskMessageService {
  #active = new Map();
  #creating = new Map();
  #canceling = new Map();
  #ending = new Map();

  constructor({ taskStore, agentRuntime }) {
    this.taskStore = taskStore;
    this.agentRuntime = agentRuntime;
  }

  async createTask(requestId) {
    validateRequestId(requestId);
    const previous = requestId ? this.taskStore.getTaskByCreationRequestId(requestId) : undefined;
    if (previous) return { task: previous, deduplicated: true };
    if (!this.agentRuntime) throw new TaskMessageSubmissionError(503, "Agent runtime is unavailable");
    if (requestId && this.#creating.has(requestId)) {
      try { return { task: await this.#creating.get(requestId), deduplicated: true }; }
      catch { throw new TaskMessageSubmissionError(500, "Unable to create the execution session"); }
    }
    // Install the shared promise before starting asynchronous session creation.
    const pending = Promise.resolve().then(async () => {
      const session = await this.agentRuntime.create();
      if (!session?.id) throw new Error("Runtime session is missing");
      return this.taskStore.createTask(session, requestId);
    });
    if (requestId) this.#creating.set(requestId, pending);
    try {
      return { task: await pending, deduplicated: false };
    } catch {
      throw new TaskMessageSubmissionError(500, "Unable to create the execution session");
    } finally {
      if (requestId) this.#creating.delete(requestId);
    }
  }

  async start({ taskId, message, requestId }, emit) {
    if (typeof message !== "string" || !message.trim() || message.trim().length > 120000) {
      throw new TaskMessageSubmissionError(400, "message must contain 1 to 120000 characters");
    }
    validateRequestId(requestId);
    message = message.trim();
    const existing = this.taskStore.getTask(taskId);
    if (!existing) throw new TaskMessageSubmissionError(404, "Unknown design task");
    const prior = requestId ? this.taskStore.getMessageByClientRequestId(taskId, requestId) : undefined;
    if (prior) {
      if (prior.role !== "user" || prior.content !== message) {
        throw new TaskMessageSubmissionError(409, "requestId was already used for different message content");
      }
      safeSend(emit, { type: "request_deduplicated", taskId, requestId });
      safeSend(emit, { type: "task_saved", task: existing });
      const result = { task: existing, userMessage: prior, deduplicated: true };
      return { ...result, completion: Promise.resolve(result) };
    }
    if (!this.agentRuntime) throw new TaskMessageSubmissionError(503, "Agent runtime is unavailable");
    if (this.#active.has(taskId) || this.#ending.has(taskId) || this.#canceling.has(taskId) || existing.status === "running" || existing.status === "stopped") {
      throw new TaskMessageSubmissionError(409, "This design task cannot accept a new message now");
    }
    // No await before this reservation and database insert: simultaneous HTTP
    // submissions cannot both start a turn on the same task.
    const active = { controller: new AbortController(), completion: null };
    this.#active.set(taskId, active);
    let turn;
    try { turn = this.taskStore.beginTurn(taskId, message, requestId); }
    catch {
      this.#active.delete(taskId);
      throw new TaskMessageSubmissionError(503, "Unable to save this message");
    }
    const send = (event) => safeSend(emit, event);
    send({ type: "task", task: turn.task, message: turn.message });
    // Install the controller and completion before dispatch: queued preparation
    // and active RPC both receive the same cancellation signal.
    const completion = Promise.resolve().then(() => this.#execute(turn, message, send, active.controller.signal));
    active.completion = completion;
    return { task: turn.task, userMessage: turn.message, deduplicated: false, completion };
  }

  async #checkLifecycle(task) {
    try {
      const description = await this.agentRuntime?.describe?.(task.executionSessionId);
      if (description?.backend !== "agent-compose" || description.supportsLifecycle === false ||
          typeof this.agentRuntime?.cancel !== "function" || typeof this.agentRuntime?.remove !== "function") {
        throw new TaskMessageSubmissionError(409, "此任务的执行环境不支持停止或结束操作。");
      }
    } catch (error) {
      if (error instanceof TaskMessageSubmissionError) throw error;
      throw new TaskMessageSubmissionError(503, "暂时无法确认执行环境，请刷新记录后重试。");
    }
  }

  #lifecycleOperation(map, taskId, operation) {
    const pending = Promise.resolve().then(operation).catch((error) => {
      if (error instanceof TaskMessageSubmissionError) throw error;
      throw new TaskMessageSubmissionError(503, "操作尚未确认，任务记录已保留，请刷新记录后重试。");
    });
    map.set(taskId, pending);
    // Avoid an unhandled rejection from a discarded finally() promise.
    pending.then(() => map.delete(taskId), () => map.delete(taskId));
    return pending;
  }

  async cancelTask(taskId) {
    const existing = this.taskStore.getTask(taskId);
    if (!existing) throw new TaskMessageSubmissionError(404, "没有找到这个任务。");
    if (this.#ending.has(taskId)) throw new TaskMessageSubmissionError(409, "任务正在结束，请等待记录保存。");
    if (this.#canceling.has(taskId)) return this.#canceling.get(taskId);
    return this.#lifecycleOperation(this.#canceling, taskId, async () => {
      await this.#checkLifecycle(existing);
      if (existing.status === "stopped") return { task: this.taskStore.getTask(taskId), stopRequested: false };
      const active = this.#active.get(taskId);
      active?.controller.abort();
      const session = await this.agentRuntime.cancel(existing.executionSessionId);
      if (active) {
        // The run owns its final status until its assistant message is saved.
        return { task: this.taskStore.getTask(taskId), stopRequested: true };
      }
      if (!["idle", "failed", "stopped"].includes(session?.status)) throw new Error("Stop was not confirmed");
      const task = this.taskStore.updateExecution(taskId, { status: session.status });
      return { task, stopRequested: false };
    });
  }

  async endTask(taskId) {
    const existing = this.taskStore.getTask(taskId);
    if (!existing) throw new TaskMessageSubmissionError(404, "没有找到这个任务。");
    if (this.#ending.has(taskId)) return this.#ending.get(taskId);
    // Reserve synchronously, before metadata inspection or a preceding stop.
    return this.#lifecycleOperation(this.#ending, taskId, async () => {
      await this.#checkLifecycle(existing);
      if (existing.status === "stopped") return { task: this.taskStore.getTask(taskId) };
      const stopping = this.#canceling.get(taskId);
      if (stopping) await stopping;
      const active = this.#active.get(taskId);
      if (active) {
        active.controller.abort();
        await this.agentRuntime.cancel(existing.executionSessionId);
        const saved = await active.completion;
        if (!saved.assistantMessage) throw new Error("The accepted turn was not durably saved");
      }
      const session = await this.agentRuntime.remove(existing.executionSessionId);
      if (session?.status !== "stopped") throw new Error("Release was not confirmed");
      return { task: this.taskStore.updateExecution(taskId, { status: "stopped" }) };
    });
  }

  async #execute(turn, message, send, signal) {
    const taskId = turn.task.id;
    let assistantText = "";
    let runId;
    let finalStatus;
    let failed = false;
    const pendingEvents = [];
    const flushPending = () => {
      for (const pending of pendingEvents.splice(0)) {
        this.taskStore.appendRunEvent(taskId, turn.message.id, runId, pending.type, pending);
      }
    };
    const persist = (event) => {
      if (!persistedEventTypes.has(event.type)) return;
      if (!runId) { pendingEvents.push(event); return; }
      flushPending();
      this.taskStore.appendRunEvent(taskId, turn.message.id, runId, event.type, event);
    };
    const accept = (original) => {
      const event = original.type === "error" ? { ...original, error: safeFailure } : original;
      if (event.runId) runId = event.runId;
      if (event.type === "text_delta") assistantText += event.delta ?? "";
      if (event.type === "assistant_message") assistantText = event.text ?? assistantText;
      if (event.type === "error") failed = true;
      if (event.type === "done") {
        finalStatus = (event.status ?? "succeeded").toLowerCase();
        failed ||= !["succeeded", "canceled", "cancelled"].includes(finalStatus);
      }
      if (["session", "run_status", "done"].includes(event.type)) {
        // Keep the task running until the answer has been durably saved.
        this.taskStore.updateExecution(taskId, { currentRunId: runId, piSessionId: event.piSessionId });
      }
      persist(event);
      send({ ...event, taskId });
    };
    try {
      try {
        await this.agentRuntime.run({ sessionId: turn.task.executionSessionId, message }, accept, signal);
        if (!finalStatus) throw new Error("Runtime did not finish");
        if (!runId) {
          runId = randomUUID();
          this.taskStore.updateExecution(taskId, { currentRunId: runId });
        }
        flushPending();
      } catch {
        failed = true;
        runId ??= randomUUID();
        this.taskStore.updateExecution(taskId, { currentRunId: runId });
        accept({ type: "error", error: safeFailure, runId });
        if (finalStatus !== "failed") accept({ type: "done", status: "failed", runId });
      }
      const wasCanceled = finalStatus === "canceled" || finalStatus === "cancelled";
      const content = assistantText.trim() || (failed ? `错误：${safeFailure}`
        : wasCanceled ? "运行已中断。可以继续修改要求或重新运行。" : "本轮已完成。");
      const assistantMessage = this.taskStore.appendAssistantMessage(taskId, content, failed ? "failed" : "complete");
      send({ type: "message_saved", taskId, message: assistantMessage });
      const task = this.taskStore.getTask(taskId);
      send({ type: "task_saved", task });
      return { task, userMessage: turn.message, assistantMessage, finalRunId: runId, deduplicated: false };
    } catch {
      // Storage can fail after the HTTP response started. Never reject a
      // detached background promise or claim an answer was saved in that case.
      let task = { ...turn.task, status: "failed" };
      try { task = this.taskStore.updateExecution(taskId, { status: "failed" }); } catch { /* Recovery handles a still-running row at startup. */ }
      send({ type: "error", taskId, error: "任务执行或保存失败，请重新打开任务检查记录后再试。", runId });
      send({ type: "done", taskId, status: "failed", runId });
      return { task, userMessage: turn.message, finalRunId: runId, deduplicated: false };
    } finally {
      this.#active.delete(taskId);
    }
  }
}
