# 2026-10-28 Tool Curator 协议 v13 实验记录

v13 使用了 v12 根因修复后的服务器版本，目标是验证 `minNetGain <= benchmarkCases.length` 之后，Builder 能否完成候选、baseline、finalize 和 direct-submit。

## 已完成的阶段

- task：`f3ecb091-b8d5-4ee6-858c-97ba017fb0ba`
- report：`afea2389-6244-4e62-b75d-4650fc7cde87`
- curation：`352003ac-a07c-4058-86a6-3c76abfc95ca`
- capability：`fasta_quality_report_protocol_v7`
- suggested tool：`report_fasta_quality`
- Builder handoff：`auto-tool-curation-build:352003ac-a07c-4058-86a6-3c76abfc95ca`

执行 Agent 只调用了一次 `sirna_tools_report_tool_gap`。预览的 `sourceSha256` 为
`3dc390333db143c2921f3956e55f9127559c4783e6c04a24141d030f999fb5ba`，
`previewSha256` 为
`1359463464648c679071de78c5866e0a10a1876550c0626a5f314548a77597f7`；独立 Curator 返回了 candidate，冻结 `traceSha256` 为
`c763fcac2fa51574d16269ecfe3b912fbafb328b21a97b32f0f1f2529f0b9bdd`。

Builder 在新的 prompt 下完成了纯进程内候选和 baseline、22 项断言、静态禁用 API 检查、重复运行和 finalize。最终 artifact 为：

- build session：`ff540c5f-bb81-4971-80d6-a487767e1ed7`
- source SHA-256：`dc1b5e8a5727a4111edb40bb469f2339c7b9bf96fe9863a7ba81908d43ded14b`
- artifact digest：`sha256:b541e66855c09313849f0796f2f16801ec7ce00e9011414a481aaf4dcf0e407a`
- candidate source：4439 字节

这些证据说明 v11 的 baseline 静态门、v12 的 `minNetGain` 数量门和构建隔离门都已被实际走通。

## 新的失败边界

第一次正式 `propose_exploration_tool` 调用发生在 finalize 之后，但宿主在登记前合同检查拒绝了 proposal，返回的客户端错误仍是泛化的“accepted operation may have completed”。本轮 proposal 使用了 `minNetGain:2` 和 3 个 benchmark，已经满足新的数量规则；失败原因是 proposal 的 `smokeInput`、`testCases[].input` 和 `benchmarkCases[].input` 仍包含完整的 `sirna-approved-tool-call/v1` execution envelope。

`packages/capability-platform/tool-contract.mjs` 的 `businessInput()` 明确拒绝这种结构：proposal 案例只允许业务输入，验证器在执行时才自动补上顶层 `protocolVersion`、`toolCallId` 和 `input`。因此这次拒绝发生在 `tool-build-sessions.mjs` 的 `checkToolProposal()` 预检阶段，没有写入 registry，也没有生成 proposal ID、validation 或 activation。

Builder 在收到不透明错误后又进行了第二次 proposal 尝试和新的构建会话；这些事件被保留为失败证据，任务随后受控取消。最终状态为：

- task：`idle`
- Builder handoff：`failed`
- proposal：无
- registry/validation/approval/activation：均无新增记录
- runtimeReleased：`false`
- stopUnconfirmed：`false`

不能把 v13 的 finalize 成功写成 proposal 已登记，也不能在同一不确定会话中继续重提。

## 本轮修复

`packages/extensions/tool-curation/tool-curation-build-contract.mjs` 现在明确说明：proposal 的 `smokeInput`、`testCases[].input` 和 `benchmarkCases[].input` 必须是去掉 execution envelope 的业务输入；候选和 baseline 源码仍从 verifier 自动添加的 `envelope.input` 读取字段。

`tests/tool-curation-build.test.mjs` 新增了该语义边界的回归测试。按 TDD 顺序，先移除提示语运行测试得到 1/1 失败，再恢复提示语运行完整 Builder 定向套件得到 30/30 通过。

## 与参考仓库的对应关系

| 原仓库职责 | 本地学习版 | v13 证据 |
| --- | --- | --- |
| Curator 冻结执行证据并给出 candidate | `tool-curation-preview.mjs`、`tool-curation-service.mjs`、`tool-curation-store.mjs` | candidate 状态和三个摘要已冻结 |
| candidate 交给原任务 Builder | `tool-curation-build-service.mjs`、`tool-curation-build-contract.mjs` | 同一 task 的固定 `auto-tool-curation-build:` 消息 |
| Builder 在隔离环境构建并 finalize | `tool-build-sessions.mjs`、`tool-builder-tools.mjs` | 候选/baseline 静态干净，finalize 和 artifact readback 成功 |
| finalize 后直接 propose | `tool-build-sessions.mjs`、`tool-contract.mjs` | direct-submit 已发生，但在登记前合同拒绝 |
| 登记后再独立验证 | `tool-validation-service.mjs` | v13 未到 registry，因此尚未启动验证 |

下一轮必须使用全新的 curation/build task，验证“业务输入案例与 execution envelope 分离”修复；不能重放 v13 的不确定提交，也不释放 v11、v12 或 v13 runtime，除非用户分别确认。
