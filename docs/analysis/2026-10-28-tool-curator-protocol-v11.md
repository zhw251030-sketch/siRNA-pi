# 2026-10-28 Tool Curator 协议 v11 实验记录

v11 使用最新的 direct-submit 和 compact prompt，目标是验证 v10 暴露的问题是否已经解决，并继续走到独立验证阶段。

## v11 的成功部分

任务：`46401ed6-4a4b-47b7-a38d-c879cc269d20`。

Agent 只调用一次 `sirna_tools_report_tool_gap`，报告为
`a89e9775-0da1-4ab1-9851-a59903817eeb`。随后完成了 preview、Curator candidate 和 Builder handoff：

- curation：`a3f172de-e53e-4a5c-bc60-638923c9a074`
- candidate：`fasta_quality_report_protocol_v5`
- proposal：`8bbda7d5-3689-4e28-beca-72ddf42aed83`
- proposal 状态：`submitted`
- `verified=false`、`approved=false`、`activated=false`

Builder 使用最新提示后，完成了候选源码、baseline、7 个 domain cases、3 个 benchmark cases 和 finalize，并且只执行了一次正式 `propose_exploration_tool`。没有出现 v09 的 `prop.json` shell 组装，也没有出现 v10 的多次 throwaway proposal probe。这证明 compact transport guard 已实际生效。

## 独立验证结果

使用服务器上的 `scripts/validate-tool-proposal.mjs` 启动独立 Docker 验证。结果：

- validation：`71e08c28-a005-4ec0-a98b-0d66043dc0ee`
- `artifactIntegrityPassed=true`
- `runtimeArtifactVerified=true`
- `executionCount=0`
- `state=verification_failed`

失败不是候选运行时错误，而是验证前静态扫描拒绝 baseline：

```text
ruleId: STATIC_NODE_PROCESS_API
target: baseline
file: baseline.mjs
line: 5
matchedText: node:child_process
```

因为权限档案是 `no_external_access`，baseline 也必须避免 `child_process`、`spawn`、`fs`、网络 API、shell 和动态执行。静态门失败后，验证器没有启动候选或 baseline，所以不能把 `executionCount=0` 解读为业务功能失败。

## 修订合同边界

按原仓库 repair 流程提交了：

```text
POST /v1/tool-proposals/8bbda7d5-3689-4e28-beca-72ddf42aed83/repair
```

repair 服务创建了 attempt 1。模型尝试把 baseline 改为进程内实现，但宿主返回了结构化合同拒绝：

```text
code: repair_contract_mismatch
outcome: not_registered
fields: ["baseline"]
```

这证明 baseline 属于冻结比较合同，不能为了让验证通过而替换。随后模型继续做等价性探测并进入重复构建尝试；为避免无效消耗，任务被受控取消。最终 repair 状态为 `phase=failed`、`already_requested`，没有自动重发，也没有产生替代 proposal。

## 本轮代码修复

现在 Builder 初始提示已经把静态门前置写明：候选和 baseline 都会被 `no_external_access` 静态扫描，必须是纯离线、进程内实现；禁止 `child_process`、`spawn`、`fs`、网络 API、shell、动态执行、Docker 控制和运行时安装。

定向 Builder 测试为 28/28，覆盖：

1. envelope 字段必须使用 `protocolVersion`、`toolCallId`、`input`；
2. proposal 必须直接提交；
3. proposal 体积和案例数量有界；
4. 禁止 throwaway proposal probe；
5. 候选和 baseline 的静态安全规则。

## 与参考仓库的对应关系

| 原仓库职责 | 本地实现 | v11 证据 |
| --- | --- | --- |
| finalize 后直接 propose | `tool-curation-build-contract.mjs`、`tool-build-sessions.mjs` | 一次 direct-submit，proposal 成功登记 |
| 独立验证前静态扫描 | `tool-validation-service.mjs`、`tool-validation-static.mjs` | baseline 的 `child_process` 被拒绝，0 次执行 |
| 失败反馈和修订 | `tool-repair-feedback.mjs`、`tool-repair-service.mjs` | repair_contract_mismatch，冻结 baseline 不可改 |
| 不自动重发 | `tool-repair-store.mjs`、协调器 | 取消后 `already_requested`，无替代 proposal |

当前还没有 verified proposal。下一步应使用新的 curation/build 任务，或在明确扩展 repair 合同后重新设计 baseline；不能修改旧 proposal、不能降低权限规则、不能把静态门失败写成工具业务失败。
