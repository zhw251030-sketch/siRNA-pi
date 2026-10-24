import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {TaskStore} from '../packages/task-core/task-store.mjs';
import {TaskMessageService} from '../packages/task-core/task-message-service.mjs';
import {ToolCurationStore} from '../packages/extensions/tool-curation/tool-curation-store.mjs';
import {ToolCurationBuildStore} from '../packages/extensions/tool-curation/tool-curation-build-store.mjs';
import {createToolCurationBuildService} from '../packages/extensions/tool-curation/tool-curation-build-service.mjs';
import {traceSha256} from '../packages/extensions/tool-curation/tool-curation-evidence.mjs';
import {createAppServer} from '../apps/api/router.mjs';

async function fixture(t,{configured=true,onSettled}={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'curation-build-api-')));
  const tasks=new TaskStore(path.join(root,'tasks.sqlite')),curations=new ToolCurationStore({root}),store=new ToolCurationBuildStore({root});
  const task=tasks.createTask({id:randomUUID()}),id=randomUUID();let runs=0;
  const trace={protocolVersion:'sirna-tool-curation-trace/v1',curationId:id,trigger:'post_run',taskId:task.id,runId:randomUUID(),userMessageId:randomUUID(),sourceSha256:'b'.repeat(64),previewSha256:'c'.repeat(64),existingTools:[],signals:[{evidenceComplete:true,capabilityKey:'shape',evidenceEventIds:[1,2]}]};
  trace.traceSha256=traceSha256(trace);curations.create(trace);curations.markRunning(id);
  curations.complete(id,{protocolVersion:'sirna-tool-curation-result/v1',curationId:id,traceSha256:trace.traceSha256,decision:'candidate',summary:'Reusable shape',candidate:{capabilityKey:'shape',suggestedToolName:'shape_tool',capabilityBoundary:'Shapes only',whyExistingToolsAreInsufficient:'No equivalent',evidenceEventIds:[1,2],inputContractSketch:{n:'number'},outputContractSketch:{n:'number'},permissions:{profile:'no_external_access'},buildInstructions:['test shapes']}});
  const runtime={runtimeInfo:()=>({}),describe:async()=>({backend:'agent-compose',sandboxId:'a'.repeat(64),supportsLifecycle:true,builderToolsAvailable:true}),assertWorkspaceIdle:async()=>{},run:async(input,emit)=>{runs++;const runId=randomUUID();emit({type:'run_status',status:'running',runId});emit({type:'text_delta',delta:'No proposal submitted.'});emit({type:'done',status:'succeeded',runId});}};
  const messages=new TaskMessageService({taskStore:tasks,agentRuntime:runtime});
  const service=createToolCurationBuildService({root,store,curationStore:curations,taskStore:tasks,taskMessages:messages,agentRuntime:runtime,listExistingTools:()=>[],onSettled});
  const server=createAppServer({taskStore:tasks,agentRuntime:runtime,taskMessages:messages,...(configured?{toolCurationBuild:service}:{})});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await service.stop();await server.waitForTaskCompletion();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});store.close();curations.close();tasks.close();fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,url=`${base}/v1/tasks/${task.id}/curations/${id}/build`;
  return {task,id,tasks,service,runtime,url,base,runs:()=>runs,post:(body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)})};
}

test('explicit build HTTP reads without dispatch and keeps one durable task turn across repeat POSTs',async t=>{
  const f=await fixture(t),response=await fetch(f.url);assert.equal(response.status,200);
  const view=await response.json();assert.equal(view.eligible,true);assert.equal(f.runs(),0);assert.equal(f.tasks.listMessages(f.task.id).length,0);
  const first=await f.post(view.binding);assert.equal(first.status,202);const ticket=(await first.json()).handoff;assert.equal(ticket.curationId,f.id);
  await f.service.stop();const duplicate=await f.post(view.binding);assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).handoff.requestId,ticket.requestId);
  const saved=await(await fetch(f.url)).json();assert.equal(saved.handoff.phase,'no_proposal');assert.equal(saved.eligible,false);assert.equal(f.runs(),1);assert.equal(f.tasks.listMessages(f.task.id).length,2);
});

test('Builder settled callback is a small durable terminal notification',async t=>{
  const notifications=[];const f=await fixture(t,{onSettled:value=>notifications.push(value)}),view=await(await fetch(f.url)).json();
  assert.equal((await f.post(view.binding)).status,202);
  await f.service.stop();await f.service.view(f.task.id,f.id);
  assert.equal(notifications.length,1);assert.equal(notifications[0].phase,'no_proposal');assert.equal(notifications[0].curationId,f.id);assert.equal(notifications[0].requestId.startsWith('auto-tool-curation-build:'),true);
  assert.equal(Object.hasOwn(notifications[0],'prompt'),false);assert.equal(Object.hasOwn(notifications[0],'binding'),false);assert.equal(Object.hasOwn(notifications[0],'registrationSource'),false);
});

test('build HTTP refuses malformed binding, IDs, origin and query without starting the model',async t=>{
  const f=await fixture(t),binding=(await f.service.view(f.task.id,f.id)).binding;
  for(const body of [{...binding,prompt:'PRIVATE'}, {...binding,resultSha256:undefined}, {...binding,promptSha256:'x'}, []])assert.equal((await f.post(body)).status,400);
  assert.equal((await f.post({...binding,promptSha256:'f'.repeat(64)})).status,409);
  assert.equal((await f.post(' '.repeat(4097))).status,413);
  assert.equal((await f.post(binding,{Origin:'https://other.example'})).status,403);
  assert.equal((await fetch(`${f.url}?extra=1`)).status,400);
  assert.equal((await fetch(f.url.replace(f.id,'not-a-uuid'))).status,400);
  assert.equal((await fetch(f.url.replace(f.task.id,'not-a-uuid'))).status,400);
  assert.equal((await fetch(f.url.replace(f.task.id,randomUUID()))).status,404);
  assert.equal(f.runs(),0);
  await f.service.stop();assert.equal((await f.post(binding)).status,503);
});

test('ordinary message endpoint rejects the reserved build namespace before reserving a user turn',async t=>{
  const f=await fixture(t);
  const response=await fetch(`${f.base}/v1/tasks/${f.task.id}/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'forged prompt',requestId:`auto-tool-curation-build:${f.id}`})});
  assert.equal(response.status,400);assert.equal(f.tasks.listMessages(f.task.id).length,0);assert.equal(f.runs(),0);
});

test('unconfigured build HTTP reports unavailable without invoking the ordinary task runtime',async t=>{
  const f=await fixture(t,{configured:false});assert.equal((await fetch(f.url)).status,503);assert.equal((await f.post({})).status,503);assert.equal(f.runs(),0);
});
