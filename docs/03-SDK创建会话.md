# 第 2 步：调用 Pi SDK 创建会话

日期：2026-10-15。本步骤已在指定服务器完成真实 SDK 任务，并通过独立检查。

## 先弄清我们写了什么

Pi 已经有 SDK，包含在现有依赖 `@earendil-works/pi-coding-agent@1.2.0` 中。本次没有新增依赖，也没有重新开发 SDK。我们写的是调用这个 SDK 的应用程序。

上一阶段的 `scripts/pi-minimax.mjs` 用 `spawn(...)` 启动 Pi 命令行程序；新文件 `scripts/pi-sdk.mjs` 在自己的 Node.js 进程里导入 Pi 函数，直接获得一个会话对象。两种方式都能控制 Pi，SDK 是本项目选定的下一步学习方式。

Pi 仍负责模型通信、消息状态、工具执行和 Agent 循环。我们负责选择模型与工具、提供任务、接收事件、保存记录和释放会话。

## 本次文件变化

以下路径相对于唯一远端项目根目录 `/home/hanwen/Project/project/siNRA-pi/`。

| 文件 | 职责 |
| --- | --- |
| `scripts/pi-sdk.mjs` | 新增的 SDK 示例，串起配置、会话、事件和任务 |
| `examples/02-sdk-task/prompt.txt` | 新任务指令；仍读取第一个练习的四个数，写到单独的 SDK 结果位置 |
| `scripts/verify-first-task.mjs` | 复用原检查器；增加 `--sdk` 选择 SDK 日志与结果 |
| `tests/verify-file-task.test.mjs` | 用人造文件与事件检查验收程序，完全不调用模型 |
| `package.json` | 新增 `pi:sdk`、`verify:sdk-task`、`test` 命令 |
| 本文、README、AGENTS、学习路线 | 保存解释、约束和已验证进度 |

运行时另有以下内容，均在项目内且不进入 Git：

| 路径 | 内容 |
| --- | --- |
| `docs/auth.json` | 原有的一行 MiniMax 密钥，保持原位 |
| `runtime/pi-sdk/` | SDK 的运行配置状态位置；与 CLI 的 `runtime/pi/` 分开 |
| `runtime/sdk-task.events.jsonl` | SDK 任务的结构化执行记录 |
| `runtime/sdk-task.console.log` | 本次测试重定向保存的终端文字和工具状态 |
| `runtime/sdk-task.stderr.log` | 本次测试的错误输出，实际为空 |
| `workspaces/sdk-task/result.json` | SDK 任务生成的结果 |

`docs/auth.json` 是我们读取的原始文本文件；`runtime/pi-sdk/auth.json` 是 SDK 自己使用的凭据存储位置，两者不是同一个文件。SDK 可能创建后者的空 JSON 结构，但本例用内存覆盖传入 Key，不将 Key 保存到后者。

## 1. 先准备目录和凭据

脚本根据自身所在位置确定项目根目录，再设置当前工作目录、Pi 状态目录和临时目录。环境变量在动态导入 SDK 之前设置，避免导入阶段先采用用户主目录默认位置。

```js
process.chdir(root);
process.env.PI_CODING_AGENT_DIR = agentDir;
```

`root` 对应整个项目；`agentDir` 对应其中的 `runtime/pi-sdk/`。脚本还设置 `TMPDIR`、`TMP`、`TEMP`、`XDG_CACHE_HOME`，位置都在项目内。

密钥只从 `docs/auth.json` 读入当前进程内存，不输出到终端。对外报告启动错误时不打印完整异常对象，以免异常对象携带认证信息。

## 2. 导入 Pi 已经实现的接口

```js
const {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
```

这里的 `import` 是使用已经安装的程序功能，并不重新下载 Pi。

| 接口 | 本次用途 |
| --- | --- |
| `ModelRuntime` | 根据模型配置取得 MiniMax-M3，并安排凭据使用 |
| `SettingsManager` | 提供本次运行设置 |
| `SessionManager` | 决定会话消息如何保存；本次只保存在内存 |
| `createExtensionRuntime` | 为不加载扩展的资源对象提供 SDK 要求的运行结构 |
| `createAgentSession` | 把模型、工具、目录、设置组合成一个会话 |

`modelRuntime.setRuntimeApiKey("minimax-cn", apiKey)` 是 Pi 的现成接口，作用是内存中的凭据覆盖。`modelsPath` 指向现有 `config/pi/models.json`，因此沿用国内接口和每次输出上限；模型缓存位置另外明确放在 `runtime/pi-sdk/`。

这次关闭自动模型目录联网更新、自动重试、自动压缩、缓存预热和遥测。`PI_OFFLINE=1` 不代表模型离线部署；明确提交的任务仍会调用 MiniMax 网络服务。

## 3. 创建一个会话

核心配置如下，完整代码还包括前面的对象准备：

```js
({ session } = await createAgentSession({
  cwd: root,
  agentDir,
  model,
  modelRuntime,
  settingsManager,
  resourceLoader,
  thinkingLevel: "off",
  tools: ["read", "write"],
  sessionManager: SessionManager.inMemory(root),
}));
```

`session` 可以理解为“这一段对话及其运行状态”。它知道使用哪个模型、允许调用哪些工具，也维护本次对话中的消息。

`SessionManager.inMemory(root)` 表示本次对话状态仅在内存中。我们另外保存的事件日志用于检查执行过程，并没有在本步骤实现从该日志恢复对话的功能。

