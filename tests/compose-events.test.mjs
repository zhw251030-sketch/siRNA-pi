import assert from "node:assert/strict";
import test from "node:test";
import { createComposeEventProjector } from "../packages/agent-runtime/compose-events.mjs";

// Hand-written protocol fixtures, from Agent Compose v2609.3.0 PiRunner,
// interactive.ts and stream.ts. The final RPC wrapper uses eof; the preceding
// agent_turn_completed frame retains PiRunner's completed stop reason.
const threadId = "b29d2b95-ad3d-4b58-bc37-8855b6372a09";
const turn = {
  v: 1, seq: 12, type: "agent_turn_completed", provider: "pi", threadId,
  finalText: "共 4 个数，平均值为 25。", finalTextSource: "provider_message", stopReason: "completed",
};
const wrapper = {
  v: 1, seq: 13, type: "result", provider: "pi", threadId,
  stopReason: "eof", finalText: turn.finalText, finalTextSource: "provider_message",
  transcript: "先读取文件\n共 4 个数，平均值为 25。", stderr: "",
};
const snapshot = (result = wrapper) => ({
  runId: "run-1", sandboxId: "a".repeat(64), status: "succeeded", output: "",
  warnings: [], resultJson: JSON.stringify(result),
});
function fixture() {
  const events = [];
  const projection = createComposeEventProjector((event) => events.push(event));
  const event = (name, payload, text) => projection.onAgentEvent({ name, payload: { kind: name, ...payload }, text });
  return { projection, event, events };
}
function lastStep(f, stopReason = "stop", rawStopReason = stopReason) {
  f.event("step_start", { step: 2 });
  f.event("text_delta", { step: 2, blockIndex: 0, text: turn.finalText });
  f.event("step_end", { step: 2, stopReason, rawStopReason });
}
function completed(f) {
  lastStep(f);
  f.projection.onTurnCompleted(JSON.stringify(turn));
}

test("Pi's step_end before tools produces one progress entry and paired tool events", () => {
  const f = fixture();
  f.event("step_start", { step: 1 });
  f.event("text_delta", { step: 1, blockIndex: 0, text: "先读取文件" });
  f.event("reasoning_delta", { step: 1, text: "PRIVATE_REASONING" });
  f.event("step_end", { step: 1, stopReason: "tool_use", rawStopReason: "toolUse" });
  f.event("tool_call", { step: 1, id: "c1", name: "read", toolKind: "read", status: "in_progress", input: { path: "numbers.csv" } });
  f.event("tool_call", { step: 1, id: "c1", name: "read", toolKind: "read", status: "in_progress", input: { path: "numbers.csv" } });
  f.event("tool_result", { step: 1, id: "c1", ok: true, output: '{"content":[{"type":"text","text":"10\\n20\\n30\\n40"}]}' });
  completed(f);
  assert.deepEqual(f.events, [
    { type: "progress_message", text: "先读取文件" },
    { type: "tool_start", toolCallId: "c1", toolName: "read", args: { path: "numbers.csv" } },
    { type: "tool_end", toolCallId: "c1", toolName: "read", result: { content: [{ type: "text", text: "10\n20\n30\n40" }] }, isError: false },
  ]);
  assert.deepEqual(f.projection.finish(snapshot()), {
    answer: turn.finalText, piSessionId: threadId, toolCalls: 1, toolResults: 1, failedTools: 0, modelResponses: 2,
  });
  assert.ok(!JSON.stringify(f.events).includes("PRIVATE_REASONING"));
});

test("final text stays private until verified completion and is returned without raw frame data", () => {
  const f = fixture();
  f.event("started", { type: "started", provider: "pi", threadId: "" });
  f.event("reasoning_delta", { step: 2, text: "PRIVATE_REASONING" }, "PRIVATE_REASONING");
  f.event("state", { text: "UNTRUSTED_STATE" });
  completed(f);
  assert.deepEqual(f.events, []);
  assert.equal(f.projection.finish(snapshot()).answer, turn.finalText);
  assert.deepEqual(f.events, []);
});

test("a failed tool can be followed by a normal model answer", () => {
  const f = fixture();
  f.event("step_start", { step: 1 });
  f.event("step_end", { step: 1, stopReason: "tool_use", rawStopReason: "toolUse" });
  f.event("tool_call", { step: 1, id: "c1", name: "read", toolKind: "read", status: "in_progress", input: { path: "missing.csv" } });
  f.event("tool_result", { step: 1, id: "c1", ok: false, output: "File not found", error: "tool error" });
  completed(f);
  assert.equal(f.events.at(-1).isError, true);
  assert.equal(f.projection.finish(snapshot()).failedTools, 1);
});

for (const rawStopReason of ["length", "aborted", "unknown"])
  test(`outer succeeded cannot hide Pi's unmapped ${rawStopReason} stop reason`, () => {
    const f = fixture();
    f.event("step_start", { step: 2 });
    f.event("text_delta", { step: 2, blockIndex: 0, text: turn.finalText });
    f.event("step_end", { step: 2, rawStopReason });
    f.projection.onTurnCompleted(JSON.stringify(turn));
    assert.throws(() => f.projection.finish(snapshot()), /未完成/);
  });

