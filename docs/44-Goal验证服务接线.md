# 第13C-D步：把 Goal Verification 接入网页服务生命周期

## 这一阶段解决什么问题

13C-A 到 13C-C 已经完成了后端验证闭环的核心零件：Goal 可以停在 `verifying`，Bundle 会冻结当时的消息、工具回执和任务文件，Coordinator 能调用 policy 决定 `complete`、`active` 或 `paused`。但是如果这些模块没有接进网页服务，浏览器提交的完成请求仍然看不到验证记录，服务启动和关闭也不会管理验证协调器。

本轮把这条链路接入现有 API，同时保持验证功能默认关闭：

```text
网页 PATCH /v1/tasks/:taskId/goal
        ↓
Goal API 先把 active 改成 verifying
        ↓
可选 Verification port 请求 Coordinator
        ↓
返回 HTTP 202 和 verification id
        ↓
GET /v1/tasks/:taskId/goal-verifications 查询记录
```

没有显式设置 `SIRNA_GOAL_VERIFICATION=deterministic` 时，普通网页任务仍走原来的 Goal API，不创建验证数据库，也不调用 verifier。

## 与原仓库的对应关系

| 原仓库 | 学习版 | 本轮作用 |
| --- | --- | --- |
| `apps/api/extensions/goal-verification-api.ts` | `packages/extensions/goal/goal-verification-runtime.mjs` | 统一创建可选 Store、BundleBuilder、Coordinator，并向 Goal API 提供窄 port |
| `apps/api/extensions/goal-api.ts` | `apps/api/goal-api.mjs` | Agent 的完成申请在存在 `verification.request()` 时返回 `202`，不直接声称完成 |
| `apps/api/router.ts` 中的验证读取路由 | `apps/api/router.mjs` 的 `goal-verifications` GET 路由 | 提供任务级验证列表和单条验证详情 |
| `apps/api/bootstrap.ts` | `apps/api/bootstrap.mjs` | 用环境变量决定是否创建验证运行时，并把它传给 HTTP 服务和 shutdown |
| `apps/api/service-lifecycle.ts` | `apps/api/service-lifecycle.mjs` | HTTP 监听成功后启动 Coordinator；关闭时先停止验证服务，再关闭存储 |

原仓库还把 verifier 专用的 evidence、artifact、message、attempt、check、search、fetch 访问接口放在独立扩展中。本轮只实现任务级列表和详情读取，暂不开放这些高权限读取入口；这样先验证网页状态和生命周期，再单独学习 EvidenceStore 与真实 Agent Compose verifier。

## 逐文件解释

### `goal-verification-runtime.mjs`：可选扩展的组装点

`createGoalVerificationRuntime()` 是一个工厂函数。它接收现有的 `TaskStore`、`TaskFiles` 和 `GoalStore`，然后依次创建：

1. `GoalVerificationStore`，保存 verification run 和 attempt；
2. `GoalVerificationBundleBuilder`，冻结任务当时可以看到的证据；
3. `GoalVerificationCoordinator`，负责请求去重、调用 verifier 和状态转换。

它返回的 `port` 只有三个网页服务需要的操作：

```js
{
  request(goal, trigger), // 发起一次验证
  list(taskId),            // 列出该任务的验证记录
  get(taskId, verificationId) // 读取并核对任务归属
}
```

Goal API 不需要知道 Store、Bundle 或 Coordinator 的具体类型。这个窄接口对应原仓库的端口分层，也保证未来替换 fake verifier 时不用改 HTTP 路由。

### `bootstrap.mjs`：默认关闭，显式打开

启动文件调用：

```js
enabled: process.env.SIRNA_GOAL_VERIFICATION === 'deterministic',
verifier: createDeterministicGoalVerifier(),
```

这里的 verifier 是 13C-C 用来练习协议的确定性假实现。它不调用 MiniMax、网络或 Docker。默认环境变量没有设置，因此 `goalVerification` 是 `undefined`；shutdown 的 stores 列表也不会加入验证数据库。

