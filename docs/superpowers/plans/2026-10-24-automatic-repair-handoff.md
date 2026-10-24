# Automatic validation failure to repair handoff

## Goal

Connect a failed validation produced by the current automatic Builder handoff to the existing trusted repair service. The bridge must remain opt-in, bounded, and manual at the approval boundary.

## Scope

- Add a small durable-terminal notification to the maintenance worker.
- Track only proposal IDs enqueued by this coordinator instance.
- When a business validation finishes with `passed:false`, use the existing repair service and its private verified feedback to request one repair turn.
- Keep `outcome_unknown`, infrastructure failure, Docker cleanup uncertainty, restart recovery, and passed validation out of automatic repair.
- Do not add a second repair database, a second repair prompt, automatic replacement validation, automatic approval, or historical scan.

## Files

- `packages/capability-platform/tool-maintenance-worker.mjs`
- `packages/extensions/tool-curation/tool-curation-coordinator.mjs`
- `apps/api/bootstrap.mjs`
- `tests/tool-maintenance.test.mjs`
- `tests/curation-coordinator-integration.test.mjs`
- `docs/36-自动验证失败触发受控修订.md`
- `README.md`, `docs/学习路线.md`, `packages/extensions/tool-curation/MODULE.md`

## Acceptance boundaries

1. The maintenance callback is emitted after terminal job persistence and contains only proposal/job/status/result identity and SHA fields.
2. Automatic repair is disabled by default and has its own bounded budget.
3. Only a current automatic validation proposal with `status=succeeded`, `passed=false`, `validationId`, and verified `reportSha256` can call `toolRepair.start()`.
4. A passed validation, unknown/infrastructure failure, cleanup uncertainty, no report, duplicate notification, stopped coordinator, or manual validation never starts repair.
5. Existing repair service remains responsible for source-task idle checks, frozen repair prompt, contract admission, lineage, three-attempt budget, restart interruption, and replacement supersede.

## Verification

- Run focused maintenance, coordinator, repair, and Builder suites.
- Run complete `npm test`.
- Run `git diff --check`.
- Commit and push only after the full suite and clean branch check pass.

## Status

- [x] Add maintenance terminal notification.
- [x] Add opt-in coordinator repair observation and bounded repair admission.
- [x] Reuse the existing repair service and its durable lineage checks.
- [x] Run the complete suite.
- [x] Commit and push after the full suite and clean branch check pass.
