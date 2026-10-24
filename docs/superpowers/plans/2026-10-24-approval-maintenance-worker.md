# Approval Maintenance Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将个人仓库当前的协调器批准回调升级为与参考仓库语义一致的持久化 approval maintenance job、独立 worker、HTTP 入队和自动化状态恢复链路。

**Architecture:** 新增独立的 `ToolApprovalStore` 与 `createToolApproval` worker，避免修改已经投入使用且只负责验证的 `ToolMaintenanceStore` schema。协调器只负责在 `approving` 阶段入队并观察批准终态；批准服务继续负责证据核验、正式包发布和版本激活。批准队列使用 proposal UUID、请求人和幂等 request UUID，worker 重启时把未知的 running job 退回 pending，因为批准服务本身是幂等的并会重新检查全部证据。

**Tech Stack:** Node.js 22+ `node:sqlite`、现有 `approveRegisteredToolProposal`、HTTP `apps/api/router.mjs`、Node test runner。

**Spec:** [第12E自动批准边界](../../38-自动批准边界.md) 与参考仓库 `apps/api/router.ts`、`packages/capability-platform/tool-maintenance-worker.ts`、`packages/capability-platform/tool-registry.ts`。

## Global Constraints

- 默认不打开自动批准；`SIRNA_AUTOMATIC_APPROVAL=1` 才允许协调器自动入队。
- 批准前必须继续使用现有 `approveRegisteredToolProposal`，不得绕过 `ToolRegistry.activateVersion` 的证据核验。
- approval job 不执行候选源码，不创建 Docker 容器；重启重试只能调用幂等批准服务。
- 队列数据库、请求别名和错误信息必须位于项目 `runtime` 私有目录，公开 API 不返回私有路径、源码或原始异常。
- 已激活但 catalog 投影失败时必须保留 `completed`/已提交事实，不能把已激活版本报告为未批准。

---

### Task 1: Add durable approval queue storage

**Files:**
- Create: `packages/capability-platform/tool-approval-store.mjs`
- Test: `tests/tool-approval-store.test.mjs`

**Interfaces:**
- Produces `ToolApprovalStore({root})` with `enqueue(proposalId, requestId, {approvedBy})`, `claim()`, `finish(id, result)`, `get(id)`, `getByRequest(requestId)`, `latest(proposalId)`, `list()`, `interruptRunning()`, `halted()`, `close()`.
- A row contains `id`, `proposalId`, `status`, `requestedBy`, `createdAt`, `updatedAt`, and optional `approved`, `activated`, `error`.

- [ ] **Step 1: Write failing store tests**

  Cover UUID validation, `verified`-only admission through the worker-facing binding, same request deduplication, cross-proposal request rejection, one running job across two SQLite connections, running-only finish, bounded queue aliases, and reopening a running job as `pending`.

- [ ] **Step 2: Run the focused tests and confirm failure**

  Run `node --test tests/tool-approval-store.test.mjs`.
  Expected: failure because `tool-approval-store.mjs` does not yet exist.

- [ ] **Step 3: Implement the isolated SQLite store**

  Use a private `runtime/tool-approval/jobs.sqlite` database with application identity, strict schema recognition, WAL/busy timeout, symlink/hardlink checks, one active job per proposal, one running job globally, request aliases capped at 32, and a transaction for enqueue/claim/finish/recovery.

- [ ] **Step 4: Run the focused tests**

  Run `node --test tests/tool-approval-store.test.mjs`.
  Expected: all store tests pass with no production database access.

- [ ] **Step 5: Commit the storage unit**

  Run `git add packages/capability-platform/tool-approval-store.mjs tests/tool-approval-store.test.mjs && git commit -m "feat: add durable approval queue store"`.

### Task 2: Add the approval worker and terminal notifications

**Files:**
- Create: `packages/capability-platform/tool-approval-worker.mjs`
- Test: `tests/tool-approval-worker.test.mjs`

**Interfaces:**
- Produces `createToolApproval({root, store, approve, onError, onSettled})` with `start()`, `status()`, `enqueue(proposalId, requestId, {approvedBy})`, `latest(proposalId)`, `list()`, `drain()`, and `stop()`.
- `approve` receives `(proposalId, approvedBy)` and must return `{approved:true, activated:true}` for a normal successful terminal result.
- `onSettled` receives a bounded `sirna-tool-approval/v1` notification containing job ID, proposal ID, requested actor, status, approved and activated booleans.

