# 第 5 步 D：让网页通过 Agent Compose 操作容器中的 Pi

完成日期：2026-10-20（北京时间；服务器记录使用 UTC，因此目录日期为 2026/10/19）。

## 这次究竟增加了什么

上一轮我们证明了：在终端发出命令，Agent Compose 能创建容器，容器里的 Pi 1.2.0 能调用 MiniMax-M3、读写文件并继续对话。但是网页仍然直接调用宿主机上的 Pi SDK。两条路线各自可用，还没有接在一起。

现在，新建网页任务已经采用下面这条路线：

```text
浏览器 public/app.js
  ↓ HTTP：创建任务、发送消息
apps/api/router.mjs
  ↓ 任务状态、消息保存、去重
packages/task-core/task-message-service.mjs
  ↓ 统一的 create/run/status 接口
RuntimeRouter → AgentComposeRuntime
  ↓ 正式 AttachAgentRun 双向 RPC
Agent Compose 控制服务（服务器本地 7410）
  ↓ 在本任务 guest 中启动 Pi
Pi 1.2.0 → 模型转接 → MiniMax-M3
  ↕ read/write
本任务 /workspace
```

执行中的说明和工具结果沿着反方向回来，最后由 HTTP 服务用 SSE 持续发送给浏览器。SSE 可以理解为“一个不断收到新消息的下载连接”。RPC 则是“网页后端调用另一个程序提供的函数”；本项目使用正式的 gRPC 协议。

网页地址仍是 `http://127.0.0.1:3000/`，经原有 SSH 隧道连接服务器。模型和容器没有搬到本机浏览器中；浏览器只负责输入和显示。服务器唯一项目目录仍是 `/home/hanwen/Project/project/siNRA-pi`。

## 对照原仓库理解

参考应用基准为 `965c53fba4eaa23996f54aa0532c7f6e1064bfd8`，含阅读记录的参考提交为 `67d275494c50f1e5c205b96b72a7b1623acfbe1d`。

| 职责 | 参考仓库 | 本次学习实现 |
| --- | --- | --- |
| 把各层组合成服务 | `apps/api/bootstrap.ts` | `apps/api/bootstrap.mjs` |
| 管任务、消息和历史 | `packages/task-core/task-message-service.ts`、`task-store.ts` | 保留现有 Task Core，调整重启提示 |
| 为任务准备独立环境 | `packages/agent-runtime/executor.ts` | `compose-executor.mjs` |
| 把网页任务变成容器运行 | `packages/agent-runtime/agent-compose-runtime.ts` | `agent-compose-runtime.mjs`、`compose-session-store.mjs` |
| 双向调用正式执行平台 | `packages/agent-runtime/rpc.ts` | `agent-compose-rpc.mjs` |
| 将执行事件变成网页事件 | `agent-compose-runtime.ts` 中的事件处理 | 独立拆为 `compose-events.mjs` |
| 显示历史、工具和目录 | `public/app.js` | 在既有页面上使用真实执行目录 |

参考仓库的运行时接口还有停止、删除、会话分支、修订等能力。本轮只实现当前学习需要的任务创建、执行、状态和目录描述，不能称为已经完整复刻全部接口。个人 Git 仓库仍只有 main；这里的“会话分支”是未来的对话功能，和 Git 分支无关。

协议文件来自 Agent Compose 官方固定版本 v2609.3.0，保留完整原文、上游 AGPL-3.0 许可证及来源说明，见 `proto/README.md`。应用适配代码独立编写，没有整仓复制参考应用。

## 按一次真实操作逐步读代码

### 1. 服务启动时，选定谁执行任务

打开 `apps/api/bootstrap.mjs`。以前组合服务时使用 `new LocalPiRuntime()`；现在创建以下对象：

```js
const rpc = new AgentComposeRpcClient({ token: readComposeControlToken(projectRoot) });
const compose = new AgentComposeRuntime({ root: projectRoot, executor: createComposeExecutor(projectRoot), rpc });
const agentRuntime = new RuntimeRouter({ compose, legacy: new LocalPiRuntime() });
```

