# Tool Proposal Registration Implementation Plan

> 使用subagent-driven-development执行分工和审查；用户明确main单分支、继续工作和持续同步，沿已有授权实施。

**Goal:** 将真实工具提案保存为可查询、可核对未变更的submitted记录。

**Architecture:** 材料包与SQLite分责；生命周期编排，可信CLI触发。提交不执行源码、不批准、不生成正式版本。

**Tech Stack:** Node内置fs/crypto/sqlite/node:test，无新依赖。

**Spec:** ../specs/2026-10-20-tool-proposal-registration-design.md

## Global Constraints

仅siRNA-pi/main；远端/home/hanwen/Project/project/siNRA-pi；不读凭据、不调用模型、不操作Docker/重启服务、不改参考或RSI。独立实现原格式与职责。完整合同要求artifact；parent本步拒绝。包draft/0.1.0-draft，登记submitted，执行/验证/审批/激活false。

## Task 1: 材料包

Create packages/capability-platform/tool-proposals.mjs, tests/tool-proposals.test.mjs。接口与精确字段见Spec。使用真实临时目录，不执行源码。

- [x] 先编写失败测试：`const saved=createToolProposal(input,{proposalsRoot}); assert.equal(saved.manifest.status,'draft');`，重读源码与原输入一致；独立SHA和字面文件集合；分别篡改候选/基线/manifest/添加文件/链接必须抛错。
- [x] 观察RED后实现UUID目录、固定文件名、manifest、哈希、Linux只读私有权限。只允许真实普通目录与有界普通文件，不覆盖旧包。
- [x] 专测GREEN，自审材料格式与参考对应关系；提交前交主代理统一集成。

## Task 2: SQLite登记

Create packages/capability-platform/tool-registry.mjs, tests/tool-registry.test.mjs。接口与精确字段见Spec。父目录由调用方创建。

- [x] 先测：`registry.registerProposal(record); registry.close();`重新打开后state=submitted且事件数1；重复ID失败但原行/事件保持；同toolName不同ID成功。
- [x] 在真实测试库加拒绝插入事件的trigger，验证提案行随事务回滚。写readonly/非法输入/非本库/路径链接负例。
- [x] 实现显式路径、参数化SQLite、类型/版本标识、提交事务及只读查询，观察GREEN，无发布/更新状态接口。

## Task 3: 生命周期、CLI及交付

Create packages/capability-platform/tool-lifecycle.mjs, scripts/manage-tool-proposals.mjs, tests/tool-lifecycle.test.mjs；modify package.json；学习文档docs/16-工具提案登记与完整性.md及README/AGENTS/学习路线。

- [x] 写失败集成测试：空库list不创建；无artifact/parent不写；提交→重新打开list/show；检查登记与材料字段一致；变更源草稿不影响已提交包；篡改快照后show失败；候选源码带host写文件哨兵，提交后哨兵不存在。
- [x] 实现显式root路径准备、提交/列表/读回与CLI，缺失库只读查询不建库，失败保留材料位置，不输出源码。
- [x] 专测和完整本机测试；独立审查；暂存源到远端唯一项目根。
- [x] 真实CLI提交10B副本、独立进程list/show；专用临时库篡改负例；核对旧状态及0模型/容器操作。Linux完整回归。
- [x] 完善逐文件中文说明，审查差异。最终732项：Linux730通过/2跳过，Windows722通过/10跳过；审查P2修复并复审通过。

交付时提交推送main并bundle同步；最终提交SHA和三处工作树核验保存在忽略追踪的`runtime/registration-sync.json`，避免把提交自身的SHA写回同一个提交。本轮材料与失败诊断保留，不清理已有运行状态。
