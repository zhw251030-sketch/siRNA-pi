# 第13C-I步：验证 Attempt、诊断和阶段重试

## 为什么需要这一层

13C-H 已经能保证 evidenceId 来自后端，但 verifier 仍可能提交格式错误的 review，或者引用不存在的 evidenceId。原仓库不会因为一次协议错误就重新执行用户任务，也不会把这种错误当成业务验证失败；它会保存一次 attempt，生成针对某一阶段的修复反馈，最多重试三次。

本阶段把个人仓库的最小 attempt 记录升级为可审计的阶段重试流程。

## 与原仓库的对应关系

| 原仓库 | 学习版 | 作用 |
| --- | --- | --- |
| `goal-verification-store.ts` 的 `goal_verification_attempts` | `goal-verification-store.mjs` 的 `verification_attempts` | 保存 attempt 状态、session/run、prompt、raw proposal、diagnostics |
| `startAttempt/setAttemptIdentity/setAttemptPrompt/finishAttempt` | 同名 Store 方法 | 约束一次 attempt 的生命周期 |
| `GoalEvidenceReferenceError` | `goal-verification-policy.mjs` | 区分证据引用错误和普通 review 协议错误 |
| `repairContextReference()` | `goal-verification-coordinator.mjs` | 给下一轮 verifier 一个短的 `read_verification_attempt` 读取指针 |
| coordinator 的三次 bounded loop | `GoalVerificationCoordinator.runVerification()` | 最多三次，不重跑用户任务，不无限重试 |
| `read_verification_attempt` | `goal-verification-access.mjs` + `/attempt` POST 路由 | token-scoped 分页读取 diagnostics、proposal、prompt |

## Attempt 表保存什么

`verification_attempts` 现在包含：

```text
verification_id
attempt_number
status                 running/protocol_failed/accepted/error
verifier_session_id
verifier_run_id
prompt_text            保存前替换短期 access token
proposal_json          结构化 proposal（兼容字段）
raw_result_json        本次 verifier 返回的原始 JSON 对象
diagnostics             后端生成的诊断包
created_at/completed_at
```

字段都有上限：proposal 最多5MB，prompt最多500KB，diagnostics最多500KB。旧数据库如果只有 `running/accepted/error` 三种状态，启动时会迁移 attempt 表并保留旧记录。

## 失败和重试流程

```text
startAttempt(1)
  ↓
verifier.verify(run, token, signal, onStarted, retryFeedback, onPrompt)
  ↓
返回 proposal
  ├─ evidenceId 不存在
  │    → EVIDENCE_REFERENCE_INVALID
  │    → failedStage=resolve_evidence
  │    → protocol_failed
  │    → retryFeedback 指向 read_verification_attempt
  │
  └─ 结构或协议错误
       → VERIFIER_OUTPUT_INVALID
       → failedStage=review
       → protocol_failed
       → retryFeedback 指向 read_verification_attempt
```

如果 verifier 在没有返回 proposal 前就崩溃，这是基础设施错误，当前 attempt 直接记为 `error`。如果已经返回了 proposal 但后端解析失败，最多修复三次；第三次仍失败后，验证请求进入 error，Goal 进入 paused。

重试只重新调用 verifier 的 review 阶段，不重新执行用户任务，也不重新创建冻结 Bundle。`resolve_evidence` 错误和普通 `review` 错误使用不同的 code/stage，避免把“ID 写错”误诊成“任务执行失败”。

## 逐文件说明

### `goal-verification-store.mjs`

新增 `setAttemptIdentity()`、`setAttemptPrompt()`，扩展 `finishAttempt()` 接收 `protocol_failed`、session/run、raw proposal 和 diagnostics。`attemptRecord()` 对外返回审计所需的元数据，但不返回 access token。

### `goal-verification-coordinator.mjs`

协调器在开始新轮次前会发现并关闭上次进程遗留的 `running` attempt，然后从下一个 attempt 编号继续。调用 verifier 时传入：

```text
activeRun
accessToken
undefined signal
onStarted(sessionId, runId)
retryFeedback
onPrompt(prompt)
```

`onPrompt` 写库前会把短期 token 替换为 `[REDACTED_SHORT_LIVED_ACCESS_TOKEN]`。第一次未知 evidenceId 的反馈只包含修复指针和必要诊断，下一轮通过真实后端 evidenceId 重新提交即可。

### `goal-verification-access.mjs` 与 `apps/api/router.mjs`

新增：

```text
POST /v1/goal-verifications/:id/attempt
```

请求必须携带当前 verification 的 access token，并可按 `field=diagnostics|proposal|prompt` 和 offset/maxChars 分页。模型只能读取自己这次 verification 的 attempt 记录。

## 测试证据

新增测试覆盖：

- 第一次未知 evidenceId，第二次 `resolve_evidence` 重试成功；
- attempt 状态为 `protocol_failed → accepted`；
- session/run、脱敏 prompt、diagnostics 均持久化；
- 重启遗留的 running attempt 被关闭后从下一个编号继续；
- `/attempt` 只能通过 token 读取，并且正文不包含短期 token。

本阶段仍使用确定性 verifier 和 fake fetch，没有调用 MiniMax，也没有创建真实 Agent Compose verifier 容器。

本轮完整 `npm test` 结果为 **1571 项：1555 通过、16 个平台跳过、0 失败**。

## 当前整体进度

Goal 的后端验证协议现在已经具备：状态门控、不可变 Bundle、持久证据、token-scoped access、受控 scholarly search/fetch、随机 evidenceId、阶段诊断和有界重试。

还需要完成真实独立 Agent Compose verifier：把 review prompt、attempt retry feedback、`read_verification_attempt`、message/artifact/search/fetch/check 工具和最终 policy 结果接到真实容器中，再做一次真实模型端到端验收。
