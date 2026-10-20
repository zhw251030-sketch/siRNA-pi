# 网页任务连接工具构建服务（10K）

目标：把10J已验收的六个工具接到网页任务中的 Pi，实际完成一次构建与候选提交。用户已授权沿原仓库逐步重建；继续使用个人 main，不创建分支或工作树。

## 对齐与范围

参考固定67d275494c50f1e5c205b96b72a7b1623acfbe1d。原 guest 本地 MCP 的五个构建工具调用 controller 的 `/v1/build-sessions`，提案调用中央 `/v1/tool-proposals`；`/v1/agent-tools`只用于正式工具。本步保留这些路由和工具参数关系；个人版将两类构建路由放在已有私有UDS服务，经固定relay转发，避免增加第二套Docker授权。原代码无每轮构建owner认证，个人版加入既有lease认证，不将其说成原版已有能力。

保留Node单源码、无依赖、无网络、非root调试、洁净打包、人工批准。提交只到submitted；不运行验证器、不自动批准/激活、不接Curator。现有正式工具参数 `{input:...}` 和发现路由保持原合同。

## 身份与生命周期

- 可信owner来自host激活后的lease：taskId、executionSessionId、sandboxId、agentTurnId、agentRunId。模型参数不能声明或覆盖owner；Bearer不落日志。
- 每轮懒创建一个builder service实例，实例内UUID会话相互隔离。为维持明确全局资源预算，网页同时只允许一个轮拥有builder；至多4活构建容器/32累计会话；其他轮拒绝，不排队、不暗中重试。
- lease.close同步撤销权限，等待已接受请求，再关闭注册的builder资源；成功清理才释放全局owner槽。不确定清理保留占用与诊断，不能静默允许下一轮。
- 正常完成、失败、取消都走相同收尾；context文件清理放finally，即使资源清理失败也撤销连接信息。既有run失败/未知判定不能因清理而被改成成功。
- 构建journal与finalized/proposal-result包含可信taskContext，便于从提案反查网页任务。登记actor使用明确web-agent来源（CLI旧默认保持）。不迁移数据库、不让模型注入来源、不改变proposal业务合同。
- 会话仅属于本轮；下一轮不能续用旧sessionId。完成镜像与submitted材料保留，临时容器清理。进程崩溃恢复仍不在本步内，不能声称异常退出已自动清理。

## 传输合同

五条参考路由：POST `/v1/build-sessions` `{}`→201；PUT `/:id/files` `{path,content}`→200；POST `/:id/exec` `{command,timeoutMs?}`→200；DELETE `/:id` 无body→200；POST `/:id/finalize` `{command:string[]}`→200。提案POST `/v1/tool-proposals` 完整扁平proposal→201。返回复用10J安全结果字段；不暴露host路径/容器ID/私有错误。

构建JSON请求上限1MiB，响应上限300000B；正式工具保留262144B请求。构建请求有界长deadline（client300000ms、relay310000ms）。已核查锁定适配器2.11.0源码：仅对显式启用builder的sirna-tools配置设置requestTimeoutMs=320000；正式工具自身HTTP仍保持30秒界限。body读取仍短deadline；无重定向、自动重放或任意URL代理。传输失联不等于操作没发生，host继续记录已接受操作并在轮结束排空。

guest MCP固定加入六工具，仍使用现有正式工具动态发现；六工具不标注只读。新增独立新guest image `sirna-pi-guest:pi1.2.0-mcp3`、新project identity `sirna-pi-learning-tool-builder`，保留旧guest/image，新增能力只用于新建任务。新连接env显式启用builder，旧配置不隐式获新能力。

## 验收

离线：真实HTTP/UDS/MCP加临时文件与SQLite，只模拟外部Docker/RPC；跨任务/跨轮ID、pending未激活、撤销后请求、并发、owner槽释放/未知保留、正常/取消收尾、恶意body、长deadline、不泄露诊断、旧正式工具严格参数均有行为测试。CLI子进程显式temp cwd。

远端：只在 `/home/hanwen/Project/project/siNRA-pi`，先记录旧数据和无活动run；精确传输审查代码，Linux全套测试后构建镜像和重启项目服务。实际网页新建任务使用MiniMax-M3与六工具，受控小Node工具只提交候选；从event、journal、镜像、registry交叉验证任务关联与清理。保留所有旧任务/材料/批准/正式版本1.0.1；不读取或复制auth内容。真实调用与费用未知项如实记录。
