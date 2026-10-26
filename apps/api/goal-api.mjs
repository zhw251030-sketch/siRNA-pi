function asBody(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('request body must be an object');
  const keys = Object.keys(input);
  const allowed = new Set(['action', 'objective', 'maxAutomaticTurns', 'additionalTurns', 'status', 'reason', 'completedItemIds', 'expectedRevision']);
  if (keys.some(key => !allowed.has(key))) throw new Error('unknown Goal request field');
  for (const key of ['maxAutomaticTurns', 'additionalTurns', 'expectedRevision']) {
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < 1)) throw new Error(`${key} must be a positive integer`);
  }
  if (input.objective !== undefined && typeof input.objective !== 'string') throw new Error('objective must be text');
  if (input.reason !== undefined && typeof input.reason !== 'string') throw new Error('reason must be text');
  if (input.status !== undefined && !['progress', 'complete', 'blocked'].includes(input.status)) throw new Error('invalid Goal update status');
  if (input.action !== undefined && !['pause', 'resume', 'agent_update'].includes(input.action)) throw new Error('invalid Goal action');
  if (input.completedItemIds !== undefined && (!Array.isArray(input.completedItemIds) || input.completedItemIds.length > 50 ||
      input.completedItemIds.some(item => typeof item !== 'string' || !item.trim() || item.length > 100))) {
    throw new Error('completedItemIds must contain at most 50 nonempty strings');
  }
  return input;
}

export function createGoalApi({taskStore, goalStore, readJsonBody, sendJson, appendObjective} = {}) {
  if (!taskStore || !goalStore || typeof readJsonBody !== 'function' || typeof sendJson !== 'function') {
    throw new TypeError('Goal API requires taskStore, goalStore, readJsonBody and sendJson');
  }
  return {
    get(taskId) { return goalStore.get(taskId) ?? null; },
    async handle(request, response, taskId) {
      const task = taskStore.getTask(taskId);
      if (!task) { sendJson(response, 404, {error: '没有找到这个任务。'}); return true; }
      try {
        if (request.method === 'GET') {
          sendJson(response, 200, {goal: goalStore.get(taskId) ?? null});
          return true;
        }
        if (request.method === 'POST') {
          if (task.status === 'stopped') throw new Error('已结束任务不能创建 Goal。');
          const input = asBody(await readJsonBody(request));
          if (input.action !== undefined || typeof input.objective !== 'string' || !input.objective.trim()) throw new Error('创建 Goal 需要 objective。');
          const goal = goalStore.create(taskId, input.objective, input.maxAutomaticTurns);
          let message;
          if (typeof appendObjective === 'function') {
            message = appendObjective(taskId, goal.objective, `goal-objective:${goal.goalId}`);
          }
          sendJson(response, 201, {goal, ...(message ? {message} : {})});
          return true;
        }
        if (request.method === 'PATCH') {
          const input = asBody(await readJsonBody(request));
          let goal;
          if (input.action === 'pause') goal = goalStore.pause(taskId);
          else if (input.action === 'resume') goal = goalStore.resume(taskId, input.additionalTurns);
          else if (input.action === 'agent_update') {
            if (!input.status) throw new Error('agent_update 需要 status。');
            goal = goalStore.updateFromAgent(taskId, input.status,
              input.status === 'progress' ? input.completedItemIds : input.reason,
              input.expectedRevision);
          } else throw new Error('PATCH 需要 action。');
          sendJson(response, 200, {goal});
          return true;
        }
        if (request.method === 'DELETE') {
          if (task.status === 'running') throw new Error('任务正在执行，不能清除 Goal。');
          sendJson(response, 200, {cleared: goalStore.clear(taskId), goal: null});
          return true;
        }
        response.writeHead(405, {allow: 'GET, POST, PATCH, DELETE'});
        response.end();
        return true;
      } catch (error) {
        sendJson(response, 409, {error: error instanceof Error ? error.message : String(error)});
        return true;
      }
    },
  };
}

