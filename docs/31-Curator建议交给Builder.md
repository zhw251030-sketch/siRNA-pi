# 第11C步：把 Curator 的建议交给 Builder

本步承接 [独立 Curator 审查](30-独立Curator审查与冻结证据.md)，实现显式的建议→构建交接。它补上发现建议和已有构建能力之间的连接；是否能得到有价值的新工具，仍须真实模型执行和后续独立验证。

## 先理解这一步解决什么问题

上一轮，系统已经能把执行记录交给独立的 Curator，让它回答：“这里有没有值得做成通用工具的能力？”回答为 `candidate` 时，得到的仍是一份建议。例如：“这里反复统计一组数字的范围，可以考虑封装成数值范围工具。”它没有源码、镜像，也没有正式工具资格。

这一步让人点击“交给 Builder”，把这份建议转成一条明确的工作指令，发回原来的任务。原任务中的 Pi 随后可以调用早已实现的构建工具：创建构建环境、写代码、运行测试、打包、提交提案。Builder 在这里是 Agent 执行构建工作的角色，并不是本轮新装的另一个大模型或新框架。

```mermaid
flowchart LR
  A[原任务的执行记录] --> B[11B 独立 Curator 审查]
  B --> C[candidate 建议]
  C --> D[人点击交给 Builder]
  D --> E[11C 保存交接单与固定指令]
  E --> F[原任务、原 Pi 会话继续一轮]
  F --> G[已有 OCI 构建工具]
  G --> H[submitted 工具提案]
  H --> I[已有独立验证]
  I --> J[人工批准与正式版本]
```

箭头表示工程链路，不表示每次都能走到终点。Agent 可以发现建议不适合做工具并停止，也可能构建失败；即使成功提交，仍不等于通过验证或成为正式工具。

## 原仓库怎样处理

参考固定为 `sirna-pi-agent-service-refactor@67d2754`：

| 原文件 | 作用 | 本轮学习版的对应处理 |
|---|---|---|
| `packages/extensions/tool-curation/tool-curation-coordinator.ts` | 找到尚未派发的 candidate，等待原任务空闲后排队 | 网页显式触发，不增加自动轮询派发 |
| `packages/extensions/tool-curation/tool-curation-build-prompt.ts` | 把能力边界、合同草案、权限、证据和构建要求组织成消息 | 保存同类信息，并冻结完整消息及摘要 |
| `apps/api/router.ts:3278` | 向原任务发送 `auto-tool-curation-build:<curationId>` 请求 | 沿用原任务、固定请求号与 TaskMessageService |
| `packages/extensions/tool-curation/tool-curation-types.ts` | 保存 buildRequestId / queuedAt | 独立交接单保存派发状态和完整绑定 |

原版通过固定请求号去重；它的 curation 记录和自动化记录并没有完整保存一条精确的 curation→proposal 边。本轮增加这条边，是为了学习时能回答“这个提案究竟来自哪条建议”，不能把它说成原版已经具备的同一实现。

## 为什么先存交接单，再调用 Agent

网页按钮可能被点两次，网络可能在提交后断开，服务也可能在等待模型时重启。如果只在模型返回后记账，后端就可能不知道前一轮已经开始，于是又执行一次。

因此先固定以下信息，再派发：原任务和执行会话、建议 ID、冻结证据摘要、Curator 回答摘要、完整构建指令及其摘要、唯一请求号。SHA-256 可以理解为一份材料的“内容指纹”；它用于检查同一份材料有没有变，并不判断模型说得对不对。

同一建议再次请求时，只能拿到已存在的交接记录。遇到执行结果无法确认的情况，记录为未知，不自动重发。用户仍可查看原任务历史和已经登记的提案，保留实际发生的结果。

## 模型负责什么，程序负责什么

模型负责理解建议、判断是否值得构建、写实现、提出测试和基线。程序负责检查任务可用性、权限范围、材料身份、请求去重、真实来源、注册事务和后续独立验证。模型在回答中说“已经提交”不能作为登记依据，必须读到后端实际保存的提案及对应事件。

输入输出合同在建议阶段只是草案，Builder 可以把它细化为正式提案的合同和测试。工具名称和权限边界不能随意更换；当前 Builder 仅支持 Node、无额外依赖、精确重复性、无外部访问。涉及网络或额外软件的建议会被明确拦住，不会悄悄降低要求，也不会扩大现有容器权限。

## 按文件理解数据流

