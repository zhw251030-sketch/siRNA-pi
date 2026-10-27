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

## 四次真实结果

### 第一次：字段契约不足

模型返回了接近自然语言的 `supported`、`criterionIds` 等字段，而策略实际读取 `claims[].verdict`、`requirements[].criterionId` 和 `requirements[].claimIds`。因此出现 `undefined` 字段和“未知验收项”。传输、容器启动和模型调用都成功，错误发生在结果解释层。

参考实现的 `packages/extensions/goal/agent-goal-verifier.ts` 会把 `goalVerificationProtocolContract()` 完整放入提示词；本仓库原先只给出顶层键名。修复位于 `packages/extensions/goal/goal-verification-agent-compose.mjs`：提示词现在公布完整的 `qualityReview`、`requirements`、`claims` 结构，并列出禁止的近似字段。

### 第二次：证据引用形状错误

模型已经使用了正确的 `criterionId` 和 `verdict`，但把证据写成字符串数组，而协议要求每项都是 `{ "evidenceId": "..." }`。原实现直接进入证据解析，报成“未知 evidenceId”。

修复位于 `packages/extensions/goal/goal-verification-policy.mjs`：先执行字段级校验；格式错误走 `VERIFIER_OUTPUT_INVALID` 的 review 修复路径，真实未知 ID 仍走 `EVIDENCE_REFERENCE_INVALID` 的 resolve-evidence 路径。`tests/goal-verification-coordinator.test.mjs` 新增了 malformed evidence 的两次尝试回归。

### 第三次：确定性检查证据已建立，但模型带入无关产物声明

第三次结果被协议层接受，工具回执和 `check_verification_artifact` 都已经进入冻结 bundle。策略正确识别出健康探针满足执行标准，但模型额外生成了 `numbers.csv` 事实，并把 `deterministic_check` 与 artifact 证据混用；旧策略只认可 `artifact_read`，因此报告了 `EVIDENCE_METHOD_MISMATCH`。这次没有 `undefined` 字段、未知验收项或无效 evidence 引用。

### 第四次：Goal 通过

策略层补齐了原仓库的 `deterministic_check` 规则：

- 证据 URL 必须是后端生成的 `check://{id}`；
- `getCheck(id)` 必须在当前 verification 范围内存在；
- 只有 `result.passed === true` 才能支撑 artifact/objective 事实或 execution 类验收项；
- 携带伪造 `retrievalId` 的检查证据会 fail-closed。

同时，验证提示明确规定没有问题时 `qualityReview.issues` 必须是空数组 `[]`，不能写“无未解决问题”占位字符串。第四次 Verification `398b298e-63c0-49b8-aa39-3a4027b5138b` 状态为 `passed`，Goal 最终状态为 `complete`。这次没有重新执行任务；它复用了同一个真实工具回执，只重新冻结并验证了证据，符合原仓库“验证失败回到 active、修复后重新验证，不重复用户任务”的语义。

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

`goal-verification-policy.mjs` 现在还与原仓库 `goal-verification-policy.ts` 对齐了 `deterministic_check`、verification-scoped `getCheck`、通过检查支撑 artifact/objective/execution 的规则；`tests/goal-verification-policy.test.mjs` 覆盖通过检查、未知检查和带伪造 retrieval ID 的 fail-closed 行为。

本轮最终证明了独立容器、内部网络、模型调用、冻结 bundle、工具回执、确定性检查、策略判定和 Goal 状态转换可以连通。它仍然是一个最小网络接线测试，不代表完整业务任务上的普适成功率；下一步应把同样的验证链路用于真实文件产出、受控检索和失败后修订场景。
