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
- 本阶段仅开放原生 read/write，关闭扩展、MCP 和自动资源发现；CLI/SDK 命令行练习仍用内存会话，网页使用项目内 Pi 持久化会话。这不是操作系统级沙箱。
- 网页入口为 npm run web → apps/api/bootstrap.mjs，只监听 127.0.0.1:3000，经 SSH 隧道访问。先 POST /v1/tasks 创建，再 POST /v1/tasks/:id/messages 发送；不要恢复成旧的一次性合并接口。
- 网页历史保存在 runtime/tasks/tasks.sqlite；Pi 上下文位于 runtime/pi-web/sessions；执行元数据位于 runtime/task-sessions。每项任务沿用 workspaces/web/<executionSessionId>，日志按 runtime/web/<executionSessionId>.<runId>.events.jsonl 分开。网页 read/write 不能越过任务目录，不称为容器沙箱。
- 通用 SDK 调用位于 packages/agent-runtime/pi-sdk.mjs；scripts/pi-sdk.mjs 保留命令行入口。网页支持多轮、SSE、历史恢复，尚无停止按钮。SSE 的 done 后还要保存消息并发出 task_saved；连接断开不能取消已接受任务，正常关闭服务也须等待后台任务落盘。
- 当前网页统计检查：npm run verify:web-task -- <executionSessionId> --run <runId>；旧命令 --web <UUID> 仅用于原第 3 步历史样例。

## 当前阶段

2026-10-15：已完成第 4 步的任务流程对齐，采用 apps/api、packages/task-core、packages/agent-runtime、public 的职责目录。真实网页第一轮统计任务通过独立验收（4 次模型响应、3 次工具调用）；重启网页服务后在同一任务追问，Pi 保持同一会话编号并正确回忆前文标记（1 次模型响应、0 次工具调用）。原 CLI/SDK/旧网页证据仍通过检查。完整记录见 docs/05-对齐原仓库任务架构.md。尚未部署 Agent Compose、任务容器、停止功能或自进化。

下一步先沿 docs/05-对齐原仓库任务架构.md 理解当前请求和保存链路，再按原仓库接入正式 Agent Compose 与任务容器。只读预检发现 hanwen 无 Docker socket 权限，尚无 agent-compose 命令；容器阶段须解决权限和状态目录前提，不擅自修改系统用户组或项目外配置。服务器直接访问私有 GitHub 的认证尚未配置，继续通过本地 GitHub 授权与项目内 Git bundle 同步。

2026-10-17：用户确认系统安装并提供管理员认证，已安装 uidmap 1:4.8.1-2ubuntu2.2，升级/删除为零。项目 rootless Docker 28.3.0 已由 hanwen 启动，固定摘要的官方 hello-world 容器运行成功，退出码 0，测试容器已自动清理。详见 docs/06-Docker运行环境.md。

Docker 使用脚本 scripts/project-docker.sh 显式连接 runtime/docker/run/docker.sock；不要让命令回落到共享 /var/run/docker.sock。启动入口 scripts/start-project-docker.sh，配置 config/docker/daemon.json，状态均在 runtime/docker；外层目录 0700，Docker 数据子目录允许其原生的 0710。已有 PID/socket/RootlessKit 状态时拒绝启动，不盲目清理；尚未配置开机自启。实际 cgroup 为 systemd/v2，内存和进程数限制被 Docker 报告为可用并由测试容器接受，CPU 配额不可用。下一步接入 Agent Compose 控制服务及 guest，当前网页仍为 local-pi。后续新系统权限/服务变更继续按用户要求确认，不把这次 uidmap 授权扩大到其他系统操作。

2026-10-18：Agent Compose v2609.3.0 控制服务已健康运行，127.0.0.1:7410；配置 compose.yml / agent-compose.yml，入口 scripts/start-project-agent-compose.sh、project-agent-compose.sh。项目独立管理 token 位于 runtime/agent-compose/control.env（0600，不显示或提交），与模型 key 分开；CLI 在管理容器内经 Unix socket 连接，HTTP 管理请求要求 token。不要输出 Docker Compose 完整解析配置或控制容器完整 inspect，以免显示 token；配置检查用 config --quiet。

已用 scripts/verify-agent-compose-workspace.mjs 完成真实无模型命令验收：创建 guest、运行成功、文件挂载与网络核对、宿主/guest 未登录请求均 401、停止后资源 released 且文件保留。证据 runtime/agent-compose/verify-RaHJj9；日期分层路径从 inspect.workspace_path 读取。默认 guest 实际无内存/进程/CPU 配额。官方 guest 内置 Pi 0.82.1，本轮未启动它；不能据此声称个人 Pi 1.2.0 容器接通。AGENT_COMPOSE_RUNTIME_BASE_URL 本轮刻意留空，避免模型代理准备读取凭据；后续真实模型阶段才配置可访问回调和模型配置。

当前下一步：制作并验证 Pi 1.2.0 定制 guest 与 MiniMax，再接网页 Agent Compose 运行时。现有网页仍 local-pi / taskContainers=false，49 项离线测试通过；本轮不修改研究阶段。完整解释和已验证边界见 docs/07-AgentCompose与任务环境.md。大镜像直连下载失败后采用官方摘要校验的本机归档传输，归档保留 runtime/image-transfer，不配置系统代理。
