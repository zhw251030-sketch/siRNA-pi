# 第10G步实施计划

设计：docs/superpowers/specs/2026-10-21-web-approved-tools-design.md。已获用户继续实施授权，保持main；不创建额外分支。

1. TDD实现能力凭证、专用HTTP工具端点与taskContext审计；真实HTTP覆盖认证、pending、忙碌、断线、撤销和排空。
2. TDD实现guest远程MCP、固定范围relay与锁定适配器刷新；覆盖协议、大小、错误脱敏、通知和参数。
3. TaskCore/runtime加入task身份、每轮上下文、onStarted激活和终态前排空；bootstrap组装私有UDS；新guest配置，不迁移旧sandbox。
4. 独立规格/质量审查，完整Windows/Linux测试。检查现有任务空闲，部署项目内新镜像/relay及控制服务配置；验证无公开新端口及匿名拒绝。
5. 真实网页模型任务验收，关联执行审计并结束新guest；核对旧材料/会话/容器；记录实际响应及工具次数，不把计划当证据。
6. 逐文件中文教学文档、README/路线/项目摘要；main提交、推送和服务器bundle同提交读回。
