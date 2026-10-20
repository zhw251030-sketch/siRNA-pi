# Tool version release and manual rollback design

Step10I continues the user's approved next step from10H: publish the verified parent candidate, preserve history, and verify manual rollback. Work stays on personal main and the dedicated server root. Reference baseline67d2754; personal base94d09dd478634fbba775d5807ca8b10440b8d4bd.

## Behavior

- Follow original nextVersion: first1.0.0; child reuses parent toolId and major/minor, patch is maximum historical patch plus1. Never reuse a number after rollback. Accept canonical nonnegative safe-integer semver without leading zeroes.
- Approval publishes a new immutable five-file package, transactionally sets the previous active version inactive, inserts the new active version, marks the candidate approved, and records version_activated. Old packages/reports/source bytes remain unchanged.
- Historical evidence readback permits retained active/inactive ancestors. Parent still requires same name, authentic package/proposal/report/approval, matching baseline source and runtime. Enforce parent lineage order and cycle/depth protection while traversing; initial1.0.0 has no parent. Store parentToolId/parentVersion on child version rows and optional parent in the new approved manifest. Preserve original first-version protocol/bytes.
- Runtime discovery and execution use the current active catalog only. Stale descriptors fail before execution; existing post-run version-change rejection remains, recorded as failure rather than silently rebinding. Actual maintenance happens only when idle.
- Explicit rollback(toolName,version,actor,reason) selects an existing retained active/inactive version, verifies full evidence before writes, transactionally switches active and records tool_rolled_back including source/target/reason. It neither revalidates nor creates a version. Selecting current active is an idempotent checked no-op (catalog may be rebuilt). No disabled/degraded/purge or automatic rollback feature this step.
- Reapproving an approved proposal returns its existing version and actual activated flag; must not reactivate an inactive historical version or add records.
- Catalog remains a checked projection. Publication failure after DB commit reports active-state change and explicit rebuild recovery; never claim the whole operation rolled back if it did not.

## Storage and interfaces

Registry schema4 replaces first-version-only tool_versions constraints with composite tool_id/version identity, unique name/version and proposal, a unique partial active-name index, retained runtime, active/inactive states and nullable parent_tool_id/parent_version. Preserve old rows exactly except additive null fields and intended state/timestamp updates. Existing schemas1/2/3 are recognized read-only; migrate explicitly with a consistent private SQLite backup before transaction. Failed/unrecognized migration does not overwrite original DB. No credentials or logs enter Git.

Generalize package loader/publisher and audit version validation. Existing first-version calls remain compatible (publisher version default1.0.0). Service rollbackRegisteredTool(toolName,version,actor,reason,{root}) returns version/catalog/activated/changed and callability unknown. CLI adds rollback <toolName> <version> <actor> <reason> under existing trusted host entry; no new public HTTP admin endpoint.

## Acceptance and bounds

Offline tests cover schema3 WAL backup/preservation, old schema reads, failed migration/transactions,1.0.1 and a later child, historical parent reads, cycle/tamper rejection, monotonic allocation after rollback, duplicate approval, rollback both directions, catalog recovery, stale discovery and actual audit version.

On the server snapshot old materials/rows/session metadata/container identities and credentials metadata without reading secrets. Check idle. Deploy reviewed code and run the full suite with TMPDIR inside project. Restart only project web process to load schema4-aware code, preserving old task containers. Approve existing verified proposal4530af22-d8d7-42f0-ac75-fec6ce851466 as actor hanwen-via-codex. Verify1.0.1 real controlled call, rollback1.0.0 and call, restore1.0.1 and call; final active1.0.1 with both packages/images retained. Use three fixed AACCGGGUUUA calls and literal output expectations;0 model calls,0 new candidate builds/revalidation. Read-only final verifier and detailed Chinese teaching document. Tests and real calls establish engineering behavior, not biological or self-evolution effectiveness.
