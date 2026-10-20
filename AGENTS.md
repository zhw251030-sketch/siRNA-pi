# siRNA-pi 协作规则

## 项目目标

用户希望通过从零逐步重建参考项目来理解 Agent 工程，当前是学习项目。先阅读 README.md 和 docs/学习路线.md，确认当前阶段。

## 学习节奏

- 用中文、面向初学者解释；首次出现的术语给出具体含义。
- 每轮只完成当前约定的小步骤，先说明要解决的问题、涉及的文件和预期结果。
- 实现后结合实际代码说明输入如何流动、哪部分由模型决定、哪部分由程序执行。
- 保持实现尽量小；复杂目录、容器编排、工具治理和自进化机制在对应阶段引入。
- 区分 Pi 已有能力、参考项目新增能力和本学习仓库新增能力。
- 用户的当前指示优先于这里的默认安排。
- 用户已澄清以原仓库正式架构为重建目标，包括 Agent Compose 与独立任务容器。逐步学习时应尽量保持同一职责分层、任务接口、事件语义和交互流程；暂缓功能须标明，不能默默另设计一套简化协议。

## 参考与版本

- 参考仓库是相邻的 sirna-pi-agent-service-refactor；不要为完成本仓库任务修改参考仓库。
- 参考代码使用 Pi 0.85.1，本仓库固定使用 Pi 1.2.0；阅读对应版本的官方接口再实现。
- packages/agent-runtime/chat.ts 是参考仓库保留的 SDK 路径，不等同于参考项目当前默认的 Agent Compose 执行路径。
- 不整仓复制参考项目。引用或改编代码时标明来源、版本和修改，并核对许可。

## 验证与证据

- 不把计划写成已完成，不把历史日志写成当前运行结果。
- 模型连接、文件操作、会话恢复和停止等能力按实际实现进行对应验证。
- 记录运行命令、预期结果、实际结果及尚未验证的范围。
- 普通工程学习不自动构成正式研究实验；保存记录或修改工具不等同于证明自进化有效。

## Git 与凭据

- 本仓库是用户独立管理的个人仓库，只使用 main 分支；所有学习与实现工作提交并同步到 origin/main。
- 区分本仓库与参考仓库 sirna-pi-agent-service-refactor；参考仓库的 hw 分支属于其原有协作安排，不应用到本仓库。除非用户另有要求，不为本仓库新建分支。
- 不改写已有提交，不强制推送，不把用户的其他改动混入本次提交。
- 密码、API key、SSH 私钥、真实会话日志和个人数据不写入代码、文档或 Git。
- 用户指定的密钥文件为服务器项目内 docs/auth.json；当前是一行密钥文本，已忽略且权限为 600，不要打印、提交或复制到本地。
- 需要模型调用时沿用用户明确授权的模型和凭据使用范围；尚未确定时先说明所需配置。

## 远端工作范围

- 用户于 2026-10-17 明确授权助手执行全部项目工作及必要管理员操作；涉及系统安装、系统权限/服务变更、破坏性操作等风险命令，先说明具体命令、目标与影响并取得确认。普通只读检查和项目内可逆准备继续执行，不要求用户代做安装。管理员密码只经约定的认证通道使用，不输出、不持久写入项目。
- 唯一远端工作根目录是 /home/hanwen/Project/project/siNRA-pi；本阶段新增配置、日志、缓存、临时文件、Git 传输文件和练习产物都放在该目录内。
- 使用已有 Node 24 运行环境即可；不再向用户主目录的 .pi、.config 或 /tmp 写入本项目状态。
- MiniMax 国内服务使用 minimax-cn / MiniMax-M3。启动入口是 npm run pi:minimax，读取 docs/auth.json 并将 Pi 状态目录设为 runtime/pi。
- SDK 入口为 npm run pi:sdk；--check 只创建并检查会话，不调用模型。SDK 状态位于 runtime/pi-sdk，任务事件位于 runtime/sdk-task.events.jsonl，结果位于 workspaces/sdk-task/result.json，保留原 CLI 练习证据。
- 原CLI/SDK练习仍只开放read/write、使用内存会话。第9步新Compose guest允许read/write/mcp；mcp来自官方显式pi-mcp-adapter 2.11.0，只连接控制端指定的固定服务。Pi原生MCP和自动资源发现仍关闭；网页使用项目内持久化会话。工具允许清单不是操作系统级沙箱。
- 网页入口为 npm run web → apps/api/bootstrap.mjs，只监听 127.0.0.1:3000，经 SSH 隧道访问。先 POST /v1/tasks 创建，再 POST /v1/tasks/:id/messages 发送；不要恢复成旧的一次性合并接口。
- 网页历史保存在 runtime/tasks/tasks.sqlite。旧 SDK 任务的 Pi 上下文位于 runtime/pi-web/sessions，执行元数据 runtime/task-sessions，目录 workspaces/web/<executionSessionId>，日志 runtime/web/<executionSessionId>.<runId>.events.jsonl；该旧路径有任务目录读写限制。
- 新任务默认 Agent Compose：元数据 runtime/compose-sessions，投影日志 runtime/compose-web，实际文件/原生 Pi 会话在 runtime/agent-compose/data/sandboxes/<日期>/<sandboxId> 下。日期路径必须读取 inspect.workspace_path；guest 中 read/write 允许清单不等于严格路径限制。通过 RuntimeRouter 保留旧 SDK 任务，不将故障新任务静默改走 SDK。
- 通用 SDK 调用位于 packages/agent-runtime/pi-sdk.mjs；scripts/pi-sdk.mjs 保留命令行入口。网页支持多轮、SSE、历史恢复；Compose 任务现支持停止/结束。SSE 的 done 后还要保存消息并发出 task_saved；连接断开不能取消已接受任务，正常关闭服务也须等待后台任务和生命周期操作落盘。
- 容器网页统计检查：node scripts/verify-compose-web-task.mjs <taskId>；旧 SDK 网页检查仍为 npm run verify:web-task -- <executionSessionId> --run <runId>；--web <UUID> 仅用于原第3步历史样例。

## 当前阶段

2026-10-15：已完成第 4 步的任务流程对齐，采用 apps/api、packages/task-core、packages/agent-runtime、public 的职责目录。真实网页第一轮统计任务通过独立验收（4 次模型响应、3 次工具调用）；重启网页服务后在同一任务追问，Pi 保持同一会话编号并正确回忆前文标记（1 次模型响应、0 次工具调用）。原 CLI/SDK/旧网页证据仍通过检查。完整记录见 docs/05-对齐原仓库任务架构.md。尚未部署 Agent Compose、任务容器、停止功能或自进化。

下一步先沿 docs/05-对齐原仓库任务架构.md 理解当前请求和保存链路，再按原仓库接入正式 Agent Compose 与任务容器。只读预检发现 hanwen 无 Docker socket 权限，尚无 agent-compose 命令；容器阶段须解决权限和状态目录前提，不擅自修改系统用户组或项目外配置。服务器直接访问私有 GitHub 的认证尚未配置，继续通过本地 GitHub 授权与项目内 Git bundle 同步。

2026-10-17：用户确认系统安装并提供管理员认证，已安装 uidmap 1:4.8.1-2ubuntu2.2，升级/删除为零。项目 rootless Docker 28.3.0 已由 hanwen 启动，固定摘要的官方 hello-world 容器运行成功，退出码 0，测试容器已自动清理。详见 docs/06-Docker运行环境.md。

