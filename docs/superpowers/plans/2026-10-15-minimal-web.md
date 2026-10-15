# 最小网页学习步骤

本计划承接用户已经同意的“网页输入 → 后端 → Pi SDK → 网页结果”步骤；在 main 上实现并同步，不另建分支。

## 目标与边界

新增一个单用户网页：提交一条任务，等待执行，显示真实回答、任务编号和产物目录。每次创建新的 Pi 内存会话，不保留对话上下文。延续 Pi 1.2.0、MiniMax-M3、项目内凭据与运行目录；不新增 npm 依赖。

参考仓库网页通过 POST /v1/tasks 创建任务，再通过 POST /v1/tasks/:id/messages 发消息并消费 SSE。本轮把创建与执行合并为 POST /v1/tasks，返回完整 JSON；学习职责对应，不声称协议兼容。后续再分离任务管理、流式事件和历史。

## 文件和接口

- `src/pi-session.mjs`：从已有 SDK 示例抽取 `createLearningSession({cwd, agentName, scopedFiles})` 与 `runPiTask({prompt, cwd, agentName, eventPath, source, onEvent, scopedFiles})`。保留原 SDK 命令的检查和事件格式。
- `src/workspace-files.mjs`：`createWorkspaceOperations(directory)` 为 Pi 原生 read/write 提供目录受限的文件操作，拒绝越界、符号链接、硬链接及大文件；不声称操作系统沙箱。
- `src/web-task.mjs`：`runWebTask(message)` 为每次请求创建 UUID、独立工作目录，复制 numbers.csv，调用 SDK 并返回 `{taskId, answer, workspace, eventLog, toolCalls, modelResponses}`。
- `src/server.mjs`：`createAppServer({runTask})` 使用 Node HTTP，白名单提供网页，接收 JSON 并限制一项任务同时运行。只监听回环地址，检查 Host/Origin、正文长度和输入，错误不返回原始服务商内容。
- `scripts/web.mjs`：启动服务器，默认 127.0.0.1:3000。
- `public/index.html`、`app.js`、`style.css`：中文任务表单、示例、等待状态、成功/失败显示；使用 textContent 显示模型文本。
- `tests/web.test.mjs`、`workspace-files.test.mjs`：真实 HTTP 与临时文件行为测试；只有收费模型调用使用替身。
- `docs/04-网页连接Pi.md`：按浏览器到文件的顺序讲解及对应参考仓库文件，记录实际验证与边界。

## 执行顺序

- [x] 写 HTTP 和文件范围行为测试，先运行观察未实现失败。
- [x] 抽取现有 SDK 调用，完成任务目录和最小 HTTP 服务；运行离线测试及 SDK --check。
- [x] 完成网页，同步服务器，通过 SSH 隧道在真实浏览器提交统计任务。
- [x] 独立检查事件中的真实工具调用、完成状态和 result.json 数值；保留以前 CLI/SDK 证据。
- [x] 审查、修复并更新中文学习记录。

集成要求：提交并同步 main，最后核对本地、GitHub、服务器提交一致；实际提交记录以 Git 历史为准。

## 验收

`npm test` 应覆盖正确输入、空/损坏/过大请求、并发拒绝、失败后可继续、静态路径不暴露密钥、跨站请求拒绝，以及文件越界/链接拒绝。`npm run pi:sdk -- --check` 不调用模型；旧两项 verify 命令继续检查旧证据。网页实际执行一次 read → write → read，独立验证 count=4、sum=100、mean=25。

服务器与 SSH 隧道分别运行；网页地址为本机 http://127.0.0.1:3000，不能把它解释为公开互联网网址。所有服务器新增文件限定在 /home/hanwen/Project/project/siNRA-pi。
