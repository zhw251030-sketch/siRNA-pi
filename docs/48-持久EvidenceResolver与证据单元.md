# 第13C-H步：持久 Evidence Resolver 与证据单元

## 本阶段完成的事情

13C-G 已经能受控地 search/fetch，但当时返回的 evidence ID 是 `retrieval:<receiptId>:<index>` 这样的临时字符串。原仓库不会让模型自己拼出这种 ID，而是由后端生成随机 UUID、保存到数据库，并用 `(verificationId, dedupeKey)` 保证重复读取仍返回同一个证据单元。本阶段补齐这条关键链路。

现在的流程是：

```text
冻结 Bundle
  ↓
EvidenceResolver.prepareBundle()
  ↓
数据库 verification_evidence_units
  ↓
Verifier 只提交 { evidenceId }
  ↓
policy 按 verificationId 查回权威证据
```

## 与原仓库的对应关系

| 原仓库 | 学习版 | 对应作用 |
| --- | --- | --- |
| `goal-verification-evidence-resolver.ts` | `packages/extensions/goal/goal-verification-evidence-resolver.mjs` | 统一物化 bundle、message、artifact、retrieval、check |
| `GoalVerificationStore.recordEvidenceUnit()` | `goal-verification-store.mjs` | 随机 UUID、持久化字段和幂等去重 |
| `GoalVerificationAccessService.message/artifact/checkArtifact` | `goal-verification-access.mjs` 与 `goal-verification-evidence.mjs` | 每次读取都通过 Resolver 生成后端证据单元 |
| `GoalVerificationCoordinator` 的 `prepareBundle` | `goal-verification-coordinator.mjs` | `begin()` 后预建冻结消息、工具回执、产物元信息 evidence inventory |
| `resolve(run, review)` | `goal-verification-policy.mjs` 的 `resolveVerificationProposal(..., persistedUnits)` | 只允许当前 verification 的已登记 ID，并补齐权威字段 |
| `modelEvidenceUnit()` | `goal-verification-evidence-resolver.mjs` | 对模型只暴露 `evidenceId/method/sourceId/title/excerpt`，隐藏内部 dedupeKey、createdAt 和 verificationId |

## 文件逐个解释

### `goal-verification-store.mjs`

新增 `verification_evidence_units` 表：

```text
id                  随机 UUID
verification_id     绑定一次验证请求
method              retrieval/artifact_read/message_quote/tool_receipt/deterministic_check
retrieval_id        外部检索回执（如有）
source_url/source_id/title
excerpt             有界摘要
fetched_at/content_sha256
locator             JSON Pointer 或 chars:start-end
dedupe_key          同一验证内的幂等键
created_at
```

`recordEvidenceUnit()` 先用 `randomUUID()` 生成候选 ID，再执行 `INSERT OR IGNORE`。如果同一个验证请求和 dedupe key 已存在，随后查询旧记录并返回旧 UUID。因此重复调用不会产生第二个证据，也不会让同一份证据在重放时改变身份。

### `goal-verification-evidence-resolver.mjs`

`prepareBundle()` 为工具结束回执、消息分片和冻结产物元数据登记证据。消息和文本使用最多16,000字符的 `chars:start-end` 定位；tool receipt 的摘要由后端 canonical JSON 生成。

`materializeRetrieval()` 识别 OpenAlex、Crossref、Europe PMC 的三种 JSON 列表结构：`/results/i`、`/message/items/i` 和 `/resultList/result/i`。每条记录会从 DOI、PMID、PMCID 或 provider id 生成 `sourceId`，并保存后端计算的摘要、时间、哈希和 locator。没有结构化记录的 search 返回空列表；fetch 的普通文本才按字符分片。

`materializeArtifact()`、`materializeMessage()` 和 `materializeCheck()` 都先验证对象属于当前冻结 Bundle 或当前验证请求，再写入持久单元。`modelEvidenceUnit()` 将内部字段裁剪成模型协议允许的最小视图。

### `goal-verification-evidence.mjs` 与 `goal-verification-access.mjs`

受控 search/fetch 和 artifact check 不再直接构造 `check:<id>` 或 `retrieval:<id>:<index>` 字符串，而是调用 Resolver 后返回随机、持久的 `evidenceId`。`evidence` 目录也从数据库读取已登记单元，重复分页读取保持同一 ID。

### `goal-verification-coordinator.mjs` 与 `goal-verification-policy.mjs`

协调器在验证请求进入 `running` 后调用 `prepareBundle()`，再把当前验证的持久证据列表交给 proposal resolver。policy 现在接受持久 retrieval unit，并按 `retrievalId/sourceId` 做外部事实和来源数量检查；旧的确定性假 verifier 也改为使用后端生成的随机 evidence ID。

## 测试证据

本阶段先添加失败测试，再实现：

- 重复 `prepareBundle()` 返回相同 UUID；
- evidence ID 是随机 UUID，不再是 `message:<id>` 或 `artifact:<id>`；
- 检索 JSON 记录生成 DOI/sourceId 和 `/results/0` locator；
- 重复物化 retrieval/check 不增加数据库行；
- access、coordinator、policy 和完整回归保持通过。

`npm test` 当前结果为 **1568 项：1552 通过、16 个平台跳过、0 失败**。本轮没有真实互联网访问，也没有调用 MiniMax 或 Agent Compose；网络边界仍由 fake fetch 测试覆盖。

## 当前仍未完成的原仓库部分

1. `attempt` 还只是学习版的最小状态记录，尚未保存完整 prompt、session/run ID、raw response 与 protocol retry stage；
2. 尚未把 `TaskMessageService` 接到独立 verifier 的真实消息循环；
3. 尚未用 Agent Compose 创建真实独立验证容器，并让真实 verifier 通过 token-scoped search/fetch/message/artifact/check 工具工作；
4. 尚未做真实外部来源的端到端回放和 provider 失败后的 bounded retry；
5. Memory、Data Pool、Workbench 和 Black-box 等原仓库后续研究模块仍未开始。

下一步是把 `attempt`/retry feedback 和真实 Agent Compose verifier 接起来，先做无模型协议回放，再做一次受控真实模型验收。