Docker 使用脚本 scripts/project-docker.sh 显式连接 runtime/docker/run/docker.sock；不要让命令回落到共享 /var/run/docker.sock。启动入口 scripts/start-project-docker.sh，配置 config/docker/daemon.json，状态均在 runtime/docker；外层目录 0700，Docker 数据子目录允许其原生的 0710。已有 PID/socket/RootlessKit 状态时拒绝启动，不盲目清理；尚未配置开机自启。实际 cgroup 为 systemd/v2，内存和进程数限制被 Docker 报告为可用并由测试容器接受，CPU 配额不可用。下一步接入 Agent Compose 控制服务及 guest，当前网页仍为 local-pi。后续新系统权限/服务变更继续按用户要求确认，不把这次 uidmap 授权扩大到其他系统操作。

2026-10-18：Agent Compose v2609.3.0 控制服务已健康运行，127.0.0.1:7410；配置 compose.yml / agent-compose.yml，入口 scripts/start-project-agent-compose.sh、project-agent-compose.sh。项目独立管理 token 位于 runtime/agent-compose/control.env（0600，不显示或提交），与模型 key 分开；CLI 在管理容器内经 Unix socket 连接，HTTP 管理请求要求 token。不要输出 Docker Compose 完整解析配置或控制容器完整 inspect，以免显示 token；配置检查用 config --quiet。

已用 scripts/verify-agent-compose-workspace.mjs 完成真实无模型命令验收：创建 guest、运行成功、文件挂载与网络核对、宿主/guest 未登录请求均 401、停止后资源 released 且文件保留。证据 runtime/agent-compose/verify-RaHJj9；日期分层路径从 inspect.workspace_path 读取。默认 guest 实际无内存/进程/CPU 配额。官方 guest 内置 Pi 0.82.1，本轮未启动它；不能据此声称个人 Pi 1.2.0 容器接通。AGENT_COMPOSE_RUNTIME_BASE_URL 本轮刻意留空，避免模型代理准备读取凭据；后续真实模型阶段才配置可访问回调和模型配置。

当前下一步：制作并验证 Pi 1.2.0 定制 guest 与 MiniMax，再接网页 Agent Compose 运行时。现有网页仍 local-pi / taskContainers=false，49 项离线测试通过；本轮不修改研究阶段。完整解释和已验证边界见 docs/07-AgentCompose与任务环境.md。大镜像直连下载失败后采用官方摘要校验的本机归档传输，归档保留 runtime/image-transfer，不配置系统代理。

2026-10-20：第 5 步 C 已完成。个人 `sirna-pi-guest:pi1.2.0` 使用完整 lockfile，实际 ImageID 为 `sha256:e34a8f3fe6b2b74a3fa7f1a6143a126ae1e5414fa8a334c7bba82fe57d28971b`。wrapper 保留官方 session 参数，仅启用 read/write、禁用 MCP/自动资源、重试和压缩；不覆盖官方 facade models.json。read/write 允许清单不等于 guest 内严格路径沙箱。

controller 通过只读单文件挂载读取既有 docs/auth.json，Python 入口将 key 注入 daemon 进程而非 Docker Config.Env。官方会把 key 存入 runtime/agent-compose/data/data.db，因此管理数据也属于敏感状态，不能输出凭据列或挂给 guest。模型目录为 config/agent-compose-models.json，国内 api.minimax.cn/anthropic/v1，maxOutputTokens4096 为单响应上限；回调现为 http://agent-compose:7410。guest 使用绑定 sandbox/provider/protocol 的 facade token，不能称其自动定时过期或精确锁单模型。

真实验收入口 scripts/verify-agent-compose-model.mjs 会调用模型并产生额度消耗。证据 runtime/agent-compose/model-verify-IT2dgw：第一轮4次响应、3次成功工具，count4/sum100/mean25；第二轮同Pi会话回忆随机口令，1次响应、0工具；停止后 released 且文件保留。96 项 Node 测试和4项目标Linux凭据测试通过。命令工作区回归证据 verify-oKmfDl。详见 docs/08-容器中的Pi与模型连接.md。

以上是第5步C结束时的状态；网页RPC的后续完成证据见下。

2026-10-20：第5步D完成，bootstrap默认新任务走AgentComposeRuntime，通过官方AttachAgentRun双向RPC，Bearer管理认证、顺序回调、显式stdinEof、最终result验证后收尾。proto/LICENSE原样固定到官方493af1c16a7c84ac8ab3bdfdaf1419ed19d0a9d8。保留旧SDK任务，未知/损坏记录拒绝静默新建上下文。

真实网页任务52d8672c-f320-4543-bd56-0729389b70d1完成统计（4响应/3工具/count4sum100mean25）；重启网页服务后同Pi会话01a155ae-b9d2-734b-99dc-1d348210cc98续问成功（1响应/0工具），JSONL原8833字节未变且追加新记录。第二任务52072665-52fb-4f0e-b93c-167ada3950e4的sandbox、Pi会话、目录均独立。证据runtime/compose-web/acceptance-{first,isolation,resume}.json；两项网页guest保留运行。完整说明docs/09-网页接入AgentCompose.md。170项Node测试、4项Linux凭据测试通过；网页health现在backend=agent-compose/taskContainers=true。

DETACH任务可能在网页进程意外退出后继续：重启提示只能说结果未确认。新一轮先依序查pending/running，失败不认作空闲；已知运行的RPC异常尝试StopRun，停止未确认保留标志，不自动重试付费任务。单网页进程，不声称跨副本原子锁或自动重新附着。凭据清理不保证识别任意文本秘密，原始记录仍私有。

以上为第5步D结束状态；第6步最新完成记录见下。

2026-10-20：第6步完成。POST /v1/tasks/:id/cancel 请求停止本轮；DELETE /v1/tasks/:id/runtime 等待保存后释放并标记 stopped。TaskCore与Runtime分别保护运行/取消/结束竞争；旧SDK任务禁用新功能。RPC以StopRun+终态流/GetRun确认结束，不把running确认当成功。网页维持SSE至task_saved，结束状态不会被迟到事件复活；未送达草稿保留于浏览器sessionStorage但不阻塞新任务。

重要版本差异：v2609.3.0的sandbox rm会删除整个sandbox目录，不得用于保留文件的结束流程。执行sandbox stop --graceful，检查vm_status=stopped和stopped_runtime_state=released。当前Docker prompt attach可能把中断变为failed/context canceled；只有持久化userCancelRequested、后台终态、精确错误文本且无cleanupError才解释为canceled，保留daemonStatus/Error等原始字段，普通失败仍失败。初始化中断允许既有固定命令收尾、不提交模型；首轮过早中断可能无法恢复完整上下文，不静默重建。

真实复验任务36ba635d-8b5c-44d2-a4fe-ec272564f5d6：正常统计→停止→同Pi会话01a155d6-267f-73c5-953d-d4237f42c428续问→运行中结束。最终8条消息，guest0、released/graceful，统计文件4/100/25，原生JSONL前8607字节不变、增长到34509。证据runtime/compose-web/lifecycle-v2-{baseline,canceled,resumed,ended}.json；只读验收scripts/verify-compose-lifecycle.mjs。诊断任务f612f8c2-3481-43ae-b92e-c570c4f75cc9也已释放并保留失败记录。第5步D两项旧guest仍运行。239项Node测试与4项Linux凭据测试通过；详细说明docs/10-停止运行与结束任务.md。

最新下一步：对照原仓库任务文件接口，学习网页查看输入/输出与获取结果，再进入工具封装。本步无新系统安装、权限或系统服务配置修改；main单分支，不修改RSI研究项目及其阶段。代码继续本机GitHub提交/推送、项目内bundle同步服务器，不强制覆盖未提交修改。

以上为第6步结束时的安排；以下为最新状态。

