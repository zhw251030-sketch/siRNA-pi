# 第9步：把候选枚举程序接到正式任务中的 Pi

日期：2026-10-20。前置步骤是网页、Agent Compose、任务容器、上传与文件归档。本轮把参考项目已有的一个确定性工具接到同一条正式执行路径；不是重新实现 Agent，也不是训练模型。

## 1. 这次要补上的能力

此前 Pi 已经可以读取文件、理解要求、写入文件。但是“模型能输出一个答案”和“模型确实调用指定算法得出答案”是两件事。以候选序列为例，如果只让模型回答，它可能自己推算或猜测；没有一个固定程序确保坐标、反向互补、评分和排序始终按同一规则进行。

现在增加 `enumerate_sirna_candidates`：输入一条靶序列，程序枚举固定长度的窗口，生成相应反义 RNA 引导序列，再用透明规则打分排序。Pi 决定何时调用它、传什么参数，以及怎样将结果交付给用户；算法本身不调用模型。

这只是“把软件/代码封装为 tool”的第一个固定工具实例。尚未实现让 Agent 安装任意软件、自动生成工具定义、管理候选版本、发布升级或自进化。

## 2. 原仓库怎么做，我们对齐了什么

参考基准为本机参考仓库 `67d2754`，应用代码基准 `965c53f`。本轮没有复制其应用源文件；在核对可观察的输入输出与数学规则后独立实现。参考应用没有明确许可证，因此不整段移植。使用的上游 Pi MCP adapter 保留其 MIT 许可证。

| 职责 | 参考仓库 | 学习仓库 |
| --- | --- | --- |
| 候选生成与预筛选规则 | `packages/domain/sirna-tools/candidates.ts` | `packages/domain/sirna-tools/candidates.mjs` |
| 工具名称、说明、参数和执行函数 | `packages/domain/sirna-tools/sirna-tools.ts` | `packages/domain/sirna-tools/sirna-tools.mjs` |
| 通过 MCP 列举、执行工具 | `src/mcp-server.ts` | `apps/mcp/server.mjs` |
| 指定 designer 可连接哪些 MCP 服务 | `agent-compose.yml` | `agent-compose.yml` |
| guest 内 Pi 与 MCP adapter | `containers/agent-compose-guest/` | 同职责目录，按 Pi 1.2.0 验证 |

原仓库还有 `packages/capability-platform/pi-extension.ts`，它可以帮助理解直接向 Pi 注册工具的方式。但当前正式网页路径由 Agent Compose 配置 MCP，所以本轮沿着正式 MCP 路径接入，不能仅在旧 SDK 练习中注册成功就称网页容器已经接通。

我们只暴露一个固定业务工具，未搬入原仓库整个工具目录和动态注册体系。领域算法的正常输出、排序和公开参数范围与参考合同对齐；额外明确拒绝未知参数，并检查底层 GC 边界等非法输入。

## 3. 第一层：真正做计算的函数

入口：`packages/domain/sirna-tools/candidates.mjs` 中的 `enumerateCandidates(targetSequence, options)`。

可以先把它理解成一个普通计算器：给定相同输入，一定产生相同输出；它不知道网页、聊天和模型是什么，也不读文件或访问网络。

执行顺序如下：

1. 去掉 FASTA 的标题行和空白，统一大写，把 U 转成 T 便于内部处理；拒绝空序列和不支持的字符。
2. 取默认21个碱基长的窗口，从第1位逐个向后移动。
3. 将每个窗口反向互补，生成 RNA guide。这里必须同时理解“反向”和“互补”，并非简单把 T 换成 U。
4. 计算 GC 比例、连续相同碱基、碱基种类和 guide 首尾规则，产生预筛选分数及警告。
5. 按分数从高到低排序，同分先看警告数，再按原始坐标；只返回指定数量。

例如教学输入有24个碱基，窗口长度21，则共有 `24 - 21 + 1 = 4` 个窗口，坐标分别是1–21、2–22、3–23、4–24。输出坐标从1开始、包含两端。候选的 id 关联原始起点，不是排序名次。

