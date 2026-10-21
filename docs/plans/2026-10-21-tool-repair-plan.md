# Controlled Tool Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** 把可信失败反馈送回原任务，保存有界替代谱系，网页显式运行一轮。
**Architecture:** 注册事件保存来源与替代关系；独立repair SQLite保存派发票据；既有任务消息服务负责模型执行，既有builder与maintenance负责构建/验证。
**Tech Stack:** Node内置SQLite/HTTP、Pi/Agent Compose现有运行时、原生网页、node:test。
**Spec:** docs/plans/2026-10-21-tool-repair-design.md

## Global Constraints

仅个人siRNA-pi/main；不改参考/父级RSI/凭据/旧证据。无新依赖/系统/root操作。来源仅可信lease，schema4保持，新事件同事务。固定auto-tool-repair:<proposalId>去重；崩溃不重放；每绑定链最多3替代，无自动验证/批准/循环。GET只读。完整上下文≤120000字符且≤256KiB，POST≤4096B只validationId/reportSha256。测试临时root不使用正式cwd。

## Task 1: 可信来源、修订票据与后端接线

Files: tool-registry.mjs、tool-lifecycle.mjs、tool-build-sessions.mjs、task-tool-builders.mjs、apps/api/router.mjs、bootstrap.mjs、tool-maintenance-worker.mjs；新tool-proposal-source.mjs、tool-repair-store.mjs、tool-repair-service.mjs；新tests/tool-repair.test.mjs，必要既有定向测试。

Interfaces: createToolRepair({root,store,taskStore,taskMessages,agentRuntime,maintenance})返回start(proposalId,{validationId,reportSha256})、status(proposalId)、recover()、stop()、registration(input,taskContext)；接口可在实现前与控制者一次明确微调。ToolRepairStore({root})独立私有库。createAppServer可注入同一taskMessages与toolRepair，默认仍兼容旧测试。builder可选宿主registrationPolicy(input,taskContext)只在propose登记前调用，返回可信repair元数据，taskContext原样进入生命周期；CLI未配置保持旧行为。maintenance可选canValidate(id)守卫。source reader验证唯一submission事件及材料身份后返回可信source/repair。getRepairReplacement(requestId)从登记事件查询，不依赖list100截断。

- [x] RED真实临时注册表：来源同提交事务保存、旧CLI仍null、伪造模型字段拒绝；注入SQLite失败原行事件同回滚。
- [x] RED/GREEN票据：固定请求跨重开去重、不同report拒绝、未知/通过/无来源/忙/停止/排队/halt拒绝，无模型副作用；多次请求仅一消息。
- [x] RED/GREEN派发：真实TaskStore/TaskMessageService及外部runtime替身，检查完整消息包含原源码、合同和实际错误；预算3后第4拒绝；消息保存失败/取消/无新提案不误报成功；未完成重启为interrupted且不重发。
- [x] RED/GREEN提交：真实构建服务的外部Docker替身，当前repair消息+run匹配才承认替代；合同变化/改名/第二提案/跨task/run拒绝，事务内唯一；新提案仍submitted。真实登记在completion前，收尾不覆盖superseded，跨进程仍能由事件读回。
- [x] RED/GREEN HTTP和生命周期：只接受固定body，安全错误，无凭据/内部路径外泄；server失败监听不恢复；shutdown等待已接纳修订，不因HTTP断开停止；验证/修订互斥。
- [x] focused测试通过并自审，保存RED/GREEN完整日志与报告；不提交，控制者复审后继续UI。

## Task 2: 网页来源和一轮修订入口

Files: public/tools.mjs、按需style.css、新或改tests/tools-ui.test.mjs。消费Task1真实API。
- [x] RED：挂载/真实状态测试读取来源、无来源禁用、点击POST固定报告绑定、双击只一次、POST未知提示不自动重放、旧status/feedback迟到不回填。
- [x] GREEN：中文提示运行模型消耗额度、链次/新候选/显式验证边界；先读取可修订状态，再允许明确点击；保留10M展开状态及原验证行为。
- [x] focused回归；控制者任务复审、两端完整套件各一次，失败做有据定向诊断。

## Controller delivery

- [ ] 旧状态快照，guarded部署，真实新任务构建→失败验证→一轮修订→新提案验证→结束释放；记录所有实际结果/用量/失败。
- [ ] 重启只读复核、不重复运行；中文docs27逐文件说明，更新README/学习路线/AGENTS和有界验收脚本。
- [ ] 整体复审，main提交推送，项目内bundle同步，三处提交和旧状态核验。

实际演示偏离预期：只运行1根构建轮+1修订轮。修订源码已调试和finalize，但模型自行新增parent，提交被拒绝，实际为awaiting_replacement。原计划“新提案验证”尚未完成，不能勾选为成功；改为保存真实失败轨迹、只读诊断与资源/旧状态核验，不追加模型轮次。完整记录见docs/27。
