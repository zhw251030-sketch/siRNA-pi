import assert from "node:assert/strict";
import test from "node:test";
import { verifyComposeFileTask } from "../scripts/lib/verify-compose-file-task.mjs";

// 人造的 Pi 1.2.0 SessionHeader / SessionMessageEntry；不使用真实会话或密钥。
const csv = "value\n3\n-1\n10\n";
const resultJson = '{"count":3,"sum":12,"mean":4}';
const assistant = (content, stopReason = "toolUse") => ({
  role: "assistant", provider: "agent-compose", model: "MiniMax-M3",
  api: "anthropic-messages", content, stopReason, timestamp: 1,
});
const call = (id, name, path) => ({
  type: "toolCall", id, name,
  arguments: { path, ...(name === "write" ? { content: resultJson } : {}) },
});
const result = (toolCallId, toolName, text = "成功") => ({
  role: "toolResult", toolCallId, toolName, isError: false,
  content: [{ type: "text", text }], timestamp: 1,
});
const final = () => assistant([{ type: "text", text: "统计结果已写入并重新读取。" }], "stop");

function fixture() {
  return [
    { type: "session", version: 3, id: "synthetic-session", timestamp: "2026-10-20T00:00:00.000Z", cwd: "/workspace" },
    { type: "model_change", provider: "agent-compose", modelId: "MiniMax-M3" },
    { type: "message", message: { role: "user", content: "读取 CSV，写入统计结果，再读取结果。", timestamp: 1 } },
    ...[
      assistant([call("read-input", "read", "input/numbers.csv")]),
      result("read-input", "read", csv),
      assistant([call("write-output", "write", "/workspace/output/result.json")]),
      result("write-output", "write"),
      assistant([call("read-output", "read", "./output/result.json")]),
      result("read-output", "read", resultJson),
      final(),
    ].map((message) => ({ type: "message", message })),
  ];
}

function verify(entries = fixture(), overrides = {}) {
  const rows = entries.map((entry, index) => index === 0 ? entry : {
    id: `entry-${index}`, parentId: index === 1 ? null : `entry-${index - 1}`,
    timestamp: "2026-10-20T00:00:00.000Z", ...entry,
  });
  return verifyComposeFileTask({ sessionJsonl: rows.map((row) => JSON.stringify(row)).join("\n") + "\n", csv, resultJson, ...overrides });
}

test("原生 Pi 会话凭真实工具结果通过，不要求流式 agent_settled", () => {
  const report = verify();
  assert.deepEqual(report.result, { count: 3, sum: 12, mean: 4 });
  assert.equal(report.sessionId, "synthetic-session");
  assert.equal(report.assistantResponses, 4);
  assert.equal(report.toolCalls, 3);
  assert.equal(report.toolResults, 3);
  assert.equal(report.readCalls, 2);
  assert.equal(report.writeCalls, 1);
});

test("允许额外安全读取和不同的最终文字，不限定工具次数", () => {
  const entries = fixture();
  entries.splice(-1, 0,
    { type: "message", message: assistant([call("extra-read", "read", "/workspace/input/notes.txt")]) },
    { type: "message", message: result("extra-read", "read", "说明") },
  );
  entries.at(-1).message.content[0].text = "完成。";
  const report = verify(entries);
  assert.equal(report.assistantResponses, 5);
  assert.equal(report.readCalls, 3);
  assert.equal(report.toolCalls, 4);
});

test("允许重新写入后重新读取，不要求恰好一次 write", () => {
  const entries = fixture();
  entries.splice(-1, 0,
    { type: "message", message: assistant([call("rewrite", "write", "output/result.json")]) },
    { type: "message", message: result("rewrite", "write") },
    { type: "message", message: assistant([call("reread", "read", "output/result.json")]) },
    { type: "message", message: result("reread", "read", resultJson) },
  );
  assert.equal(verify(entries).writeCalls, 2);
});

test("从传入 CSV 独立计算，支持 CRLF、负数及小数", () => {
  const report = verify(undefined, { csv: "value\r\n1.5\r\n-0.5\r\n4\r\n", resultJson: '{"count":3,"sum":5,"mean":1.6666666666666667}' });
  assert.deepEqual(report.result, { count: 3, sum: 5, mean: 1.6666666666666667 });
});

