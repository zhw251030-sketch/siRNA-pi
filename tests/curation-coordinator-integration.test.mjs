import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {TaskStore} from '../packages/task-core/task-store.mjs';
import {TaskMessageService} from '../packages/task-core/task-message-service.mjs';
import {createAppServer} from '../apps/api/router.mjs';
import * as lifecycle from '../apps/api/service-lifecycle.mjs';
import {ToolCurationStore} from '../packages/extensions/tool-curation/tool-curation-store.mjs';
import {ToolGapStore} from '../packages/extensions/tool-curation/tool-gap-store.mjs';
import {createToolCurationPreview} from '../packages/extensions/tool-curation/tool-curation-preview.mjs';
import {createToolCurationService} from '../packages/extensions/tool-curation/tool-curation-service.mjs';
import {buildRequestId} from '../packages/extensions/tool-curation/tool-curation-build-contract.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t,{onSettled,workspaceFiles,run}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'curation-integration-'));
  const tasks=new TaskStore(path.join(root,'tasks.sqlite')),runId=randomUUID();
  const runtime={runtimeInfo:()=>({}),describe:async()=>({backend:'agent-compose',supportsLifecycle:true}),assertWorkspaceIdle:async()=>{},
    run:run??(async(input,emit)=>{emit({type:'run_status',runId,status:'running'});emit({type:'assistant_message',text:'saved answer'});emit({type:'done',status:'succeeded',runId});})};
  const messages=new TaskMessageService({taskStore:tasks,agentRuntime:runtime,workspaceFiles,onSettled});
  const task=tasks.createTask({id:randomUUID()});
  const closers=[];
  t.after(async()=>{for(const close of closers.toReversed())await close();tasks.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,tasks,runtime,messages,task,runId,closers};
}

test('settled observer sees collected files, durable assistant and cleared active reservation exactly once',async t=>{
  const notifications=[],order=[];let f;
  f=fixture(t,{workspaceFiles:{collect:async()=>{order.push('collect');return {state:'ready',synchronization:'current'};}},onSettled:value=>{
    assert.equal(f.messages.isTaskBusy(f.task.id),false);assert.equal(f.tasks.listMessages(f.task.id).at(-1).content,'saved answer');
    order.push('observe');notifications.push(value);
  }});
  const input={taskId:f.task.id,message:'inspect',requestId:'message:integration-first'};
  const turn=await f.messages.start(input,()=>{});assert.equal(f.messages.isTaskBusy(f.task.id),true);
  const saved=await turn.completion;
  assert.deepEqual(order,['collect','observe']);assert.equal(notifications.length,1);
  assert.deepEqual(notifications[0],{taskId:f.task.id,runId:f.runId,userMessageId:turn.userMessage.id,requestId:input.requestId});
  assert.equal(saved.finalRunId,f.runId);assert.equal(f.tasks.listMessages(f.task.id).length,2);
  await(await f.messages.start(input,()=>{})).completion;assert.equal(notifications.length,1);
});

test('observer sync throws and rejected promises preserve the original successful saved result',async t=>{
  for(const observer of [()=>{throw Error('PRIVATE');},()=>Promise.reject(Error('PRIVATE'))]){
    let calls=0;const f=fixture(t,{onSettled:value=>{calls++;return observer(value);}});const result=await(await f.messages.start({taskId:f.task.id,message:'inspect'},()=>{})).completion;
    assert.equal(calls,1);assert.equal(result.assistantMessage.content,'saved answer');assert.equal(result.task.status,'idle');assert.equal(f.tasks.listMessages(f.task.id).length,2);
  }
  await new Promise(r=>setImmediate(r));
});

