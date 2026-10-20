# 第10E步：明确批准与首个正式工具版本

## 目标与依据

按用户已确认的main单分支与逐步重建要求，延续第10D步已验证教学提案，完成显式批准、不可变正式包、版本登记和目录读回。参考application965c53f/checkout67d2754的tool-lifecycle.ts:1202/1230、tool-proposals.ts:991/1144、tool-registry.ts:767/782；独立实现可观察合同，不复制应用代码。

## 范围

只支持当前Node/零依赖/no_external_access/exact已登记提案的第一次发布，版本1.0.0。批准人显式提供，是审计声明而非认证。既有同名版本拒绝；parent、替换、禁用、回滚、运行审计、MCP/网页接入下轮再做。不执行候选、不调用模型、不操作Docker、不修改系统服务。真实验收批准当前f742eea2-b025-4474-ae47-d6eab267c408，批准人记hanwen (delegated learning step)，表示用户授权助手执行本学习步骤。

## 产物与身份

提案ID固定材料，validationId固定一次验证，toolId为新UUID且区别于proposalId，version=1.0.0。runtime/tool-artifacts/approved/<toolId>-1.0.0恰好五文件：manifest.json、tool.mjs、verification.json、approval.json、integrity.json。候选源码和报告保留原始字节；baseline仍在原提案。协议分别sirna-approved-tool/v1、sirna-tool-approval/v1、sirna-approved-tool-integrity/v1，字段按参考。批准包摘要SHA256(sorted name+NUL+fileHexSHA+LF)，不改变已有提案摘要算法。

发布使用私有临时目录、独占写入/fsync、Linux文件0400/目录0500，再重命名；目标已存在不覆盖。读回检查真实目录、普通单链接文件、精确文件集合、大小、严格UTF-8 JSON、读前后状态、各文件/整包摘要和跨文件身份关系；错误不回显原始JSON。源码200000字节、report16MiB、其他JSON1MiB。包摘要以数据库值为信任锚，不是数字签名。部分失败保留带路径证据，不自动清理。

## 状态与事务

SQLite schema3增加tool_versions，已知v1/v2仍可只读，migrate:true先保留一致备份后升级，新库v3。v1→v3一次备份后事务增加v2/v3结构；v2→v3保留v2备份。普通注册不强制迁移；v2仍可recordValidation，v3同样支持；未知布局拒绝。

批准前必须最新通过验证、材料/报告摘要匹配。activateVersion事务重新确认proposal.state=verified、最新validationId与reportSha及artifactSha完全等于前置快照、工具名/镜像一致、没有同名版本；插入active版本、提案approved、version_activated事件一同提交。版本行含toolId/toolName/version/state/proposalId/packageDirectory/packageSha256/imageDigest/runtimeState=retained/approvedBy/approvedAt/updatedAt。同一approvedAt写入包和DB。数据库内active表示目录选中版本，不代表Agent已接线。

## 流程与失败

服务重新核对提案、报告→生成正式包→完整读回并核对原证据仍相同→激活事务→重建目录。文件、SQLite、目录不是共同事务：包成功DB失败保留孤立包并报路径；DB成功目录失败报versionActivated=true及版本定位。重复批准已approved提案时核对原材料、原报告和正式包，返回同一版本并重建目录，不增版本或事件。

目录runtime/tool-registry/active-tools.json为sirna-tool-catalog/v1，generatedAt及tools数组；每项toolId/toolName/version/directoryName/packageSha256/imageDigest，按toolName排序。从DB active行与验证过的正式包生成，通过私有临时文件原子替换。读取必须与当前DB投影及包摘要一致，不能信任孤立目录；catalog-rebuild显式修复丢失/普通文件内容损坏，不跟随链接。versions只读，version详情验证包。show/report支持approved且仍要求最新passing报告，show核对正式包后才返回approved/activated=true，agentCallable=false。

## 验收与边界

TDD真实文件/SQLite覆盖成功、未验证/失败/篡改拒绝、同名冲突、重复批准幂等、事务失败、报告/材料在前置与激活之间变化、目录失败后修复、包/目录链接与篡改拒绝。两平台完整回归后服务器验收：正式proposal approved、1个active1.0.0、同一报告与源字节、3事件、五文件与目录摘要独立核对、重复批准无变化；负例在独立runtime目录。旧10会话/3容器/凭据元数据保持，模型0。main提交推送及项目内bundle同步，无新分支、无系统更改。
