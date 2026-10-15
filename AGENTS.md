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
