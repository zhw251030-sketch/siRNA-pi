import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projectRoot, ensureProjectDirectory, runPiTask } from "./pi-session.mjs";

export async function runWebTask(message) {
  const taskId = randomUUID();
  const workspace = `workspaces/web/${taskId}`;
  const eventLog = `runtime/web/${taskId}.events.jsonl`;
  const cwd = path.join(projectRoot, workspace);
  ensureProjectDirectory(cwd);
  ensureProjectDirectory(path.join(projectRoot, "runtime", "web"));
  fs.copyFileSync(path.join(projectRoot, "examples", "01-file-task", "numbers.csv"), path.join(cwd, "numbers.csv"), fs.constants.COPYFILE_EXCL);
  const prompt = "这是一个独立的练习任务。当前目录已提供 numbers.csv。你只能用 read/write 读写当前任务目录内的普通文本文件；路径请使用相对路径。不要尝试读取凭据或项目源代码。\n\n用户任务：\n" + message;
  const result = await runPiTask({
    prompt, cwd, agentName: "pi-web", source: "web", scopedFiles: true,
    eventPath: path.join(projectRoot, eventLog), timeoutMs: 180000, maxResponses: 12,
  });
  return { taskId, ...result, workspace, eventLog };
}