test("provider raw end_turn is compatible with normalized stop", () => {
  const f = fixture();
  lastStep(f, "stop", "end_turn");
  f.projection.onTurnCompleted(JSON.stringify(turn));
  assert.equal(f.projection.finish(snapshot()).piSessionId, threadId);
});

for (const [label, mutate] of [
  ["missing turn completion", (f) => lastStep(f)],
  ["missing final step", (f) => f.projection.onTurnCompleted(JSON.stringify(turn))],
  ["last step still requests tools", (f) => { lastStep(f, "tool_use", "toolUse"); f.projection.onTurnCompleted(JSON.stringify(turn)); }],
  ["an earlier abnormal step", (f) => { f.event("step_start", { step: 1 }); f.event("step_end", { step: 1, rawStopReason: "length" }); completed(f); }],
  ["pending tool", (f) => { f.event("step_start", { step: 1 }); f.event("step_end", { step: 1, stopReason: "tool_use" }); f.event("tool_call", { step: 1, id: "c1", name: "read", status: "in_progress", input: {} }); completed(f); }],
  ["unpaired tool result", (f) => { f.event("tool_result", { step: 1, id: "missing", ok: true, output: "done" }); completed(f); }],
  ["model error event", (f) => { f.event("error", { severity: "error", message: "SECRET_SERVER_DETAIL" }); completed(f); }],
]) test(`completion rejects ${label}`, () => {
  const f = fixture();
  mutate(f);
  assert.throws(() => f.projection.finish(snapshot()), (error) => /未完成/.test(error.message) && !error.message.includes("SECRET"));
});

for (const [label, patch] of [
  ["failed outer run", { status: "failed" }],
  ["outer error", { error: "SECRET_ERROR" }],
  ["cleanup error", { cleanupError: "SECRET_ERROR" }],
  ["invalid final JSON", { resultJson: "broken" }],
  ["mismatched final session", { resultJson: JSON.stringify({ ...wrapper, threadId: "another-session" }) }],
  ["CLI completion in RPC wrapper", { resultJson: JSON.stringify({ ...wrapper, stopReason: "completed" }) }],
  ["mismatched final text", { resultJson: JSON.stringify({ ...wrapper, finalText: "different" }) }],
  ["transcript fallback", { resultJson: JSON.stringify({ ...wrapper, finalTextSource: "transcript_fallback" }) }],
]) test(`completion rejects ${label}`, () => {
  const f = fixture();
  completed(f);
  assert.throws(() => f.projection.finish({ ...snapshot(), ...patch }), /未完成/);
});

for (const [label, raw] of [
  ["invalid JSON", "{"], ["array", "[]"],
  ["wrong provider", JSON.stringify({ ...turn, provider: "codex" })],
  ["missing session ID", JSON.stringify({ ...turn, threadId: "" })],
  ["empty answer", JSON.stringify({ ...turn, finalText: "  " })],
  ["cancelled turn", JSON.stringify({ ...turn, stopReason: "cancelled" })],
  ["transcript answer", JSON.stringify({ ...turn, finalTextSource: "transcript_fallback" })],
]) test(`turn parser rejects ${label} without forwarding raw data`, () => {
  const f = fixture();
  assert.throws(() => f.projection.onTurnCompleted(raw), /未完成/);
  assert.deepEqual(f.events, []);
});

test("tool payloads redact credentials, cap large content and preserve safe paths", () => {
  const f = fixture();
  f.event("step_start", { step: 1 });
  f.event("step_end", { step: 1, stopReason: "tool_use" });
  f.event("tool_call", { step: 1, id: "c1", name: "write", status: "in_progress", input: {
    path: "result.json", apiKey: "FAKE_KEY", nested: { authorization: "Bearer FAKE_TOKEN" },
    content: "token=FAKE_INLINE https://example.test/?password=FAKE_QUERY",
  } });
  f.event("tool_result", { step: 1, id: "c1", ok: true, output: JSON.stringify({ content: [{ type: "text", text: "x".repeat(70_000) }] }) });
  const encoded = JSON.stringify(f.events);
  assert.ok(!encoded.includes("FAKE_"));
  assert.equal(f.events[0].args.path, "result.json");
  assert.equal(f.events[1].result.truncated, true);
  assert.ok(encoded.length < 30_000);
});

test("duplicate tool results do not create duplicate activity or counts", () => {
  const f = fixture();
  f.event("step_start", { step: 1 });
  f.event("step_end", { step: 1, stopReason: "tool_use" });
  f.event("tool_call", { step: 1, id: "c1", name: "read", status: "in_progress", input: {} });
  f.event("tool_result", { step: 1, id: "c1", ok: true, output: "ok" });
  f.event("tool_result", { step: 1, id: "c1", ok: true, output: "ok" });
  completed(f);
  assert.equal(f.projection.finish(snapshot()).toolResults, 1);
  assert.equal(f.events.filter((event) => event.type === "tool_end").length, 1);
});

