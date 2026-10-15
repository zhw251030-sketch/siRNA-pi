import assert from "node:assert/strict";
import test from "node:test";

test("SDK tool and progress events use the reference runtime contract", async () => {
  const { projectPiEvent } = await import("../packages/agent-runtime/local-pi-runtime.mjs");
  assert.deepEqual(projectPiEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "numbers.csv" } }),
    { type: "tool_start", toolCallId: "c1", toolName: "read", args: { path: "numbers.csv" } });
  assert.deepEqual(projectPiEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [] }, isError: true }),
    { type: "tool_end", toolCallId: "c1", toolName: "read", result: { content: [] }, isError: true });
  assert.deepEqual(projectPiEvent({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "先读取输入" }] } }),
    { type: "progress_message", text: "先读取输入" });
});

test("raw text and reasoning never become final answers before verified completion", async () => {
  const { projectPiEvent } = await import("../packages/agent-runtime/local-pi-runtime.mjs");
  assert.equal(projectPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "片段" } }), undefined);
  assert.equal(projectPiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private" } }), undefined);
  assert.equal(projectPiEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "结果" }] } }), undefined);
});
