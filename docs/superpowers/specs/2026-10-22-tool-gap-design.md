# 11D：明确能力缺口报告

个人基线c418659，参考sirna-pi-agent-service-refactor固定67d2754只读。本轮接通report_tool_gap→可信保存→结束轮次预览→人工独立Curator审查；保留11C人工Builder交接及后续验证/批准。

## 范围与来源

参考sirna-tools.ts:290、router.ts:1566、tool-curation-store.ts、coordinator.ts:54及agent-tool-curator.ts:62。工具提交六项业务数据，后端决定task/run/userMessage；同run规范化capability去重，任何合法报告都可形成online_gap审查线索，blocking仅为报告者判断，不自动取消任务。gap本身的ID可以作为候选引用，空evidenceEventIds允许；这只证明报告存在，不证明缺口真实。

个人使用现有activated lease的task/session/sandbox/turn/run五项可信来源，不采用原版单header或唯一任务fallback。报告只接受正在执行且未终态的本轮；轮次结束或审查冻结后拒绝新增。继续手动送审、单task/run一次审查、失败不自动重试。没有自动观察、冷却调度、Goal/Verifier接入或自动构建/批准。

## 固定接口

- ToolGapStore({root,readOnly=false})位于packages/extensions/tool-curation/tool-gap-store.mjs；独立runtime/tool-gaps/gaps.sqlite，严格schema身份、路径/旁文件链接防护、不可变payload摘要、事务内UNIQUE(task_id,run_id,capability_key)。list(taskId,runId)、create(inputWithTrustedSource)返回{report,deduplicated}、close()及databasePath。同key先到者保留，重复不更新内容。
- createToolGapService({store,taskStore,curationStore})位于tool-gap-service.mjs；同步report(input,taskContext)返回{report,deduplicated,candidateCreated:false,toolCreated:false,nextGate:"finish_current_turn_then_manual_curator_review"}；list(taskId,runId)核查归属后只读。ToolGapError使用安全固定消息和statusCode（400格式、404任务/轮不存在、409身份/终态/冻结冲突、413容量、503存储不可用）。
- input只允许capability、blocking、reason、desiredInput、desiredOutput、可选evidenceEventIds。capability修剪后3–500字符，reason3–4000，blocking布尔，两个草案必须普通JSON对象且各≤4096字节，evidenceEventIds≤100个非空唯一字符串，每项≤500字符；省略等价[]。全请求≤32768字节、深度≤16，拒绝额外身份字段/accessors/危险JSON键。采用现有证据脱敏器；按脱敏后capability小写、非Unicode字母数字转连字符、去首尾连字符、截断160字符，空key拒绝。这是明确的本地差异：原版仅保留ASCII字母数字和基本汉字，并为空键回退unspecified-capability；本地保留其他语言的字母，避免不同名称丢失成同一空键，并拒绝没有可用名称的报告。
- report沿原版字段{id,taskId,runId,userMessageId,capability,capabilityKey,blocking,reason,desiredInput,desiredOutput,evidenceEventIds,createdAt}；增加source五项实际身份和reportSha256。不得保存token。每run最多10报告、报告数组JSON累计≤32768字节，超过拒绝而不静默截断；重复在容量检查前返回原记录。服务用有界readRunEvidence校验当前run/user/所有引用事件与未终态，并核当前task.running/currentRunId/session。
- 私有UDS经relay开放POST /v1/tool-gaps，使用现有Bearer/task/turn认证；读取body前和后核验activated lease，handle.run排空跟踪，服务持久化前检查取消。新202/重复200，正文上述service结果。网页router不开放POST报告，不能替Agent伪造来源。报告不走approved-tool执行审计，不触发Docker、模型或Curator。
- MCP为独立report工具类别，readOnlyHint/idempotentHint均false，显式调用一次无自动重试。createToolGapClient({baseUrl,contextPath,timeoutMs=10000}).report(args,signal)，每次读既有context，固定endpoint、禁止重定向、请求32768/响应65536上限；验证response身份、固定false字段及去重状态，失败只输出安全消息。createToolGapTools({service})返回一个report_tool_gap。createRemoteMcpServer新增gapUrl（CLI env SIRNA_TOOL_GAP_URL），只配置后展示；普通宿主固定枚举工具保持原语义。

## 证据与兼容

createToolCurationPreview增加可选listGapReports(taskId,runId)，未配置或空报告时保持11A预览字节/摘要语义完全相同。有报告则加gapReports并把完整脱敏报告纳入sourceSha256与previewSha256，eligibleForReview=true；不伪造重复调用signals。报告逐项验证task/run/user、摘要和引用事件在当前快照中；超过64KiB明确413，不丢弃完整报告。原控制调用report_tool_gap继续被排除，不能给重复次数加分。

冻结trace可因完整调用组或合法报告创建，有报告trigger=online_gap，gapReports完整保存；显式引用的公共事件以脱敏gapEvidence保存（不只留下无法解释的事件号），总trace仍≤64KiB。没有报告时旧trace结构/摘要规则保持。result验证：原完整组规则不放宽；也允许capabilityKey匹配报告、至少引用该组的一个报告ID，其他引用仅来自该组报告所引用且已冻结的事件。不能跨能力挪用ID。提示明确报告是模型主张、blocking非后端判决、报告存在不证明能力确实缺失。ToolCurationStore从冻结trace读取post_run/online_gap，不改旧schema或旧记录。

网页在结束轮预览显示报告、阻塞判断的来源、原因、输入输出、引用与ID；gap-only可手动送审。没有报告时兼容旧页面。模型文字用textContent；任务切换/晚响应保护保持。候选后续可沿11C交给Builder，测试覆盖gap-only candidate到构建说明读取，工程模拟不算实际模型成果。

最终联调审查补充：新报告控制名report_tool_gap（含已有sirna_tools_别名规范）不得被新的Curator建议或工具提案占用，否则将来批准后会使MCP目录发生名称冲突。在候选/构建说明与提案入场层使用共享保留名规则；保留末端MCP碰撞检查，不改变旧预览参与摘要的existingTools数组，也不扩展为历史所有控制工具的重构。

## 部署与验证

新guest标签sirna-pi-guest:pi1.2.0-mcp5，Agent Compose项目identity sirna-pi-learning-tool-gap，只供新任务；旧任务metadata/guest/image保持。relay增加一条固定路径，权限/网络/卷不扩大。根代理在空闲状态构建项目镜像并更新项目controller/relay配置及API，无系统安装或root。真实guest内无模型MCP验收+隔离HTTP/存储/审查/UI行为验收；不把模拟报告写入生产任务。

Linux完整测试、Windows相关测试、独立审查；旧六业务DB schema/行、证据/原生会话/正式目录/旧guest保持。镜像只新增本轮标签，两个管理容器更换有明确回执。教学docs/32、README/AGENTS/学习路线/MODULE更新；个人main提交推送并bundle同步，核验三处一致。所有远端新增状态/缓存/临时文件仅在/home/hanwen/Project/project/siNRA-pi。密钥不读不打印不入Git，0付费模型调用。
