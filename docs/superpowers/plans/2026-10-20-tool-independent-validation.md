# Tool Independent Validation Implementation Plan

> 使用subagent-driven-development执行独立模块；主代理负责集成与交付。用户明确main单分支及持续推进，不另建分支或重复请求已授权事项。

**Goal:** 对已登记工具运行独立检查，保存可核对报告并准确登记验证状态。

**Architecture:** 独立容器执行器、报告编排和SQLite状态分责；每个报告绑定固定材料摘要。无自动批准。

**Tech Stack:** 现有Node24、node:sqlite、crypto/fs、项目Docker Engine；无新依赖。

**Spec:** ../specs/2026-10-20-tool-independent-validation-design.md

## Global Constraints

仅siRNA-pi/main；远端/home/hanwen/Project/project/siNRA-pi；不读凭据、不调用模型、不改参考或RSI、不重启服务。node/no dependencies/no_external_access/exact；候选与基线都在项目独立Docker容器内运行。报告sirna-tool-validation/v3，全部关卡通过才verified；不得自动approve/activate。私有证据runtime，不提交数据库/报告/源码运行数据。并行任务不互改文件，主代理统一提交。

## Task 1: 容器验证执行器

Files create packages/capability-platform/tool-validation-runner.mjs, tests/tool-validation-runner.test.mjs；必要固定容器内助手scripts/lib/tool-validation-guest.mjs与其测试。不得修改build-service既有行为。

Interface createDockerValidationRunner({docker,timeoutMs=10000,onEvent=async()=>{}}) → {checkSources({manifest,input}),run({target,manifest,input,caseInput,toolCallId})}，target=candidate|baseline。manifest为readToolProposal.manifest，input为其input（含script/baseline.script/runtimeArtifact）。checkSources返回{syntaxChecks,runtimeArtifactVerified,executionPolicy}；syntaxChecks两个{passed,command,exitCode,timedOut,stdout,stderr,target}。run返回完整exitCode,timedOut,cancelled,protocolValid,output,stdout,stderr,filesDigest及containerId/imageDigest/actualPolicy，不能返回假文件摘要。

- [x] 先测完整候选/基线路径、镜像源SHA不匹配必须阻止运行、两次run独立容器、实际文件摘要随内容变化、无网络/挂载/nonroot/readonly限制、超时/非法输出/清理失败。先缺函数或stub失败，再实现。
- [x] 实现可信Node助手在容器内准备/执行/摘要，源码不在宿主eval；候选从真实镜像读，基线快照输入。资源和标签检查按Spec，caseInput最多64KiB，输出/文件有界，拒绝链接特殊文件。独立工作目录内容摘要采用明确类型/路径分隔及文件长度或固定长度内容摘要，排序稳定，不能让文件内容伪装为下个文件头。
- [x] 用具体Docker边界fake测试命令与结果；固定助手本身可在无候选执行的专用测试目录测试摘要。只运行专测，保存runtime/validation-task1-report.md（RED/GREEN、接口/限制、自审）。

## Task 2: 验证登记与已知schema升级

Files modify packages/capability-platform/tool-registry.mjs, create tests/tool-registry-validation.test.mjs；仅确有旧测试版本假设时修改tests/tool-registry.test.mjs。

Interface constructor(databasePath,{readOnly=false,migrate=false})；v1/v2均可读，migrate:true才升级已有v1；新库v2。recordValidation({id,proposalId,passed,reportPath,reportSha256})→{同输入,createdAt}；getValidation(id)、latestValidation(proposalId)同对象或undefined。proposal row有latestValidationId时才附字段。v1读取验证返回undefined。写验证需要v2。

- [x] 写真实SQLite测试：`registry.recordValidation(record); registry.close();`重开后state verified/latestValidationId/事件一致；false为verification_failed；同提案重新验证保留旧报告；approved/rejected拒绝。
- [x] 写v1fixture含WAL已提交数据；普通read不变；migrate:true先VACUUM INTO独占0600备份再事务ALTER/CREATE/user_version2；备份仍v1且数据完整。未知schema拒绝；迁移失败不损坏原表。事件trigger拒绝验证写入后索引/状态/事件全部回滚。
- [x] 严格校验输入/actor固定validator，参数化SQL，事务内部检查状态防竞争；latest按proposal.latest_validation_id精确取，不靠毫秒时间排序。专测通过并保存runtime/validation-task2-report.md。

## Task 3: 关卡编排、报告读回、CLI与教学

Files create tool-validation-static.mjs/tool-validation-service.mjs/tool-validation-reports.mjs in packages/capability-platform，scripts/validate-tool-proposal.mjs，tests/tool-validation-service.test.mjs/tests/tool-validation-static.test.mjs与共享tests/helpers/validation-docker-boundary.mjs；modify tool-lifecycle.mjs/manage-tool-proposals.mjs/package.json，docs/17-工具独立验证与报告.md及README/AGENTS/学习路线。

- [x] 先写真实文件/SQLite配合明确runner结果测试：报告2烟测+2领域+2×2基准，候选2基线1净增1；篡改/语法失败/重复不一致/领域失败/净增不足各自失败；不能运行的关卡不执行candidate；基础设施错误不标verified。报告篡改与DB路径重定向拒绝。
- [x] 编排函数用Task1接口，所有输入来自登记包；前后重读完整性。静态扫描参考Node适用规则，字段位置完整且有限输出；必须说明词法局限。
- [x] 报告独占保存并摘要登记，失败保留私有证据路径。只读report无schema创建。show验证状态与实际报告一致，未知或终态在执行前拒绝。CLI Linux/hanwen/唯一root、项目socket。
- [x] 独立审查三任务合规与质量，修复后本机/Linux全套；真实正式提案执行，保存候选基线结果和文件摘要，临时容器清理精确验证；旧状态保持。
- [x] 完成中文逐文件说明；main同步在提交后执行，最终SHA及完成状态以runtime/validation-sync.json为准，不能把提交自身SHA写入同一提交。

Acceptance: 815项最终测试（Linux813通过/2跳过，Windows805通过/10跳过）；正式验证8次业务执行，候选2/基线1、净增1，提案verified。三项真实负例均按预期拒绝或失败，0模型请求。详见docs/17-工具独立验证与报告.md及私有runtime/validation-progress.md。