- [ ] **Step 1: Write failing worker tests**

  Cover verified proposal admission, worker claim and approval success, approval failure, duplicate request idempotency, restart recovery, shutdown drain, and the catalog projection error shape `{approved:true, activated:true, versionActivated:true}`.

- [ ] **Step 2: Run focused tests and confirm failure**

  Run `node --test tests/tool-approval-worker.test.mjs`.
  Expected: failure because the worker module does not yet exist.

- [ ] **Step 3: Implement the worker**

  Claim one job at a time, call the existing approval service, persist success/failure before emitting the terminal notification, convert an already-activated projection error into a truthful successful terminal result, and requeue unknown running jobs during `start()`.

- [ ] **Step 4: Run worker tests**

  Run `node --test tests/tool-approval-worker.test.mjs tests/tool-approval-store.test.mjs`.
  Expected: all queue and worker tests pass.

- [ ] **Step 5: Commit the worker unit**

  Run `git add packages/capability-platform/tool-approval-worker.mjs tests/tool-approval-worker.test.mjs && git commit -m "feat: add approval maintenance worker"`.

### Task 3: Connect coordinator, bootstrap, lifecycle, and HTTP queueing

**Files:**
- Modify: `packages/extensions/tool-curation/tool-curation-coordinator.mjs`
- Modify: `apps/api/bootstrap.mjs`
- Modify: `apps/api/service-lifecycle.mjs`
- Modify: `apps/api/router.mjs`
- Modify: `tests/curation-coordinator-integration.test.mjs`
- Modify: `tests/server.test.mjs` or the existing proposal HTTP test file

**Interfaces:**
- Coordinator consumes `toolApproval.enqueue`, `toolApproval.latest`, and `toolApproval.onSettled` observations; it no longer directly executes approval from the coordinator when the worker is configured.
- HTTP `POST /v1/tool-proposals/:id/approve` accepts exactly `{requestId, approvedBy}` and returns `202` for a new job or `200` for a deduplicated job.
- Bootstrap creates the approval store/worker, wires `approveRegisteredToolProposal`, starts it only after the server owns port 3000, and closes it during shutdown.

- [ ] **Step 1: Add failing integration tests**

  Add a real fixture that reaches `approving`, then assert the coordinator enqueues one approval job; processing that job with the worker activates the proposal and moves the run to `completed`. Add failure, duplicate HTTP queueing, restart recovery, and late terminal notification cases.

- [ ] **Step 2: Run focused integration tests and confirm failure**

  Run `node --test tests/curation-coordinator-integration.test.mjs`.
  Expected: new approval-queue tests fail while the existing 12E tests remain diagnostic.

- [ ] **Step 3: Wire the worker and coordinator**

  Change the coordinator's automatic approval path to enqueue a durable request, add `observeApproval`, reconcile `approving` runs from the approval store, and preserve the explicit direct callback only for isolated compatibility tests.

- [ ] **Step 4: Add the HTTP route and lifecycle wiring**

  Pass `toolApproval` through `createAppServer`, validate same-origin/JSON/UUID/actor/request fields, enqueue only verified proposals, and return safe status. Add worker start/stop ordering beside validation maintenance in `service-lifecycle.mjs` and `bootstrap.mjs`.

- [ ] **Step 5: Run focused and full verification**

  Run `node --test tests/curation-coordinator-integration.test.mjs tests/tool-approval-store.test.mjs tests/tool-approval-worker.test.mjs` and then `npm test`.
  Expected: all focused tests pass and the full suite has zero failures; platform-specific skips remain explicitly reported.

- [ ] **Step 6: Update learning documentation**

  Update `docs/38-自动批准边界.md`, `docs/学习路线.md`, `packages/extensions/tool-curation/MODULE.md`, and `README.md` to say that 12F now matches the reference's approval-job/worker boundary, while preserving the default-off switch and documenting the separate local store if it differs from the reference's shared registry queue.

- [ ] **Step 7: Commit and push**

  Run `git diff --check`, `git status --short`, `git add ...`, `git commit -m "feat: persist approval maintenance jobs"`, and `git push origin main`.

## Self-review checklist

- The plan covers storage, worker, coordinator, HTTP, bootstrap, tests, lifecycle, and documentation.
- The plan deliberately keeps validation storage unchanged and does not execute untrusted candidate code in the approval worker.
- The remaining architectural difference is explicit: the personal repository may use a dedicated approval SQLite file while the reference stores both maintenance kinds in its registry database.
- The plan does not claim Goal, Memory/Data Pool, Workbench, Black-box, or empirical self-evolution results are complete.
