# Automatic Builder-to-Validation Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect a durably submitted automatic Builder proposal to the existing independent maintenance queue without automatically approving or publishing it.

**Architecture:** The Builder service emits a terminal notification only after its durable handoff phase is written and the registry receipt has been read back. The existing coordinator accepts only `submitted` results from the current automatic Builder handoff, verifies the proposal/artifact identity, and calls the existing maintenance worker with a deterministic request UUID. Automatic validation is opt-in and disabled by default; no historical scan or unknown-outcome replay is added.

**Tech Stack:** Node.js ESM, `node:test`, SQLite-backed Builder and maintenance stores, existing Docker validation worker.

**Spec:** `docs/34-自动Builder交接闭环.md`, `packages/extensions/tool-curation/MODULE.md`, `packages/capability-platform/tool-maintenance-worker.mjs`, and the Builder phases in `tool-curation-build-store.mjs`.

## Global Constraints

- Automatic validation is disabled by default and must have its own explicit bounded switch.
- Only a submitted proposal produced by the current automatic Builder handoff may be enqueued automatically.
- The request key must bind the exact `proposalId`, Builder `curationId`, and artifact SHA-256; a mismatch fails closed.
- `no_proposal`, `failed`, and `outcome_unknown` never enter maintenance automatically.
- Maintenance execution remains independently isolated and may halt on an uncertain Docker outcome.
- Validation success never activates a tool; human approval remains a separate operation.
- Restart does not scan historical submitted proposals or replay an uncertain validation job.

---

### Task 1: Add failing terminal-notification and enqueue tests

**Files:**
- Modify: `tests/curation-build-lifecycle.test.mjs`
- Modify: `tests/curation-coordinator-integration.test.mjs`

**Interfaces:**
- Consumes: existing Builder fixture, maintenance fake, and durable handoff states.
- Produces: tests for submitted-only handoff, exact proposal/artifact binding, opt-in gate, and no auto-approval.

- [ ] **Step 1: Add a fake maintenance service with `enqueue(proposalId, requestId)`**
- [ ] **Step 2: Add a failing test for submitted Builder notification**
- [ ] **Step 3: Add a failing test for no-proposal and outcome-unknown suppression**
- [ ] **Step 4: Add a failing test for deterministic duplicate enqueue**
- [ ] **Step 5: Add a failing test that the default configuration never enqueues maintenance**
- [ ] **Step 6: Run the focused tests and confirm failure is caused by the missing terminal bridge**

### Task 2: Add Builder terminal notification with immutable receipt data

**Files:**
- Modify: `packages/extensions/tool-curation/tool-curation-build-service.mjs`
- Modify: `tests/curation-build-lifecycle.test.mjs`

**Interfaces:**
- Consumes: optional `onSettled(ticket)` callback.
- Produces: a callback after `submitted`, `no_proposal`, `failed`, or `outcome_unknown` is durably saved; the callback includes `curationId`, `phase`, `proposalId`, `requestId`, and the frozen artifact binding when available.

- [ ] **Step 1: Add the callback to the service factory and validate its type**
- [ ] **Step 2: Notify only after `finish()` has updated the durable store**
- [ ] **Step 3: Swallow callback failures without changing the Builder phase**
- [ ] **Step 4: Verify duplicate completion notifications do not create a second ticket**

### Task 3: Add an explicit automatic-validation gate to the coordinator

**Files:**
- Modify: `packages/extensions/tool-curation/tool-curation-coordinator.mjs`
- Modify: `apps/api/bootstrap.mjs`
- Modify: `tests/curation-coordinator-integration.test.mjs`

**Interfaces:**
- Consumes: Builder terminal notification and optional maintenance service.
- Produces: `observeBuilder(ticket)` and status reasons `validation_disabled`, `validation_queued`, `validation_deduplicated`, `validation_busy`, or `validation_error`.

- [x] **Step 1: Add `toolMaintenance` and `automaticValidation=false` dependencies**
- [x] **Step 2: Track only Builder tickets dispatched by this coordinator instance**
- [x] **Step 3: Derive a deterministic maintenance request ID from the Builder ticket**
- [x] **Step 4: Enqueue only `submitted` tickets with a verified proposal ID and artifact SHA**
- [x] **Step 5: Keep disabled mode side-effect free and preserve manual validation**
- [x] **Step 6: Bound validation admissions and drain them during shutdown**

### Task 4: Document and verify restart/approval boundaries

**Files:**
- Modify: `docs/34-自动Builder交接闭环.md`
- Modify: `README.md`
- Modify: `docs/学习路线.md`
- Modify: `packages/extensions/tool-curation/MODULE.md`

**Interfaces:**
- Consumes: final test evidence.
- Produces: phase 12B explanation and explicit statement that validation is opt-in and approval remains manual.

- [ ] **Step 1: Run the focused Builder/maintenance/coordinator suites**
- [x] **Step 2: Run the complete `npm test` suite**
- [x] **Step 3: Run `git diff --check` and inspect the exact changed files**
- [ ] **Step 4: Commit and synchronize only the verified changes to `main`**

---
