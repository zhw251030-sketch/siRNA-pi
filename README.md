# siRNA-pi

通过亲手逐步重建一个 Pi Agent 应用，理解参考项目中每一层为什么存在、如何连接，以及怎样验证它确实工作。

这是独立的学习仓库。以原仓库当前正式架构为重建目标，每次实现一段可以解释、运行和检查的流程，并用 Git 提交保存学习过程。新网页任务已经通过 Agent Compose 正式 RPC 驱动独立容器中的 Pi；旧 SDK 任务保留原有上下文。

## 当前进度

- 2026-10-15：建立仓库说明、学习路线和协作规则。
- 2026-10-15：在指定服务器目录安装 Pi Coding Agent `1.2.0`，使用已有 Node.js `24.16.0`；依赖检查、版本输出和隔离环境下的帮助命令均通过。
- 2026-10-15：接通 MiniMax 国内平台的 `MiniMax-M3`，完成“读取样例 → 计算 → 写入结果 → 重新读取”任务；实际结果为 4 个数、总和 100、平均值 25。
- 2026-10-15：通过 Pi SDK 创建内存会话、订阅事件并完成相同文件任务；4 次模型响应、3 次成功工具调用，独立验证结果正确。
- 2026-10-15：完成最小网页与 HTTP 服务，通过浏览器提交统计任务；4 次模型响应、3 次工具调用，真实文件通过独立验证，17 项离线测试通过。
- 本轮代码：按原仓库拆开“创建任务”和“发送消息”，增加任务列表、SQLite 历史、同任务多轮会话、SSE 执行动态，并采用 `apps/api`、`packages/task-core`、`packages/agent-runtime` 的职责目录。
- 本轮验证：49 项离线测试通过；真实网页统计结果正确，服务重启后同一 Pi 会话成功继续回答前文问题。完整记录见 [第 4 步：对齐原仓库任务架构](docs/05-对齐原仓库任务架构.md)。
- 2026-10-17：经确认安装 uidmap，启动项目 rootless Docker，固定摘要的官方 hello-world 容器运行成功、退出码 0。全部项目数据位于指定目录；已核对重启和客户端连接范围。见 [第 5 步 A：Docker 运行环境](docs/06-Docker运行环境.md)。
- 2026-10-18：启动正式 Agent Compose v2609.3.0，由其创建命令任务容器，验证执行、文件挂载、管理接口鉴权和停止释放；文件及运行记录保留，49 项离线测试通过。见 [第 5 步 B：Agent Compose 与任务环境](docs/07-AgentCompose与任务环境.md)。
- 2026-10-20：构建锁定依赖的 Pi 1.2.0 guest，经 Agent Compose 模型转接接通 MiniMax-M3；真实文件任务和同会话续问通过，停止后容器释放且文件保留。96 项 Node 测试与 4 项 Linux 凭据测试通过。见 [第 5 步 C：容器中的 Pi 与模型连接](docs/08-容器中的Pi与模型连接.md)。
- 2026-10-20：网页接入正式 Agent Compose RPC，真实统计、不同任务独立环境、网页服务重启后同 Pi 会话续聊通过；170 项 Node 测试与 4 项 Linux 凭据测试通过。详见 [第 5 步 D：网页接入 Agent Compose](docs/09-网页接入AgentCompose.md)。
- 2026-10-20：完成停止本轮、结束任务与容器释放。真实网页停止后同会话续聊成功，运行中结束后 guest 释放、8 条消息及文件保留，刷新只读；239 项 Node 测试与4项 Linux 凭据测试通过。见 [第 6 步：停止运行与结束任务](docs/10-停止运行与结束任务.md)。
- 2026-10-20：完成网页任务文件列表、文本预览与下载。已结束任务仍能查看 CSV/JSON，浏览器下载与宿主字节一致，切换任务不混入其他结果。Linux 271 项 Node 测试通过；本轮没有模型调用。见 [第 7 步：网页查看任务文件](docs/11-网页查看任务文件.md)。
- 2026-10-20：第8步已实现输入上传、独立任务归档、执行前回填和执行后收集。Linux354项测试通过；真实网页上传、回填、旧结果归档下载及结束保留通过。两次新模型验收均遭MiniMax 529过载、0工具调用，成功生成新结果仍待补验。详见 [上传资料与任务文件归档](docs/12-上传资料与任务文件归档.md)。
- 下一步先在模型服务恢复后补齐上传任务的成功验收，再进入工具封装。第5步D两个网页guest仍保留，本轮两个验收guest及生命周期guest均已释放、文件保留。资源配额、开机自启、专业siRNA工具与自进化尚未实现。

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
| `sh scripts/check-docker-rootless.sh` | 服务器上的 Docker 前提检查，不启动或安装服务 | 否 |
| `sh scripts/project-docker.sh info` | 检查项目 Docker 的实际模式、目录和能力 | 否 |
| `sh scripts/start-project-agent-compose.sh` | 准备私有状态并启动 Agent Compose 控制服务 | 否 |
| `sh scripts/build-project-guest.sh` | 从固定官方底座构建个人 Pi 1.2.0 任务镜像；首次启动前执行 | 否 |
| `sh scripts/project-agent-compose.sh status` | 查询管理服务状态；同一入口支持 up、inspect 等命令 | 否 |
| `node scripts/verify-agent-compose-workspace.mjs` | 新建固定命令测试环境，检查文件及隔离范围，再停止环境；保留证据 | 否 |
| `node scripts/verify-agent-compose-model.mjs` | 新建容器，完成文件任务及同会话续问，验收后释放容器并保留证据 | 是 |
| `python3 tests/controller-secret.test.py` | 用临时假数据测试控制服务凭据读取；Linux 检查权限和链接 | 否 |
| `npm run pi:sdk` | 再做第 2 步固定文件练习，替换该练习原有输出 | 是 |
| `npm run verify:first-task` | 验证已有 CLI 样例产物 | 否 |
| `npm run verify:sdk-task` | 验证已有 SDK 样例产物 | 否 |
| `node scripts/verify-compose-web-task.mjs <taskId>` | 验证新容器网页统计任务的记录、原生会话和真实文件 | 否 |
| `node scripts/verify-compose-task-files.mjs <taskId>` | 校验下载与任务归档字节一致、读取不改变任务记录；GET 可刷新归档 | 否 |
| `node scripts/verify-compose-upload.mjs <taskId> uploaded\|completed\|ended` | 核验上传未启动环境、真实工具执行和结束后文件保留 | 否 |
| `npm run verify:web-task -- <executionSessionId> --run <runId>` | 验证旧 SDK 网页统计示例的一次具体执行 | 否 |
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
scripts/check-docker-rootless.sh 服务器 rootless Docker 只读预检
scripts/start-project-docker.sh  以 hanwen 启动项目自己的 Docker
scripts/project-docker.sh        Docker 客户端连接项目 socket
config/docker/daemon.json        项目 Docker 的数据、执行、日志与 socket 设置
compose.yml                     Docker Compose 启动管理服务
agent-compose.yml               Agent Compose 的 designer 环境配置
scripts/prepare-agent-compose.mjs        创建私有状态和独立管理令牌
scripts/start-project-agent-compose.sh   启动管理服务并等待健康
scripts/project-agent-compose.sh         经控制容器本地 socket 调用官方 CLI
scripts/verify-agent-compose-workspace.mjs 真实命令工作区验收
containers/agent-compose-guest/           个人 Pi 1.2.0 镜像及启动包装器
containers/agent-compose/entrypoint.py    从只读文件加载控制端模型凭据
config/agent-compose-models.json          无密钥的模型目录与环境变量引用
config/pi/compose-settings.json           guest 的重试、压缩和遥测设置
scripts/build-project-guest.sh            用项目 Docker 构建 guest
scripts/verify-agent-compose-model.mjs    真实容器模型任务及上下文续接验收
scripts/lib/verify-compose-file-task.mjs  按原生会话与真实文件独立验收
apps/api/bootstrap.mjs      组合数据库、运行时与 HTTP 服务，启动网页
packages/agent-runtime/runtime-router.mjs       新任务走 Compose，旧 SDK 任务继续原上下文
packages/agent-runtime/agent-compose-runtime.mjs 组织任务容器、模型运行与结果保存
packages/agent-runtime/agent-compose-rpc.mjs     使用正式双向 RPC、认证、截止时间和 EOF
packages/agent-runtime/compose-executor.mjs     通过官方 CLI 初始化并检查任务环境
packages/agent-runtime/compose-session-store.mjs 保存执行关系、检查目录与 Pi 会话
packages/agent-runtime/compose-events.mjs       将底层事件映射为网页合同并验证结束状态
packages/agent-runtime/compose-control-token.mjs 仅在服务端安全读取管理令牌
proto/                                       固定版本的官方协议、许可证与来源
scripts/verify-compose-web-task.mjs            新容器网页统计练习只读验收
scripts/verify-compose-lifecycle.mjs           中断、续聊、释放后的状态与文件只读验收
apps/api/router.mjs         任务接口、SSE 传输与静态页面
packages/task-core/task-store.mjs           SQLite 任务、消息和运行事件
packages/task-core/task-message-service.mjs 消息检查、去重、执行协调与保存
packages/task-core/workspace.mjs           工作目录归属、受限读取与 SHA-256 共享原语
packages/task-core/task-files.mjs          输入上传、任务归档、执行前回填与结果收集
packages/task-core/safe-file-tree.mjs      安全目录遍历、容量检查与原子文件写入
packages/agent-runtime/runtime-port.mjs     上层调用执行器的边界说明
packages/agent-runtime/local-pi-runtime.mjs 旧 SDK 任务的执行会话与事件转换
packages/agent-runtime/pi-sdk.mjs           CLI/网页共用的 SDK 创建与运行
packages/agent-runtime/workspace-files.mjs  read/write 文件范围检查
public/index.html           任务列表、对话、执行动态三个区域
public/app.js               创建任务、发消息、切换与恢复历史
public/sse.mjs              连续读取服务端事件，确认保存完成
public/lifecycle.mjs        停止/结束按钮、迟到状态和待发送草稿规则
public/files.mjs            文件请求、文本预览与切换任务后的过期响应保护
public/style.css            网页样式
scripts/verify-first-task.mjs 检查 CLI、SDK 或网页统计任务的轨迹与真实文件
tests/verify-file-task.test.mjs 不调用模型的验收程序测试
tests/web.test.mjs           HTTP/SSE、错误、请求限制和静态访问测试
tests/task-core.test.mjs     真实 SQLite、多轮消息、去重与恢复测试
tests/runtime-events.test.mjs SDK 事件转换行为测试
tests/sse.test.mjs           字节分块、事件帧和保存完成检查
tests/workspace-files.test.mjs 真实文件范围与链接检查
tests/task-workspace-files.test.mjs 网页任务文件范围、链接、变化与容量检查
tests/task-files-http.test.mjs 文件 API、文本/附件响应和错误检查
tests/files-ui.test.mjs      文件请求竞争、预览与切换任务检查
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
docs/06-Docker运行环境.md     系统前提、项目 Docker 和真实容器验证
docs/07-AgentCompose与任务环境.md 控制服务、任务环境、挂载与实际验收
docs/08-容器中的Pi与模型连接.md  镜像、模型转接、凭据范围与真实模型任务
docs/09-网页接入AgentCompose.md 网页正式 RPC、执行事件、同会话续聊及验收
docs/10-停止运行与结束任务.md   停止请求、确认终态、保留文件并释放容器
docs/11-网页查看任务文件.md     文件列表、文本预览与下载
docs/12-上传资料与任务文件归档.md 上传、独立资料区和执行同步
docs/superpowers/plans/      安装步骤与执行记录
```

服务器的 `node_modules/` 保存依赖，`runtime/` 保存运行状态，`workspaces/` 保存旧练习产物；这些都不进入 Git。所有网页任务历史仍在 `runtime/tasks/tasks.sqlite`。新任务使用 `runtime/compose-sessions/` 保存执行关系，`runtime/compose-web/` 保存投影事件，真实工作文件和 Pi 原生会话位于 `runtime/agent-compose/data/sandboxes/<日期>/<sandboxId>/`。第8步新增 `runtime/task-files/<taskId>/input|output` 保存独立任务资料，执行前回填输入、执行后收回输出。旧 SDK 任务继续使用 `runtime/pi-web/sessions/`、`workspaces/web/<executionSessionId>/` 及 `runtime/web/`。

网页后端只读管理令牌；控制服务读取模型 key，且官方会把它保存到管理数据库。因此整个 `runtime/agent-compose/data/` 应作为敏感状态保护，只把每项任务自己的 sandbox 子目录挂给它的 guest。
