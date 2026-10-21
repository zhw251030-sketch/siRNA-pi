# Curator 轨迹预览实施计划

> **For agentic workers:** 使用 subagent-driven-development 的独立实现与审查流程；用户已指定个人 main，持续同步，无需另建分支。

**Goal:** 从已结束的一轮公共工具事件生成只读、有限大小的能力线索预览，并在当前任务网页中展示。

**Architecture:** Task Core 提供有界公共记录；tool-curation 扩展做确定性归一化与筛选；API/网页只读取。保留原仓库职责分层，本阶段没有 Curator 模型、候选登记或自动构建。

**Tech Stack:** Node ESM、SQLite、原生 HTTP、浏览器 ES modules，零新增依赖。

**Spec:** 本文下述契约。参考提交 67d275494c50f1e5c205b96b72a7b1623acfbe1d 的 tool-curation-trace/coordinator/agent-tool-curator；独立实现，不复制整模块。

## 全局约束

- 个人起点 5cdc5edba7f57d68f5fd8593e5e7a4a07981cab1，main；远端仅 /home/hanwen/Project/project/siNRA-pi。
- 不调用模型、运行工具、创建/修订/批准提案；不读取凭据内容；不改旧业务记录。
- 不改变数据库 schema，不启动新 worker/guest；部署仅空闲网页进程重启。
- 常见敏感字段脱敏不是所有私密文本的安全认证；网页仅用 textContent。
- 源事件最多 2000 条、JSON 总量 4 MiB，超限明确 413，不能当成没有线索。

## 共同接口

纯函数 `buildCurationPreview({taskId,runId,userMessageId,objective,events,existingTools})`，导出于 `packages/extensions/tool-curation/tool-curation-trace.mjs`。所有事件只属于同 task/run/userMessage；service 保证终态，纯函数验证绑定与配对。不完整/冲突调用不计资格。

返回 `{protocolVersion:'sirna-tool-curation-preview/v1',taskId,runId,userMessageId,objective,sourceSha256,previewSha256,eligibleForReview,summary,calls,signals,limits}`。

- summary: `{toolStarts,consideredCalls,excludedCalls,incompleteCalls,omittedCalls}`。
- calls 最后 12 个业务调用；每项 `{startEventId,endEventId?,toolCallId,reportedToolName,actualToolName,capabilityKey,inputSha256,inputPreview,outputPreview?,outcome:'success'|'error'|'unknown',exclusionReason?:string}`。普通 read/write、MCP 元操作、Goal/Builder/验证控制调用不回传输入输出，纳入 excludedCalls。
- signals: 最多 20 项 `{capabilityKey,callCount,distinctInputs,errorCount,evidenceEventIds,evidenceComplete}`。全轮完整业务调用按网络 host、bash 首程序、工具名粗分组，排除既有工具名称，阈值 `(calls>=3 && inputs>=2) || errors>=2`。依据不在显示窗口时 evidenceComplete=false；limits 明示省略量。
- limits 至少 `{maxCalls:12,omittedSignals,displayTruncated}`；最终整个 preview <=64KiB。摘要为已保存记录的 canonical hash，不声称原始 provider 请求摘要；previewSha256 覆盖除该字段外的最终对象。
- 内层 MCP details.mcpResult.isError 与外层错误均识别；没有 end 或无法确定 outcome 必须 unknown。无法可信解析/截断的输入不能制造“不同输入”。

服务 `createToolCurationPreview({taskStore,listExistingTools})` 返回 `{read(taskId,runId?)}`，同步只读。`read` 返回 `{preview:null,reason:'no_run'}` 或 `{preview:buildCurationPreview(...)}`；错误类 `ToolCurationPreviewError(statusCode,message)`。不存在404、进行中/无终态409、有界限制413、目录不可用503。默认取 task.currentRunId，不擅自回退到别轮。显式 runId 接受旧SDK UUID或实际Compose64hex，且必须属于该任务。

HTTP `GET /v1/tasks/:id/curation-preview?runId=<可选轮次编号>`，只允许至多一个 runId 参数。同源限制沿用现有路由。