2026-10-20：第7步完成网页任务文件列表、文本预览与下载。入口 packages/task-core/workspace.mjs，GET /v1/tasks/:id/files 和 /files/:kind/:encodedName；元数据字段同原仓库，额外 state=ready/unprepared/unsupported。只读已保存的 Compose workspacePath/input|output，不启动模型或容器；旧 SDK 扁平目录明确暂不支持。当前直接读宿主绑定目录，尚无原仓库独立 task-files 归档／同步层，因此仍依赖 graceful stop 保留文件。

Linux 用目录描述符锚定逐层读取，拒绝符号链接、硬链接、特殊文件与越界；前后身份和时间检查发现变化返回409。文本预览256KiB，单文件50,000,000字节，列表哈希100,000,000字节／1000条目，超限413。前端 public/files.mjs 的取消与请求编号防止任务切换后显示旧文件；文件内容只作纯文本。不能称这些HTTP检查为Pi工具沙箱或多用户鉴权。

第7步验收：Linux271项Node测试通过（新增32项，无跳过）；Windows268通过、3项Linux专属检查跳过。已结束任务36ba635d-8b5c-44d2-a4fe-ec272564f5d6的CSV18字节／JSON45字节可预览下载，JSON指纹b62fa3ddc398457bbb243e0bbe7dbed5b4293f896eebbc4f8e1acdee587b03bf，内容4/100/25。另一任务52072665-52fb-4f0e-b93c-167ada3950e4只有自己的输入，没有输出混入。新建空任务b430129d-72e1-4304-9907-cb97103c0d0b用于文件空状态检查，没有发送模型消息。验收入口scripts/verify-compose-task-files.mjs，私有证据runtime/compose-web/files-*-acceptance.json。参考说明docs/11-网页查看任务文件.md。本轮无模型调用、无系统变更，两个旧guest未停止。

最新下一步：按原仓库加入输入文件上传、独立任务文件归档以及与sandbox的同步，再学习工具封装。继续main提交与GitHub/bundle服务器同步，只改siRNA-pi学习项目。

以上为第7步结束状态，以下为最新进度。

2026-10-20：第8步上传与独立归档代码完成。bootstrap使用TaskFiles；runtime/task-files/<taskId>/input|output保存任务资料，hydrate在Compose准备完成且远端明确空闲后、RPC提交前回填输入；collect在执行后和释放后收集输出。POST files沿用{name,contentBase64}，新上传1..600000字节、同名409不覆盖；历史输入导入／回填与下载保留50MB，总量100MB/1000条目。旧输入只导入缺失项，GET不回写guest，归档不镜像删除。保存成功但同步失败201pending；归档失败workspace_warning与模型终态分开；workspace事件外层沿用SQLite progress_message，实际类型在payload.type。上传和运行／结束互斥，重启后先核查远端活动状态。网页预览读取X-Task-Files-Sync提示cached。

本轮Linux354项Node测试全通过；Windows350通过、4项Linux专属跳过。真实浏览器两个任务624e3709-f5f8-422b-8ce7-a7c8e079d155和a841937e-66a1-4010-bd2d-97fb3a58b7a1上传values.csv13字节成功，上传本身无guest/Pi会话/模型运行；输入归档、工作区与HTTP字节相同。两个任务的模型请求均收到MiniMax529 overloaded_error（相隔约4分钟），原生记录0工具调用，没有生成3/27/9结果，真实成功链路尚未验收，不能声称已通过。两项guest已结束释放、0容器、无活动运行，输入及失败历史保留。第5步D的两个旧guest仍运行。旧结束任务36ba635d的result.json45字节已按需收回任务归档，字节指纹和4/100/25历史结果未变，下载验证通过。

验收脚本scripts/verify-compose-upload.mjs支持uploaded/completed/ended，只查验、不调用模型；completed严格检查原生read→write→read、统计和同步记录，本次两次失败均拒绝通过。私有证据runtime/compose-web/upload-{acceptance-uploaded,retry-uploaded,first-overload,retry-overload,retry-files,legacy-archive,releases}.json，完整测试runtime/upload-step8-tests.log。详细文件解释见docs/12-上传资料与任务文件归档.md。

最新下一步：MiniMax服务恢复后，用新专用任务补齐上传→模型读取→新结果归档→结束后下载的成功验收；保留失败任务与记录，不循环自动付费重试。然后对照原仓库capability-platform/agent-tool.ts与pi-extension.ts进入可复用工具封装。main单分支；无新系统权限/服务/安装变更；不改上级RSI项目。

以上为第8步当时状态；以下为最新进度。

2026-10-20：已补齐第8步成功验收，专用任务4f75f67c-a3ab-43b3-94a4-6f0e680334b0完成3次工具和3/27/9，uploaded/completed/ended均通过，结束后文件保留。原529任务保持失败历史。

第9步完成首个固定MCP工具enumerate_sirna_candidates：packages/domain/sirna-tools负责确定性算法和工具合同，apps/mcp/server.mjs使用固定MCP SDK1.30.0/stdin-stdout。与参考transparent_prefilter_v1的输出和评分规则对齐，严格拒绝未知参数。分数只是预筛选，不是活性预测；未实现专业软件或自进化。

正式路径agent-compose.yml声明sirna-tools，通过官方pi-mcp-adapter2.11.0向Pi1.2.0提供mcp入口；业务名带前缀sirna_tools_enumerate_sirna_candidates。新项目sirna-pi-learning-mcp、新镜像sirna-pi-guest:pi1.2.0-mcp1。pi.sh仅允许read/write/mcp，关闭原生MCP和自动资源发现。构建补丁只允许显式控制端MCP配置，拒绝imports，防止全局/项目配置替换；这不是OS路径沙箱。旧任务保留原project/revision/image，不静默迁移。

第一次网页试跑061b69c5因控制容器单文件bind mount仍指向旧YAML而没有MCP，未生成候选，已结束并保留记录。检查所有任务空闲后仅重建本项目控制容器并up；旧8份session文件、旧项目修订和两个旧guest保留。后续修改此配置需同时核验容器内内容，不能只看宿主文件或up退出码。

真实复验任务5567e0ae-6715-4db8-8be9-0a4ea6079ca6：7响应/6成功工具（read、MCP连接、MCP描述、MCP业务call、write、read）；4条候选与独立expected.json一致，812字节JSON原文未改写，archive/HTTP/guest及浏览器下载SHA一致。completed/ended验收通过，guest已释放，历史文件保留；两个第5步D旧guest仍运行。验收入口scripts/verify-compose-candidate-tool.mjs与lib/verify-compose-candidate-task.mjs，新增32项负例/成功轨迹检查。最终Linux406通过/0跳过，Windows402通过/4Linux专属跳过；无模型guest适配器检查也通过。

完整文件解释与证据见docs/13-第一个MCP工具.md。下一步围绕原仓库工具合同、注册记录和验证案例学习工具管理，再进入外部软件执行与版本流程；不要把当前固定算法接入称为自动封装或自进化完成。本轮不修改系统服务/权限、上级RSI项目，继续main同步。

2026-10-20：第10A步完成工具提案合同预检。packages/capability-platform/tool-contract.mjs区分完整性与字段检查，tool-validation.mjs提供已有记录的成功/输出匹配/重复性判据；scripts/check-tool-contract.mjs只读JSON，绝不运行源码。npm run check:tool-contract -- examples/04-tool-contract/proposal.draft.json --draft退出0，默认正式MCP要求检查退出2且仅缺/runtimeArtifact。教学提案尚无真实运行产物，不得伪造摘要；executed/registered/activated/runtimeArtifactVerified始终false。

