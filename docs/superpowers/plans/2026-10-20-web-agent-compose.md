# 网页接入 Agent Compose 实施计划

> 使用 executing-plans 分项实施，独立的协议与事件任务并行；按用户已经批准的正式架构继续，在 main 工作，不创建其他分支。

**Goal:** 新建网页任务通过 Agent Compose 正式双向 RPC 驱动独立容器中的 Pi，并保留旧 SDK 任务和完整消息保存顺序。

**Architecture:** HTTP 和任务层继续使用现有接口；新增 AgentComposeRuntime 实现 create/run/status/runtimeInfo。执行会话元数据保存 sandboxId、Pi 会话和每轮 runId；CLI 负责登记/初始化/状态，正式模型任务走 AttachAgentRun。前端继续消费现有 SSE 事件。

**Tech Stack:** Node 24、Pi 1.2.0、Agent Compose v2609.3.0、grpc-js 1.14.4、proto-loader 0.8.1、原有 SQLite/SSE/静态网页。

**Spec:** 本文件的设计与验收约束；用户已在上一轮明确下一步并要求继续实施。

## 全局约束

- 唯一远端目录 `/home/hanwen/Project/project/siNRA-pi`；状态、缓存和传输文件均在其中。
- 不修改原仓库、系统配置或 RSI 项目；不读取/打印模型 key，RPC 管理 token 只在服务端读取。
- 默认新任务使用 Agent Compose；旧任务按既有执行会话记录继续走 LocalPiRuntime，不静默新建空对话。
- 仅启用 read/write；保留上一轮镜像、模型代理和 rootless Docker。网页通过 localhost/SSH 隧道访问。
- 创建任务与发送消息分开；创建只建元数据，首次消息才初始化容器。相同任务复用 sandbox 和 Pi 会话，不同任务相互独立。
- 不添加停止/删除按钮、专业工具或自进化；传输失败时停止已知运行是本轮必要的内部错误处理。
- 原生工具允许清单不等同于 guest 内路径权限控制，不夸大隔离边界。

## 设计与接口

`AgentComposeRpcClient({address,token,timeoutMs})` 使用官方 pinned proto 和 metadata Bearer 认证，`run(request,{onStarted,onAgentEvent,onTurnCompleted})` 返回 snapshot；`stopRun(runId)`、`close()` 管理连接。显式发送 stdinEof 后关闭请求，等最终 result 和流结束；不自动重试付费运行。连接断开不会自动停止 DETACH 运行，因此已知 runId 的失败路径显式 StopRun。

`createComposeEventProjector(emit)` 提供 onAgentEvent、onTurnCompleted、finish。只映射 progress_message/tool_start/tool_end，不展示 reasoning，不提前把文本片段当作最终答案。检查最终 step 正常 stop、turn completed、最终 eof 与一致的 Pi threadId，避免 length/aborted 被旧 runner 报 completed 后误判。

`AgentComposeRuntime` 使用独立 `runtime/compose-sessions/<UUID>.json` 原子保存记录；`create()` 返回 idle 元数据；`ensureWorkspace(id)` 通过 CLI up/run --command 初始化并保存 sandboxId、受限映射的 workspace；`run({sessionId,message},emit)` 调正式 RPC，保存状态后发 assistant_message、run_status、done。运行前核查已有活跃运行与会话文件，不因进程重启丢失上下文。

`RuntimeRouter` 对已有 compose-sessions 记录选择 Compose，否则读取既有 task-sessions 的 SDK 记录。新建一律 Compose，不能因 Compose 故障自动改走 SDK。`describe(id)` 只返回安全的 backend、sandboxId、项目相对工作目录/事件路径，供任务详情显示。

HTTP GET messages 增加 execution 元数据，已有 task/messages/runEvents 保留。前端按 execution 显示实际目录，并为新容器任务填入 input/numbers.csv → output/result.json 的示例；旧任务保留原示例路径。

## 实施与验收

- [x] 协议与事件：先编写失败测试，再实现；本地真实 gRPC 服务测试认证、EOF、错误、回调顺序、无最终结果和超时停止；事件测试拒绝截断、缺失工具结果和 reasoning 泄露。
- [x] 执行器与持久化：临时项目目录和可控 transport 测试无模型创建、两轮复用、重建实例恢复、不同任务隔离、并发拒绝、初始化写入后恢复和断线后的运行处理。
- [x] 网页集成：保留 task API/SQLite/SSE 保存顺序；任务详情显示真实路径；离线检查新旧路由和 HTTP 历史。
- [x] 服务器实测：安全同步依赖与源码，在 idle 时重启现有项目网页进程；浏览器真实提交统计任务并核对工具/文件；另一任务不同 sandbox；网页进程重启后同任务回忆学习标记。
- [x] 完整测试、独立审查、详细中文文件讲解；最终本机/服务器170项Node测试与服务器4项Linux凭据测试通过，实测细节见 docs/09-网页接入AgentCompose.md。

收尾集成使用 main 提交推送及服务器 Git bundle 同步，三端 HEAD 以本轮最终终端核验为准，不将真实会话/凭据/运行产物提交。

## 参考与证据边界

原仓库 packages/agent-runtime/{executor,agent-compose-runtime,rpc}.ts 与 packages/task-core 负责对应边界。官方协议取自 chaitin/agent-compose v2609.3.0，保留其 AGPL-3.0 许可和来源；客户端、适配器和验收独立编写，不整仓复制应用代码。上一轮 CLI 成功不能替代本轮 RPC/网页证据。
