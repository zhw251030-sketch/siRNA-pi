# 2026-10-27 Agent Compose Goal 验证器网络接线记录

## 目的

本轮验证一个最小的真实闭环：个人仓库的 Goal 完成请求能否由独立的 Agent Compose `goal-verifier` 容器接收，并通过服务器内部的验证 API 访问入口。验证器容器使用 `192.168.1.169:3001`，项目网页仍监听 `127.0.0.1:3000`。

## 实际链路

```text
Goal PATCH complete
  -> GoalStore: active -> verifying
  -> GoalVerificationCoordinator: 冻结 bundle、签发短期 token
  -> Agent Compose: 创建 goal-verifier sandbox
  -> Pi/MiniMax-M3: 读取只读 MCP 工具
  -> 192.168.1.169:3001: token-scoped verification access
  -> policy: 解析证据并决定 pass/fail
```

`apps/api/bootstrap.mjs` 启动两个监听器：网页接口只对本机开放；内部 listener 复用同一个路由处理器，但 `apps/api/goal-verifier-internal-listener.mjs` 只允许 `/health` 和 `/v1/goal-verifications/{id}/{operation}`。`apps/api/router.mjs` 再用 host allow-list 和短期 token 做第二层约束。这样 Agent Compose 容器能访问验证服务，却不能把整个网页 API 当作工具网关。

## 三次真实结果

### 第一次：字段契约不足

模型返回了接近自然语言的 `supported`、`criterionIds` 等字段，而策略实际读取 `claims[].verdict`、`requirements[].criterionId` 和 `requirements[].claimIds`。因此出现 `undefined` 字段和“未知验收项”。传输、容器启动和模型调用都成功，错误发生在结果解释层。

参考实现的 `packages/extensions/goal/agent-goal-verifier.ts` 会把 `goalVerificationProtocolContract()` 完整放入提示词；本仓库原先只给出顶层键名。修复位于 `packages/extensions/goal/goal-verification-agent-compose.mjs`：提示词现在公布完整的 `qualityReview`、`requirements`、`claims` 结构，并列出禁止的近似字段。

### 第二次：证据引用形状错误

模型已经使用了正确的 `criterionId` 和 `verdict`，但把证据写成字符串数组，而协议要求每项都是 `{ "evidenceId": "..." }`。原实现直接进入证据解析，报成“未知 evidenceId”。

修复位于 `packages/extensions/goal/goal-verification-policy.mjs`：先执行字段级校验；格式错误走 `VERIFIER_OUTPUT_INVALID` 的 review 修复路径，真实未知 ID 仍走 `EVIDENCE_REFERENCE_INVALID` 的 resolve-evidence 路径。`tests/goal-verification-coordinator.test.mjs` 新增了 malformed evidence 的两次尝试回归。

### 第三次：协议正确，业务证据不足

第三次结果被协议层接受，策略得到的是合理的业务失败：当前 Goal bundle 没有输出 artifact，也没有成功的工具回执，只有用户消息和受控检索记录，因此不能证明“内部健康接口确实被执行并返回成功”。这次没有 `undefined` 字段、未知验收项或无效 evidence 引用。

这不是网络链路失败，而是证据闭环尚未建立。要让该 Goal 通过，后续需要在任务执行侧产生一个真实的 health probe 工具回执，或把 probe 输出保存为冻结 artifact，再由 verifier 用 `list_verification_evidence` 和 `check_verification_artifact` 引用。

## 额外修复：受控 fetch 路由

真实模型曾调用 `fetch_verification_source`，暴露出 HTTP 分派错误：访问层方法名是 `fetchSource`，但 `handle('fetch', ...)` 直接查找 `service.fetch`。现在 `packages/extensions/goal/goal-verification-access.mjs` 显式把 `fetch` 映射到 `fetchSource`，`apps/api/router.mjs` 对 search/fetch 传递 20 秒 AbortSignal；`tests/goal-verification-access.test.mjs` 覆盖了这条通路。

## 对原仓库的对应关系

| 本仓库 | 原仓库对应机制 |
| --- | --- |
| `goal-verification-agent-compose.mjs` | `packages/extensions/goal/agent-goal-verifier.ts` |
| `goal-verification-policy.mjs` | `packages/extensions/goal/goal-verification-policy.ts` 与结果契约校验 |
| `goal-verification-coordinator.mjs` | `packages/extensions/goal/goal-verification-coordinator.ts` 的 attempt/retry 生命周期 |
| `goal-verification-access.mjs`、`goal-verification-evidence.mjs` | Goal verification access service 与 controlled retrieval |
| `goal-verifier-internal-listener.mjs` | 原项目中 Agent Compose 与 API 的内部服务边界 |

本轮证明了独立容器、内部网络和模型调用可以连通，也证明了策略会拒绝没有执行证据的完成声明；它还没有证明 Goal 可以通过，因为真正的执行回执尚未进入该任务的冻结 bundle。
