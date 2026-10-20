# 第10A步：工具提案合同预检

用户要求沿参考仓库继续逐步重建，并在完成后结合代码讲解。上一轮已完成固定MCP工具；本轮完成工具治理的第一个独立切片：合同预检。保留main和已验证的网页/容器路径。

## 设计

参考packages/capability-platform/tool-contract.ts及领域output-matcher.ts，独立实现提案完整性检查、字段验证、字面递归子集匹配与重复性判据。脚本文本始终作为数据；本轮不执行、登记、安装、验证运行、批准或动态发布。不得把固定算法Map换成另造的治理库。

CLI `node scripts/check-tool-contract.mjs <proposal.json> [--draft]`：默认按原正式MCP入口要求runtimeArtifact；--draft只略过该产物的必填要求，其余正式合同仍检查。产物即使结构合法也不证明真实镜像存在或已通过验证。成功exit0，合同缺失/非法exit2，文件/JSON/命令用法错误exit1。输出JSON摘要，不回显候选或基线源码，不写文件，不调用模型或启动提案代码。

模块checkToolProposal(value,{requireRuntimeArtifact=true})返回ok、stage、executed:false、registered:false、activated:false、runtimeArtifactVerified:false与validationContract；失败附code/error/missingFields（缺项时）。沿用参考TOOL_CONTRACT_INCOMPLETE/TOOL_PROPOSAL_INVALID类别。保留原字段名称、类型、限制与三种permission profile；声明权限不等于授予权限。只接受可由JSON完整表达的数据；严格拒绝未知合同字段，文档记录与参考宽松HTTP验证的差异。

expectedOutput按recursive-subset/v1：对象只要求预期中的自有键，允许实际额外键；数组长度顺序完全一致；原始值Object.is；点号键是字面键，不解释为路径或比较表达式。validationRunPassed/casePassed/runsRepeatable只判断已有运行记录，不伪造运行记录或启动代码；exact比较stdout/stderr/filesDigest，contract只放宽跨次相等。未知mode拒绝。

## 文件与接口

- packages/capability-platform/tool-contract.mjs：collectToolContractIssues、validateToolProposalInput、checkToolProposal，重导出验证判据。
- packages/capability-platform/tool-validation.mjs：expectedOutputMatches、validationRunPassed、validationCasePassed、validationRunsRepeatable、toolValidationContract。
- scripts/check-tool-contract.mjs：有界读取JSON与退出码/安全摘要。
- examples/04-tool-contract/proposal.draft.json：独立Node教学序列统计脚本、较有限的baseline、输入/预期；真实运行产物尚不存在，因此不填假镜像摘要。
- 对应tests检查正确合同、缺项、边界、权限与锁定版本、比较规则、失败运行、CLI只读/不执行/退出码。完整例子可用--draft通过；默认明确报告/runtimeArtifact缺失。

## 版本与边界

参考checkout67d2754/application965c53f；Pi1.2.0、AgentCompose v2609.3.0不变。无新增依赖，无Docker/网页部署变化，无模型请求。正规MCP原入口要求OCI产物，原HTTP入口默认不要求，这是参考入口差异；--draft用于学习该区别，不表示本项目已有HTTP提交接口。纯结构通过永远不显示verified或approved。

## 验收

测试先失败后实现。用两种CLI模式检查同一真实教学文件；对子进程哨兵脚本证明不会执行；测试文件不变、不生成registry或运行目录。回归现有MCP协议与全部Node测试。服务器在唯一目录/home/hanwen/Project/project/siNRA-pi执行相同检查；旧任务元数据与guest保持。独立复核后提交推送main、Git bundle同步服务器并确认三处一致。
