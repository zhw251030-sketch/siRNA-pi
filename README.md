# siRNA-pi

通过亲手逐步重建一个 Pi Agent 应用，理解参考项目中每一层为什么存在、如何连接，以及怎样验证它确实工作。

这是独立的学习仓库。以原仓库当前正式架构为重建目标，每次实现一段可以解释、运行和检查的流程，并用 Git 提交保存学习过程。目标包含 Agent Compose 和独立任务容器；当前执行器仍是 Pi SDK 过渡实现。

## 当前进度

- 2026-10-15：建立仓库说明、学习路线和协作规则。
- 2026-10-15：在指定服务器目录安装 Pi Coding Agent `1.2.0`，使用已有 Node.js `24.16.0`；依赖检查、版本输出和隔离环境下的帮助命令均通过。
- 2026-10-15：接通 MiniMax 国内平台的 `MiniMax-M3`，完成“读取样例 → 计算 → 写入结果 → 重新读取”任务；实际结果为 4 个数、总和 100、平均值 25。
- 2026-10-15：通过 Pi SDK 创建内存会话、订阅事件并完成相同文件任务；4 次模型响应、3 次成功工具调用，独立验证结果正确。
- 2026-10-15：完成最小网页与 HTTP 服务，通过浏览器提交统计任务；4 次模型响应、3 次工具调用，真实文件通过独立验证，17 项离线测试通过。
- 本轮代码：按原仓库拆开“创建任务”和“发送消息”，增加任务列表、SQLite 历史、同任务多轮会话、SSE 执行动态，并采用 `apps/api`、`packages/task-core`、`packages/agent-runtime` 的职责目录。
- 本轮验证：49 项离线测试通过；真实网页统计结果正确，服务重启后同一 Pi 会话成功继续回答前文问题。完整记录见 [第 4 步：对齐原仓库任务架构](docs/05-对齐原仓库任务架构.md)。
- 后续继续接入正式 Agent Compose 与任务容器。目前服务器 Docker 使用权限尚未满足条件；停止操作、专业 siRNA 工具与自进化仍未实现。
- 2026-10-17：完成 Docker 只读预检，准备项目 rootless Docker 配置及检查脚本。缺少的系统包 uidmap 尚待确认安装；容器还未启动。见 [第 5 步 A：Docker 运行环境](docs/06-Docker运行环境.md)。

安装位置、文件解释和验证记录见 [第 1 步 A：安装与运行 Pi](docs/01-安装与运行Pi.md)。服务器项目目录是 `/home/hanwen/Project/project/siNRA-pi/`，按用户指定拼写保留。

模型连接、工具轨迹、运行命令和结果检查见 [第 1 步 B：MiniMax 与首次文件任务](docs/02-MiniMax与首次文件任务.md)。后续远端工作均限制在上述项目目录内；用户提供的 `docs/auth.json` 仅在服务器保存，不进入 Git。

SDK 示例、逐段代码解释和实际结果见 [第 2 步：调用 Pi SDK 创建会话](docs/03-SDK创建会话.md)。`npm run pi:sdk -- --check` 只检查会话配置，`npm run pi:sdk` 执行模型任务，`npm run verify:sdk-task` 独立检查已有结果。

最初的网页实现与历史证据见 [第 3 步：网页连接 Pi](docs/04-网页连接Pi.md)，当前任务流程见 [第 4 步：对齐原仓库任务架构](docs/05-对齐原仓库任务架构.md)。服务器运行 `npm run web`，本机通过 SSH 隧道访问 `http://127.0.0.1:3000`。点击“新建设计任务”建立任务，在该任务中发送消息和继续追问；密钥仅由服务器读取。

## 当前常用命令

先进入服务器唯一工作目录 `/home/hanwen/Project/project/siNRA-pi`，使用已有 Node 24 环境。

| 命令 | 用途 | 是否调用模型 |
| --- | --- | --- |
| `npm run web` | 启动 `apps/api/bootstrap.mjs`；只监听 `127.0.0.1:3000` | 启动不调用；网页发送消息后调用 |
| `npm test` | 运行离线行为测试 | 否 |
| `npm run pi:sdk -- --check` | 检查 Pi SDK 会话配置 | 否 |
| `npm run pi:sdk` | 再做第 2 步固定文件练习，替换该练习原有输出 | 是 |
| `npm run verify:first-task` | 验证已有 CLI 样例产物 | 否 |
| `npm run verify:sdk-task` | 验证已有 SDK 样例产物 | 否 |
| `npm run verify:web-task -- <executionSessionId> --run <runId>` | 验证当前网页统计示例的一次具体执行 | 否 |
| `npm run verify:web-task -- <旧任务编号>` | 兼容第 3 步原有网页样例 | 否 |

`executionSessionId` 标识任务使用的执行环境，`runId` 标识其中某次发送引发的运行。两者均可从任务 API 记录和网页“任务记录与文件位置”中核对；不能把网页任务 `id` 直接当作执行会话编号。

## 第一个目标

逐步完成“通过网页操作 Pi”：

1. 认识原生 Pi 已经提供的模型连接、工具与执行循环。
2. 用一小段程序创建 Pi 会话、提交任务并接收结果。
3. 增加最小后端和网页，走通“网页输入 → 后端 → Pi → 网页输出”。
4. 按原仓库重建任务与消息流程、执行过程展示、多轮上下文和历史保存。
5. 接入 Agent Compose 与任务容器，再补上停止和容器生命周期等能力。

