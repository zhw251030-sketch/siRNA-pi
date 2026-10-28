# 2026-10-28 Tool Curator 协议对照与 Builder 失败记录

本记录承接 [Tool Curator 真实验收](2026-10-28-tool-curator-live.md)。目标是把参考仓库的
“缺口报告 → 独立 Curator → Builder → 隔离验证”链路再跑一遍，并用真实失败理解边界。
本轮没有批准或激活任何新工具；所有失败记录都保留。

## 先把原仓库的职责对齐

参考仓库中相关实现位于：

| 参考仓库 | 学习仓库对应文件 | 作用 |
| --- | --- | --- |
| `packages/extensions/tool-curation/agent-tool-curator.ts` | `packages/extensions/tool-curation/agent-tool-curator.mjs` | 启动独立 Curator Agent，只把冻结 trace 交给它，并把一次响应交给严格解析器。 |
| `packages/extensions/tool-curation/tool-curation-coordinator.ts` | `packages/extensions/tool-curation/tool-curation-service.mjs`、`tool-curation-coordinator.mjs` | 决定何时创建审查请求、保存状态、拒绝自动重复和处理异常。 |
| `packages/extensions/tool-curation/tool-curation-trace.ts` | `packages/extensions/tool-curation/tool-curation-trace.mjs` | 把执行轨迹压缩为候选可见的证据；Goal、验证器、检索和构建控制操作被排除或脱敏。 |
| `packages/extensions/tool-curation/tool-curation-store.ts` | `packages/extensions/tool-curation/tool-curation-store.mjs` | 持久保存冻结 trace、Curator session/run、结果和错误，不因为模型失败自动重试。 |
| `packages/extensions/tool-curation/tool-curation-build-prompt.ts` | `packages/extensions/tool-curation/tool-curation-build-contract.mjs`、`tool-curation-build-service.mjs` | 将 candidate 转成固定 Builder 上下文，并计算 trace/result/prompt 三个绑定摘要。 |
| `packages/capability-platform/validate-tool.ts` | `packages/capability-platform/tool-validation-service.mjs`、`tool-validation-runner.mjs` | 重新执行候选和 baseline，计算领域得分、净增益、重复性和运行时完整性。 |
| `packages/capability-platform/tool-maintenance-worker.ts` | `scripts/validate-tool-proposal.mjs` 及 `runtime/tool-maintenance/jobs.sqlite` | 把验证作为独立维护作业执行并保存报告；个人仓库当前通过 CLI 直接触发。 |

因此，本轮实验的关键学习点不是“让模型多试几次”，而是每一层都要能证明：输入来自哪一层、
字段如何绑定、哪个角色有权限、验证到底执行了什么。

## v05：Curator 自身输出不完整

任务 `cd077986-e0b1-41ff-8a91-a0d900d95540` 的缺口报告进入独立审查，Curator 会话
`9d4bb322-5472-48d1-86cf-45b2830e0651` 返回了近乎完整的候选 JSON，但在嵌套
`restrictionSiteHits` 对象附近缺少结束括号。解析器在 EOF 处失败，记录为
`Independent curator did not complete a valid review`。

这说明 `agent-tool-curator.mjs` 的职责是“只接受一个完整 JSON”，而不是尝试修补模型输出。
如果后端替模型补括号，就无法再证明保存的结果是模型原始响应，也会破坏 Curator 结果与
`traceSha256` 的绑定。

## v06：冷却窗口阻止重复候选

任务 `f24cf0f0-942a-4218-988b-9c127eef3e9b` 产生了新的缺口报告，但能力键仍为
`fasta-quality-report`。服务返回 `skipped`，原因是 7 天冷却窗口内已经存在候选
`9134ddab-21b6-411d-93d6-74494e28d85a`。

这对应原仓库 coordinator/store 的重复保护：同一能力不能因为模型又报告一次，就无限创建
候选和构建任务。它把“模型声称缺口”与“系统接受一次独立审查”分开。

## v07：候选建立成功，但 Builder 对字段名理解错误

任务 `95e48d26-aa85-4d15-8e3f-0eba4475bdc6` 的 Curator 候选是
`report_fasta_quality_envelope`。Builder 成功提交了 proposal
`7cd9cbf9-349d-47b7-b4cb-5617cf75f1ab`，静态检查、语法检查、artifact 完整性和运行时
完整性都通过；独立验证的 17 次执行均返回：