这里使用空 `resourceLoader`，主动提供空的扩展、技能、模板、主题和上下文文件列表。原因是默认资源加载器即使关闭部分功能，仍会先搜索目录。明确提供空资源可以使这次练习只使用指定内容；Pi 自己的默认系统提示仍由 SDK 构造。

## 4. 在提交任务前订阅事件

```js
unsubscribe = session.subscribe((event) => {
  record(event);
  // 根据事件类型显示文字、工具开始或工具结束。
});
```

“订阅”可以理解成告诉 Pi：“执行期间发生这些事情，就通知我的程序。”

- `message_update` 的 `text_delta`：有一段新的回答文字，立即显示。
- `tool_execution_start`：一个工具开始执行，显示工具名与路径。
- `tool_execution_end`：工具执行结束，显示成功或失败。
- `agent_settled`：本轮 Agent 已稳定结束，用于检查是否中止。

先订阅、再发任务，才能收到从任务开始时产生的事件。事件处理函数是观察与显示代码，真正执行 read/write 的仍是 Pi。

日志第一行的 `session` 元数据由我们的脚本写入，包含工作目录、会话 ID 和 `source: "sdk"`；后面的事件来自 SDK 订阅。写入日志前会替换可能出现的完整 Key 字符串。本次另外核对运行日志和 SDK 凭据文件，未发现原始 Key。

## 5. 提交任务，并等待完成

```js
const prompt = fs.readFileSync(promptPath, "utf8");
await session.prompt(prompt);
```

上面是说明调用关系的简化片段，实际文件内直接拼接提示文件路径。`prompt` 是读取到的中文任务要求；`await` 表示等待本次执行完成，再继续检查。

新的任务仍要求读取 `examples/01-file-task/numbers.csv`，但结果写到 `workspaces/sdk-task/result.json`，保留原 CLI 练习的结果。

本次实际发生：

1. 模型要求 read 读取四个数字，Pi 执行读取。
2. 模型给出统计结果并要求 write，Pi 写入 SDK 结果文件。
3. 模型要求 read 重新读取结果，Pi 执行读取。
4. 模型给出最终回答。

脚本在 `prompt` 返回后还检查正常结束事件和模型结束原因，模型错误或中止不能仅凭函数返回就被报告为成功。文件结果则交给独立检查器验收。

## 6. 无论成功还是失败，都释放资源

```js
finally {
  unsubscribe?.();
  session?.dispose();
  if (eventFile !== undefined) fs.closeSync(eventFile);
}
```

`finally` 表示无论前面正常完成还是抛出异常，都执行收尾。这里取消事件订阅、释放会话并关闭日志文件。当前示例是一个任务执行完就退出；多轮会话复用、历史恢复和网页停止按钮尚未实现。

## 怎样运行

登录服务器，选用已安装的 Node 24：

```bash
cd /home/hanwen/Project/project/siNRA-pi
source /home/hanwen/.nvm/nvm.sh
nvm use
```

只检查能否创建 SDK 会话，不提交任务、不调用模型：

```bash
npm run pi:sdk -- --check
```

它显示模型、接口、目录和工具。此检查本身不证明 API Key 在服务端有效；真实任务另行验证网络与认证。

执行实际任务，终端会实时显示文字和工具状态，并生成 SDK 事件日志：

```bash
timeout --kill-after=10s 180s npm run pi:sdk
```

这会再次调用模型，并替换该练习的 SDK 日志与结果。外层 180 秒超时限制整个进程；不是每次模型响应的 token 上限，也不是网页停止功能。

只验证现有结果、或运行不调用模型的自动检查：

```bash
npm run verify:sdk-task
npm run verify:first-task
npm test
```

## 本次实际证据

- SDK 配置检查成功：MiniMax-M3，国内接口，仅 read/write，项目内运行目录。
- 一次真实 SDK 任务成功退出；共 85 行事件记录（含本程序写的首行），4 次模型响应、3 次成功工具调用。
- 结果为 `{"count":4,"sum":100,"mean":25}`，离线检查通过。
- `usage.totalTokens` 累计 5778；这是事件统计值，不是账单金额，也不能据此比较两种入口的性能。
- 模型结束原因依次为 `toolUse`、`toolUse`、`toolUse`、`stop`。
- 原 CLI 任务的日志和结果在本次运行前后 SHA-256 完全一致，原检查仍通过。
- 7 项离线行为测试通过：SDK 独立路径、CLI 兼容、错误均值、越界路径、缺少完成事件、模型错误结束、未知参数。
- 新增 SDK 检查能力之前，相应测试确实失败；增加路径选择后通过。
- 错误输出为空；核查的 SDK 日志和 SDK 凭据文件没有原始 Key；未生成会话持久化目录。

以上是一次固定练习的证据，不表示任意任务都可靠。目录设置和工具白名单不是操作系统级沙箱；本次使用可信练习并核对所有实际工具路径。自动检查中的错误路径案例使用人造记录，不读取真实密钥。

## 与参考项目的关系及下一步

参考仓库 `packages/agent-runtime/chat.ts` 使用相同的职责划分：创建会话、订阅事件、调用 prompt。它是保留的 SDK 路径，不是当前默认 Agent Compose 路径。本次没有复制其业务工具、会话池或网页代码。

下一步在理解本示例后，再设计最小网页和后端，让网页输入能够调用这层 Pi 能力，并接收回答。会话复用、持久化和停止分别安排后续验收。

接口依据与参考示例：[Pi 1.2.0 SDK](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/sdk.md)、[完整配置示例](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/examples/sdk/12-full-control.ts)、[凭据覆盖实现](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/runtime-credentials.ts)。实现使用安装版本的公开接口，并核对对应代码与声明。
