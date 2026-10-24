# Persistent automatic replacement validation

## Goal

Match the reference repository's next lifecycle boundary: persist automatic tool runs, reconnect a repair replacement transactionally, and queue independent validation for that replacement after restart or a lost in-process callback.

## Scope

- [x] Add a dedicated SQLite automation store with bounded phases and lineage.
- [x] Emit a safe replacement terminal notification from the existing repair service.
- [x] Let the curation coordinator persist initial automatic validation runs and replacement runs.
- [x] Reconcile open persisted runs on each coordinator tick, so restart does not depend on process-local maps.
- [x] Reuse the existing maintenance validator and repair service; do not add automatic approval or publication.

## Acceptance boundaries

1. An initial automatic Builder submission creates one persisted `queued`/`validating` automation run.
2. A failed validation moves that run to `repairing` and then `awaiting_replacement` only after the existing repair service durably records its state.
3. A replacement proposal is accepted only when its trusted repair association matches the source task, tool name, predecessor, root proposal, and next attempt.
4. Registration supersedes the old automation run and inserts the replacement as `queued` in one SQLite transaction.
5. A replacement receives its own deterministic validation request key and is independently enqueued.
6. `listOpenRuns()` reconciliation can recover queued/validating/repairing/awaiting-replacement work after a process restart without scanning arbitrary historical proposals.
7. Passed validation, unknown infrastructure outcomes, manual proposals, duplicate callbacks, and mismatched artifacts never trigger repair or replacement validation.
8. No automatic approval, publication, second repair database, or raw diagnostic exposure is added.

## Verification

- [x] Add store and coordinator integration tests first.
- [x] Run focused automation, repair, maintenance, and curation suites.
- [x] Run complete `npm test`, `git diff --check`, commit, push, and verify local/remote equality.
