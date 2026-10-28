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

因此 v09 的结论是：**Curator candidate 成功，候选实现和 finalize 成功，proposal 登记失败；没有进入验证、批准或激活。** 任务当前为 `failed`。在用户明确确认后，已通过任务专属 `DELETE /v1/tasks/:id/runtime` 释放 v09 runtime，并核对 `runtimeReleased:true`、API `ready=true`、`busy=false`。这次释放只清理任务资源，不改变任何 proposal 或验证状态。

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

新增的三组测试分别锁定 Builder 的 envelope 字段、Builder 的 proposal 直传边界和 repair prompt 的实际 envelope 字段。新增护栏的定向测试为 27/27；`tool-approval-store` 单独运行 19 通过、1 个 Windows 符号链接能力跳过，`web-lifecycle` 单独运行 6/6。一次全量运行只出现瞬时 `bad port`，随后该测试文件重跑通过；因此不能把第一次全量的瞬时错误写成稳定回归，也不能在全量进程未正常收尾时声称全部通过。v09 的真实宿主失败不改变这些本地测试结果，因为失败发生在 proposal 大 payload 的传输边界。

## 当前边界与下一步

v09 证明协议提示已足以让 Builder 写出正确 envelope 解析和可重复候选，但尚未证明完整的“候选登记 → 14 次验证 → verified → 人工批准 → 激活”闭环。针对本轮失败原因，已在 `792e2b2` 中加入 transport guard：Builder 必须直接调用 `propose_exploration_tool`，禁止再用 `run_tool_build_command` 拼装 proposal 中间文件；随后又加入 proposal 体积、案例数量和唯一提交尝试护栏。v10 已使用前一条 direct-submit 护栏验证：没有出现 `prop.json` shell 组装，但旧提示仍允许模型多次 throwaway probe，最终因响应过大和重建会话失败而没有 proposal。下一轮必须使用最新 compact prompt；不能把 finalize 成功误报为 proposal 已提交，也不能复用旧 proposal 的验证状态。
