# siRNA-pi

通过亲手逐步重建一个 Pi Agent 应用，理解参考项目中每一层为什么存在、如何连接，以及怎样验证它确实工作。

这是独立的学习仓库。以原仓库当前正式架构为重建目标，每次实现一段可以解释、运行和检查的流程，并用 Git 提交保存学习过程。新网页任务已经通过 Agent Compose 正式 RPC 驱动独立容器中的 Pi；旧 SDK 任务保留原有上下文。

## 当前进度

最新：第12E步在第12D持久化自动修订状态机上接通“验证通过后的批准边界”。默认仍停在 `approving`，只有明确设置 `SIRNA_AUTOMATIC_APPROVAL=1` 才调用已有的可信批准服务；回调必须报告 `approved: true` 且 `activated: true` 才能进入 `completed`，停止、重复通知、非激活结果和旧验证通知都会安全拒绝。当前实现是协调器批准回调，尚未复制原仓库独立 approval maintenance job/worker；逐文件机制和差异见 [自动批准边界](docs/38-自动批准边界.md) 与 [持久化自动修订状态机](docs/37-持久化自动修订状态机.md)。

上一轮第11D已接入 `report_tool_gap`，任务Pi的明确缺口报告可以单独成为审查线索。报告是Agent主张，不能证明缺口真实或授予权限，机制与当时验收见 [Agent主动报告能力缺口](docs/32-Agent主动报告能力缺口.md)。

12E定向回归 `tests/curation-coordinator-integration.test.mjs` 为32项全通过；本轮完整 `npm test` 为1482项：1467通过、15项平台/环境条件跳过、0失败。新增测试覆盖等待批准、显式自动批准、重启恢复、非激活结果拒绝和停止后的迟到通知。第12E步的逐文件解释和边界见 [自动批准边界](docs/38-自动批准边界.md)。

上一阶段第11B的真实合成审查返回skip（1模型响应/0工具）；Windows全套曾有间歇文件锁失败，历史证据不改，见 [独立Curator审查与冻结证据](docs/30-独立Curator审查与冻结证据.md)。以下日期条目保留各阶段完成时的状态，以本节和最新教学文档为准。

11D最终Linux全套1406项：1404通过、2项Windows专属跳过、0失败；已完成真实Pi/适配器/stdio的无模型报告验收和隔离网页报告→建议→构建说明读取。正式业务仍16任务，0缺口报告/独立建议/交接。本轮没有真实模型请求、新业务提案或批准。六旧业务库、旧证据、两个旧任务guest和正式1.0.1保持；新任务使用mcp5，管理服务已更新。同步状态以实际回执为准，隔离演示不计作模型发现成果。此前11C的交接机制与历史验收见 [上一轮说明](docs/31-Curator建议交给Builder.md)。

