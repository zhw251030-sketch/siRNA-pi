# 第12A步：自动 Curator → Builder 交接闭环

本步把第11E步的自动观察再向前推进一层：当本次服务实例自己发起的 Curator 审查最终产生 `candidate` 时，系统可以在有界条件下把该候选交给已有 Builder。这里的“自动”只表示交接动作自动发生；候选仍然要经过 Builder、独立验证和人工批准，不能把交接状态写成工具成功。

## 当前进度

截至当前代码版本，个人仓库已经完成：

```text
任务收尾
  → 自动观察
  → Curator 独立审查
  → candidate / skip / error
  → candidate 自动交给 Builder
  → Builder 自己保存 dispatching/running/submitted/no_proposal/
       failed/outcome_unknown 状态
```

本步尚未接通：

```text
submitted
  → 自动验证
  → 自动修订
  → 自动批准
  → 自动发布
```

这些仍然保留人工入口。

## 为什么不能在 `request()` 返回后简单调用 Builder

`toolCurationService.request()` 只是把审查请求写入独立队列并返回请求记录，Curator 模型可能稍后才完成。如果协调器把这个“等待中的请求”误认为最终候选，就可能：

- 在 Curator 尚未返回时启动 Builder；
- 把 `skip` 或 `error` 当成候选；
- 在人工审查和自动审查竞争时错误派发；
- 在服务重启后猜测旧记录属于自动流程。

因此，本步在 Curator 完成并且终态已经写入 SQLite 后才发出 `onSettled` 通知。通知同时携带 `automatic` 元数据，协调器只接受本进程自动请求产生的 `candidate`。重启时不扫描历史候选。

## 文件变化

### `packages/extensions/tool-curation/tool-curation-service.mjs`

新增可选 `onSettled(record, { automatic })` 回调。

它具有三个边界：

1. 先调用 `store.complete()` 或 `store.fail()`，再读取最终记录；
2. 自动与人工请求的标记随内部队列保存，不依赖 `post_run` 或 `online_gap` 猜测来源；
3. 通知异常只被吞掉并记录在后台流程中，不会把已经保存成功的 Curator 结果改成失败。

这保证了证据顺序：

```text
Curator 返回
  → 身份和结果校验
  → 冷却规则处理
  → SQLite 保存终态
  → 通知协调器
```

### `packages/extensions/tool-curation/tool-curation-coordinator.mjs`

新增 `toolCurationBuild` 依赖和 `observeCuration()`。

协调器在调用 Builder 前依次检查：

1. 通知确实来自自动审查；
2. 记录状态是 `candidate`；
3. 本候选尚未派发；
4. 自动 Builder 次数没有超过有界额度；
5. 任务当前不忙；
6. 候选仍能通过既有 `curationBuildPrompt()` 契约；
7. 使用冻结的 `traceSha256`、`resultSha256`、`promptSha256` 调用现有 `toolCurationBuild.start()`。

协调器不会直接调用 `TaskMessageService.start()`，也不会绕过 Builder 的来源绑定、任务空闲复查、目录检查和持久状态机。

状态页新增 `maxBuilds`、`buildAttempts` 和 `buildRemaining`，最近事件会区分：

- `builder_dispatched`：交接请求被 Builder 接受；
- `builder_deduplicated`：相同候选已经有持久交接单；
- `builder_busy`：任务正在执行或有其他占用；
- `builder_budget_exhausted`：自动 Builder 额度用完；
- `curation_skip`：Curator 明确不建议构建；
- `curation_error`：Curator 结果未知或失败；
- `invalid_candidate`：候选不能通过冻结契约。

任务忙或自动额度用尽时，Curator 候选仍保留为 `candidate`，用户可以通过原来的人工 Builder 入口处理。

### `apps/api/bootstrap.mjs`

启动顺序调整为：

1. 创建 Curator 服务；
2. 创建持久 Builder 服务；
3. 创建协调器并注入 Builder；
4. API 监听成功后，再由生命周期模块启动这些服务。

`onSettled` 使用延迟绑定的协调器引用，因此构造顺序不会导致 Curator 在 API 尚未监听时启动自动交接。关闭时仍然先停止自动准入，再排空已接受的 Curator 和 Builder 操作，最后关闭数据库和 RPC。

## 这一步解决了什么问题

第11E步完成后，系统已经能够自动发现“可能值得审查的工具能力”，但建议仍需要人工点击 Builder。第12A步把中间交接动作自动化，使流程从：

```text
自动观察 → 自动 Curator → 人工点击 Builder
```

变成：

```text
自动观察 → 自动 Curator → 自动交给 Builder → 人工批准
```

这仍然是“受控工具演化”，不是无限制自我修改。最危险的动作——验证、批准、发布和替换生产版本——仍由后续明确阶段控制。

## 验收边界

本步必须证明：

- 自动 `candidate` 只派发一次；
- `skip` 不会启动 Builder；
- Curator 失败不会启动 Builder，也不会自动重试；
- 任务忙时候选保留给人工处理；
- 重复终态通知不产生第二个 Builder 请求；
- Builder 的冻结哈希绑定没有被重算或放宽；
- Builder 交接不会直接调用验证、批准或注册表激活；
- 重启恢复 `dispatching/running` 时变成 `outcome_unknown`，不会重放模型请求。

因此，本步完成的判断依据是状态和边界测试，而不是“模型生成了一段代码”或“出现了一个候选文件”。

下一步是把 `submitted` 候选接入现有独立验证/维护队列；那一步仍然应先保留人工批准，不应一次性打开自动发布。

## 本步验证结果

本轮先让新增行为测试在旧代码上失败，再接入实现，随后运行定向回归和完整套件：

- 自动 Curator/Builder 与既有工具生命周期定向回归：95 项，94 通过，1 项 Windows 文件符号链接条件跳过，0 失败；
- 完整 `npm test`：1462 项，1447 通过，15 项平台或环境条件跳过，0 失败，0 取消；
- 真实生产默认仍关闭自动审查，本轮没有启动真实 Builder、验证、批准或发布，也没有扫描历史候选。

因此，本步的完成结论限于“自动候选交接的代码、持久身份和失败边界已经通过测试”，不扩展为真实模型已经发现了有价值的新工具。
