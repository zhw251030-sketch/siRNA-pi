# 2026-10-27 Goal 反馈续跑实时验收

## 本轮实现

提交 `a964044` 把个人版的 `GoalCoordinator` 接到实际网页服务生命周期。核心路径现在是：

`GoalVerificationCoordinator` 发现验收失败 → `GoalStore.continueAfterVerification()` 保存反馈并恢复 `active` → `GoalCoordinator` 获取有界 lease → `TaskMessageService.start()` 发送带 `latestVerificationFeedback` 的下一轮 Agent 消息 → 任务完成后回写 lease 结果。

这对应参考仓库的 `apps/api/extensions/goal-api.ts` 中 `GoalCoordinator` 与 `turnPort` 的接线，以及 `packages/task-core/task-message-service.ts` 中的 `isIdle()`、`hasPendingUserInput()` 和完成结果映射。

## 代码变化

- `apps/api/goal-api.mjs` 新建与参考版相同的 turn port：只在任务空闲且没有待输入时派发；捕获 409 admission 冲突并退还 lease；等待 `started.completion` 后根据 assistant 状态和成功工具回执生成 `GoalTurnResult`。
- `apps/api/router.mjs` 把共享 `TaskMessageService` 传入 Goal API，并把可选 coordinator 暴露给生命周期；`apps/api/bootstrap.mjs` 默认开启 Goal coordinator，可用 `SIRNA_GOAL_COORDINATOR=0` 关闭。
- `apps/api/service-lifecycle.mjs` 在 HTTP socket 监听后启动 coordinator，在关闭时先停止 coordinator，再排空已接受运行并关闭数据库。
- `packages/task-core/task-message-service.mjs` 增加 `isIdle()` 和 `hasPendingUserInput()`，保留参考仓库的扩展边界；当前没有交互式审批输入，因此后者固定返回 false。
- `packages/extensions/goal/goal-verification-agent-compose.mjs` 补齐 acceptance criterion 到 claim category/evidence class、`minimumExternalSources` 的逐来源 claim 和 artifact/message 实际读取约束。
- `packages/extensions/goal/goal-verification-policy.mjs` 修复合法 retrieval-backed external claim 被无条件标记为 `EXTERNAL_FACT_WITHOUT_RETRIEVAL` 的判断错误。

## 离线验收

新增了 Goal API 的真实 coordinator port 回放、retrieval external claim 正例、artifact 错绑负例、聚合 claim 冒充多来源负例和 source-specific 多来源正例；随后补充了 Agent Compose daemon/workspace 空闲状态的 fail-closed 测试，并把执行 Agent 与独立 verifier 的检索职责写进配置和续跑提示。最后补齐执行侧 `get_goal/create_goal/update_goal` MCP 工具，使自动回合能真正回写计划进度。完整 `npm test` 结果为 1601 项：1585 通过、16 项 Windows 平台跳过、0 失败。

## 服务器实时验收

服务器 `/home/hanwen/Project/project/siNRA-pi` 已通过 bundle 同步到 `a964044` 并重启。健康接口确认 `backend=agent-compose`、`supportsLifecycle=true`、内部 verifier listener 可用。

重启后，已有的受控检索 Goal 自动恢复，续跑消息中包含真实的中文 verifier 反馈，证明持久 Goal、lease、反馈和 TaskMessageService 接线生效。执行 Agent 随后因为 `sirna-tools` 没有学术检索工具，反复尝试不存在的 `verify_controlled_retrieval_record`，最终按任务运行时失败处理；这不是协调器静默吞错，而是保留了失败 assistant、tool trace 和 Goal feedback。

为避免历史实验继续消耗自动回合，三个旧检索 Goal 已暂停；在途任务先按服务规则完成或取消，最终服务器健康为 `ready:true, busy:false`。暂停不删除任何消息、文件、检索回执或验证 attempt，后续可显式 resume。

## 对原仓库的理解和剩余边界

本轮完成的是“持久 Goal 失败后自动反馈续跑”的运行骨架，验证了参考仓库的职责分层：Goal store 管状态和预算，verification coordinator 管独立验收，task message service 管真实 Agent turn，Goal coordinator 只负责有界调度。

仍未完成的是可证明的业务闭环：执行 Agent 还没有正式的学术检索工具，verifier 与执行 Agent 的证据职责仍需明确；真实模型尚未在一次受控实验中把 retrieval evidenceId 正确绑定到 `external_fact`、把 artifact 证据绑定到文件验收项并最终通过。下一轮应新建一个只有 1–2 个自动回合预算的独立 Goal，先提供明确的 retrieval 工具或改成 verifier-only retrieval，再验证失败反馈后的单次修订和最终通过。