- 2026-10-15：建立仓库说明、学习路线和协作规则。
- 2026-10-15：在指定服务器目录安装 Pi Coding Agent `1.2.0`，使用已有 Node.js `24.16.0`；依赖检查、版本输出和隔离环境下的帮助命令均通过。
- 2026-10-15：接通 MiniMax 国内平台的 `MiniMax-M3`，完成“读取样例 → 计算 → 写入结果 → 重新读取”任务；实际结果为 4 个数、总和 100、平均值 25。
- 2026-10-15：通过 Pi SDK 创建内存会话、订阅事件并完成相同文件任务；4 次模型响应、3 次成功工具调用，独立验证结果正确。
- 2026-10-15：完成最小网页与 HTTP 服务，通过浏览器提交统计任务；4 次模型响应、3 次工具调用，真实文件通过独立验证，17 项离线测试通过。
- 本轮代码：按原仓库拆开“创建任务”和“发送消息”，增加任务列表、SQLite 历史、同任务多轮会话、SSE 执行动态，并采用 `apps/api`、`packages/task-core`、`packages/agent-runtime` 的职责目录。
- 本轮验证：49 项离线测试通过；真实网页统计结果正确，服务重启后同一 Pi 会话成功继续回答前文问题。完整记录见 [第 4 步：对齐原仓库任务架构](docs/05-对齐原仓库任务架构.md)。
- 2026-10-17：经确认安装 uidmap，启动项目 rootless Docker，固定摘要的官方 hello-world 容器运行成功、退出码 0。全部项目数据位于指定目录；已核对重启和客户端连接范围。见 [第 5 步 A：Docker 运行环境](docs/06-Docker运行环境.md)。
- 2026-10-18：启动正式 Agent Compose v2609.3.0，由其创建命令任务容器，验证执行、文件挂载、管理接口鉴权和停止释放；文件及运行记录保留，49 项离线测试通过。见 [第 5 步 B：Agent Compose 与任务环境](docs/07-AgentCompose与任务环境.md)。
- 2026-10-20：构建锁定依赖的 Pi 1.2.0 guest，经 Agent Compose 模型转接接通 MiniMax-M3；真实文件任务和同会话续问通过，停止后容器释放且文件保留。96 项 Node 测试与 4 项 Linux 凭据测试通过。见 [第 5 步 C：容器中的 Pi 与模型连接](docs/08-容器中的Pi与模型连接.md)。
- 2026-10-20：网页接入正式 Agent Compose RPC，真实统计、不同任务独立环境、网页服务重启后同 Pi 会话续聊通过；170 项 Node 测试与 4 项 Linux 凭据测试通过。详见 [第 5 步 D：网页接入 Agent Compose](docs/09-网页接入AgentCompose.md)。
- 2026-10-20：完成停止本轮、结束任务与容器释放。真实网页停止后同会话续聊成功，运行中结束后 guest 释放、8 条消息及文件保留，刷新只读；239 项 Node 测试与4项 Linux 凭据测试通过。见 [第 6 步：停止运行与结束任务](docs/10-停止运行与结束任务.md)。
- 2026-10-20：完成网页任务文件列表、文本预览与下载。已结束任务仍能查看 CSV/JSON，浏览器下载与宿主字节一致，切换任务不混入其他结果。Linux 271 项 Node 测试通过；本轮没有模型调用。见 [第 7 步：网页查看任务文件](docs/11-网页查看任务文件.md)。
- 2026-10-20：第8步已实现输入上传、独立任务归档、执行前回填和执行后收集。Linux354项测试通过；真实网页上传、回填、旧结果归档下载及结束保留通过。两次新模型验收均遭MiniMax 529过载、0工具调用，成功生成新结果仍待补验。详见 [上传资料与任务文件归档](docs/12-上传资料与任务文件归档.md)。
- 2026-10-20：后续补齐第8步真实成功验收，上传values.csv后3次工具调用得到3/27/9，结束后归档、工作区、HTTP字节一致。原529失败任务保留。
- 2026-10-20：第9步接入首个固定MCP工具 `enumerate_sirna_candidates`。真实网页7响应/6工具，完成MCP业务调用、保存和重读4条候选；结束后下载字节一致。Linux406项测试通过，旧任务保留。详细实现、真实验收和部署问题见 [第一个MCP工具](docs/13-第一个MCP工具.md)。
- 2026-10-20：第10A步完成工具提案合同预检：离线检查草稿字段、权限和测试约定，明确区分预检、实际验证和发布。Linux533项全通过；实际草稿通过、正式入口检查只缺真实运行产物。0模型请求，原10份会话元数据和3个容器保持。详见 [工具提案合同预检](docs/14-工具提案合同预检.md)。
- 2026-10-20：第10B步完成真实工具产物构建：可信CLI将教学源码写入专用容器、冒烟、保存镜像，再在两个新容器复测，输出均为length4/gcFraction0.5；篡改拒绝及真实语法失败验收通过，临时容器已清理。详见 [构建真实工具运行产物](docs/15-构建真实工具运行产物.md)。
- 2026-10-20：第10C步完成提案材料快照、SQLite登记与完整性读回。真实成品已登记为submitted；独立进程重开、材料摘要、事务回滚与篡改拒绝验收通过。Linux730通过/2项Windows专属跳过，0模型调用。详见 [工具提案登记与完整性](docs/16-工具提案登记与完整性.md)。
- 2026-10-20：第10D步完成已登记工具的独立验证、报告保存与状态更新。真实候选基准2/2、基线1/2，净增益1达到门槛；正式提案已成为verified。门槛不足、源码/镜像不一致与报告篡改负例通过。Linux813通过/2项Windows专属跳过，0模型调用。详见 [工具独立验证与报告](docs/17-工具独立验证与报告.md)。
- 2026-10-20：第10E步完成显式批准、首个正式版本包、SQLite版本事务与工具目录。summarize_target_sequence的1.0.0已批准并在目录中active；原源码/报告字节不变，重复批准不新增版本或事件，损坏目录恢复及篡改拒绝通过。Linux916通过/2项Windows专属跳过，0候选执行/模型调用。详见 [工具批准与正式版本](docs/18-工具批准与正式版本.md)。
- 2026-10-21：第10F步完成正式工具发现、受控调用、持久审计和宿主stdio MCP。真实两次新输入得到10/0.4及6/(2/3)，摘要/版本/实际策略/清理通过；三个错误参数在执行前拒绝。Linux940通过/2跳过，0模型请求，旧任务保持。详见 [正式工具发现调用与审计](docs/19-正式工具发现调用与审计.md)。
- 2026-10-21：第10G步接通新网页guest→远程MCP→后端正式工具，逐轮凭证绑定任务/Compose运行/调用审计，真实适配器动态刷新通过。网页6模型响应/6次Pi操作，其中1次正式调用，输出11及5/11；结束后归档和下载一致，旧10会话/2guest保持。Pi自由解释另有碱基计数错误，原记录保留；链路验收不认证整段解释。详见 [网页调用正式工具与任务审计](docs/20-网页调用正式工具与任务审计.md)。
- 2026-10-21：第10H步完成parent改进提案与真实父版本源码绑定。新增归一化碱基计数候选，真实独立基准候选3/3、父源码1/3、净增2，已成为verified；这衡量新增字段合同，不是泛化或生物预测效果。正式1.0.0仍active，尚无1.0.1；0模型调用。详见 [父版本提案与真实基线比较](docs/21-父版本提案与真实基线比较.md)。
- 2026-10-21：第10I步完成1.0.1正式发布、1.0.0人工回退及恢复1.0.1。旧包/报告/镜像保留；同一MCP客户端三次真实调用及版本审计通过。schema4保存版本历史及父关系；0模型/构建/重新验证。1023测试：Linux1021通过/2跳过，Windows1010通过/13跳过。初次Linux测试隔离问题提前迁移数据库，影响核查、修复和复审完整记录见 [工具版本发布与人工回退](docs/22-工具版本发布与人工回退.md)。
- 2026-10-21：第10J步完成六个Agent构建/提交操作及独立宿主MCP。真实协议完成数值工具构建、洁净源码打包和submitted登记，重复请求保持同一镜像/提案，5个负例及5容器清理核验通过；0模型/独立验证/批准。最终Linux1041项：1039通过/2跳过；初次测试清理失败及修正保留记录。详见 [Agent构建工具与提交候选](docs/23-Agent构建工具与提交候选.md)。
- 2026-10-21：第10K步将六个构建工具接入真实网页Pi，保留原build/proposal路径分工，新增每轮身份、资源归属与排空清理。真实16响应/19操作，8次构建业务全部成功，数值范围工具得到3/2/6/4并仅登记submitted；另有2次工具说明参数失败，原轨迹保留。4构建容器及新任务guest已释放，文件保留；Linux1057项：1055通过/2跳过。详见 [网页Agent构建工具与任务归属](docs/24-网页Agent构建工具与任务归属.md)。
- 2026-10-21：第10L步完成网页候选列表、显式验证入队、持久维护作业、串行执行及报告摘要。真实网页验证数值范围工具：领域3/3、候选2/2、基线1/2，9业务运行和2语法检查，11容器全部清理；重启/刷新保持同一结果。Linux1084项：1082通过/2跳过，0模型请求。详见 [网页候选验证队列](docs/25-网页候选验证队列.md)。
- 2026-10-21：第10M步完成可信失败报告→结构化反例→网页修订说明预览。新的故意错误教学候选在乱序输入[6,2,4]返回min6/max4/range-2；领域2/3、候选和基线均1/2，净增0不足1，正常保存verification_failed。网页可读冻结输入、预期、实际输出和门禁；查看不创建作业或调用模型。修订消息、来源任务持久绑定、替代谱系与次数预算尚未接入。详见 [验证失败反馈与修订说明](docs/26-验证失败反馈与修订说明.md)。
- 第10N步接通可信来源绑定和显式一轮修订：失败报告交回原任务，保存固定请求与有界替代链，冻结原测试/基线/权限。真实一轮修订已改写、调试和打包，但模型新增parent违反原合同，提交失败；页面如实显示未收到新候选，不冒称闭环成功。1170项代码回归两端均0失败。逐文件说明、实际验收及边界见 [可信来源与一轮工具修订](docs/27-可信来源与一轮工具修订.md)。
- 2026-10-21：第10O步完成明确合同拒绝反馈，并用独立新任务d72bc8cc…补齐合法替代与独立验证。根候选32b9a044…领域2/3、基准1/2对基线1/2；Pi一轮修订改用Math.min/Math.max，替代5fc8293d…领域3/3、基准2/2对基线1/2、净增1，现verified待人工批准。测试、基线、权限及parent等冻结合同未变。两次propose均成功、0工具错误，所以真实模型轮未经历409拒绝后改正；该反馈仅在真实Pi适配器的无模型夹具和离线集成中触发。第10N失败历史保留。详见 [明确拒绝反馈与修订闭环](docs/28-明确拒绝反馈与修订闭环.md)。
- 第10O步验收：15次模型响应、16次Pi工具调用、113340 tokens，实际费用未知；4构建和22验证容器及新guest均释放。旧270份证据、22份原生文件、2个旧guest及正式1.0.1保持，仅在空闲时重建项目controller和relay两个管理容器。完整1223项测试：Windows1210通过/13跳过，Linux1221通过/2跳过，均0失败。
- 当前正式工具和六个构建工具均可由新网页任务使用；正式工具保持1.0.1，未批准候选不进入正式目录。下一步对照原仓库实现从任务轨迹发现候选能力的真正Curator；当前受控修订成功不等于自动自进化。原版automation会自动批准，个人保留人工门是范围收紧，批准仍使用可信CLI。CPU配额仍不可用，开机自启未配置。