网页模块 `createCurationPreviewPanel({root,fetcher=fetch})` 返回 `{setTask(task),refresh()}`；setTask 按 id/currentRunId/status 清除旧结果、取消旧请求；只有用户点击才 GET。任务选择/轮次切换拒绝旧响应。

## Task 1: 确定性轨迹和脱敏

文件：新增 tool-curation-trace.mjs、可选 sibling sanitizer、tests/tool-curation-trace.test.mjs。

- [ ] 先写阈值、实际 MCP 参数、内层错误、已有工具、元操作、文件操作、跨 run/重复结束/缺失结束、JSON 秘密和 URL 信息、中文超长输入与最终字节上限测试，运行证明未实现时失败。
- [ ] 独立实现上面的纯函数；规范化排序的对象摘要，明确标记窗口与未知结果。
- [ ] 运行该测试，独立审查规格和质量。

## Task 2: Task Core 有界读取、服务与 HTTP

文件：task-store.mjs、tool-curation-preview.mjs、bootstrap.mjs、router.mjs、tests/tool-curation-preview.test.mjs。

- [ ] 临时 SQLite+真实 HTTP 测试：空任务、结束任务、运行中、其他任务run、参数错误、过大历史、目录失败；断言数据库所有业务记录前后相同，runtime 方法零调用。
- [ ] `readRunEvidence(taskId,runId)` 先统计记录条数/UTF8字节，限制内才读取，并仅取该轮绑定用户消息；超限返回标记，未知返回 null。
- [ ] 注入只读目录名称，生产包含固定 enumerate_sirna_candidates 和当前正式工具名；不得执行工具。
- [ ] 跑聚焦测试并审查。

## Task 3: 任务网页

文件：public/curation.mjs、index.html、style.css、app.js、tests/curation-ui.test.mjs。

- [ ] 测试手动刷新、无选择、运行中、错误、迟到响应、任务切换及安全文本渲染。
- [ ] 展示当前任务/轮次、统计、规则、排除说明、输入输出预览、事件ID、摘要和窗口限制；文案明确不是模型建议、不是冻结证据。
- [ ] 将 setTask 接到现有任务状态更新，新增静态模块路由；独立审查。

## Task 4: 验证、教学与同步

- [ ] 运行本机和服务器完整测试；旧证据保全记录使用全新 runtime/curation-preview-* 前缀。
- [ ] 仅部署已检查文件，空闲时重启项目网页；GET 旧真实任务并核查业务表/文件/正式工具不变，浏览器验证。
- [ ] docs/29-工具发现轨迹预览.md 解释原版映射、数据流、真实结果与范围；更新 README、学习路线和个人 AGENTS。
- [ ] 审查后 commit/push main，通过守卫 bundle 同步服务器并核验三处提交与干净状态。

## 设计裁定

- 用户已要求继续实施并固定 main；按此授权直接实施和同步，不重复索取流程性批准。
- 采用独立文件所有权并行实现与审查，避免共享编辑冲突。
- 普通文件读写在本阶段提前排除：原版在后续 Curator prompt 要求不为其造工具，个人当前尚无模型审查，所以保守前移。明确记录这一差异。
- 这是新 preview 协议，不假冒原版已持久化/frozen 的 trace/v1 包；正式 Curator/存储/调度留给后续步骤。
- 实际审查修正：done/error后允许两种公共workspace归档通知；终态后业务调用仍拒绝。
- 教学显示补充：顶层excludedCalls保留最后20条安全名称/事件ID/固定原因，不含输入输出；limits显示省略量，仍纳入最终64KiB与hash。sourceSha绑定完整保存输入和规范目录。
- 真实部署修正：Compose实际使用64hex runId。增加先失败再通过的显式查询回归，保留SDK UUID兼容和task/run联合绑定。

## 执行与审查记录

Task 1–3 已实现并完成独立审查。完整1261项两端0失败，随后Compose编号修正两端38项定向通过；目标折叠21项UI相关通过。真实16任务GET验收14预览/2no_run/0eligible，重复默认与显式读取一致，旧业务状态保全。详见docs/29-工具发现轨迹预览.md；最终main提交及服务器一致性由私有runtime/curation-preview-sync.json回执记录。
