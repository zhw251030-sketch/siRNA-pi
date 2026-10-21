# Tool Curation：工具发现扩展

本阶段实现已结束任务轮次的只读轨迹预览、显式送审、不可变证据和独立Curator建议。Task Core仍负责保存任务、消息与公共事件，能力平台仍负责工具构建、独立验证和发布。

输入：TaskStore.readRunEvidence的有界记录，以及经过已有目录核验逻辑读出的正式工具名称。snapshot一次取得来源与目录；原始目录给11A预览构建器，冻结目录另按相同规则去sirna_tools_前缀、去重、排序，避免双重规范化。

输出：`sirna-tool-curation-preview/v1`仍是临时预览；显式送审产生`sirna-tool-curation-trace/v1`，独立Agent返回`sirna-tool-curation-result/v1`。trace沿原版主字段，增加sourceSha256、previewSha256、signals、evidenceMetadata；inputSha256允许null明确表示原输入不可用。完整触发组不代表完整原始正文，truncated独立保留。

状态：runtime/tool-curation/curation.sqlite独立保存请求与结果；单实例单消费者、task/run唯一、冻结后禁止重写。正常关闭排空已接受请求；启动时未完成记录变error并暂停接收，不自动重发。恢复入口仅供可信运维，HTTP不开放。

执行：bootstrap注入独立tool-curator角色的AgentComposeRuntime，独立sessions/events目录和180秒截止的RPC。此扩展不读取模型密钥、不调用业务工具、不读取worker私有状态，也不修改任务事件或工具登记库。Curator镜像关闭全部工具，完整回答一旦包含工具意图即本地中止，另有执行前拦截；适配器180秒发出取消，零重试，启动/清理可另需时间；必须确认终态、结果身份和guest释放。

边界：规则预览不派发；Curator的candidate是建议，尚未成为能力平台的submitted提案。未接自动观察、online_gap、自动Builder或批准。结构与引用检查不证明建议正确或有收益；JSON.parse沿用标准重复键语义。预览/trace仅常见字段脱敏，不承诺消除任意私密文本。

参考：sirna-pi-agent-service-refactor@67d275494c50f1e5c205b96b72a7b1623acfbe1d 的同目录 MODULE、trace、coordinator 和 agent-tool-curator。未发现参考根目录 LICENSE/NOTICE，本模块按公开职责与行为独立实现，未复制原模块。
