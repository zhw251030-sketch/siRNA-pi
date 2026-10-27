# 2026-10-27 受控外部检索 Goal 实验记录

## 实验目的

13C-J 已经证明 verifier 能读取真实文件和工具回执。本轮继续验证原仓库的受控外部事实链：执行任务产生报告，独立 verifier 使用固定学术 provider 重新检索，再把 retrieval evidence 绑定到外部事实 claim。重点观察执行侧工具能力、后端来源抓取和最终证据引用是否保持一致。

## 第一条真实任务：执行侧能力缺口

任务 `70838c59-2984-4163-8043-c16b556362af` 的目标是检索 RNA interference 的外部来源。执行 Agent 实际列出了自己的 `sirna-tools` MCP，确认只有 siRNA、构建、tool-gap 和健康探针工具，没有学术检索工具；它没有伪造标题或 DOI，而是写出阻塞报告并提交了 tool gap。这个运行产生 79 个工具回执和 5 个输出 artifact。

第一次 verifier 容器因为证据目录达到 102 个 unit，连续分页读取工具回执后超时；这不是 provider 失败。重试后 verifier 成功调用 OpenAlex 和 Europe PMC，均返回真实 retrieval receipts，但它正确判定执行 Agent 没有交付来源，Goal 保持 active/paused，未被错误标记为完成。这个结果把两个边界分开了：`goal-verification-evidence.mjs` 能访问外部来源，普通执行 Agent 的 `sirna-tools` 目前不能。

## 第二条真实任务：独立检索核对文件报告

任务 `dc644b57-5bda-4316-b488-2ee64bf55e86` 上传了一份真实检索记录，来源来自前一轮 OpenAlex 返回的 `DOI:10.1038/418244a`、标题 `RNA interference` 和 OpenAlex work URL。执行 Agent 只做受控文件操作：

```text
read /workspace/input/retrieval_source.json
write /workspace/output/retrieval_report.json
read /workspace/output/retrieval_report.json
```

文件内容逐字复制，输出为合法 JSON，4 个工具回执和 3 个 artifact 均已冻结。独立 verifier 随后真实调用 OpenAlex，返回同一个 DOI、标题和 work ID；还执行了 `json_valid`、`text_stats` 和来源抓取。说明“文件执行证据”和“外部来源证据”两条链都已经连通。

最终仍有一个协议层缺口：连续几次 verifier proposal 都把外部事实 claim 的证据留在 artifact/tool 证据上，或把 retrieval 只写进 rationale，没有在 `claim.evidence` 中列出 retrieval evidenceId；另有一次把复读条目没有绑定 artifact 类证据。policy 因此返回 `EXTERNAL_FACT_WITHOUT_RETRIEVAL` 和 `REQUIREMENT_EVIDENCE_CLASS_MISMATCH`，Goal 保持 `active`。这属于正确的 fail-closed 行为，不能把“独立检索成功”直接当成 Goal 通过。

为减少第一次实验中不必要的证据分页，`packages/extensions/goal/goal-verification-agent-compose.mjs` 现在明确要求：search/fetch 已返回 evidence 时直接使用其 evidenceId，不要遍历整个证据目录；每个 `external_fact + supported` claim 必须至少列出一个 retrieval evidenceId。对应的单元测试位于 `tests/goal-verification-agent-compose.test.mjs`。

## 与原仓库的对应关系

| 学习版 | 原仓库 | 本轮观察 |
| --- | --- | --- |
| `goal-verification-evidence.mjs`、`goal-verification-access.mjs` | `packages/extensions/goal/goal-verification-access.ts` | HTTPS allowlist、OpenAlex/Europe PMC search、receipt 和 evidence unit 真实工作 |
| `goal-verification-evidence-resolver.mjs` | `goal-verification-evidence-resolver.ts` | 将 retrieval/check/artifact 物化成后端拥有的 ID，拒绝模型自造 locator |
| `goal-verification-policy.mjs` | `goal-verification-policy.ts` | 外部事实没有 retrieval 或验收项证据类别不匹配时 fail-closed |
| `goal-verification-agent-compose.mjs` | `agent-goal-verifier.ts` | 独立容器、短期 token、协议重试和直接 retrieval 提示 |
| `apps/mcp/goal-verifier.mjs` | `src/goal-verifier-mcp.ts` | 只读 search/fetch/check/artifact 入口；执行 Agent 尚未接入这组 verifier 专用工具 |

## 当前结论和下一步

本轮没有声称外部检索 Goal 已完成，但取得了三个可复现结论：真实 provider 能被 verifier 访问；执行 Agent 的工具表没有学术检索能力；policy 能阻止缺少 retrieval evidenceId 的外部事实通过。下一步应优先修复 verifier 输出中的证据类别绑定，增加针对“external claim 必须引用 retrieval、artifact claim 必须引用 artifact/check”的结构化回放测试；之后再决定是否把受控检索能力作为普通执行 Agent 的正式工具，或继续保持“执行 Agent 产出、独立 verifier 检索核对”的职责分离。