这三行不是在“创建新的大模型”。它们是在连接已有组件：RPC 客户端负责通话，Compose 运行时负责组织一次任务，路由器决定一条历史任务该交给谁。

`compose-control-token.mjs` 只读取项目内 `runtime/agent-compose/control.env` 的管理令牌，检查格式、文件类型、链接及 Linux 上的所属用户/0600 权限。它不读取模型 key。管理令牌用于证明“我是有权让 Agent Compose 启动任务的网页后端”；MiniMax key 用于向模型服务请求回答，两者用途不同。

### 2. 点击“新建设计任务”，先建记录

`public/app.js` 仍先请求 `POST /v1/tasks`，`apps/api/router.mjs` 将请求交给 Task Core。`RuntimeRouter.create()` 一律选择 Compose。

`AgentComposeRuntime.create()` 生成执行会话编号，保存 idle 状态及空的 runs 数组，此时没有启动容器、没有调用模型。这样，“建立一个任务”和“花费模型额度执行任务”仍是两个明确动作，与参考项目一致。

### 3. 第一次发送消息，才准备任务容器

在 `agent-compose-runtime.mjs` 中先读 `ensureWorkspace()` 和 `prepare()`。它们调用 `compose-executor.mjs`：

1. 用官方 CLI `up` 获取项目登记信息。
2. 提交一个固定的无模型初始化命令，创建 `input`、`work`、`output`、`tool-drafts` 目录。
3. 保存初始化 runId，等待成功，取得 sandboxId。
4. 从 `inspect sandbox` 返回值读取真实 workspace_path，再映射到服务器项目目录。
5. 只在首次初始化时写入统计样例 `input/numbers.csv`。

用户文字不会拼进 shell 命令；初始化命令固定，真正的任务要求通过后面的 RPC 字段传递。

`compose-session-store.mjs` 检查 sandboxId、目录格式和真实路径，防止错误记录把文件位置指向项目外。若进程刚写好样例就退出、尚未保存“准备完成”，重试只接受已有且内容相同的样例，不覆盖不同内容。

目录来自控制服务，不手工猜日期。真实对应关系是：

```text
容器中：/workspace/input/numbers.csv
服务器：项目根/runtime/agent-compose/data/sandboxes/日期/sandboxId/workspace/input/numbers.csv
```

这不是模型把文件“上传回来”；同一任务目录通过挂载让两边看到。

### 4. 调用正式 RPC，让 Pi 开始做事

在 `agent-compose-rpc.mjs` 读 `run()`。请求包括 projectId、designer、sandboxId 和 prompt。它按官方协议发 `start`，并监听：

```text
started              控制服务已接收，得到本轮真实 runId
agentEvent           模型步骤、过程文字、工具调用和结果
agentTurnCompleted   Pi 的这一轮对话结束
stdinEof             后端明确告诉执行端：本轮没有更多输入
result               执行端给出最终运行结果
```

仅关闭请求写入端不等于发 EOF；官方 DETACH 模式下必须显式发送 `stdinEof`，才能可靠收尾。回调按收到顺序等待，避免工具完成比工具开始先进入数据库。

这次增加 `@grpc/grpc-js` 和 `@grpc/proto-loader` 依赖，用官方 proto 定义与控制服务交流。没有重新实现 Pi 的模型循环，也没有为此重建 guest 镜像；继续使用上一轮已经验证的 Pi 1.2.0 镜像。

### 5. 将底层事件翻译成网页能显示的事件

`compose-events.mjs` 的 `createComposeEventProjector()` 接收底层事件，输出现有 Task Core 合同中的事件：

| 底层信息 | 网页收到的内容 |
| --- | --- |
| 工具步骤中的公开说明 | `progress_message` |
| `tool_call` | `tool_start`：工具名、参数、调用编号 |
| `tool_result` | `tool_end`：对应结果、是否失败 |
| 正常最终步骤和完整结束证据 | 最终答案，稍后发 `assistant_message` |
| reasoning_delta | 不发送到网页 |