test("JSON text inside a tool result cannot forward the guest facade token", () => {
  const f = fixture();
  f.event("step_start", { step: 1 });
  f.event("step_end", { step: 1, stopReason: "tool_use", rawStopReason: "toolUse" });
  f.event("tool_call", { step: 1, id: "c1", name: "read", status: "in_progress", input: { path: "/root/.pi/agent/models.json" } });
  f.event("tool_result", { step: 1, id: "c1", ok: true, output: JSON.stringify({ content: [{ type: "text",
    text: '{"providers":{"agent-compose":{"apiKey":"FAKE_FACADE_TOKEN","api":"anthropic-messages"}}}',
  }] }) });
  const text = f.events.at(-1).result.content[0].text;
  assert.equal(typeof text, "string");
  assert.equal(JSON.parse(text).providers["agent-compose"].apiKey, "[REDACTED]");
  assert.equal(JSON.parse(text).providers["agent-compose"].api, "anthropic-messages");
  assert.ok(!JSON.stringify(f.events).includes("FAKE_FACADE_TOKEN"));
});

for (const finalText of [
  '{"providers":{"agent-compose":{"apiKey":"FAKE_FINAL_TOKEN"}}}',
  '配置如下：\n```json\n{"apiKey":"FAKE_FINAL_TOKEN"}\n```',
]) test("verified final answers redact recognizable credential fields", () => {
  const f = fixture();
  f.event("step_start", { step: 1 });
  f.event("text_delta", { step: 1, blockIndex: 0, text: finalText });
  f.event("step_end", { step: 1, stopReason: "stop", rawStopReason: "end_turn" });
  f.projection.onTurnCompleted(JSON.stringify({ ...turn, finalText }));
  const answer = f.projection.finish(snapshot({ ...wrapper, finalText })).answer;
  assert.ok(!answer.includes("FAKE_FINAL_TOKEN"));
  assert.ok(answer.includes("[REDACTED]"));
});

test("deep JSON-in-text encoding is bounded and cannot retain credential content", () => {
  const f = fixture();
  let nested = '{"apiKey":"FAKE_DEEP_TOKEN"}';
  for (let i = 0; i < 16; i++) nested = JSON.stringify({ text: nested });
  f.event("step_start", { step: 1 });
  f.event("step_end", { step: 1, stopReason: "tool_use", rawStopReason: "toolUse" });
  f.event("tool_call", { step: 1, id: "c1", name: "read", status: "in_progress", input: {} });
  f.event("tool_result", { step: 1, id: "c1", ok: true, output: nested });
  const encoded = JSON.stringify(f.events);
  assert.ok(!encoded.includes("FAKE_DEEP_TOKEN"));
  assert.ok(encoded.length < 30_000);
});

for (const finalStepText of ["", "  ", "实际上执行尚未完成。"])
  test("completed wrappers cannot reuse earlier narration as the final answer", () => {
    const f = fixture();
    f.event("step_start", { step: 1 });
    f.event("text_delta", { step: 1, blockIndex: 0, text: turn.finalText });
    f.event("step_end", { step: 1, stopReason: "tool_use", rawStopReason: "toolUse" });
    f.event("step_start", { step: 2 });
    if (finalStepText) f.event("text_delta", { step: 2, blockIndex: 0, text: finalStepText });
    f.event("step_end", { step: 2, stopReason: "stop", rawStopReason: "stop" });
    f.projection.onTurnCompleted(JSON.stringify(turn));
    assert.throws(() => f.projection.finish(snapshot()), /未完成/);
  });

test("final answer comparison trims boundaries but preserves streamed block order", () => {
  const f = fixture();
  f.event("step_start", { step: 1 });
  f.event("text_delta", { step: 1, blockIndex: 0, text: "\n共 4 个数，" });
  f.event("text_delta", { step: 1, blockIndex: 2, text: "平均值为 25。  " });
  f.event("step_end", { step: 1, stopReason: "stop", rawStopReason: "end_turn" });
  f.projection.onTurnCompleted(JSON.stringify({ ...turn, finalText: ` ${turn.finalText}` }));
  assert.equal(f.projection.finish(snapshot({ ...wrapper, finalText: `${turn.finalText}\n` })).answer, turn.finalText);
});

for (const rawStopReason of ["length", "aborted", "error", "toolUse", "tool_use"])
  test(`normalized stop cannot contradict raw ${rawStopReason}`, () => {
    const f = fixture();
    lastStep(f, "stop", rawStopReason);
    f.projection.onTurnCompleted(JSON.stringify(turn));
    assert.throws(() => f.projection.finish(snapshot()), /未完成/);
  });

test("normalized tool_use accepts the provider tool_use spelling", () => {
  const f = fixture();
  f.event("step_start", { step: 1 });
  f.event("step_end", { step: 1, stopReason: "tool_use", rawStopReason: "tool_use" });
  completed(f);
  assert.equal(f.projection.finish(snapshot()).modelResponses, 2);
});
