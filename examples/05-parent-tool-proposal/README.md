# 父版本改进提案：增加确定性的碱基计数

这是待构建的教学草稿，不能直接提交为正式工具。它声明parent为summarize_target_sequence@1.0.0，baseline复制该版本来源提案中的候选源码；提交服务仍会与真实已批准包核对，不以此README为证据。

候选保持length与gcFraction，增加baseCounts:{A,C,G,T}。输入先去FASTA标题和空白、转大写、U转T，因此T计数包括输入中的U；这是归一化后序列计数，不是原始RNA字符计数。它不预测siRNA活性。

基准固定三例：第一例只检查旧字段，后两例还要求新增counts。预期候选3/3、旧源码1/3、净增2；旧源码失败是没有新增字段，不是旧长度或GC计算错误。这里验证功能扩展，不代表独立数据泛化、总体工具优越或自动进化。

在唯一服务器项目根，沿已有流程执行：

```sh
npm run check:tool-contract -- examples/05-parent-tool-proposal/proposal.draft.json --draft
npm run build:tool -- examples/05-parent-tool-proposal/proposal.draft.json
npm run tools:proposals -- submit runtime/tool-builds/<本次构建ID>/proposal.json
npm run validate:tool -- <本次提案ID>
```

构建和验证会真实执行已审阅源码并创建受限临时容器；不调用模型。构建不会验证parent登记关系，提交/验证才会核对父版本证据。通过后仍是verified候选，approve目前会明确拒绝parent提案，网页继续使用原active1.0.0。
