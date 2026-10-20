# Parent Tool Proposal Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. The user explicitly requires this personal repository's main branch; no worktree or new branch.

**Goal:** Bind a child proposal to the real approved parent source and produce a verified candidate without publishing it.

**Architecture:** Preserve parent in immutable proposal material; resolve the approved parent at submission, validation and readback; add comparison identity to the existing validation report. Existing approval rejects child proposals before writes until the separate multi-version step.

**Tech Stack:** Node24 ES modules, node:test, node:sqlite, existing Docker execution runner.

**Spec:** docs/superpowers/specs/2026-10-21-parent-tool-proposal-design.md

## Global Constraints

- main only; do not modify reference repository or RSI project.
- Remote root /home/hanwen/Project/project/siNRA-pi only; do not read credentials.
- parent is current active/retained 1.0.0; baseline runtime/source must equal the verified parent.
- comparisonMode is registered-parent-source; fixed validation base executes source, not the parent's OCI runtime.
- Node, no dependencies, no_external_access, exact; no new model calls.
- Candidate remains verified; no schema migration, active switch or rollback this step.

## Task 1: Parent material, service binding and validation evidence

**Files:** modify packages/capability-platform/tool-proposals.mjs, tool-lifecycle.mjs, tool-validation-service.mjs, tool-approval-service.mjs; modify report reader only if needed for consistent report validation. Tests in tests/tool-parent-proposal.test.mjs and relevant existing tests.

**Interfaces:** export assertRegisteredToolParent(input,{root,registry}); return undefined without parent, otherwise the exact parentComparison fields in the spec. Submit additionally rejects missing parent when an approved same-name version exists. Keep old initial proposal readback valid after its approval.

- [ ] RED: create a real approved-parent fixture using existing registration, validation and approval test helpers; assert parent material survives fresh reads and wrong/missing references create no child package/row. Assert weak baseline and wrong runtime reject. Run node --test tests/tool-parent-proposal.test.mjs and record expected failures.
- [ ] GREEN: retain optional parent in create/read material, use complete formal version readback and SHA checks before child persistence. No source execution or synthetic artifact verification.
- [ ] RED: validate a child with a boundary runner, assert literal parentComparison and original baseline passed to it; corrupt the real parent before/while execution and assert no passing child validation. Assert report/show refuse missing or inconsistent child binding. Assert verified child approve leaves packages/catalog/events unchanged.
- [ ] GREEN: bind before runner and after execution, preserve identity in report and check it on readers; reject child approval explicitly before writes. Keep original first-version records readable.
- [ ] Run focused tests including tool-proposals, lifecycle, validation, approval and approved-execution. Report RED/GREEN evidence and files to runtime/parent-tool-implementation-report.md. No commit or remote actions; controller owns integration and final single-step commit.

## Task 2: Concrete candidate, deployment and learning record

**Files:** examples/05-parent-tool-proposal/proposal.draft.json, its README; scripts/verify-parent-tool-proposal.mjs read-only acceptance; docs/21-父版本提案与真实基线比较.md, README.md, docs/学习路线.md, AGENTS.md.

- [ ] Add the independently specified counts example and a literal expected-output test; baseline must be the unchanged existing candidate. The new implementation should fail the new expectations before it is added.
- [ ] Review Task1 diff against spec, fix findings and run full Windows/Linux suites on frozen implementation.
- [ ] Capture clean base3ee3184, old registry rows/material/versions/catalog, all old session hashes and container identities before deployment; transfer only this step's exact files after unrelated-change check.
- [ ] Build the one reviewed draft, submit its built proposal and validate once using existing CLI. Independently check parent/source hashes, real 3/3 versus1/3, netGain2, recorded execution count and no leftover temporary containers. No model calls.
- [ ] Read-only verify candidate is verified/unapproved, parent remains active1.0.0 and catalog/formal package/old records are unchanged. Document failures if any without overwriting old evidence.
- [ ] Complete independent final review and detailed Chinese file explanation; explicit-list commit/push main, Git bundle transfer, verify three identical commits and clean worktrees.
