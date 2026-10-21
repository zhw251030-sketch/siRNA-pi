import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {TaskStore} from '../packages/task-core/task-store.mjs';
import {ToolCurationStore} from '../packages/extensions/tool-curation/tool-curation-store.mjs';
import {createToolCurationService} from '../packages/extensions/tool-curation/tool-curation-service.mjs';
import {createToolCurationPreview} from '../packages/extensions/tool-curation/tool-curation-preview.mjs';
import {createAppServer} from '../apps/api/router.mjs';

async function fixture(t,{configured=true}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'curator-api-'));const taskStore=new TaskStore(path.join(root,'tasks.sqlite'));
  const store=new ToolCurationStore({root});let calls=0;
  const preview=createToolCurationPreview({taskStore,listExistingTools:()=>[]});
  const service=createToolCurationService({store,preview,curator:{async curate(run,signal,onStarted){calls++;const sessionId=randomUUID(),runId=randomUUID();onStarted(sessionId,runId);return {sessionId,runId,result:{protocolVersion:'sirna-tool-curation-result/v1',curationId:run.id,traceSha256:run.traceSha256,decision:'skip',summary:'No stable boundary.'}};}}});service.start();
  const server=createAppServer({taskStore,agentRuntime:{runtimeInfo:()=>({})},...(configured?{toolCuration:service}:{})});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await service.stop();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});store.close();taskStore.close();fs.rmSync(root,{recursive:true,force:true});});
  const task=taskStore.createTask({id:randomUUID()});const {message}=taskStore.beginTurn(task.id,'review fixture');const runId=randomUUID();taskStore.updateExecution(task.id,{currentRunId:runId});
  for(let i=0;i<3;i++) {const toolCallId=`c-${i}`;taskStore.appendRunEvent(task.id,message.id,runId,'tool_start',{toolCallId,toolName:'fetch_dataset',args:{id:i}});taskStore.appendRunEvent(task.id,message.id,runId,'tool_end',{toolCallId,toolName:'fetch_dataset',result:{ok:true},isError:false});}
  taskStore.appendRunEvent(task.id,message.id,runId,'done',{status:'succeeded'});taskStore.appendAssistantMessage(task.id,'complete','complete');
  const p=preview.read(task.id).preview,binding={runId,sourceSha256:p.sourceSha256,previewSha256:p.previewSha256};
  const base=`http://127.0.0.1:${server.address().port}/v1/tasks/${task.id}/curations`;
  return {task,base,binding,service,calls:()=>calls,post:(body=binding,options={})=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json',...options.headers},body:typeof body==='string'?body:JSON.stringify(body)})};
}

test('curation HTTP admits once, lists safe summaries and returns task-bound frozen detail',async t=>{
  const f=await fixture(t);const response=await f.post();assert.equal(response.status,202);const first=await response.json();
  const duplicate=await f.post();assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).curation.id,first.curation.id);
  await f.service.stop();assert.equal(f.calls(),1);
  const list=await(await fetch(f.base)).json();assert.equal(list.curations.length,1);assert.equal(list.curations[0].trace,undefined);
  const detail=await(await fetch(`${f.base}/${first.curation.id}`)).json();assert.equal(detail.curation.status,'skipped');assert.ok(detail.curation.traceSha256);assert.ok(detail.curation.trace);
  assert.equal((await fetch(f.base.replace(f.task.id,randomUUID())+`/${first.curation.id}`)).status,404);
});
test('curation HTTP enforces exact binding, limits, origin and safe failures',async t=>{
  const f=await fixture(t);
  for(const body of [{...f.binding,prompt:'PRIVATE'}, {...f.binding,runId:undefined}, {...f.binding,previewSha256:'x'}])assert.equal((await f.post(body)).status,400);
  assert.equal((await f.post({...f.binding,previewSha256:'a'.repeat(64)})).status,409);
  assert.equal((await f.post(' '.repeat(4097))).status,413);
  assert.equal((await f.post(f.binding,{headers:{Origin:'https://external.example'}})).status,403);
  assert.equal((await fetch(f.base+'?extra=1')).status,400);
  assert.equal((await fetch(f.base.replace(f.task.id,randomUUID()))).status,404);assert.equal(f.calls(),0);
  await f.service.stop();const unavailable=await f.post();assert.equal(unavailable.status,503);assert.ok(!(await unavailable.text()).includes('PRIVATE'));
});
test('curation HTTP without service is unavailable, never invokes task runtime',async t=>{
  const f=await fixture(t,{configured:false});assert.equal((await f.post()).status,503);assert.equal((await fetch(f.base)).status,503);assert.equal(f.calls(),0);
});
