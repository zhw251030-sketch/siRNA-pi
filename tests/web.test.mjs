import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import test from "node:test";

async function serve(t, run, configured = true, describe) {
  const { createAppServer } = await import("../apps/api/router.mjs");
  const { TaskStore } = await import("../packages/task-core/task-store.mjs");
  const parent = path.resolve("runtime", "http-tests");
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "case-"));
  const taskStore = new TaskStore(path.join(directory, "tasks.sqlite"));
  let created = 0, executed = 0;
  const agentRuntime = configured ? {
    async create() { created++; return { id: randomUUID(), status: "idle", runs: [] }; },
    async run(input, emit) {
      executed++;
      if (run) return run(input, emit);
      emit({ type: "session", sessionId: input.sessionId, runId: "run-1", backend: "local-pi", mode: "model" });
      emit({ type: "assistant_message", text: "平均值25" });
      emit({ type: "done", status: "succeeded", runId: "run-1" });
    },
    runtimeInfo() { return { backend: "test" }; },
    ...(describe ? { describe } : {}),
  } : undefined;
  const server = createAppServer({ taskStore, agentRuntime });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    taskStore.close();
    assert.equal(path.dirname(directory), parent);
    fs.rmSync(directory, { recursive: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body = "{}", headers = {}) => fetch(url + route, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
  });
  return { url, post, server, taskStore, counts: () => ({ created, executed }) };
}

test("create is separate from execution; messages use SSE and finish with persisted records", async (t) => {
  const { url, post, counts } = await serve(t);
  const created = await post("/v1/tasks", '{"requestId":"task:1234567890123456"}');
  assert.equal(created.status, 201);
  const { task } = await created.json();
  assert.equal(task.status, "idle");
  assert.equal(task.messageCount, 0);
  assert.deepEqual(counts(), { created: 1, executed: 0 });
  assert.equal((await post("/v1/tasks", '{"requestId":"task:1234567890123456"}')).status, 200);
  const response = await post(`/v1/tasks/${task.id}/messages`, '{"message":"  计算平均值  ","requestId":"message:1234567890123456"}');
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data:")).map((frame) => JSON.parse(frame.slice(5)));
  assert.equal(events[0].type, "task");
  assert.ok(events.findIndex((e) => e.type === "message_saved") > events.findIndex((e) => e.type === "done"));
  assert.equal(events.at(-1).type, "task_saved");
  const history = await (await fetch(`${url}/v1/tasks/${task.id}/messages`)).json();
  assert.deepEqual(history.messages.map((m) => [m.role, m.content]), [["user", "计算平均值"], ["assistant", "平均值25"]]);
  assert.equal(history.task.status, "idle");
  assert.equal(history.execution, null);
  assert.equal((await (await fetch(url + "/v1/tasks")).json()).tasks.length, 1);
  const repeated = await post(`/v1/tasks/${task.id}/messages`, '{"message":"计算平均值","requestId":"message:1234567890123456"}');
  assert.match(await repeated.text(), /request_deduplicated/);
  assert.deepEqual(counts(), { created: 1, executed: 1 });
});

test("history includes task-specific runtime paths without guessing the workspace", async (t) => {
  const execution = {
    backend: "agent-compose", sandboxId: "a".repeat(64),
    workspacePath: "runtime/agent-compose/data/sandboxes/2026/10/20/sandbox/workspace",
    eventLogPath: "runtime/web/session.run.events.jsonl",
  };
  let describedId;
  const { url, post } = await serve(t, undefined, true, async (id) => {
    describedId = id;
    return execution;
  });
  const { task } = await (await post("/v1/tasks")).json();
  await (await post(`/v1/tasks/${task.id}/messages`, '{"message":"保留历史"}')).text();
  const response = await fetch(`${url}/v1/tasks/${task.id}/messages`);
  assert.equal(response.status, 200);
  const history = await response.json();
  assert.equal(describedId, task.executionSessionId);
  assert.deepEqual(history.execution, execution);
  assert.deepEqual(history.messages.map((message) => message.content), ["保留历史", "平均值25"]);
});

