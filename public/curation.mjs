// Deliberately read-only: no polling and no model or tool execution.
export function createCurationPreviewPanel({ root, fetcher = fetch }) {
  const document = root.ownerDocument;
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  const heading = node('h2', '工具使用线索 · 只读预览');
  const identity = node('p', '', 'help curation-identity');
  const button = node('button', '读取本轮预览', 'button secondary'); button.type = 'button';
  const status = node('p', '', 'help'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const explanation = node('p', '这是确定性规则筛出的使用线索，不是模型建议，也不是模型候选；不会登记、构建或批准工具。不是冻结证据。筛选门槛：同类完整业务调用至少 3 次且输入至少 2 种，或错误至少 2 次；既有工具不进入线索。普通文件读写和控制、验证、MCP 元操作排除。', 'help');
  const privacy = node('p', '仅对常见敏感字段做脱敏，不是完整隐私保证；任意私密文本仍可能出现，请谨慎分享。', 'help');
  const result = node('div');
  root.replaceChildren(heading, identity, button, status, explanation, privacy, result);
  let task = null, key = '', generation = 0, controller = null, loading = false;
  function idleMessage() { return !task ? '选择任务后，可手动读取已结束的一轮。' : task.status === 'running' || task.status === 'pending' ? '本轮仍在运行或等待，结束后才能读取。' : '尚未读取。点击按钮只读取保存记录，不运行模型或工具。'; }
  function controls() {
    button.disabled = !task || ['running', 'pending'].includes(task.status) || loading;
    button.textContent = loading ? '读取中…' : '读取本轮预览';
    root.setAttribute('aria-busy', String(loading));
  }
  function raw(label, value) {
    const details = node('details'); details.append(node('summary', label));
    const pre = node('pre', typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'curation-raw');
    pre.tabIndex = 0; details.append(pre); return details;
  }
  function render(preview) {
    const s = preview.summary, limits = preview.limits;
    result.append(raw('任务目标（保存记录摘要）', preview.objective ?? '未记录'));
    result.append(node('p', `规则筛选：${preview.eligibleForReview ? '存在达到门槛的线索，仍需审查' : '没有达到门槛的线索，不表示没有可改进之处'}。`));
    result.append(node('p', `工具开始 ${s.toolStarts}；纳入业务调用 ${s.consideredCalls}；排除 ${s.excludedCalls}；不完整 ${s.incompleteCalls}；调用窗口外省略 ${s.omittedCalls}。`));
    result.append(node('p', `显示窗口最多 ${limits.maxCalls} 条调用；线索省略 ${limits.omittedSignals} 项；${limits.displayTruncated ? '显示已截断' : '显示未截断'}。证据可能在窗口外，不能只凭可见预览作完整判断。`));
    if (Array.isArray(preview.excludedCalls)) {
      const excluded = node('details'); excluded.append(node('summary', `被排除的调用（显示 ${preview.excludedCalls.length} 条）`));
      excluded.append(node('p', `排除记录另省略 ${limits.omittedExcludedCalls ?? 0} 条；此列表只显示名称、事件编号和排除原因。`));
      const reasons = { file_operation: '文件读写', governance_operation: '治理与控制', mcp_meta_operation: 'MCP 元操作', existing_tool: '既有工具' };
      const list = node('ul');
      for (const call of preview.excludedCalls) list.append(node('li', `${call.actualToolName} · 事件 ${call.startEventId} · ${reasons[call.reason] || '未纳入业务调用筛选'}`));
      excluded.append(list); result.append(excluded);
    }
    result.append(node('h3', '达到门槛的能力线索'));
    if (!preview.signals.length) result.append(node('p', '本轮没有达到门槛的线索。'));
    for (const signal of preview.signals) {
      const item = node('article', undefined, 'curation-item');
      item.append(node('h4', signal.capabilityKey), node('p', `${signal.callCount} 次调用，${signal.distinctInputs} 种输入，${signal.errorCount} 次错误。`), node('p', `事件 ID：${signal.evidenceEventIds.join('、')}。${signal.evidenceComplete ? '依据在当前窗口完整可见。' : '窗口内证据不完整，部分依据未显示。'}`)); result.append(item);
    }
    result.append(node('h3', '业务调用窗口'));
    result.append(node('p', '“记录未报错”仅表示保存的工具记录未报告错误，不验证业务正确性。'));
    if (!preview.calls.length) result.append(node('p', '没有可显示的业务调用。'));
    for (const call of preview.calls) {
      const item = node('article', undefined, 'curation-item');
      item.append(node('h4', `${call.actualToolName}（记录名称：${call.reportedToolName}）`), node('p', `能力：${call.capabilityKey}；结果：${({ success: '记录未报错', error: '错误', unknown: '未知' })[call.outcome] || '未知'}。`), node('p', `调用 ID：${call.toolCallId}；开始事件：${call.startEventId}；结束事件：${call.endEventId ?? '缺失'}。`), node('p', `输入摘要：${call.inputSha256 ?? '输入不完整，未计算'}`));
      if (call.exclusionReason) item.append(node('p', '排除说明：记录缺失或冲突，未计入筛选。'));
      if (call.inputPreview !== undefined) item.append(raw('展开输入预览', call.inputPreview));
      if (call.outputPreview !== undefined) item.append(raw('展开输出预览', call.outputPreview));
      result.append(item);
    }
    const hashes = node('details'); hashes.append(node('summary', '摘要与记录绑定'));
    hashes.append(node('p', '摘要是已保存记录的规范化哈希，不是原始模型 provider 请求摘要；预览摘要覆盖当前预览内容。'), node('p', `用户消息：${preview.userMessageId}`), node('p', `保存记录 SHA-256：${preview.sourceSha256}`), node('p', `预览 SHA-256：${preview.previewSha256}`)); result.append(hashes);
  }
  async function refresh() {
    if (button.disabled) return;
    const current = task, version = ++generation;
    controller?.abort(); controller = new AbortController(); loading = true; result.replaceChildren(); controls(); status.textContent = '正在读取已保存的本轮工具记录…';
    try {
      const query = current.currentRunId ? `?runId=${encodeURIComponent(current.currentRunId)}` : '';
      const response = await fetcher(`/v1/tasks/${encodeURIComponent(current.id)}/curation-preview${query}`, { method: 'GET', cache: 'no-store', signal: controller.signal });
      if (version !== generation) return;
      if (!response.ok) throw new Error(({ 404: '任务或轮次不存在，请刷新任务记录。', 409: '本轮未结束或没有终态，请结束后再读取。', 413: '本轮记录过大，超出预览上限；不能把它解释为没有线索。', 503: '正式工具目录暂不可用，请稍后手动重试。' })[response.status] || `读取失败（HTTP ${response.status}），请稍后手动重试。`);
      const body = await response.json();
      if (version !== generation) return;
      if (body.preview === null && body.reason === 'no_run') { status.textContent = '本任务尚无执行轮次。'; return; }
      const preview = body.preview;
      if (preview?.protocolVersion !== 'sirna-tool-curation-preview/v1' || preview.taskId !== current.id || current.currentRunId && preview.runId !== current.currentRunId || !preview.summary || !preview.limits || !Array.isArray(preview.calls) || !Array.isArray(preview.signals)) throw new Error('预览与当前任务或轮次不匹配，或响应不完整；请刷新任务记录。');
      render(preview); status.textContent = '已读取本轮保存记录。这里只展示线索，没有创建工具候选。';
    } catch (error) {
      if (version === generation) { result.replaceChildren(); status.textContent = error instanceof Error ? error.message : '预览读取失败，请手动重试。'; }
    } finally { if (version === generation) { loading = false; controller = null; controls(); } }
  }
  function setTask(next) {
    const nextKey = JSON.stringify([next?.id ?? null, next?.currentRunId ?? null, next?.status ?? null]);
    if (nextKey === key) return;
    key = nextKey; task = next?.id ? { id: next.id, currentRunId: next.currentRunId, status: next.status } : null;
    generation++; controller?.abort(); controller = null; loading = false; result.replaceChildren();
    identity.textContent = task ? `当前任务：${task.id} · 轮次：${task.currentRunId || '尚无轮次'}` : '当前没有选择任务';
    status.textContent = idleMessage(); controls();
  }
  button.addEventListener('click', refresh); setTask(null);
  return { setTask, refresh };
}
