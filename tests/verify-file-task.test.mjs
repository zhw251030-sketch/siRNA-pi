import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const testRoot = path.join(root, "runtime", "verification-tests");
fs.mkdirSync(testRoot, { recursive: true });

// 全部是人造记录，不使用密钥、真实运行日志或模型服务。
function fixture(t, sdk = true, web = false) {
  const dir = fs.mkdtempSync(path.join(testRoot, "case-"));
  t.after(() => {
    assert.equal(path.dirname(dir), testRoot);
    fs.rmSync(dir, { recursive: true });
  });
  const stage = sdk ? "sdk-task" : "first-task";
  const taskId = "12345678-1234-4123-8123-123456789abc";
  const workspace = web ? `workspaces/web/${taskId}` : `workspaces/${stage}`;
  const input = web ? `${workspace}/numbers.csv` : "examples/01-file-task/numbers.csv";
  const eventLog = web ? `runtime/web/${taskId}.events.jsonl` : `runtime/${stage}.events.jsonl`;
  for (const relative of ["scripts", "runtime/web", "examples/01-file-task", workspace]) {
    fs.mkdirSync(path.join(dir, relative), { recursive: true });
  }
  fs.copyFileSync(path.join(root, "scripts/verify-first-task.mjs"), path.join(dir, "scripts/verify-first-task.mjs"));
  fs.writeFileSync(path.join(dir, input), "value\n10\n20\n30\n40\n");
  const resultPath = path.join(dir, workspace, "result.json");
  fs.writeFileSync(resultPath, JSON.stringify({ count: 4, sum: 100, mean: 25 }));
  const events = [{ type: "session", cwd: web ? path.join(dir, workspace) : dir, source: web ? "web" : sdk ? "sdk" : "cli" }];
  const calls = [
    ["read", web ? "numbers.csv" : input],
    ["write", web ? "result.json" : `${workspace}/result.json`],
    ["read", web ? "result.json" : `${workspace}/result.json`],
  ];
  for (const [index, [toolName, filePath]] of calls.entries()) {
    events.push({ type: "message_end", message: { role: "assistant", provider: "minimax-cn", model: "MiniMax-M3", stopReason: "toolUse" } });
    events.push({ type: "tool_execution_start", toolName, toolCallId: String(index), args: { path: filePath } });
    events.push({ type: "tool_execution_end", toolName, toolCallId: String(index), isError: false });
  }
  events.push({ type: "message_end", message: { role: "assistant", provider: "minimax-cn", model: "MiniMax-M3", stopReason: "stop" } });
  events.push({ type: "agent_settled", aborted: false });
  return {
    events, resultPath,
    run(args = web ? ["--web", taskId] : sdk ? ["--sdk"] : []) {
      fs.writeFileSync(path.join(dir, eventLog), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
      return spawnSync(process.execPath, [path.join(dir, "scripts/verify-first-task.mjs"), ...args], { encoding: "utf8" });
    },
  };
}

test("SDK 检查读取独立的 SDK 日志和结果，而不依赖旧 CLI 结果", (t) => {
  const run = fixture(t).run();
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).result, { count: 4, sum: 100, mean: 25 });
});

test("原 CLI 练习仍可通过检查", (t) => {
  const run = fixture(t, false).run();
  assert.equal(run.status, 0, run.stderr);
});

for (const [name, change, expected] of [
  ["错误平均值", (f) => fs.writeFileSync(f.resultPath, '{"count":4,"sum":100,"mean":26}'), /独立计算/],
  ["越过练习范围的路径", (f) => { f.events.find((e) => e.type === "tool_execution_start").args.path = "docs/auth.json"; }, /之外的路径/],
  ["缺少完成事件", (f) => { f.events.pop(); }, /agent_settled/],
  ["模型错误结束", (f) => { f.events.at(-2).message.stopReason = "error"; }, /没有正常结束/],
]) {
  test(`SDK 检查拒绝${name}`, (t) => {
    const f = fixture(t);
    change(f);
    const run = f.run();
    assert.equal(run.status, 1);
    assert.match(run.stderr, expected);
  });
}

test("未知练习参数被拒绝，不能误报旧练习成功", (t) => {
  const run = fixture(t, false).run(["--typo"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /参数/);
});

test("网页统计检查按任务编号读取目录和轨迹", (t) => {
  const run = fixture(t, true, true).run();
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).result, { count: 4, sum: 100, mean: 25 });
});

test("网页统计检查拒绝不匹配的任务目录", (t) => {
  const f = fixture(t, true, true);
  f.events[0].cwd = path.dirname(f.events[0].cwd);
  const run = f.run();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /运行目录/);
});
