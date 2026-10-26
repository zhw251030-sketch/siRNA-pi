# 第13C-A步：Goal 完成验证门控

## 这一阶段解决什么问题

13B 已经能在任务空闲时派发自动回合，但 13A/13B 仍然允许 Agent 在完成计划后直接把 Goal 写成 `complete`。原仓库把这个边界拆成两步：Agent 只能提交完成申请，后端把状态变成 `verifying`；只有独立验证流程确认冻结证据后，才允许 `completeVerified`。

本轮先完成这层状态门控，不启动真实 verifier、不调用 MiniMax、不冻结任务文件。下一轮再实现消息、运行事件、工具回执和任务文件的不可变 Verification Bundle。

## 参考仓库对应关系

| 原仓库 | 学习版 | 本轮作用 |
| --- | --- | --- |
| `packages/extensions/goal/goal-store.ts:updateFromAgent` | `packages/extensions/goal/goal-store.mjs:updateFromAgent` | Agent 的 `complete` 只进入 `verifying` |
| `goal-store.ts:completeVerified` | `goal-store.mjs:completeVerified` | 独立验证通过后才进入 `complete` |
| `goal-store.ts:continueAfterVerification` | `goal-store.mjs:continueAfterVerification` | 内容证据不足，返回 `active` 并保存反馈 |
| `goal-store.ts:pauseAfterVerification` | `goal-store.mjs:pauseAfterVerification` | 验证基础设施失败，进入 `paused` |
| `goal-store.ts:requestCheckpoint` | `goal-store.mjs:requestCheckpoint` | 阶段检查进入 `verifying`，不代表整个 Goal 完成 |
| `goal-store.ts:continueAfterCheckpoint` | `goal-store.mjs:continueAfterCheckpoint` | 阶段检查结束后恢复 active |
| `apps/api/extensions/goal-api.ts` | 当前 `apps/api/goal-api.mjs` | 当前 Agent API 已能返回 `verifying`；专用 verifier API 留后续 |

## 状态变化

```text
active --Agent complete申请--> verifying --独立验证通过--> complete
                                      \--证据不足--> active + feedback
                                      \--验证服务故障--> paused

active --checkpoint--> verifying --阶段检查结束--> active
```

### 为什么必须经过 `verifying`

模型的最终文字只说明模型声称完成了什么，不能证明文件、工具回执和执行轨迹真的支持这个结论。如果允许 `active → complete`，任何一句“已经完成”都会绕过后端检查。`verifying` 是一个不可自动续作的中间态：协调器只扫描 `active`，因此验证期间不会继续消耗自动回合。

### `completeVerified` 的 revision 保护

完成申请会把 Goal 的 revision 加一。验证器必须提交它看到的 revision；如果在验证期间用户暂停、恢复或其他操作改变了 Goal，旧验证结果就会因 revision 不匹配而被拒绝。这避免“旧证据完成新目标”。

### 失败与基础设施故障的区别

- `continueAfterVerification` 表示验证器确实读到了证据，但发现缺少文件、工具结果或验收条件；Goal 回到 `active`，反馈会放入下一轮自动提示。
- `pauseAfterVerification` 表示验证服务本身出错、证据无法读取或协议无法恢复；Goal 进入 `paused`，避免 Agent 为验证器故障浪费自动回合。
- `requestCheckpoint` 只做阶段审查，审查结束恢复 `active`，不能把中间检查当成整个 Goal 完成。

## 修改文件

- `packages/extensions/goal/goal-store.mjs`：增加 `completeVerified`、`continueAfterVerification`、`pauseAfterVerification`、`requestCheckpoint`、`continueAfterCheckpoint`，并把 Agent 的完成申请改为 `verifying`。
- `tests/goal-core.test.mjs`：覆盖完成门控、revision 冲突、验证失败反馈、基础设施暂停和 checkpoint。
- `tests/goal-api.test.mjs`：确认 HTTP 的 Agent 完成申请返回 `verifying`，不会直接返回 `complete`。

## 当前验收边界

本轮证明的是后端状态机：Agent 自报完成不能直接写入终态，只有带正确 revision 的独立验证路径才能完成。它还没有证明验证器真的检查了文件或工具回执，因为 Verification Bundle、policy 和独立 verifier 尚未实现。

