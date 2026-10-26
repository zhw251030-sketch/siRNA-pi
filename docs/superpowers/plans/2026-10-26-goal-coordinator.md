# 13B GoalCoordinator 实现计划

## 目标

对照参考仓库 `packages/extensions/goal/goal-coordinator.ts`，把 13A 的持久 Goal 状态推进为一个可验证的自动续作调度内核，同时保持真实模型自动回合默认关闭。

## 实施步骤

1. 对照参考实现确认 `GoalTurnPort`、租约、requestId、退避和恢复语义。
2. 在 `GoalStore` 增加未接受派发时释放租约并退还预算的事务操作。
3. 先写协调器行为测试：空闲检查、待处理用户输入、requestId、prompt、拒绝退还、失败退避、重启恢复、并发去重。
4. 实现 `GoalCoordinator`，暂不接入 `bootstrap.mjs` 的真实 TaskMessageService。
5. 更新学习文档，说明参考映射、当前边界和下一步真实适配。
6. 运行定向测试、串行全套测试和 `git diff --check`，再提交到个人仓库 `main`。

## 验收边界

- 只使用假 `GoalTurnPort` 做调度测试，不产生模型请求。
- 证明协调器不会在任务忙或用户输入等待时领取 lease。
- 证明不接受的派发会 refund 自动回合预算。
- 证明失败会进入内存退避，成功会在仍为 active 时唤醒后续回合。
- 真实 `TaskMessageService` 适配、productive 判定、独立 Goal Verifier 和网页开关留到后续步骤。

