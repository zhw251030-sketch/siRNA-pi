# 2026-10-28 Tool Curator 协议 v10 实验记录

v10 是在 v09 runtime 已获得用户确认并释放后创建的独立任务。目的不是重复 v09 的协议解析修复，而是验证 `finalize_tool_build` 之后把 proposal 直接作为 `propose_exploration_tool` 参数发送，能否绕过 v09 暴露的 shell 命令长度问题。

## 真实运行

- task：`dd94470e-eea4-4799-8e2b-2597442ce47c`
- execution session：`49f82704-88df-49ee-85d7-f32c3a88351d`
- run：`194badfd8d982fb7847f8d0f04cd01bc811231d3b402d24a7070ab10a0cda58d`
- report：`4ba39d67-86a6-4f0c-b50f-c66785e5c42a`
- curation：`8c125346-8ca8-4f6c-8de9-e1a306037114`
- candidate：`fasta_quality_report_protocol_v4`

Pi Agent 只调用 `sirna_tools_report_tool_gap`。Curator 正常生成 `candidate`，并保存了 trace/result/prompt 三项摘要；Builder 也完成了候选源码、baseline 和测试动作，最后执行了 `finalize_tool_build`。

## v10 证明了什么

事件日志没有出现 v09 的 `run_tool_build_command` → `prop.json` → shell 拼装路径。Builder 确实尝试把完整 proposal 直接交给 `propose_exploration_tool`。这验证了 `792e2b2` 的 direct-submit 提示方向与参考仓库 `apps/api/extensions/blackbox-core-routes.ts:311-321` 一致：完成构建后直接提交，而不是把宿主提交材料伪装成候选代码运行。

## v10 为什么仍然失败

本轮使用的是加入 compact guard 之前的提示词，因此模型先后进行了多次 throwaway proposal probe，并在第一次提交被截断后重新创建 Builder session。事件末尾明确记录了 `payload too large`，随后再次写文件、创建 session，最终任务进入 `failed`。宿主 proposal registry 中没有新增 v4；旧的两个 `verification_failed` proposal 也没有被改变。任务 runtime 目前仍是 `runtimeReleased:false`、`stopUnconfirmed:true`，不能在没有单独确认的情况下释放。

所以 v10 的严格结论是：**Curator candidate 成功，Builder 候选和 finalize 完成，直接提交路径被实际尝试，但多次试探和过大的模型响应使 proposal 没有登记；没有进入 14 次验证、人工批准或激活。** 这不是“proposal API 太小”的证据；已知 API、客户端和 MCP 输出上限都高于 v09 约 31KB 的材料，失败来自 Builder 生成过程和旧提示的行为约束。

## 本轮修复已落地但尚未用于 v10

最新的 `packages/extensions/tool-curation/tool-curation-build-contract.mjs` 要求：

1. proposal JSON 小于 120000 个 UTF-8 字节；
2. `testCases` 最多 8 个、`benchmarkCases` 最多 4 个，只保留最小必要字段；
3. 源码和 baseline 去掉不必要注释与空白；
4. 禁止 throwaway proposal probe，第一次正式 `propose_exploration_tool` 必须是唯一提交尝试。

`tests/tool-curation-build.test.mjs` 已增加这四项提示合同断言，定向测试为 27/27。由于 v10 在这些改动提交前已经运行，下一轮需要同步最新代码并重新创建全新 task；不能把 v10 的失败当成新提示已经验证。

## 与参考仓库的对应关系

| 原仓库职责 | 学习仓库实现 | 本轮观察 |
| --- | --- | --- |
| `blackbox-core-routes.ts` 中 finalize 后直接 propose | `tool-curation-build-contract.mjs` 的 Builder prompt、`tool-builder-tools.mjs` 的提交工具 | direct-submit 路径已被真实调用 |
| 独立 Builder session 与 artifact 绑定 | `tool-curation-build-service.mjs`、`tool-build-sessions.mjs` | 新 session 和 finalize 事件存在，但没有 proposal 登记 |
| `validate-tool.ts` 的 proposal 后独立验证 | `tool-validation-service.mjs`、`tool-validation-runner.mjs` | 本轮未达到 proposal 状态，因此 14 次验证未启动 |
| maintenance/approval 状态机 | `tool-proposals.mjs`、`tool-maintenance-worker.mjs`、`manage-tool-proposals.mjs` | registry 没有新 proposal，批准和激活保持关闭 |

当前主线下一阶段是：先提交并同步 compact prompt，确认新的服务器版本可用；随后在用户单独确认释放 v10 runtime 后，再创建全新任务验证“一次直接提交 → 新 proposal → 14 次独立验证”的闭环。
