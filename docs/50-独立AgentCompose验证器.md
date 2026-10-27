# 第 13C-J 步：独立 Agent Compose Verifier 的离线接线

日期：2026-10-27。

## 这一步解决什么问题

前面的 13C-B 到 13C-I 已经把 Goal 验证的后端基础做出来了：先冻结不可变证据包，再由 Evidence Resolver 生成后端拥有的 `evidenceId`，最后由 Coordinator 校验 verifier 提案并持久化每一轮 Attempt。但直到 13C-I，`apps/api/bootstrap.mjs` 仍然只装配 `createDeterministicGoalVerifier()`。验证闭环可以测试，却还没有真正让一个独立 Agent Compose/Pi 会话读取证据并返回 JSON。

原仓库把这个问题拆成三层：

| 原仓库职责 | 本仓库本轮对应实现 |
| --- | --- |
| `packages/extensions/goal/agent-goal-verifier.ts` | `packages/extensions/goal/goal-verification-agent-compose.mjs`：创建会话、发送提示、接收 `runId` 和最终 assistant JSON、finally 清理会话 |
| `src/goal-verifier-mcp.ts` | `apps/mcp/goal-verifier.mjs`：把 8 个只读验证工具转发到 token-scoped 后端 HTTP 访问层 |
| `agent-compose.yml` 的 `goal-verifier` + `goal-verifier-guard.ts` | `agent-compose.yml` 的 `goal-verifier`、guest 中的 `goal-verifier-guard.mjs` 和 `pi.sh` 的 verifier 分支 |
| `test/goal-verification-contract.test.ts` | `tests/goal-verification-agent-compose.test.mjs`：使用 fake chat 做无模型协议回放 |
| `test/goal-verifier-guard.test.ts` | 同一测试文件中的 guest guard 测试，以及 `tests/goal-verifier-mcp.test.mjs` |

## 适配器的实际时序

`createAgentComposeGoalVerifier(chat)` 不直接依赖网络或具体模型。它要求一个很小的 chat 接口：`create()`、`run(request, emit, signal)`、`remove(sessionId)`。这样做是为了把“验证协议”与“Agent Compose 传输”分开，离线测试可以完全不启动 Docker。

每轮验证的顺序是：

1. 调用 `chat.create({agentName: 'goal-verifier'})`，得到独立 session ID，并立即通过 `onStarted` 交给 Coordinator 持久化。
2. `verificationPrompt()` 将 Goal 的验收项、后端已有 evidenceId、工具使用边界、JSON 协议和短期访问令牌放入消息。保存到 attempt 的 prompt 会把真实令牌替换成 `[REDACTED_SHORT_LIVED_ACCESS_TOKEN]`。
3. 调用 `chat.run()`。收到 `run_status` 或 `assistant_message` 事件时记录 run ID，并只保留最后一条 assistant 文本。
4. 要求模型输出一个完整 JSON 对象；多个对象、半截对象或无法解析的文本直接失败，交给 13C-I 的协议重试机制。
5. 无论模型成功、协议失败还是网络异常，都在 `finally` 中调用 `chat.remove(sessionId)`，避免 verifier sandbox 残留。

`createRuntimeGoalVerifier(runtime)` 再把本项目的 `AgentComposeRuntime` 事件转换成上面的 chat 接口。它不会给 verifier 注入 `toolCallLeases`；verifier 的证据读取必须走只读 MCP。

## MCP 工具为什么必须单独存在

模型不能直接读取 SQLite、任务文件或宿主机目录。`apps/mcp/goal-verifier.mjs` 只公开以下 8 个工具：

`get_verification_bundle`、`read_verification_message`、`read_verification_artifact`、`list_verification_evidence`、`read_verification_attempt`、`check_verification_artifact`、`search_verification_sources`、`fetch_verification_source`。

