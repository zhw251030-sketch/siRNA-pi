import fs from 'node:fs';
import {randomUUID} from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function contextFrom(file) {
  if (typeof file !== 'string' || !file) throw new Error('Goal tools require taskContextPath');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || value.protocolVersion !== 'sirna-task-context/v1' || !uuid.test(value.taskId)) {
    throw new Error('Goal tools require a valid task context');
  }
  return value;
}
function textResult(value) {
  return {content: [{type: 'text', text: JSON.stringify(value, null, 2)}], details: value};
}
function schema(properties, required = []) {
  return {type: 'object', properties, required, additionalProperties: false};
}

export function createGoalTools({registryUrl, taskContextPath, fetchImpl = fetch} = {}) {
  const requestGoal = async (method, body) => {
    const context = contextFrom(taskContextPath);
    if (typeof registryUrl !== 'string' || !registryUrl) throw new Error('registryUrl is required for Goal tools');
    const response = await fetchImpl(`${registryUrl.replace(/\/$/, '')}/v1/tasks/${encodeURIComponent(context.taskId)}/goal`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${context.token}`,
        'x-sirna-task-id': context.taskId,
        'x-sirna-agent-turn-id': context.agentTurnId ?? '',
      },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = {error: raw || `Goal API returned HTTP ${response.status}`}; }
    if (!response.ok) throw new Error(payload?.error ? String(payload.error) : `Goal API returned HTTP ${response.status}`);
    return payload;
  };
  const getGoal = {
    name: 'get_goal', label: 'Get current Goal',
    description: 'Read the current task Goal, status, plan, revision and automatic-turn budget.',
    parameters: schema({}),
    executionMode: 'sequential',
    execute: async () => textResult(await requestGoal('GET')),
  };
  const createGoal = {
    name: 'create_goal', label: 'Create a Goal',
    description: 'Create a persisted Goal only when the user explicitly asks for autonomous continuation.',
    parameters: schema({
      objective: {type: 'string', minLength: 1, maxLength: 4000},
      maxAutomaticTurns: {type: 'integer', minimum: 1, maximum: 100},
    }, ['objective']),
    executionMode: 'sequential',
    execute: async (_id, params) => textResult(await requestGoal('POST', params)),
  };
  const updateGoal = {
    name: 'update_goal', label: 'Update current Goal',
    description: 'Submit real progress, a blocked reason, or a completion request; the backend gates completion on required plan items.',
    parameters: schema({
      status: {enum: ['progress', 'complete', 'blocked']},
      reason: {type: 'string', minLength: 1, maxLength: 2000},
      completedItemIds: {type: 'array', maxItems: 50, items: {type: 'string', minLength: 1, maxLength: 100}},
      expectedRevision: {type: 'integer', minimum: 1},
    }, ['status']),
    executionMode: 'sequential',
    execute: async (_id, params) => textResult(await requestGoal('PATCH', {action: 'agent_update', ...params})),
  };
  return [getGoal, createGoal, updateGoal];
}

