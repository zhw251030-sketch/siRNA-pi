# Tool Runtime Artifact Implementation Plan

> 执行：按测试先行实现独立模块，随后集成和独立审查；用户已明确个人main单分支及持续同步。

**Goal:** 将教学提案构建为真实本地镜像，验证从该镜像独立运行，并保存可追溯runtimeArtifact。

**Architecture:** 显式Docker Engine客户端→构建/运行内核→可信CLI；保持原工具控制器与Agent Compose职责分开。

**Tech Stack:** Node内置HTTP、crypto、fs、node:test；无新依赖。

**Spec:** ../specs/2026-10-20-tool-runtime-artifact-design.md

## 全局约束

仅siRNA-pi/main；远端/home/hanwen/Project/project/siNRA-pi；不读取凭据，不修改参考或RSI，不重启现有服务。固定Pi1.2.0/Composev2609.3.0。独立实现可观察协议，不复制参考应用代码。无HTTP服务/MCP新增权限，无模型调用，无系统安装。

## Task 1: Docker通信

文件packages/capability-platform/docker-engine-client.mjs、tests/docker-engine-client.test.mjs。显式socket构造客户端，实现create/start/stop/remove/inspect/exec/commit/wait/logs；非TTY输出严格解帧，接口不自动重试。

- [x] 写本地HTTP假daemon协议测试：实际调用create/exec/commit/wait，验证JSON请求与解帧；HTTP500/无效JSON/超限/截止时间必须reject。例：`await assert.rejects(client.waitContainer(id, 20), {code:'DOCKER_TIMEOUT'})`。
- [x] 运行观察失败，再实现显式socket客户端和严格解帧，不提供全局Docker默认值。
- [x] 专测通过，审查客户端与内核接口一致。

## Task 2: 构建与成品执行

文件packages/capability-platform/tool-build-service.mjs、tests/tool-build-service.test.mjs。导出buildToolArtifact/executeToolArtifact，由调用方注入Docker边界和事件回调，候选源码仅在容器中执行。

- [x] 先测完整草稿→真实事件顺序/6字段产物、源码绑定、候选与基线分离、失败及清理：`assert.equal(result.artifact.protocolVersion,'sirna-tool-runtime-artifact/v1')`；伪造command/标签必须在create前reject。
- [x] 实现纯编排函数，Docker外部操作由Task1边界提供；固定受限配置、构建冒烟、停止commit及成品逐案例执行。
- [x] 专测通过；任何不通过/清理未确认不得生成成功结果。

## Task 3: 命令、真实验收与文档

文件scripts/build-tool-artifact.mjs、scripts/lib/tool-build-files.mjs、tests/tool-build-files.test.mjs、package.json、docs/15-构建真实工具运行产物.md、README/AGENTS/学习路线。

- [x] 测试有界安全读取/唯一证据目录/失败记录与成功提案分离，先失败再实现；CLI整体失败不发布由真实Linux语法负例另行验收。
- [x] CLI限定Linux/hanwen/唯一根及项目socket，保存事件与源码快照，将服务返回artifact合入副本。输出只列运行ID/路径/摘要。
- [x] 先完整本机回归，再将经过审查的文件暂存到远端唯一根。构建命令`node scripts/build-tool-artifact.mjs examples/04-tool-contract/proposal.draft.json`；只执行这份已审阅教学源码。
- [x] 验收真实ImageID、运行输出、无网络/readonly/非root/配额、源码哈希、精确容器清理；成品提案完整预检应ok，registered/activated仍false。核对旧状态不变。
- [x] 完整Linux回归、独立最终审查、逐文件中文学习文档。Linux607通过；Windows603通过/4项Linux专属跳过；失败诊断P2已修复且复审通过。

交付时提交推送main并通过bundle同步；三处SHA与干净工作树核验结果保存到私有runtime/tool-artifact-sync.json，避免在提交内引用自身SHA。实际构建与失败验收记录见docs/15-构建真实工具运行产物.md。
