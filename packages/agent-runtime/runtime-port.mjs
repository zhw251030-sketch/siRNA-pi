/**
 * 实现原仓库 AgentRuntimePort 的 create/run/status/runtimeInfo 及 Compose 生命周期子集。
 * @typedef {{sessionId?: string, message: string}} ChatRequest
 * @typedef {{type: string, sessionId?: string, runId?: string, piSessionId?: string,
 *   backend?: string, status?: string, text?: string, delta?: string,
 *   toolCallId?: string, toolName?: string, args?: unknown, result?: unknown,
 *   isError?: boolean, error?: string}} ChatStreamEvent
 * @typedef {{create: Function, run: Function, status: Function, runtimeInfo: Function,
 *   describe: Function, cancel: Function, remove: Function}} AgentRuntimePort
 *
 * Task Core 只依赖这个边界。新任务使用 Agent Compose，旧任务保留 local-pi；
 * run(request, emit, signal) 接收本轮取消信号；cancel 请求停止，remove 确认释放。
 * describe 提供目录和 supportsLifecycle；旧 SDK 任务拒绝生命周期操作。
 * remove 保留工作文件，并非删除 sandbox 目录。不把容器创建或 Pi 细节放进 HTTP 路由。
 */
export {};
