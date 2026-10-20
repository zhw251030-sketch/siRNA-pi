# 第一个正式 MCP 工具：设计与范围

用户已要求按照参考仓库继续逐步重建；上一轮说明并获准继续的顺序是补齐上传验收，然后接入一个简单自定义工具。本轮只做这一步，沿用 main 和现有独立任务容器。

## 目标与取舍

选择参考仓库的 `enumerate_sirna_candidates`，以确定性的候选枚举作为第一个工具。采用 Agent Compose 声明 MCP 服务、guest 内 stdio 调用的正式路径。仅在本机 SDK 注册工具不能验证正式路径；直接迁移到 Pi 1.2 原生 MCP 则需要适配上游传入参数，因此先验证 Compose 自带的显式 MCP adapter，只有证据表明不兼容时才作限定的版本桥接。

## 合同

- 输入：targetSequence 字符串原始长度19..100000；可选 guideLength 整数19..27默认21；maxCandidates 整数1..100默认40。拒绝未知字段，区别于参考默认可能接受额外字段的行为。
- 序列去除 FASTA 标题和空白、统一大小写、U转T，拒绝空串和非ACGT字符。本轮沿用参考多记录连接行为，文档明确应上传单条靶序列。
- 输出字段与参考相同：sequenceLength、guideLength、totalWindows、returnedCandidates、scoringMethod、candidates。每个候选含id/start/end/targetWindow/guide/gcFraction/prefilterScore/warnings。
- 坐标从1开始并包含两端；候选窗口与guide输出RNA字母。评分规则按参考 transparent_prefilter_v1 独立实现，只是透明预筛选，不是活性预测或实验结论。
- MCP `tools/list` 只列这一项业务工具；`tools/call` 验证参数、执行、返回JSON文本；错误以isError反馈。无文件、网络、子进程能力。

## 分层与版本边界

领域纯函数位于 packages/domain/sirna-tools；工具合同位于同模块 sirna-tools.mjs；协议适配位于 apps/mcp/server.mjs。不移植动态工具注册库、治理、OCI构建、自进化或专业软件。

agent-compose.yml 是正式 MCP 配置来源；镜像包含已锁定 SDK 与工具代码。保留原生read/write、会话与模型参数及禁用自动扩展发现。验证直接工具暴露与旧adapter的兼容性，避免默默同时启用两套MCP。现有旧guest保持原镜像，配置变化只影响新任务。

## 验收

1. 已有上传样例独立验收：真实read/write/read、3/27/9、归档/HTTP/工作区一致、结束后保留。
2. 工具函数手工推导样例、排序、上下界和非法输入。
3. 真实stdio MCP客户端执行发现、调用、错误；不调用模型。
4. 新guest内真实Pi加载工具列表；保留read/write，不开放任意shell等工具。
5. 网页任务上传单条FASTA，让模型实际调用工具，将结果保存并重读；与独立预期及原生调用轨迹核对，结束后下载。
6. 全量现有测试、独立代码复核、main提交/GitHub推送/项目内bundle同步。失败和未验证事项照实记录。

## 参考

参考代码基准67d2754（应用965c53f），主要阅读packages/domain/sirna-tools/candidates.ts、sirna-tools.ts、src/mcp-server.ts、agent-compose.yml。未发现应用许可证，不直接复制源代码；独立实现相同输入输出语义和数学规则。上游Agent Compose和Pi以项目已有固定版本为准。

## 已验证的实现决策

固定@modelcontextprotocol/sdk1.30.0；沿用官方guest的pi-mcp-adapter2.11.0显式扩展，在Pi1.2.0下启用read/write/mcp，关闭Pi原生MCP。adapter向Pi显示mcp入口和带服务前缀的业务工具名，server原名仍是enumerate_sirna_candidates。固定2.11.0配置补丁保证显式控制端配置不与工作区/全局配置合并；不引入原项目动态刷新补丁。

新镜像标签pi1.2.0-mcp1、新项目名sirna-pi-learning-mcp，旧任务保持原绑定。真实一次性guest无模型检查通过；第一次网页试跑揭示单文件挂载持有旧配置，确认空闲后重建项目控制容器，保留旧任务guest。后续先核验实际project/image/Pi版本再发送新网页任务。完整解释及最终证据见../../13-第一个MCP工具.md。
