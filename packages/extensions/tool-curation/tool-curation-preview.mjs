import {buildCurationPreview} from './tool-curation-trace.mjs';

// Independent, read-only first stage of reference tool-curation-coordinator
// (67d2754). This does not persist a frozen trace or dispatch a Curator agent.
export class ToolCurationPreviewError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}
const fail = (status, message) => { throw new ToolCurationPreviewError(status, message); };
// Legacy SDK runs use UUIDs; Agent Compose returns 64-digit hex run IDs.
const runIdentity = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$/i;
function hasCompletedEvidence(events) {
  if (!Array.isArray(events)) return false;
  const terminal = events.findLastIndex(event => ['done', 'error'].includes(event.type));
  // TaskMessageService archives workspace files after execution ends. Those
  // two public notifications may follow the terminal event; business events may not.
  return terminal >= 0 && events.slice(terminal + 1).every(event => event.type === 'progress_message' &&
    ['workspace_synced', 'workspace_warning'].includes(event.payload?.type));
}

export function createToolCurationPreview({taskStore, listExistingTools, listGapReports}) {
  function snapshot(taskId, requestedRunId) {
      if (requestedRunId !== undefined && !runIdentity.test(requestedRunId)) fail(400, 'runId 必须是已保存的 SDK UUID 或 Compose 轮次编号。');
      const task = taskStore.getTask(taskId);
      if (!task) fail(404, '没有找到这个任务。');
      if (task.status === 'running') fail(409, '任务正在运行，请等待本轮结束后查看预览。');
      const runId = requestedRunId ?? task.currentRunId;
      if (!runId) return {preview: null, reason: 'no_run'};
      let source;
      try { source = taskStore.readRunEvidence(task.id, runId); }
      catch { fail(409, '这轮保存的记录无法一致读取，不能生成预览。'); }
      if (!source) fail(404, '这个任务中没有该轮的记录。');
      if (source.tooLarge) fail(413, '这轮记录超过 2000 条或 4 MiB 的读取上限，未进行部分筛选。');
      if (source.inconsistent || source.userMessage?.role !== 'user' ||
          !hasCompletedEvidence(source.events)) {
        fail(409, '这轮缺少一致的用户消息或结束记录，暂不能生成预览。');
      }
      let existingTools, rawExistingTools;
      try {
        existingTools = listExistingTools();
        if (!Array.isArray(existingTools) || existingTools.length > 500 ||
            existingTools.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(name))) throw Error('Invalid tool names');
        rawExistingTools = [...existingTools];
        // Freeze exactly the canonical catalog represented by the 11A source
        // digest: namespace aliases, duplicates and order are not identity.
        existingTools = [...new Set(existingTools.map(name => name.replace(/^sirna_tools_/, '')).filter(Boolean))].sort();
      } catch { fail(503, '当前正式工具目录无法核验，预览暂不可用。'); }
      try {
        const gapReports=listGapReports?listGapReports(task.id,runId):[];
        if(!Array.isArray(gapReports))throw Error('Gap evidence is unavailable');
        return {preview: buildCurationPreview({taskId: task.id, runId, userMessageId: source.userMessage.id,
          objective: source.userMessage.content, events: source.events, existingTools: rawExistingTools,gapReports}), existingTools, events: source.events};
      } catch(error) {
        if(error instanceof RangeError||error.statusCode===413)fail(413,'这轮缺口证据超过完整预览上限，不能部分预览。');
        if(error.statusCode===503)fail(503,'这轮缺口存储暂不可用。');
        fail(409, '这轮工具证据存在冲突或不支持的记录，不能生成可靠预览。');
      }
    }
  return {
    snapshot,
    read(taskId, runId) {
      const result = snapshot(taskId, runId);
      return result.preview ? {preview: result.preview} : {preview: null, reason: result.reason};
    },
  };
}
