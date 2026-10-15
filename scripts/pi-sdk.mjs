import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const agentDir = path.join(root, "runtime", "pi-sdk");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  console.error("本示例只接受 --check；不传参数时执行 SDK 文件任务。");
  process.exit(1);
}

let session;
let unsubscribe;
let eventFile;
try {
  // 1. 先确定项目内的目录，再加载 SDK，避免导入时采用用户主目录默认值。
  process.chdir(root);
  const temporaryDir = path.join(root, "runtime", "tmp");
  const cacheDir = path.join(root, "runtime", "cache");
  for (const dir of [path.join(root, "runtime"), agentDir, temporaryDir, cacheDir, path.join(root, "workspaces"), path.join(root, "workspaces", "sdk-task")]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(dir) !== dir) throw new Error("project directory");
  }
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    TMPDIR: temporaryDir, TMP: temporaryDir, TEMP: temporaryDir, XDG_CACHE_HOME: cacheDir,
  });
  const credentialPath = path.join(root, "docs", "auth.json");
  if (fs.realpathSync(credentialPath) !== credentialPath) throw new Error("credential path");
  const apiKey = fs.readFileSync(credentialPath, "utf8").trim();
  if (!apiKey.startsWith("sk-") || /\s/.test(apiKey)) throw new Error("credential format");
  const settings = JSON.parse(fs.readFileSync(path.join(root, "config", "pi", "settings.json"), "utf8"));

  // 2. 这些函数来自已安装的 Pi SDK；没有重新实现 Agent 循环。
  const { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(root, "config", "pi", "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey("minimax-cn", apiKey); // 仅在内存中覆盖，不保存密钥。
  const model = modelRuntime.getModel("minimax-cn", "MiniMax-M3");
  if (!model || modelRuntime.getError()) throw new Error("model configuration");
  const settingsManager = SettingsManager.inMemory({
    ...settings,
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    compaction: { enabled: false }, cacheWarming: "off",
    enableInstallTelemetry: false, enableAnalytics: false,
  });

  // 空资源加载器：不搜索项目外的扩展、技能、提示模板或 AGENTS.md。
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  ({ session } = await createAgentSession({
    cwd: root, agentDir, model, modelRuntime, settingsManager, resourceLoader,
    thinkingLevel: "off", tools: ["read", "write"],
    sessionManager: SessionManager.inMemory(root),
  }));

  if (args[0] === "--check") {
    console.log(JSON.stringify({ ready: true, cwd: root, agentDir, provider: session.model.provider,
      model: session.model.id, baseUrl: session.model.baseUrl, tools: session.getActiveToolNames(),
      modelCalled: false, sessionPersisted: false }, null, 2));
  } else {
    // 3. 先订阅，再提交任务；首行元数据由本脚本写入，其余为 SDK 原始事件。
    const eventPath = path.join(root, "runtime", "sdk-task.events.jsonl");
    const resultPath = path.join(root, "workspaces", "sdk-task", "result.json");
    for (const file of [eventPath, resultPath]) {
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("output path");
    }
    const prompt = fs.readFileSync(path.join(root, "examples", "02-sdk-task", "prompt.txt"), "utf8");
    eventFile = fs.openSync(eventPath, "w", 0o600);
    const record = (event) => fs.writeSync(eventFile, JSON.stringify(event).replaceAll(apiKey, "[REDACTED]") + "\n");
    record({ type: "session", source: "sdk", cwd: root, sessionId: session.sessionId });
    let settled;
    unsubscribe = session.subscribe((event) => {
      record(event);
      if (event.type === "agent_settled") settled = event;
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      } else if (event.type === "tool_execution_start") {
        console.log(`\n[工具开始] ${event.toolName}: ${event.args.path}`);
      } else if (event.type === "tool_execution_end") {
        console.log(`[工具结束] ${event.toolName}: ${event.isError ? "失败" : "成功"}`);
      }
    });
    await session.prompt(prompt);
    const messages = session.messages.filter((message) => message.role === "assistant");
    if (settled?.aborted !== false || session.state.errorMessage || messages.at(-1)?.stopReason !== "stop" ||
        messages.some((message) => !["toolUse", "stop"].includes(message.stopReason))) {
      throw new Error("incomplete run");
    }
    console.log("\n[会话完成] 请运行 npm run verify:sdk-task，独立检查工具轨迹和结果。");
  }
} catch {
  // 原始异常可能包含服务商响应或凭据，不直接打印。
  console.error("SDK 示例未完成：请检查项目配置、网络和 runtime/sdk-task.events.jsonl（若已生成）。");
  process.exitCode = 1;
} finally {
  // 4. 无论任务成功还是报错，都撤销监听并释放会话。
  unsubscribe?.();
  session?.dispose();
  if (eventFile !== undefined) fs.closeSync(eventFile);
}
