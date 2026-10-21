import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {TaskStore} from '../packages/task-core/task-store.mjs';
import {ToolCurationStore} from '../packages/extensions/tool-curation/tool-curation-store.mjs';
import {ToolGapStore} from '../packages/extensions/tool-curation/tool-gap-store.mjs';
import {gapInput} from './helpers/tool-gap-fixture.mjs';
import {createToolCurationPreview} from '../packages/extensions/tool-curation/tool-curation-preview.mjs';
import {createToolCurationService} from '../packages/extensions/tool-curation/tool-curation-service.mjs';
import {buildToolCurationTrace} from '../packages/extensions/tool-curation/tool-curation-evidence.mjs';

const module=await import('../packages/extensions/tool-curation/tool-curation-coordinator.mjs').catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {};});
const createCoordinator=(...args)=>{assert.equal(typeof module.createToolCurationCoordinator,'function','bounded coordinator must be implemented');return module.createToolCurationCoordinator(...args);};
const gate=()=>{let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(t,{isReady=()=>true,isTaskBusy=()=>false,maxReviews=3,request,preview:previewBoundary}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'curation-coordinator-')));
  const tasks=new TaskStore(path.join(root,'tasks.sqlite')),store=new ToolCurationStore({root}),gaps=new ToolGapStore({root});
  const preview=createToolCurationPreview({taskStore:tasks,listExistingTools:()=>[],listGapReports:(...args)=>gaps.list(...args)});
  const service=createToolCurationService({store,preview,curator:{async curate(run,signal,onStarted){onStarted('session','run');return {sessionId:'session',runId:'run',result:{protocolVersion:'sirna-tool-curation-result/v1',curationId:run.id,traceSha256:run.traceSha256,decision:'skip',summary:'No stable boundary.'}};}}});service.start();
  const curation=request?{list:id=>service.list(id),find:(...args)=>service.find(...args),request:(...args)=>request(service,...args)}:service;
  const coordinator=createCoordinator({taskStore:tasks,preview:previewBoundary??preview,curation,isReady,isTaskBusy,intervalMs:60000,maxReviews});
  t.after(async()=>{await coordinator.stop();await service.stop();gaps.close();store.close();tasks.close();fs.rmSync(root,{recursive:true,force:true});});
  function run({taskId,gap=false,error=false,count=3,requestId,runId=randomUUID()}={}){
    const task=taskId?tasks.getTask(taskId):tasks.createTask({id:randomUUID()});
    const {message}=tasks.beginTurn(task.id,'Compare datasets',requestId);tasks.updateExecution(task.id,{currentRunId:runId});
    if(gap){gaps.create({...gapInput(),taskId:task.id,runId,userMessageId:message.id,source:{taskId:task.id,executionSessionId:task.executionSessionId,sandboxId:'a'.repeat(64),agentTurnId:randomUUID(),agentRunId:runId}});}
    else for(let i=0;i<count;i++){
      tasks.appendRunEvent(task.id,message.id,runId,'tool_start',{toolCallId:`c${i}`,toolName:'fetch_dataset',args:{identifier:i}});
      tasks.appendRunEvent(task.id,message.id,runId,'tool_end',{toolCallId:`c${i}`,toolName:'fetch_dataset',isError:error,result:{rows:[1]}});
    }
    tasks.appendRunEvent(task.id,message.id,runId,'done',{status:error?'failed':'succeeded'});tasks.appendAssistantMessage(task.id,'done',error?'failed':'complete');
    return {taskId:task.id,runId,userMessageId:message.id,...(requestId?{requestId}:{})};
  }
  return {tasks,store,gaps,preview,service,coordinator,run};
}

