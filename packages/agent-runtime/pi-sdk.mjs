import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspaceOperations } from "./workspace-files.mjs";

export const projectRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

export function ensureProjectDirectory(directory) {
  const relative = path.relative(projectRoot, directory);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("project directory");
  // 逐级创建之前先检查已有父级，避免沿符号链接在项目外新建目录。
  let current = projectRoot;
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    if (fs.realpathSync(current) !== current || !fs.statSync(current).isDirectory()) throw new Error("project directory");
  }
}

export async function createLearningSession({ cwd = projectRoot, agentName = "pi-sdk", scopedFiles = false,
  persistSession = false, sessionFile } = {}) {
  const agentDir = path.join(projectRoot, "runtime", agentName);
  const temporaryDir = path.join(projectRoot, "runtime", "tmp");
  const cacheDir = path.join(projectRoot, "runtime", "cache");
  for (const directory of [agentDir, temporaryDir, cacheDir, cwd]) ensureProjectDirectory(directory);
  // 必须先设置项目内目录，再动态导入 SDK。
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    TMPDIR: temporaryDir, TMP: temporaryDir, TEMP: temporaryDir, XDG_CACHE_HOME: cacheDir,
  });
  const credentialPath = path.join(projectRoot, "docs", "auth.json");
  if (fs.realpathSync(credentialPath) !== credentialPath) throw new Error("credential path");
  const apiKey = fs.readFileSync(credentialPath, "utf8").trim();
  if (!apiKey.startsWith("sk-") || /\s/.test(apiKey)) throw new Error("credential format");
  const settings = JSON.parse(fs.readFileSync(path.join(projectRoot, "config", "pi", "settings.json"), "utf8"));
  const { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
    createReadToolDefinition, createWriteToolDefinition } = await import("@earendil-works/pi-coding-agent");
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(projectRoot, "config", "pi", "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey("minimax-cn", apiKey);
  const model = modelRuntime.getModel("minimax-cn", "MiniMax-M3");
  if (!model || modelRuntime.getError()) throw new Error("model configuration");
  const settingsManager = SettingsManager.inMemory({
    ...settings,
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    compaction: { enabled: false }, cacheWarming: "off",
    enableInstallTelemetry: false, enableAnalytics: false,
  });
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
  let customTools;
  if (scopedFiles) {
    const operations = createWorkspaceOperations(cwd);
    // Pi 仍提供参数结构与工具行为；仅替换底层文件操作以落实目录范围。
    customTools = [
      createReadToolDefinition(cwd, { operations: operations.read }),
      createWriteToolDefinition(cwd, { operations: operations.write }),
    ];
  }
  let sessionManager = SessionManager.inMemory(cwd);
  if (persistSession) {
    const sessionDir = path.join(agentDir, "sessions");
    ensureProjectDirectory(sessionDir);
    if (sessionFile) {
      if (path.dirname(sessionFile) !== sessionDir || (fs.existsSync(sessionFile) && fs.realpathSync(sessionFile) !== sessionFile)) {
        throw new Error("session file path");
      }
      // 没有发过消息的空会话不会落盘；第一轮开始前允许创建。
      sessionManager = fs.existsSync(sessionFile) ? SessionManager.open(sessionFile, sessionDir, cwd) : SessionManager.create(cwd, sessionDir);
    } else sessionManager = SessionManager.create(cwd, sessionDir);
  }
  const { session } = await createAgentSession({
    cwd, agentDir, model, modelRuntime, settingsManager, resourceLoader,
    thinkingLevel: "off", tools: ["read", "write"], customTools,
    sessionManager,
  });
  return { session, agentDir, redact: (text) => text.replaceAll(apiKey, "[REDACTED]") };
}

export async function runPiTask({ prompt, cwd = projectRoot, agentName = "pi-sdk", eventPath,
  source = "sdk", scopedFiles = false, onEvent = () => {}, timeoutMs = 180000, maxResponses = 12,
  persistSession = false, sessionFile, onSession = () => {} }) {
  let session, unsubscribe, eventFile, timer;
  try {
    const created = await createLearningSession({ cwd, agentName, scopedFiles, persistSession, sessionFile });
    session = created.session;
    const initialMessageCount = session.messages.length;
    onSession({ sessionId: session.sessionId, sessionFile: session.sessionManager.getSessionFile() });
    if (fs.existsSync(eventPath) && fs.lstatSync(eventPath).isSymbolicLink()) throw new Error("event path");
    eventFile = fs.openSync(eventPath, source === "web" ? "wx" : "w", 0o600);
    const record = (event) => fs.writeSync(eventFile, created.redact(JSON.stringify(event)) + "\n");
    record({ type: "session", source, cwd, sessionId: session.sessionId });
    let settled, limitReached = false, modelResponses = 0, toolCalls = 0;
    const stop = (reason) => {
      if (limitReached) return;
      limitReached = true;
      record({ type: "application_limit", reason });
      void session.abort().catch(() => {});
    };
    unsubscribe = session.subscribe((event) => {
      record(event);
      if (event.type === "agent_settled") settled = event;
      if (event.type === "tool_execution_end") toolCalls++;
      if (event.type === "message_end" && event.message.role === "assistant") {
        modelResponses++;
        if (modelResponses >= maxResponses && event.message.stopReason === "toolUse") stop("model_response_limit");
      }
      onEvent(JSON.parse(created.redact(JSON.stringify(event))));
    });
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    await session.prompt(prompt);
    const messages = session.messages.slice(initialMessageCount).filter((message) => message.role === "assistant");
    if (limitReached || settled?.aborted !== false || session.state.errorMessage || messages.at(-1)?.stopReason !== "stop" ||
        messages.some((message) => !["toolUse", "stop"].includes(message.stopReason))) throw new Error("incomplete run");
    const answer = messages.at(-1).content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (!answer.trim()) throw new Error("empty answer");
    return { answer: created.redact(answer), modelResponses, toolCalls };
  } finally {
    clearTimeout(timer);
    unsubscribe?.();
    session?.dispose();
    if (eventFile !== undefined) fs.closeSync(eventFile);
  }
}