评分遵循参考 `transparent_prefilter_v1`：基础分0.7；GC在默认0.30–0.55内时按距区间中心的位置加分，区间外扣分；连续4个相同碱基扣0.25，只有一两种碱基扣0.15；guide 以A/U开始加0.08，以G/C结尾加0.04；最后限制到0–1并保留4位小数。排序使用输出精度的分数。

`prefilterScore` 是这组规则的分数，不是“成功概率”或“沉默活性”。0.8686不能解释成86.86%的有效率，也没有在本轮测量脱靶、结构可及性或实验效果。教学序列本身是人为重复序列，用于检查程序，不是经验证的生物学设计。

本轮沿用参考的多FASTA记录连接行为，因此应上传单条靶序列；多记录拼接会产生跨记录边界的窗口。参数原始字符串长度为19–100000，清理后还要足够长。将来若改变多记录行为，需明确作为合同变化，而不是静默调整结果。

## 4. 第二层：把函数包装成工具

入口：`packages/domain/sirna-tools/sirna-tools.mjs` 中的 `createSirnaTools()`。

普通函数只有程序员知道如何调用。模型需要一份“使用说明”，所以工具对象包含：

| 字段 | 作用 |
| --- | --- |
| `name` | 稳定名称 `enumerate_sirna_candidates`，用于找到执行函数 |
| `description` | 解释用途和限制，明确分数不是活性预测 |
| `parameters` | JSON Schema，告诉调用方允许哪些输入、类型和范围 |
| `execute` | 真正检查参数、调用领域函数、返回结果 |

公开输入为 `targetSequence`，可选 `guideLength`（19–27，默认21）和 `maxCandidates`（1–100，默认40）。Schema帮助模型理解格式；`validateCandidateArguments()` 在执行时再次检查，不能假设模型一定遵守说明。底层函数另可接受GC设置和更宽的返回数量上限，这些没有开放为本轮MCP参数。

`execute` 返回 `content` 和 `details`：前者是可传递给模型的JSON文本，后者保留程序对象。MCP桥接本轮只发送 `content`。该工具实现不读写文件，也未暴露文件操作；是 Pi 的已有 read/write 在前后负责文件。这不是收紧了整个Node子进程的操作系统权限，而是让业务算法不依赖具体目录或网页任务。

## 5. 第三层：MCP 负责跨程序调用

入口：`apps/mcp/server.mjs`，依赖固定的 `@modelcontextprotocol/sdk@1.30.0`。

MCP可以先理解为“程序之间统一询问和调用工具的协议”。它不是模型，也不是另一个 Agent。本轮以标准输入/标准输出传消息：Pi侧的适配器启动一个Node子进程，子进程运行MCP server。

server主要回答两种请求：`tools/list` 返回可用工具及其参数；`tools/call` 根据名称检查输入、执行工具并返回结果。未知工具、非法参数、算法拒绝的输入会返回 `isError: true`，不会被包装成正常候选结果。标准输出只用于协议消息，调试信息不能混入其中。

MCP server和Pi位于同一个任务guest中，但属于不同进程；没有为这个工具新增公网端口。工具运算本身没有模型费用；Pi为安排和解释工作而发出的模型请求仍使用既有 MiniMax 额度。

## 6. 第四层：在真实任务容器中接通

`agent-compose.yml` 声明名为 `sirna-tools` 的local MCP服务，命令为 `/usr/bin/node /opt/sirna-pi/apps/mcp/server.mjs`，并把它列入designer可用服务。镜像标签更新为 `sirna-pi-guest:pi1.2.0-mcp1`，项目名改为 `sirna-pi-learning-mcp`，从而保留旧项目修订及已有任务绑定。旧任务不会自动获得新工具；本步能力从新任务使用。

Agent Compose v2609.3.0会生成本次调用的MCP配置，并向Pi传入显式扩展和配置路径。正式镜像内是 `pi-mcp-adapter 2.11.0`。它向Pi注册统一的 `mcp` 入口，再通过该入口访问业务工具：

