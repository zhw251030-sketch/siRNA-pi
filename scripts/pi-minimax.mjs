import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const credentialPath = path.join(root, "docs", "auth.json");
const agentDir = path.join(root, "runtime", "pi");
const temporaryDir = path.join(root, "runtime", "tmp");
const cacheDir = path.join(root, "runtime", "cache");
const args = process.argv.slice(2);

// 本阶段只开放显示模式；任务从终端输入或 stdin 传入，避免改写模型、工具和目录参数。
for (let i = 0; i < args.length; i += 1) {
  if (["--version", "--help", "--print"].includes(args[i])) continue;
  if (args[i] === "--mode" && args[i + 1] === "json") {
    i += 1;
    continue;
  }
  console.error("本练习入口只接受 --version、--help、--print、--mode json；任务请从标准输入传入。");
  process.exit(1);
}

try {
  // 当前文件按用户提供的格式保存一行密钥，不把它当作 Pi 的 auth.json。
  if (fs.realpathSync(credentialPath) !== credentialPath) {
    throw new Error("credential path");
  }
  const apiKey = fs.readFileSync(credentialPath, "utf8").trim();
  if (!apiKey.startsWith("sk-") || /\s/.test(apiKey)) {
    throw new Error("credential format");
  }

  for (const dir of [path.join(root, "runtime"), agentDir, temporaryDir, cacheDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(dir) !== dir) throw new Error("runtime path");
  }
  for (const name of ["models.json", "settings.json"]) {
    const destination = path.join(agentDir, name);
    if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
      throw new Error("runtime config path");
    }
    fs.copyFileSync(path.join(root, "config", "pi", name), destination);
  }

  const cli = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  const child = spawn(process.execPath, [
    cli,
    "--provider", "minimax-cn",
    "--model", "MiniMax-M3",
    "--thinking", "off",
    "--tools", "read,write",
    "--no-session", "--no-extensions", "--no-mcp", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    ...args,
  ], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      MINIMAX_CN_API_KEY: apiKey,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      TMPDIR: temporaryDir,
      TMP: temporaryDir,
      TEMP: temporaryDir,
      XDG_CACHE_HOME: cacheDir,
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", () => {
    console.error("Pi 启动失败：请确认 Node 版本和项目依赖已安装。");
    process.exitCode = 1;
  });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} catch {
  // 不打印异常详情，避免把凭据内容带进终端或日志。
  console.error("Pi 配置失败：检查 docs/auth.json 是否为一行有效密钥，以及项目内运行目录和配置文件是否可用。");
  process.exitCode = 1;
}