| 文件 | 负责什么 | 为什么单独存在 |
|---|---|---|
| `packages/extensions/tool-curation/tool-curation-build-contract.mjs` | 检查交接绑定、组织固定构建提示、限制提案名称和权限 | 把模型建议与程序允许做的事分开；摘要有统一算法 |
| `packages/extensions/tool-curation/tool-curation-build-store.mjs` | SQLite 交接单、冻结字段、来源身份、状态恢复 | 网页刷新或后端重启后仍记得已接受的工作 |
| `packages/extensions/tool-curation/tool-curation-build-service.mjs` | 检查 candidate/任务/目录，调用 TaskMessageService，确认完成和提案关系 | 把流程规则放在业务层，不散落到按钮和 HTTP 处理里 |
| `packages/capability-platform/task-tool-builders.mjs` 与 `tool-build-sessions.mjs` | 将真实执行轮的身份交给新的登记策略 | 防止 Agent 自报来源；旧 repair 策略保持独立 |
| `packages/capability-platform/tool-lifecycle.mjs`、`tool-registry.mjs`、`tool-proposal-source.mjs` | 登记时同时保存 curation 来源，限制每票据一个提案，并检查读回材料 | 提案内容和来源关系必须一起成立，不能按名称猜关联 |
| `apps/api/router.mjs`、`bootstrap.mjs`、`service-lifecycle.mjs` | HTTP 入口、连接对象、取得服务所有权后恢复、关闭时排空 | 让新流程进入真实运行服务，并保持正常停机顺序 |
| `public/curation.mjs`、`app.js`、`tools.mjs` | 展示建议、交接条件和状态，手动提交，打开原任务/提案 | 用户能看到每一步进展，网页失败不变成隐式重试 |

新增的构建接口是 `GET/POST /v1/tasks/:taskId/curations/:curationId/build`。GET 读条件、提示和已有票据；POST 仅提交三项摘要，后端从已保存的材料重建指令。浏览器不能在这个接口里夹带另一条任意提示。

建议详情中的“查看构建任务”使用已有任务选择逻辑，“查看提案”使用已有工具面板；不是创建第二个聊天任务。任务中的新增消息就是这次构建的起点。

## 跟着一次点击读代码

1. `public/curation.mjs` 先读取建议详情，再显式 GET 构建条件。后端 `view()` 核对这是不是 candidate、证据是否一致、原任务是否可继续，以及实际运行时是否提供 Builder 工具。如果检查期间另一个请求已接受交接，重新读票据，优先显示已经发生的事实。
2. `curationBuildPrompt()` 将能力名称、输入输出草案、证据与构建要求组织成固定消息。模型建议中的文字被当作待分析的数据；它不能授权网络、额外依赖或更改正式工具。
3. 人点击交接，网页 POST 三个内容指纹。`start()` 对同一建议合并在途请求；`dispatch()` 在异步检查空闲后再次核对材料，先写交接单，再调用已有 `taskMessages.start()`。
4. 原任务增加一条用户消息，沿用 Agent Compose 运行路径开始新一轮。Pi 可以调用 `create_tool_build_session`、`write_tool_build_file`、`run_tool_build_command`、`finalize_tool_build`、`propose_exploration_tool`。已有的取消操作也保留。这些工具来自第10J/K步，本轮没有重写构建器。
5. 到 `propose_exploration_tool` 时，`registration()` 检查真实任务、执行会话、容器、轮次和固定消息，得到精确来源。能力平台在提案登记事务中同时写入关联；不能凭工具名相同或模型自报“来自某条建议”认定来源。
6. `finish()` 结合真正保存的消息、终态事件和提案读回决定状态。模型回复“成功了”不够；网页显示已登记提案后，可以进入已有面板，继续人工触发独立验证。

这里的几个词要区分：`candidate` 是 Curator 的建议；`submitted` 是已有材料的工具提案；`verified` 是独立验证通过；`active` 才是获准进入正式目录的版本。本轮接通前两者，中间仍可能失败，后两者沿用之前的流程。

## 为什么保存这些状态

| 状态 | 程序实际知道什么 | 网页可以怎样理解 |
|---|---|---|
| `dispatching` | 交接单已保存，正在派发 | 已接受，不能重复启动 |
| `running` | 原任务执行轮已经接收 | 可查看原任务执行过程 |
| `submitted` | 执行正常结束且找到精确关联提案 | 可以打开提案，尚待独立验证 |
| `no_proposal` | 执行正常结束，但没有登记提案 | 可能主动放弃构建，不能当作工具成功 |
| `failed` | 执行失败且未找到关联提案 | 保留失败记录 |
| `outcome_unknown` | 无法完整确认执行或登记结果 | 读已有记录，不自动重跑 |

