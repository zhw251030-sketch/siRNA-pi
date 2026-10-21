import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import test from 'node:test';
import {TaskStore} from '../packages/task-core/task-store.mjs';
import {createAppServer} from '../apps/api/router.mjs';
import {createToolCurationPreview} from '../packages/extensions/tool-curation/tool-curation-preview.mjs';

async function fixture(t,{catalog=()=>[],configured=true}={}) {
  const parent=path.resolve('runtime/curation-tests');fs.mkdirSync(parent,{recursive:true});
  const dir=fs.mkdtempSync(path.join(parent,'case-'));const store=new TaskStore(path.join(dir,'tasks.sqlite'));
  let runtimeCalls=0;
  const runtime={runtimeInfo:()=>({backend:'test'}),describe:()=>{runtimeCalls++;throw Error('Must not inspect guests');},run:()=>{runtimeCalls++;throw Error('Must not run');}};
  const service=createToolCurationPreview({taskStore:store,listExistingTools:catalog});
  const server=createAppServer({taskStore:store,agentRuntime:runtime,...(configured?{toolCurationPreview:service}:{})});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(r=>{server.close(r);server.closeAllConnections();});store.close();assert.equal(path.dirname(dir),parent);fs.rmSync(dir,{recursive:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  function task(){return store.createTask({id:randomUUID()});}
  function run(task,{terminal=true,finish=true,runId=randomUUID()}={}) {
    const {message}=store.beginTurn(task.id,'比较不同输入的远端数据');store.updateExecution(task.id,{currentRunId:runId});
    for(let i=0;i<3;i++){
      const toolCallId=`call-${i}`;
      store.appendRunEvent(task.id,message.id,runId,'tool_start',{toolCallId,toolName:'fetch_dataset',args:{url:`https://example.org/data?n=${i}`}});
      store.appendRunEvent(task.id,message.id,runId,'tool_end',{toolCallId,toolName:'fetch_dataset',isError:false,result:{content:[{type:'text',text:'ok'}]}});
    }
    if(terminal)store.appendRunEvent(task.id,message.id,runId,'done',{status:'succeeded'});
    if(finish)store.appendAssistantMessage(task.id,'完成','complete');
    return {runId,message};
  }
  const snapshot=()=>JSON.stringify(store.listTasks().map(t=>[t,store.listMessages(t.id),store.listRunEvents(t.id)]));
  return {store,service,task,run,snapshot,calls:()=>runtimeCalls,get:(id,q='',init)=>fetch(`${base}/v1/tasks/${id}/curation-preview${q}`,init),base};
}

test('preview reads a completed run without modifying any task records or inspecting a guest',async t=>{
  const f=await fixture(t),task=f.task();const {runId}=f.run(task);const before=f.snapshot();
  const response=await f.get(task.id);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const {preview}=await response.json();assert.equal(preview.runId,runId);assert.equal(preview.eligibleForReview,true);assert.equal(preview.calls.length,3);
  assert.equal(f.snapshot(),before);assert.equal(f.calls(),0);
  assert.deepEqual(await(await f.get(task.id)).json(),{preview});
});

test('empty task is explicit; running and unfinished evidence are not accepted',async t=>{
  const f=await fixture(t),empty=f.task();assert.deepEqual(await(await f.get(empty.id)).json(),{preview:null,reason:'no_run'});
  const busy=f.task();f.run(busy,{finish:false});assert.equal((await f.get(busy.id)).status,409);
  const partial=f.task();f.run(partial,{terminal:false});assert.equal((await f.get(partial.id)).status,409);
  assert.equal((await f.get(randomUUID())).status,404);
});

test('explicit run cannot cross task boundaries; an earlier completed round can be read',async t=>{
  const f=await fixture(t),a=f.task(),b=f.task();const one=f.run(a),two=f.run(a);f.run(b);
  assert.equal((await f.get(b.id,`?runId=${one.runId}`)).status,404);
  const old=await(await f.get(a.id,`?runId=${one.runId}`)).json();assert.equal(old.preview.runId,one.runId);
  assert.equal((await(await f.get(a.id)).json()).preview.runId,two.runId);
});

test('explicit Compose SHA-256 run IDs work as well as legacy SDK UUIDs',async t=>{
  const f=await fixture(t),task=f.task();const {runId}=f.run(task,{runId:'e92e21ad478b53307a32e4b49fad239c58999976ef6cad12514ca096e251dbf4'});
  const response=await f.get(task.id,`?runId=${runId}`);assert.equal(response.status,200);
  assert.equal((await response.json()).preview.runId,runId);
  assert.equal((await f.get(task.id,`?runId=${'g'.repeat(64)}`)).status,400);
});

test('query validation, method and same-origin restrictions stay explicit',async t=>{
  const f=await fixture(t),task=f.task();const {runId}=f.run(task);
  for(const q of ['?runId=bad','?runId=','?extra=yes',`?runId=${runId}&runId=${runId}`])assert.equal((await f.get(task.id,q)).status,400);
  assert.equal((await f.get(task.id,'',{method:'POST'})).status,404);
  assert.equal((await f.get(task.id,'',{headers:{Origin:'https://example.org'}})).status,403);
  assert.equal((await fetch(f.base+'/curation.mjs')).status,200);
});

test('catalog unavailable is 503 and never degrades to an empty known-tool list',async t=>{
  const f=await fixture(t,{catalog:()=>{throw Error('PRIVATE_CATALOG_DETAIL');}}),task=f.task();f.run(task);
  const response=await f.get(task.id);assert.equal(response.status,503);assert.ok(!(await response.text()).includes('PRIVATE_CATALOG_DETAIL'));
});

test('missing preview service is 503',async t=>{
  const f=await fixture(t,{configured:false});assert.equal((await f.get(f.task().id)).status,503);
});

test('registered tool names exclude matches from the heuristic without executing them',async t=>{
  const f=await fixture(t,{catalog:()=>['fetch_dataset']}),task=f.task();f.run(task);
  assert.equal((await(await f.get(task.id)).json()).preview.eligibleForReview,false);assert.equal(f.calls(),0);
});

test('single-run reading caps event count before decoding JSON',async t=>{
  const f=await fixture(t),task=f.task();const {runId,message}=f.run(task);
  for(let i=0;i<1995;i++)f.store.appendRunEvent(task.id,message.id,runId,'progress_message',{text:'x'});
  assert.equal(f.store.readRunEvidence(task.id,runId).tooLarge,true);
  assert.equal((await f.get(task.id)).status,413);
});

test('single-run reading caps UTF-8 bytes, not only event count',async t=>{
  const f=await fixture(t),task=f.task();const {runId,message}=f.run(task);
  f.store.appendRunEvent(task.id,message.id,runId,'progress_message',{text:'数'.repeat(1_400_000)});
  assert.equal(f.store.readRunEvidence(task.id,runId).tooLarge,true);assert.equal((await f.get(task.id)).status,413);
});

test('mixed user message bindings in one run cannot form evidence',async t=>{
  const f=await fixture(t),task=f.task();const one=f.run(task),two=f.run(task);
  f.store.appendRunEvent(task.id,two.message.id,one.runId,'progress_message',{text:'wrong round'});
  assert.equal((await f.get(task.id,`?runId=${one.runId}`)).status,409);
});

test('TaskMessageService archive events after done preserve a completed round',async t=>{
  const f=await fixture(t);
  for(const type of ['workspace_synced','workspace_warning']) {
    const task=f.task();const {runId,message}=f.run(task);
    // TaskMessageService.#run stores collect() results after done under
    // progress_message while preserving their public event type in payload.
    f.store.appendRunEvent(task.id,message.id,runId,'progress_message',{type,runId});
    const response=await f.get(task.id);assert.equal(response.status,200);
    assert.equal((await response.json()).preview.eligibleForReview,true);
  }
  const task=f.task();const {runId,message}=f.run(task);
  f.store.appendRunEvent(task.id,message.id,runId,'tool_start',{toolName:'fetch_dataset',toolCallId:'late',args:{value:9}});
  assert.equal((await f.get(task.id)).status,409);
});
