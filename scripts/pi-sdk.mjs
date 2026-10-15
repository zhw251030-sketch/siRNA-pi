import fs from "node:fs";
import path from "node:path";
import { projectRoot, ensureProjectDirectory, createLearningSession, runPiTask } from "../packages/agent-runtime/pi-sdk.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  console.error("本示例只接受 --check；不传参数时执行 SDK 文件任务。");
  process.exit(1);
}

try {
  process.chdir(projectRoot);
  ensureProjectDirectory(path.join(projectRoot, "workspaces", "sdk-task"));
  if (args[0] === "--check") {
    const { session, agentDir } = await createLearningSession();
    try {
      console.log(JSON.stringify({ ready: true, cwd: projectRoot, agentDir, provider: session.model.provider,
        model: session.model.id, baseUrl: session.model.baseUrl, tools: session.getActiveToolNames(),
        modelCalled: false, sessionPersisted: false }, null, 2));
    } finally { session.dispose(); }
  } else {
    const resultPath = path.join(projectRoot, "workspaces", "sdk-task", "result.json");
    if (fs.existsSync(resultPath) && fs.lstatSync(resultPath).isSymbolicLink()) throw new Error("output path");
    await runPiTask({
      prompt: fs.readFileSync(path.join(projectRoot, "examples", "02-sdk-task", "prompt.txt"), "utf8"),
      eventPath: path.join(projectRoot, "runtime", "sdk-task.events.jsonl"),
      onEvent(event) {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta);
        } else if (event.type === "tool_execution_start") {
          console.log(`\n[工具开始] ${event.toolName}: ${event.args.path}`);
        } else if (event.type === "tool_execution_end") {
          console.log(`[工具结束] ${event.toolName}: ${event.isError ? "失败" : "成功"}`);
        }
      },
    });
    console.log("\n[会话完成] 请运行 npm run verify:sdk-task，独立检查工具轨迹和结果。");
  }
} catch {
  console.error("SDK 示例未完成：请检查项目配置、网络和 runtime/sdk-task.events.jsonl（若已生成）。");
  process.exitCode = 1;
}
