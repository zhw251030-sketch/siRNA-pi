# Agent Tool Builder Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. User requires main only. Root owns commit, remote actions and teaching docs. Preserve private runtime evidence.

**Goal:** Expose the reference's six Agent build/proposal operations and verify a real submitted candidate through host MCP.

**Architecture:** A controller owns isolated mutable build sessions, packages declared source into clean immutable images, and registers proposals; a dedicated stdio adapter exposes original tool names. Existing approved calls/web remain unchanged.

**Tech Stack:** Existing Node24 ESM, node:test, MCP SDK, project Docker and SQLite; no dependencies.

**Spec:** docs/superpowers/specs/2026-10-21-agent-tool-builder-design.md

## Global Constraints

- Personal main only, base07f605c6d2fa22960958dfe83ea2d0ae05d75013; reference67d2754 read-only.
- Remote only/home/hanwen/Project/project/siNRA-pi; no secrets output/copy, no system changes/model calls.
- Node/no dependencies/no_external_access/exact; fixed main.mjs and runtime command; shell inside owned container as65534, clean source-only finalization.
- Six original names/parameter shapes, bounded inputs, explicit session ownership/state, no web/Curator/automatic validation/approval.
- Preserve currentactive1.0.1 and every old material/task/container. Private evidence survives failures and is not committed.
- Tests only in controlled temporary roots; CLI subprocesses MUST set explicit temporary cwd, never inherit production checkout.

## Task1: Session controller, AgentTools and stdio host adapter

Files: new packages/capability-platform/tool-build-sessions.mjs, optional focused tool-build-runtime.mjs shared helper; existing tool-build-service.mjs minimal extraction/reuse. New packages/domain/sirna-tools/tool-builder-tools.mjs, apps/mcp/tool-builder-server.mjs, scripts/tool-builder-mcp.mjs. Reuse scripts/lib/tool-build-files.mjs for private evidence or narrowly improve shared journal writing if needed. New tests/tool-build-sessions.test.mjs, tests/tool-builder-mcp.test.mjs and tests/helpers/tool-build-docker.mjs as needed; existing build-service tests only adapt shared double imports if justified. No docs outside task report, no git/remote operations.

Interfaces: createToolBuildSessionService({root,docker,ttlMs=300000,maxLiveSessions=4,maxSessions=32}) returns {create(),write({sessionId,path,content}),run({sessionId,command,timeoutMs?}),cancel({sessionId}),finalize({sessionId,command}),propose(proposal),close()}. Public session includes id/state/createdAt, no hostpath/socket/containerId; finalize returns {artifact,...}; propose returns safe {proposalId,toolName,state,registered:true,verified:false,approved:false,activated:false}. createToolBuilderTools({service}) returns AgentTool descriptors. createToolBuilderMcpServer({service}) exposes those six tools, safe text results/errors and lifecycle drain. Existing signatures preserved.

- [x] RED controller: real temp evidence/registry with only external Docker fake; absent service initially fails consumer behavior. Assert successful create/write/run/finalize/propose has submitted row and zeroactive; second finalize and identical proposal return same identities.
  ```js
  assert.equal(saved.state,'submitted');
  assert.equal(registry.listActiveTools().length,0);
  assert.equal(repeated.proposalId,saved.proposalId);
  ```
- [x] GREEN bounded state/lifecycle and clean packaging. Reuse original build policy/ownership/image identity checks; host-provided source only reaches new image. Each mutation journaled before effects, failure diagnostics preserved. Do not fabricate verified/smoke-passed flags from successful shell alone.
- [x] RED/GREEN invalid transition/extra fields/linked evidence directories/unknownsession/wrongpath/sourcemismatch/artifactforgery/prewriteparent failure; no registration before finalized artifact. Concurrent operations refuse; timeout/TTL/cancel/close preserve confirmed/unknown cleanup distinction. A controlled nonroot shell change to transient files must not enter final image. Real filesystem effects and registry exercised.
- [x] MCP integration using actual SDK in-memory transport. Literal six tool names/schema fields, complete create→proposal sequence, safe failures/no diagnostics leak, busy and EOF/signal lifecycle. Test explicit tempcwd hostguard regardless of OS.
- [x] Focused tests until green, then one full frozen node --test --test-reporter=spec tests/*.test.mjs. Write runtime/agent-builder-task1-report.md with RED/GREEN, files, limitations and exact results; freeze for root review.

## Task2: Real protocol exercise, preservation and teaching

Root owns private runtime/agent-builder-* scripts and receipts, scripts/verify-agent-tool-builder.mjs readonly, example06 controlled Node candidate, docs23/readme/route/AGENTS.

- [x] Snapshot clean three places and old immutable/state data; transfer exact reviewed code after no-unrelated-change checks; full Linux test with TMPDIR insideproject.
- [x] Task1 independent spec/quality review, fix/review before real build. Ops review of one-time exercise/readonly verifier. No web restart needed for separate stdio service.
- [x] Create/write/run/finalize/propose via same MCPclient, literal inputoutput; artifact executed once in fresh existing runner. Cancel secondsession. Failedarguments do not mutate existing state. Verify exact newproposal submitted, zero newvalidations/versions/approvedcalls, old catalog1.0.1 unchanged, images/source/audits and no orphan containers.
- [x] Explain files/choices/real results in docs23; update current summaries; final independent review. Final Chinese explanation includes reference alignment, stricter subset and unfinished web/Curator integration.

Delivery follows the reviewed commit: push main, transfer its exact Git bundle and verify clean identical local/GitHub/server heads. Commit-dependent completion evidence is saved separately in ignored `runtime/agent-builder-sync.json` and `runtime/agent-builder-post-sync.json`, so this pre-commit plan does not assert a future commit ID.

Execution record: 18 new tests. Initial Linux teardown failures were test-only POSIX cleanup, corrected with bounded temporary-root cleanup; original failures retained. Final Linux1041/1039pass2skip, Windows full1041/1028pass13skip plus corrected18focused; production unchanged after first full test. Real MCP one-time exercise created submitted proposal f94f2783-6dd5-4dfe-b725-3efd24764cc2, one image, one event, five temporary containers removed, zero model/validation/approval calls. Original active1.0.1 and all prior data preserved. Independent implementation/operations/final reviews passed; docs23 records scope and evidence.
