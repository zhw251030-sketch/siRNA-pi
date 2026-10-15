# 对齐参考仓库的任务流程

用户已确认：目标包括原仓库正式的 Agent Compose 与独立任务容器架构，按阶段重建。本轮先纠正已经完成的网页入口和任务层，保留可运行的 SDK 过渡执行器，后续替换执行器。

## 本轮合同

- 与原仓库相同的职责目录：apps/api、packages/task-core、packages/agent-runtime、public。沿用本学习仓库 JavaScript ESM，因此扩展名为 .mjs；不在本轮额外引入 TypeScript 编译工具链。
- POST /v1/tasks 仅创建任务，201 返回 task/memory/dataPool。创建不执行 prompt。
- POST /v1/tasks/:id/messages 提交消息，返回 SSE。GET /v1/tasks 与 GET /v1/tasks/:id/messages 恢复列表、消息与事件。
- 使用 node:sqlite 保存任务、消息、运行事件，与参考仓库相同。Pi JSONL 保存模型上下文，二者职责分别解释。
- requestId 创建和消息去重；同一任务运行中拒绝新消息；成功回 idle，失败为 failed，允许后续再次发送。
- SSE 使用参考的事件名与字段：task/session/progress_message/assistant_message/tool_start/tool_end/run_status/done/message_saved/task_saved/error。done 后仍读到 EOF。
- SDK 适配器实现运行时 create/run/status/runtimeInfo 子集，明确 backend=local-pi，不伪造 sandbox 或声称已部署 Agent Compose。
- 同一任务继续同一个 Pi 会话；不同任务独立目录。采用项目内持久化会话，进程重启后恢复；意外中断的运行标记 failed。
- 网页采用原仓库对应的任务列表、对话、执行进度分区；没有实现的领域工具与容器按钮不提供。

## 分工与验收

1. task-store.mjs、task-message-service.mjs：真实 SQLite 测试创建/去重/多轮/冲突/失败/重启恢复。
2. pi-sdk.mjs、local-pi-runtime.mjs、runtime-port.mjs：共享 SDK 调用；保留 CLI，原生会话文件复用；中间说明与最终答案分离。
3. apps/api/router.mjs、bootstrap.mjs：原 API 的本轮子集；测试有效输入、分帧 SSE、持久化收尾、错误状态和静态访问保护。
4. public：新任务、续问、历史恢复、工具状态；SSE 解析测试 UTF-8 分块、CRLF、尾帧、done 后事件及不完整响应。
5. 服务器预检、真实浏览器两轮对话、刷新与进程重启恢复；独立检查统计文件和 Pi sessionId 一致。原 CLI/SDK/上一轮网页证据保持可验证。
6. 写清当前与正式 Agent Compose 的差异、下一步前提；审查、提交并同步 main。

## 已知后续前提

只读检查发现服务器有 /usr/bin/docker，但 hanwen 访问 /var/run/docker.sock 被拒绝；尚无可用 agent-compose 命令。安装与启用正式容器运行时前，需解决 Docker 使用权限并确认其状态存储满足项目目录约束。本轮不更改系统用户组、Docker 守护进程或项目外目录。
