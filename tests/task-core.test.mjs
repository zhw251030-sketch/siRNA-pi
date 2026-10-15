import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../packages/task-core/task-store.mjs";
import { TaskMessageService, TaskMessageSubmissionError } from "../packages/task-core/task-message-service.mjs";

const fixtureRoot = fileURLToPath(new URL("../runtime/task-core-tests/", import.meta.url));

function fixture(t, run) {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fixtureRoot, "case-"));
  const dbPath = path.join(dir, "tasks.sqlite");
  let taskStore = new TaskStore(dbPath);
  const calls = [];
  const agentRuntime = {
    async create() { return { id: randomUUID(), status: "idle", runs: [] }; },
    async run(input, emit) {
      calls.push(input);
      const runId = randomUUID();
      emit({ type: "session", sessionId: input.sessionId, piSessionId: "pi-test-session", backend: "local-pi", mode: "model", runId });
      if (run) await run(input, emit, runId);
      else {
        emit({ type: "assistant_message", text: "结果为 25。" });
        emit({ type: "done", status: "succeeded", runId });
      }
    },
  };
  const service = new TaskMessageService({ taskStore, agentRuntime });
  t.after(() => {
    taskStore.close();
    assert.equal(path.dirname(dir), path.resolve(fixtureRoot));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    taskStore, service, agentRuntime, calls,
    reopen() {
      taskStore.close();
      taskStore = new TaskStore(dbPath);
      return taskStore;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("task history and execution events survive closing and reopening SQLite", async (t) => {
  const f = fixture(t, async (_input, emit, runId) => {
    emit({ type: "run_status", status: "running", runId });
    emit({ type: "progress_message", text: "正在读取数据。" });
    emit({ type: "text_delta", delta: "临时的部分答案" });
    emit({ type: "tool_start", toolCallId: "tool-1", toolName: "read", args: { path: "numbers.csv" } });
    emit({ type: "tool_end", toolCallId: "tool-1", toolName: "read", isError: false, result: "10,20,30,40" });
    emit({ type: "assistant_message", text: "结果为 25。" });
    emit({ type: "done", status: "succeeded", runId });
  });
  const { task } = await f.service.createTask("create-persist-001");
  assert.equal(f.calls.length, 0, "creating a task must not run a model");
  assert.notEqual(task.id, task.executionSessionId);
  const sent = [];
  const handle = await f.service.start({ taskId: task.id, message: "  计算平均值  ", requestId: "message-persist-01" }, (event) => sent.push(event));
  assert.equal(handle.userMessage.content, "计算平均值");
  await handle.completion;
  assert.deepEqual(sent.slice(-3).map((event) => event.type), ["done", "message_saved", "task_saved"]);
  const reopened = f.reopen();
  assert.equal(reopened.getTask(task.id).status, "idle");
  assert.equal(reopened.getTask(task.id).messageCount, 2);
  assert.equal(reopened.getTask(task.id).piSessionId, "pi-test-session");
  assert.equal(reopened.getTaskByCreationRequestId("create-persist-001").id, task.id);
  assert.deepEqual(reopened.listMessages(task.id).map(({ role, content, sequence }) => ({ role, content, sequence })), [
    { role: "user", content: "计算平均值", sequence: 1 },
    { role: "assistant", content: "结果为 25。", sequence: 2 },
  ]);
  assert.deepEqual(reopened.listRunEvents(task.id).map((event) => event.type), ["run_status", "progress_message", "tool_start", "tool_end", "done"]);
  assert.ok(reopened.listRunEvents(task.id).every((event) => event.userMessageId === handle.userMessage.id && event.runId && event.taskId === task.id));
  assert.equal(reopened.listTasks()[0].id, task.id);
});

test("concurrent creation retries share one execution session and one stored task", async (t) => {
  const f = fixture(t);
  const gate = deferred();
  let creates = 0;
  f.agentRuntime.create = async () => {
    creates += 1;
    await gate.promise;
    return { id: `execution-${creates}`, status: "idle", runs: [] };
  };
  const first = f.service.createTask("create-concurrent-01");
  const duplicate = f.service.createTask("create-concurrent-01");
  gate.resolve();
  const results = await Promise.all([first, duplicate]);
  assert.equal(creates, 1, "retry must not allocate a second paid runtime session");
  assert.equal(results[0].task.id, results[1].task.id);
  assert.deepEqual(results.map((result) => result.deduplicated), [false, true]);
  assert.equal(f.taskStore.listTasks().length, 1);
  assert.equal((await f.service.createTask("create-concurrent-01")).deduplicated, true);
});

test("same request is deduplicated while running; a different request conflicts", async (t) => {
  const gate = deferred();
  const f = fixture(t, async (_input, emit, runId) => {
    await gate.promise;
    emit({ type: "assistant_message", text: "已完成。" });
    emit({ type: "done", status: "succeeded", runId });
  });
  const { task } = await f.service.createTask();
  const first = await f.service.start({ taskId: task.id, message: "第一轮", requestId: "message-retry-001" }, () => {});
  const events = [];
  const duplicate = await f.service.start({ taskId: task.id, message: "第一轮", requestId: "message-retry-001" }, (event) => events.push(event));
  assert.equal(duplicate.deduplicated, true);
  assert.deepEqual(events.map((event) => event.type), ["request_deduplicated", "task_saved"]);
  await assert.rejects(f.service.start({ taskId: task.id, message: "其他内容", requestId: "message-retry-001" }, () => {}), { statusCode: 409 });
  await assert.rejects(f.service.start({ taskId: task.id, message: "第二轮", requestId: "message-retry-002" }, () => {}), { statusCode: 409 });
  assert.equal(f.taskStore.listMessages(task.id).length, 1);
  assert.equal(f.calls.length, 1);
  gate.resolve();
  await first.completion;
  const repeat = await f.service.start({ taskId: task.id, message: "第一轮", requestId: "message-retry-001" }, () => {});
  assert.equal(repeat.deduplicated, true);
  assert.equal(f.taskStore.listMessages(task.id).length, 2);
  assert.equal(f.calls.length, 1);
});

test("completed tasks accept a second turn on the same execution session", async (t) => {
  const f = fixture(t);
  const { task } = await f.service.createTask();
  for (const message of ["计算平均值", "再说一遍结果"]) {
    const handle = await f.service.start({ taskId: task.id, message }, () => {});
    await handle.completion;
  }
  assert.deepEqual(f.calls.map(({ sessionId }) => sessionId), [task.executionSessionId, task.executionSessionId]);
  assert.deepEqual(f.taskStore.listMessages(task.id).map(({ sequence }) => sequence), [1, 2, 3, 4]);
  assert.equal(f.taskStore.getTask(task.id).status, "idle");
});

test("runtime errors become safe failed history and release the task for retry", async (t) => {
  const f = fixture(t, async () => { throw new Error("credential=secret-value-that-must-not-escape"); });
  const { task } = await f.service.createTask();
  const events = [];
  const first = await f.service.start({ taskId: task.id, message: "请运行" }, (event) => events.push(event));
  const result = await first.completion;
  assert.equal(result.task.status, "failed");
  assert.equal(f.taskStore.listMessages(task.id).at(-1).status, "failed");
  assert.deepEqual(events.slice(-4).map((event) => event.type), ["error", "done", "message_saved", "task_saved"]);
  assert.equal(events.find((event) => event.type === "done").status, "failed");
  assert.doesNotMatch(JSON.stringify([events, f.taskStore.listMessages(task.id), f.taskStore.listRunEvents(task.id)]), /secret-value/);
  f.agentRuntime.run = async (_input, emit) => {
    emit({ type: "assistant_message", text: "重试已完成。" });
    emit({ type: "done", status: "succeeded", runId: randomUUID() });
  };
  await (await f.service.start({ taskId: task.id, message: "重试" }, () => {})).completion;
  assert.equal(f.taskStore.getTask(task.id).status, "idle");
  assert.equal(f.taskStore.listMessages(task.id).length, 4);
});

test("a disconnected event consumer does not cancel execution or saved history", async (t) => {
  const f = fixture(t);
  const { task } = await f.service.createTask();
  const handle = await f.service.start({ taskId: task.id, message: "读取数据" }, () => { throw new Error("browser disconnected"); });
  await handle.completion;
  assert.equal(f.taskStore.getTask(task.id).status, "idle");
  assert.equal(f.taskStore.listMessages(task.id).at(-1).content, "结果为 25。");
  assert.equal(f.taskStore.listRunEvents(task.id).at(-1).type, "done");
});

test("startup recovery marks unfinished tasks failed once and keeps interruption evidence", async (t) => {
  const f = fixture(t);
  const { task } = await f.service.createTask();
  const turn = f.taskStore.beginTurn(task.id, "尚未完成的任务", "interrupted-turn-01");
  f.taskStore.updateExecution(task.id, { currentRunId: "interrupted-run" });
  const store = f.reopen();
  assert.equal(store.recoverInterruptedTasks().length, 1);
  assert.equal(store.getTask(task.id).status, "failed");
  const messages = store.listMessages(task.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].status, "failed");
  assert.match(messages[1].content, /中断/);
  assert.equal(store.listRunEvents(task.id).at(-1).payload.status, "failed");
  assert.equal(store.listRunEvents(task.id).at(-1).userMessageId, turn.message.id);
  assert.equal(store.recoverInterruptedTasks().length, 0);
  assert.equal(store.listMessages(task.id).length, 2);
});

test("invalid, unknown, and unavailable submissions fail before creating user history", async (t) => {
  const f = fixture(t);
  const { task } = await f.service.createTask();
  for (const message of ["  ", "x".repeat(120001), null]) {
    await assert.rejects(f.service.start({ taskId: task.id, message }, () => {}), { statusCode: 400 });
  }
  await assert.rejects(f.service.start({ taskId: task.id, message: "你好", requestId: "short" }, () => {}), { statusCode: 400 });
  await assert.rejects(f.service.start({ taskId: randomUUID(), message: "你好" }, () => {}), { statusCode: 404 });
  await assert.rejects(f.service.createTask("invalid!"), { statusCode: 400 });
  const unavailable = new TaskMessageService({ taskStore: f.taskStore });
  await assert.rejects(unavailable.start({ taskId: task.id, message: "你好" }, () => {}), { statusCode: 503 });
  await assert.rejects(unavailable.createTask(), { statusCode: 503 });
  assert.equal(f.taskStore.listMessages(task.id).length, 0);
  assert.equal(f.calls.length, 0);
  assert.ok(new TaskMessageSubmissionError(409, "conflict") instanceof Error);
});

test("concurrent failed creation returns safe server errors and allows another attempt", async (t) => {
  const f = fixture(t);
  const gate = deferred();
  f.agentRuntime.create = async () => {
    await gate.promise;
    throw new Error("credential=creation-secret");
  };
  const attempts = [f.service.createTask("create-failure-001"), f.service.createTask("create-failure-001")];
  gate.resolve();
  for (const result of await Promise.allSettled(attempts)) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.statusCode, 500);
    assert.doesNotMatch(result.reason.message, /creation-secret/);
  }
  assert.equal(f.taskStore.listTasks().length, 0);
  f.agentRuntime.create = async () => ({ id: randomUUID(), status: "idle", runs: [] });
  assert.equal((await f.service.createTask("create-failure-001")).deduplicated, false);
});

