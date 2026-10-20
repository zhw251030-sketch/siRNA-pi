# 第一个候选枚举工具

新建任务，上传本目录target.fasta。只需上传该输入，不把expected.json提供给模型。发送：

> 读取input/target.fasta。用mcp连接sirna-tools，调用它实际列出的sirna_tools_enumerate_sirna_candidates工具，targetSequence取文件中的序列，guideLength=21，maxCandidates=4。把工具返回的完整JSON结果原样保存到output/candidates.json，再read重新读取核对。不要自己代替工具计算，也不要修改输入。最后说明这个预筛选分数不是活性预测。

expected.json是人工核对的验收预期，不是调用工具生成的预期。24个碱基、21个碱基窗口，共24-21+1=4个窗口。坐标1和4的GC为10/21，坐标2和3为11/21。按原项目transparent_prefilter_v1规则分别得到0.8686和0.7714；同分时按警告数和原始坐标排序。因此返回顺序是1、4、2、3。

这是一条重复的教学序列，不是经过生物学验证的靶标或药物建议。枚举工具不调用模型、不读文件、不连接网络；模型负责读取文件、选择调用、保存结果。网页发送消息会使用模型额度。
