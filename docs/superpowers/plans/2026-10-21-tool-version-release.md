# Tool Version Release Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. User explicitly requires personal main; no new branch/worktree. Controller owns final commit/push and server actions.

**Goal:** Publish the already verified child as1.0.1 and demonstrate manual rollback while preserving evidence.

**Architecture:** Generalize registry/package/history readers together, retain active-only execution, expose trusted rollback CLI, and verify the same released images through three controlled calls.

**Tech Stack:** Node24 ES modules, node:sqlite, node:test, existing project rootless Docker.

**Spec:** docs/superpowers/specs/2026-10-21-tool-version-release-design.md

## Global Constraints

- Personal main only; base94d09dd478634fbba775d5807ca8b10440b8d4bd; reference67d2754 read-only.
- Remote root /home/hanwen/Project/project/siNRA-pi only; never read/print/copy credentials.
- Node, no dependencies, no_external_access, exact;0 model calls,0 new builds/revalidation.
- Existing first-version package/report/source bytes remain unchanged; new version1.0.1 finalactive; old1.0.0 inactive/retained.
- Explicit schema4 migration with consistent private backup; active/inactive only, no automatic degradation/rollback or image deletion.

## Task1: Multi-version storage, release, history and CLI

Files: packages/capability-platform/tool-registry.mjs, tool-approved-packages.mjs, tool-lifecycle.mjs, tool-validation-reports.mjs, tool-approval-service.mjs, tool-run-audit.mjs, tool-approved-execution.mjs if active guard needs clarification; scripts/manage-tool-proposals.mjs. Add a focused shared tool-version.mjs only if validation reuse warrants it. Tests: new tests/tool-version-release.test.mjs and existing registry/package/approval/parent/audit suites and helpers where their old first-version restriction must be updated.

Interfaces: ToolRegistry.nextVersion(toolName,parentVersion?) -> {toolId,version}; activateVersion retains existing evidence fields and adds optional parentToolId,parentVersion,parentPackageSha256 for parent identity checks under write lock; persisted child rows expose parentToolId,parentVersion. rollbackTool(toolName,version,actor,reason) -> version (service computes changed). publishApprovedToolPackage accepts version default1.0.0; manifest optionally parent. rollbackRegisteredTool(toolName,version,actor,reason,{root}) -> {version,catalog,activated:true,changed,...callability}. Existing callers unchanged otherwise. Recursion context may be optional in historical reader/resolver/report reader and must propagate across all recursive edges.

- [x] RED: use real approval fixtures and child baseline equal parent source; publish child and assert literal states/IDs, then read parent and child evidence. Initially child approval must fail. Add second child to exercise real lineage beyond first parent.
  ```js
  assert.equal(child.version.version,'1.0.1');
  assert.equal(child.version.toolId,parent.version.toolId);
  assert.equal(getRegisteredToolVersion(name,'1.0.0',{root}).version.state,'inactive');
  ```
- [x] GREEN: migrate schema3 safely, generalize packages and history; recheck evidence/parent inside activation transaction; preserve first-version bytes. Add authentic schema3 WAL fixture test before migration implementation, asserting backup rows and post-migration preserved records.
- [x] RED/GREEN: verify rollback1.0.0 and restore1.0.1 with transaction rollback on event failure. Reapproval of inactive child does not reactivate it; next child becomes1.0.2 even after rollback. Corrupt target/ancestor and wrong identity fail before mutation; malformed/cyclic lineage fails boundedly.
  ```js
  rollbackRegisteredTool(name,'1.0.0','fixture actor','exercise rollback',{root});
  assert.equal(approveRegisteredToolProposal(childId,'fixture actor',{root}).activated,false);
  assert.equal(registry.nextVersion(name,'1.0.0').version,'1.0.2');
  ```
- [x] Add trusted CLI rollback arguments and correct structured error metadata; reject blank/control actor/reason before writes. Audit accepts canonical semver, discovery remains active-only, stale descriptors refuse execution. Cover catalog publication failure recovery and retained old evidence.
- [x] Run focused tests then node --test --test-reporter=spec tests/*.test.mjs once on frozen code; report RED/GREEN, changed files and concerns to runtime/version-release-task1-report.md. No commits/remote/model calls by implementer.

## Task2: Real release, independent acceptance and teaching

Files: scripts/verify-tool-version-release.mjs (read-only), docs/22-工具版本发布与人工回退.md, README.md, docs/学习路线.md, AGENTS.md; private scripts/evidence under ignored runtime/version-release-*.

- [x] Snapshot clean three-place base, registry/material/session/container metadata and credential stat. Exact-file transfer after unrelated-change checks; full Linux suite with project TMPDIR.
- [x] Independent Task1 spec/quality review; fix/review findings before release. Capture idle state and restart only project web to load new readers. Preserve guest containers and old task metadata. Deviation: initial unsafe CLI test migrated early; exact impact audited, test isolated, original state preserved. See docs22.
- [x] Approve4530af22-d8d7-42f0-ac75-fec6ce851466; call1.0.1 with AACCGGGUUUA -> {length:11,gcFraction:5/11,baseCounts:{A:3,C:2,G:3,T:3}}. Rollback1.0.0 -> {length:11,gcFraction:5/11}; restore1.0.1 -> first output. Assert three fresh audits/version/image and removed temporary containers. Capture each operation separately with exclusive evidence paths.
- [x] Read-only verifier checks two immutable packages, original source/report hashes, migration backup, exact state/events, three output/audit hashes, finalcatalog and preserved old task/container state. Document exact evidence and limitations.
- [ ] Final independent review, explicit-file commit/push main, bundle to server after matching content; verify identical commits and clean worktrees. Detailed Chinese explanation follows file/data flow.
