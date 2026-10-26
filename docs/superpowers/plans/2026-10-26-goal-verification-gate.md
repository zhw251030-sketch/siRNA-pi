# 13C-A Goal 完成验证门控计划

## 目标

对照参考仓库 `packages/extensions/goal/goal-store.ts`，禁止 Agent 通过一次 `update_goal status=complete` 直接写入 Goal 终态，建立 `active → verifying → complete` 的 revision 保护路径。

## 实施步骤

1. 先写 GoalStore 和 HTTP 行为测试。
2. 让完成申请进入 `verifying`，保留计划完成门控。
3. 增加独立验证通过、证据不足恢复、验证基础设施暂停和 checkpoint 恢复方法。
4. 运行 Goal 定向测试、完整回归和 `git diff --check`。
5. 更新逐文件学习文档并提交到个人 `main`。

## 边界

- 本轮不调用 verifier Agent、不访问网络、不冻结任务文件。
- `completeVerified` 只允许 `verifying + expectedRevision`，后续 Verification Coordinator 才能调用。
- 证据包、确定性 policy 和 verifier 访问工具属于 13C-B 及以后。