test('busy check covers upload, cancel, end, persisted running and stopped tasks',async t=>{
  for(const operation of ['upload','cancel','end']){
    const gate=deferred(),f=fixture(t,{workspaceFiles:{saveInput:async()=>{await gate.promise;return {};},hydrate:async()=>({}),collect:async()=>({})}});
    f.runtime.cancel=async()=>{await gate.promise;return {status:'idle'};};f.runtime.remove=async()=>{await gate.promise;return {status:'stopped'};};
    assert.equal(f.messages.isTaskBusy(f.task.id),false);
    const pending=operation==='upload'?f.messages.uploadInput(f.task.id,{}):operation==='cancel'?f.messages.cancelTask(f.task.id):f.messages.endTask(f.task.id);
    assert.equal(f.messages.isTaskBusy(f.task.id),true,operation);gate.resolve();await pending;
    assert.equal(f.messages.isTaskBusy(f.task.id),operation==='end');
  }
  const f=fixture(t);f.tasks.updateExecution(f.task.id,{status:'running'});assert.equal(f.messages.isTaskBusy(f.task.id),true);
  f.tasks.updateExecution(f.task.id,{status:'stopped'});assert.equal(f.messages.isTaskBusy(f.task.id),true);
});

test('readiness refuses legacy, active lifecycle and unconfirmed Compose workspace',async t=>{
  const f=fixture(t),ready=lifecycle.createCurationAutomationReadiness({taskMessages:f.messages,agentRuntime:f.runtime});let calls=0;
  f.runtime.assertWorkspaceIdle=async()=>{calls++;throw Error('PRIVATE');};f.runtime.describe=async()=>({backend:'local-pi'});
  assert.equal(await ready(f.task),false);assert.equal(calls,0);
  f.runtime.describe=async()=>({backend:'agent-compose'});await assert.rejects(ready(f.task));assert.equal(calls,1);
  f.tasks.updateExecution(f.task.id,{status:'running'});assert.equal(await ready(f.task),false);assert.equal(calls,1);
});

test('failed durable assistant save never notifies an observer',async t=>{
  const notifications=[];const f=fixture(t,{onSettled:value=>notifications.push(value)});
  f.tasks.appendAssistantMessage=()=>{throw Error('disk unavailable');};
  const result=await(await f.messages.start({taskId:f.task.id,message:'inspect'},()=>{})).completion;
  assert.equal(result.assistantMessage,undefined);assert.equal(result.task.status,'failed');assert.deepEqual(notifications,[]);
});

test('settled notification retains final run identity when task_saved handler changes current task run',async t=>{
  const notifications=[];const f=fixture(t,{onSettled:value=>notifications.push(value)}),replacement=randomUUID();
  await(await f.messages.start({taskId:f.task.id,message:'inspect'},event=>{if(event.type==='task_saved')f.tasks.updateExecution(f.task.id,{currentRunId:replacement});})).completion;
  assert.equal(notifications[0]?.runId,f.runId);assert.equal(f.tasks.getTask(f.task.id).currentRunId,replacement);
});

test('readiness checks task reservation before and after real runtime idle confirmation',async t=>{
  assert.equal(typeof lifecycle.createCurationAutomationReadiness,'function');
  const f=fixture(t),gate=deferred();let checked=0;
  const ready=lifecycle.createCurationAutomationReadiness({taskMessages:f.messages,agentRuntime:f.runtime});
  f.runtime.assertWorkspaceIdle=async()=>{checked++;await gate.promise;};
  const pending=ready(f.task);await new Promise(r=>setImmediate(r));f.tasks.updateExecution(f.task.id,{status:'stopped'});gate.resolve();
  assert.equal(await pending,false);assert.equal(checked,1);assert.equal(await ready(f.tasks.getTask(f.task.id)),false);
});

