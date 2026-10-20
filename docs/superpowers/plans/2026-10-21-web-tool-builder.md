# Web Tool Builder Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. User requires main only. Root owns commit, remote actions and teaching docs; private runtime evidence remains ignored.

**Goal:** Connect the six builder tools to web Pi with turn ownership and verified cleanup, then submit one real candidate.

**Architecture:** Guest-local MCP calls reference-shaped private HTTP routes; the existing UDS gateway authenticates leases and owns per-turn builder services. Separate approved discovery/call contracts remain intact.

**Tech Stack:** Existing Node ESM, node:test, MCP SDK, rootless Docker, SQLite; no new dependency.

**Spec:** docs/superpowers/specs/2026-10-21-web-tool-builder-design.md

## Global Constraints

- Main only; base670150e3765ebb51ff66dbfc27db9fbf3537f6f8; reference67d2754 read-only.
- Remote only `/home/hanwen/Project/project/siNRA-pi`; no system/admin changes or credential contents output/copy.
- Preserve Node/no dependencies/no_external_access/exact, source-only packaging and submitted-only registration.
- Owner is host-selected activated taskContext; per-turn builder; one builder-owning web turn at once, max4live/32total sessions; unknown cleanup keeps slot occupied.
- Reference HTTP method/path/body relations; builder1MiB request,300000B response,client300s/relay310s; approved262144B/30s unchanged.
- Tests use controlled temporary roots; subprocess cwd explicit, never production root.

## Task1: Authenticated builder transport and turn lifecycle

Create `packages/capability-platform/task-tool-builders.mjs` (one-owner coordinator), `apps/api/tool-build-api.mjs` (fixed route handler), `apps/mcp/tool-builder-client.mjs` (bounded fixed HTTP adapter), and if useful a small shared private HTTP helper for authentication/body parsing. Modify leases to register lazy owned resources and drain/close on turn end; modify builder service to record validated host taskContext; modify tool-lifecycle to accept trusted optional actor (CLI default retained). Modify existing agent-tools server to delegate only exact build routes, track accepted requests in shutdown; bootstrap injects coordinator. Runtime closes context in finally and records builder availability for new tasks.

Modify remote-server/approved-server to add optional fixed six builder tools with correct annotations without relaxing approved validation. Tool execute signal must reach builder client. Modify relay only for fixed build/proposal routes with per-route bounds/status handling. Change agent-compose.yml to new project/image and explicit builder URL. Modify build-project-guest.sh tag, and guest config/patch only if actual adapter timeout requires it (inspect actual locked adapter first, report exact setting).

Tests: new `tests/web-tool-builder.test.mjs`, existing lease/agent-tools/remote/relay/runtime tests as appropriate. Reuse externalDocker double and safe fixture cleanup. No edits to final teaching docs, operational private scripts or examples by implementer.

Interfaces chosen by implementer within spec: coordinator `createTaskToolBuilders({root,docker})` exposes service acquisition from authenticated lease handle; lease resource registration must be synchronous and revoke-safe, with promise close that drains requests and preserves cleanup failure. Route handler must integrate existing server.waitForCalls. Explicit constructor injection supports tests.

- [x] RED real HTTP/MCP test shows six tools reach reference routes, then real temp registry records submitted candidate tied to host taskContext; absent routing initially fails.
  ```js
  assert.equal(proposal.state, 'submitted');
  assert.equal(registry.listActiveTools().length, 0);
  assert.deepEqual(journalOwner, activatedTaskContext);
  ```
- [x] GREEN implement bounded routes/client, lifecycle resources and audit association.
- [x] RED/GREEN verify pending/forged/revoked/other-turn session rejection, draining accepted calls before container cleanup, unknown cleanup preventing slot reuse, request bounds/timeout/errors, approved call validation unchanged and cancelled/finished resource cleanup.
  ```js
  assert.equal(crossTaskResponse.status, 409);
  await lease.close();
  assert.equal(fakeDocker.liveContainers().length, 0);
  assert.equal(revokedResponse.status, 401);
  ```
- [x] Focused tests until green; full scoped suite once, not broad runtime discovery. Record RED/GREEN commands and exact results in runtime/web-builder-task1-report.md; self-review and stop for root review. Root commits after complete verification, not implementer.

## Task2: Real deployment, web exercise and explanation

Root owns runtime/web-builder-* evidence/transfer/sync scripts; new example07, readonly verifier and docs24; README/learning-route/AGENTS summary updates.

- [x] Snapshot clean three heads, old rows/material hashes/sessions/audits/container IDs, credential stat only. Prepare constrained transfer manifest, independent code review and focused fixes.
- [x] Linux full tests; build new image; verify no active tasks, then scoped relay/controller/backend restart. Existing guests untouched; create fresh web task.
- [x] Use real webpage Pi to create/write/debug/finalize/propose a controlled deterministic small tool. Capture actual model/run/MCP results and status; no automatic validation/activation. Exercise cancel/turn-end cleanup and ownership refusals without affecting other tasks.
- [x] Readonly cross-check registry, frozen source/image, owner context and temporary cleanup; preserve all pre-existing rows and files, active1.0.1. Explain reference similarities/differences and unfinished Curator/automatic recovery.
- [ ] Independent final review; commit/push main and transfer exact bundle with source hash verification, then compare clean local/GitHub/server heads. Commit-dependent receipts remain runtime only.

## Execution evidence

Task1 reviewed independently with no Critical/Important findings. Its Minor public-error warning was corrected with a failing integration test followed by29 passing related tests. Windows before that narrow fix:1056 total,1043pass/13skip; final Linux:1057 total,1055pass/2skip/0fail. Exact commands and fixture diagnostics are in ignored runtime/web-builder-task1-report.md; Linux log/runtime preservation records retained.

Task2 actually deployed the new guest image and ran one browser task506ee4db-d6c6-4a8c-b1ab-d9bd5b26cb52.16 model responses,19 Pi tools,8 successful builder operations,2 pre-business describe schema errors corrected by Pi. One submitted candidate26883ce8-5c2e-4a0e-90fb-d96e53270b9c; no new validation/approval/version.4 temporary containers removed, explicit cancel and automatic close_cleanup verified; task then ended and guest released, output preserved. Ownership refusals were exercised in real HTTP/MCP integration tests with isolated temporary state, not by issuing forged production requests. Old21 materials/12audits/11sessions/2guests and old registry/task rows remained unchanged.

Detailed Chinese explanation, reference differences, costs and limitations: docs/24-网页Agent构建工具与任务归属.md. The final review/sync checkbox deliberately remains pending in the pre-commit document; successful final publication is evidenced by ignored runtime/web-builder-sync.json and web-builder-post-sync.json, avoiding a second commit solely to embed its own commit hash.
