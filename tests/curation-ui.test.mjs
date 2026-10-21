import test from 'node:test';
import assert from 'node:assert/strict';
import { createCurationPreviewPanel } from '../public/curation.mjs';

class Element {
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.listeners = {}; this.dataset = {}; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('unsafe HTML'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
}
function harness(fetcher) {
  const document = { createElement: tag => new Element(tag, document) };
  const root = new Element('section', document);
  const panel = createCurationPreviewPanel({ root, fetcher });
  return { root, panel, button: root.children.find(child => child.tagName === 'button') };
}
const task = { id: 'task/a', currentRunId: 'run-1', status: 'idle' };
function preview(overrides = {}) {
  return { protocolVersion: 'sirna-tool-curation-preview/v1', taskId: task.id, runId: task.currentRunId, userMessageId: 'msg', objective: '<script>hello</script>', sourceSha256: 'source', previewSha256: 'preview', eligibleForReview: true,
    summary: { toolStarts: 4, consideredCalls: 3, excludedCalls: 1, incompleteCalls: 0, omittedCalls: 1 },
    calls: [{ startEventId: 'e1', endEventId: 'e2', toolCallId: 'c1', reportedToolName: 'mcp', actualToolName: '<img>', capabilityKey: 'network', inputPreview: '<script>input</script>', outputPreview: 'out', inputSha256: 'input-hash', outcome: 'success' }],
    signals: [{ capabilityKey: 'network', callCount: 3, distinctInputs: 2, errorCount: 0, evidenceEventIds: ['e1', 'missing'], evidenceComplete: false }], limits: { maxCalls: 12, omittedSignals: 2, displayTruncated: true }, ...overrides };
}
test('manual read only, unavailable selection and running task disable request', async () => {
  const calls = []; const h = harness(async (...args) => { calls.push(args); return Response.json({ preview: preview() }); });
  assert.equal(h.button.disabled, true); await h.panel.refresh();
  h.panel.setTask(task); assert.equal(calls.length, 0); assert.equal(h.button.disabled, false);
  await h.button.listeners.click(); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/v1/tasks/task%2Fa/curation-preview?runId=run-1'); assert.equal(calls[0][1].method, 'GET');
  h.panel.setTask({ ...task, status: 'running' }); assert.equal(h.button.disabled, true); await h.panel.refresh(); assert.equal(calls.length, 1);
});
test('renders safe evidence, limitations and beginner explanations as text', async () => {
  const h = harness(async () => Response.json({ preview: preview() })); h.panel.setTask(task); await h.panel.refresh();
  for (const text of ['<script>hello</script>', '<script>input</script>', '<img>', 'input-hash', 'e1', 'missing', '不是模型', '已保存记录', '隐私', '3 次', '2 种', '不是冻结证据', '窗口', '不完整']) assert.ok(h.root.textContent.includes(text), text);
  assert.ok(h.root.textContent.includes('省略 2'));
});
test('late task/run/status responses are discarded even when fetch ignores abort', async () => {
  for (const next of [{ ...task, id: 'other' }, { ...task, currentRunId: 'run-2' }, { ...task, status: 'running' }]) {
    let resolve, signal; const h = harness((_, options) => { signal = options.signal; return new Promise(r => resolve = r); });
    h.panel.setTask(task); const pending = h.panel.refresh(); h.panel.setTask(next); assert.equal(signal.aborted, true);
    resolve(Response.json({ preview: preview() })); await pending; assert.equal(h.root.textContent.includes('input-hash'), false);
  }
});
test('errors, no run and mismatched binding never become empty successful clues', async () => {
  for (const [response, expected] of [[Response.json({ error: '<bad>' }, { status: 413 }), '过大'], [Response.json({ preview: null, reason: 'no_run' }), '尚无'], [Response.json({ preview: preview({ runId: 'other' }) }), '不匹配']]) {
    const h = harness(async () => response); h.panel.setTask(task); await h.panel.refresh(); assert.ok(h.root.textContent.includes(expected)); assert.equal(h.button.disabled, false);
  }
});
test('loading excludes double request; same task state retains preview', async () => {
  let resolve, calls = 0; const h = harness(() => { calls++; return new Promise(r => resolve = r); }); h.panel.setTask(task);
  const pending = h.panel.refresh(); assert.equal(h.button.disabled, true); await h.panel.refresh(); assert.equal(calls, 1);
  resolve(Response.json({ preview: preview() })); await pending; h.panel.setTask({ ...task }); assert.ok(h.root.textContent.includes('input-hash'));
});
test('excluded calls teach concrete reasons without payload and success is only recorded status', async () => {
  const fixture = preview();
  fixture.calls[0].inputSha256 = null; fixture.calls[0].exclusionReason = 'conflicting_end';
  fixture.excludedCalls = ['file_operation', 'governance_operation', 'mcp_meta_operation', 'existing_tool'].map((reason, i) => ({ startEventId: `excluded-${i}`, actualToolName: `<tool-${i}>`, reason }));
  fixture.limits.omittedExcludedCalls = 3;
  const h = harness(async () => Response.json({ preview: fixture })); h.panel.setTask(task); await h.panel.refresh();
  for (const text of ['记录未报错', '不验证业务正确性', '记录缺失或冲突，未计入筛选', '输入不完整，未计算', '文件读写', '治理与控制', 'MCP 元操作', '既有工具', 'excluded-0', '<tool-0>', '排除记录另省略 3']) assert.ok(h.root.textContent.includes(text), text);
  assert.equal(h.root.textContent.includes('conflicting_end'), false);
  const details = h.root.children.flatMap(child => child.children).find(child => child.tagName === 'details' && child.textContent.includes('excluded-0'));
  assert.ok(details); assert.notEqual(details.open, true);
});

function buttons(h){return h.root.children.filter(child=>child.tagName==='button');}
test('review is explicit only after a complete signal preview and submits exact immutable binding',async()=>{
  const calls=[];const p=preview({signals:[{capabilityKey:'network',callCount:3,distinctInputs:2,errorCount:0,evidenceEventIds:['e1'],evidenceComplete:true}]});
  const h=harness(async(url,options)=>{calls.push([url,options]);return Response.json(options.method==='POST'?{curation:{id:'review-1',status:'waiting',traceSha256:'trace-hash'}}:{preview:p});});
  h.panel.setTask(task);const submit=buttons(h).find(b=>b.textContent==='提交独立审查（调用模型）');assert.ok(submit);assert.equal(submit.disabled,true);
  await h.panel.refresh();assert.equal(submit.disabled,false);assert.equal(calls.length,1);
  await submit.listeners.click();assert.equal(calls.length,2);assert.equal(calls[1][1].method,'POST');
  assert.deepEqual(JSON.parse(calls[1][1].body),{runId:'run-1',sourceSha256:'source',previewSha256:'preview'});
  assert.equal(calls[1][0],'/v1/tasks/task%2Fa/curations');assert.ok(h.root.textContent.includes('trace-hash'));assert.ok(h.root.textContent.includes('等待'));
  h.panel.setTask({...task,id:'other'});assert.equal(submit.disabled,true);assert.equal(h.root.textContent.includes('trace-hash'),false);
});
test('incomplete signals cannot enable review; records refresh is manual and safely renders advisory detail',async()=>{
  const calls=[];const h=harness(async(url,options)=>{calls.push(url);return Response.json(url.endsWith('/review-1')?{curation:{id:'review-1',status:'candidate',traceSha256:'frozen',result:{decision:'candidate',summary:'<img onerror=x>',candidate:{suggestedToolName:'example_tool',evidenceEventIds:['e1'],permissions:{profile:'no_external_access'}}}}}:url.endsWith('/curations')?{curations:[{id:'review-1',status:'candidate',traceSha256:'frozen'}]}:{preview:preview()});});
  h.panel.setTask(task);await h.panel.refresh();assert.equal(buttons(h).find(b=>b.textContent==='提交独立审查（调用模型）').disabled,true);
  const refresh=buttons(h).find(b=>b.textContent==='刷新审查记录');assert.ok(refresh);assert.equal(calls.length,1);await refresh.listeners.click();assert.equal(calls.length,2);
  const reviews=h.root.children.at(-1);const detailButton=reviews.children.flatMap(c=>c.children).find(c=>c.tagName==='button');assert.ok(detailButton);await detailButton.listeners.click();
  for(const text of ['<img onerror=x>','example_tool','e1','no_external_access','frozen','建议','不授予权限'])assert.ok(h.root.textContent.includes(text),text);
  assert.equal(calls.length,3);
});
test('late review POST and detail JSON never overwrite a newly selected task',async()=>{
  const p=preview({signals:[{capabilityKey:'network',evidenceEventIds:['e1'],evidenceComplete:true}]});let finish;
  const h=harness(async(url,options)=>options.method==='POST'?{ok:true,json:()=>new Promise(resolve=>finish=resolve)}:Response.json({preview:p}));
  h.panel.setTask(task);await h.panel.refresh();const pending=buttons(h).find(b=>b.textContent==='提交独立审查（调用模型）').listeners.click();
  while(!finish)await Promise.resolve();h.panel.setTask({...task,id:'other'});finish({curation:{id:'old-review',status:'waiting',traceSha256:'stale-hash'}});await pending;
  assert.equal(h.root.textContent.includes('stale-hash'),false);assert.equal(h.root.textContent.includes('old-review'),false);
});
