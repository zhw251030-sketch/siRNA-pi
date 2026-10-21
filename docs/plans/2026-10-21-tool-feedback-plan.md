# Tool Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** 从可核验失败报告生成网页可读的反例与修订说明，读取不触发执行。
**Architecture:** 反馈模块复用既有注册表和报告读回；maintenance暴露feedback方法，router增加只读GET，tools面板显示有界证据。原验证器和执行器不变。
**Tech Stack:** Node内置SQLite/HTTP、原生浏览器模块、node:test。
**Spec:** docs/plans/2026-10-21-tool-feedback-design.md

## Global Constraints

个人main，不提交或读取凭据内容；仅siRNA-pi，不改参考/父研究项目。模型请求0；不派发任务、不建立自动修订循环。GET只读。单业务JSON预览4096 UTF-8字节，最多20条领域和20条比较案例，整体256KiB，省略显式。保持既有队列/报告/版本合同。测试只创建隔离临时root，不用正式cwd作fixture。

## Task 1: 失败证据与网页预览

Files: 新packages/capability-platform/tool-repair-feedback.mjs；改tool-maintenance-worker.mjs、apps/api/router.mjs、public/tools.mjs；按需public/style.css；新tests/tool-repair-feedback.test.mjs、改tests/tools-ui.test.mjs。

Interfaces: 导出getToolRepairFeedback(id,{root})返回null或protocolVersion=sirna-tool-repair-feedback/v1反馈；maintenance.feedback(id)核对不存在/pending/running边界；HTTP GET /v1/tool-proposals/:id/repair-feedback返回{feedback}。面板提供inspectFeedback(id)，state.feedback与明确的选中视图，现有摘要行为保持。可内部拆纯buildToolRepairPrompt用于生成固定合同及结构化证据说明。

- [x] RED：用真实提案登记和既有validator/替代Docker生成完整失败报告。断言失败反例的input/expectedOutput/candidate输出、报告和材料绑定；无报告/通过/批准无反馈；改报告字节或材料拒绝。断言读取前后注册表和文件字节一致。
- [x] RED：覆盖static/syntax导致not_run、协议错误/超时、超长JSON/超过20案例时显式省略且总体有界、比较门槛失败但领域全过。测试错误分支要被真实语义断言捕获，不能仅grep源码/提示文本。
- [x] GREEN：实现getToolRepairFeedback，使用getRegisteredToolProposal/getLatestToolValidationReport及已有材料读取，投影白名单字段；输入和预期来自冻结manifest，实际来自绑定报告，核对案例名称/数量对应。纯说明字符串可用固定文字；不提供新执行入口。
- [x] RED/GREEN：真实HTTP验证GET权限/方法/未知ID/坏报告安全错误，重复GET不产生状态变化，pending/running阻止旧反馈。浏览器模拟网络仅在fetch边界；测试切换候选/提交/轮询的迟到响应不可回填旧反馈。
- [x] RED/GREEN：修复读取错误恢复横幅，仍保留未确认POST警告；有正常可查看的反馈时UI展示案例、门禁和只读说明，动态内容用textContent。
- [x] 定向测试通过后自审；保存Windows完整串行检查的两次既有fixture失败及单文件复查，不声称全绿。Linux完整1111项1109通过/2跳过；UI修复后两地64项相关回归、最后文案23项通过。控制者完成真实Docker/浏览器与重启验收。

## Controller delivery

- [x] 准备故意错误的新教学候选、旧状态快照与只读验收脚本。
- [x] 独立复审并修正阻塞项；服务器部署、真实验证和浏览器读取，重启复验。
- [x] 更新docs/26-验证失败反馈与修订说明.md、README/学习路线/AGENTS，区分反馈准备与尚未实现的派发/谱系/预算。
- [x] 整体复审通过；P2阅读状态与P3参考差异说明已修正。交付按main提交推送、项目内Git bundle对齐服务器并核对，实际同步提交及结果记录于私有runtime/feedback-sync.json，不在计划中预填成功结果或自引用提交号。
