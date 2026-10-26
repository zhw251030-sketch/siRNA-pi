# 第 13A 步：持久化 Goal 核心闭环

这一阶段把原仓库 M6 的第一层搬到学习版：任务不再只有“发一条消息并等待回复”，还可以拥有一个后端保存的长期目标（Goal）。Goal 记录目标本身、有限工作计划、当前状态、修订号和自动回合预算；Pi 只能通过受控的 Goal 工具提交进度、阻塞或完成申请，不能直接把状态写成完成。

## 先看原仓库对应什么

| 原仓库职责 | 参考文件 | 学习版实现 |
| --- | --- | --- |
| 目标拆成有限工作项 | packages/extensions/goal/goal-plan.ts | packages/extensions/goal/goal-plan.mjs |
| 目标状态、计划、revision、预算、租约 | packages/extensions/goal/goal-store.ts | packages/extensions/goal/goal-store.mjs |
| Agent 侧三个 Goal 工具 | packages/extensions/goal/goal-tools.ts | packages/extensions/goal/goal-tools.mjs |
| HTTP Goal API | apps/api/extensions/goal-api.ts | apps/api/goal-api.mjs + apps/api/router.mjs |
| 目标与任务消息的关系 | goal-api.ts 创建 objective 消息 | TaskStore.appendConversationUserMessage() |
| 自动续作协调器 | packages/extensions/goal/goal-coordinator.ts | packages/extensions/goal/goal-coordinator.mjs（13B，默认不启动真实自动回合） |

## 为什么需要 Goal

普通消息接口只知道“一轮已经结束”，无法表达“这个任务还剩哪些工作、是否允许服务在用户离开后继续、预算用了多少、模型能否宣称完成”。原仓库把这些内容放入 GoalStore，并用 revision 和租约避免两个执行器同时推进同一目标。

学习版的目标生命周期是：

```text
创建 -> active -> progress* -> complete
                  \\-> blocked
active <-> paused
active --自动回合预算用尽--> budget_limited
```

complete 不是模型自报就成立。后端会读取保存的 plan，只有所有必需工作项都是 done 才允许进入 complete。13A 还没有独立 Goal Verifier，所以这只是“计划门控”，不是对文件、工具轨迹或科学结果的独立正确性证明。

## 每个文件做了什么

- goal-plan.mjs 把中文或英文目标按换行、标点和连接词拆成最多 12 个工作项；工具类目标会补出“接口与验收、实现测试、提案验证、MCP 调用”四个可观察步骤。parseGoalPlan 丢弃非法项，applyGoalProgress 只接受已存在的工作项 ID。
- goal-store.mjs 使用 runtime/goal/goals.sqlite。这是独立数据库，避免修改已经稳定运行的任务数据库。每次修改都在 SQLite BEGIN IMMEDIATE 事务中完成，revision 用于并发更新检查，leaseId/leaseExpiresAt 为下一阶段自动回合预留。
- goal-api.mjs 负责 HTTP 输入校验和状态映射：GET 读取，POST 创建，PATCH 做用户 pause/resume 或 Agent progress/complete/blocked，DELETE 清除目标。它只接受 taskId 对应的任务。
- task-store.mjs 新增 appendConversationUserMessage。Goal 创建时把 objective 作为一条持久用户消息保存，刷新后仍能看到“为什么创建这个目标”。
- router.mjs 在 /v1/tasks/:taskId/goal 挂载 API，并在任务消息响应中返回当前 Goal；bootstrap.mjs 创建 GoalStore，并在服务关闭时一起关闭数据库。
- goal-tools.mjs 对齐原仓库的 get_goal/create_goal/update_goal 名称和参数。它通过任务上下文请求 Goal API，后端仍是唯一状态写入者。本轮先完成合同和单元测试，尚未把三个工具放进新的 Agent Compose guest 镜像；这会在 13B/13C 接入时完成。

## 怎样验收

```bash
node --test tests/goal-core.test.mjs tests/goal-api.test.mjs tests/goal-tools.test.mjs
```

这些测试覆盖：

- 计划生成、非法工作项拒绝和进度标记；
- SQLite 重开后目标仍存在；
- revision 冲突不会覆盖新状态；
- pause/resume、租约回收和自动回合预算耗尽；
- HTTP 创建、读取、进度、暂停、恢复、重复目标和未知任务；
- Goal 工具使用 task context，并把三个操作映射到 GET/POST/PATCH。

## 当前边界和下一步

13A 完成了“目标有地方保存、状态不能被模型直接绕过、完成有计划门槛”。它没有声称完成原仓库的全部 Goal 贡献：

1. 13B 已接 GoalCoordinator 调度内核：只有任务空闲、没有待处理用户输入时才领取 lease，使用 goal:<goalId>:<turn> requestId 发起有限自动回合，并在重启时回收遗留 lease。当前只用假 GoalTurnPort 测试，尚未接入 bootstrap 的真实 TaskMessageService。
2. 13C 接 GoalVerificationBundle/Store/Policy/Coordinator：把完成申请冻结成不可变证据包，由没有任务执行权限的独立 verifier 检查文件、消息、工具回执，再决定 complete、继续或 blocked。
3. 后续再接 Memory、Data Pool、Design Workbench 和 Black-box；它们依赖 Goal 的 taskId、revision 和证据边界。

因此，本阶段可以证明 Goal 状态机和接口工作，不能证明 Agent 已经能自主完成复杂科学任务，也不能把“所有计划项已标记 done”当作独立实验结果。
