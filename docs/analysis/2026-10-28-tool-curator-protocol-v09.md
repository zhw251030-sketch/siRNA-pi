# 2026-10-28 Tool Curator 协议 v09 实验记录

本轮是在 v08 runtime 已经受控释放后重新创建的独立任务，目的是验证最近加入的协议护栏是否能让 Builder 生成一个真正读取 `sirna-approved-tool-call/v1` envelope 的工具。v08 的失败不是 Curator 判断错误，而是候选源码把业务字段当成了顶层 `raw.sequence`，或者把协议字段写成 `protocol`；因此本轮只改变 Builder 的固定提示和测试动作，不追认旧 proposal。

## 运行链路

v09 任务为 `bc11c5e8-f341-49a0-8302-cb534f40606c`，执行 run 为
`a72695c7fb6b6ebcbe69559cd67fb346b47dff6faddad26f6b49a09b5f4036e9`。

1. Pi Agent 只调用一次 `sirna_tools_report_tool_gap`，报告
   `49821b35-eef6-41f4-a4d0-9dc13c6df363`，没有自行调用 build、验证或写文件工具。
2. `GET /v1/tasks/:id/curation-preview` 把报告和调用轨迹冻结为预览；随后显式提交到
   `POST /v1/tasks/:id/curations`。Curator 生成
   `d4eaac0b-0693-4b3b-b1c8-a18b4197baf4`，状态为 `candidate`。
3. 候选固定工具名为 `fasta_quality_report_protocol_v3`。它要求顶层
   `protocolVersion`、`toolCallId`、`input`，业务字段只能位于 `input.sequence` 和
   `input.restrictionSites`；输出是 GC 比例、最长同聚物和限制性位点命中范围。
4. Builder 交接保存了 `traceSha256`、`resultSha256`、`promptSha256` 三项绑定，并在独立 build session 中完成：
   - 17 个断言测试；
   - 60/60 随机候选与独立 baseline 差分一致；
   - 候选重复运行字节一致；
   - 23 个提案样例（含 7 个 benchmark）通过候选/baseline 对照；
   - `finalize_tool_build` 成功，最后一个 artifact digest 为
     `sha256:b810d96a2da4fc129b5e39155a4bad5cbef663eb99ec36c36090114c9b42db60`。
5. Builder 在把约 31KB 的完整 proposal JSON 传给 `propose_exploration_tool` 时多次遇到宿主命令长度/会话卡死错误。宿主没有留下新 proposal；只读执行
   `manage-tool-proposals.mjs list` 仍只看到旧的 `fasta_quality_report` 和
   `report_fasta_quality_envelope`，没有 `fasta_quality_report_protocol_v3`。

因此 v09 的结论是：**Curator candidate 成功，候选实现和 finalize 成功，proposal 登记失败；没有进入验证、批准或激活。** 任务当前为 `failed`，其 Agent Compose runtime 的记录是 `runtimeReleased:false`、`stopUnconfirmed:true`。这只表示生命周期释放尚未得到宿主确认，不表示已经有可验证 proposal；释放属于有副作用的运维动作，需要单独确认。

## 与参考仓库的对应关系

- 参考 `agent-tool-curator.ts` / `tool-curation-coordinator.ts` 对应本地
  `packages/extensions/tool-curation/agent-tool-curator.mjs` 和
  `tool-curation-coordinator.mjs`：先保存 gap report，再生成不可变 trace，最后才允许 Builder。
- 参考 `tool-curation-build-prompt.ts` 对应
  `packages/extensions/tool-curation/tool-curation-build-contract.mjs`。本轮新增的提示护栏把验证器真实 envelope 写进 Builder 指令，明确禁止 `raw.sequence`、`raw.restrictionSites` 和 `protocol`。
- 参考 `validate-tool.ts` 对应
  `packages/capability-platform/tool-validation-runner.mjs`。它会把每个业务输入包装成
  `{protocolVersion, toolCallId, input}`；因此 smoke、domain、benchmark 和 baseline 的输入都只能写业务字段。
- 参考 `tool-repair-prompt.ts` 对应
  `packages/capability-platform/tool-repair-service.mjs`。v09 仍只是新构建尝试，未形成 proposal，所以没有错误地对旧 proposal 发起 repair。

## 代码回归状态

协议修复位于：

- `packages/extensions/tool-curation/tool-curation-build-contract.mjs`
- `packages/capability-platform/tool-repair-service.mjs`
- `tests/tool-curation-build.test.mjs`
- `tests/tool-repair.test.mjs`

新增的两组测试分别锁定 Builder 和 repair prompt 的实际 envelope 字段。完整回归为 1607 项：1591 通过、16 项 Windows 平台跳过、0 失败；服务器和本机的 `git diff --check` 均通过。v09 的真实宿主失败不改变这些本地测试结果，因为失败发生在 proposal 大 payload 的传输边界。

## 当前边界与下一步

v09 证明协议提示已足以让 Builder 写出正确 envelope 解析和可重复候选，但尚未证明完整的“候选登记 → 14 次验证 → verified → 人工批准 → 激活”闭环。下一步必须先对 v09 runtime 做一次获得确认的生命周期释放并核对 `runtimeReleased:true`，然后针对当前宿主的 proposal 长度边界缩小候选合同或修复传输方式，再开一个全新任务；不能把 finalize 成功误报为 proposal 已提交，也不能复用旧 proposal 的验证状态。