`step_end` 可能出现在工具事件之前；代码按官方实际顺序处理，不用网页常识猜顺序。工具调用编号把“一次调用”和“它的结果”配成一对。

“控制服务说 succeeded”还不够。投影器同时检查：最后一个模型步骤正常 stop、最终文字确实来自这个最后步骤、Pi 会话编号一致、turn/completed 和 result/eof 匹配、工具结果完整。模型被长度限制截断或中止时，不能显示成成功。工具失败后模型可以正常解释失败，所以“任务正常结束”和“所有工具成功”仍是不同概念。

工具输出、公开过程文字和最终答案中的可识别凭据字段会清理；过大的工具结果只显示摘要。此清理不保证识别任意自然语言中的所有秘密。原生会话和控制服务数据仍是私有敏感状态，不能发布。

### 6. 模型结束后，还要完成消息保存

`AgentComposeRuntime.run()` 验证结果与 Pi 原生会话，先保存自己的运行元数据，再发最终答案、成功状态和 done。

已有的 `packages/task-core/task-message-service.mjs` 随后把最终回答保存到 SQLite，再发 `message_saved` 和 `task_saved`。浏览器继续等保存结果，不能收到 done 就断开并宣称全部保存完成。

因此完整收尾为：

```text
Pi 回答完成 → RPC 最终 result → 运行元数据保存 → done
          → SQLite 保存回答 → message_saved → task_saved
```

这一段主要沿用上一阶段正确的设计，本次通过新的执行器接入验证了它。

### 7. 为什么继续聊天需要保存多种编号

| 编号 | 回答的问题 | 同一任务续聊时 |
| --- | --- | --- |
| taskId | 网页上是哪一项任务？ | 不变 |
| executionSessionId | 这项任务的执行记录在哪里？ | 不变 |
| sandboxId | 使用哪个容器环境和挂载目录？ | 不变 |
| piSessionId | Pi 要恢复哪一段上下文？ | 不变 |
| runId | 这一次发送产生哪一次执行？ | 每轮改变 |

SQLite 保存网页历史，`runtime/compose-sessions/<executionSessionId>.json` 保存上述对应关系，sandbox 的 `state/agents/providers/pi/sessions/*.jsonl` 保存 Pi 的原生上下文。只有网页历史还在，并不能证明模型记得前文；必须继续加载原生会话。

运行前检查 provider state 与 JSONL 的会话编号，丢失或歧义时拒绝默默新建空对话。第一轮已被接收但结果丢失时，只有能够确认已有原生会话才恢复。这里做的是身份和存在性校验，还不是针对任意文件损坏的完整内容校验/修复系统。

### 8. 旧网页任务如何处理

`runtime-router.mjs` 对新任务使用 Compose；已有 Compose 记录继续 Compose，已有 SDK 记录继续 LocalPiRuntime。Compose 故障不会自动降级成 SDK，从而避免在另一个目录中启动一段空上下文。

旧 SDK 的文件目录和读写限制保留。`apps/api/router.mjs` 的 GET messages 额外返回 execution 元数据，`public/app.js` 据此显示真实目录，并按实际后端选择统计示例路径。元数据暂时读取失败时，聊天历史仍能显示。

## 重启与失败为什么要单独处理

浏览器关闭与网页服务崩溃不同；正常关闭网页服务与强制杀死进程也不同。

- 浏览器断开：已接受的任务仍完成执行和保存。
- 正常 SIGTERM：网页服务等待已接受任务完成保存，再关闭 RPC 连接。
- 网页服务意外退出：官方 DETACH 允许控制服务继续运行。重启后的提示改为“上一轮结果尚未确认”，不误称容器任务已经停止。
- 再次提交：顺序查询同一 sandbox 的 pending、running 状态，避免状态从 pending 变成 running 时被两个并发查询漏掉。查询失败就拒绝执行，不把失联当空闲。
- RPC 超时、协议错误或回调失败：若已经知道 runId，另发 StopRun；停止无法确认时保留 runId 和 stopUnconfirmed 标志。不自动重试付费任务。

