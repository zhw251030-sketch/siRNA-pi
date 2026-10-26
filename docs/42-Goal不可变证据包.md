# 第13C-B步：Goal 不可变 Verification Bundle

## 这一阶段解决什么问题

13C-A 已经把 Goal 完成申请拦在 `verifying`，但验证器还没有固定自己能看到的证据。如果验证期间任务文件继续变化，验证器可能看到“申请完成之后”才产生的内容，结果就无法回答：它验证的到底是哪一个时刻的任务？

本轮实现原仓库 `GoalVerificationBundleBuilder` 的最小核心：在验证开始时把消息、工具回执和输入/输出文件复制到独立快照目录，并给每个对象保存 SHA-256。验证器后续只应读取这个快照。

## 参考仓库与学习版的对应关系

| 原仓库 | 学习版 | 作用 |
| --- | --- | --- |
| `packages/extensions/goal/goal-verification-bundle.ts` | `packages/extensions/goal/goal-verification-bundle.mjs` | 生成不可变验证包、文件快照和读取校验 |
| `TaskStore.listMessages()` | `packages/task-core/task-store.mjs:listMessages()` | 冻结用户/助手消息和正文哈希 |
| `TaskStore.listRunEvents()` | `packages/task-core/task-store.mjs:listRunEvents()` | 收集工具结束回执，不把完整敏感参数写入验证包 |
| `workspaceFiles.list/read` | `TaskFiles.list/read` 或本轮测试假接口 | 冻结任务 input/output 文件 |
| `extractGoalAcceptanceCriteria()` / `artifactQualityFlags()` | `extractGoalAcceptanceCriteria()` / `qualityFlags()` | 从目标文字生成后端验收条件，标记输出中可能诱导 verifier 的指令 |
| `GoalVerificationBundle.bundleSha256` | `goal-verification-bundle.mjs:bundleSha256` | 绑定整个验证包内容 |

## Bundle 中保存什么

验证包的顶层身份包括：

```text
protocolVersion
verificationId
trigger
taskId
goalId
goalRevision
objective
acceptanceCriteria
requestedAt
messages
artifacts
toolReceipts
bundleSha256
```

`goalRevision` 是关键绑定。一个验证包只对应某一版本的 Goal；如果用户在验证期间改变 Goal，旧包不能被当作新目标的证据。

`acceptanceCriteria` 由后端从目标文字拆出，而不是让 verifier 自己发明标准。它与原仓库一样区分 `external`（文献、来源、实验或数据）、`execution`（运行、测试、计算）和 `artifact`（报告、文件、表格）证据；没有明显类型时才使用 `independent`。目标写出“至少 3 篇文献”时还会保存 `minimumExternalSources: 3`，供后续 policy 强制检查。

### 消息

每条消息保存：

- 消息 ID、角色和顺序；
- 正文；
- 消息状态和创建时间；
- 正文 SHA-256。

消息哈希用于检测保存内容是否被修改。后续访问服务仍应按权限分页返回消息，不能把大段原文一次性暴露给验证器。

### 工具回执

只记录 `tool_end` 事件，保存：

- 事件、运行和用户消息身份；
- 工具名和是否报错；
- 工具输入的哈希；
- 工具结果的哈希；
- 经过限制和脱敏的结果预览。

`authorization`、`cookie`、`apiKey`、`accessToken`、`password`、`secret` 等字段会变成 `[REDACTED]`，字符串中的 Bearer/Basic 凭据也会被替换。这样 verifier 可以知道“哪个工具返回了什么结构”，但不需要获得主机凭据。

输出文件还会被扫描是否包含 `verifier must/read`、`verified_quote`、`fact-q` 等提示词；命中后只写入 `qualityFlags: ["embedded_verifier_instructions"]`，不会把文件直接判为错误。后续 policy 再决定这类文件能否作为独立证据。

### 任务文件

每个输入或输出文件先由 `workspaceFiles.list()` 提供大小和哈希，再通过 `workspaceFiles.read()` 读取实际字节。实际网页接线传入完整的 `TaskStore.getTask(taskId)` 记录，因此 Agent Compose 文件解析仍能使用 `executionSessionId`；两次信息不一致就拒绝冻结，避免文件在枚举和复制之间被替换。

快照保存到：

```text
runtime/goal-verifications/<verificationId>/
  bundle.json
  artifacts/input/...
  artifacts/output/...
```

快照文件使用独占创建和受限权限。`readArtifact()` 每次重新计算文件大小和 SHA-256；即使攻击者修改了验证快照，也不能得到一个看起来正常的证据。

## 为什么还没有实现完整 verifier

Bundle 只解决“验证器看到什么”。它还没有回答“这些证据是否支持目标完成”。原仓库把后一个问题放在：

- `goal-verification-policy.ts`：检查证据类型和验收条件；
- `goal-verification-evidence-resolver.ts`：把证据 ID 解析为后端创建的证据单元；
- `goal-verification-coordinator.ts`：调用独立 verifier，并根据 pass/fail/error 调用 GoalStore 的不同状态转换。

因此本轮不把“有 bundle”写成“已验证完成”，也不调用模型。下一步将先实现本地确定性读取和 policy 假 verifier，再考虑真实独立 Agent Verifier。

## 验收结果与边界

本轮测试证明：

- 验证包绑定 `taskId/goalId/goalRevision`；
- 消息、工具回执和文件都有哈希；
- 工具结果中的敏感字段不会出现在 bundle JSON；
- 源任务文件在冻结后变化，不会改变已保存快照；
- 快照自身被篡改时 `readArtifact` 会拒绝；
- 非 `verifying` Goal 不能创建 completion verification bundle。

这仍然不是完整 Goal 验证器，也没有证明任务内容正确，只建立了可信证据输入边界。