每次调用都必须携带 `verificationId` 和短期 `accessToken`。MCP server 将请求 POST 到 `/v1/goal-verifications/{id}/{operation}`，后端再检查令牌、验证状态、分页范围和证据归属。模型收到的是后端创建的 evidence unit，最终 claim 只能复制 `evidenceId`；它不能自己填写 URL、locator、excerpt、时间戳或哈希。这正是原仓库把“事实解析和证据定位”留给后端的边界。

## 容器隔离变化

`compose-session-store.mjs` 现在允许第三个角色 `goal-verifier`，使用独立的 `runtime/goal-verifier/sessions` 和 `runtime/goal-verifier/events`。`AgentComposeRuntime` 对 `tool-curator` 和 `goal-verifier` 都拒绝业务工具租约；verifier 也禁止 workspace hydration，并使用未经 designer 前缀包装的独立提示。

`agent-compose.yml` 新增 `goal-verifier` agent，挂载 `goal-verifier-tools` MCP，使用 MiniMax-M3 和同一固定 guest 镜像。guest 的 `pi.sh` 在 `SIRNA_GOAL_VERIFIER=1` 时只启用 `mcp`，并加载 `goal-verifier-guard.mjs`；guard 会在 session 开始时把工具集合收紧到 MCP，并在更底层拒绝 `bash/read/write/edit` 等调用。

## 当前启用方式和边界

`apps/api/bootstrap.mjs` 现在支持三个模式：

- `SIRNA_GOAL_VERIFICATION=off`（默认）：不创建验证运行，不产生模型请求；
- `SIRNA_GOAL_VERIFICATION=deterministic`：使用本地确定性 verifier，继续作为离线回归路径；
- `SIRNA_GOAL_VERIFICATION=agent-compose`：创建独立 `goal-verifier` runtime，并使用上面的 Agent Compose adapter。

本轮还要处理一个与原仓库不同的部署适配：本项目的 API 进程在宿主机上，不能让 verifier guest 访问 guest 自己的 `127.0.0.1`。因此 `apps/api/bootstrap.mjs` 在显式设置 `SIRNA_GOAL_VERIFIER_API_HOST` 时，保留网页用的 `127.0.0.1:3000`，并复用同一个请求处理器在 Docker 私有网桥地址上开启第二个内部端口（默认 `172.18.0.1:3001`）。路由只额外允许这个明确的内部 host；没有设置环境变量时不会开启第二监听器。

远端启动入口是 `sh scripts/start-project-web-agent-compose.sh`。它设置 `SIRNA_GOAL_VERIFICATION=agent-compose`、内部网桥地址和端口；`agent-compose.yml` 中 verifier MCP 使用 `http://172.18.0.1:3001`。这相当于原仓库中 verifier 访问同一 Compose 网络内 `sirna-agent` 服务的效果，但没有把网页 API 暴露到服务器外网。若 Docker 网络被重新创建，应先用 `sh scripts/project-docker.sh network inspect sirna-pi_default` 读取新的 Gateway，再通过 `SIRNA_GOAL_VERIFIER_API_HOST` 覆盖默认值。

## 验收结果

本轮新增：

- `tests/goal-verification-agent-compose.test.mjs`：会话创建、run/session 标识、令牌脱敏、重试提示、唯一 JSON、runtime 事件适配、角色隔离和 guest guard；
- `tests/goal-verifier-mcp.test.mjs`：8 个工具、只读标记、逐工具必填字段、token-scoped 转发和后端错误；
- `apps/mcp/goal-verifier.mjs`：实际 MCP stdio server；
- `agent-compose.yml`、guest Dockerfile、`pi.sh`：独立 verifier profile 的静态接线。

定向运行结果为 29 项测试，28 项通过，1 项 Windows 平台跳过，0 项失败；新增的内部 listener 测试证明同一 API handler 可以安全复用且仍执行 host 白名单。远端已完成 guest 镜像构建、管理容器重建和配置发现；下一步是启动上述内部 API listener，使用 verifier guest 做无模型网络/MCP 回环验收，再决定是否进行一次受控 MiniMax verifier 请求。这一步不应与已有 designer 任务混用。
