import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projectRoot, ensureProjectDirectory, runPiTask } from "./pi-sdk.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function projectPiEvent(event) {
  if (event.type === "tool_execution_start") {
    return { type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
  }
  if (event.type === "tool_execution_end") {
    return { type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError };
  }
  // 对齐正式运行时：工具步骤中的说明是 progress_message，最终答案单独发布。
  if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "toolUse") {
    const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    if (text) return { type: "progress_message", text };
  }
}

export class LocalPiRuntime {
  constructor() { this.active = new Set(); }

  runtimeInfo() {
    return { backend: "local-pi", structuredToolEvents: true, reasoningExposed: false, taskContainers: false };
  }

  file(id) {
    if (!uuid.test(id)) throw new Error("执行会话编号无效。");
    const directory = path.join(projectRoot, "runtime", "task-sessions");
    ensureProjectDirectory(directory);
    return path.join(directory, `${id}.json`);
  }

  save(session) {
    const file = this.file(session.id);
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(session, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  }

  async status(id) {
    const file = this.file(id);
    if (fs.realpathSync(file) !== file) throw new Error("执行会话记录路径无效。");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  async create() {
    const id = randomUUID();
    const cwd = path.join(projectRoot, "workspaces", "web", id);
    ensureProjectDirectory(cwd);
    ensureProjectDirectory(path.join(projectRoot, "runtime", "web"));
    fs.copyFileSync(path.join(projectRoot, "examples", "01-file-task", "numbers.csv"), path.join(cwd, "numbers.csv"), fs.constants.COPYFILE_EXCL);
    const session = { id, status: "idle", runs: [] };
    this.save(session);
    return session;
  }

  async run(request, emit) {
    const session = await this.status(request.sessionId);
    if (this.active.has(session.id)) throw new Error("此执行会话正在运行。");
    this.active.add(session.id);
    const runId = randomUUID();
    const run = { runId, status: "running", startedAt: new Date().toISOString(), outputCharacters: 0 };
    session.runs.push(run);
    session.status = "running";
    session.currentRunId = runId;
    try {
      // Never silently forget a completed conversation if its session file
      // disappeared. A failed first attempt can still have an unflushed file.
      if (session.runs.some((previous) => previous.status === "succeeded") &&
          (!session.sessionFile || !fs.existsSync(session.sessionFile))) throw new Error("Saved Pi conversation is missing");
      this.save(session);
      const result = await runPiTask({
        prompt: "当前任务目录提供 numbers.csv。只能用 read/write 读写本任务目录内的普通文本文件，使用相对路径。\n\n用户消息：\n" + request.message,
        cwd: path.join(projectRoot, "workspaces", "web", session.id),
        agentName: "pi-web", source: "web", scopedFiles: true, persistSession: true,
        sessionFile: session.sessionFile,
        eventPath: path.join(projectRoot, "runtime", "web", `${session.id}.${runId}.events.jsonl`),
        onSession: ({ sessionId, sessionFile }) => {
          session.piSessionId = sessionId;
          session.sessionFile = sessionFile;
          this.save(session);
          emit({ type: "session", sessionId: session.id, piSessionId: sessionId, mode: "model", backend: "local-pi", runId });
          emit({ type: "run_status", sessionId: session.id, backend: "local-pi", runId, status: "running" });
        },
        onEvent: (event) => { const projected = projectPiEvent(event); if (projected) emit(projected); },
      });
      Object.assign(run, { status: "succeeded", completedAt: new Date().toISOString(), outputCharacters: result.answer.length });
      session.status = "idle";
      this.save(session);
      emit({ type: "assistant_message", text: result.answer });
      emit({ type: "run_status", sessionId: session.id, backend: "local-pi", runId, status: "succeeded" });
      emit({ type: "done", status: "succeeded", runId });
    } catch {
      Object.assign(run, { status: "failed", completedAt: new Date().toISOString() });
      session.status = "failed";
      this.save(session);
      emit({ type: "error", error: "本轮执行未完成，请检查项目配置、网络与项目内运行记录。" });
      emit({ type: "done", status: "failed", runId });
    } finally { this.active.delete(session.id); }
  }
}