安装位置、文件解释和验证记录见 [第 1 步 A：安装与运行 Pi](docs/01-安装与运行Pi.md)。服务器项目目录是 `/home/hanwen/Project/project/siNRA-pi/`，按用户指定拼写保留。

模型连接、工具轨迹、运行命令和结果检查见 [第 1 步 B：MiniMax 与首次文件任务](docs/02-MiniMax与首次文件任务.md)。后续远端工作均限制在上述项目目录内；用户提供的 `docs/auth.json` 仅在服务器保存，不进入 Git。

SDK 示例、逐段代码解释和实际结果见 [第 2 步：调用 Pi SDK 创建会话](docs/03-SDK创建会话.md)。`npm run pi:sdk -- --check` 只检查会话配置，`npm run pi:sdk` 执行模型任务，`npm run verify:sdk-task` 独立检查已有结果。

最初的网页实现与历史证据见 [第 3 步：网页连接 Pi](docs/04-网页连接Pi.md)，当前任务流程见 [第 4 步：对齐原仓库任务架构](docs/05-对齐原仓库任务架构.md)。服务器运行 `npm run web`，本机通过 SSH 隧道访问 `http://127.0.0.1:3000`。点击“新建设计任务”建立任务，在该任务中发送消息和继续追问；密钥仅由服务器读取。