对照原tool-contract/tool-lifecycle/output-matcher独立实现；原MCP提交要求运行产物，而HTTP提交未开启同一完整性选项，不能混为一谈。expectedOutput为字面递归子集，不是JSON Schema；exact要求两次成功且stdout/stderr/filesDigest相同，contract仅放松字节相同要求。JSON和未知字段有意收紧；运行记录必须完整，拒绝自定义数组原型。依赖预检沿参考字符规则，next/stable/1.x可能通过，不保证版本不可变或实际安装。

新增126项专测，原RPC超时测试分成两种明确情形，生产停止代码未改。最终Linux533通过/0跳过，Windows529通过/4项Linux专属跳过。两地实际CLI结果一致；服务器10份会话元数据哈希、3个运行容器ID/镜像、凭据文件元数据保持，health就绪空闲。0模型请求，不读真实凭据内容，不构建镜像，不重启服务。日志在runtime/contract-preflight-*，详见docs/14-工具提案合同预检.md。

当前下一步：为工具建立真实可追溯的运行产物，再登记提案、在专用环境实际验证、批准并暴露版本；这些尚未实现。现有MCP仍只有固定候选枚举工具，预检CLI未接到网页或MCP服务；不要把“字段通过”写成verified/approved或自进化完成。

以上为第10A步结束状态；以下为最新进度。

2026-10-20：第10B步完成真实工具构建与成品案例执行。docker-engine-client.mjs通过显式项目socket调用Docker API v1.43；tool-build-service.mjs只接受node/无依赖/no_external_access/exact/最多10案例的草稿，输入JSON最多64KiB，源码沿合同200000字节并分块上传。固定已存在Pi1.2.0 ImageID e34a8f3f…作为Node底座，不启动Pi或模型。源码写入/语法/读回哈希/非root冒烟后stop→commit，候选baseline不写入镜像；按成品真实ImageID为每例创建独立运行容器。artifact沿原六字段，没有filesDigest或完整验证声明。

构建与运行配置1GiB内存/64进程、CapDrop ALL、no-new-privileges、无网络/宿主bind/凭据/socket；运行非root65534、readonly根、64MiB临时/tmp。CPU配额仍不可用。实际inspect检查配置；固定命令/平台/会话/时间/源码与基座标签绑定。不是任意敌对代码的完整沙箱，只供可信CLI运行已审阅教学源码，尚未接HTTP/MCP构建工具。

入口npm run build:tool -- examples/04-tool-contract/proposal.draft.json，仅允许Linux/hanwen/唯一项目根。scripts/lib/tool-build-files.mjs有界读取和保存runtime/tool-builds/<UUID>私有证据；proposal.json最后发布，不改草稿、不覆盖旧记录。语法和smoke失败先保存exit/stdout/stderr，再抛错并清理。只移除本调用获得且标签归属核对的容器，保留镜像；清理未确认时报错带ID。SIGKILL/主机崩溃恢复与TTL清理服务尚未实现，不得全局扫删容器。

真实成功构建7e0aa187-6c67-46b6-8c5f-7b2e4f5351ea，镜像sha256:e800a6bdb8139da0fb8026a838744a748990a314a025435f5f0a20572ea2ec18，源码哈希3bb9f0ca3237100e9ceb7e182939ed731fc6a68b9f1c1251bf6ffb577193d8ac。冒烟和两个成品新容器案例均length4/gcFraction0.5；完整字段预检通过，仍registered/approved/activated/verified=false。两个篡改输入拒绝；真实语法失败2a997147-af94-4e6b-a736-9b850370ad37保留SyntaxError、无commit/成功提案。临时容器0，旧10会话哈希/3容器/凭据元数据不变，health就绪空闲，模型请求0。

新增74项测试，最终Linux607通过/0跳过，Windows603通过/4项Linux专属跳过；独立审查与范围限定复审通过。私有证据runtime/tool-artifact-{acceptance,state-before,linux-tests,sync}及runtime/tool-builds，逐文件解释docs/15-构建真实工具运行产物.md。现有服务无须重启，继续main提交/GitHub推送/bundle服务器同步，不修改参考库或上级RSI。

当前下一步：对照tool-lifecycle学习提案登记、完整独立验证与状态流转，再接批准版本和Agent发现/调用。当前只有构建/执行内核与教学案例证据，基线净增益、双次重复性完整门禁、审批、发布及自进化仍未实现。

以上为第10B步结束状态；以下为最新进度。

2026-10-20：第10C步完成工具提案持久登记。packages/capability-platform/tool-proposals.mjs独立实现sirna-tool-proposal/v1材料：manifest.status=draft/version=0.1.0-draft、候选与baseline文件、两源SHA及整包摘要；runtime/tool-artifacts/proposals/<UUID>下Linux文件0400/目录0500。read重新核对平面文件集合、链接/硬链接、大小/UTF-8、前后文件状态、合同与摘要。拒绝无法无损UTF-8往返的源码；损坏manifest的JSON/解码错误固定提示，不回显原文，仍保留ID/路径。

tool-registry.mjs使用显式runtime/tool-registry/registry.sqlite，独立application_id/user_version，普通单链接与sidecar检查、0600新库，未知库只读探测后拒绝，无迁移；readonly不存在不建库。tool_proposals及proposal_submitted事件用BEGIN IMMEDIATE同事务；初始仅submitted，actor=local-cli。正式发布版本/验证记录尚未建立；同材料重提会新UUID，无内容去重。parent更新提案本步明确拒绝，不能擅自移除parent。

tool-lifecycle.mjs连接完整合同→材料→SQLite；list最多100条元数据，show按固定根读回材料并核对DB工具名/权限/镜像。npm run tools:proposals -- submit <项目内JSON>|list|show <UUID>仅Linux/hanwen/唯一项目根；提交不执行候选/基线、不核验镜像、不接HTTP自动化/MCP/审批。文件和DB非共同事务，DB失败可能留未登记包，错误附定位；无自动清理、恢复或请求幂等。

真实提交ID f742eea2-b025-4474-ae47-d6eab267c408，材料包SHA c434888a9acf31d8143c3df19c9fec126cf5c3cfe7bf996a5b2b574e0cda4a49；沿用10B构建7e0aa187…及e800a6bd…镜像，原提案未变。4独立CLI进程空list→submit→list→show，正式库1提案/1事件、submitted/draft；独立摘要和Linux权限实测。runtime/registration-negative-pdvrVY单独负例验证源码不执行/篡改拒绝/损坏manifest不回显，正式材料未改。旧10会话哈希/3容器/凭据元数据保持，镜像仍存在，模型0。

新增125项：材料61、SQLite54、集成10。最终Linux732项=730通过/2项Windows专属跳过；Windows722通过/10平台或符号链接权限跳过。独立审查P2已修复且范围复审通过。本机中间一次旧HTTP测试fetch bad port：OS临时端口1024..15000与fetch禁用端口相交，单测及全套复跑通过；记录registration-local-bad-port.log/registration-port-diagnosis.md，未称已修复也未改系统端口设置。

证据runtime/registration-{submitted,acceptance,linux-tests,sync}，详细解释docs/16-工具提案登记与完整性.md。继续main提交/GitHub/bundle同步，不更改参考或上级RSI。下一步从已登记提案ID出发建立独立验证报告及状态变化，逐步完成静态、语法/依赖、双次重复性、领域案例与基线净增益；审批、版本发布、自动封装和自进化仍未完成。

以上为第10C步结束状态；以下为最新进度。