test('services start automation only after listening and stop its admission before asynchronous drains',async()=>{
  const events=[],server={listening:false,close:cb=>cb(),waitForTaskCompletion:async()=>events.push('messages')};
  const services={server,toolCuration:{start:()=>events.push('curator-start'),stop:async()=>events.push('curator-stop')},toolCurationCoordinator:{start:()=>events.push('automation-start'),stop:async()=>events.push('automation-stop')}};
  assert.throws(()=>lifecycle.startApiServices(services));assert.deepEqual(events,[]);server.listening=true;lifecycle.startApiServices(services);
  assert.deepEqual(events,['curator-start','automation-start']);
  await lifecycle.createApiShutdown({...services,stores:[{close:()=>events.push('store')}]} )();
  assert.deepEqual(events,['curator-start','automation-start','automation-stop','curator-stop','messages','store']);
});

async function httpFixture(t,coordinator){
  const f=fixture(t),server=createAppServer({taskStore:f.tasks,agentRuntime:f.runtime,toolCurationCoordinator:coordinator});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}/v1/tool-curation-automation`;
  return {get:(suffix='')=>fetch(base+suffix),post:(value,headers={})=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:typeof value==='string'?value:JSON.stringify(value)})};
}

test('automation HTTP exposes exact status and exact bounded boolean controls with same-origin protection',async t=>{
  let enabled=false;const status=()=>({protocolVersion:'sirna-tool-curation-automation/v1',started:true,enabled,maxReviews:3,attempts:1,remaining:2,pending:0,reason:enabled?'enabled':'disabled',recent:[]});
  const f=await httpFixture(t,{status,configure:body=>{enabled=body.enabled;return status();}});
  assert.deepEqual(await(await f.get()).json(),{automation:status()});
  for(const body of [{enabled:true,limit:999},{enabled:1},{},{enabled:false,prompt:'PRIVATE'}])assert.equal((await f.post(body)).status,400);
  assert.equal((await f.post(' '.repeat(1025))).status,413);assert.equal((await f.get('?enabled=true')).status,400);
  assert.equal((await f.post({enabled:true},{Origin:'https://foreign.example'})).status,403);
  assert.equal((await f.post({enabled:true})).status,200);assert.equal((await(await f.get()).json()).automation.enabled,true);
  await f.post({enabled:true});await f.post({enabled:false});assert.equal((await(await f.get()).json()).automation.attempts,1);
});

test('automation HTTP without configuration is 503 and unexpected exceptions are safe',async t=>{
  const missing=await httpFixture(t);assert.equal((await missing.get()).status,503);assert.equal((await missing.post({enabled:true})).status,503);
  const broken=await httpFixture(t,{status:()=>{throw Error('PRIVATE_HOST_KEY');},configure:()=>{throw Object.assign(Error('PRIVATE_HOST_KEY'),{statusCode:409});}});
  for(const response of [await broken.get(),await broken.post({enabled:true})]){assert.ok([503,409].includes(response.status));assert.equal((await response.text()).includes('PRIVATE_HOST_KEY'),false);}
});

async function curationFixture(t,{curate,readiness,isTaskBusy,beforeCuration,toolCurationBuild,toolMaintenance,toolRepair,automaticValidation=false,automaticRepair=false}={}){
  const module=await import('../packages/extensions/tool-curation/tool-curation-coordinator.mjs').catch(()=>({}));
  assert.equal(typeof module.createToolCurationCoordinator,'function','real coordinator must be available');
  const f=fixture(t),curations=new ToolCurationStore({root:f.root}),gaps=new ToolGapStore({root:f.root});let calls=0;
  f.closers.push(()=>curations.close(),()=>gaps.close());
  const preview=createToolCurationPreview({taskStore:f.tasks,listExistingTools:()=>[],listGapReports:(taskId,runId)=>gaps.list(taskId,runId)});
  const modelResults=[];
  let coordinator;
  const service=createToolCurationService({store:curations,preview,cooldownMs:604800000,onSettled:(run,metadata)=>{beforeCuration?.(run,metadata);coordinator?.observeCuration(run,metadata);},curator:{async curate(run,signal,onStarted){
    calls++;if(curate)return curate(run,signal,onStarted);const sessionId=randomUUID(),runId=randomUUID();onStarted(sessionId,runId);
    const result={protocolVersion:'sirna-tool-curation-result/v1',curationId:run.id,traceSha256:run.traceSha256,decision:'candidate',summary:'A reusable fetch boundary.',candidate:{capabilityKey:'tool:fetch_dataset',suggestedToolName:'dataset_fetch',capabilityBoundary:'Fetch public datasets by identifier.',whyExistingToolsAreInsufficient:'No catalog fetch capability.',evidenceEventIds:run.trace.signals[0].evidenceEventIds,inputContractSketch:{identifier:'string'},outputContractSketch:{rows:'array'},permissions:{profile:'no_external_access'},buildInstructions:['Implement the bounded fetch interface.']}};
    modelResults.push(result);return {sessionId,runId,result};
  }}});
  f.runtime.run=async(input,emit)=>{
    const runId=randomUUID();emit({type:'run_status',runId,status:'running'});
    for(let i=0;i<3;i++){emit({type:'tool_start',toolCallId:`call-${i}`,toolName:'fetch_dataset',args:{identifier:i}});emit({type:'tool_end',toolCallId:`call-${i}`,toolName:'fetch_dataset',isError:false,result:{rows:[1,2]}});}
    emit({type:'assistant_message',text:'saved fetch results'});emit({type:'done',runId,status:'succeeded'});
  };
  coordinator=module.createToolCurationCoordinator({taskStore:f.tasks,preview,curation:service,toolCurationBuild,toolMaintenance,toolRepair,automaticValidation,automaticRepair,isReady:readiness??lifecycle.createCurationAutomationReadiness({taskMessages:f.messages,agentRuntime:f.runtime}),isTaskBusy:isTaskBusy??(taskId=>f.messages.isTaskBusy(taskId)),intervalMs:1000,maxReviews:3});
  f.messages.onSettled=value=>coordinator.observeRun(value);
  service.start();coordinator.start();f.closers.push(()=>service.stop(),()=>coordinator.stop());
  const turn=async(task=f.task,requestId)=>{const value=await f.messages.start({taskId:task.id,message:'Compare datasets',...(requestId?{requestId}:{})},()=>{});const saved=await value.completion;await coordinator.runOnce();await new Promise(r=>setImmediate(r));return saved;};
  return {...f,curations,gaps,preview,service,coordinator,turn,modelResults,calls:()=>calls};
}

async function waitFor(check,{attempts=20}={}){
  for(let i=0;i<attempts;i++){
    const value=check();
    if(value)return value;
    await new Promise(resolve=>setImmediate(resolve));
  }
  return check();
}

test('automatic Curator candidate is handed to Builder once with the frozen binding',async t=>{
  const starts=[];
  const f=await curationFixture(t,{toolCurationBuild:{start:async(...args)=>{starts.push(args);return {handoff:{phase:'running',curationId:args[1]}};}}});
  f.coordinator.configure({enabled:true});
  const saved=await f.turn();
  const candidate=await waitFor(()=>f.curations.list(f.task.id).find(row=>row.status==='candidate'));
  assert.ok(candidate,'Curator candidate should settle');
  await waitFor(()=>starts.length===1);
  assert.equal(starts.length,1);
  assert.equal(starts[0][0],f.task.id);
  assert.equal(starts[0][1],candidate.id);
  assert.deepEqual(Object.keys(starts[0][2]).sort(),['promptSha256','resultSha256','traceSha256']);
  assert.equal(f.tasks.listMessages(f.task.id).length,2,'coordinator must not create an ordinary user turn');
  f.coordinator.observeCuration(candidate);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(starts.length,1,'duplicate terminal notification must not re-dispatch Builder');
  assert.equal(saved.task.status,'idle');
});

test('automatic Curator skip never starts Builder',async t=>{
  const starts=[];
  const f=await curationFixture(t,{curate:async (run,signal,onStarted)=>{const sessionId=randomUUID(),runId=randomUUID();onStarted(sessionId,runId);return {sessionId,runId,result:{protocolVersion:'sirna-tool-curation-result/v1',curationId:run.id,traceSha256:run.traceSha256,decision:'skip',summary:'No stable boundary.'}};},toolCurationBuild:{start:async(...args)=>{starts.push(args);}}});
  f.coordinator.configure({enabled:true});await f.turn();
  const terminal=await waitFor(()=>f.curations.list(f.task.id).find(row=>['skipped','error'].includes(row.status)));
  assert.ok(terminal);assert.equal(terminal.status,'skipped');assert.equal(starts.length,0);
  assert.ok(f.coordinator.status().recent.some(item=>item.reason==='curation_skip'));
});

test('automatic candidate remains manual while the coordinator switch is disabled',async t=>{
  const starts=[];let f;f=await curationFixture(t,{beforeCuration:()=>f.coordinator.configure({enabled:false}),toolCurationBuild:{start:async(...args)=>{starts.push(args);}}});
  f.coordinator.configure({enabled:true});await f.turn();const candidate=await waitFor(()=>f.curations.list(f.task.id).find(row=>row.status==='candidate'));
  assert.ok(candidate);assert.equal(starts.length,0);assert.ok(f.coordinator.status().recent.some(item=>item.reason==='builder_disabled'));
});

test('automatic Builder dispatch refuses a busy task and leaves candidate for manual handoff',async t=>{
  const starts=[];let busy=false;
  const f=await curationFixture(t,{beforeCuration:()=>{busy=true;},toolCurationBuild:{start:async(...args)=>{starts.push(args);}},isTaskBusy:()=>busy});
  f.coordinator.configure({enabled:true});
  await f.turn();
  const candidate=await waitFor(()=>f.curations.list(f.task.id).find(row=>row.status==='candidate'));
  assert.ok(candidate);
  busy=true;
  f.coordinator.observeCuration(candidate);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(starts.length,0);
  assert.equal(f.curations.get(f.task.id,candidate.id).status,'candidate');
  assert.ok(f.coordinator.status().recent.some(item=>item.reason==='builder_busy'));
});

test('submitted automatic Builder ticket enters maintenance only when automatic validation is enabled',async t=>{
  const starts=[],jobs=[];const proposalId=randomUUID(),artifactSha256='a'.repeat(64);
  const f=await curationFixture(t,{automaticValidation:true,toolMaintenance:{enqueue:(...args)=>{jobs.push(args);return {job:{id:randomUUID(),proposalId:args[0],status:'pending'},deduplicated:false};}},toolCurationBuild:{start:async(...args)=>{starts.push(args);return {handoff:{phase:'running',curationId:args[1]}};}}});
  f.coordinator.configure({enabled:true});await f.turn();const candidate=await waitFor(()=>f.curations.list(f.task.id).find(row=>row.status==='candidate'));assert.ok(candidate);await waitFor(()=>starts.length===1);
  f.coordinator.observeBuilder({curationId:candidate.id,requestId:buildRequestId(candidate.id),phase:'submitted',proposalId,artifactSha256});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(jobs.length,1);assert.equal(jobs[0][0],proposalId);assert.match(jobs[0][1],/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert.deepEqual(jobs[0][2],{artifactSha256});
  f.coordinator.observeBuilder({curationId:candidate.id,requestId:buildRequestId(candidate.id),phase:'submitted',proposalId,artifactSha256});await new Promise(resolve=>setImmediate(resolve));assert.equal(jobs.length,1);
});

test('automatic validation stays side-effect free by default and suppresses no-proposal tickets',async t=>{
  const jobs=[],starts=[],proposalId=randomUUID();const f=await curationFixture(t,{toolMaintenance:{enqueue:(...args)=>{jobs.push(args);}},toolCurationBuild:{start:async(...args)=>{starts.push(args);return {handoff:{phase:'running',curationId:args[1]}};}}});
  f.coordinator.configure({enabled:true});await f.turn();const candidate=await waitFor(()=>f.curations.list(f.task.id).find(row=>row.status==='candidate'));assert.ok(candidate);await waitFor(()=>starts.length===1);
  f.coordinator.observeBuilder({curationId:candidate.id,requestId:buildRequestId(candidate.id),phase:'submitted',proposalId,artifactSha256:'b'.repeat(64)});
  f.coordinator.observeBuilder({curationId:candidate.id,requestId:buildRequestId(candidate.id),phase:'no_proposal',proposalId,artifactSha256:'b'.repeat(64)});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(jobs.length,0);assert.ok(f.coordinator.status().recent.some(item=>item.reason==='validation_disabled'));
});

test('late Builder terminal notification after coordinator stop cannot enqueue validation',async t=>{
  const jobs=[],starts=[];const f=await curationFixture(t,{automaticValidation:true,toolMaintenance:{enqueue:(...args)=>{jobs.push(args);}},toolCurationBuild:{start:async(...args)=>{starts.push(args);return {handoff:{phase:'running',curationId:args[1]}};}}});
  f.coordinator.configure({enabled:true});await f.turn();const candidate=await waitFor(()=>f.curations.list(f.task.id).find(row=>row.status==='candidate'));assert.ok(candidate);await waitFor(()=>starts.length===1);
  await f.coordinator.stop();f.coordinator.observeBuilder({curationId:candidate.id,requestId:buildRequestId(candidate.id),phase:'submitted',proposalId:randomUUID(),artifactSha256:'c'.repeat(64)});
  assert.equal(jobs.length,0);assert.ok(f.coordinator.status().recent.some(item=>item.reason==='stopped'));
});

test('failed automatic validation enters the existing repair service only when repair is enabled',async t=>{
  const starts=[],jobs=[],repairs=[],curationId=randomUUID(),proposalId=randomUUID(),validationId=randomUUID(),artifactSha256='d'.repeat(64),reportSha256='e'.repeat(64);
  const f=await curationFixture(t,{automaticValidation:true,automaticRepair:true,toolMaintenance:{enqueue:(...args)=>{jobs.push(args);return {job:{id:randomUUID(),proposalId:args[0],status:'pending'},deduplicated:false};}},toolRepair:{start:async(...args)=>{repairs.push(args);return {repair:{phase:'running',proposalId:args[0]},deduplicated:false};}},toolCurationBuild:{start:async(...args)=>{starts.push(args);return {handoff:{phase:'running',curationId:args[1]}};}}});
  f.coordinator.configure({enabled:true});await f.turn();const candidate=await waitFor(()=>f.curations.list(f.task.id).find(row=>row.status==='candidate'));assert.ok(candidate);await waitFor(()=>starts.length===1);
  f.coordinator.observeBuilder({curationId:candidate.id,requestId:buildRequestId(candidate.id),phase:'submitted',proposalId,artifactSha256});await new Promise(resolve=>setImmediate(resolve));assert.equal(jobs.length,1);
  f.coordinator.observeMaintenance({proposalId,jobId:randomUUID(),status:'succeeded',passed:false,validationId,reportSha256,artifactSha256});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(repairs,[[proposalId,{validationId,reportSha256}]]);
  f.coordinator.observeMaintenance({proposalId,jobId:randomUUID(),status:'succeeded',passed:false,validationId,reportSha256,artifactSha256});await new Promise(resolve=>setImmediate(resolve));assert.equal(repairs.length,1);
});

test('automatic repair ignores passed, unknown and default-disabled validation outcomes',async t=>{
  const starts=[],jobs=[],repairs=[],proposalId=randomUUID(),validationId=randomUUID(),artifactSha256='f'.repeat(64),reportSha256='1'.repeat(64);
  const f=await curationFixture(t,{automaticValidation:true,toolMaintenance:{enqueue:(...args)=>{jobs.push(args);return {job:{id:randomUUID(),proposalId:args[0],status:'pending'},deduplicated:false};}},toolRepair:{start:async(...args)=>{repairs.push(args);}},toolCurationBuild:{start:async(...args)=>{starts.push(args);return {handoff:{phase:'running',curationId:args[1]}};}}});
  f.coordinator.configure({enabled:true});await f.turn();const candidate=await waitFor(()=>f.curations.list(f.task.id).find(row=>row.status==='candidate'));assert.ok(candidate);await waitFor(()=>starts.length===1);
  f.coordinator.observeBuilder({curationId:candidate.id,requestId:buildRequestId(candidate.id),phase:'submitted',proposalId,artifactSha256});await new Promise(resolve=>setImmediate(resolve));
  for(const value of [{status:'succeeded',passed:true},{status:'failed',passed:null},{status:'succeeded',passed:false,validationId,reportSha256}]){f.coordinator.observeMaintenance({proposalId,jobId:randomUUID(),artifactSha256,...value});await new Promise(resolve=>setImmediate(resolve));}
  assert.equal(repairs.length,0);
});

test('real completed task and HTTP switch persist one candidate, then apply backend cooldown on a new task',async t=>{
  const f=await curationFixture(t),server=createAppServer({taskStore:f.tasks,agentRuntime:f.runtime,taskMessages:f.messages,toolCurationCoordinator:f.coordinator,toolCuration:f.service});
  server.listen(0,'127.0.0.1');await once(server,'listening');f.closers.push(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}/v1/tool-curation-automation`,post=enabled=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});
  assert.equal((await(await fetch(base)).json()).automation.enabled,false);
  await post(true);const saved=await f.turn();assert.equal(saved.task.status,'idle');assert.equal(f.tasks.listMessages(f.task.id).length,2);
  const first=f.curations.list(f.task.id)[0];assert.equal(first.status,'candidate');assert.equal(first.trigger,'post_run');assert.equal(f.calls(),1);
  f.coordinator.observeRun({taskId:f.task.id,runId:saved.finalRunId,userMessageId:saved.userMessage.id});await f.coordinator.runOnce();assert.equal(f.calls(),1);
  const another=f.tasks.createTask({id:randomUUID()});await f.turn(another);const second=f.curations.list(another.id)[0];
  assert.equal(second.status,'skipped');assert.match(second.result.summary,/后端冷却规则/);assert.ok(second.result.summary.includes(first.id));assert.equal(f.modelResults[1].decision,'candidate');assert.equal(f.calls(),2);
  await post(false);await post(true);const state=(await(await fetch(base)).json()).automation;assert.equal(state.attempts,2);assert.equal(state.remaining,1);
  assert.equal(f.tasks.listMessages(another.id).length,2);assert.deepEqual(f.gaps.list(another.id,f.tasks.getTask(another.id).currentRunId),[]);
});