## 当前常用命令

先进入服务器唯一工作目录 `/home/hanwen/Project/project/siNRA-pi`，使用已有 Node 24 环境。

| 命令 | 用途 | 是否调用模型 |
| --- | --- | --- |
| `npm run web` | 启动 `apps/api/bootstrap.mjs`；只监听 `127.0.0.1:3000` | 启动不调用；网页发送消息后调用 |
| `npm test` | 运行离线行为测试 | 否 |
| `npm run check:tool-contract -- examples/04-tool-contract/proposal.draft.json --draft` | 检查教学草稿；去掉`--draft`会指出尚缺真实运行产物 | 否，也不执行提案代码 |
| `npm run build:tool -- examples/04-tool-contract/proposal.draft.json` | 构建工具镜像、真实运行教学案例，保存带artifact的提案副本 | 否；会执行提案源码并创建容器/镜像 |
| `npm run tools:proposals -- submit <项目内完整提案.json>` | 保存独立材料并新增submitted登记；重复提交会新增提案编号 | 否，也不执行候选/基线 |
| `npm run tools:proposals -- list` / `show <提案UUID>` | 列出最近100条登记 / 重新核对一份材料并查看详情 | 否 |
| `npm run validate:tool -- <提案UUID>` | 从登记材料重新执行验证，保存报告并更新verified/verification_failed；不是批准 | 否；会真实执行候选和基线并创建临时容器 |
| `npm run tools:proposals -- report <提案UUID>` | 只读查看最新验证报告，核对报告摘要与登记关系 | 否 |
| `node scripts/verify-web-tool-builder.mjs 506ee4db-d6c6-4a8c-b1ab-d9bd5b26cb52 ended` | 只读复核第10K步网页构建、来源、清理与输出；10I/10J固定旧提案数检查不再适用 | 否，也不重新执行工具 |
| `node scripts/verify-web-tool-maintenance.mjs` | 只读复核第10L步固定网页验证样例、报告、11容器清理及旧数据；依赖服务器私有基线 | 否，也不重新执行工具 |
| `node scripts/verify-web-tool-feedback.mjs` | 只读复核第10M步固定失败案例、反馈绑定及13容器清理；依赖服务器私有基线。新增候选后，10L旧总数断言不再适用 | 否，也不重新执行工具 |
| `node scripts/verify-tool-repair-feedback-loop.mjs` | 只读复核第10O步固定真实修订、独立报告与清理；依赖服务器私有runtime基线及helper。10N的`verify-controlled-tool-repair.mjs`固定旧总数检查已不适用，旧证据保留 | 否，也不重新执行工具 |
| `node scripts/tool-builder-mcp.mjs` | 启动可信宿主的六操作构建MCP；网页guest通过独立HTTP客户端使用相同内核 | 启动不调用模型；收到构建/提交call会产生相应容器/镜像/提案 |
| `npm run tools:proposals -- approve <提案UUID> "<批准人>"` | 显式批准已验证提案；首版1.0.0，后续分配新patch并启用；重复批准不重新激活历史版本 | 否，也不执行候选 |
| `npm run tools:proposals -- rollback <工具名> <版本> "<操作人>" "<原因>"` | 人工切换到已批准且保留的版本，核对证据、记事件并刷新目录 | 否，也不重新验证或执行工具 |
| `npm run tools:proposals -- versions` / `version <工具名> <版本>` | 只读版本列表 / 核对正式包与来源证据 | 否 |
| `npm run tools:proposals -- catalog` / `catalog-rebuild` | 核对当前目录 / 显式从登记和正式包重建目录 | 否 |
| `npm run tools:mcp` | 启动可信宿主stdio MCP；自动客户端直接以Node启动scripts/approved-tools-mcp.mjs，避免npm横幅混入协议 | 否；收到正式工具call会创建临时容器执行 |
| `npm run pi:sdk -- --check` | 检查 Pi SDK 会话配置 | 否 |
| `sh scripts/check-docker-rootless.sh` | 服务器上的 Docker 前提检查，不启动或安装服务 | 否 |
| `sh scripts/project-docker.sh info` | 检查项目 Docker 的实际模式、目录和能力 | 否 |
| `sh scripts/start-project-agent-compose.sh` | 准备私有状态并启动 Agent Compose 控制服务 | 否 |
| `sh scripts/build-project-guest.sh` | 从固定官方底座构建个人 Pi 1.2.0 任务镜像；首次启动前执行 | 否 |
| `sh scripts/project-agent-compose.sh status` | 查询管理服务状态；同一入口支持 up、inspect 等命令 | 否 |
| `node scripts/verify-agent-compose-workspace.mjs` | 新建固定命令测试环境，检查文件及隔离范围，再停止环境；保留证据 | 否 |
| `node scripts/verify-agent-compose-model.mjs` | 新建容器，完成文件任务及同会话续问，验收后释放容器并保留证据 | 是 |
| `python3 tests/controller-secret.test.py` | 用临时假数据测试控制服务凭据读取；Linux 检查权限和链接 | 否 |
| `npm run pi:sdk` | 再做第 2 步固定文件练习，替换该练习原有输出 | 是 |
| `npm run verify:first-task` | 验证已有 CLI 样例产物 | 否 |
| `npm run verify:sdk-task` | 验证已有 SDK 样例产物 | 否 |
| `node scripts/verify-compose-web-task.mjs <taskId>` | 验证新容器网页统计任务的记录、原生会话和真实文件 | 否 |
| `node scripts/verify-compose-task-files.mjs <taskId>` | 校验下载与任务归档字节一致、读取不改变任务记录；GET 可刷新归档 | 否 |
| `node scripts/verify-compose-upload.mjs <taskId> uploaded\|completed\|ended` | 核验上传未启动环境、真实工具执行和结束后文件保留 | 否 |
| `node scripts/verify-compose-candidate-tool.mjs <taskId> completed\|ended` | 核对真实MCP调用、独立预期、输出归档与结束后交付 | 否 |
| `npm run verify:web-task -- <executionSessionId> --run <runId>` | 验证旧 SDK 网页统计示例的一次具体执行 | 否 |
| `npm run verify:web-task -- <旧任务编号>` | 兼容第 3 步原有网页样例 | 否 |