const mutations = [
  ["只有最终文字伪称完成", (e) => e.splice(3, 6), /工具|序列/],
  ["只用用户消息伪装工具证据", (e) => e.slice(3, -1).forEach((r) => { r.message = { role: "user", content: JSON.stringify(r.message) }; }), /工具|序列/],
  ["缺失工具结果", (e) => e.splice(4, 1), /完成|结果|顺序/],
  ["失败的工具结果", (e) => { e[4].message.isError = true; }, /失败|isError/],
  ["缺少明确的成功标记", (e) => { delete e[4].message.isError; }, /成功|isError/],
  ["无法配对的 toolCallId", (e) => { e[4].message.toolCallId = "unknown"; }, /匹配|调用/],
  ["结果使用错误的工具名", (e) => { e[4].message.toolName = "write"; }, /工具名|匹配/],
  ["重复的调用编号", (e) => { e[7].message.content[0].id = "read-input"; }, /重复/],
  ["重复的工具结果", (e) => e.splice(5, 0, structuredClone(e[4])), /重复|完成/],
  ["结果出现在调用之前", (e) => { [e[3], e[4]] = [e[4], e[3]]; }, /匹配|调用/],
  ["错误的模型", (e) => { e[3].message.model = "other-model"; }, /模型|model/],
  ["错误的模型提供方", (e) => { e[3].message.provider = "minimax-cn"; }, /提供方|provider/],
  ["错误的工作目录", (e) => { e[0].cwd = "/tmp"; }, /工作目录|cwd/],
  ["重复的 session 头", (e) => e.splice(1, 0, { ...e[0] }), /session|会话头/],
  ["assistant 错误结束", (e) => { e.at(-1).message.stopReason = "error"; }, /正常|error/],
  ["assistant 被中止", (e) => { e[3].message.stopReason = "aborted"; }, /正常|aborted/],
  ["隐藏在中间响应的 errorMessage", (e) => { e[3].message.errorMessage = "失败"; }, /errorMessage|错误/],
  ["最后一条消息尚未 stop", (e) => e.pop(), /最终|结束/],
  ["最终响应因长度停止", (e) => { e.at(-1).message.stopReason = "length"; }, /正常|stop/],
  ["调用未允许的工具", (e) => { e[3].message.content[0].name = "bash"; }, /工具/],
  ["写入非指定输出", (e) => { e[5].message.content[0].arguments.path = "input/numbers.csv"; }, /写入|路径/],
  ["先写后读输入", (e) => { e.splice(3, 4, e[5], e[6], e[3], e[4]); }, /顺序|读取/],
  ["读取输出发生在写入之前", (e) => { e.splice(5, 4, e[7], e[8], e[5], e[6]); }, /顺序|重新读取|序列/],
  ["写入后未重新读取最新输出", (e) => e.splice(-1, 0,
    { type: "message", message: assistant([call("last-write", "write", "output/result.json")]) },
    { type: "message", message: result("last-write", "write") }), /重新读取|序列/],
  ["以同批调用冒充已读输入后的写入", (e) => {
    e[3].message.content.push(e[5].message.content[0]);
    e.splice(5, 1);
  }, /顺序|读取/],
];
for (const [name, change, expected] of mutations) {
  test(`拒绝${name}`, () => {
    const entries = fixture();
    change(entries);
    assert.throws(() => verify(entries), expected);
  });
}

for (const path of ["../input/numbers.csv", "/etc/passwd", "/workspace-other/input/numbers.csv", "/workspace/input/../../etc/passwd", "input/../output/result.json", "input\\numbers.csv", "C:/workspace/input/numbers.csv", "input/numbers.csv\0", "/workspace/docs/auth.json"]) {
  test(`拒绝范围外或有歧义的读取路径 ${JSON.stringify(path)}`, () => {
    const entries = fixture();
    entries[3].message.content[0].arguments.path = path;
    assert.throws(() => verify(entries), /路径/);
  });
}

for (const [name, overrides, expected] of [
  ["实际结果数值错误", { resultJson: '{"count":3,"sum":12,"mean":5}' }, /独立计算/],
  ["实际结果字段是字符串", { resultJson: '{"count":3,"sum":"12","mean":4}' }, /数值|数字/],
  ["实际结果不是 JSON", { resultJson: "我已经成功写入。" }, /JSON/],
  ["CSV 包含非数值", { csv: "value\n3\nnot-a-number\n10\n" }, /CSV/],
  ["CSV 没有数据", { csv: "value\n" }, /CSV/],
  ["CSV 包含额外列", { csv: "value\n3,4\n" }, /CSV/],
  ["CSV 包含非有限数", { csv: "value\n1e999\n" }, /CSV/],
  ["损坏的 JSONL", { sessionJsonl: "{\n" }, /JSONL/],
  ["空的会话日志", { sessionJsonl: "\n" }, /会话|JSONL/],
]) {
  test(`拒绝${name}`, () => assert.throws(() => verify(undefined, overrides), expected));
}
