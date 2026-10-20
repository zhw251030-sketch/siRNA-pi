# Tool Approval Implementation Plan

> 使用superpowers:subagent-driven-development执行独立任务，主代理负责集成与真实验收。用户明确main及持续推进，统一完成后提交同步。

**Goal:** 已验证提案显式批准为可核对的首个正式版本，并产生受登记约束的工具目录。

**Architecture:** 正式包、SQLite版本事务、审批编排与目录分责；保留材料与报告原始字节，禁止自动Agent接线。

**Tech Stack:** 现有Node24、node:sqlite、fs/crypto；无新依赖。

**Spec:** ../specs/2026-10-20-tool-approval-design.md

## Global Constraints

仅siRNA-pi/main；远端/home/hanwen/Project/project/siNRA-pi；不读密钥、不调用模型、不执行候选、不操作Docker或重启服务。Node/无依赖/no_external_access/exact/首版1.0.0；不支持parent/替换。包与报告/数据库/目录关系必须验证。工作证据runtime/approval-*保留，不提交。各任务不修改彼此文件，不单独commit，主代理统一提交。

## Task 1: 正式包写入与完整性加载

Files create packages/capability-platform/tool-approved-packages.mjs, tests/tool-approved-packages.test.mjs。

Interface `publishApprovedToolPackage({saved,verificationBytes,verificationSha256,toolId,approvedBy,approvedAt},{approvedRoot})` → `{directory,directoryName,manifest,approval,verification,packageSha256}`；saved是readToolProposal的完整结果，verificationBytes为Buffer且必须与verificationSha256一致。`loadApprovedToolPackage(directoryName,{approvedRoot,expectedPackageSha256})`返回同结构。version固定1.0.0，directoryName=toolId+'-1.0.0'。允许root已存在，不跟随链接；创建权限由调用方建立，publish不创建任意父目录。

- [x] 写真实文件测试：先assert.equal(typeof publishApprovedToolPackage,'function')失败；用已登记材料fixture和真实v3报告字节构造，发布并重开loader。断言5文件、源码/报告字节完全相等、version1.0.0、manifest.id新toolId且proposalId原ID、baseline未发布。单独按参考公式计算整包摘要。
- [x] 实现Spec批准manifest/approval/integrity字段；manifest严格含原参考字段，不额外塞提案草稿字段；copy源码从saved.input.script无损UTF8编码并核对manifest.scriptSha256，报告协议/ID/通过/材料SHA/verifiedAt校验，actor非空最多120字符。无运行/动态导入。
- [x] 文件独占写/fsync/只读/临时目录rename，不覆盖目标；失败附packagePath及temporaryPath并保留。读有界/前后stat/精确集合/链接硬链接拒绝/所有跨文件身份及报告passed检查。每个被改文件或额外文件均拒绝；损坏JSON错误不回显内容；超长文件/错误directory/expectedSHA失败。
- [x] 仅跑专测与自审，记录runtime/approval-task1-report.md，包含RED/GREEN和限制。

## Task 2: 版本登记与schema3

Files modify packages/capability-platform/tool-registry.mjs, create tests/tool-registry-approval.test.mjs；旧schema测试仅调整合法新版本及未知版本数字。

Interface `activateVersion({toolId,toolName,version,proposalId,packageDirectory,packageSha256,imageDigest,approvedBy,approvedAt,validationId,reportSha256,artifactSha256})` 返回版本行，后三绑定字段仅校验不写版本表；`getToolVersion(toolName,version)`, `getActiveTool(toolName)`, `listToolVersions(toolName?)`, `listActiveTools()`；旧v1/v2读返回undefined或[]。版本row字段见Spec；packageDirectory只允许toolId+'-1.0.0'basename。proposalId唯一，toolName/version唯一，active toolName唯一。版本1.0.0，首个toolId不得等于proposalId。