后端保存事实，浏览器也保存本次 POST 尚未确认的标记。如果网络中断，刷新页面不会立刻重新开放提交；只有重新读取到对应交接记录，才把它呈现为已接受的工作。重启后的未完成记录同样不会自动派发第二次。这是控制副作用和重复调用，不是保证任务一定成功。

## 验收

最终Linux完整1360项：1358通过、2项Windows专属跳过、零失败、零取消。实际使用Node24.16.0，测试临时目录固定在项目runtime/tmp，运行 `node --test --test-concurrency=4 --test-reporter=spec tests/*.test.mjs`，耗时332.64秒。Windows修复后的96项相关网页测试全通过；核心24+API4项通过，另有早先176项相关回归170通过/6平台跳过。不将不同集合相加冒充不同测试数量，也不声称本轮Windows完整套件通过。

部署后API ready且空闲，PID从1547001正常退出后变为1736030；未重建controller、relay或guest。业务数据核验仍为16任务、14有轮次、2无轮次、0合格预览、0Curator记录、0交接。不存在建议的GET/POST均404，错误ID400，伪造保留请求号400，外站Origin403；任务消息前后摘要相同。浏览器刷新最新页面后，旧任务预览正确显示5个构建控制调用被排除、没有线索、独立审查按钮禁用、审查记录为空，控制台无error。

五个旧业务数据库全schema及行、旧材料/原生会话/归档文件、正式目录、容器及镜像均保持，正式 `summarize_target_sequence@1.0.1` 不变。本轮生产新增模型请求、Docker执行、任务、提案、验证、批准均0；凭据只核对文件元数据，未读取或输出密钥。新交接数据库为空，这与现有业务数据没有candidate相符。

入口仍是经现有SSH隧道访问的 [本机网页](http://127.0.0.1:3000/#curation-panel)，服务器唯一目录仍为 `/home/hanwen/Project/project/siNRA-pi`。服务未设开机自启。只有将来确实保存合格candidate且原任务仍可继续时，生产页面才会显示可执行的Builder交接；隔离演示的建议不会出现在你的业务库。

本轮新增39项行为测试：核心24项、API4项、UI7项、生命周期4项。它们检查并发重复提交、跨重启不重发、伪造身份、已结束执行轮不能注册、每票据一个提案、登记结果未知不能绕过、异步读取期间票据变化，以及网页过期响应和未确认POST。

独立审查发现过一个真实并发缺陷：GET先读取“还没有票据”，随后等待运行时查询；这期间POST可能已完成交接，GET却仍返回“可交接”或“任务忙”。现在成功和错误路径都重新读取持久票据，三个确定性竞争用例先复现失败、再通过，已有历史优先于临时条件。

首次Linux完整测试1357项：1349通过、6失败、2跳过。六个失败全部发生在旧的网页VM测试环境：它删除浏览器import后没有注入新增的真实 `curationNavigation`。修复只添加真实函数导入和注入，没有用空实现替代、删断言或跳过失败；随后96项相关网页测试通过，完整Linux复跑结果以上方最终记录为准。首次失败日志保留，不能写成从未失败。

隔离浏览器验收在本机独立临时目录进行，页面全程标明“隔离演示·无真实模型”。它运行真正的网页、API、SQLite、交接和登记逻辑，只把模型运行及Docker边界替换成确定性测试对象。手动读取说明→点击交接→读到submitted→打开已登记提案→返回原任务聊天全部成功；最终一项任务、四条消息、一个提案、零正式工具，精确来源读回通过。它验证工程接线，未验证真实模型能否自主构建有价值的新工具。

相关私有证据保留在忽略目录，不进入Git：服务器 `runtime/curation-build-linux-tests-01/02.*`、`runtime/curation-build-before.json`、`runtime/curation-build-acceptance-01.json`、`runtime/curation-build-sync.json`；本机 `runtime/curation-build-browser-receipt.json` 和 `runtime/curation-build-browser-result.png`。同步回执在最终提交后生成，提交号以该回执和Git实际状态为准。

## 与完整原项目还差在哪里

11C 接的是“建议之后”的构建通道。原版的自动观察、七天能力冷却、`report_tool_gap` 主动缺口报告、Goal/Verifier 联动等仍没有在这一小步接入。特别是 `report_tool_gap` 可以让 Agent 把“当前缺哪种通用能力、期望输入输出是什么、依据是哪些事件”明确保存下来；原版 `sirna-tools.ts:290` 与 `router.ts:1566` 提供了这一入口。

下一步适合先补这条缺口报告入口，再把合法报告纳入冻结证据和独立审查。它能补充当前仅依赖重复调用规则的线索来源。报告仍只是模型的一项主张，不能直接当成工具创建许可或效果证据。本轮不提前实现这些后续功能。
