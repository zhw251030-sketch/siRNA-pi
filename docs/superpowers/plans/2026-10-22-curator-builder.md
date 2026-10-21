# Curator → Builder Implementation Plan

Spec: `docs/superpowers/specs/2026-10-22-curator-builder-design.md`

## Global Constraints

个人 siRNA-pi/main，基线 d7e2576；参考67d2754只读。远端唯一根 /home/hanwen/Project/project/siNRA-pi。禁止新分支、模型调用/生产伪造记录、自动批准、秘密输出；根代理负责远端和提交同步。所有编辑 apply_patch。新增能力先 RED 后 GREEN；测试真实边界，不只断言 mocks。

### Task 1: Durable handoff and trusted proposal association

读取 Spec。创建 `packages/extensions/tool-curation/tool-curation-build-{contract,prompt,store,service}.mjs`（可合并职责很小的 contract/prompt，不为拆分而拆分），测试 `test/tool-curation-build*.test.mjs`。需要时适配 capability-platform 的 task-tool-builders、tool-build-sessions、tool-lifecycle、tool-registry、tool-proposal-source；不得编辑 apps/public/docs。

导出 `ToolCurationBuildStore({root,readOnly=false})`，以及 `createToolCurationBuildService({root,store,curationStore,taskStore,taskMessages,agentRuntime,listExistingTools})`，服务 `.view(taskId,curationId)` 和 `.start(taskId,curationId,binding)` 异步、`.registration(input,context)` 同步、`.recover()`/`.stop()`；`.active(taskId)` 若生命周期协调需要。GET 等待只读 runtime.describe 核验实际后端与 Builder 能力，返回 spec 格式，reason 稳定短码，额外 reason 文案由 UI 映射。所有错误用安全 statusCode 与固定消息。

curationRegistrationPolicy 独立参数逐层传递；repair registrationPolicy 原行为保持。registry 增 curation event 字段和事务内票据唯一检查，无需改旧 schema/行；getToolProposalSource 返回 curation|null，可追溯材料/事件。策略注册必须核当前消息、来源、terminal事件、固定冻结提示；构建工具的重复读回只能返回原已注册结果。异常不能使下一次点击启动第二轮。

数据库路径/旁文件拒绝 symlink/hardlink，识别 schema，冻结字段不可变，读回验摘要。view 对存在票据即使任务已停止仍展示历史与链接。未知结果不重发，不拿 stale currentRunId 误归属。排空跟踪 completion 要在任何后续落库操作前建立。TaskMessageService 的持久消息顺序/终态用于确认，而非模型文字自报。一个 ticket 最多一个 proposal，不自动验证。

RED/GREEN 覆盖 spec 主要行为，以及候选提示注入不改变权限、同一 curation 并发、停止/重启、登记后读回不明、第二个 build session 重复登记。隔离端到端验收用真实 Store/TaskMessageService/registry 和确定性 runtime，禁止往生产插入 fixture。原修订注册的相关用例回归。

报告 `.superpowers/sdd/2026-10-22-curator-builder/task-1-report.md`，包含命令/结果/失败先证据、实际接口和限制。不要提交/推送/远端/模型/派生子代理。

### Task 2: API, lifecycle and browser integration

读取 Spec 和 Task 1 报告的已实现接口。编辑 `apps/api/{bootstrap,server,shutdown}.mjs`（按实际文件名）及 `public/curation.mjs` 等实际页面连接和对应测试；不要修改 Task 1 核心文件，问题报根代理处理。

GET/POST spec 路由、严格 body 与 task/curation UUID、回环/origin防护沿用现有服务。普通消息入口拒绝保留的 auto-tool-curation-build 请求 namespace。bootstrap 注入独立 curationRegistrationPolicy；只在取得端口 owner 后 recover；关闭停止接收、排空 handoff 与正常 taskMessages、关闭其 DB，错误不跳过其他关闭。不要自动复派。

UI 放在 Curator 候选详情内。显示构建前说明/可用性/固定提示，按钮“交给 Builder（调用模型）”，已交接则显示状态和固定链接。POST 未确认后禁止重复点击，GET 能读取原记录。非candidate 不可派发，过期响应不修改别的任务。沿用现有 history navigation 和工具提案链接，不自造 URL。不要轮询或自动派发。

RED/GREEN 路由/生命周期/UI 相关行为，重跑已有 curation/repair/task消息相关测试。报告 `.superpowers/sdd/2026-10-22-curator-builder/task-2-report.md`。不要提交/推送/远端/模型/子代理。

### Task 3: Verify, deploy, teach and sync

根代理：两项审查后运行适当检查；仅项目内分阶段传输/部署。冻结旧五业务DB和旧文件/container/catalog，验证无旧记录损失。生产 API 无candidate 应显示/拒绝正常；隔离验收候选路径明确为模拟。完整教学 docs/31（文件、输入输出、前后变化、原版对照、测试/未完成），更新 README/AGENTS/学习路线/MODULE。只 main 提交推送并安全 bundle 同步；三处 clean/hash一致。