test('unknown curator outcome is retained as one error without retrying the completed task',async t=>{
  const f=await curationFixture(t,{curate:async()=>{throw Object.assign(Error('PRIVATE_HOST_KEY'),{outcomeUnknown:true});}});
  f.coordinator.configure({enabled:true});await f.turn();const record=f.curations.list(f.task.id)[0];assert.equal(record.status,'error');
  await f.coordinator.runOnce();await f.coordinator.runOnce();assert.equal(f.calls(),1);assert.equal(f.coordinator.status().attempts,1);
  assert.equal(f.tasks.getTask(f.task.id).status,'idle');assert.equal(f.tasks.listMessages(f.task.id).at(-1).content,'saved fetch results');assert.equal(JSON.stringify(record).includes('PRIVATE_HOST_KEY'),false);
  assert.ok(f.coordinator.status().recent.some(item=>item.reason==='curation_error'));
});

test('shutdown during awaited readiness prevents dispatch and closes all stores even if another drain rejects',async t=>{
  const gate=deferred(),entered=deferred();const f=await curationFixture(t,{readiness:async()=>{entered.resolve();await gate.promise;return true;}});
  f.coordinator.configure({enabled:true});const turn=await f.messages.start({taskId:f.task.id,message:'Compare datasets'},()=>{});await turn.completion;await entered.promise;
  const events=[],shutdown=lifecycle.createApiShutdown({server:{close:cb=>cb(),waitForTaskCompletion:async()=>{}},toolCurationCoordinator:f.coordinator,toolCuration:f.service,toolRepair:{stop(){throw Error('private drain');}},stores:[{close:()=>events.push('store')}],rpcs:[{close:()=>events.push('rpc')}]});
  const stopping=shutdown();assert.equal(f.coordinator.status().enabled,false);assert.deepEqual(events,[]);gate.resolve();await assert.rejects(stopping);
  assert.deepEqual(events,['store','rpc']);assert.equal(f.curations.list(f.task.id).length,0);assert.equal(f.calls(),0);
});

