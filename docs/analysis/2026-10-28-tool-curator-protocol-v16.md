# Tool Curator / Builder v16：提案登记成功，但运行协议验证失败

## 本轮输入与关联

- taskId: `7d84514b-1d2c-4293-93b0-2802fe99efe0`
- curationId: `abe7d4d1-aaad-4c3b-b3b5-b152720fc528`
- reportId: `8a793ce4-f0d3-4a20-91df-9f2490f2b560`
- proposalId: `fc5e9529-0b21-44c4-a687-32d13434da37`
- toolName: `report_fasta_quality_protocol_v10`
- validationId: `0bd4d294-c793-4020-aa77-e0fc96e12234`
- runtimeReleased: `false`

Curator 已经正确引用冻结的 gap report：`evidenceEventIds` 包含 `8a793ce4-f0d3-4a20-91df-9f2490f2b560`。Builder 生成了纯进程内候选和 baseline，静态扫描通过，候选在 Builder 自己的 4 个 benchmark 上全部胜出，并使用合法的 `minNetGain=2`。正式 `propose_exploration_tool` 只调用一次，服务端登记成功。

## 独立验证结果

proposal 登记后执行独立验证，结果为 `verification_failed`：

- artifact 完整性：通过；
- 运行镜像、Node 语法检查和 `no_external_access` 静态规则：通过；
- 隔离执行：发生 18 次，使用 UID 65534、无网络、无挂载、只读 rootfs；
- repeatability、8 个 domain cases 和 4 个 benchmark cases：全部 `protocolValid=false`，stdout 为空；
- benchmark gate：candidateScore=0、baselineScore=0、netGain=0、minNetGain=2。

根因是 Builder 为压缩提交体积，提交了只导出 `handleApprovalRequest`/`run`/`default` 的 ES module，却删除了从 stdin 读取 envelope 并向 stdout 输出 JSON 的入口。Builder 的本地测试调用了导出函数，因此误以为成功；正式验证器通过固定的 `/usr/bin/node /opt/tool/main.mjs` 进程和 stdin/stdout 协议执行，所以得到空 stdout。

## 与原仓库的对应关系

原仓库的工具封装协议要求包装器从 `sirna-approved-tool-call/v1` 请求的 `input` 读取业务参数，并只输出一个 JSON 对象；本地 `packages/capability-platform/tool-build-service.mjs` 的 `envelopeCommand()` 与 `parsedRun()` 也明确实现了相同的 stdin/stdout 边界。v16 暴露的是 Builder 提示没有把这条“进程入口协议”写清楚，而不是验证器过严。

## 修复

在 `packages/extensions/tool-curation/tool-curation-build-contract.mjs` 的 Builder prompt 中加入明确要求：候选和 baseline 必须从标准输入解析 envelope，必须从 `envelope.input` 读取业务字段，处理后只向 stdout 输出一个 JSON 对象，不能只导出函数、依赖 import，也不能输出日志。`tests/tool-curation-build.test.mjs` 增加对应断言。

修复证据：删除该提示后的 focused test 为 1 fail；恢复提示后 Builder 测试 30/30 通过，Curator+Builder 组合测试 49/49 通过。该修复尚未产生新的模型请求；需要下一轮全新 Builder runtime 才能验证它是否解决 v16 的实际失败。

