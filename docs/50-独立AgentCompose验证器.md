# 第 13C-J 步：独立 Agent Compose Verifier 的真实接线与 Goal 验收

日期：2026-10-27。离线接线、内部网络回环和一次受控真实 MiniMax 验收均已完成。

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

本轮还要处理一个与原仓库不同的部署适配：本项目的 API 进程在宿主机上，不能让 verifier guest 访问 guest 自己的 `127.0.0.1`。因此 `apps/api/bootstrap.mjs` 在显式设置 `SIRNA_GOAL_VERIFIER_API_HOST` 时，保留网页用的 `127.0.0.1:3000`，并复用同一个请求处理器在 Docker 私有网桥地址上开启第二个内部端口（默认 `172.18.0.1:3001`）。远端验收时按用户确认绑定到 `192.168.1.169:3001`；路由只额外允许这个明确的内部 host，没有把网页 API 暴露到服务器外网。

远端启动入口是 `sh scripts/start-project-web-agent-compose.sh`。它设置 `SIRNA_GOAL_VERIFICATION=agent-compose`、内部地址和端口；`agent-compose.yml` 中 verifier MCP 使用 `http://192.168.1.169:3001`。这相当于原仓库中 verifier 访问同一 Compose 网络内 `sirna-agent` 服务的效果，但没有把网页 API 暴露到服务器外网。若 Docker 网络被重新创建，应先读取新的可达地址，再通过 `SIRNA_GOAL_VERIFIER_API_HOST` 覆盖默认值。

## 验收结果

本轮新增：

- `tests/goal-verification-agent-compose.test.mjs`：会话创建、run/session 标识、令牌脱敏、重试提示、唯一 JSON、runtime 事件适配、角色隔离和 guest guard；
- `tests/goal-verifier-mcp.test.mjs`：8 个工具、只读标记、逐工具必填字段、token-scoped 转发和后端错误；
- `apps/mcp/goal-verifier.mjs`：实际 MCP stdio server；
- `agent-compose.yml`、guest Dockerfile、`pi.sh`：独立 verifier profile 的静态接线。

定向离线测试、内部 listener 测试和策略回归全部通过；最新完整 `npm test` 为 1602 项，1586 通过、16 项 Windows 平台跳过、0 失败。远端健康 Goal `55426f18-22b1-4088-99ac-eb7378a58149` 和真实文件 Goal `2a91d8b1-faa4-46d7-a9d7-158a64e9a754` 均已通过，后者的 Verification `7e17a510-b9e9-403e-9725-5c52213f7eb7` 为 `passed`，同时包含 2 个 artifact 和 3 个成功工具回执。文件验收期间还补齐了原仓库的非 JSON 输出 `protocol_failed` 重试：格式错误只生成 attempt 诊断和修复提示，不重新执行用户任务。

第13C-L 又把 Goal 反馈续跑接入真实网页服务：`apps/api/goal-api.mjs` 创建参考仓库同形状的 `turnPort`，`bootstrap.mjs` 和 `service-lifecycle.mjs` 负责启动、停止和排空，`TaskMessageService` 暴露空闲/待输入门控。新增的 policy 回放覆盖合法 retrieval external claim、artifact 错绑和多来源 source-specific claim；并修复合法 retrieval claim 被无条件误拒绝的问题。服务器重启后历史 Goal 确实自动收到包含 `latestVerificationFeedback` 的下一轮消息，说明持久 Goal、lease 和真实 Agent turn 已接通；由于执行 Agent 没有学术检索工具，历史实验最终暂停保留证据，没有被写成业务成功。详见 [Goal反馈续跑实时验收](analysis/2026-10-27-goal-coordinator-live.md)。

本轮还把职责边界写入执行 Agent 的 Agent Compose `designer` system prompt 和 Goal continuation prompt：执行 Agent 只使用 `sirna-tools`，不得调用 verifier-only 的 scholarly search/fetch 或伪造 `retrievalId/evidenceId`；需要外部事实时保存 DOI、PMID、URL、标题和对应结论，交给独立 verifier 重新检索。配置回放和续跑提示回放均覆盖这一约束。

随后又完成执行侧 Goal 工具的真实网络验收。参考仓库中执行 profile 访问主服务的 `/v1/tasks/:taskId/goal`；个人版网页服务仍只监听 `127.0.0.1:3000`，所以 `192.168.1.169:3001` 内部 listener 现在额外允许当前任务的 Goal 路由，但必须通过 `toolCallLeases` 的 Bearer token、taskId 和 agentTurnId 校验。`packages/extensions/goal/goal-tools.mjs` 发送相同的任务能力头，`apps/api/bootstrap.mjs` 注入共享 Goal API 与 leases；其它网页路由仍被拒绝。真实验收中 `get_goal` 和 `update_goal` 均成功，`step-1` 完成且 revision 推进。逐文件记录见 [Goal 工具真实接线验收](analysis/2026-10-28-goal-tools-live.md)。

随后修复了执行侧 Goal 工具缺口：参考仓库的 `application-profile` 会把 `get_goal`、`create_goal`、`update_goal` 合并进 `sirna-tools` MCP；个人版现在由 `apps/mcp/remote-server.mjs` 通过 `SIRNA_TOOL_REGISTRY_URL` 注入同一组工具，`apps/mcp/approved-server.mjs` 负责发布并区分只读/写入标记。这样执行 Agent 可以更新 Goal 进度，但仍看不到 `goal-verifier-tools` 的 scholarly search/fetch。

部署时还必须同步更新 guest 镜像：`containers/agent-compose-guest/Dockerfile` 显式复制 `packages/extensions/goal/goal-tools.mjs`，并由 `apps/mcp/remote-server.mjs` 默认读取 `/workspace/.sirna-task-context.json`。否则前者会让 guest 导入失败、后者会让 Goal tools 找不到任务身份；两种错误都会表现为普通的 MCP 工具失败，而不是一个可读的 Goal 状态错误。

13C-K 的受控外部检索实验见 [独立记录](analysis/2026-10-27-controlled-retrieval-goal.md)。它没有被写成成功闭环：OpenAlex/Europe PMC 的真实 retrieval receipt 已经由 verifier 取得，但执行 Agent 没有学术检索工具；现在后端已经锁定 external/artifact/source-counting 证据约束，下一步仍需在有限预算的新 Goal 中提供执行侧检索能力或明确采用 verifier-only retrieval，再验证失败后一次修订能否最终通过。
