import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import test from "node:test";

async function serve(t, runTask) {
  const { createAppServer } = await import("../src/server.mjs");
  const server = createAppServer({ runTask });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (body, headers = {}) => fetch(url + "/v1/tasks", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
  });
  return { url, send };
}

test("HTTP task passes trimmed input and returns the runner result", async (t) => {
  const { send } = await serve(t, async (message) => {
    assert.equal(message, "计算平均值");
    return { taskId: "task-1", answer: "平均值为25", workspace: "workspaces/web/task-1" };
  });
  const response = await send(JSON.stringify({ message: "  计算平均值  " }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { taskId: "task-1", answer: "平均值为25", workspace: "workspaces/web/task-1" });
});

test("invalid, oversized and cross-origin requests never execute a task", async (t) => {
  let calls = 0;
  const { send, url } = await serve(t, async () => { calls++; return {}; });
  for (const body of ['{"message":" "}', '{"message":42}', 'null', '{']) {
    assert.equal((await send(body)).status, 400);
  }
  assert.equal((await send(JSON.stringify({ message: "a".repeat(4001) }))).status, 400);
  assert.equal((await send(JSON.stringify({ message: "a".repeat(20000) }))).status, 413);
  assert.equal((await send('{"message":"hello"}', { Origin: "https://another.example" })).status, 403);
  assert.equal((await send('{"message":"hello"}', { "Content-Type": "text/plain" })).status, 415);
  // Node fetch 会自行设置 Host；用真实 HTTP 请求检查不可信 Host。
  const status = await new Promise((resolve, reject) => {
    const req = request(url + "/v1/tasks", { method: "POST", headers: { Host: "untrusted.example", "Content-Type": "application/json" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end('{"message":"hello"}');
  });
  assert.equal(status, 403);
  assert.equal(calls, 0);
});

test("concurrent task is rejected; a failed task releases the slot without exposing its error", async (t) => {
  let finish;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const { send } = await serve(t, async () => {
    if (++calls === 1) {
      started();
      await new Promise((resolve) => { finish = resolve; });
      throw new Error("private-provider-response");
    }
    return { answer: "下一次完成" };
  });
  const first = send('{"message":"one"}');
  await ready;
  assert.equal((await send('{"message":"two"}')).status, 409);
  finish();
  const failed = await first;
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /private-provider-response/);
  const next = await send('{"message":"three"}');
  assert.equal(next.status, 200);
  assert.equal((await next.json()).answer, "下一次完成");
});

test("static routing never serves project credentials, source or logs", async (t) => {
  const { url } = await serve(t, async () => ({}));
  for (const route of ["/docs/auth.json", "/runtime/web.log", "/src/server.mjs", "/package.json", "/%2e%2e/docs/auth.json"]) {
    assert.equal((await fetch(url + route)).status, 404);
  }
  const health = await fetch(url + "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ready: true, busy: false });
});

test("a malformed request target returns 400 and leaves the service available", async (t) => {
  const { url } = await serve(t, async () => ({}));
  const status = await new Promise((resolve, reject) => {
    const req = request(url, { path: "//[" }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 400);
  assert.equal((await fetch(url + "/health")).status, 200);
});
