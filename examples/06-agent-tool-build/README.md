# Agent 构建用的受控数值工具

`proposal.draft.json` 保存单文件 Node 源码和提案合同，工具名为 `summarize_numeric_values`。输入 `{"values":[2,4,6]}`，预期输出 `{"count":3,"sum":12,"mean":4}`；输入 `{"values":[-2,2]}`，预期输出 `{"count":2,"sum":0,"mean":0}`。

代码从标准输入读取平台信封中的 `input`，要求1到100个有限数，并拒绝溢出的总和。`baseline` 故意固定返回 `mean:0`，仅供后续学习比较流程；它不是已有正式工具或合理统计方法的强基线。本步不执行baseline/benchmark，不报告净增益或泛化结论。

本步由受控 MCP 客户端按原仓库的工具名称调用：创建会话、写入 `/opt/tool/main.mjs`、执行调试、冻结产物、提交完整提案。草稿不含 `runtimeArtifact`；必须使用真实 `finalize_tool_build` 返回的对象，不能编造镜像摘要。

这份源码是人为准备的验收样例，不是 Pi 本轮自动生成的代码。候选提交后仍需单独验证和批准；新工具尚未进入网页工具目录。

完整文件教学见 [第10J步](../../docs/23-Agent构建工具与提交候选.md)。
