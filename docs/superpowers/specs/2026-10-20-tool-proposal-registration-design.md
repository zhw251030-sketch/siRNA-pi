# 第10C步：工具提案登记与完整性读回

## 目标与授权

承接10B的真实运行产物，按参考checkout67d2754/application965c53f建立持久提案登记。用户已授权按原架构继续实现并同步main；本轮为新增登记子系统，保持单一学习步骤。仅siRNA-pi/main，唯一远端根/home/hanwen/Project/project/siNRA-pi；不改参考/RSI、不安装系统组件、不读凭据、不调用模型、不重启服务或操作Docker资源。

## 方案选择

单独JSON索引容易在并发写入时丢记录；直接加入完整验证/审批会混淆提交与执行。本轮采用原职责：tool-proposals保存材料、tool-registry维护SQLite记录、tool-lifecycle组织提交与查询，可信CLI作为入口。SQLite沿用项目已有node:sqlite，不增加依赖。HTTP/MCP、自动维护worker和网页暂不连接。

## 数据与行为

- runtime/tool-artifacts/proposals/<UUID>/保存manifest.json、tool.mjs|py|sh、baseline.mjs|py|sh。manifest协议sirna-tool-proposal/v1，version=0.1.0-draft/status=draft；包含名称、描述、运行类型、源码文件/摘要、重复性、smokeInput、dependencies、testCases、baseline元数据、benchmarkCases、minNetGain（若提供）、permissions、runtimeArtifact、createdAt。独立编写格式，不复制应用源码。
- runtime/tool-registry/registry.sqlite保存tool_proposals和tool_events。初始state=submitted；proposal_submitted事件和提案行在同一BEGIN IMMEDIATE事务。事件actor=local-cli，不能声称Agent提交。没有正式版本或通过验证的记录。
- 登记必须通过现有checkToolProposal默认完整检查，要求runtimeArtifact结构，仍不验证镜像存在或执行正确。本步只支持新工具提案，含parent明确拒绝，待版本功能实现；同toolName不同提案允许，重复同材料每次新UUID，符合参考无内容去重。
- 材料包哈希使用排序文件名、NUL、原始字节；源码分别哈希。Linux文件0400、目录0500（学习版仅所有者可读；参考0444/0555）。权限只能防误改，读回仍必须核对摘要。Windows依靠摘要检查，不声称POSIX权限冻结。
- 读回按登记ID定位固定根下包目录，不能信任数据库中任意外部路径；验证准确文件集合、普通文件/非链接、大小、UTF-8、manifest字段、候选/基线哈希、整包摘要，以及数据库toolName/权限/镜像与manifest一致。修改、额外文件、丢失、链接、非法ID均拒绝。
- 文件与SQLite不是跨系统原子事务。先保存完成材料包，再登记；失败可能留下未登记包，错误保留ID/路径，不自动删除或伪报submitted。数据库失败必须回滚提案行和事件。进程崩溃恢复/幂等请求和孤立包维护不在本步范围。

## 文件和接口

tool-proposals.mjs导出createToolProposal(input,{proposalsRoot})与readToolProposal(id,{proposalsRoot,expectedArtifactSha256})，返回{manifest,input,artifactPath,artifactSha256}；create创建全新UUID，输入快照不被异步更改。目录由生命周期层先准备，函数只在提供的真实普通目录下操作。

tool-registry.mjs导出ToolRegistry(databasePath,{readOnly=false})，只接受显式绝对数据库路径，父目录已存在；方法registerProposal(input,{actor='local-cli'}={})、getProposal(id)、listProposals(limit=100)、listEvents(proposalId)、close()。登记input={id,toolName,artifactPath,artifactSha256,permissionProfile,imageDigest}。只提供提交与查询，无任意状态更新方法。校验字段、参数化SQL、路径/链接检查、私有数据库权限、类型/版本识别、readonly查询不执行迁移或建库。

tool-lifecycle.mjs导出submitRegisteredToolProposal(input,{root})、listRegisteredToolProposals({root})、getRegisteredToolProposal(id,{root})。仅显式项目root；返回提交/详情含proposal、registry和完整性证据，统一executed/verified/approved/activated/runtimeArtifactVerified=false。无数据库时list返回[]且不创建目录；show未知ID失败。

scripts/manage-tool-proposals.mjs通过npm run tools:proposals -- submit <项目内JSON>|list|show <UUID>运行。仅Linux/hanwen/指定唯一根；submit沿用有界readBuildProposal；list最多100条、show核对材料但不显示源码正文。成功退出0、失败1，JSON输出不回显用户源码或密钥。不会将提交动作接入现有自动化。

## 验收

真实SQLite重开/并行连接、事务事件回滚、同名多提案、严格只读/非法库拒绝；真实文件材料重读、独立摘要、候选/基线/manifest/额外文件变化拒绝；生命周期端到端提交/列表/show及无执行证据。服务器登记10B已有proposal副本，独立进程重读，正式库只有一条本轮提交且状态submitted；在专用临时库做篡改负例而不损坏正式材料。旧10会话/3容器/凭据元数据与镜像保持，模型调用0。最终Windows/Linux全套、独立审查、main提交推送/bundle同步。
