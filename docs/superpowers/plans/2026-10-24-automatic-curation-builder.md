# Automatic Curator-to-Builder Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect an automatically completed Curator candidate to the existing durable Builder service with bounded, idempotent dispatch while preserving manual approval.

**Architecture:** The Curator service remains responsible for durable review results. It emits a non-blocking terminal-result notification after the result is durably stored. The existing coordinator accepts only candidates originating from its own automatic review, verifies the task is still idle and the candidate is still eligible, and calls the existing `toolCurationBuild.start` exactly once. Builder state remains the source of truth for restart and outcome handling; no automatic validation, approval, or historical rescan is added.

**Tech Stack:** Node.js ESM, `node:test`, SQLite-backed stores, existing TaskMessageService and Agent Compose runtime.

**Spec:** `docs/33-自动观察与候选冷却.md`, `packages/extensions/tool-curation/MODULE.md`, and the existing Builder contract in `packages/extensions/tool-curation/tool-curation-build-contract.mjs`.

## Global Constraints

- Automatic review remains disabled by default and keeps the existing per-process maximum of three Curator reviews.
- Automatic Builder dispatch is opt-in and bounded to candidates produced by the current coordinator instance; it never scans historical candidates on startup.
- The existing Builder contract remains unchanged: Node only, empty dependencies, exact repeatability, no external access, no parent tool, and at most one submitted proposal.
- A submitted proposal is not verified, approved, or published automatically.
- A busy, stopped, stale, changed, or uncertain task produces a durable skip/error observation and never starts a second Builder turn.
- Curator persistence must finish before the notification is emitted; notification failures cannot rewrite a successful Curator result.

---

### Task 1: Define failing coordinator-to-builder behavior tests

**Files:**
- Modify: `tests/curation-coordinator-integration.test.mjs`
- Inspect: `packages/extensions/tool-curation/tool-curation-coordinator.mjs`

**Interfaces:**
- Consumes: existing coordinator fixture and existing `curation` service.
- Produces: executable expectations for candidate dispatch, skip decisions, and idempotent duplicate handling.

- [x] **Step 1: Add a fake Builder service to the integration fixture**

  Give it `start(taskId, curationId, binding)` and record calls. Return a durable-looking handoff object. Keep the fake task runtime idle so the test isolates coordinator admission.

- [x] **Step 2: Add a failing test for automatic candidate dispatch**

  Complete an automatic Curator review as `candidate`, emit its terminal notification, run the coordinator once, and assert that Builder `start` receives the exact task ID, Curator ID, and frozen `traceSha256/resultSha256/promptSha256` binding. Assert that no ordinary user message is created by the coordinator itself.

- [x] **Step 3: Add a failing test for skip results**

  Complete an automatic Curator review as `skip`, emit its terminal notification, run the coordinator, and assert that Builder is never called and the automation status records a terminal `ignored`/`curation_skip` observation.

- [x] **Step 4: Add a failing test for duplicate terminal notifications**

  Emit the same candidate notification twice and assert that Builder is called once. The second observation must be recorded as deduplicated and must not consume another automatic review or Builder attempt.

- [x] **Step 5: Run only these tests and verify they fail for the missing dispatch behavior**

  Run: `node --test tests/curation-coordinator-integration.test.mjs`

  Expected: the new dispatch assertions fail because the coordinator currently has no Builder dependency or terminal-candidate path; all pre-existing tests should remain green.

### Task 2: Add a durable Curator terminal-result notification

**Files:**
- Modify: `packages/extensions/tool-curation/tool-curation-service.mjs`
- Modify: `tests/curation-coordinator-integration.test.mjs`

**Interfaces:**
- Consumes: optional `onSettled(run)` callback supplied to `createToolCurationService`.
- Produces: a callback after `store.complete` or `store.fail`, with the persisted curation record, and no callback before durable completion.

- [x] **Step 1: Extend the fixture to pass an `onSettled` callback**

  Capture notifications and assert the callback sees the final persisted `status`, `id`, `taskId`, and `runId`.

- [x] **Step 2: Run the notification test and confirm it fails because the callback is not called**

  Run: `node --test tests/curation-coordinator-integration.test.mjs`

