# 第10G步：网页任务调用正式工具

用户已要求继续按原正式架构逐步重建。前提：第10F步后端stdio MCP通过；本步接通Compose guest，不重复批准或更改工具版本。

## 路径与边界

网页 → TaskMessageService → AgentComposeRuntime → guest Pi显式MCP适配器 → guest远程MCP → 私有网络relay → 宿主Unix socket工具API → 正式登记发现/隔离执行/审计。

沿参考GET `/v1/agent-tools`和POST `/v1/agent-tools/:name/call`，GET返回`{tools:[{name,label,description,inputSchema}]}`，POST只接收`{arguments:{input:{...}}}`，成功只返回`{content}`。不增加文件转移、工具构建或审批HTTP入口。网页3000端口的loopback和Origin检查保留；工具API不与完整网页router混用。

relay只访问专用Unix socket，Docker网络内监听，不发布宿主端口，不挂Docker socket、登记库或密钥。新guest镜像和新Compose项目名保留旧任务版本。原有10份会话、两个旧guest不改动。

## 每轮身份

TaskCore把已登记taskId传给runtime。runtime分配稳定agentTurnId，在RPC提交前创建进程内随机能力凭证并写`/workspace/.sirna-task-context.json`。保留参考`sirna-task-context/v1`，增加agentTurnId和token作为教学部署的认证扩展；该文件是guest可读取的窄权限，不能称对模型保密。凭证不进入提示词、事件、审计、Git或输出归档。

`createToolCallLeases().begin({taskId,executionSessionId,sandboxId,agentTurnId,signal,onCall})`返回`{context,activate(agentRunId),close()}`。发现可在pending阶段进行；业务调用须在RPC onStarted核对并activate真实Compose runId后接受。由host凭证绑定推导身份，核对x-sirna-task-id；不信任客户端声称的run/session。每个服务全局最多一个正式工具执行；busy不排队、不自动重试。

取消时立即撤销新调用权限并标记signal；已接受工具仍等待受限执行、审计和清理。正常run完成也先close撤销并drain，再发送终态；HTTP断线不取消已接受任务。重启凭证全部失效。close必须幂等。

审计增加可选严格`taskContext:{taskId,executionSessionId,sandboxId,agentTurnId,agentRunId}`，业务toolCallId仍由host生成UUID，不与Agent runId混淆。host stdio旧路径保持无taskContext。宿主可投影最小approved_tool_call事件关联调用编号与结果，不返回私有路径、凭证或原业务文本。

## 代码接口

- `packages/capability-platform/tool-call-leases.mjs`：能力生命周期与排空。
- `apps/api/agent-tools.mjs`：`createAgentToolsServer({leases,discover})`，discover接收`{taskContext}`，HTTP严格有限读取/固定错误，server.waitForCalls用于关闭。
- `discoverApprovedTools({root,runner,taskContext})`：将可选服务器身份传入审计。
- `apps/mcp/remote-client.mjs`：明确固定base URL与context文件，逐次GET/POST、有限大小/期限、不重定向、不泄露响应诊断；返回AgentTool描述符给已有MCP层。
- `apps/mcp/remote-server.mjs`：固定领域工具+remote approved工具；清单通知/适配器刷新按锁定2.11.0核对实现。
- `containers/agent-tools-relay/relay.mjs`：只转发精确工具路径到固定UDS，限制正文/结果/超时。
- bootstrap组装单个lease/runner/API，Unix socket位于项目runtime专用0700目录，socket0600；不能盲删未知旧socket。

## 验收

先真实HTTP/MCP、任务生命周期、审计及权限负例离线测试；再Linux完整回归、新镜像构建与无模型网络检查。仅当没有活动任务后更新本项目控制服务和网页进程。用一个新网页任务调用已有summarize_target_sequence并保存结果，核对任务/Compose run/工具调用/包摘要/容器清理；结束新guest后文件仍可下载。所有新增请求、失败和限制如实记录。main提交推送并bundle同步服务器，不改RSI项目。
