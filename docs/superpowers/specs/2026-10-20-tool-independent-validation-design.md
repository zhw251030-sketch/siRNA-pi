# 第10D步：已登记工具的独立验证

用户已要求继续上一轮明确的下一步：对照原仓库完成独立验证并逐文件教学。main单分支、项目内执行、持续同步沿已有授权；本设计把该下一步具体化。

## 范围与参考

参考application965c53f/checkout67d2754的tool-lifecycle.ts validateRegisteredToolProposal、tool-registry.ts recordValidation及tool-proposals.ts运行摘要。独立实现，不复制应用源码。保留sirna-tool-validation/v3报告主要字段和submitted→verified/verification_failed语义。审批、发布、MCP/HTTP、自动化和模型不接入。

支持已有教学合同：候选/基线均node、dependencies=[]、permissions.profile=no_external_access、repeatabilityMode=exact、有真实runtimeArtifact，每类案例至多10，输入至多64KiB。其他合同明确拒绝，不假装已验证。报告记录范围、实际容器配置和无CPU配额边界。

## 数据与职责

1. tool-validation-static.mjs：候选与基线的静态禁用模式检查。覆盖参考Node适用规则，保留ruleId/目标/行列定位；扫描是词法检查，可能误报和漏报，不是安全证明。
2. tool-validation-runner.mjs：createDockerValidationRunner({docker,timeoutMs=10000,onEvent})返回checkSources({manifest,input})与run({target,manifest,input,caseInput,toolCallId})。前者返回{syntaxChecks,runtimeArtifactVerified,executionPolicy}；后者返回完整ProposalRunResult（exitCode,timedOut,cancelled,protocolValid,output,stdout,stderr,filesDigest及容器证据）。候选来自固定摘要镜像，验证镜像标签与实际源码SHA一致；基线来自已登记快照，放入固定底座的专用容器。两者均非root执行、无网络/宿主挂载/凭据/socket、readonly rootfs、1GiB内存/64进程和64MiB tmpfs。准备/文件摘要用固定可信程序，绝不在宿主执行候选。每次run新容器新工作目录，按文件路径与实际字节计算摘要，禁止伪造空摘要。只清理本调用创建且归属标签一致的容器，不删除镜像或旧容器。超时/输出超限必须失败，清理不确认不得报成功。
3. tool-registry.mjs：已知v1向v2可恢复迁移，迁移前SQLite一致备份（含WAL已提交内容，0600，同目录）。v2增加latest_validation_id与tool_validations。只读可读v1/v2且不迁移；未知版本拒绝。recordValidation({id,proposalId,passed,reportPath,reportSha256})同事务插入报告索引、更新状态/最新ID、追加validation_passed/failed事件actor=validator。允许submitted/verification_failed/verified重验，拒绝approved/rejected。重复ID与事件写入失败全部回滚。迁移显式选项migrate:true，新库直接v2。
4. tool-validation-service.mjs：validateRegisteredToolProposal(id,{root,runner})先读回已登记材料并确认状态/身份，做静态/语法检查、2次烟测、领域案例、候选与基线基准；执行前后核对包摘要。7门全部通过才passed。分数为通过基准案例数，netGain=candidateScore-baselineScore，默认minNetGain1。报告固定路径runtime/tool-artifacts/validations/<proposalId>/<validationId>.json，独占0600写再0400，记录SHA。无完整报告的基础设施错误不伪造验证结论，保留私有诊断；报告保存但登记失败保留路径。getLatestToolValidationReport(id,{root})只读校验路径/哈希/ID/结论与登记，不创建库。不依赖数据库提供任意读取路径。
5. tool-lifecycle.mjs show接受验证状态，读取报告后返回verified/executed等准确标志；提交依旧不执行。CLI新增独立validate:tool <UUID>和tools:proposals report <UUID>，Linux/hanwen/唯一项目根，socket只指向项目rootlessDocker。

## 实际验收与保留边界

验证上一轮正式提案f742eea2-b025-4474-ae47-d6eab267c408。教学候选预计两例通过，基线仅纯DNA通过，差1满足minNetGain1；必须按实跑报告而非预期宣布结果。正式材料不修改，测试失败/篡改在独立测试根；数据库迁移备份保留。原10份会话、3个运行容器及凭据元数据前后核验，不读密钥，不重启服务，不安装系统依赖，模型调用0。仅本轮临时容器按精确ID清理。

测试关注真实材料/SQLite事务/迁移和读回，Docker边界离线模拟后以Linux真实验收补齐。最终完整Windows/Linux回归、独立审查、中文说明、main提交推送及bundle同步；真实报告和数据库忽略Git。verified只对声明案例与本验证范围成立，不代表专业生物学有效性、敌对代码安全性或批准发布。
