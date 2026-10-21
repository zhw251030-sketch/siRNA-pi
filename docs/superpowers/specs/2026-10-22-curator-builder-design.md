# 11C：显式将 Curator 建议交给 Builder

参考固定只读版本 `sirna-pi-agent-service-refactor@67d2754`，个人基线 `d7e2576`。原版 `tool-curation-coordinator.ts`、`tool-curation-build-prompt.ts` 和 `router.ts:3278` 将建议转换为原任务的一条新消息，固定 requestId；并没有另建 Builder Agent，也没有保存精确 curation→proposal 边。本轮独立实现同一职责流程，同时增加可核查的来源连接。

## 范围

用户从已保存的 candidate 详情显式请求构建。原任务必须为可继续的空闲 Compose 任务，运行时确实支持 Builder。复用原任务、原会话、TaskMessageService、既有 OCI Builder、提案登记和后续独立验证/人工批准。不开自动 Observer、不自动构建/验证/批准、不新增运行时/镜像/权限、不制造真实发现记录。

## 数据和接口

- 独立 `runtime/tool-curation-build/builds.sqlite` 保存一条建议唯一的交接票据。冻结 curationId、taskId、executionSessionId、trace/result SHA、完整提示及其 SHA、固定请求号 `auto-tool-curation-build:<curationId>`。派发前写入；重复点击返回同票据，绑定冲突拒绝。中断/未知不自动再派发。
- GET `/v1/tasks/:taskId/curations/:curationId/build` 返回 `{eligible, reason, binding?, prompt?, handoff?}`。POST 同路径只接受 `{traceSha256,resultSha256,promptSha256}`，返回 `{handoff,deduplicated}`。提示不含原始 provider 日志或密钥。
- 对 skipped/error/waiting/running、错误 trace/result 绑定、SDK/停止/忙碌任务、已有工具名、非 no_external_access 权限拒绝。GET 不建任务/模型调用；POST 在异步空闲检查后重新核验。
- 状态 `dispatching → running → submitted | no_proposal | failed | outcome_unknown`；异常恢复只标记 unknown，停止/关闭排空已接受工作；保存 userMessageId/runId（确认后），原任务聊天中可查看该轮。
- 提示含候选边界、输入输出草案、证据ID、最小权限和构建指令，清楚区分草案与正式测试。要求检查目录、构建、实际测试、finalize、propose；允许判断不适合后不提交。既有 Builder 的 node、空依赖、exact、no_external_access 限制保持。
- 新的 curation 注册策略独立于 repair 返回值；从激活 lease 核对真实 task/session/run、最新用户消息与固定提示、未终态。普通用户伪造保留请求号不得激活关联；修订链保持原样。建议工具名冻结，权限不得扩大，不能将建议变成旧版本 parent 更新。
- `proposal_submitted` 与新 curation association 在注册事务中同时写入，包含 requestId/curationId/traceSha256/resultSha256/promptSha256。每票据最多一个提案，事务内检查；不得按同名或最新提案猜测。读回核验事件/材料/来源；登记后错误或完成状态不明按 unknown 展示，不重复提交。
- 网页详情展示可派发原因、固定提示、显式调用模型的按钮、交接状态及原任务/提案链接。请求响应按当前任务/建议/代次隔离；POST 回执未知后仅允许 GET 查记录，不自动重发。禁止用 innerHTML 渲染模型内容。

## 验证与交付

行为测试覆盖状态门禁、固定绑定、并发/跨重启去重、未知结果、伪造请求、终态后注册、单提案上限、来源读回、修订回归和 UI 陈旧响应。使用隔离目录的真实 SQLite/TaskMessageService/登记路径和确定性假运行时验证 candidate 成功路径；该记录不得插入生产业务库或冒充模型发现。现有生产无合格 candidate，验收生产拒绝路径和历史保持，不为了演示循环付费。Linux 完整测试与 Windows 相关测试，独立审查。部署只在指定项目根，保留旧业务记录、凭据和容器；个人 main 三端同步。