test("an execution failure before its first runtime event still has a persisted failed run", async (t) => {
  const f = fixture(t);
  f.agentRuntime.run = async () => { throw new Error("startup-secret"); };
  const { task } = await f.service.createTask();
  await (await f.service.start({ taskId: task.id, message: "运行" }, () => {})).completion;
  const events = f.taskStore.listRunEvents(task.id);
  assert.deepEqual(events.map(({ type }) => type), ["error", "done"]);
  assert.ok(events[0].runId);
  assert.equal(events[0].runId, events[1].runId);
  assert.equal(f.taskStore.getTask(task.id).status, "failed");
});

test("a database write failure cannot escape as an unhandled background rejection", async (t) => {
  const gate = deferred();
  const f = fixture(t, async (_input, emit, runId) => {
    await gate.promise;
    emit({ type: "assistant_message", text: "结果为 25。" });
    emit({ type: "done", status: "succeeded", runId });
  });
  const events = [];
  const { task } = await f.service.createTask();
  const handle = await f.service.start({ taskId: task.id, message: "运行" }, (event) => events.push(event));
  // A real closed SQLite connection models loss of access during a run.
  f.reopen();
  gate.resolve();
  const result = await handle.completion;
  assert.equal(result.task.status, "failed");
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).status, "failed");
  assert.equal(events.some(({ type }) => type === "message_saved"), false);
});

