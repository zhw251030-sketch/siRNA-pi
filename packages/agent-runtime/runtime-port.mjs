/**
 * 实现原仓库 AgentRuntimePort 的 create/run/status/runtimeInfo 子集。
 * @typedef {{sessionId?: string, message: string}} ChatRequest
 * @typedef {{type: string, sessionId?: string, runId?: string, piSessionId?: string,
 *   backend?: string, status?: string, text?: string, delta?: string,
 *   toolCallId?: string, toolName?: string, args?: unknown, result?: unknown,
 *   isError?: boolean, error?: string}} ChatStreamEvent
 * @typedef {{create: Function, run: Function, status: Function, runtimeInfo: Function}} AgentRuntimePort
 *
 * Task Core 只依赖这个边界。新任务使用 Agent Compose，旧任务保留 local-pi；
 * describe 提供可选的任务目录元数据。不把容器创建或 Pi 细节放进 HTTP 路由。
 */
export {};
