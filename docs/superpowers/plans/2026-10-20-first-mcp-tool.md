# 第一个正式 MCP 工具实施计划

**Goal:** 在网页正式任务容器中调用一个可核验的siRNA候选枚举工具。

**Architecture:** 领域函数→同名工具合同→stdio MCP→Agent Compose提供的Pi适配器。模型选择调用，程序确定性计算，已有任务归档交付文件。

**Tech Stack:** Node24、Pi1.2.0、AgentCompose v2609.3.0、MCP SDK固定版本。

**Spec:** ../specs/2026-10-20-first-mcp-tool-design.md

## 全局约束

只改siRNA-pi，main单分支，远端唯一根/home/hanwen/Project/project/siNRA-pi。保留既有任务与guest。凭据和真实运行记录不入Git。按实际验证报告；本轮不实现专业软件安装、动态工具治理或自进化。

## 任务与进度

- [x] 前置验收：新任务4f75f67c-a3ab-43b3-94a4-6f0e680334b0真实上传处理成功、3次工具、3/27/9，结束后验证通过。私有证据runtime/compose-web/upload-success-next.json。
- [x] 领域与工具合同：先写独立样例及边界测试并运行失败，再实现packages/domain/sirna-tools/candidates.mjs与sirna-tools.mjs。17项领域/合同检查通过。
- [x] MCP协议：锁定@modelcontextprotocol/sdk1.30.0；apps/mcp/server.mjs使用官方Server/StdioServerTransport。3项真实子进程协议测试通过，不以直接函数调用冒充协议验收。
- [x] guest集成：官方Pi adapter2.11.0在Pi1.2.0下无模型验证通过，使用显式唯一配置。新项目及新镜像，保留旧绑定。单文件挂载旧内容问题已定位并在空闲时重载控制容器。
- [x] 验收与讲解：新任务5567e0ae的completed/ended验收通过，7响应/6工具、业务调用1次、4条候选。浏览器下载SHA一致。32项验收测试与完整Linux406项回归通过；独立审查意见已处理，逐文件说明见docs/13。
- [x] 提交前检查：凭据和runtime均排除，git diff --check通过；本机、GitHub和服务器基线均为9e48ae3，无混入其他工作。

交付操作：将本轮已验证文件提交并推送main，以bundle同步服务器，最后核对三处提交和两工作树。最终提交号由交付消息与runtime中的同步证据记录，避免在包含本计划的提交中记录自身哈希。

## 验证命令

`node --test tests/sirna-candidates.test.mjs tests/sirna-mcp.test.mjs` 验证新增确定性行为和协议。`npm test` 回归现有任务流程。真实模型请求只通过专用网页任务发起，不循环自动重试。服务器测试使用已存在Node24，测试产物与临时数据限制在项目runtime。

## 决策记录

继续沿用用户已授权的main/同步流程，不新建分支。第一项工具先独立实现参考可观察合同，不复制无明确许可的应用代码。新旧Pi的MCP适配以无模型实际验证决定，记录最终实现差异。
