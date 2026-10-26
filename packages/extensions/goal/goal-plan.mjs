export const GOAL_PLAN_PROTOCOL = 'sirna-goal-plan/v1';

function normalizedText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

export function deriveGoalPlan(objective) {
  if (typeof objective !== 'string') throw new Error('objective must be text');
  const normalized = objective.replace(/\r\n?/g, '\n').trim();
  if (!normalized || normalized.length > 4000) throw new Error('objective must contain 1 to 4000 characters');
  let segments = normalized
    .replace(/(?:^|\n)\s*(?:[-*]|\d+[.)、])\s*/g, '\n')
    .split(/(?:\n+|[。！？!?；;]+|\s+(?:并且|此外|同时|最终|然后|以及|还要|and then|also)\s*)/iu)
    .map(normalizedText).filter(Boolean);
  if (segments.length <= 1 && /(?:工具|tool|黑盒|black[ -]?box)/iu.test(normalized)
      && /(?:创建|开发|实现|构建|提案|注册|build|implement|create|propose)/iu.test(normalized)) {
    segments = [
      `明确工具接口和验收标准：${normalizedText(normalized)}`,
      '实现候选工具并运行本地测试',
      '提交工具提案并通过隔离验证',
      '通过 MCP 端到端调用并记录结果',
    ];
  }
  const unique = [...new Set((segments.length ? segments : [normalizedText(normalized)]))].slice(0, 12);
  return {
    protocolVersion: GOAL_PLAN_PROTOCOL,
    items: unique.map((description, index) => ({
      id: `step-${index + 1}`, description, required: true, status: 'pending',
    })),
  };
}

export function parseGoalPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {protocolVersion: GOAL_PLAN_PROTOCOL, items: []};
  }
  const items = [];
  const ids = new Set();
  for (const raw of (Array.isArray(value.items) ? value.items : []).slice(0, 50)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const description = typeof raw.description === 'string' ? normalizedText(raw.description) : '';
    if (!id || !description || ids.has(id) || !['pending', 'working', 'done', 'blocked'].includes(raw.status)) continue;
    ids.add(id);
    items.push({id, description, required: raw.required !== false, status: raw.status});
  }
  return {protocolVersion: GOAL_PLAN_PROTOCOL, items};
}

export function applyGoalProgress(plan, completedItemIds) {
  if (!Array.isArray(completedItemIds) || completedItemIds.length === 0) {
    throw new Error('completedItemIds must contain at least one Goal work item ID');
  }
  const known = new Set(plan.items.map(item => item.id));
  const unknown = completedItemIds.find(id => !known.has(id));
  if (unknown) throw new Error(`Unknown Goal work item: ${unknown}`);
  const completed = new Set(completedItemIds);
  return {...plan, items: plan.items.map(item => completed.has(item.id) ? {...item, status: 'done'} : item)};
}

export function pendingRequiredWorkItems(plan) {
  return plan.items.filter(item => item.required && item.status !== 'done');
}

export function formatGoalPlan(plan) {
  if (!plan.items.length) return '（没有结构化工作项；可直接执行目标）';
  return plan.items.map(item => `- [${item.status === 'done' ? '已完成' : item.status === 'blocked' ? '已阻塞' : '待完成'}] ${item.id}: ${item.description}`).join('\n');
}