test('default off, new gap-only or complete-repeat notifications admit once and preserve automatic trigger',async t=>{
  const f=fixture(t),c=f.coordinator;c.start();const off=f.run();c.observeRun(off);await c.runOnce();assert.equal(f.store.list(off.taskId).length,0);
  c.configure({enabled:true});
  for(const options of [{gap:true},{error:true},{runId:'b'.repeat(64)}]){
    const event=f.run(options);c.observeRun(event);c.observeRun(event);await Promise.all([c.runOnce(),c.runOnce()]);
    assert.equal(f.store.list(event.taskId).length,1);
    const row=f.service.get(event.taskId,f.store.list(event.taskId)[0].id);assert.equal(row.trigger,options.gap||options.error?'online_gap':'post_run');
  }
  assert.equal(c.status().attempts,3);assert.equal(c.status().remaining,0);assert.equal(c.status().reason,'budget_exhausted');assert.equal(c.status().enabled,false);
  assert.throws(()=>c.configure({enabled:true}),e=>e.statusCode===409);
  c.start();assert.equal(c.status().attempts,3);
});

test('Builder sources and exact task/run/user mismatches never dispatch; invalid events/configuration are rejected safely',async t=>{
  const f=fixture(t),c=f.coordinator;assert.throws(()=>c.configure({enabled:true}),e=>e.statusCode===503);c.start();
  for(const input of [{},{enabled:1},{enabled:true,maxReviews:9},Object.create({enabled:true})])assert.throws(()=>c.configure(input),e=>e.statusCode===400);
  c.configure({enabled:true});
  const builder=f.run({requestId:'auto-tool-curation-build:source'});c.observeRun(builder);
  const event=f.run();c.observeRun({...event,userMessageId:randomUUID()});await c.runOnce();assert.equal(f.store.list(event.taskId).length,0);
  const stale=f.run();f.run({taskId:stale.taskId});c.observeRun(stale);await c.runOnce();
  assert.equal(f.store.list(stale.taskId).length,0);assert.equal(f.store.list(builder.taskId).length,0);assert.equal(c.status().attempts,0);
  for(const bad of [{...event,taskId:'not-uuid'},{...event,runId:'bad'},{...event,requestId:3}])assert.throws(()=>c.observeRun(bad),e=>e.statusCode===400);
});

test('manual/automatic race persists exactly one review and attempts stay conservative',async t=>{
  const ready=gate(),f=fixture(t,{isReady:()=>ready.promise}),c=f.coordinator;c.start();c.configure({enabled:true});const event=f.run();
  c.observeRun(event);const active=c.runOnce();await tick();
  const p=f.preview.read(event.taskId,event.runId).preview;const binding={runId:event.runId,sourceSha256:p.sourceSha256,previewSha256:p.previewSha256};
  const manual=await f.service.request(event.taskId,binding);ready.release(true);await active;
  assert.equal(f.store.list(event.taskId).length,1);assert.equal(f.store.list(event.taskId)[0].id,manual.curation.id);assert.equal(c.status().attempts,0);assert.ok(c.status().recent.some(r=>r.state==='deduplicated'));
});

test('manual review winning at the service admission boundary keeps one row but reserves the automatic attempt',async t=>{
  const f=fixture(t,{request:async(service,taskId,binding,options)=>{await service.request(taskId,binding);return service.request(taskId,binding,options);}}),c=f.coordinator;c.start();c.configure({enabled:true});const event=f.run();c.observeRun(event);await c.runOnce();assert.equal(f.store.list(event.taskId).length,1);assert.equal(c.status().attempts,1);assert.equal(c.status().recent.at(-1).state,'deduplicated');
});

test('an existing persisted review outside the display window does not consume automatic budget',async t=>{
  const f=fixture(t),c=f.coordinator,history=[f.run()];
  for(let i=0;i<100;i++)history.push(f.run({taskId:history[0].taskId}));
  const event=f.run({taskId:history[0].taskId}),p=f.preview.read(event.taskId,event.runId).preview;
  const manual=await f.service.request(event.taskId,{runId:event.runId,sourceSha256:p.sourceSha256,previewSha256:p.previewSha256});
  await f.service.stop();f.service.start();
  for(const past of history)f.store.create(buildToolCurationTrace({id:randomUUID(),snapshot:f.preview.snapshot(past.taskId,past.runId)}));
  assert.equal(f.store.list(event.taskId).length,100);assert.ok(!f.store.list(event.taskId).some(row=>row.id===manual.curation.id));
  c.start();c.configure({enabled:true});c.observeRun(event);await c.runOnce();assert.equal(c.status().attempts,0);assert.equal(c.status().recent.at(-1).state,'deduplicated');
});

