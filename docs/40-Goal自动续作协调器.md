# 第13B步：Goal 自动续作协调器

## 这一阶段解决什么问题

13A 已经能保存 Goal，但“保存一个目标”和“服务在用户离开后继续做一小步”是两件事。13B 增加调度内核：它定期扫描 active Goal，在任务确实空闲、没有待处理用户输入时，领取一次有时限的 lease，然后把一个带有 Goal 上下文的继续提示交给执行端。

本轮只验证调度逻辑，默认不连接真实 `TaskMessageService`，因此不会因为启动网页服务而自动调用 MiniMax 或其他模型。这个边界对应原仓库的分层：`GoalCoordinator` 只负责何时派发和如何记录结果，具体执行仍通过 `GoalTurnPort`，完成是否真实、是否有工具动作要由后续执行器和 verifier 判断。

## 参考仓库与学习版的对应关系

| 参考仓库 | 学习版 | 作用 |
| --- | --- | --- |
| `packages/extensions/goal/goal-coordinator.ts` | `packages/extensions/goal/goal-coordinator.mjs` | 周期扫描、空闲/用户输入门控、租约、请求 ID、退避和唤醒 |
| `packages/extensions/goal/goal-store.ts:releaseLease` | `packages/extensions/goal/goal-store.mjs:releaseLease` | 执行端未接受派发时清理 lease 并退还本轮预算 |
| `packages/extensions/goal/goal-store.ts:acquireLease` | `packages/extensions/goal/goal-store.mjs:acquireLease` | 以 SQLite 事务领取一个自动回合 |
| `packages/extensions/goal/goal-store.ts:completeLease` | `packages/extensions/goal/goal-store.mjs:completeLease` | 把 accepted 回合的 success/productive/error 结果写回 Goal |
| `packages/task-core/task-message-service.ts` | `packages/task-core/task-message-service.mjs` | 后续真实适配的任务消息执行端；本轮没有直接接入 |

## 逐文件解释

### `goal-store.mjs`：补上“派发未被接受”的事务

`acquireLease` 会把 `automaticTurnsUsed` 加一，因为它先预留一个自动回合，防止两个协调器同时派发同一目标。可是任务服务可能因为任务刚变忙、请求重复或运行时不可用而没有接受请求。这种情况不是一次真正消耗的回合，所以 `releaseLease(taskId, leaseId, true)` 会在 leaseId 仍匹配时清掉租约，并把预算减回去；如果 leaseId 不匹配，则不碰别人的租约。这个操作和原仓库的事务语义一致。

### `goal-coordinator.mjs`：把“是否自动续作”变成受控状态机

- `start()` 先执行 `expireLeasesForRecovery()`，回收上一次进程崩溃后遗留的 active lease，再启动周期扫描。
- `runOnce()` 只枚举 `GoalStore.listActive()`，每个任务交给 `runTask()`。
- `runTask()` 先做进程内的 `runningTasks` 去重，再检查 Goal 状态、失败退避、`port.isIdle()` 和 `port.hasPendingUserInput()`。
- 通过检查后调用 `acquireLease()`，并生成稳定的 `goal:<goalId>:<automaticTurnNumber>` requestId。这个 ID 让真实消息层可以做请求去重，也让一次自动回合有明确的审计关联。
- `goalContinuationPrompt()` 将 objective、回合编号、有限计划和 verifier 反馈放入提示，并要求 Agent 先执行工作项，再调用 `update_goal`；它不能仅凭一句文字把 Goal 变成 complete。
- `accepted=false` 时调用 `releaseLease(..., true)`；`accepted=true` 时调用 `completeLease()`。
- 失败会按 `failureBackoffMs * consecutiveFailedTurns` 延迟下一次尝试；成功且 Goal 仍 active 时用 `wake()` 触发下一轮。

### `goal-coordinator.test.mjs`：用假执行端验证调度，而不是伪造模型结果

测试覆盖了 continuation prompt、空闲/待输入门控、requestId、预算退还、失败退避、重启恢复和并发去重。假执行端只返回结构化 `accepted/success/productive`，不会调用网络、Pi SDK、Docker 或 MiniMax。

## 为什么本轮不改 `bootstrap.mjs`

当前 `TaskMessageService.start()` 返回的是 `{task,userMessage,completion}`，而协调器需要的是 `{accepted,success,productive}`。其中 `productive` 不能简单等同于“保存了一条 assistant 消息”：它应当依据任务运行事件或 Goal 工具动作判断是否真的推进了工作。直接把两者强行接起来，会把“模型回答成功”误当成“Goal 有效推进”。因此本轮只实现和验收通用 `GoalTurnPort`，后续单独设计真实适配器：

1. 先用 `isTaskBusy`、执行环境状态和 workspace idle 做 `isIdle`；
2. 明确定义待处理用户输入的来源；
3. 从持久运行事件中判断 `productive`；
4. 用环境变量显式开启自动续作，并把协调器加入启动/关闭生命周期；
5. 再接独立 Goal Verification Bundle/Verifier。

## 验收结果与边界

本轮 13B 的协调器定向测试与 Goal 核心测试全部通过。它证明的是租约与调度状态机，不证明真实 Agent 已经能自动完成复杂目标，也不证明 `productive` 或完成状态已经有独立正确性证据。原仓库在同一层也把这些责任分给执行端和后续 verifier。