完成这个目标以后，再学习专业工具接入、工具版本管理、受控改进及人类反馈。详细安排见 [学习路线](docs/学习路线.md)。

## 每一步怎样学习

每一步都回答六个问题：

1. 当前缺少什么能力，为什么需要增加它？
2. 参考仓库在哪些文件中实现了相关职责？
3. Pi 自带什么，我们需要新增什么？
4. 本次新增或修改的每个文件负责什么？
5. 怎样运行，应该看到什么，失败时如何定位？
6. 实际观察到了什么，还没有验证什么？

先解释当前的小步骤，再实现并验证，最后提交代码和学习记录。后续功能按学习进度展开。

## 参考来源与版本

- 原始参考仓库：[ZhxinMath/sirna-pi-agent-service-refactor](https://github.com/ZhxinMath/sirna-pi-agent-service-refactor)。
- 自己账号下的参考副本：[zhw251030-sketch/sirna-pi-agent-service-refactor](https://github.com/zhw251030-sketch/sirna-pi-agent-service-refactor)。
- 已阅读代码基准：`965c53fba4eaa23996f54aa0532c7f6e1064bfd8`；含贡献核查笔记的参考提交：`67d275494c50f1e5c205b96b72a7b1623acfbe1d`。
- 参考项目使用 Pi `0.85.1`；学习版以 [Pi 1.2.0](https://github.com/earendil-works/pi/releases/tag/v1.2.0) 为起点，通过 npm 使用时要求 Node.js `>=22.19.0`。
- 新版已提供 [MCP 接入](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/mcp.md)，具体接入代码按新版接口验证。

参考项目用于理解问题、职责和实现思路。初始提交没有复制其应用代码；以后引用或改编具体实现时，记录来源、版本和修改内容，并核对相应许可。

## 分支与同步

- 本仓库由个人独立管理，只使用 `main`；日常学习、实现和阶段记录均提交并推送到 `origin/main`。
- 参考仓库 `sirna-pi-agent-service-refactor` 有独立的协作与分支安排，不沿用到本仓库。
- 每次提交聚焦一个学习步骤；推送前检查改动和验证结果。
- 凭据、真实会话记录、运行产物和依赖目录不进入版本控制。

## 目录

```text
README.md                   项目目标、当前进度和学习方式
AGENTS.md                   与编程助手协作时遵守的规则
.gitignore                  排除凭据、依赖和运行产物
.nvmrc                      项目使用的 Node.js 版本
.npmrc                      npm 安装规则
package.json                Pi 依赖和命令入口
package-lock.json           npm 生成的精确依赖记录
scripts/pi-minimax.mjs       读取项目内凭据并启动原生 Pi
scripts/pi-sdk.mjs           调用已有 SDK 创建会话、订阅事件和提交任务
apps/api/bootstrap.mjs      组合数据库、运行时与 HTTP 服务，启动网页
apps/api/router.mjs         任务接口、SSE 传输与静态页面
packages/task-core/task-store.mjs           SQLite 任务、消息和运行事件
packages/task-core/task-message-service.mjs 消息检查、去重、执行协调与保存
packages/agent-runtime/runtime-port.mjs     上层调用执行器的边界说明
packages/agent-runtime/local-pi-runtime.mjs 当前 SDK 执行器、执行会话与事件转换
packages/agent-runtime/pi-sdk.mjs           CLI/网页共用的 SDK 创建与运行
packages/agent-runtime/workspace-files.mjs  read/write 文件范围检查
public/index.html           任务列表、对话、执行动态三个区域
public/app.js               创建任务、发消息、切换与恢复历史
public/sse.mjs              连续读取服务端事件，确认保存完成
public/style.css            网页样式
scripts/verify-first-task.mjs 检查 CLI、SDK 或网页统计任务的轨迹与真实文件
tests/verify-file-task.test.mjs 不调用模型的验收程序测试
tests/web.test.mjs           HTTP/SSE、错误、请求限制和静态访问测试
tests/task-core.test.mjs     真实 SQLite、多轮消息、去重与恢复测试
tests/runtime-events.test.mjs SDK 事件转换行为测试
tests/sse.test.mjs           字节分块、事件帧和保存完成检查
tests/workspace-files.test.mjs 真实文件范围与链接检查
tests/pi-session.integration.mjs 已安装 SDK 的会话落盘与重开检查，不调用模型
config/pi/                  不含密钥的模型和运行设置
examples/01-file-task/       四个样例数和任务说明
examples/02-sdk-task/        SDK 练习的任务说明
docs/学习路线.md             分阶段目标、参考文件和验收方式
docs/01-安装与运行Pi.md       本轮安装说明与实际结果
docs/02-MiniMax与首次文件任务.md 模型接入与真实任务记录
docs/03-SDK创建会话.md        SDK 应用代码与实际任务讲解
docs/04-网页连接Pi.md         网页到服务器、SDK、文件的完整路径
docs/05-对齐原仓库任务架构.md 当前任务流程、职责分层和正式架构方向
docs/superpowers/plans/      安装步骤与执行记录
```

服务器的 `node_modules/` 保存依赖，`runtime/` 保存运行状态，`workspaces/` 保存练习产物；这些都不进入 Git。网页任务历史位于 `runtime/tasks/tasks.sqlite`；Pi 上下文会话位于 `runtime/pi-web/sessions/`；同一执行会话沿用 `workspaces/web/<executionSessionId>/`，每次运行另有 `runtime/web/<executionSessionId>.<runId>.events.jsonl`。文件范围检查仍是应用层限制，尚未提供独立容器。