test("done without status completes the task successfully", async (t) => {
  const f = fixture(t, async (_input, emit, runId) => {
    emit({ type: "assistant_message", text: "完成。" });
    emit({ type: "done", runId });
  });
  const { task } = await f.service.createTask();
  const result = await (await f.service.start({ taskId: task.id, message: "请运行" }, () => {})).completion;
  assert.equal(result.task.status, "idle");
  assert.equal(result.assistantMessage.status, "complete");
  assert.equal(f.taskStore.listRunEvents(task.id).some(({ type }) => type === "error"), false);
});

test("both cancellation spellings allow another turn, while an error still marks failure", async (t) => {
  for (const status of ["canceled", "cancelled"]) {
    for (const withError of [false, true]) {
      const f = fixture(t, async (_input, emit, runId) => {
        if (withError) emit({ type: "error", error: "safe runtime error" });
        emit({ type: "done", status, runId });
      });
      const { task } = await f.service.createTask();
      const result = await (await f.service.start({ taskId: task.id, message: "请运行" }, () => {})).completion;
      assert.equal(result.task.status, withError ? "failed" : "idle");
      assert.equal(result.assistantMessage.status, withError ? "failed" : "complete");
      if (!withError) assert.match(result.assistantMessage.content, /中断/);
      await (await f.service.start({ taskId: task.id, message: "再次运行" }, () => {})).completion;
      assert.equal(f.taskStore.listMessages(task.id).length, 4);
    }
  }
});

test("a runtime without run IDs still persists every pending event under one fallback ID", async (t) => {
  const f = fixture(t);
  f.agentRuntime.run = async (_input, emit) => {
    emit({ type: "progress_message", text: "开始检查" });
    emit({ type: "run_status", status: "running" });
    emit({ type: "tool_start", toolCallId: "tool-1", toolName: "read", args: { path: "numbers.csv" } });
    emit({ type: "tool_end", toolCallId: "tool-1", toolName: "read", isError: false, result: "10,20,30,40" });
    emit({ type: "assistant_message", text: "结果为 25。" });
    emit({ type: "done", status: "succeeded" });
  };
  const { task } = await f.service.createTask();
  const result = await (await f.service.start({ taskId: task.id, message: "运行" }, () => {})).completion;
  const store = f.reopen();
  const events = store.listRunEvents(task.id);
  assert.deepEqual(events.map(({ type }) => type), ["progress_message", "run_status", "tool_start", "tool_end", "done"]);
  assert.match(result.finalRunId, /^[0-9a-f-]{36}$/);
  assert.ok(events.every(({ runId }) => runId === result.finalRunId));
  assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2, 3, 4, 5]);
  assert.equal(store.getTask(task.id).currentRunId, result.finalRunId);
});