- [x] **Step 3: Add the optional callback to the service factory**

  Invoke it only after `store.complete` or `store.fail` returns. Wrap both synchronous and asynchronous callback failures so they are observed safely and cannot turn a durable Curator result into a retry.

- [x] **Step 4: Run the focused tests and verify the notification timing**

  Run: `node --test tests/curation-coordinator-integration.test.mjs tests/curation-cooldown.test.mjs`

### Task 3: Implement bounded candidate dispatch in the coordinator

**Files:**
- Modify: `packages/extensions/tool-curation/tool-curation-coordinator.mjs`
- Modify: `apps/api/bootstrap.mjs`
- Modify: `tests/curation-coordinator-integration.test.mjs`

**Interfaces:**
- Consumes: `toolCurationBuild.start(taskId, curationId, binding)` and terminal curation notifications.
- Produces: `observeCuration(run)` and an automation status record for `builder_dispatched`, `curation_skip`, `builder_busy`, `builder_error`, or `builder_outcome_unknown`.

- [x] **Step 1: Add a Builder dependency and a second bounded capacity counter**

  Accept `toolCurationBuild` and `maxBuilds` in the coordinator. Default `maxBuilds` to the existing review budget so automatic Builder cannot outgrow automatic Curator admission. Reject invalid values at construction.

- [x] **Step 2: Add a failing test for a busy task**

  Make `isTaskBusy` return true when the Curator candidate settles. Assert that Builder is not called, the candidate remains a candidate for later manual handoff, and the status reason is `builder_busy`.

- [x] **Step 3: Implement `observeCuration(run)` with strict identity checks**

  Ignore non-candidate results, non-automatic results, malformed bindings, and candidates that do not belong to the coordinator’s observed task/run set. For a valid candidate, read the frozen Builder binding from the curation result through the existing `curationBuildPrompt` contract, then call `toolCurationBuild.start` once.

- [x] **Step 4: Add idempotent reservation before the asynchronous Builder call**

  Keep a process-local set keyed by `curationId`, and check the durable Builder store through `view`/`start` before dispatch. A repeated notification must return a deduplicated observation and never call the model twice.

- [x] **Step 5: Wire the callback and Builder service in bootstrap**

  Construct the Curator service with a callback that forwards to `toolCurationCoordinator?.observeCuration`. Keep the existing closure ordering so startup does not dispatch before the API owns its listening socket.

- [x] **Step 6: Run the focused tests and verify red-to-green**

  Run: `node --test tests/curation-coordinator-integration.test.mjs tests/curation-build-api.test.mjs tests/curation-cooldown.test.mjs`

### Task 4: Verify lifecycle, restart, and no-approval boundaries

**Files:**
- Modify: `tests/curation-build-lifecycle.test.mjs`
- Modify: `tests/curation-coordinator-integration.test.mjs`
- Modify: `docs/33-自动观察与候选冷却.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: coordinator startup/shutdown and existing Builder `recover` behavior.
- Produces: documented phase 12 behavior and regression coverage for recovery boundaries.

- [x] **Step 1: Existing lifecycle tests cover stopping during accepted Builder work**

  Assert that shutdown stops new automatic admissions, waits for the in-flight callback, and closes the Builder service before stores close.

- [x] **Step 2: Existing Builder lifecycle tests cover interrupted handoff recovery**

  Persist a `dispatching` or `running` build, call the existing Builder `recover`, and assert it becomes `outcome_unknown` without an automatic replay.

- [x] **Step 3: Existing Builder/maintenance boundaries and automatic integration tests cover no auto-approval/validation**

  Use the existing fake Builder and maintenance fixtures; assert only `start` is called and no registry activation, validation, or approval function is invoked.

- [x] **Step 4: Update the learning document with exact phase status**

  State that 11E remains complete, 12A automatic Curator-to-Builder dispatch is complete only after the focused and full suites pass, and automatic validation/approval remain future work.

- [x] **Step 5: Run the full repository test suite and inspect the diff**

  Run: `npm test`

  Confirm exit code 0, count failures and skips, inspect `git diff --check`, and verify no secret/config files changed.

---
