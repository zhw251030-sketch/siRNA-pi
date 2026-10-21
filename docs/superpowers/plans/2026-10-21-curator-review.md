# Curator review implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** 从11A已结束轮次的完整线索形成不可变证据，并由独立无工具Agent提出可追溯建议。

**Architecture:** extension owns frozen evidence/store/coordinator/result validation; generic runtime gains a fixed Curator role; API/UI manually request and read. No builder/registry writes.

**Tech Stack:** Node24 ESM, node:sqlite, Pi1.2.0, AgentCompose v2609.3.0, existing browser modules.

**Spec:** docs/superpowers/specs/2026-10-21-curator-review-design.md

## Global Constraints

- Personal main only; no edits to reference/parent research; remote only /home/hanwen/Project/project/siNRA-pi.
- Never output/read credential contents for investigation; established runtime may use credentials in memory. No new dependency/install/system mutation.
- Reference 67d2754 is read-only; independently implement behavior, preserve original trace/result protocol names and label extensions/deferred scope.
- One task/run one immutable trace, max64KiB; model output max48KiB; single consumer;180s/zero retries; no auto build/approval/replay.
- Existing designer tasks, four business DBs, catalog and old artifacts are preserved.
- Use apply_patch; tests temp fixtures only; final source verified on Windows and Linux; root owns commits/deployment.

### Task 1: Frozen evidence, persistence, advisory review service

**Files:** modify tool-curation-preview.mjs for `snapshot(taskId,runId)` returning `{preview,existingTools,events}` from one read, while `read` keeps exact11Apublicresponse. Create tool-curation-evidence.mjs, tool-curation-result.mjs, tool-curation-store.mjs, tool-curation-service.mjs in packages/extensions/tool-curation; meaningful tests in tests/curation-review.test.mjs and tests/curation-store.test.mjs. No API/runtime/UI edits yet.

**Interfaces:**
- `buildToolCurationTrace({id,snapshot})` returns immutable-compatible trace/v1 with complete triggering calls only, `gapReports:[]`,trigger post_run, exact known tools, source/preview hashes and signals metadata; pure canonical hash helper exported if needed.
- `toolCurationPrompt(run)` and `validateToolCurationResult(run,value)` plus `parseToolCurationResult(run,text)` in result module. Strict bounded validation against frozen trace; no executable effects.
- `new ToolCurationStore({root})`: own runtime/tool-curation/curation.sqlite, safe path/recognized schema; atomic unique(task_id,run_id), transaction where needed, immutable trace (SQL update guard), methods may be designed coherently and documented in report. `close()`.
- `createToolCurationService({store,preview,curator})` returns `request(taskId,{runId,sourceSha256,previewSha256})`, `list(taskId)`, `get(taskId,id)`, `start()`, `stop()`; curator injectable `{curate(run,signal,onStarted)}` returns `{result,sessionId,runId}`. Service independently validates result and persists identity immediately. `ToolCurationError` statusCode for router. Accepted response `{curation,deduplicated}`. No eligible signal =>409 no record/model; missing task/run404, stalehash409, oversized413, unavailable503. request idempotently returns prior matching record even source now changed, mismatching prior binding409. Limit pending admission (e.g.32); bound list results to100 without returning trace on list. get full frozen record.

- [ ] RED: temp TaskStore fixture with completed3calls/2inputs; request once and concurrently, fake delayedCurator; assert one durable request/dispatch and unchanged source/task DB; restart never dispatches old in-flight. Write tests before modules and run to see missing-module failure.
- [ ] Implement and GREEN: exact source/catalog hash binding, stale preview/no signal/incomplete window/foreign run/running/oversize refusal; mutation of source afterfreeze leavestrace unchanged; readonly reopened store; immutable update guard; prototype/path issues.
- [ ] Result fixtures: skip/candidate success, wrongid/hash/key/evidence,name/permissions/unknownfields/size/depth rejection, missingterminal/failure identity. Fakecurator is no-model.
- [ ] Run focused tests including existingcuration preview/trace, document commands/counts in runtime/curator-review-task1-report.md. Root commits after verification; do not commit yourself.

### Task 2: Independent read-only runtime and webpage integration