这一步保留了“功能存在”和“功能启用”两个概念：代码已经接好，但在真实 Agent Compose verifier 尚未完成之前，不能让普通网页任务意外进入验证流程。

### `goal-api.mjs`：完成申请的 HTTP 语义

`PATCH` 的 `complete` 请求仍然先调用 `goalStore.updateFromAgent()`。因此状态变化由 GoalStore 的 revision 门控决定，Agent 不能直接写 `complete`。当返回状态是 `verifying` 且存在 `verification.request` 时，API 再提交验证请求，并返回：

```json
{
  "goal": {"status": "verifying"},
  "verification": {"id": "...", "status": "waiting"}
}
```

HTTP `202 Accepted` 表示“验证请求已接受，结果尚未完成”。如果没有验证 port，旧的响应仍是 HTTP `200`，只返回 `goal`，所以默认关闭时既有网页行为保持不变。

### `router.mjs`：只读验证状态

新增两个 GET 形式：

```text
GET /v1/tasks/:taskId/goal-verifications
GET /v1/tasks/:taskId/goal-verifications/:verificationId
```

路由先确认任务存在，再通过 runtime port 查询。详情读取还会再次检查 `run.taskId`，避免拿一个任务的 verification id 读取另一个任务的记录。验证服务未启用时返回 `503`，任务不存在时返回 `404`。

### `service-lifecycle.mjs`：启动和关闭顺序

`startApiServices()` 只有在 HTTP server 已经监听成功后才调用 `goalVerification.start()`，和现有 maintenance、curation coordinator 的启动条件一致。`createApiShutdown()` 把验证服务放在 drain 列表最前面：

```text
停止接受新的验证工作
        ↓
关闭 HTTP server 并等待任务消息排空
        ↓
关闭所有 SQLite store 和 RPC
```

这样不会在数据库已关闭后仍有 Coordinator 写入验证结果。

## 本轮如何验证

定向命令：

```text
node --test tests/goal-api.test.mjs tests/goal-verification-lifecycle.test.mjs \
  tests/goal-verification-coordinator.test.mjs tests/goal-verification-bundle.test.mjs \
  tests/api-shutdown.test.mjs tests/curation-build-lifecycle.test.mjs
```

结果为 26 项通过、0 项失败。新增的两个行为检查是：

- `tests/goal-api.test.mjs`：启用验证 port 后，完成申请得到 `202`，Goal 是 `verifying`，列表和详情接口能读到同一个 verification id；
- `tests/goal-verification-lifecycle.test.mjs`：默认关闭时不创建 runtime；未监听的 server 不会启动 Coordinator；关闭顺序为 verification stop → HTTP close → message drain → store close。

随后运行了完整 `npm test`，结果为 1557 项测试、1541 项通过、16 项平台跳过、0 项失败。它覆盖 Goal、工具治理、Agent Compose 接线和既有网页合同。测试通过只说明接线和状态边界正确，不等于真实 Agent Compose verifier 已经实现，也不等于 Goal 已经可以被自动判定完成。

## 删除这一层会失去什么

如果删除 `goal-verification-runtime.mjs` 和 bootstrap 接线，13C-C 的 Coordinator 只能被单元测试调用，网页完成申请不会产生验证记录；如果删除 Goal API 的 `202` 分支，前端会把 `verifying` 误认为普通更新；如果删除 lifecycle 接线，服务重启或关闭时可能留下未排空的验证任务。它们共同把“验证模块”从独立库代码变成可控的网页服务能力。

## 下一步

下一步是实现受限 `EvidenceStore`/检索回执：验证器只能读取后端保存的来源摘要和检索结果，不能把自己写出的 URL 或引文当成事实证据。之后再把真实 Agent Compose verifier 接到同一个 port，并保留确定性 fake verifier 作为离线回归夹具。