当前只有一个网页服务进程；查询不是跨多个副本的分布式锁。强制重启后的自动接回实时事件、补齐丢失答案仍未实现。

## 实际验收

先在本机编写/运行离线测试，再同步服务器依赖和源码；只重启确认空闲的项目网页进程，没有系统安装、权限修改或新建系统服务。

实际浏览器任务：

- taskId：`52d8672c-f320-4543-bd56-0729389b70d1`
- executionSessionId：`52ea3105-1d3e-4d6d-9eb3-18f4e4216ad6`
- sandboxId：`a2b136000c5f937602af67f27220a83a0e09984c1c1eaae9c4b26ea8113e3c2e`
- piSessionId：`01a155ae-b9d2-734b-99dc-1d348210cc98`
- 统计 runId：`7449c1f1c6fe1cc4ad7565d298d7c6028c4b511b01606c5204e136372e896d18`
- 续聊 runId：`40db825775e5619f1dd43ad1189ba36556d62eda2ecaac1fb59636173bc92188`

| 检查 | 实际结果 |
| --- | --- |
| 网页通过正式 RPC 完成统计 | 4 次模型响应，3 次成功工具操作；实际 JSON 为 count4/sum100/mean25 |
| 重启服务后同任务续聊 | 同 Pi 会话、同 sandbox；正确回忆学习标记与统计结果；1 次响应、0 工具 |
| 原生会话真实追加 | 文件从 8833 增至 10093 字节；原 8833 字节的 SHA256 不变 |
| 第二项独立任务 | taskId `52072665-52fb-4f0e-b93c-167ada3950e4`，不同 sandbox/Pi 会话；输出目录为空，没有第一项结果 |
| 实际 guest | 两项任务均使用上一轮固定 ImageID；只挂各自 sandbox 子目录，没有宿主 Docker socket、原始模型 key 或管理令牌环境变量 |
| 旧任务 | 网页仍能恢复旧 SDK 的消息、工具记录与目录；离线路由测试验证保留 SDK 路径，本轮未重复调用旧任务模型 |

独立检查入口：

```sh
node scripts/verify-compose-web-task.mjs 52d8672c-f320-4543-bd56-0729389b70d1
```

它不调用模型；读取任务 API、运行元数据、原生 JSONL 和实际 CSV/JSON，并用既有 `verifyComposeFileTask()` 重新计算和检查轨迹。它专用于当前统计练习，不是任意任务的通用正确性证明；后续若改写练习输出或加入不相关工具操作，验收可能不再适用。原 `npm run verify:web-task` 继续用于旧 SDK 网页任务。

私有证据保存在 `runtime/compose-web/acceptance-first.json`、`acceptance-isolation.json`、`acceptance-resume.json` 及对应运行日志中，不提交 Git。第一项前后原生 JSONL 的差值证明此次续接，不代表未来所有会话文件都有完整防损坏保护。

离线测试覆盖本机真实 gRPC 假控制服务、认证/EOF/超时停止、事件合法性与脱敏、初始化恢复、同任务并发拒绝、未知活跃状态拒绝、新旧路由、SQLite/SSE 保存以及既有文件验收。最终完整结果为 170 项 Node 测试通过；另保留运行 4 项 Linux 凭据测试。独立只读审查发现的嵌套凭据、陈旧最终文字、状态查询竞态已修复并加入回归。

## 当前完成边界与下一步

新网页任务正式走 Agent Compose，health 返回 `backend=agent-compose`、`taskContainers=true`。测试后的两个网页 guest 保留运行以支持继续任务；保留运行是本阶段策略，不等于已经实现自动回收。

下一步沿参考仓库补“停止本轮执行”和“结束任务/释放容器”。先区分停止一次模型运行、停止整个任务环境、保留历史与文件，再实现按钮、状态转换与实际验收。

当前仍无网页停止/删除按钮、资源配额、开机自启、专业 siRNA 工具、工具封装平台或自进化。guest 内 read/write 允许清单也不构成严格目录沙箱。模型负责提出工具调用和组织回答；程序负责执行、容器管理、记录与验证；这些工程功能本身不证明模型具有自进化能力。
