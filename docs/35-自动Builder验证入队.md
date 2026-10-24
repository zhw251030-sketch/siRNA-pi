# 第12B步：自动 Builder 提案进入独立验证队列

第12A步只完成了“Curator 找到候选后自动交给 Builder”。本步继续沿参考仓库的生命周期向前走：当这一次服务进程亲自派发的 Builder 完成并且确实把候选登记为 `submitted` 后，可以在显式打开开关时把它放进已有的独立维护队列。

这里的自动化有一个很窄的含义：自动排队验证。它不等于验证通过，也不等于批准和发布。验证仍由独立 Docker worker 执行，成功只会形成 `succeeded` 维护作业和候选验证报告；工具目录不会因此改变，人工批准仍是单独的 CLI 操作。

## 这一轮完成了什么

现在的链路是：

```text
任务结束
  → Curator 终态持久化
  → candidate
  → 本进程 Builder 交接单
  → Builder 终态持久化
  → submitted + proposalId + artifactSha256
  →（显式开启时）维护队列 pending
  → 独立 worker 验证
```

默认配置仍然是关闭自动验证。`apps/api/bootstrap.mjs` 只有在环境变量 `SIRNA_AUTOMATIC_VALIDATION=1` 时才把 `automaticValidation` 设为 `true`。因此普通启动不会因为历史候选或新的 Builder 结果而创建 Docker 验证作业，网页上的人工“验证”入口仍按原来的显式请求工作。

## 逐文件理解

### Builder：`packages/extensions/tool-curation/tool-curation-build-service.mjs`

Builder 原本已经把 `dispatching`、`running`、`submitted`、`no_proposal`、`failed` 和 `outcome_unknown` 写入 `builds.sqlite`。本轮增加可选的 `onSettled` 回调，但通知只在数据库终态写入之后发出。

回调只发送以下小型身份信息：`curationId`、`taskId`、`requestId`、`phase`、`userMessageId`、`runId`，以及提交时读回的 `proposalId` 和 `artifactSha256`。不会把 Builder 的完整 prompt、冻结 binding 或注册来源直接传给协调器。这样做是为了让回调成为一次通知，而不是第二份事实数据库；大模型提示也不会触碰协调器的 8 KiB 通知上限。

`submitted` 的 SHA 来自登记材料的只读读回，而不是模型回复中的字符串。若读回不完整，Builder 进入 `outcome_unknown`，不会伪造一个可验证的候选。回调抛错也不会改变已经保存的 Builder 终态。

### 协调器：`packages/extensions/tool-curation/tool-curation-coordinator.mjs`

协调器增加 `observeBuilder()`。它维护本进程内的来源集合，只接受本次自动 `observeCuration()` 真正派发的 Builder 票据；手动点击、重启后历史票据和去重的旧交接不会被冒充成自动来源。

交接开始前同步登记来源，解决“Builder 立即完成，而 `start()` 的 Promise 回调尚未执行”的微任务竞态。Builder 启动失败或返回去重结果时撤销来源标记。终态通知还必须带正确的 `auto-tool-curation-build:<curationId>` 请求号。

只有 `phase === "submitted"`、proposal ID 合法、artifact SHA-256 合法且自动开关打开时，才调用 `toolMaintenance.enqueue()`。`no_proposal`、`failed`、`outcome_unknown` 会被记录为抑制事件；任务停止、服务关闭、维护未配置、额度耗尽和入队冲突也只会记录安全原因。

验证请求号由 proposal ID、Curator ID 和 artifact SHA 的完整三元组经过 SHA-256 派生，再套 UUID v4 格式。相同三元组重试得到同一请求号，不同候选或不同产物不会共享请求号。

### 维护边界：`packages/capability-platform/tool-maintenance-worker.mjs` 与 `tool-maintenance-store.mjs`

维护 worker 继续是独立执行者。它先读回当前登记候选，只允许 `submitted` 或 `verification_failed`，然后将作业写入 `jobs.sqlite` 并异步唤醒 Docker 验证。它不会因为队列作业成功而批准工具。

本轮把自动交接的 artifact SHA 作为入队条件：当前候选摘要与通知摘要不同就返回 409；同一个 request ID 如果再次带来不同摘要也返回 409。这个检查覆盖了“登记后材料被替换”和“重试键被错误复用”两个窗口。

## 与参考仓库的关系

参考仓库的正式 Composition 已经把 `submitted → validation → repair/approval` 放进持久自动化管线。本学习仓库当前复现其中最窄、可独立验收的一段：`submitted → 独立 validation job`。参考仓库还拥有自动修订、替代候选谱系和自动批准；个人仓库暂时保留人工批准门，避免把“验证队列能工作”误写成“工具已经可靠或自动发布”。

## 如何验收

定向测试覆盖以下事实：Builder 终态回调在持久写入之后发生且不泄漏 prompt/binding；自动候选只有在开关打开时才入队；`no_proposal`、重复通知、重复请求和错误来源不会重复执行；proposal/artifact 摘要错配在 Docker 之前拒绝；维护 worker 的重启、中断和不确定清理规则仍由原测试保护。

这一轮完成后，下一阶段才是参考仓库中更复杂的“验证失败 → 原任务受控修订 → 替代候选继承与 supersede”。自动批准、Goal 限制、Memory/Data Pool、Workbench 和 Black-box 仍未实现。