```text
INVALID_ENVELOPE: envelope is missing required field: protocol
```

问题不是容器没有运行，而是 Builder 把候选描述中的协议字段写成了 `protocol`。仓库实际
在 `packages/capability-platform/tool-validation-runner.mjs:186-196` 生成：

```json
{
  "protocolVersion": "sirna-approved-tool-call/v1",
  "toolCallId": "...",
  "input": { "sequence": "...", "restrictionSites": [] }
}
```

`scripts/lib/tool-validation-guest.mjs:89-115` 将这个 envelope 原样写入候选 stdin；
候选必须读取 `raw.protocolVersion`，再从 `raw.input` 读取业务字段。v07 没有做到这一点，
所以 candidate 和 baseline 都得到 0 分，`netGain=0<minNetGain=3`，最终为
`verification_failed`。这证明验证器在检查真实协议接线，而不是只检查脚本能否启动。

## v08：Curator 正确描述协议，但 Builder 受宿主故障中止

任务 `3b0f6aac-ca43-4dc9-8d4c-e41568582dff` 的缺口报告显式写出此前两类错误：
顶层字段必须是 `protocolVersion`，业务字段位于 `envelope.input`。Curator
`f600556c-f0ce-431b-bf85-252b6737daaa` 返回 candidate，且严格结果绑定为：

```text
traceSha256  = f857b7e219e4aa6d0b27806bfbea5f76444a5804262501031ced7cdc4dec73c5
resultSha256 = bef93e2f442e5ec6e0b1e904c3a1a05d7f8cacb87baab68cb3c17cfaab9074ea
promptSha256 = 71c0d36dc1540512b2794afe2d55bb614d146c19cab57a5dc89284ebacd2c98b
```

Builder 交接已创建，固定工具名为 `fasta_quality_report_protocol_v2`，约束仍是
Node、空 dependencies、`exact`、`no_external_access`，没有 parent。后台真实事件显示它
完成了源码写入、执行测试和源文件哈希核对；随后 `finalize_tool_build` 多次遇到宿主侧
间歇错误。任务最终为 `failed`，`proposalId=null`，`runtimeReleased=false`、
`stopUnconfirmed=true`。因此这一轮没有 proposal，也没有验证、批准或激活结果。

这里不能把“Builder 写出了报告”当成“工具已提交”：原仓库的生命周期要求必须有宿主登记
的 `proposal_submitted`，并且 source/artifact/runtime identity 完整绑定。v08 缺少这一步，
所以只能记录为 Builder 阶段失败。

## 当前进度和后续入口

当前已经有真实证据的链路是：

1. 执行 Agent 通过 `sirna_tools_report_tool_gap` 报告能力缺口；
2. 后端冻结 trace，并过滤 verifier-only 证据；
3. 独立 Curator 成功返回嵌套 candidate；
4. Builder 至少一次成功登记过 submitted proposal（v07）；
5. 独立验证确实能执行候选并指出协议错误；
6. 自动批准保持关闭，失败或宿主不确定状态不会自动重试。

尚未完成的是新协议候选的一次完整成功链路：Builder 必须产生 `proposal_submitted`，然后
验证应达到 `passed=true`，最后再由人工批准进入正式目录。v08 的 `stopUnconfirmed` 是
任务生命周期清理状态，不应通过杀通用 daemon 解决；应先让宿主确认/恢复该失败任务的
运行时，再决定是否启动新的独立任务。旧 proposal 和失败报告都保持只读留存。

本轮没有修改正式工具目录，也没有把任何候选标成 verified、approved 或 active。

## 针对真实失败增加的合同护栏

v07 的失败暴露出仅把协议写在 Curator candidate 里还不够：Builder 可能在实现时把
`protocolVersion` 改写成近似字段。现在 `packages/extensions/tool-curation/tool-curation-build-contract.mjs`
在固定 Builder prompt 中直接写出验证器文件、完整 envelope 形状和禁止读取的错误路径；
`tests/tool-curation-build.test.mjs` 增加回归断言，确保后续改 prompt 时不会丢掉这条事实。

这项修改只改变 Builder 的说明，不放宽运行时验证、不替候选修补、不自动重试，也不改变
proposal、verification 或 approval 的状态机。新增提示后的本地全套回归为 1606 项：
1590 通过、16 项 Windows 平台跳过、0 失败。
