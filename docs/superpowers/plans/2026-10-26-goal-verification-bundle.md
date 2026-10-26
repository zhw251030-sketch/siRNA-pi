# 13C-B Goal Verification Bundle 计划

## 目标

对照参考仓库 `packages/extensions/goal/goal-verification-bundle.ts`，在 Goal 进入 `verifying` 时冻结消息、运行事件、工具回执和任务文件，形成可重读、可校验的不可变证据包。

## 实施步骤

1. 先测试验证包身份、工具回执脱敏、文件枚举/读取一致性和冻结后源文件变化。
2. 实现稳定 JSON 哈希、消息快照、工具回执摘要和文件快照。
3. 实现 `bundle.json` 和 `readArtifact()` 的大小/哈希校验。
4. 运行 Goal、Bundle 和完整回归测试。
5. 更新学习文档并提交到个人 `main`。

## 边界

- 不调用 verifier Agent，不做网络检索，不改变 Goal 状态。
- Bundle 只冻结证据，不决定 pass/fail。
- policy、evidence resolver、verification store/coordinator 留到后续步骤。