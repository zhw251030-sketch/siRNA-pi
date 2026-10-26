# 第13C-C步：Goal Verification Store、Evidence Resolver、Policy 与 Coordinator

## 这一阶段解决什么问题

13C-B 已经把验证开始时的消息、工具回执和任务文件冻结下来，但“有一份 Bundle”仍然不等于“Goal 已完成”。本轮补上原仓库中真正决定完成与否的后端层：保存验证请求、把 verifier 提交的证据编号解析为后端实际拥有的证据、执行确定性 policy，并把结果安全地写回 Goal。

## 对照原仓库的职责

| 原仓库 | 学习版 | 本轮职责 |
| --- | --- | --- |
| `goal-verification-store.ts` | `goal-verification-store.mjs` | SQLite 保存 waiting/running/passed/failed/error 请求、Bundle、评估结果和 attempts |
| `goal-verification-evidence-resolver.ts` | `goal-verification-policy.mjs:verificationEvidenceUnits/resolveVerificationProposal` | 从 Bundle 生成后端拥有的 `artifact:*`、`tool:*`、`message:*` evidenceId；拒绝模型伪造 ID |
| `goal-verification-policy.ts` | `goal-verification-policy.mjs:evaluateVerificationResult` | 独立检查证据方法、成功工具回执、文件证据、验收项覆盖和质量检查 |
| `goal-verification-coordinator.ts` | `goal-verification-coordinator.mjs` | 绑定 Goal revision，生成 Bundle，调用 verifier，处理重复、失败和状态转换 |
| `agent-goal-verifier.ts` | `goal-verification-fake.mjs` | 本轮用确定性假 verifier 练习协议；暂不启动真实 Agent Compose |

## 输入如何流动

```text
Agent 的 complete 请求
        ↓ 13C-A
Goal: active → verifying, revision=n
        ↓ Coordinator.request
VerificationStore: waiting
        ↓ BundleBuilder
VerificationStore: pending + bundle(goalRevision=n)
        ↓ Fake/真实 verifier 的 proposal
EvidenceResolver: evidenceId 必须来自后端 Bundle
        ↓ Policy
pass → Goal.completeVerified(taskId, n)
fail → Goal.continueAfterVerification(taskId, n, feedback)
error/stale → Goal.pauseAfterVerification(taskId, n, reason)
```

关键点是 verifier 只能提出 proposal。它不能直接把 Goal 写成 complete，也不能在 JSON 中自写一个看似可信的 URL、文件哈希或检索摘要。Policy 重新检查这些证据是否与 Bundle 中的真实对象匹配。

## 当前确定性 Policy 检查什么

- `artifact_read` 必须对应 Bundle 中真实的 input/output 文件；
- `tool_receipt` 必须对应真实 `tool_end`，并且成功工具回执才能支持 `tool_result`；
- `external_fact` 在本轮没有网络检索单元时不能通过；
- 每个 `acceptanceCriteria` 必须出现一次、状态为 `satisfied`，并且关联的 claim 必须是 supported；
- `external`、`execution`、`artifact` 类验收条件必须分别有对应类别的 claim；
- 目标要求的 `minimumExternalSources` 没有足够独立来源时失败；
- 输出文件包含面向 verifier 的嵌入式协议指令时失败；
- 只要重要 claim 不是 supported，或者 pass 的四项质量检查不全为 pass，最终决策就是 fail。

## 为什么先用假 verifier

原仓库的 `AgentGoalVerifier` 是一个独立 Agent Compose 会话，它没有执行 Agent 的历史记忆，只能通过验证工具读取 Bundle。这个运行层依赖 Compose 容器、访问令牌、严格 JSON contract 和真实文件读取。若在 policy 尚未固定前直接接模型，模型输出中的格式错误、证据引用错误和基础设施错误会混在一起，难以判断是哪一层的问题。

所以本轮 `goal-verification-fake.mjs` 用固定规则生成 proposal：有成功工具回执就提出 `tool_result`，有 output 文件就提出 `artifact`；没有证据就提出 `insufficient_evidence`。它不是研究结果，也不代表真实模型能力，只用于验证后端状态机和拒绝边界。

## 验收与边界

新增 6 项协调器测试，并与 Goal、Bundle、API、工具和自动续作测试合计 32 项定向测试全部通过。已验证：持久化去重、通过后 complete、policy fail 后 active、verifier 异常后 paused、过期 revision 不覆盖新 Goal、未知 evidenceId 拒绝并暂停。

本轮没有接入 HTTP API、bootstrap、网络检索或真实 verifier；也没有产生模型请求。下一步应先把 Verification Coordinator 以默认关闭方式接入服务生命周期和 Goal API，再单独实现受限的 EvidenceStore/检索回执，最后才接 Agent Compose 独立 verifier。
