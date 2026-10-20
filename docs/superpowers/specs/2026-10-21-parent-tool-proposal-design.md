# 第10H步：父版本提案与真实基线比较

用户授权沿原仓库继续逐步重建。本轮完成版本迭代的第一个可验收单元：明确parent、冻结真实父版本源码为baseline、构建新候选、登记并独立验证。批准后续版本、数据库多版本迁移、切换和回退留在下一单元，不能把verified称为已发布。

## 原仓库与本轮范围

参考只读基线67d2754。正式tool-lifecycle.ts:754处理已有工具必须指定同名存在的parent，tool-proposals.ts:610/619分别保存baseline与parent；它们是独立字段。原实现不会自动保证baseline等于parent实现。本学习单元增加明确约束：parent仅为当前已批准active/retained的1.0.0，baseline.runtime和源码SHA必须与通过完整证据读回的正式parent相同。这是学习仓库的额外约束，不宣称原项目已有。

候选仍是普通Node工具，no_external_access、无额外依赖、exact；用原来的固定Node基座执行父版本源码，不直接执行父版本OCI镜像。因此报告称“父版本源码比较”，不能称完整父运行环境复现。

## 数据与流程

1. tool-proposals材料保留可选parent:{toolName,version}，纳入现有整包SHA；同名约束在材料层和服务层检查。旧无parent材料字节和读取方式保持兼容。
2. 提交时：首次工具无parent；已有正式同名工具必须提供parent。父版本不存在、工具名不同、状态不允许或baseline源码不匹配，在保存新材料及登记前拒绝。
3. 新导出assertRegisteredToolParent(input,{root,registry})：无parent返回undefined；有parent则核验版本、正式包、来源提案、报告及baseline，返回parentComparison。复用readRegisteredToolVersion，不执行源码；不得对原始凭据或会话读取。
4. parentComparison精确字段：toolName,version,toolId,packageSha256,imageDigest,scriptSha256,baselineScriptSha256,comparisonMode。comparisonMode固定registered-parent-source；两源码SHA相等。manifest保留parent名称/版本，报告增加完整parentComparison。
5. 验证在runner接收材料之前核验parent，全部执行完成后再次核验并与首次绑定比较。失败不能写passed=true或verified；保留现有基础设施失败诊断。show/report读回也核对parent和报告比较身份，旧无parent报告保持兼容。
6. 独立验证仍使用现有七关卡；parent提案即使verified也在approve入口明确拒绝，拒绝必须发生在任何包/目录/数据库写入前。

## 教学候选

新增examples/05-parent-tool-proposal/proposal.draft.json。parent指summarize_target_sequence@1.0.0，baseline逐字复制上一轮正式源码对应的原教学candidate；提交时再以真实正式包校验。

候选保持length、gcFraction，增加baseCounts:{A,C,G,T}。先去FASTA标题/空白、转大写、U归一为T，故baseCounts描述归一后的DNA字母，不能误称原始RNA字母计数。旧版本没输出counts是功能边界，不是旧length/gcFraction计算错误。

案例固定：ACGT→4/0.5/各1；AACCGGGUUUA→11/5/11/A3C2G3T3；FASTA小写ggccau→6/2/3/A1C2G2T1。3个领域例检查完整输出。3个benchmark中第1个只要求旧字段、第2和第3要求新增counts，预期candidate3/3、parent1/3、netGain2，minNetGain1。此成绩只说明明确的新字段契约通过，不证明总体算法优越、泛化、生物有效或自动自进化。

## 验收与保护

TDD覆盖材料往返/摘要、无父/错父/弱基线/父包损坏、提交不执行代码、验证前后父完整性、报告绑定及parent批准拒绝。临时测试使用真实SQLite和正式包证据，Docker仅在边界替身；不模拟整套内部逻辑。

本机及Linux完整测试后，在唯一远端项目根构建一个候选并正式登记/验证一次；无需模型调用。保留现有正式工具包/版本/catalog/批准记录、全部旧任务与运行容器。新候选停留verified，网页仍使用1.0.0。记录真实构建与验证次数/镜像/清理/来源摘要，main同步三处。仅项目内可逆操作，不改系统服务/权限及RSI项目。