2026-10-20：第10D步完成独立验证。tool-validation-static/runner/service/reports及固定guest助手分别负责范围/词法扫描、真实容器执行、七关卡编排与报告完整性。仅Node、无额外依赖、no_external_access、exact，领域/基准各1至10例、业务输入64KiB；其他范围显式拒绝。原sirna-tool-validation/v3主要报告合同保留，实际工作目录摘要额外核对并使用有明确长度边界的编码；与原镜像控制路径固定filesDigest标记有意不同。词法扫描不是安全证明，案例来自提案而非独立隐藏集。

候选镜像核对标签和实际/opt/tool/main.mjs摘要；基线从登记源码进入独立固定Node底座。每次运行新容器，非root65534业务执行、无网络/宿主挂载/凭据/socket、只读根、1GiB内存/64进程/tmp64MiB，CPU配额仍不可用。固定root助手仅准备只读源码/助手和核对摘要。只清理得到且标签归属一致的容器，再确认不存在；Docker传输/来源/清理异常中止并保存诊断，不能伪装成基线低分。

tool-registry schema2增加tool_validations/latest_validation_id，recordValidation事务更新报告索引/状态/最新ID/事件。已知v1只读不迁移，写入验证显式migrate:true，先VACUUM INTO一致备份（含已提交WAL，0600）再升级；未知schema拒绝。允许submitted/verified/verification_failed重验，approved/rejected拒绝；每次新报告ID，历史保留。报告独占写/fsync/0400，读回固定路径、普通单链接、大小、前后状态、SHA与DB/协议关系；报告与DB不是跨系统事务，异常保留可定位文件。

CLI npm run validate:tool -- <proposalUUID>仅Linux/hanwen/唯一项目根/项目Docker；退出0通过、2完整验证未通过、1操作异常。npm run tools:proposals -- report <UUID>只读最新报告，show同时核对材料与报告。未接HTTP/MCP，未批准发布；manifest仍draft，verified只在登记状态。

正式提案f742eea2-b025-4474-ae47-d6eab267c408，验证db1ef939-a129-4766-9a47-5b52917e927e，报告SHA42056952447cc598f627cb7bb780a195273d9d23351c2b957deac9fc53144e5a。8次业务运行/8独立容器，双烟测一致、领域2通过、候选基准2/2基线1/2净增1达到门槛，state=verified，approved/activated=false。原三材料哈希不变；v1备份44de245b-19ff-47a4-8c13-89526d25b84b仍原submitted+1事件，v2库1验证+2事件。独立负例runtime/validation-negative-7eQXFB：最低净增2则verification_failed；源/镜像不匹配在业务前拒绝；负例报告篡改拒绝，正式报告未变。

新增83项，815项总测试：Linux813通过/2项Windows专属跳过，Windows805通过/10平台权限跳过，0失败。独立全审及范围复审通过，修复UUID跨模块合同、Docker传输错误误计基线、文件摘要编码歧义并补回归。证据runtime/validation-{acceptance,negative-acceptance,local-tests,linux-tests,sync}；文件教学docs/17-工具独立验证与报告.md。旧10会话哈希/3运行容器/凭据元数据不变，临时验证容器0，health就绪空闲，模型0。无系统变更/重启/镜像创建或删除；所有证据、备份和镜像保留。

下一步：沿原仓库实现明确审批、正式工具版本、Agent发现/调用边界。不要把verified写成已批准/自动可用，不把提案案例成绩写成未见输入泛化或科研活性证明。持续main提交/GitHub推送/bundle同步，仅本学习项目；不改参考、上级研究库或agent_RSI_demo。

以上为第10D步结束状态；以下为最新进度。

2026-10-20：第10E步完成显式批准与首版目录。tool-approved-packages.mjs生成并核对五文件包：manifest/tool.mjs/verification/approval/integrity，协议sirna-approved-tool/v1、sirna-tool-approval/v1、sirna-approved-tool-integrity/v1；源与报告原字节不变，基线留原提案。正式包SHA沿参考sorted name+NUL+fileHexSHA+LF，原提案摘要算法不改。Linux文件0400/目录0500；有界读取、精确集合/身份/摘要/前后stat，链接/硬链接拒绝。无签名；私有父目录可信，不承诺抵抗同UID恶意并发替换。

tool-registry schema3增加tool_versions，v1/v2显式升级先VACUUM INTO一致备份，旧版只读不迁移，v2仍可recordValidation。activateVersion事务内核对verified/最新validationId/报告SHA/材料SHA/工具名/镜像/无同名首版，再插active版本、改提案approved、记version_activated事件。仅首个1.0.0，无parent替换/禁用/回滚。

tool-approval-service从原登记证据出发，包→DB→目录不是共同事务：DB失败保留孤立包路径，目录失败明确versionActivated=true，重复批准核验原包并修复目录，不增版本事件。tool-catalog生成sirna-tool-catalog/v1，读取与DB active投影和包一致；显式重建可替换损坏普通文件，不能跟随链接，读取/生成均限1MiB。show/report批准后仍核对原材料与报告，show另外核对版本包。active只表示目录当前选择，agentCallable=false。

CLI tools:proposals新增approve <UUID> <approvedBy>、versions、version <toolName> 1.0.0、catalog、catalog-rebuild，沿用Linux/hanwen/唯一项目根限制。批准人文本是审计声明非认证。本次用户授权助手继续学习步骤，记hanwen (delegated learning step)，不冒充用户亲自逐行审阅。

正式提案f742eea2-b025-4474-ae47-d6eab267c408现approved，工具summarize_target_sequence、toolId977b9593-091a-4624-a4ba-b0c8f12b62df、1.0.0 active。包SHA4e259ca65e6bd9b70e9ebe0017fbcd76d79a3777c1dfe5e3a0d2d195a4b5cd73；原验证db1ef939-a129-4766-9a47-5b52917e927e及报告SHA42056952…未变，原三材料摘要一致。v2备份8c98cbf1-9b31-452c-8d98-9edf2cedbb0c保留原verified/2事件；正式v3为1版本/3事件/目录1项。重复批准版本/批准时间/包字节/事件不变。

负例runtime/approval-negative-LXga7l克隆真实数据：超大目录拒读/显式恢复、submitted拒批、正式包源码和报告篡改拒绝；正式数据未改。首轮私有验收断言错误消息正则过窄，修正脚本后新副本通过，非产品失败。新增103项，最终918测试：Linux916pass/2Windows专属skip；Windows906pass/12平台权限skip，0fail。独立审查一P2超大目录恢复已修复且复审通过。旧10会话/3运行容器/凭据元数据保持，health就绪空闲，候选执行0/模型0，无容器镜像写操作或重启。

证据runtime/approval-{acceptance,negative-acceptance,local-tests,linux-tests,sync}，文件说明docs/18-工具批准与正式版本.md。下一步对照正式包发现和执行流程接入Agent/MCP及调用审计，再扩展parent版本迭代。持续main同步，仅本学习项目；不把active目录写成Pi已可调用，不把批准当作新科学有效性证据。

以上为第10E步结束状态；以下为最新进度。

2026-10-21：第10F步完成正式工具发现、受控调用、持久审计和宿主stdio MCP。tool-approved-execution.mjs组合catalog/DB/正式包/原材料/报告，只暴露active/retained正式版本；调用前后绑定toolId/version/packageSha256/imageDigest。参数严格{input:普通JSON对象}、业务JSON65536字节，拒绝文件传输和协议字段；平台UUIDv4进入sirna-approved-tool-call/v1。未登记/损坏目录不能回退扫描。