```text
Pi已有工具：read、write
Pi新增入口：mcp
MCP服务名：sirna-tools
服务内工具名：enumerate_sirna_candidates
适配器对Pi显示的业务名称：sirna_tools_enumerate_sirna_candidates
```

所以原生轨迹中看到 `mcp` 并不表示没有调用业务算法，要继续看其参数中的 `tool` 和对应返回结果。模型可先connect、查询工具Schema，然后传JSON参数执行。

相关容器文件的变化：

- `Dockerfile` 把领域函数、MCP server和验收脚本放进镜像，按lockfile安装依赖；修复官方适配器只链接入口、缺少相邻模块的布局，暴露完整适配器目录并保留许可证。
- `pi.sh` 将允许工具改成 `read,write,mcp`，保留Agent Compose传入的模型和会话参数。`--no-mcp` 关闭Pi 1.2原生MCP，避免同时运行两套接入；显式加载的官方适配器仍然工作。自动扩展、技能和上下文发现继续关闭。
- `patch-mcp-config.mjs` 只针对2.11.0的明确位置做构建时补丁：指定控制端配置时，只读取该配置，拒绝imports。原因是上游默认还会合并项目或全局 `.mcp.json` 等文件；本轮要求任务文件不能通过这些配置偷偷替换已指定的服务。版本和锚点不符时构建失败，不能猜着修改。
- `.dockerignore` 只增加必要源码的构建白名单，仍排除凭据和runtime；`build-project-guest.sh` 使用新标签，保留旧镜像。

这只是MCP配置来源约束和工具允许清单，不是完整操作系统沙箱。guest里read/write的路径权限、容器配额、多用户访问等仍有此前说明的边界。

## 7. 从网页输入到下载结果，完整发生了什么

```text
上传 target.fasta → TaskFiles保存在任务归档
发送任务 → AgentComposeRuntime准备独立guest并回填输入
Pi read读取序列 → mcp连接/查询sirna-tools
MCP tools/call → 工具合同检查 → enumerateCandidates确定性计算
工具返回JSON → Pi write保存output/candidates.json → Pi read核对
本轮结束 → TaskFiles收集输出 → 网页预览/下载
结束任务 → 释放guest → 归档与历史继续保留
```

模型负责理解要求、读取内容、选择调用、填写参数、保存和解释结果。程序负责固定计算、检查调用格式、执行容器与文件生命周期。网页显示和归档沿用前几步，不必为增加一个计算工具重写聊天后端。

`examples/03-candidate-tool/target.fasta` 是输入；`expected.json` 是独立核对的预期，只供验收，**没有上传给模型**。四个候选排序为起点1、4、2、3，分数分别0.8686、0.8686、0.7714、0.7714。模型必须真正调用工具，不能直接抄期待值或自己代算。

## 8. 验证与部署中实际遇到的问题

先补齐第8步：新任务 `4f75f67c-a3ab-43b3-94a4-6f0e680334b0` 完成上传values.csv后的read→write→read，得到3/27/9；uploaded、completed、ended三阶段验收通过。之前两次529失败记录保留，没有修改为成功。

本轮先写测试并观察缺少实现时失败，再实现领域和MCP层。17项领域/合同测试覆盖独立预期、排序、归一化、范围及错误；3项MCP测试通过真实stdio子进程完成发现、调用和错误恢复。另一次独立审查用1000个固定种子的合法样例比较参考结果，字段全部一致；这验证合同，不验证生物学有效性。

`scripts/verify-guest-mcp.mjs` 在一次性guest内通过真实Pi SDK扩展加载器发现并执行MCP，网络关闭、没有prompt和模型调用。检查实际允许工具为read/write/mcp、真实结果返回，以及项目/全局伪MCP配置不会覆盖控制端配置。

