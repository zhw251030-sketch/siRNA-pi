# 工具提案合同教学草稿

本目录的proposal.draft.json是一份可检查的提案草稿，声明候选代码、较有限的基线、成功样例、预期输出、重复性和权限。候选是独立的序列长度/GC统计程序；它与已接入MCP的enumerate_sirna_candidates是不同工具。本轮没有执行或登记它。

在项目根目录运行：

```sh
npm run check:tool-contract -- examples/04-tool-contract/proposal.draft.json --draft
npm run check:tool-contract -- examples/04-tool-contract/proposal.draft.json
```

第一条只检查草稿合同，不要求真实运行产物；结构完整时exit0，executed/registered/activated仍为false。第二条按原正式MCP入口要求runtimeArtifact；本草稿没有创建OCI镜像，预期exit2并指出/runtimeArtifact缺失。这是正确识别未完成前提，不是工具运行失败。不要随便填一个假的sha256让检查变绿；即使结构检查通过，检查器也不会确认镜像存在。

烟雾输入（smokeInput）是一次代表性的业务输入；testCases写应满足的行为；baseline是对照实现；benchmarkCases约定比较案例。这里人工把基线限制为纯DNA，便于学习如何记录功能差异，不是科学基线，也没有实测改进结论。minNetGain=1声明未来候选至少比基线多通过一个比较案例，尚未执行任何案例。

expectedOutput是字面JSON的递归子集断言，不是JSON Schema。例如{"length":4}要求实际length恰为4；{"length":{"minimum":4}}要求实际存在对应嵌套对象，不表示length大于等于4。数组长度和顺序也必须匹配。

脚本运行时的输入协议是sirna-approved-tool-call/v1信封，业务参数放在input中；合同中的smokeInput/testCases.input只填写业务参数，由将来的运行器添加信封。本轮检查器只读这个JSON，不调用模型、不执行脚本、不写注册库、不激活工具。

完整逐文件说明见../../docs/14-工具提案合同预检.md。
