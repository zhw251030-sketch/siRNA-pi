# Tool Curator / Builder v17：stdin/stdout 运行协议验证通过

## 本轮身份

- taskId: `60501cbb-7191-4686-9c0e-e3d298d241bd`
- runId: `038a02b2a06761066c4ebbd3485fb25113778d119280d4f23bcc43a219f9077b`
- gap report: `f608d9d2-e058-4e3d-86b9-fd69c96ce988`
- curationId: `5fdb0c06-fc66-4ea5-94a1-52453280ba80`
- proposalId: `417eb711-1b00-4347-a26c-374bf0dca81b`
- toolName: `fasta_quality_report_protocol`
- validationId: `9950a5e9-8eb4-475b-bfcf-928b219d5b4d`
- runtimeReleased: `false`

## 流程结果

本轮先创建一个真实 Agent Compose 任务，让 Agent 只调用一次 `sirna_tools_report_tool_gap`。任务结束后，网页服务读取 `curation-preview`，冻结本轮 `sourceSha256` 和 `previewSha256`，再显式提交 Curator。Curator 返回 `candidate`，并在 `evidenceEventIds` 中精确引用 gap report `f608d9d2-e058-4e3d-86b9-fd69c96ce988`。Builder handoff 使用 curation 的三项 SHA 绑定启动，最终只登记一个 proposal。

本轮 Builder 经过多次候选代码调试和案例核对后，使用一个新的 finalize build session 生成不可变 runtime artifact。正式提交响应为：`state=submitted`、`registered=true`、`verified=false`、`approved=false`、`activated=false`。任务运行本身正常结束，runtime 仍保留用于审计。

## 独立验证

通过服务器上的 `scripts/validate-tool-proposal.mjs` 执行了独立验证，结果为 `state=verified`、`passed=true`：

- `artifactIntegrityPassed=true`，注册包与源文件哈希一致；
- `runtimeArtifactVerified=true`，固定 Node runtime artifact 可读；
- `staticCheck.passed=true`，`no_external_access` 下没有文件、网络、子进程、动态执行或 Docker 控制违规；
- `executionCount=18`，候选和 baseline 均在 UID 65534、无网络、无挂载、只读 rootfs 的隔离环境中执行；
- `repeatabilityPassed=true`，两次相同 smoke 输入的输出和执行记录满足 exact 合同；
- `domainGatePassed=true`，8 个业务测试全部通过；
- benchmark 候选 4/4、baseline 0/4，`netGain=4 >= minNetGain=2`。

工具语义是一个确定性的 FASTA 质量报告：从 `sirna-approved-tool-call/v1` 的 stdin envelope 读取 `input.sequence` 和 `input.restrictionSites`，向 stdout 输出单个 JSON 对象，计算 GC fraction、最长同碱基连续段和重叠 restriction-site 命中。候选与 baseline 都声明 `node`、空依赖和 `no_external_access`；baseline 是较弱实现，因此 benchmark 能区分候选带来的 FASTA/重叠匹配能力。

## v16 到 v17 的关键修复

v16 的候选登记成功，但独立验证得到空 stdout 和 `protocolValid=false`。原因是 Builder 为缩短源码删掉了进程入口，只留下 ES module 导出函数；Builder 自己调用导出函数时没有暴露这个差异。v17 的 Builder prompt 明确要求：脚本必须从标准输入解析完整 envelope，只从 `envelope.input` 读取业务字段，处理后只向 stdout 输出一个 JSON 对象，不能依赖调用方 import，也不能写日志。v17 的独立验证证明该约束已真正落地。

## 与原仓库的对应关系

- 原仓库 `packages/domain/sirna-tools/sirna-tools.ts` 的 `propose_exploration_tool` 合同要求先完成 OCI build-session，再提交不变的 `runtimeArtifact`；本轮的 `create_tool_build_session → write_tool_build_file → run_tool_build_command → finalize_tool_build → propose_exploration_tool` 完整执行了这条路径。
- 原仓库 `apps/api/extensions/blackbox-core-routes.ts` 要求 proposal 保留完整描述、业务输入、expectedOutput、baseline 和 benchmarkCases；本轮登记包包含这些字段，并由独立 validator 重新执行。
- 本地 `packages/capability-platform/tool-build-service.mjs` 的 `envelopeCommand()` 把业务输入包装为 `sirna-approved-tool-call/v1` 后通过 stdin 传给容器，`parsedRun()` 只接受 stdout 中的一个 JSON 对象；v17 正是针对这一合同完成修复。
- 本地 `packages/capability-platform/tool-validation-service.mjs` 重新执行 smoke、domain cases 和 candidate/baseline benchmarks，并把结果写成不可变 validation report；因此 Builder 的自测不再被当成最终证据。
- 本地 `packages/extensions/tool-curation/tool-curation-result.mjs` 和 `tool-curation-build-contract.mjs` 把 Curator 的报告 ID、权限边界、业务输入与 Builder handoff 绑定；本轮的 `evidenceEventIds` 和三项 SHA 关联可追溯到同一条 gap report。

## 当前边界

验证通过只证明这个候选满足当前 proposal 合同并在当前 4 个 benchmark 上胜出。它还没有经过人工批准、版本激活或生产业务调用；没有把它写入 active tool catalog，也没有据此声称自进化机制已经稳定或具有独立泛化能力。后续应在用户确认后再决定是否批准/激活，以及是否释放 v17 runtime。

