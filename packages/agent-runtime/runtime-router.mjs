// New tasks use Compose. Existing SDK records retain their own context and files.
export class RuntimeRouter {
  constructor({ compose, legacy }) { this.compose = compose; this.legacy = legacy; }
  runtimeInfo() { return this.compose.runtimeInfo(); }
  create() { return this.compose.create(); }
  async runtime(id) {
    if (this.compose.owns(id)) return this.compose;
    await this.legacy.status(id); // Missing or invalid records must not become new SDK sessions.
    return this.legacy;
  }
  async status(id) { return (await this.runtime(id)).status(id); }
  async run(request, emit) { return (await this.runtime(request.sessionId)).run(request, emit); }
  async describe(id) {
    const runtime = await this.runtime(id);
    if (runtime === this.compose) return runtime.describe(id);
    const session = await runtime.status(id);
    return { backend: 'local-pi', workspacePath: `workspaces/web/${id}`,
      eventLogPath: session.currentRunId ? `runtime/web/${id}.${session.currentRunId}.events.jsonl` : null };
  }
}
