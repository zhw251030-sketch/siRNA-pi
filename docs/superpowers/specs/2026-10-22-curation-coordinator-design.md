# 第11E步：有界自动观察与候选冷却

## 目标与来源

用户继续授权按参考仓库逐步重建并在完成后逐文件讲解。基线为个人main的e1c605ea32c13c940d05bca923b714139da175b1；参考67d2754只读。上一轮已有明确缺口报告、冻结证据、人工Curator与人工Builder交接。本步连接任务收尾通知→自动送审，并实现原版七天候选去重。

原版task-message-service.ts的onSettled在清除active后通知；router.ts排除auto-tool-curation-build来源；coordinator.ts在完整轮次结束后请求审查，在模型返回candidate后查最近七天同能力candidate并改为skip。七天规则不节省已经发生的模型请求。原版自动Builder、Goal在线限制与验证后回调不在本步；学习仓库尚无对应Goal模块。

采用事件通知加一秒有界队列协调，复用既有串行Curator服务，不创建另一套模型执行器。独立后台全历史扫描会重新处理旧任务；直接在done事件中调用会早于文件/消息保存，因此两者不采用。启用状态使用进程内显式开关，默认关闭；首次部署不启动真实模型验收。

## 约束

- 只改个人siRNA-pi/main，不建分支/工作树；远端唯一根/home/hanwen/Project/project/siNRA-pi。参考及其他研究项目只读。
- 0真实模型请求；测试只在独立临时目录用真实存储/API和确定性模型边界。生产不插入合成任务、报告或候选。
- 新功能不会自动Builder交接、验证、批准、重试模型或恢复未知结果。已有Curator运行仍是单响应、180秒截止、无工具、零重试。
- 不改旧SQLite schema、旧预览摘要、旧冻结记录与guest镜像；候选冷却只作用于新完成的审查。所有编辑apply_patch。
- 自动审查默认关闭；每次服务启动累计最多3次自动送审尝试，关闭再开启不补额度，重启后仍关闭且不回扫旧轮次。手动审查使用既有独立入口，不计自动额度，界面明确说明。

## 核心接口与行为

新文件packages/extensions/tool-curation/tool-curation-coordinator.mjs导出createToolCurationCoordinator({taskStore,preview,curation,isReady,isTaskBusy=()=>false,intervalMs=1000,maxReviews=3})，maxReviews为内部配置整数1..10，不通过HTTP任意改大。返回start()/stop():Promise<void>/configure({enabled:boolean})/status()/observeRun({taskId,runId,userMessageId,requestId?})/runOnce():Promise<void>。start幂等不重置次数；stop同步禁止新观察和派发、清空未送审队列并等待正在进行的readiness/request操作退出。允许已接受Curator工作由原服务排空。

审查补充：isReady完成后的Promise交接仍可能插入上传/取消/结束预约；协调器在await返回并重检task之后，通过同步isTaskBusy(taskId)再核对同一TaskMessageService的预约表。true保留队列且不花次数，异常关闭自动准入；此检查到preview/find/预留/调用request之间没有await。生产必须注入此同步桥，单独重复await readiness无法关闭这个窗口。

status固定protocolVersion=sirna-tool-curation-automation/v1，返回started、enabled、maxReviews、attempts、remaining、pending、reason以及最多20项recent记录。reason使用固定枚举disabled/enabled/budget_exhausted/capacity_exhausted/unavailable/stopped；recent仅保存taskId/runId/userMessageId、state、reason、可选curationId，禁止正文/原始错误/凭据。record state为queued/ignored/deduplicated/admitted/error，reason用固定安全短标签。状态克隆返回，不暴露内部可变集合。

configure只接受一个自有布尔enabled字段，服务未start/已stop时503；启用且额度耗尽时409。重复开启不重置额度，关闭后再开启仍使用同一剩余额度。关闭立即使await中的readiness失效，未接受项不得随后派发；已经接受的Curator不取消、不重发。服务重启丢失临时观察状态是明确边界，持久Curator记录照常可读。

observeRun同步接收已保存轮次通知，校验UUID task/user与既有UUID或64hex run，拒绝来源为auto-tool-curation-build:的requestId（不形成自激循环）。仅启用期间的新通知进入队列；每进程最多记住256个task/run去重键、同时最多32待处理项，容量耗尽明确关闭并记录原因，不静默淘汰后重发。旧历史不扫描，重复通知不重复送审。可微任务唤醒runOnce，同时用一秒unref定时器处理暂不ready项；runOnce互斥，同次tick不并行消费。

