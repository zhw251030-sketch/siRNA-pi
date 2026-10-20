# 第10F步：正式工具发现、调用与审计

用户要求沿原仓库继续一个可学习、可验收步骤。前一步2b0fcea完成首版批准。本步是架构中的执行层：正式目录→AgentTool合同→受控Docker执行→审计→MCP结果。网页guest远程HTTP桥接是下一步，本步不配置端口、任务身份、guest镜像或重启服务。

## 参考与选择

参考本地只读仓库application965c53f/checkout67d2754的tool-proposals.ts:1195 executeApprovedPackage、1337 createApprovedAgentTool、1366 discoverApprovedTools及src/mcp-server.ts。正式guest通过/v1/agent-tools转发，后端负责实际执行。本步独立实现该后端核心，并以宿主stdio MCP验收。直接把Docker socket/登记库挂给guest会破坏职责边界；一次接完跨容器网络/身份则使本步过大，故不采用。

## 接口与行为

- 新tool-approved-execution.mjs导出discoverApprovedTools({root,runner})，返回{tools,packages,rejected}；tools为{name,label,description,parameters,executionMode:'sequential',execute(toolCallId,args,signal)}。名称保持toolName，不增加approved_前缀。
- args严格为{input:<普通JSON对象>}，JSON字节不超过65536；拒绝数组、未知顶层字段、协议包、循环、访问器、非有限数、非JSON值。inputFiles/outputFiles本步不支持，明确拒绝。toolCallId为UUID v4。业务模型只提供input，平台生成sirna-approved-tool-call/v1包。
- discovery只读，只有DB active/retained+正式包+原提案+报告+目录一致才能暴露。缺库返回空不建目录；损坏登记/目录返回rejected，不回退扫描孤立目录。调用时重新读取目录、包、登记证据并与发现时toolId/version/packageSha256/imageDigest绑定，旧描述符不能执行改变版本。无runner允许发现但不能执行。
- 复用现有createDockerValidationRunner的candidate执行内核，不重跑验证/基线、不改变批准。增加purpose='approved-call'选项，只改变容器名称、归属标签、事件语义；默认validation兼容。执行时仍校验镜像实际源码与来源，非root65534、无网络/宿主挂载/凭据/socket、只读根、1GiB/64进程/tmp64MiB、CPU配额不可用。固定准备助手可能装入历史baseline文本但不执行，未来通用执行内核可进一步拆分。
- runner由调用端显式提供，execute使用runner.run({target:'candidate',manifest:原提案manifest,input:原提案input,caseInput:args.input,toolCallId})。仅exitCode0且非timeout/cancel/overflow且protocolValid且output普通对象且filesDigest有效可返回成功；失败保留审计并抛错。每次执行新容器，由已有归属检查清理，不自动重试。
- 新tool-run-audit.mjs在runtime/approved-tool-runs/<toolName>/<UUID>/独占写request.json和audit.json。协议sirna-approved-tool-audit/v1沿参考字段：runId/toolCallId/toolName/proposalId/toolVersion/packageSha256/inputSha256/startedAt/finishedAt/exitCode/timedOut/cancelled/protocolValid/filesDigest/stdoutSha256/stderrSha256/outputSha256/success/error；增加toolId/imageDigest和operationError/cleanup未确认诊断。原始input/stdout/stderr不写审计，摘要仅表示一致性。先fsync请求再执行、结束fsync审计0400；目录0700，普通路径和无链接检查。操作异常、清理异常、执行后包变化不能标success。请求存在而无终态表示不完整，不自动补成失败或重跑。
- signal已取消时不启动；进行中取消不声称实时中断，等待受限runner清理后记cancelled并不给成功。宿主进程被杀仍可能留孤立容器，不能承诺崩溃自动恢复。
- 新apps/mcp/approved-server.mjs以显式discover回调连接同一MCP SDK，保留固定工具并动态加载正式工具。每次list/call重读，名称冲突/损坏目录明确失败，不能用空列表伪装。正式工具readOnlyHint=false/idempotentHint=false/destructiveHint=false/openWorldHint=false。只返回content，私有details/路径不出MCP；未知名/坏输入/执行失败为isError=true。每实例串行化正式调用或busy拒绝，避免无界并发。stdio入口Linux/hanwen/精确根/项目socket检查，不接guest启动路径。
- 旧管理CLI的agentCallable=false仍指网页未接线，文档区分后端可调用和网页状态。原MCP server.mjs及guest镜像保持固定工具行为。

## 验收与边界

TDD以真实SQLite/包/报告fixtures测试，替换仅Docker传输。覆盖读后篡改、未批准、未知/超大/协议输入、成功与非零/超时/协议错/清理失败、审计失败不能执行、重入/冲突及MCP内容隔离。最终Windows/Linux全套一次。服务器使用既有批准版本，通过真实stdio MCP列工具并执行2个新输入，独立核算length/gcFraction，核对审计/镜像/容器清理/原材料与旧会话不变；另坏参数确认无容器。0模型请求，不创建新镜像、不改DB、不重启服务。若模型/网页尚未接线，必须明确说明。

仅个人main，远端根/home/hanwen/Project/project/siNRA-pi。凭据不读不复制，运行证据私有runtime。遵循用户已有持续实现和main同步授权，不重复要求分支或设计确认；发生系统权限/服务风险变化才另行确认。