test("unavailable runtime metadata cannot hide saved history or reveal the failure detail", async (t) => {
  const { url, post } = await serve(t, undefined, true, async () => {
    throw new Error("PRIVATE_RUNTIME_DETAIL");
  });
  const { task } = await (await post("/v1/tasks")).json();
  await (await post(`/v1/tasks/${task.id}/messages`, '{"message":"保留历史"}')).text();
  const response = await fetch(`${url}/v1/tasks/${task.id}/messages`);
  assert.equal(response.status, 200);
  const history = await response.json();
  assert.deepEqual(history.execution, { unavailable: true });
  assert.deepEqual(history.messages.map((message) => message.content), ["保留历史", "平均值25"]);
  assert.ok(history.runEvents.some((event) => event.type === "done"));
  assert.ok(!JSON.stringify(history).includes("PRIVATE_RUNTIME_DETAIL"));
});

test("the first SSE event arrives before the runtime finishes", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { post } = await serve(t, async (_input, emit) => {
    emit({ type: "progress_message", text: "正在读取" });
    await gate;
    emit({ type: "assistant_message", text: "完成" });
    emit({ type: "done", status: "succeeded" });
  });
  const { task } = await (await post("/v1/tasks")).json();
  const response = await post(`/v1/tasks/${task.id}/messages`, '{"message":"运行"}');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /connected|"type":"task"/);
  assert.equal((await post(`/v1/tasks/${task.id}/messages`, '{"message":"另一条"}')).status, 409);
  release();
  let tail = "";
  for (;;) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value); }
  assert.match(tail, /task_saved/);
});

test("shutdown waits for an accepted turn even after its browser disconnected", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { post, server, taskStore } = await serve(t, async (_input, emit) => {
    await gate;
    emit({ type: "assistant_message", text: "断线后仍已保存" });
    emit({ type: "done", status: "succeeded" });
  });
  const { task } = await (await post("/v1/tasks")).json();
  const response = await post(`/v1/tasks/${task.id}/messages`, '{"message":"运行"}');
  await response.body.cancel();
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  let drained = false;
  const completion = server.waitForTaskCompletion().then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  assert.equal(taskStore.getTask(task.id).status, "running");
  release();
  await completion;
  assert.equal(taskStore.getTask(task.id).status, "idle");
  assert.equal(taskStore.listMessages(task.id).at(-1).content, "断线后仍已保存");
});

test("invalid input, unsupported features, missing runtime and unknown tasks fail before execution", async (t) => {
  const { post, counts } = await serve(t);
  for (const body of ["null", "{", '{"message":"old combined endpoint"}', '{"requestId":"short"}', '{"memoryFileIds":["not-implemented"]}']) {
    assert.equal((await post("/v1/tasks", body)).status, 400);
  }
  assert.equal((await post("/v1/tasks", JSON.stringify({ requestId: "a".repeat(1100000) }))).status, 413);
  assert.equal((await post("/v1/tasks/missing/messages", '{"message":"hello"}')).status, 404);
  const { task } = await (await post("/v1/tasks")).json();
  for (const body of ['{"message":" "}', '{"message":42}', '{"message":"hi","revisesMessageId":"unsupported"}']) {
    assert.equal((await post(`/v1/tasks/${task.id}/messages`, body)).status, 400);
  }
  assert.equal((await post(`/v1/tasks/${task.id}/messages`, JSON.stringify({ message: "a".repeat(120001) }))).status, 400);
  assert.equal(counts().executed, 0);
  const unavailable = await serve(t, undefined, false);
  assert.equal((await unavailable.post("/v1/tasks")).status, 503);
});

test("static routes protect project files and only accept local same-origin requests", async (t) => {
  const { url, post, counts } = await serve(t);
  for (const route of ["/docs/auth.json", "/runtime/web.log", "/packages/agent-runtime/pi-sdk.mjs", "/package.json", "/%2e%2e/docs/auth.json"]) {
    assert.equal((await fetch(url + route)).status, 404);
  }
  assert.equal((await post("/v1/tasks", "{}", { Origin: "https://another.example" })).status, 403);
  assert.equal((await post("/v1/tasks", "{}", { "Content-Type": "text/plain" })).status, 415);
  for (const [target, host, expected] of [["/health", "untrusted.example", 403], ["//[", new URL(url).host, 400]]) {
    const status = await new Promise((resolve, reject) => {
      const req = request(url, { path: target, headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(status, expected);
  }
  assert.equal((await fetch(url + "/health")).status, 200);
  assert.equal((await fetch(url + "/v1/chat")).status, 410);
  assert.equal(counts().executed, 0);
});
