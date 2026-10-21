# Curation Coordinator Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development with task-scoped review and final review.

**Goal:** 接通新结束轮次的有界自动审查与七天候选去重，保留人工Builder和批准。
**Architecture:** 进程内显式开关/有界观察队列复用持久Curator；任务保存后事件通知，完成路径做候选冷却；独立HTTP/UI状态面板。
**Tech Stack:** Node24、SQLite、原生HTTP、Pi/Agent Compose已有执行器。
**Spec:** docs/superpowers/specs/2026-10-22-curation-coordinator-design.md

## Global Constraints

只改个人siRNA-pi/main，基线e1c605ea32c13c940d05bca923b714139da175b1；参考67d2754只读。远端唯一根/home/hanwen/Project/project/siNRA-pi。0真实模型请求；不向生产插入合成任务/报告/候选，不自动Builder、验证或批准。不读输出密钥，不改旧SQLite schema/预览摘要/旧记录/镜像。所有编辑apply_patch。root独占远端、最终完整测试、文档和提交同步；子代理不提交、不操作远端、不派生代理。

### Task 1: Bounded coordinator and candidate cooldown

Files: create packages/extensions/tool-curation/tool-curation-coordinator.mjs; modify tool-curation-service.mjs、tool-curation-store.mjs、tool-curation-evidence.mjs in same directory; create tests/curation-coordinator.test.mjs and tests/curation-cooldown.test.mjs. Existing helper tests/helpers/tool-gap-fixture.mjs可读复用，不修改Task2文件或生产文档。

Interfaces: implement spec exact coordinator constructor/status/commands, request third argument {automatic:true}, optional service cooldownMs/clock and store.findRecentCandidate. Cooldown zero default, production604800000 supplied byTask2. Task2 supplies onSettled event and readiness; use exacttask/user/run checks. All source/API limits and safe statuses use Spec values. No newSQLite/file ledger required fortemporaryobservations; raw model response retained existing runtime logs, standardfinalskip explicitlybackendpolicy.

- [x] RED: 写真实store夹具证明默认off不派发，开启后gap-only或完整重复轮只生成一个审查，重复notify/手动竞争不产生第二条，自动失败信号trigger=online_gap而成功重复=post_run，Builder保留requestId忽略。
```js
coordinator.start();coordinator.observeRun(event);await coordinator.runOnce();
assert.equal(curations.list(task.id).length,0);
coordinator.configure({enabled:true});coordinator.observeRun(event);await coordinator.runOnce();
assert.equal(curations.list(task.id).length,1);
```
- [x] GREEN: 实现singleflight队列、post-await重检和generation失效；构造真实新task/run进行budget3耗尽、切换不重置、freshinstance关闭/不回扫、32pending/256seen容量边界。只替代外部readiness/模型边界，不替代真实保存去重。
```js
assert.equal(coordinator.status().attempts,3);
assert.equal(coordinator.status().remaining,0);
assert.throws(()=>coordinator.configure({enabled:true}),e=>e.statusCode===409);
```
- [x] RED/GREEN: readiness延迟期间关停/换轮/任务停止均不新请求，invalidpreview不计次数；request未知失败不重试并关闭；stop等待已经进入的readiness退出而不派发，timer不泄漏，recent仅20且返回值修改不改变内部状态。
- [x] RED/GREEN: 两真实不同task同capability候选第二个skipped且summary明确后端；原response对象不变，原候选ID可查；不同capability/超过7天/等于边界/未来时间与损坏记录正确。超过100展示记录仍查到近期candidate；skip不延长冷却；未配置cooldown旧行为和旧无gap摘要保持。
```js
assert.equal(second.status,'skipped');
assert.equal(second.result.decision,'skip');
assert.match(second.result.summary,new RegExp(first.id));
assert.equal(modelResult.decision,'candidate');
```
- [x] 运行聚焦测试RED→GREEN及相关curation-review/store/build回归一次，保存实际命令/结果到task-1-report.md。检查diff，只交付自己的文件，root审查后统一提交。

### Task 2: Settled hook, lifecycle, HTTP and UI

