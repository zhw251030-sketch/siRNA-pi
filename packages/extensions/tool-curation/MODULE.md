# Tool Curation：工具发现扩展

本阶段只实现已结束任务轮次的只读轨迹预览。Task Core 仍负责保存任务、消息与公共事件，能力平台仍负责工具的构建、独立验证和发布。

输入：TaskStore.readRunEvidence 的有界记录，以及经过已有目录核验逻辑读出的正式工具名称。

输出：当前计算的 `sirna-tool-curation-preview/v1`，展示粗分组、阈值、依据事件和显示窗口。不是已冻结的原版 trace，不是 Curator 模型结果，更不是工具提案。

禁止：读取 worker 私有状态、访问模型密钥、调用模型或工具、准备/恢复 guest、改写任务事件或登记候选。

参考：sirna-pi-agent-service-refactor@67d275494c50f1e5c205b96b72a7b1623acfbe1d 的同目录 MODULE、trace、coordinator 和 agent-tool-curator。未发现参考根目录 LICENSE/NOTICE，本模块按公开职责与行为独立实现，未复制原模块。
