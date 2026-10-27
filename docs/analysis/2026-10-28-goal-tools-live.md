# 2026-10-28 执行 Agent Goal 工具真实接线验收

## 这一步为什么必须做

上一轮已经把 `get_goal`、`create_goal`、`update_goal` 放进执行 Agent 的 `sirna-tools` 工具目录，但真实调用仍失败。原因不是 MCP schema，而是地址边界：

- 参考仓库的执行 Agent 通过 `SIRNA_TOOL_REGISTRY_URL` 访问主服务的 `/v1/tasks/:taskId/goal`；
- 本项目网页 API 只监听 `127.0.0.1:3000`；
- 为独立 verifier 建立的 `192.168.1.169:3001` listener 当时只允许 `/v1/goal-verifications/:verificationId/...`，会拒绝任务 Goal 路由。

因此执行 Agent 能看到工具，却无法读写自己的 Goal。这是“工具发现成功、运行时授权失败”的典型分层问题。

## 代码变化

### 1. `packages/extensions/goal/goal-tools.mjs`

参考仓库的 `goal-tools.ts` 使用任务上下文发请求。本地实现现在把上下文里的 64 位 token 作为：

```text
Authorization: Bearer <token>
x-sirna-task-id: <taskId>
x-sirna-agent-turn-id: <agentTurnId>
```

这样 Goal API 请求与 `sirna-tools`、builder、gap API 使用同一种任务能力凭证，不再只有可伪造的 taskId 标头。

### 2. `apps/api/goal-verifier-internal-listener.mjs`

内部 listener 仍然只允许三类入口：`/health`、verifier 的只读证据操作、当前任务的 `/v1/tasks/:id/goal`。Goal 路由只接受 `GET`、`POST`、`PATCH`，并要求：

1. URL 中的 taskId 等于 `x-sirna-task-id`；
2. `Authorization` 是合法 Bearer token；
3. `x-sirna-agent-turn-id` 与 token 属于同一 `toolCallLease`；
4. `POST/PATCH` 还必须处于已经激活的 Agent turn。

通过后才把请求转交给原有 `goalApi.handle()`。所以这层增加的是“内部可达的任务级 Goal API”，没有把 `/v1/tasks`、消息、文件或其它网页接口暴露到 3001。

### 3. `apps/api/bootstrap.mjs`

启动内部 listener 时同时注入 `server.goalCoordinator` 和共享 `toolCallLeases`。前者继续负责 GoalStore、计划和 coordinator，后者负责请求身份，职责与参考仓库的主服务任务上下文校验相对应。

## 测试和真实结果

- `tests/api-internal-listener.test.mjs` 新增授权 Goal 转发和无 token 拒绝；
- `tests/goal-tools.test.mjs` 新增 Bearer token 断言；
- 完整 `npm test`：1602 项，1586 通过，16 项 Windows 平台跳过，0 失败；
- 提交：`a9ae257 fix: authorize internal Goal API calls`。

服务器上的真实任务 `32514eff-778e-4480-8e93-a9e50989defb` 使用一个必需项 `step-1` 和 1 个自动回合预算。Agent 事件顺序为：

```text
sirna_tools_get_goal       -> 成功
sirna_tools_update_goal    -> 成功
```

`step-1` 从 `pending` 变为 `done`，Goal revision 从 5 变为 6；任务回到 `idle`，3000 和 3001 健康检查均返回 `ready:true`。验收 Goal 随后被显式暂停，避免继续消耗回合。

部署时 npm registry 曾发生 idle timeout，未能重新下载依赖；已复用服务器已有的锁定 guest 镜像，只替换本轮新增的 `goal-tools.mjs`，并用镜像文件哈希和真实 MCP 调用验收。这不会改变依赖版本，但说明后续正式部署仍应准备镜像构建缓存或可用的 npm 镜像。

## 与原仓库的对应关系和边界

这一步对应原仓库 `src/mcp-server.ts` 中把 Goal tools 注入执行 profile、`packages/extensions/goal/goal-tools.ts` 中的 task request headers，以及主服务 `/v1/tasks/:taskId/goal` 路由。个人版因为 API 与 guest 不在同一个 Compose 服务中，增加了一个受能力令牌保护的内部桥接 listener。

这证明的是 Goal 工具的真实传输、授权和持久写入，不证明 Goal 验证策略、外部学术检索或自动自进化效果。下一步应在这个已打通的基础上做一个新的、短预算的“反馈 → 一次修订 → 独立 verifier”实验，并保持执行 Agent 与 verifier 的工具边界。