- [x] 写真实SQLite测试：先方法不存在失败；insertProposal+recordValidation后activateVersion，重开查approved+active版本+version_activated事件；事件actor=approvedBy、details含proposalId/toolId/version/packageSha256/imageDigest。缺报告/失败/旧validationId或hash/材料hash/工具名镜像不符均拒绝。
- [x] 实现已知v1/v2/v3识别；v1/2普通read不迁移，migrate:true一致备份并升级，备份名.v1-backup-UUID或.v2-backup-UUID；未知库不改。v2仍可recordValidation，不要求v3；保留原提交功能。覆盖v2已提交WAL与v1直接升级。
- [x] activate事务内完成所有状态/证据/首版冲突检查，再INSERT版本/UPDATE提案/INSERT事件。trigger ABORT/ROLLBACK故障证明三者全回滚；两个同名提案只一份能批准；重复低层activate拒绝（高层幂等由Task3负责）。参数化SQL、plainData等沿旧模式，不接受getter/proxy。
- [x] 跑registry专测含旧测试，记录runtime/approval-task2-report.md。

## Task 3: 审批服务、目录、CLI与真实验收

Files create packages/capability-platform/tool-approval-service.mjs, packages/capability-platform/tool-catalog.mjs, tests/tool-approval-service.test.mjs, tests/tool-catalog.test.mjs；modify tool-lifecycle.mjs/tool-validation-reports.mjs/scripts/manage-tool-proposals.mjs，docs18及README/AGENTS/学习路线。

Interfaces `approveRegisteredToolProposal(id,approvedBy,{root})`→`{version,catalog,alreadyApproved,approved:true,activated:true,agentCallable:false}`；`getRegisteredToolVersion(toolName,version,{root})`核对包返回`{version,package}`；`listRegisteredToolVersions({root})`只读元数据；catalog模块`writeActiveToolCatalog({root,registry})` / `readActiveToolCatalog({root,registry})`。resolveToolLearningPaths额外返回approvedRoot、catalogPath但普通read不建目录；报告模块提供`readValidationReportBytes(file)`给服务复制已核对固定路径的原字节（现有有界读取函数导出），普通report输出不带Buffer。

- [x] 集成测试用真实提交/验证service+DockerBoundary或明确runner fixture，不手工伪造approved状态作为成功路径。失败先证明缺函数/缺行为，再实现批准与show/report读回。断言version/proposal/report/source/approval一致、repeat批准同版本/同事件，首次name冲突拒绝；报告/源码篡改在写前拒绝。
- [x] 服务先readonly读验证和身份，再migrate:true写路径；取新toolId和同一approvedAt，调用Task1，读回后复核源材料/报告未变，Task2传expected绑定。异常附packagePath；目录失败versionActivated=true、toolName/version/proposalId，重试原批准修复目录不新版本。
- [x] catalog从DB active+完整包验证生成参考字段，原子写0600，检查目录/文件链接和上限1MiB；read核对固定文件与DB投影、加载每包，损坏拒绝；无库/无文件返回空只读目录，不创建库。catalog-rebuild显式重建。故障测试用目录路径占位造成写失败，移走占位后重试验证版本/事件不变；自测目录篡改与正式包篡改。
- [x] CLI沿Linux/hanwen/root限制，支持`approve <UUID> <approvedBy>`、`versions`、`version <toolName> <1.0.0>`、`catalog`、`catalog-rebuild`；list/show/report原行为兼容，approved读报告不放松latest绑定，show附真实version/approved/activated并agentCallable=false。
- [x] 独立全审+问题修复；本机/Linux全套；正式提案批准，复读/重试/包和目录独立哈希/原材料报告不变/数据库备份与事件核验；负例用独立runtime不改正式数据。记录runtime/approval-acceptance.json及日志。
- [x] 完成中文文件讲解docs/18-工具批准与正式版本.md和进度更新；统一main提交推送/bundle同步在提交后执行，完成状态及三处SHA以私有runtime/approval-sync.json为准。

验收结果：新增103项，最终918测试（Linux916通过/2跳过，Windows906通过/12跳过）。正式工具977b9593-091a-4624-a4ba-b0c8f12b62df@1.0.0已批准并active，原材料/报告不变，重复批准同版本/事件，真实副本负例通过，0候选执行/模型请求。完整证据见docs18与runtime/approval-acceptance.json。
