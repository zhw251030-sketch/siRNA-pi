# Approved Tool Call Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Discover approved versions, execute the pinned candidate in a fresh restricted container, persist truthful audit, and verify through host stdio MCP.

**Architecture:** Existing catalog/registry/package/report checks anchor identity. A new AgentTool adapter reuses the candidate Docker runner; host MCP exposes only business content. Guest HTTP bridge remains the next learning step.

**Tech Stack:** Node24, node:sqlite, existing MCP SDK1.30.0, existing project rootless Docker.

**Spec:** docs/superpowers/specs/2026-10-21-approved-tool-call-design.md

## Global Constraints

- Personal main only; baseline2b0fceaf7ff1fdf1a2ad921b3925c12ebb1a971a. Root commits all reviewed work together.
- Only /home/hanwen/Project/project/siNRA-pi remotely; credentials never read/copied/output.
- No dependency, database schema, image, guest config, network listener or service changes.
- Node/no declared dependencies/no_external_access/exact; input JSON<=65536bytes, UUIDv4 calls; file transfers explicitly rejected.
- Preserve original source/report/version/approval; real accepted call is not another validation or proof of scientific efficacy.
- Retain private evidence under runtime; apply_patch text edits. No worker subagents or commits.

### Task 1: Discovery, execution and audit

Files create packages/capability-platform/tool-approved-execution.mjs, tool-run-audit.mjs, tests/tool-approved-execution.test.mjs, tests/tool-run-audit.test.mjs; modify tool-validation-runner.mjs and its focused tests only.

Interfaces: discoverApprovedTools({root,runner}) => {tools,packages,rejected}; tool.execute(toolCallId,{input},signal) => {content:[{type:'text',text:JSON.stringify(output)}],details:{output,workerFiles:[],auditPath,packageSha256,approvedTool:true}}. runner.run contract and audit fields are in spec. Choose audit helper API internally; root Task2 only depends on discovery API. Export validateApprovedToolArguments(args) returning a defensive input copy for MCP/service reuse; service always validates itself.

- [x] Write failing tests with approvalFixture, approveRegisteredToolProposal and real DockerBoundary. Hand expected outputs. At minimum:
```js
const d=discoverApprovedTools({root,runner});
assert.equal(d.tools[0].name,'summarize_target_sequence');
const r=await d.tools[0].execute(randomUUID(),{input:{sequence:'AC'}});
assert.deepEqual(JSON.parse(r.content[0].text),{length:2,gcFraction:0.5});
assert.equal(JSON.parse(fs.readFileSync(r.details.auditPath)).success,true);
```
- [x] Run focused tests RED; missing export is expected initially. Add behavior tests before implementing each validation/failure branch: absent registry no writes; submitted excluded; corrupted/stale catalog/package refused before Docker; unsupported args and abort-before no execution; failed runtime and post-execution tamper audited false; writer links/overwrite and request durability; successful output and no raw input/output in audit; bounded cleanup errors.
- [x] Implement minimal isolated helpers, using existing getRegisteredToolCatalog/getRegisteredToolVersion/readToolProposal. Add purpose to runner with unchanged validation default and explicit approved labels/events; reject unknown purpose. Real runner still always checks image/source before business execution.
- [x] Run focused GREEN including existing validation runner tests. Record exact commands/counts and RED evidence in runtime/approved-call-task1-report.md; do not run whole suite or change other files.

### Task 2: Host MCP adapter and trusted entry

Files create apps/mcp/approved-server.mjs, scripts/approved-tools-mcp.mjs, tests/approved-mcp.test.mjs; modify package.json command only. Root-owned integration may proceed in parallel after interface fixed, no overlap Task1 files.

Interface createApprovedMcpServer({discover}) returns Server; callback returns Task1 discovery result (sync or async). Each list/call loads fresh. Merge createSirnaTools; collisions fail. Serial approved call guard. Existing fixed server unchanged. Script explicitly creates DockerEngineClient(projectSocket), createDockerValidationRunner({purpose:'approved-call'}), discovery callback, stdio server. It takes no args, validates exact trusted host root/user/Linux/socket, umask0077. npm run tools:mcp runs it.

- [x] Write MCP tests using InMemoryTransport and real fixtures for argument/result identity; unknown/tool failures return isError, success strips details; stale loading and fixed names protected; concurrent active tool rejected busy. Run RED before code.
- [x] Implement with existing SDK Server/ListTools/CallTools and no polling claim. No dynamic module dependency introduced in old guest server.
- [x] Run MCP focused GREEN and old sirna-mcp tests; capture report runtime/approved-call-task2-report.md.

### Task 3: Review, actual Linux MCP acceptance and learning handoff

- [x] Read each task diff/reports, independent spec+quality review and scoped fixes. Finish whole integration review before official execution.
- [x] Run npm test locally and project Node tests on Linux with TMPDIR under runtime. Preserve stdout/stderr logs privately.
- [x] Transfer only own new/changed files after comparing remote baseline. Save old session/container/material/catalog/DB metadata; use actual stdio MCP SDK client to list and call summarize_target_sequence with {input:{sequence:'AACCGGTTAA'}} => {length:10,gcFraction:0.4}, and {input:{sequence:'>demo\nGGCCAU'}} => {length:6,gcFraction:2/3}. No model, no retry. Invalid top-level input must be isError with zero new run/container. Audit hashes/version/source/image checked independently, all obtained temporary containers absent, old state unchanged.
- [x] Write docs/19-正式工具发现调用与审计.md and update README/learning route/personal AGENTS with actual evidence, limits and next guest HTTP bridge.
- [x] Prepare commit/push and safe bundle sync with dirty-content comparison; verified code, evidence and documentation ready. Actual three-SHA/clean/readback completion is recorded after commit in private runtime/approved-call-sync.json; detailed Chinese file walkthrough follows synchronization.