第一次网页试跑 `061b69c5-bc67-4bf8-b010-01c2d7cc5b8b` 发现旧配置挂载问题：宿主YAML已更新，但归档解包替换了文件，控制容器的单文件bind mount仍指向旧文件对象。新任务因而启动旧镜像，只能read/write；模型如实报告不能调用MCP，没有生成候选结果。daemon报告本轮对话succeeded也不代表业务目标完成。该任务保留并已结束释放。

核对所有已有任务没有活动运行后，只重新创建本项目的Agent Compose控制容器，再执行项目up；未重建两个旧任务guest。核对8份原有会话元数据、旧项目修订和两个旧guest仍保留。新任务在提交模型前再检查实际项目ID、image ID和Pi版本，才开始复验。

本次有效网页任务为 `5567e0ae-6715-4db8-8be9-0a4ea6079ca6`。其实际新镜像ID为 `sha256:e1af6c70d9e8529a46746be8a85c443cd55d3b95a0889fe591e573d51743bf29`。最终验收由 `scripts/verify-compose-candidate-tool.mjs` 读取已有记录完成，既不调用模型，也不启动/停止容器。

| 验证内容 | 实际结果 |
| --- | --- |
| 完整自动化回归 | Linux 406通过、0跳过；Windows 402通过、4项Linux专属跳过；均0失败 |
| 真实模型轨迹 | 7次响应、6次成功工具：read输入、mcp连接、mcp查看Schema、mcp执行业务、write、read输出 |
| 真实业务调用 | `sirna_tools_enumerate_sirna_candidates` 调用1次；原始参数、内外层MCP返回及原生toolCallId均核对 |
| 计算结果 | 4条候选，全部字段与独立expected.json一致；原始JSON文本未经改写 |
| 文件交付 | candidates.json共812字节，工作区、归档、HTTP与真实浏览器下载字节一致 |
| 结束任务 | ended验收通过，runtimeReleased=true；该guest已不存在，输入、输出、原生会话和网页历史保留 |
| 旧数据 | 8份旧会话元数据及旧项目修订未改变；两个原有网页guest继续运行 |

输出SHA-256为 `b79814f2c63da2d70a52b0a724c097dab2c8a81f1d0d0d295468c8081f97cfad`。原生Pi日志19294字节，其SHA-256为 `60617e171a007916f8e1b43901da1ac8372a08a32244f4efb2f7b58a279f3281`。读取验收前后任务历史、元数据和原生上下文均未改变。

验收分两层：`scripts/lib/verify-compose-candidate-task.mjs` 独立核对原生工具证据，CLI入口再绑定task、executionSession、sandbox、run、归档及HTTP。新增32项验收测试会拒绝“结果文件正确但没有真实调用”、错工具、错误返回、参数不符、改写结果和未重读等情况。全部代码经独立复核，无未解决的重要发现。

服务器私有证据为 `runtime/compose-web/first-mcp-acceptance-completed.json`、`first-mcp-acceptance-ended.json`、`first-mcp-prepared.json` 和 `mcp-rollout-baseline.json`；测试报告为 `runtime/first-mcp-linux-final-tests.log`。本机保留 `runtime/first-mcp-browser-result.png` 和Windows测试报告。它们不进入Git，不提交真实会话原文或密钥。

以后修改绑定挂载的配置，不能只检查宿主文件或盲信命令退出码；要核对控制容器看到的内容以及新任务实际使用的配置。重载前仍需确认没有正在执行的任务。

## 9. 学完这一步应能解释什么

现在可以沿一个具体工具回答：计算在哪里实现、模型通过什么说明知道如何调用、MCP如何跨进程传参数、镜像如何提供代码、Agent Compose如何将服务交给Pi、最终结果如何返回网页。

下一阶段应沿原仓库学习“固定工具如何成为可管理、可验证、可迭代的工具”：先理解工具记录、输入输出合同和固定验证案例，再引入外部软件执行与版本流程。当前尚无工具自动封装、动态注册刷新、OCI软件构建、工具发布回退、人类协同评估或自进化实验。