**Files:** modify AgentComposeRuntime/ComposeSessionStore/compose-executor fixed role options; create agent-compose-curator.yml, containers/agent-compose-guest/Dockerfile.curator,pi-curator.sh,curator-guard.mjs; create extensions/tool-curation/agent-tool-curator.mjs; wire bootstrap/router; enhance public/curation.mjs. Tests actor isolation/guard/result/lifecycle/API/UI plus existing regression.

**Interfaces:** `new AgentComposeRuntime({root,executor,rpc,agentName:'tool-curator'})`; default designer unchanged. Executor corresponding fixed option. Namespace runtime/tool-curation/sessions and runtime/tool-curation/events (not task metadata). `createAgentToolCurator({runtime,timeoutMs:180000})` implements Task1curate; creates freshsession, persistsidentitybeforemodel; all error/done/tool events fail closed; finally runtime.remove awaits graceful cleanup; identity retained on failure. No host leases, no workspace sample, no task prepend prompt.

- [ ] RED guard: simulatedPi calls stored hook, every tool_call returns `{block:true,reason:...}`; session_start active tools empty. Tests wrapper argument ordering and --no-extensions explicit -e behavior frominstalledPi documented; runtime options may only designer/tool-curator; wrongrolemetadata rejected. Then implement fixedrole changes using existing lifecycle.
- [ ] Separate compose project `sirna-pi-learning-curator`, agent tool-curator, MiniMax-M3, image `sirna-pi-curator:pi1.2.0-v1`, no MCP. Dockerfile FROM existing sirna-pi-guest:pi1.2.0-mcp4 and onlyCOPYwrapper/guard. Wrapper preservesofficialargs then forces --no-tools --exclude-tools '*' and explicitguard; noextensionsauto, noskills/context/etc, existing settings. Tests no tool exposure/hardhook; do not modify existingDockerfile/agent-compose.yml.
- [ ] API POST `/v1/tasks/:id/curations` accepts exactly runId/sourceSha256/previewSha256, sameorigin+bodylimits asexistingwrites;GETsamepath lists;GET `/v1/tasks/:id/curations/:curationId` detail; errorsclass. No rawprompt/error leakage. bootstrap creates separatecuratorruntime/store/service; starts onlyafterlisten; shutdown closesacceptance/drainsbeforecloseRPC/DB.
- [ ] UI button onlyafterfullsignalpreview, text “提交独立审查（调用模型）”; manual “刷新审查记录”; display status+advisoryoutcome+tracefingerprint/details withtextContent. Retaintaskgenerationguard aftereveryawait; noautopost/poll; dedup server. ExistingUItestharness remainsworking.
- [ ] Focusedtests red→green; report runtime/curator-review-task2-report.md; root owns fulltests/deploy/commit.

### Task 3: Review, verification, deploy and explanation

**Files:** root/privateops helpers under runtime/curator-review-*, docs/30-独立Curator审查与冻结证据.md, README/AGENTS/学习路线/MODULE.

- [ ] Independent task/finalreviews; fix scopedfindings and rerun affectedtests. Fullsuite once each Windows/Linux after integration, unique logs and no privatefixtureoutput.
- [ ] Guarded serverbaseline beforechanges. Transfer explicitfilemanifest, buildprojectcuratorimage witholdimagesretained, prove guard using actualPi SDK no-model; validateComposeconfigquiet. PreserveoldDBsandoldguestIDs/state/evidence.
- [ ] Existingbusiness preview refusal noLLM, separate synthetic frozenfixture at mostone realCuratorcall afterguardtest; candidateorlegitimate skip bothvalid, protocolfailure truthfullyrecorded notretried. Releaseonlynewguest gracefully, retain evidence. No syntheticbusinessDB inserts.
- [ ] IdleAPIrestartverified; browser check manualrefresh/ineligibility, screenshotifuseful. Current curations mayempty because realhistorynoeligible; explain.
- [ ] Chinese teachingdoc actualfiles+flow+referencecomparison+testevidence+knownlimits. Commit exactallowlist, pushmain, bundledserveralign onlyverifiedmatchingfiles; local/remote/origin cleanSHAsmatch.
