// A streaming send owns `busy`; lifecycle requests must be able to run beside it.
export function lifecycleControls({ task, execution, busy = false, lifecycleBusy = false, stopRequested = false }) {
  const supported = execution?.backend === 'agent-compose' && execution.supportsLifecycle !== false;
  if (!task || !supported || lifecycleBusy || task.status === 'stopped') return { canStop: false, canEnd: false };
  return {
    canStop: !stopRequested && (task.status === 'running' || execution.stopUnconfirmed === true),
    canEnd: task.status === 'running' || (!busy && ['idle', 'failed'].includes(task.status)),
  };
}

// End is permanent even if an earlier stream save arrives after its response.
export function mergeTaskState(previous, incoming) {
  if (previous?.id === incoming?.id && previous.status === 'stopped') {
    return { ...previous, ...incoming, status: 'stopped', updatedAt: previous.updatedAt };
  }
  if (previous?.id === incoming?.id && Date.parse(previous.updatedAt) > Date.parse(incoming.updatedAt)) return previous;
  return incoming;
}

export function pendingDisposition(pending, task, messages = []) {
  if (!pending || pending.taskId !== task?.id || task.status === 'running') return 'keep';
  if (messages.some(message => message.clientRequestId === pending.requestId)) return 'clear';
  return task.status === 'stopped' ? 'archive' : 'keep';
}