派发依次检查真实任务当前run/user匹配、非running/stopped，等待isReady(task)；await后重检开关generation、task/run/user及readiness相关状态，再读取完整preview。isReady false则暂留队列；抛错关闭自动准入并给安全unavailable状态。新轮次替代旧轮或任务停止时移除旧通知。无合格完整信号/报告记ignored，不消耗额度。已存在相同curation记deduplicated，不消耗额度。新请求前同步预留1次尝试，然后调用curation.request(taskId,{runId,sourceSha256,previewSha256},{automatic:true})；即使请求拒绝也不退额度且不重试该轮，异常关闭后续自动准入。手动与自动竞争时既有task/run唯一性保证最多一个审查；若竞争导致重复，已预留尝试保守计数，不冒充实际模型次数。达到额度时关闭自动观察并清空未派发项。

ToolCurationService新增可选cooldownMs=0、clock=Date.now；生产明确传604800000，旧未配置消费者行为不变。request的第三个内部选项automatic默认false，不改变公开HTTP binding。自动审查若完整触发signal.errorCount>0或有gap则online_gap，否则post_run。buildToolCurationTrace可接可选trigger覆盖并校验枚举/最终64KiB及摘要，默认保持旧字节。

ToolCurationStore新增findRecentCandidate(capabilityKey,{excludeId,since,until})，在全部持久candidate中查，不使用list的100条展示窗口；只返回其他ID、相同精确能力键、completedAt在含边界时间区间内的完整记录。使用既有schema查询，不迁移。返回记录的trace/result绑定要在采用前验证，损坏记录不能被当作没有重复而继续。未来时间记录不视为近期，是比原版更严格的本地边界。

串行consume中先核验模型身份、清理与结构，再查近期candidate，最后complete，中间无await。命中时生成标准skip结果，summary明确“后端冷却规则”及原candidate ID，不能说模型自行skip；原response.result对象不修改。原模型回答继续保留在既有Curator私有事件/原生会话，不新增另一套结果schema。重复skip不延长冷却；不同能力或期外候选仍candidate。手动和自动完成的新审查均适用同一生产冷却规则。

## 通知、HTTP和界面

TaskMessageService构造增加onSettled可选callback，在#execute结束且#active清除后，仅对已保存assistantMessage的真实轮次通知一次，内容使用当次返回的finalRunId/userMessage.id/requestId，不读取可变currentRunId冒充旧轮。observer同步抛错或Promise拒绝均不改变已保存结果；deduplicated重发与保存失败不通知。增加isTaskBusy(taskId)检查active/cancel/end/upload及任务running/stopped，供bootstrap readiness调用。

bootstrap注入同一个taskMessages实例和coordinator：onSettled闭包只入队；isReady检查任务生命周期空闲及agentRuntime.describe为agent-compose、assertWorkspaceIdle成功。服务生命周期在Curator启动之后、HTTP真正listening时start coordinator；shutdown先同步stop coordinator，再排空原任务/审查后关闭存储。

GET/POST /v1/tool-curation-automation，查询参数拒绝，POST只接受{enabled:boolean}且上限1024字节，现有Host/Origin边界保留；未配置503，错误安全，不返回原始异常。GET返回{automation:status}，POST同形200，不能填prompt、额度或工具权限。

public/curation-automation.mjs独立面板（index.html增加容器和导航，app.js装配），明确开启会消耗模型额度、服务启动最多3次、切换不补额度、重启默认关闭、仅新结束轮次、Builder/批准仍人工、冷却发生在模型回答之后。提供读状态/开启/关闭；无自动POST、自动重试或浏览器轮询，状态只初读或显式刷新。纯文本显示recent/错误；并发按钮禁用，旧GET不得覆盖新POST结果，未知POST需重新读状态才开放下一操作。最近admitted只表示送审，审查结果仍通过既有任务线索/记录查看。

## 验收

真实TaskStore/GapStore/Curations夹具验证：save→settled→观察→一次请求→候选、第二任务同能力→后台skip、无自激Builder、关停竞争、手动竞争、次数与队列边界、重启不回扫、原始回答不变、旧无gap摘要。HTTP精确body/同源/安全错误，UI开关/过期响应/未知POST。Linux最终完整套件；隔离浏览器走新开关与自动候选/冷却，0真实模型。生产默认off、0新业务记录、七旧DB schema/行、旧证据/catalog/容器镜像保全；只重启空闲API。最终main提交、GitHub推送、项目内bundle同步及三端核验。
