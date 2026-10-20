# Tool contract preflight implementation plan

**Goal:** 完成原工具治理流程的合同预检阶段，提供实际可用的离线CLI和逐文件学习说明。

**Architecture:** 合同字段检查与已有结果判据分离；CLI仅读取JSON并返回明确阶段，原固定MCP和网页保持独立。主流程负责CLI/样例/集成，并行实现两个独立模块，随后统一审查。

**Tech Stack:** 既有Node内置API/测试器，无新依赖。

**Spec:** ../specs/2026-10-20-tool-contract-preflight-design.md

## 全局约束

main单分支；不修改参考仓或上级RSI。远端唯一根/home/hanwen/Project/project/siNRA-pi。原凭据、任务、guest保持。独立实现参考可观察合同，不复制许可证未明确的应用源文件；不执行提交的源码。

## 实施与验收

- [x] 合同检查：先用缺字段、完整草稿、非法参数和权限组合测试观察失败，再实现checkToolProposal与完整性/字段检查。`checkToolProposal({},{}).code`应为TOOL_CONTRACT_INCOMPLETE；完整草稿默认只缺/runtimeArtifact，--draft通过但executed/registered/activated都false。
- [x] 判据：先测试`expectedOutputMatches({a:1,b:2},{a:1})===true`与数组长度、点号字面键等反例；实现独立匹配与运行成功/重复性判断。failed run在exact/contract都不能通过。
- [x] CLI：先测试真实进程退出码、恶意源码哨兵不生成、源文件哈希未变；再实现有界文件读取和结构化摘要，添加教学proposal.draft.json和npm入口。
- [x] 集成：两模式实际运行、完整Windows/Linux回归、原MCP协议检查、只读审查；编写docs/14-工具提案合同预检.md并更新进度。Windows529通过/4项Linux专属跳过，Linux533全通过。
- [x] 交付准备：仅本轮文件，凭据及runtime排除；准备main提交和bundle同步脚本。提交后的三处SHA与工作树核验记录写入私有runtime/contract-preflight-sync.json。

## 命令

`node --test tests/tool-contract.test.mjs tests/tool-validation.test.mjs tests/tool-contract-cli.test.mjs`；`npm test`；`node scripts/check-tool-contract.mjs examples/04-tool-contract/proposal.draft.json --draft`（0）；去掉--draft（2，仅缺真实runtimeArtifact）。这些命令均不调用模型、不执行提案。具体运行和同步证据保存runtime而不进Git。
