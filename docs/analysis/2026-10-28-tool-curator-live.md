# 2026-10-28 Tool Curator 真实缺口到候选验收

本轮把参考仓库中“执行 Agent 发现能力缺口，独立 Tool Curator 冻结证据并给出候选”的主链路接到个人仓库的真实网页服务。网页仍通过本机 SSH 隧道访问 http://127.0.0.1:3000/，服务器项目目录仍是 /home/hanwen/Project/project/siNRA-pi。

## 参考实现与本地对应

参考仓库的 packages/extensions/tool-curation/agent-tool-curator.ts 负责启动隔离 Curator、只接受一个 JSON 响应并校验运行身份；个人仓库的 packages/extensions/tool-curation/agent-tool-curator.mjs 做同样的 Agent Compose/Pi 适配。参考的 tool-curation-coordinator.ts 负责从冻结的运行证据派发审查；个人仓库把这条路径拆在 tool-curation-service.mjs 和 tool-curation-coordinator.mjs，当前自动派发仍关闭，人工 POST 是显式门。

参考的 tool-curation-trace.ts 把执行工具调用归一化为有限 trace，并排除 Goal、构建和验证器控制操作；个人仓库的 tool-curation-trace.mjs 现在还明确排除 8 个 verifier-only 工具，并递归脱敏 verification/retrieval/evidence 的 ID 和 token。参考的 tool-curation-store.ts 把审查记录放进任务存储；个人仓库使用 runtime/tool-curation/curation.sqlite，保存 immutable trace、Curator session/run 身份、结果和错误状态。两种存储布局不同，但“冻结后不可改、异常不自动重试”的边界一致。

参考的 agent-compose.yml 为 Curator 使用独立角色、空工具面和独立数据目录；个人仓库的 agent-compose-curator.yml 与 containers/agent-compose-guest/Dockerfile.curator 对应这一隔离。Curator 只看到后端生成的 prompt 和 trace，不拥有任务文件、宿主 lease、构建工具或 MCP。

## 真实运行记录

前两次运行先用于暴露边界，记录没有删除：

1. 第一次任务 9eed1951-d0f7-4c21-a1e0-99441fc9c230 成功产生缺口报告，但服务器遗留的 Curator profile 与版本化 profile 字节不一致。stageCuratorProfile 按设计拒绝启动，记录为 error，没有重试。
2. 第二次任务 cb60e3d0-145a-48bf-90ff-99faaa569047 的 Curator 进程真实启动、产生一个响应并释放运行环境，但模型把 capabilityKey 等候选字段放在顶层。严格 validator 拒绝了这个协议错误；这促使我们把 toolCurationPrompt() 改成明确要求 candidate 嵌套对象，并补回归断言。
3. 第三次任务发现了真实的执行阶段越界：Agent 找到缺口后自行进入 Builder。该任务被显式取消，保留为“自然语言门控不足、需要角色隔离和阶段门”的负例。
4. 最终验收任务 1a28e2b9-6224-4e15-b471-86a194426bac 使用有界协议输入，只调用一次 sirna_tools_report_tool_gap，报告 ID 为 d4d27b5f-4d18-4b75-a6fb-8b46c2c4e51a，随后正常结束。冻结预览的 sourceSha256 为 376357c01f7e8fbb5708de902c3c2ffb1fb1b1cd6f9ea970a4266f3f2112188f，previewSha256 为 0d09a9967f2dc45663aaa730be3d0a6056d17edfb70a2fe210b558f636b31e92。

用这两个摘要提交人工审查后，Curator 记录 9134ddab-21b6-411d-93d6-74494e28d85a 进入 candidate，trigger=online_gap，trace 摘要为 8b4d7e9f14708ce1358c7b5d68b89319e7df007c0147304e1941751683fc0245。独立运行身份为 session 831b70e2-cfc5-439a-8a75-201a6fdc84e1、run 3b75169682ce0e305bb8a1c1ef286981caf882864a29942ab193592716bd412f。Curator 返回的候选为 fasta_quality_report，权限建议为 no_external_access，并明确引用了同一缺口报告 ID；结果已经通过严格的嵌套候选校验。

这条候选只代表“值得人工进入 Builder/验证阶段的建议”。它没有创建工具、没有生成镜像、没有进入正式目录，也没有证明缺口主张或工具设计正确。下一阶段必须由 Builder 在固定源码、权限和测试合同下实现，再经过独立验证、人工批准，才能进入正式工具目录。

## 同轮的证据边界修复

审查还发现个人 verifier 路径会在 prepareBundle() 预先生成 artifact metadata evidence，理论上可以绕过真实文件读取。现在 goal-verification-evidence-resolver.mjs 删除了这段预注册；只有 materializeArtifact()/实际 read_verification_artifact 才生成 artifact_read unit。为保留确定性 verifier 的测试，goal-verification-coordinator.mjs 注入不可枚举的窄 readArtifactEvidence 适配器，goal-verification-fake.mjs 只有在真正请求 artifact 时才调用它。

本轮新增测试还确认 Curator trace 不会携带 verifier-only 调用、短期 token、retrievalId 或 evidenceId。这样 verifier 的学术检索证据不会污染执行工具的自进化输入，也不会被误解释成执行 Agent 已经拥有的工具能力。

## 验证和当前进度

- 定向回归：91 项，89 通过、2 个 Windows 平台跳过、0 失败。
- 全套回归：1605 项，1589 通过、16 个 Windows 平台跳过、0 失败。
- 服务器重启后 127.0.0.1:3000/health 和 192.168.1.169:3001/health 均返回 ready=true,busy=false。
- 实现提交：b356697（候选响应契约提示修复）、9b2fce4（verifier/Curator 证据边界修复）。

当前整体位置是：Goal 真实失败反馈续跑已完成，执行侧 Goal 工具已完成令牌接线，Tool Gap→独立 Curator→candidate 也有真实成功证据。仍未完成的是 candidate→Builder→独立验证→人工批准→正式目录的真实新工具交接；自动批准保持关闭，不能把本轮 candidate 当成已发布工具。

## Builder 交接结果

随后通过 build view 读取固定绑定，并提交了 traceSha256、resultSha256、promptSha256 三个摘要。Builder 使用同一个任务运行环境，在 no_external_access、node、空 dependencies、exact repeatability 约束下创建并测试了 fasta_quality_report。它完成了 17 个功能测试和构建产物检查；两项 benchmark 暴露了反向互补和 IUPAC 模式处理的结果契约差异，Builder 继续尝试修正测试与实现。

最终宿主事件已经登记 proposal 1cb0e71b-fae0-4abb-97bf-2ebbeca807b1，工具名 fasta_quality_report，状态 submitted，runtime artifact 和 source/baseline SHA-256 均与登记材料一致，artifactSha256 为 20b8be3052ab6934c3862af3762caa466a2a26b3f403c2a07a6462c2cc17bef4。这个提案的 verified、approved、activated 都是 false。Builder 随后的清理操作产生了未知结果，网页任务因此为 failed，系统没有自动重试；通过宿主只读 show 已确认 proposal 登记和材料完整，所以不能把 Agent turn 的 failed 隐瞒，也不能把 submitted 提案当成已验证工具。

下一步是独立执行候选与 baseline 的验证，检查上述 benchmark 契约问题、净增益和权限边界；只有验证报告通过后，才允许人工批准并分配正式版本。验证和批准仍未执行。
