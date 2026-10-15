import assert from "node:assert/strict";
import test from "node:test";
import { consumeSse } from "../public/sse.mjs";

function responseFrom(text, chunkSize = 4096) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

test("SSE preserves split Chinese UTF-8 and receives persistence events after done", async () => {
  const events = [];
  const response = responseFrom([
    ': heartbeat\n\n',
    'data: {"type":"text_delta","delta":"平均值是 25"}\n\n',
    'data: {"type":"done","status":"succeeded"}\n\n',
    'data: {"type":"message_saved","message":{"id":"m1","text":"平均值是 25"}}\n\n',
    'data: {"type":"task_saved","task":{"id":"t1","status":"idle"}}\n\n',
  ].join(""), 1);
  await consumeSse(response, (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.type), ["text_delta", "done", "message_saved", "task_saved"]);
  assert.equal(events[0].delta, "平均值是 25");
  assert.equal(events[2].message.id, "m1");
});

test("SSE accepts CRLF, comments and multi-line data split across chunks", async () => {
  const events = [];
  await consumeSse(responseFrom(': comment\r\ndata: {"type":"task_saved",\r\ndata: "task":{"id":"t1"}}\r\n\r\n', 3), (event) => events.push(event));
  assert.deepEqual(events, [{ type: "task_saved", task: { id: "t1" } }]);
});

test("deduplicated request may end without a new run or done event", async () => {
  const events = [];
  await consumeSse(responseFrom('data: {"type":"request_deduplicated","taskId":"t1","requestId":"message:one"}\n\ndata: {"type":"task_saved","task":{"id":"t1"}}\n\n'), (event) => events.push(event));
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "request_deduplicated");
});

test("deduplication alone does not prove the persisted task state was received", async () => {
  await assert.rejects(consumeSse(responseFrom('data: {"type":"request_deduplicated","taskId":"t1"}\n\n'), () => {}));
});

test("a disconnected stream cannot report success after only done", async () => {
  await assert.rejects(
    consumeSse(responseFrom('data: {"type":"done","status":"succeeded"}\n\n'), () => {}),
    /完整|保存/,
  );
});

test("a malformed or incomplete tail rejects even after task_saved", async () => {
  for (const tail of ['data: {broken}\n\n', 'data: {"type":"message_saved"}', 'data: {"type":"message_saved"}\n']) {
    await assert.rejects(consumeSse(responseFrom('data: {"type":"task_saved","task":{"id":"t1"}}\n\n' + tail), () => {}));
  }
});

test("SSE rejects invalid UTF-8 instead of corrupting model text", async () => {
  const bytes = new Uint8Array([100, 97, 116, 97, 58, 32, 0xff, 10, 10]);
  await assert.rejects(consumeSse(new Response(bytes, { headers: { "content-type": "text/event-stream" } }), () => {}));
});

test("HTTP error responses expose their JSON explanation", async () => {
  await assert.rejects(
    consumeSse(new Response(JSON.stringify({ error: "已有任务正在运行，请稍后重试。" }), { status: 409 }), () => {}),
    /已有任务正在运行/,
  );
});

test("a non-SSE success response cannot be accepted as an empty successful run", async () => {
  await assert.rejects(consumeSse(new Response("{}", { headers: { "content-type": "application/json" } }), () => {}));
});