`executionSessionId` 标识任务使用的执行环境，`runId` 标识其中某次发送引发的运行。两者均可从任务 API 记录和网页“任务记录与文件位置”中核对；不能把网页任务 `id` 直接当作执行会话编号。

## 第一个目标

逐步完成“通过网页操作 Pi”：

1. 认识原生 Pi 已经提供的模型连接、工具与执行循环。
2. 用一小段程序创建 Pi 会话、提交任务并接收结果。
3. 增加最小后端和网页，走通“网页输入 → 后端 → Pi → 网页输出”。
4. 按原仓库重建任务与消息流程、执行过程展示、多轮上下文和历史保存。
5. 接入 Agent Compose 与任务容器，再补上停止和容器生命周期等能力。

完成这个目标以后，再学习专业工具接入、工具版本管理、受控改进及人类反馈。详细安排见 [学习路线](docs/学习路线.md)。

## 每一步怎样学习

每一步都回答六个问题：

1. 当前缺少什么能力，为什么需要增加它？
2. 参考仓库在哪些文件中实现了相关职责？
3. Pi 自带什么，我们需要新增什么？
4. 本次新增或修改的每个文件负责什么？
5. 怎样运行，应该看到什么，失败时如何定位？
6. 实际观察到了什么，还没有验证什么？

先解释当前的小步骤，再实现并验证，最后提交代码和学习记录。后续功能按学习进度展开。

## 参考来源与版本