复用tool-validation-runner的candidate执行内核，purpose=approved-call仅改变容器名/标签/事件，默认validation兼容；不跑基线/验证关卡、不改批准。仍核对真实镜像/source及非root/离线/只读/1GiB/64进程/tmp64MiB，CPU配额未施加。固定助手装入baseline惰性文本但不执行。每次独立容器、归属核对后清理；无自动重试。

tool-run-audit.mjs在runtime/approved-tool-runs/<toolName>/<UUID>写request.json和audit.json，sirna-approved-tool-audit/v1。请求刷盘后执行，终态先独占临时文件/fsync再不覆盖硬链接发布，0400单链接；正文只含摘要和元数据，不存原input/stdout/stderr。executionEvidence含容器ID/镜像/实际策略；cleanupConfirmed明确true/false/null，不能把未知当已清理。崩溃可能仅request/临时证据，不自动恢复；进行中取消等待受限执行清理，非即时中断保证。

新增apps/mcp/approved-server.mjs与scripts/approved-tools-mcp.mjs：显式discover回调，list/call都重新发现，名称冲突/损坏明确失败，正式调用实例内busy拒绝；成功只返回content，失败固定提示不回显宿主路径。MCP外层256KiB覆盖64KiB结果二次JSON编码。宿主入口仅Linux/hanwen/精确项目根/项目socket，不读凭据，npm tools:mcp仅人工入口；自动客户端直接Node脚本避免npm横幅。原guest apps/mcp/server.mjs和镜像/网页服务均未变。

真实stdio MCP两次输入：AACCGGTTAA→10/0.4，FASTA demo加GGCCAU→6/(2/3)。runId6e0cfeff-8c26-400f-acea-8658ac099848、0afd95d1-cfc2-4298-9e44-9fa0253d15fb，正式工具仍977b9593…@1.0.0/包4e259ca6…；输入输出摘要/实际策略/权限/容器移除独立核验。3个坏参数无运行目录。原材料/报告/目录/登记内容及10旧会话/3运行容器保持、health就绪空闲。2业务执行/0模型请求，无新镜像、迁移或重启。

新增24测试，942总数：Linux940通过/2Windows专属跳过，Windows930通过/12平台权限跳过，0失败；独立Task1/Task2/整体审查通过。证据runtime/approved-call-{acceptance,state-before,local-tests,linux-tests,sync}、approved-tool-runs；详细文件教学docs/19-正式工具发现调用与审计.md。验收脚本runtime/verify-approved-call.mjs会执行业务且独占写证据，不能当只读检查重复运行。

当前hostMcpCallable=true、webAgentCallable=false；管理CLI的agentCallable=false仍指网页未接线。下一步按原仓库/v1/agent-tools及/call连接guest远程MCP、任务上下文与工具列表刷新，再做真实网页调用并关联审计。不得给guest挂Docker socket/登记库，不声称已实现动态网页调用、版本替换/回滚或自进化。只改本学习项目/main，不改上级研究状态或agent_RSI_demo。

以上为第10F步历史；以下为当前状态。

2026-10-21：第10G步完成新网页任务远程正式工具链路。TaskCore传已登记taskId；AgentComposeRuntime在RPC前创建本轮agentTurnId/随机能力凭证，onStarted绑定真实agentRunId；pending仅允许发现。tool-call-leases按token和task/turn核验服务端身份，取消立即撤销新调用，已接受工具有界排空/审计/清理后才发终态。进程重启能力失效；不保证即时终止Docker业务。task-tool-context写工作区根隐藏文件0600，正常结束移除，不入提示/归档/Git；guest可读，不宣称对模型保密。审计可选taskContext含task/session/sandbox/turn/Compose run；业务toolCallId独立。管理metadata为agentCallable:null/callabilityChecked:false，不探测部署，不能作为实时可调用判断。

apps/api/agent-tools.mjs在专用UDS公开参考GET/v1/agent-tools、POST/:name/call，严格{arguments:{input}}、全服务busy、每次重新发现，成功只content。bootstrap仅在runtime/agent-tools/api.sock监听该入口，目录0700/socket0600，旧socket拒绝盲删。compose.yml新增agent-tools-relay，项目私网7420无publishedport，只读挂relay代码/专用socketdir，不挂Docker/登记/模型key；rootless0映射hanwen、rofs/capdropall/128MiB/32PID。网页仍127.0.0.1:3000。start脚本启动controller+relay；prepare检查新目录。只在空闲后重启本项目网页/重建controller刷新单文件bind配置，未改系统服务。

agent-compose.yml新identity sirna-pi-learning-approved-tools，guest pi1.2.0-mcp2 ImageID sha256:f2a4a04be99db5cf0508989e982d2b4c468753cc02fff8fa1b51af8e25dc8fa7。remote-server/client把正式工具转发至私网relay，固定领域算法仍local。approved-server可选2s列表通知；patch-mcp-refresh对锁定adapter2.11.0补通知/缓存/搜索/列表/未知回查，版本/全部锚点预检，MIT保留。真实guest无模型验证同MCP进程工具增加/调用/移除成功（fixtureCalls1，正式执行0）。旧project不迁移、不发新能力，describe明确approvedToolsAvailable=false，运行时提示新建任务。

网页验收task ea1eb12d-3aa9-44ad-b943-5e9f1ef966f5，session851c5872-cb9a-4967-a051-734c64eec9e0，sandbox0f54108530db060b12ac2e950486d757243cbfa36bdbccc8a9eef8d38cc038e2，Pi01a15a9a-c264-751b-87c8-78194b82c0c0。Compose run55dac5e39d98e19abfaefb4030517438350182c09cf93e6d6e7b1cceaf3cd1f8，toolCall7b77c97f-34ee-44c7-a52a-52404383de1c。输入AACCGGGUUUA→length11/gc5/11，6模型响应/6Pi操作/1正式执行业务；原toolId977b9593…/1.0.0/包SHA4e259ca6…未变。output/approved-summary.json46字节SHA91a08439329ea14c1af35f264a6cc6766a3afca042fce4aea1300adc7cfc1b2d，工作区/归档/HTTP一致，toolcontainer移除，guest已stopped/released，上下文能力文件移除。旧10会话字节/2guest/正式材料登记/凭据元数据保持；当前运行4容器为controller/relay/2旧guest。

Pi最后自由解释错误写C3/U2以及3+3=5，实际A3/C2/G3/U3；工具JSON/长度/GC正确。保留原回答，不追加模型请求遮盖；不得声称整段解释可靠、siRNA活性有效或自进化有效。

新增32项，974测试：Windows961通过/13跳过，Linux972通过/2跳过，均0失败；独立审查两P2（漏启relay、pending取消误判）已修复复核。冻结前并行poll-close一次失败，冻结后全套通过。后续网页/文件24项、metadata15项定向回归通过。脚本verify-compose-approved-tool.mjs <taskId> ended只读验收；verify-guest-approved-mcp.mjs只在专用无模型容器中运行。私有证据runtime/web-approved-{state-before,network,completed,ended,adapter-check,local-tests,linux-tests,sync}与截图；逐文件说明docs/20-网页调用正式工具与任务审计.md。

当前hostMcpCallable=true，新网页任务webAgentCallable=true。下一步沿原仓库完成parent版本关系、候选与原版比较、版本发布/切换及回退，再进入受控改进循环。文件传输、更多运行类型、自动工具构建/提案、长期多用户鉴权、崩溃恢复/孤立容器清理仍未实现。继续main同步，只改siRNA-pi，不改上级RSI项目和研究阶段。

以上为第10G步历史；以下为当前状态。