for(const operation of ['upload','cancel','end'])test(`resolved readiness cannot dispatch across a real ${operation} reservation in the promise continuation gap`,async t=>{
  let f,ready,first=true,reservation,observedReady;
  const gate=deferred();
  f=await curationFixture(t,{readiness:task=>{
    const pending=ready(task);
    // Registered before coordinator awaits this same promise: the real
    // readiness helper has returned true, then a competing operation reserves
    // its real private map before the coordinator's continuation resumes.
    if(first){first=false;pending.then(value=>{
      observedReady=value;
      reservation=operation==='upload'?f.messages.uploadInput(f.task.id,{}):operation==='cancel'?f.messages.cancelTask(f.task.id):f.messages.endTask(f.task.id);
    });}
    return pending;
  }});
  ready=lifecycle.createCurationAutomationReadiness({taskMessages:f.messages,agentRuntime:f.runtime});
  f.messages.workspaceFiles={collect:async()=>({state:'ready',synchronization:'current'}),saveInput:async()=>{await gate.promise;return {};},hydrate:async()=>({synchronization:'current'})};
  f.runtime.cancel=async()=>{await gate.promise;return {status:'idle'};};
  f.runtime.remove=async()=>{await gate.promise;return {status:'stopped'};};
  f.coordinator.configure({enabled:true});
  try{
    const saved=await f.turn();
    assert.equal(observedReady,true,'asynchronous readiness completed before reservation');
    assert.equal(f.messages.isTaskBusy(f.task.id),true,'actual lifecycle reservation remains held');
    assert.equal(f.tasks.getTask(f.task.id).status,'idle','persistent status alone cannot see the reservation');
    assert.equal(f.tasks.getTask(f.task.id).currentRunId,saved.finalRunId);
    assert.equal(f.calls(),0,'a reserved task must not reach the curator');
    assert.equal(f.curations.list(f.task.id).length,0);
    assert.equal(f.coordinator.status().attempts,0);assert.equal(f.coordinator.status().pending,1);
  }finally{gate.resolve();if(reservation)await reservation;}
  await f.coordinator.runOnce();await new Promise(r=>setImmediate(r));
  if(operation==='end'){
    assert.equal(f.tasks.getTask(f.task.id).status,'stopped');assert.equal(f.calls(),0);assert.equal(f.coordinator.status().attempts,0);
  }else{
    assert.equal(f.messages.isTaskBusy(f.task.id),false);assert.equal(f.calls(),1);
    assert.equal(f.curations.list(f.task.id)[0].status,'candidate');assert.equal(f.coordinator.status().attempts,1);
    await f.coordinator.runOnce();assert.equal(f.calls(),1);
  }
  assert.equal(f.coordinator.status().pending,0);
});