- 原始参考仓库：[ZhxinMath/sirna-pi-agent-service-refactor](https://github.com/ZhxinMath/sirna-pi-agent-service-refactor)。
- 自己账号下的参考副本：[zhw251030-sketch/sirna-pi-agent-service-refactor](https://github.com/zhw251030-sketch/sirna-pi-agent-service-refactor)。
- 已阅读代码基准：`965c53fba4eaa23996f54aa0532c7f6e1064bfd8`；含贡献核查笔记的参考提交：`67d275494c50f1e5c205b96b72a7b1623acfbe1d`。
- 参考项目使用 Pi `0.85.1`；学习版以 [Pi 1.2.0](https://github.com/earendil-works/pi/releases/tag/v1.2.0) 为起点，通过 npm 使用时要求 Node.js `>=22.19.0`。
- 新版已提供 [MCP 接入](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/mcp.md)，具体接入代码按新版接口验证。

参考项目用于理解问题、职责和实现思路。初始提交没有复制其应用代码；以后引用或改编具体实现时，记录来源、版本和修改内容，并核对相应许可。

## 分支与同步

- 本仓库由个人独立管理，只使用 `main`；日常学习、实现和阶段记录均提交并推送到 `origin/main`。
- 参考仓库 `sirna-pi-agent-service-refactor` 有独立的协作与分支安排，不沿用到本仓库。
- 每次提交聚焦一个学习步骤；推送前检查改动和验证结果。
- 凭据、真实会话记录、运行产物和依赖目录不进入版本控制。

## 目录

```text
README.md                   项目目标、当前进度和学习方式
AGENTS.md                   与编程助手协作时遵守的规则
.gitignore                  排除凭据、依赖和运行产物
.nvmrc                      项目使用的 Node.js 版本
.npmrc                      npm 安装规则
package.json                Pi 依赖和命令入口
package-lock.json           npm 生成的精确依赖记录
scripts/pi-minimax.mjs       读取项目内凭据并启动原生 Pi
scripts/pi-sdk.mjs           调用已有 SDK 创建会话、订阅事件和提交任务
scripts/check-docker-rootless.sh 服务器 rootless Docker 只读预检
scripts/start-project-docker.sh  以 hanwen 启动项目自己的 Docker
scripts/project-docker.sh        Docker 客户端连接项目 socket
config/docker/daemon.json        项目 Docker 的数据、执行、日志与 socket 设置
compose.yml                     Docker Compose 启动管理服务
agent-compose.yml               Agent Compose 的 designer 环境配置
scripts/prepare-agent-compose.mjs        创建私有状态和独立管理令牌
scripts/start-project-agent-compose.sh   启动管理服务并等待健康
scripts/project-agent-compose.sh         经控制容器本地 socket 调用官方 CLI
scripts/verify-agent-compose-workspace.mjs 真实命令工作区验收
containers/agent-compose-guest/           个人 Pi 1.2.0 镜像及启动包装器
containers/agent-compose/entrypoint.py    从只读文件加载控制端模型凭据
config/agent-compose-models.json          无密钥的模型目录与环境变量引用
config/pi/compose-settings.json           guest 的重试、压缩和遥测设置
scripts/build-project-guest.sh            用项目 Docker 构建 guest
scripts/verify-agent-compose-model.mjs    真实容器模型任务及上下文续接验收
scripts/lib/verify-compose-file-task.mjs  按原生会话与真实文件独立验收
apps/api/bootstrap.mjs      组合数据库、运行时与 HTTP 服务，启动网页
apps/mcp/server.mjs         通过stdio MCP列举和调用固定工具
packages/domain/sirna-tools/candidates.mjs   确定性候选枚举与透明预筛选规则
packages/domain/sirna-tools/sirna-tools.mjs  工具说明、参数合同与执行入口
examples/03-candidate-tool/                单条FASTA教学输入及独立验收预期
packages/capability-platform/tool-contract.mjs   工具提案字段、权限、依赖声明预检
packages/capability-platform/tool-validation.mjs 已有结果的匹配与重复性判据，不执行工具
scripts/check-tool-contract.mjs                 只读JSON的离线预检命令
examples/04-tool-contract/                      未构建运行产物的教学提案草稿
packages/capability-platform/docker-engine-client.mjs  显式连接项目Docker的程序接口
packages/capability-platform/tool-build-service.mjs    构建镜像、绑定源码、按成品执行案例
scripts/build-tool-artifact.mjs                       可信宿主构建命令，尚未接入Agent
packages/capability-platform/tool-build-sessions.mjs   交互式构建会话、非root调试、洁净打包、候选提交
packages/domain/sirna-tools/tool-builder-tools.mjs     六个Agent构建/提案工具名称、参数与执行适配
apps/mcp/tool-builder-server.mjs                       独立宿主构建MCP及关闭排空
scripts/tool-builder-mcp.mjs                           受守卫的宿主MCP启动入口
scripts/verify-agent-tool-builder.mjs                  第10J固定完成状态的只读复核
examples/06-agent-tool-build/                          人为准备的数值汇总构建样例
apps/mcp/tool-builder-client.mjs                      guest六工具到固定HTTP接口的适配
apps/api/tool-build-api.mjs                           本轮认证、构建路由及调用事件
packages/capability-platform/task-tool-builders.mjs   本轮专有构建服务与owner释放
scripts/verify-web-tool-builder.mjs                   第10K真实网页构建的只读复核
scripts/verify-tool-repair-feedback-loop.mjs          第10O固定修订与独立验证的只读复核，依赖私有基线
examples/07-web-tool-build/                           人为准备的数值范围工具及网页说明
scripts/lib/tool-build-files.mjs                      有界读取提案及保存私有构建证据
packages/capability-platform/tool-proposals.mjs        独立材料快照、manifest、源文件与包摘要
packages/capability-platform/tool-registry.mjs         SQLite提案、验证索引与状态/事件事务
packages/capability-platform/tool-lifecycle.mjs        提交、列表与按ID核对材料/验证状态
packages/capability-platform/tool-validation-static.mjs  执行范围和候选/基线静态扫描
packages/capability-platform/tool-validation-runner.mjs  源码与镜像绑定、独立容器真实运行
packages/capability-platform/tool-validation-service.mjs 七项关卡编排与候选/基线比较
packages/capability-platform/tool-validation-reports.mjs 报告私有保存、摘要与完整性读回
packages/capability-platform/tool-maintenance-store.mjs  独立作业库、请求去重、领取与暂停
packages/capability-platform/tool-maintenance-worker.mjs 串行验证调度、恢复/关闭及安全摘要
packages/capability-platform/tool-maintenance-validation.mjs 复用验证器并保存作业私有证据
public/tools.mjs                                     全局候选面板、显式验证请求与摘要
scripts/verify-web-tool-maintenance.mjs               第10L固定完成状态的只读复核
packages/capability-platform/tool-approved-packages.mjs 正式五文件版本包与加载完整性
packages/capability-platform/tool-approval-service.mjs  明确批准、首版登记、重复批准及失败状态
packages/capability-platform/tool-catalog.mjs           从active版本生成并核对目录，显式恢复损坏目录
scripts/lib/tool-validation-guest.mjs                  容器内固定助手、执行结果与文件摘要
scripts/validate-tool-proposal.mjs                     按提案编号启动真实独立验证
scripts/manage-tool-proposals.mjs                     可信提交/查询CLI，不运行候选源码
packages/agent-runtime/runtime-router.mjs       新任务走 Compose，旧 SDK 任务继续原上下文
packages/agent-runtime/agent-compose-runtime.mjs 组织任务容器、模型运行与结果保存
packages/agent-runtime/agent-compose-rpc.mjs     使用正式双向 RPC、认证、截止时间和 EOF
packages/agent-runtime/compose-executor.mjs     通过官方 CLI 初始化并检查任务环境
packages/agent-runtime/compose-session-store.mjs 保存执行关系、检查目录与 Pi 会话
packages/agent-runtime/compose-events.mjs       将底层事件映射为网页合同并验证结束状态
packages/agent-runtime/compose-control-token.mjs 仅在服务端安全读取管理令牌
proto/                                       固定版本的官方协议、许可证与来源
scripts/verify-compose-web-task.mjs            新容器网页统计练习只读验收
scripts/verify-compose-lifecycle.mjs           中断、续聊、释放后的状态与文件只读验收
apps/api/router.mjs         任务接口、SSE 传输与静态页面
packages/task-core/task-store.mjs           SQLite 任务、消息和运行事件
packages/extensions/tool-curation/         轨迹预览、独立审查与显式构建交接
packages/extensions/tool-curation/tool-curation-coordinator.mjs 新轮次观察、开关、次数与同步准入
packages/extensions/tool-curation/tool-curation-build-contract.mjs 固定构建指令与权限/摘要合同
packages/extensions/tool-curation/tool-curation-build-store.mjs    不可变交接单、状态和重启恢复
packages/extensions/tool-curation/tool-curation-build-service.mjs  原任务派发、去重和精确提案来源
packages/task-core/task-message-service.mjs 消息检查、去重、执行协调与保存
packages/task-core/workspace.mjs           工作目录归属、受限读取与 SHA-256 共享原语
packages/task-core/task-files.mjs          输入上传、任务归档、执行前回填与结果收集
packages/task-core/safe-file-tree.mjs      安全目录遍历、容量检查与原子文件写入
packages/agent-runtime/runtime-port.mjs     上层调用执行器的边界说明
packages/agent-runtime/local-pi-runtime.mjs 旧 SDK 任务的执行会话与事件转换
packages/agent-runtime/pi-sdk.mjs           CLI/网页共用的 SDK 创建与运行
packages/agent-runtime/workspace-files.mjs  read/write 文件范围检查
public/index.html           任务列表、对话、执行动态三个区域
public/app.js               创建任务、发消息、切换与恢复历史
public/curation-automation.mjs 全局自动审查开关、剩余次数与近期准入状态
public/sse.mjs              连续读取服务端事件，确认保存完成
public/lifecycle.mjs        停止/结束按钮、迟到状态和待发送草稿规则
public/files.mjs            文件请求、文本预览与切换任务后的过期响应保护
public/style.css            网页样式
scripts/verify-first-task.mjs 检查 CLI、SDK 或网页统计任务的轨迹与真实文件
tests/verify-file-task.test.mjs 不调用模型的验收程序测试
tests/web.test.mjs           HTTP/SSE、错误、请求限制和静态访问测试
tests/task-core.test.mjs     真实 SQLite、多轮消息、去重与恢复测试
tests/runtime-events.test.mjs SDK 事件转换行为测试
tests/sse.test.mjs           字节分块、事件帧和保存完成检查
tests/workspace-files.test.mjs 真实文件范围与链接检查
tests/task-workspace-files.test.mjs 网页任务文件范围、链接、变化与容量检查
tests/task-files-http.test.mjs 文件 API、文本/附件响应和错误检查
tests/files-ui.test.mjs      文件请求竞争、预览与切换任务检查
tests/pi-session.integration.mjs 已安装 SDK 的会话落盘与重开检查，不调用模型
config/pi/                  不含密钥的模型和运行设置
examples/01-file-task/       四个样例数和任务说明
examples/02-sdk-task/        SDK 练习的任务说明
docs/学习路线.md             分阶段目标、参考文件和验收方式
docs/01-安装与运行Pi.md       本轮安装说明与实际结果
docs/02-MiniMax与首次文件任务.md 模型接入与真实任务记录
docs/03-SDK创建会话.md        SDK 应用代码与实际任务讲解
docs/04-网页连接Pi.md         网页到服务器、SDK、文件的完整路径
docs/05-对齐原仓库任务架构.md 当前任务流程、职责分层和正式架构方向
docs/06-Docker运行环境.md     系统前提、项目 Docker 和真实容器验证
docs/07-AgentCompose与任务环境.md 控制服务、任务环境、挂载与实际验收
docs/08-容器中的Pi与模型连接.md  镜像、模型转接、凭据范围与真实模型任务
docs/09-网页接入AgentCompose.md 网页正式 RPC、执行事件、同会话续聊及验收
docs/10-停止运行与结束任务.md   停止请求、确认终态、保留文件并释放容器
docs/11-网页查看任务文件.md     文件列表、文本预览与下载
docs/12-上传资料与任务文件归档.md 上传、独立资料区和执行同步
docs/13-第一个MCP工具.md       固定候选枚举工具、MCP与真实网页验收
docs/14-工具提案合同预检.md   工具提交材料、字段与结果判据
docs/15-构建真实工具运行产物.md 源码、构建容器、成品镜像与执行证据
docs/16-工具提案登记与完整性.md 材料快照、数据库、状态和篡改检测
docs/23-Agent构建工具与提交候选.md 六个构建操作、洁净打包、真实MCP验收与边界
docs/24-网页Agent构建工具与任务归属.md 真实网页构建、宿主认证、归属与清理
docs/28-明确拒绝反馈与修订闭环.md 明确拒绝与未知结果、无模型错误验收及真实修订边界
docs/29-工具发现轨迹预览.md 任务事件、真实工具识别、重复能力线索与只读网页
docs/30-独立Curator审查与冻结证据.md 固定材料、独立无工具审查与建议状态
docs/31-Curator建议交给Builder.md 原任务构建交接、持久票据与提案来源
docs/32-Agent主动报告能力缺口.md 主动报告、可信来源、冻结证据与人工审查
docs/33-自动观察与候选冷却.md 保存后通知、自动送审、七天冷却与费用边界
docs/superpowers/plans/      安装步骤与执行记录
```

服务器的 `node_modules/` 保存依赖，`runtime/` 保存运行状态，`workspaces/` 保存旧练习产物；这些都不进入 Git。所有网页任务历史仍在 `runtime/tasks/tasks.sqlite`。新任务使用 `runtime/compose-sessions/` 保存执行关系，`runtime/compose-web/` 保存投影事件，真实工作文件和 Pi 原生会话位于 `runtime/agent-compose/data/sandboxes/<日期>/<sandboxId>/`。第8步新增 `runtime/task-files/<taskId>/input|output` 保存独立任务资料，执行前回填输入、执行后收回输出。旧 SDK 任务继续使用 `runtime/pi-web/sessions/`、`workspaces/web/<executionSessionId>/` 及 `runtime/web/`。

网页后端只读管理令牌；控制服务读取模型 key，且官方会把它保存到管理数据库。因此整个 `runtime/agent-compose/data/` 应作为敏感状态保护，只把每项任务自己的 sandbox 子目录挂给它的 guest。