2026-10-21：第10H步完成parent改进提案及真实父源码比较。tool-proposals往返保留可选同名parent并纳入材料SHA，旧无parent包字节不变。tool-lifecycle新增assertRegisteredToolParent，严格读回已批准active/retained 1.0.0的包、源提案、验证报告及批准关系，要求baseline runtime/sourceSHA与其一致。已有同名正式工具的新提交必须带parent，在材料/登记写入前拒绝错误绑定。只支持首个父版本；readRegisteredToolVersion拒绝parent来源的正式包，防止递归读回循环。未迁移数据库，schema仍3；关系目前保存在manifest和报告，不称已添加registry parent列。

tool-validation-service运行前后解析完整parentComparison并比较toolId、包/镜像/源码等全部身份；结束时换成另一份自洽有效包也拒绝。正常报告读回重查材料和父绑定；passed=false且artifactIntegrityPassed=false的旧损坏材料诊断可读，不等于完整性认证。approve在任何写入前明确拒绝parent提案。原仓库只要求父关系存在，baseline可由提交者提供；我们额外绑定父源码，不能说原仓库已自动保证同样关系。baseline在固定验证基座中执行父源码，非直接执行父OCI镜像。

examples/05-parent-tool-proposal增加baseCounts A/C/G/T，沿用FASTA/空白清理、转大写及U→T。AACCGGGUUUA输出length11、gcFraction5/11、A3/C2/G3/T3；T包含原U，非原始RNA计数。baseline是example04的candidate源码，不是更弱的baseline。三个基准候选3/3、父源码1/3、净增2，后两项要求新字段；不表示旧GC计算错误、独立泛化、生物有效性或模型解释已修复。没有调用模型。

真实build d09c8565-156f-466e-927b-86810119b6f5，候选镜像sha256:c2a82b28889e5ccba46baa68647422614be1467c6e312ec2bced38c6ce94aa47；提案4530af22-d8d7-42f0-ac75-fec6ce851466、验证d998793a-5021-460a-9276-6d2adff6647c。提案包SHA73c8c245114ee3d2ef2dbc3c584add29693d73b2d9d149c87b937706119084af，报告SHA6c643791ecd07d4f13359a5811544d33d619932d4314e9dbe7f5954e1fab266e。parent及baseline源码SHA均3bb9f0ca3237100e9ceb7e182939ed731fc6a68b9f1c1251bf6ffb577193d8ac，独立逐字节核对通过。

候选当前verified，未approved/active，未产生1.0.1。网页继续使用原toolId977b9593…/1.0.0/包4e259ca6…/镜像e800a6bd…。4次构建业务、11次验证业务、2次语法检查完成，17个临时容器均移除。原9材料文件、全部旧registry行、catalog、11会话元数据、4运行容器和凭据元数据保持；只新增1提案/1验证/2事件。没有重启服务、系统改动或新正式工具调用。

