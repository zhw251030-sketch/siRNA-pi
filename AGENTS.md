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