Files: modify packages/task-core/task-message-service.mjs、apps/api/bootstrap.mjs、apps/api/service-lifecycle.mjs、apps/api/router.mjs、public/app.js、public/index.html; create public/curation-automation.mjs; create tests/curation-coordinator-integration.test.mjs、tests/curation-automation-ui.test.mjs. Only if app import changed breaks existing VM harness, modify its real injection, never weaken assertions. 不修改Task1文件。

Interfaces: Spec coordinator methods/status fixed; createAppServer/startApiServices/createApiShutdown receive optionaltoolCurationCoordinator. Bootstrap生产maxReviews3/interval1000/cooldown604800000，onSettled closure and readiness supplied. New GET/POST /v1/tool-curation-automation use sameOrigin and boundedexactJSON. TaskMessageService callback afteractivecleared anddurablesave, observer cannotchangeoutcome; isTaskBusy protects active/cancel/end/upload/running/stopped.

- [x] RED: 真实TaskStore/TaskMessageService+runtime boundary证明文件collect与assistant保存/active清除先于observer；callback读得到最终消息且isTaskBusy=false，准确旧finalRunId，deduplicated无二次notify、保存失败无notify、sync throw/async reject不影响原成功。
```js
const turn=await messages.start(input,()=>{});await turn.completion;
assert.equal(notifications.length,1);
assert.equal(notifications[0].runId,actualRunId);
assert.equal(tasks.listMessages(task.id).length,2);
```
- [x] GREEN: 接hook/bootstrap及服务生命周期，listening之后才start；stop在任何异步drain前停止自动准入，所有store/rpc仍finally关闭。测试delayedreadiness+shutdown不dispatch；正常task completion→真实coordinator→真实curationstore一次候选，未知review失败无重试。
- [x] RED/GREEN HTTP: 精确GET/POST状态、未配置503、query/未知字段/非boolean400、body超限413、foreignorigin403，重复enable/disable不重置counter；无任意额度/prompt入口，安全错误无host/key文本。
```js
assert.equal((await post({enabled:true,limit:999})).status,400);
assert.equal((await get()).automation.enabled,false);
```
- [x] RED/GREEN UI: 独立factory createCurationAutomationPanel({root,fetcher=fetch})，支持refresh，展示全局off/3remaining、开启/关闭/耗尽、最近结果、无自动POST；过期GET不能覆盖POST，失败POST强制重新读取，按钮不重复送。文字明确过程/次数/冷却/人工边界。app仅装配实际module，index新增自动审查面板及导航。
- [x] 用真实HTTP/storage测试接线，外部模型/Docker只用确定性边界；跑相关task/web/lifecycle/UI回归一次，保存RED/GREEN命令和结果到task-2-report.md。Task1未到位时可测试hook/API/UI，不伪造最终集成通过；root审查统一提交。

### Task 3: Deployment, verification and teaching

root准备七旧DB/证据/镜像/容器状态保全，隔离浏览器夹具使用真实TaskMessageService/coordinator/Curations+固定回答走自动送审、跨任务冷却和关闭，0模型。源稳定后Linux全套，修复才重复相关/完整测试。仅空闲API重启，不重建guest或管理容器，生产off/remaining3与旧记录保全。保存docs/33、README/AGENTS/学习路线/MODULE准确实际结果及差异。任务审查+最终独立审查通过后，main提交/推送、精确LFbundle同步、三端清洁同SHA。私有证据忽略保留。

## Execution record

Task1/2完成，报告保留于当前计划的私有SDD目录。新增同步isTaskBusy桥关闭readiness返回到实际准入之间的微任务窗口，upload/cancel/end真实预约RED3fail→GREEN，任务复审与最终整合审查通过。

最终Linux84files/1459tests/1457pass/2Windows-onlyskip/0fail/0cancel，501.99秒；16个源/测试文件与该次测试传输清单逐个SHA-256相同。最终隔离浏览器两任务→candidate/skipped，原始固定回答均candidate，0真实模型/Builder，两个夹具已关闭且证据保留。

生产API空闲重启PID1914941，默认off/0of3；七旧DB schema/行、旧证据/会话/catalog/所有容器镜像/凭据元数据保持。生产16tasks/0gap/0curation/0handoff。README、AGENTS、MODULE、路线与docs33已更新；最终main提交、GitHub/server同步以Git读回及runtime/curation-coordinator-sync.json为准。