test('invalidated readiness rejection cannot disable a newly enabled generation or override stopped status',async t=>{
  for(const action of ['disable-enable','stop'])await t.test(action,async t=>{
    let reject;const delayed=new Promise((resolve,fail)=>reject=fail);const f=fixture(t,{isReady:()=>delayed}),c=f.coordinator;c.start();c.configure({enabled:true});c.observeRun(f.run());const active=c.runOnce();await tick();
    let stopping;if(action==='stop')stopping=c.stop();else {c.configure({enabled:false});c.configure({enabled:true});}
    reject(Error('private rejected state'));await active;await stopping;assert.equal(c.status().reason,action==='stop'?'stopped':'enabled');assert.equal(c.status().attempts,0);
  });
});

test('disable, stop, replaced run, or task stop during readiness prevents dispatch after await',async t=>{
  for(const action of ['disable','stop','replace','task-stop'])await t.test(action,async t=>{
    const ready=gate(),f=fixture(t,{isReady:()=>ready.promise}),c=f.coordinator;c.start();c.configure({enabled:true});const event=f.run();c.observeRun(event);const active=c.runOnce();await tick();
    let stopping,settled=false;
    if(action==='disable'){c.configure({enabled:false});c.configure({enabled:true});}
    if(action==='stop'){stopping=c.stop().then(()=>settled=true);assert.equal(c.status().started,false);await tick();assert.equal(settled,false);}
    if(action==='replace')f.run({taskId:event.taskId});
    if(action==='task-stop')f.tasks.updateExecution(event.taskId,{status:'stopped'});
    ready.release(true);await active;await stopping;assert.equal(f.store.list(event.taskId).length,0);assert.equal(c.status().attempts,0);assert.equal(c.status().pending,0);
  });
});

test('not-ready items wait for the next tick; fresh instance stays off without scanning persisted history',async t=>{
  let ready=false;const f=fixture(t,{isReady:()=>ready}),c=f.coordinator;c.start();c.configure({enabled:true});const event=f.run();c.observeRun(event);await c.runOnce();assert.equal(c.status().pending,1);
  ready=true;await c.runOnce();assert.equal(f.store.list(event.taskId).length,1);
  c.configure({enabled:false});c.configure({enabled:true});assert.equal(c.status().remaining,2);
  await c.stop();const next=createCoordinator({taskStore:f.tasks,preview:f.preview,curation:f.service,isReady:()=>true});next.start();await next.runOnce();assert.equal(next.status().enabled,false);assert.equal(next.status().attempts,0);assert.equal(next.status().pending,0);await next.stop();
});

test('invalid preview costs no attempts; unknown request/readiness failure closes safely and does not retry',async t=>{
  const f=fixture(t),c=f.coordinator;c.start();c.configure({enabled:true});const incomplete=f.run({count:2});c.observeRun(incomplete);await c.runOnce();assert.equal(c.status().attempts,0);assert.equal(c.status().pending,0);
  for(const boundary of ['request','readiness'])await t.test(boundary,async t=>{
    const g=fixture(t,boundary==='request'?{request:()=>{throw Error('secret credential');}}:{isReady:()=>{throw Error('secret credential');}}),d=g.coordinator;d.start();d.configure({enabled:true});const event=g.run();d.observeRun(event);await d.runOnce();await d.runOnce();
    assert.equal(d.status().enabled,false);assert.equal(d.status().reason,'unavailable');assert.equal(d.status().attempts,boundary==='request'?1:0);assert.equal(g.store.list(event.taskId).length,0);assert.ok(!JSON.stringify(d.status()).includes('secret'));
    d.configure({enabled:true});d.observeRun(event);await d.runOnce();assert.equal(d.status().attempts,boundary==='request'?1:0);
  });
});

