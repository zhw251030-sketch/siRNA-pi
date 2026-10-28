# 2026-10-28 Tool Curator 协议 v12 实验记录

v12 在 v11 静态门失败后使用了新增的 Builder prompt：候选和 baseline 都必须是 `no_external_access` 下的纯离线、进程内实现。

## 构建阶段

- task：`f40c5f84-6adb-4e8f-b431-c82f376b7110`
- report：`497dc075-9648-4e27-8e1a-a2790763f615`
- capability：`fasta_quality_report_protocol_v6`
- curation：`3fd099f6-1247-4f1a-ad7f-eeb2d1bd69d4`

Builder 读取最新提示后完成了：

- 候选 envelope 协议检查；
- GC fraction、最长 homopolymer、restriction-site hits 的候选实现；
- 纯进程内 baseline；
- 8 个测试案例和 2 个 benchmark 案例；
- 候选与 baseline 的 22 项断言；
- 候选和 baseline 静态扫描，均无 `child_process`、`spawn`、`fs`、网络、shell 或动态执行 API；
- 多次重复运行和 CLI 入口检查；
- `finalize_tool_build` 成功。

这说明 v11 暴露的 baseline 静态违规已经通过提示修复，且没有进入验证前门失败。

## 提交阶段

Builder 随后只做了一次正式 `propose_exploration_tool` 调用。客户端把非成功响应统一包装成了 accepted-operation/transport 不确定错误，表面上像提交传输问题；回读构建会话证据后确认，失败发生在宿主 `propose()` 的提交前置合同检查，尚未进入 registry。

v12 提案实际设置了 `minNetGain: 10`，但只提供了 2 个 `benchmarkCases`。本地用同一合同函数复现得到：

```text
code: TOOL_PROPOSAL_INVALID
error: minNetGain cannot exceed the benchmarkCases count
```

服务器构建事件 `runtime/tool-builds/b49fc5a8-3a3e-4941-8c8a-ee8886bdd65d/events.jsonl` 从 `finalized` 结束，没有 `proposal_submit` 或 `proposal_submission_failed`；因此 registry 未发生写入。服务器只读执行：

```text
manage-tool-proposals.mjs list
```

没有发现 `fasta_quality_report_protocol_v6` proposal。任务随后被受控取消，最终状态为：

- task：`failed`
- registry：无 v6 proposal
- `runtimeReleased=false`
- `stopUnconfirmed=true`

因此 v12 没有进入验证，也没有修改 v11 的 `verification_failed` proposal。不能把构建成功或一次 propose 调用误写成 proposal 已登记；本轮的“传输不确定”是客户端错误映射掩盖了一个可复现的提案合同错误。

## 与参考仓库的对应关系

| 原仓库职责 | 本地实现 | v12 证据 |
| --- | --- | --- |
| Builder 只提交完整 candidate | `tool-curation-build-contract.mjs`、`tool-build-sessions.mjs` | 候选/baseline 纯离线且 finalize 成功 |
| finalize 后直接 propose | `tool-builder-tools.mjs`、`tool-build-sessions.mjs` | 只发起一次 direct-submit，但 `minNetGain` 合同预检拒绝 |
| proposal 登记后才进入验证 | `tool-validation-service.mjs`、`manage-tool-proposals.mjs` | registry 无 v6，验证未启动 |
| 不确定结果禁止盲目重试 | `tool-build-sessions.mjs` 与任务生命周期 | 读取 registry 后停止，没有自动重提 |

当前结论是：**静态安全提示已经修复，Builder 构建合同已经通过；v12 的失败是 `minNetGain` 与 benchmark 数量不一致造成的提交前置合同拒绝，客户端错误映射使其看起来像 transport uncertainty。** 下一步应修正 Builder prompt 的 `minNetGain <= benchmarkCases.length` 约束，然后用全新 curation/build 任务重跑；不能重放 v12 的同一提交，也不能释放 v11/v12 runtime 作为“已验证”结果。
