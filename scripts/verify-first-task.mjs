import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const inputPath = path.join(root, "examples", "01-file-task", "numbers.csv");
const outputPath = path.join(root, "workspaces", "first-task", "result.json");
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

try {
  const events = fs.readFileSync(path.join(root, "runtime", "first-task.events.jsonl"), "utf8")
    .split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const header = events.find((event) => event.type === "session");
  ensure(header?.cwd === path.resolve(root), "运行目录与本项目不一致。");
  const settled = events.findLast((event) => event.type === "agent_settled");
  ensure(settled?.aborted === false, "没有正常完成的 agent_settled 事件。");
  const messages = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .map((event) => event.message);
  ensure(messages.length > 0 && messages.every((message) => message.provider === "minimax-cn" && message.model === "MiniMax-M3"), "模型或服务商与本练习不一致。");
  ensure(messages.at(-1)?.stopReason === "stop", "模型没有正常结束任务。");
  ensure(messages.every((message) => ["toolUse", "stop"].includes(message.stopReason)), "模型出现错误、中止或输出截断。");

  const starts = events.filter((event) => event.type === "tool_execution_start");
  const ends = events.filter((event) => event.type === "tool_execution_end");
  ensure(starts.length > 0 && starts.length === ends.length, "工具调用缺少开始或结束记录。");
  const allowedPaths = new Set([inputPath, outputPath]);
  for (const start of starts) {
    ensure(["read", "write"].includes(start.toolName), "出现本练习之外的工具。");
    ensure(typeof start.args?.path === "string" && allowedPaths.has(path.resolve(root, start.args.path)), "工具访问了样例和结果之外的路径。");
    ensure(start.toolName !== "write" || path.resolve(root, start.args.path) === outputPath, "工具修改了输入文件。");
    const matches = ends.filter((end) => end.toolCallId === start.toolCallId);
    ensure(matches.length === 1 && matches[0].toolName === start.toolName && matches[0].isError === false, "工具调用失败或结束记录不匹配。");
  }
  const inputRead = starts.findIndex((event) => event.toolName === "read" && path.resolve(root, event.args.path) === inputPath);
  const outputWrite = starts.findIndex((event) => event.toolName === "write" && path.resolve(root, event.args.path) === outputPath);
  const outputRead = starts.findIndex((event, index) => index > outputWrite && event.toolName === "read" && path.resolve(root, event.args.path) === outputPath);
  ensure(inputRead >= 0 && outputWrite > inputRead && outputRead > outputWrite, "缺少读取输入、写入结果、重新读取结果的完整顺序。");

  const lines = fs.readFileSync(inputPath, "utf8").trim().split(/\r?\n/);
  ensure(lines.shift() === "value", "样例 CSV 表头不正确。");
  const values = lines.map(Number);
  ensure(values.length > 0 && values.every(Number.isFinite), "样例包含无效数值。");
  const expected = { count: values.length, sum: values.reduce((sum, value) => sum + value, 0) };
  expected.mean = expected.sum / expected.count;
  const result = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  ensure(result !== null && typeof result === "object" && Object.keys(result).sort().join(",") === "count,mean,sum", "结果 JSON 字段不正确。");
  ensure(Object.entries(expected).every(([key, value]) => result[key] === value), "结果与独立计算不一致。");

  console.log(JSON.stringify({ verified: true, result, modelResponses: messages.length, toolCalls: starts.length, totalTokens: messages.reduce((sum, message) => sum + (message.usage?.totalTokens ?? 0), 0) }, null, 2));
} catch (error) {
  // JSON 解析异常可能带有原始日志片段；只输出我们自己定义的检查信息。
  const message = error?.code || error instanceof SyntaxError ? "无法读取或解析运行记录，请先完成练习。" : error.message;
  console.error(`验证失败：${message}`);
  process.exitCode = 1;
}