test('stop waits for entered request, keeps accepted work, and has no live interval after stop',async t=>{
  const entered=gate(),release=gate(),f=fixture(t,{request:async(service,...args)=>{const accepted=await service.request(...args);entered.release();await release.promise;return accepted;}}),c=f.coordinator;
  c.start();c.configure({enabled:true});const event=f.run();c.observeRun(event);const active=c.runOnce();await entered.promise;let stopped=false;const stopping=c.stop().then(()=>stopped=true);await tick();assert.equal(stopped,false);release.release();await Promise.all([stopping,active]);assert.equal(f.store.list(event.taskId).length,1);assert.equal(c.status().attempts,1);assert.equal(c.status().started,false);assert.throws(()=>c.configure({enabled:true}),e=>e.statusCode===503);
});

test('pending 32 and remembered 256 limits close explicitly without evicting duplicate keys',async t=>{
  const f=fixture(t,{isReady:()=>false}),c=f.coordinator;c.start();c.configure({enabled:true});for(let i=0;i<32;i++)c.observeRun(f.run());assert.equal(c.status().pending,32);c.observeRun(f.run());assert.equal(c.status().reason,'capacity_exhausted');assert.equal(c.status().enabled,false);assert.equal(c.status().pending,0);
  const g=fixture(t),d=g.coordinator;d.start();d.configure({enabled:true});let first;
  for(let i=0;i<256;i++){const event=g.run({count:0});first??=event;d.observeRun(event);await d.runOnce();}
  assert.equal(d.status().enabled,true);d.observeRun(first);await d.runOnce();assert.equal(d.status().enabled,true);assert.equal(d.status().attempts,0);
  d.observeRun(g.run({count:0}));assert.equal(d.status().reason,'capacity_exhausted');assert.equal(d.status().enabled,false);
  const status=d.status();assert.equal(status.recent.length,20);assert.equal(status.protocolVersion,'sirna-tool-curation-automation/v1');status.recent[0].reason='mutated';status.recent.push({});assert.equal(d.status().recent.length,20);assert.ok(!JSON.stringify(d.status()).includes('mutated'));
});

test('constructor bounds review budget and interval; third argument automatic is preserved at service boundary',async t=>{
  for(const maxReviews of [0,11,1.5])assert.throws(()=>module.createToolCurationCoordinator({maxReviews}),/review|budget|configuration/i);
  for(const intervalMs of [0,-1,1.1,2**32])assert.throws(()=>module.createToolCurationCoordinator({intervalMs}),/configuration/i);
  const f=fixture(t,{request:(service,taskId,binding,options)=>{assert.deepEqual(options,{automatic:true});return service.request(taskId,binding,options);}});f.coordinator.start();f.coordinator.configure({enabled:true});const event=f.run({error:true});f.coordinator.observeRun(event);await f.coordinator.runOnce();assert.equal(f.store.list(event.taskId)[0].trigger,'online_gap');
});

test('synchronous busy probe rejects invalid callbacks',()=>{
  for(const isTaskBusy of [null,{},true,'busy'])assert.throws(()=>module.createToolCurationCoordinator({taskStore:{},preview:{},curation:{},isReady:()=>true,isTaskBusy}),/configuration/i);
});

test('synchronous busy probe fails closed on exception before spending an attempt',async t=>{
  const f=fixture(t,{isTaskBusy:()=>{throw Error('secret lifecycle state');}}),c=f.coordinator;c.start();c.configure({enabled:true});const event=f.run();c.observeRun(event);await c.runOnce();
  assert.equal(f.store.list(event.taskId).length,0);assert.equal(c.status().attempts,0);assert.equal(c.status().enabled,false);assert.equal(c.status().reason,'unavailable');assert.equal(c.status().pending,0);assert.ok(!JSON.stringify(c.status()).includes('secret'));
});