新增21测试，总995：Windows982通过/13跳过，Linux993通过/2跳过，0失败。第一次错误裸node --test误扫ignored runtime历史/供应商测试，45失败日志保留；按package.json tests/*.test.mjs范围重跑通过，不为调用范围错误改产品代码/装依赖。Task1独立spec/quality审查通过。只读scripts/verify-parent-tool-proposal.mjs <提案UUID>可重复验收；runtime/parent-tool-ops.mjs的build/submit/validate为一次性实际写入，不重跑。私有parent-tool-{state-before,build,submit,validate,acceptance,local-tests,linux-tests,sync}保存证据，详细教学docs/21-父版本提案与真实基线比较.md。

下一步按原仓库实现多版本批准及切换/回退：保存parent版本关系、分配1.0.1、旧active转inactive并保留，完善事务及历史完整性读回后再切换目录。尚未完成自动提出/改写候选、自动批准、降级自动回退或自进化有效性验证。继续main同步，仅siRNA-pi；不要改上级agent_RSI_demo研究摘要或旧失败轨迹。

以上为第10H步历史；以下为当前状态。

2026-10-21：第10I步完成正式多版本发布、人工回退及恢复。schema4的tool_versions用toolId/version复合身份、同名唯一active，保留inactive/retained和parentToolId/parentVersion。显式迁移前VACUUM INTO一致备份，严格识别旧DDL；历史读回认证完整父链，限制64层（不是总共只能有64个版本）。新manifest.parent及版本父列为学习版额外追溯，不冒称原仓库完全一样。发布分配同toolId/major/minor的历史最大patch+1；重复批准inactive不激活。rollback可信CLI核对目标材料、事务切换、记录actor/reason/from/to、刷新目录，同active检查后不新增事件；未实现disabled/degraded/自动回退/镜像退休。

提案4530af22-d8d7-42f0-ac75-fec6ce851466已approved，工具977b9593-091a-4624-a4ba-b0c8f12b62df的1.0.1当前active，包SHAec49bc242af211202f21fa216c6576d7595bb315cabe0955aac07428082937ec，镜像仍c2a82b28…；旧1.0.0 inactive/retained，五文件包SHA4e259ca6…及镜像e800a6bd…未变。验证仍d998793a…/报告SHA6c643791…，源码/报告原字节保留。真实同一MCP客户端执行1.0.1→1.0.0→1.0.1三次：AACCGGGUUUA，新版11/5/11及A3C2G3T3、旧版无counts；审计版本/包/镜像/输出/实际隔离策略及容器移除通过。恰好三条新增发布/回退/回退事件；0模型、0构建、0重新验证，没有新网页Pi对话。网页后端在空闲时重启一次，11会话、4运行容器、旧任务和13材料保持。

初次Linux1021测试1018通过/1失败/2跳过：CLI守卫测试继承正式cwd，对当前1.0.0同版本rollback提前迁移schema4并重写catalog。原四表所有字段值保持、新增父列null、0事件/0业务，schema3备份registry.sqlite.v3-backup-7e636199-8bcd-491f-888e-89d7ef26ddb4.sqlite与原行一致；影响核查runtime/version-release-early-migration-check.json。测试现固定临时cwd，禁止重新引入部署目录继承。独立审查修复历史reader允许inactive后执行边界漏检active、prospective孩子未计入64层预算两问题；发布前和事务内重查深度，零执行/零写入负例通过。最终1023测试：Windows1010通过/13跳过、Linux1021通过/2跳过，0失败，Task1独立复审3/3通过。原失败日志保留。

当前只读验收node scripts/verify-tool-version-release.mjs，检查本轮固定最终状态；未来发布后旧固定状态验收可能不再适用。第10H验收要求旧verified/active1.0.0，发布后不可继续要求它通过，不重写旧证据。私有runtime/version-release-{state-before,exercise,acceptance,restart,early-migration-check}及三个call文件保存本轮证据；新学习说明docs/22-工具版本发布与人工回退.md。文件系统/SQLite/catalog不是全局原子事务，已提交后catalog失败要显式catalog-rebuild；维护仍要求空闲，执行前后检查不等于所有进程共享原子锁。

下一步对照原仓库tool-curation协调器与tool-builder，学习由Agent发起工具构建/候选提交，并保留人的批准边界。尚无自动提出/修改/循环改进、自动降级或科研有效性证明。继续个人main同步，唯一远端目录不变，不改上级RSI项目。

以上为第10I步历史；以下为当前状态。

2026-10-21：第10J步完成六个原名构建/提案工具的独立宿主stdio MCP。tool-build-sessions.mjs管理本实例UUIDv4会话，5分钟闲置TTL、最多4占用资源/32总会话，忙碌拒绝，关闭/EOF/SIGTERM排空清理。未知创建/清理结果明确记录并占容量，不猜容器ID，不自动孤立容器清理或进程重启恢复。write只允许/opt/tool/main.mjs、有效UTF-8且≤200000字节；run字符串≤20000字节、100..30000ms，默认10秒，非root65534执行、合并输出≤65536字节。超时/传输/超限终止会话，非0退出仍可修改。受控root helper只写root持有的申报源码；任意命令不以root执行。

finalize要求写入后成功调试，但不等于独立验证。先停止移除可变容器，再在固定底座的新容器只写申报源码，语法/摘要核对、停止后commit并检查身份。显式单源码洁净打包子集，不等同原仓库可安装依赖/保存任意rootfs。复用tool-build-service.mjs的frozen helper，不改变旧CLI行为。propose必须同实例真实artifact、源码逐字匹配、合同/parent合法；只复用原登记服务写submitted，无验证/批准。相同finalize/propose保持同一身份；冲突或不确定失败禁止盲目重复。登记actor仍local-cli兼容标签，构建session/proposal关联在私有日志，尚无网页task身份。

真实session24b84fa1-4091-4fed-80f1-a2cbb0d02976，提案f94f2783-6dd5-4dfe-b725-3efd24764cc2，工具summarize_numeric_values仅submitted。镜像sha256:ef051b2a755d16a5b30d4ae7bc2a811449fb403857383f07ebbde7a684152e7c；提案包SHA9307b48a4507472f87239aa925920013483ab5a5b4c5922717f6e1ace11694a4；源码SHA52007e56223c16bf91ae3a495c8cba11e80d805c83ea7a32e8622057d026b406。同一MCP14调用含5负例，调试[2,4,6]→3/12/4，独立成品[-2,2]→2/0/0。检查成品时无tmpfs遮挡，源码SHA匹配且debug marker不存在。5临时容器全部移除、恰好1镜像保留，原镜像集合不减；第二会话0a2125fd-17eb-4d2c-a7a0-450db33b3d35已取消。新增1proposal/1event、0validation/versions/正式调用，原active1.0.1不变。旧18材料/12审计/11会话/4运行容器及任务表/目录/凭据元数据保持。模型0，不重启服务，不改系统。

新增18测试，Windows全套1041：1028pass/13skip；Linux初次1037pass/2fail/2skip，两新测试after hook删除只读临时材料EACCES，正文已通过。仅测试夹具增加限定os.tmpdir直接子根、前缀/realpath检查、不跟随链接及解锁清理；产品权限未改。修正后Windows18定向全通过、Linux47相关全通过；最终Linux1041项1039pass/2skip，0fail。初次日志与两失败临时目录保留。聚焦检查后私有spawnSync收尾复用过期HTTP连接失败，独立只读重查确认服务/旧状态正常，健康请求改Connection:close，最终回归及保留检查通过。Task1独立审查通过，Task2操作复审通过；异常诊断落盘、stderr受控处理、同步tar覆盖前核对均修正。只读scripts/verify-agent-tool-builder.mjs验收已通过。

最新教学docs/23-Agent构建工具与提交候选.md，例子examples/06-agent-tool-build是人为样例，故意mean=0基线未执行，不称强基线或性能结果。私有runtime/agent-builder-{state-before,exercise,acceptance,fresh-run,inspection,linux-tests,linux-final}及runtime/tool-builds/<sessionId>保存证据；一次性exercise不可当只读检查重跑。10I固定旧proposal数量的检查不再适用，不修改旧历史证据。当前正式工具网页链路仍可用，但新构建MCP尚未接Pi/网页/Curator。下一步按原远程控制端接任务归属/凭证与构建会话，真实Pi验收后再接Curator；无自动提议/改写/独立验证/批准/自进化有效性。继续个人main同步，唯一远端目录不变，只改siRNA-pi。

以上为第10J步历史；以下为当前状态。

2026-10-21：第10K步接通网页Pi六构建工具。保留原build-sessions与tool-proposals路径/参数分工，个人版由既有UDS后台及relay承接控制职责，尚未拆原独立controller；原代码没有的每轮owner认证是个人增强。tool-builder-client只固定请求、不重放；tool-build-api读body前后认证，拒绝模型owner；task-tool-builders通过lease.ownResource每轮懒建service。关闭先撤销/排空再清理，确认后释放单网页owner槽，未知清理占用；身份文件finally移除。每service4live/32total，CLI实例不共享此全局槽；会话不跨轮，进程崩溃恢复未做。Node单源码、无依赖/网络、非root调试/洁净打包及人工批准仍保持。builderHTTP请求1MiB/响应300000B/client300s/relay310s，实际pi-mcp-adapter2.11.0显式builder配置320s；MCP最终262144B上限仍在，转义膨胀可被末层拒绝。正式工具HTTP合同/30s保持。

新guest sirna-pi-guest:pi1.2.0-mcp3，image sha256:e1132518f9a32c36ead10668419adb8399f5cf9a1885c096290f8ee7fa6f4ca0，project sirna-pi-learning-tool-builder；真实导入通过，无凭据/宿主builder代码。空闲重建项目controller/relay并重启后台，两旧guest/镜像保留，无系统/root操作。Linux全套1057：1055通过/2平台跳过；Windows主实现1056：1043通过/13跳过，公开错误说明修正后29相关全通过。最初SSH PATH引用错误在测试前导致sh ENOENT，修正后才运行Linux全套；Windows夹具RPC事件/DB收尾问题诊断后修正，三临时目录受限清理，正常测试通过。独立Task1审查无Critical/Important，Minor公开错误修正后部署。

真实网页task506ee4db-d6c6-4a8c-b1ab-d9bd5b26cb52、execution25c3e1e1-c18e-49f4-a8a4-11d708bf9e29、run08850a24695c4c625a4f360d28686c95c411f603b7e3fd7f6978fac73a3e3742。16模型响应/19Pi工具，8构建业务全部成功；另2次describe对象而非字符串失败后自行纠正，最终文字“无失败”不准确。usage总82081tokens，SDKcost0不当免费，实际账单未知。人为提供examples/07源码，debug[6,2,4]→3/2/6/4；A4022b31c-bc5a-45da-ac15-909a72445ee1冻结，B6a9350df-ca95-4f37-9d51-3a658ff70491取消，C9d7857a4-709c-4e4b-bd4b-afede80c0767自动close_cleanup。4临时容器已移除；网页结束后新guest释放，文件工作区/归档/下载字节一致。

候选26883ce8-5c2e-4a0e-90fb-d96e53270b9c summarize_numeric_range仅submitted，image45b87208b560b36d8424cba95bebf0a4e3f1981c49efbf1d659aba02354bccf1、source e91e65dcea8747c0b3698faaec9223c6871585f3386e5c99fde344b8a8f405af、package b57eb4bd612e32f26a7287d3867feeb99fb4835823b831a3350364f0bbc18729。所有构建事件/冻结/提交关联有5项可信owner，登记actor web-agent。+1proposal/+1event、0validation/versions；旧21材料/12审计/11会话/2guest、旧任务/登记行、catalog/凭据元数据保持，原active1.0.1。两份数值候选都未独立验证/批准；本次未单独执行成品基准，不声称自进化或自主发现。

最新docs/24-网页Agent构建工具与任务归属.md；只读复核node scripts/verify-web-tool-builder.mjs 506ee4db-d6c6-4a8c-b1ab-d9bd5b26cb52 ended，依赖私有runtime/web-builder-state-before.json且固定当前总数。10J旧总数检查不再适用，保留历史。runtime/web-builder-{completed,ended,linux-01-result,build,recreate,restart}保存证据；同步提交回执留runtime，勿提交敏感/生成目录。下一步按原tool-curation/Curator协调候选、独立验证、失败反馈及人工批准，暂不自动发布或无限循环。个人main持续同步，唯一远端目录不变，不改父级RSI项目。
