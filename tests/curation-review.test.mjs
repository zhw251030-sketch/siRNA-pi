import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {TaskStore} from '../packages/task-core/task-store.mjs';
import {createToolCurationPreview} from '../packages/extensions/tool-curation/tool-curation-preview.mjs';
import {buildToolCurationTrace} from '../packages/extensions/tool-curation/tool-curation-evidence.mjs';
import {parseToolCurationResult,validateToolCurationResult,toolCurationPrompt} from '../packages/extensions/tool-curation/tool-curation-result.mjs';
import {ToolCurationStore} from '../packages/extensions/tool-curation/tool-curation-store.mjs';
import {createToolCurationService} from '../packages/extensions/tool-curation/tool-curation-service.mjs';

export function skip(run){return {protocolVersion:'sirna-tool-curation-result/v1',curationId:run.id,traceSha256:run.traceSha256,decision:'skip',summary:'No stable reusable boundary.'};}
function candidate(run){return {...skip(run),decision:'candidate',candidate:{capabilityKey:'tool:fetch_dataset',suggestedToolName:'dataset_fetch',capabilityBoundary:'Fetch public datasets by identifier.',whyExistingToolsAreInsufficient:'The catalog has no dataset fetch capability.',evidenceEventIds:run.trace.signals[0].evidenceEventIds,inputContractSketch:{identifier:'string'},outputContractSketch:{rows:'array'},permissions:{profile:'no_external_access'},buildInstructions:['Implement only the bounded dataset interface.']}};}
async function fixture(t,{count=3,catalog=()=>[],curator}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'curation-review-'));
  const tasks=new TaskStore(path.join(root,'tasks.sqlite'));const store=new ToolCurationStore({root});
  const task=tasks.createTask({id:randomUUID()}),runId=randomUUID();const {message}=tasks.beginTurn(task.id,'Compare datasets');tasks.updateExecution(task.id,{currentRunId:runId});
  for(let i=0;i<count;i++){
    tasks.appendRunEvent(task.id,message.id,runId,'tool_start',{toolCallId:`call-${i}`,toolName:'fetch_dataset',args:{identifier:i%2}});
    tasks.appendRunEvent(task.id,message.id,runId,'tool_end',{toolCallId:`call-${i}`,toolName:'fetch_dataset',isError:false,result:{rows:[1,2]}});
  }
  tasks.appendRunEvent(task.id,message.id,runId,'done',{status:'succeeded'});tasks.appendAssistantMessage(task.id,'done','complete');
  const preview=createToolCurationPreview({taskStore:tasks,listExistingTools:catalog});
  let calls=0;const fake=curator??{async curate(run,signal,onStarted){calls++;onStarted('session-1','run-1');return {result:skip(run),sessionId:'session-1',runId:'run-1'};}};
  const service=createToolCurationService({store,preview,curator:fake});service.start();
  t.after(async()=>{await service.stop();store.close();tasks.close();fs.rmSync(root,{recursive:true,force:true});});
  const binding=()=>{const p=preview.read(task.id,runId).preview;return {runId,sourceSha256:p.sourceSha256,previewSha256:p.previewSha256};};
  return {root,tasks,store,task,runId,message,preview,service,binding,calls:()=>calls};
}

test('concurrent requests freeze one trace and dispatch once without altering task evidence',async t=>{
  let release;const gate=new Promise(r=>release=r);let calls=0;
  const f=await fixture(t,{curator:{async curate(run,signal,onStarted){calls++;onStarted('session-1','run-1');await gate;return {result:skip(run),sessionId:'session-1',runId:'run-1'};}}});
  const before=JSON.stringify([f.tasks.getTask(f.task.id),f.tasks.listMessages(f.task.id),f.tasks.listRunEvents(f.task.id)]);
  const bindings=f.binding();const responses=await Promise.all(Array.from({length:8},()=>f.service.request(f.task.id,bindings)));
  assert.equal(new Set(responses.map(r=>r.curation.id)).size,1);assert.equal(responses.filter(r=>!r.deduplicated).length,1);
  await new Promise(r=>setImmediate(r));assert.equal(calls,1);const record=f.service.get(f.task.id,responses[0].curation.id);
  assert.equal(record.curatorSessionId,'session-1');assert.equal(record.curatorRunId,'run-1');
  assert.equal(record.trace.calls.length,3);assert.deepEqual(record.trace.gapReports,[]);assert.equal(record.trace.calls[0].inputShape.identifier,'number');
  assert.equal(record.trace.calls[0].startedAt,f.tasks.listRunEvents(f.task.id)[0].createdAt);
  assert.equal(JSON.stringify([f.tasks.getTask(f.task.id),f.tasks.listMessages(f.task.id),f.tasks.listRunEvents(f.task.id)]),before);
  f.tasks.appendRunEvent(f.task.id,f.message.id,f.runId,'progress_message',{type:'workspace_warning'});
  assert.equal((await f.service.request(f.task.id,bindings)).deduplicated,true);
  assert.deepEqual(f.service.get(f.task.id,record.id).trace,record.trace);
  await assert.rejects(f.service.request(f.task.id,{...bindings,sourceSha256:'0'.repeat(64)}),e=>e.statusCode===409);
  release();await f.service.stop();assert.equal(f.service.get(f.task.id,record.id).status,'skipped');
  assert.equal('trace' in f.service.list(f.task.id)[0],false);
});

test('admission rejects stale source/catalog and missing, busy or insufficient evidence with no records',async t=>{
  let known=[];const f=await fixture(t,{catalog:()=>known});const binding=f.binding();known=['already_registered'];
  await assert.rejects(f.service.request(f.task.id,binding),e=>e.statusCode===409);
  await assert.rejects(f.service.request(randomUUID(),binding),e=>e.statusCode===404);
  await assert.rejects(f.service.request(f.task.id,{...binding,runId:randomUUID()}),e=>e.statusCode===404);
  f.tasks.updateExecution(f.task.id,{status:'running'});await assert.rejects(f.service.request(f.task.id,binding),e=>e.statusCode===409);
  assert.equal(f.store.list(f.task.id).length,0);assert.equal(f.calls(),0);
  const empty=await fixture(t,{count:2});await assert.rejects(empty.service.request(empty.task.id,empty.binding()),e=>e.statusCode===409);assert.equal(empty.calls(),0);
  const incomplete=await fixture(t,{count:13});await assert.rejects(incomplete.service.request(incomplete.task.id,incomplete.binding()),e=>e.statusCode===409);
});

test('result validator binds candidates to complete triggering groups and rejects malformed data',async t=>{
  const f=await fixture(t);const trace=buildToolCurationTrace({id:randomUUID(),snapshot:f.preview.snapshot(f.task.id,f.runId)});const run={id:trace.curationId,trace,traceSha256:trace.traceSha256};
  assert.deepEqual(validateToolCurationResult(run,skip(run)),skip(run));assert.deepEqual(parseToolCurationResult(run,JSON.stringify(candidate(run))),candidate(run));
  const prompt=toolCurationPrompt(run);
  assert.ok(prompt.includes(trace.traceSha256));
  assert.match(prompt,/nested candidate object/i);
  assert.match(prompt,/never put capabilityKey, suggestedToolName, evidenceEventIds, or any other candidate field at the top level/i);
  const mutations=[v=>v.curationId='wrong',v=>v.traceSha256='0'.repeat(64),v=>v.extra=true,v=>v.candidate.capabilityKey='tool:unknown',v=>v.candidate.evidenceEventIds=['foreign'],v=>v.candidate.evidenceEventIds=[],v=>v.candidate.suggestedToolName='Bad-Name',v=>v.candidate.permissions={profile:'controlled_network',networkHosts:['https://evil']},v=>v.candidate.extra=true,v=>v.candidate.buildInstructions=['x'.repeat(2001)],v=>v.candidate.inputContractSketch={nested:{nested:{nested:{nested:{nested:{nested:{nested:{nested:{nested:{nested:{nested:{nested:{nested:{nested:{nested:{nested:{nested:true}}}}}}}}}}}}}}}}},v=>v.summary='x'.repeat(50000)];
  for(const mutate of mutations){const v=candidate(run);mutate(v);assert.throws(()=>validateToolCurationResult(run,v));}
  assert.throws(()=>validateToolCurationResult(run,{...skip(run),candidate:candidate(run).candidate}));
  assert.throws(()=>parseToolCurationResult(run,'```json\n'+JSON.stringify(skip(run))+'\n```'));
  assert.throws(()=>validateToolCurationResult(run,Object.assign(Object.create({inherited:true}),skip(run))));
  const accessor=candidate(run);Object.defineProperty(accessor,'summary',{get(){throw Error('must not execute');},enumerable:true});assert.throws(()=>validateToolCurationResult(run,accessor),/JSON/);
  run.trace.existingTools=['dataset_fetch'];assert.throws(()=>validateToolCurationResult(run,candidate(run)));
});

test('invalid terminal result persists failure identity; cleanup uncertainty halts subsequent admissions durably',async t=>{
  const f=await fixture(t,{curator:{async curate(run,signal,onStarted){onStarted('saved-session','saved-run');throw Object.assign(Error('private detail'),{cleanupFailed:true});}}});
  const {curation}=await f.service.request(f.task.id,f.binding());await f.service.stop();const failed=f.service.get(f.task.id,curation.id);
  assert.equal(failed.status,'error');assert.equal(failed.curatorSessionId,'saved-session');assert.equal(f.store.isAdmissionHalted(),true);assert.ok(!failed.error.includes('private detail'));
  f.service.start();await assert.rejects(f.service.request(f.task.id,f.binding()),e=>e.statusCode===503);
});

test('snapshot preserves the public preview shape and its catalog is detached from caller mutation',async t=>{
  const known=['registered'];const f=await fixture(t,{catalog:()=>known});const shot=f.preview.snapshot(f.task.id,f.runId);
  assert.deepEqual(f.preview.read(f.task.id,f.runId),{preview:shot.preview});known.push('fetch_dataset');assert.deepEqual(shot.existingTools,['registered']);
});

test('complete triggering IDs do not claim unclipped input/output contents',async t=>{
  const f=await fixture(t);const shot=f.preview.snapshot(f.task.id,f.runId);
  // Real preview construction retains all event IDs while clipping long output.
  const {buildCurationPreview}=await import('../packages/extensions/tool-curation/tool-curation-trace.mjs');
  shot.events[1].payload.result={rows:'x'.repeat(3000)};shot.preview=buildCurationPreview({taskId:f.task.id,runId:f.runId,userMessageId:f.message.id,objective:'Compare datasets',events:shot.events,existingTools:shot.existingTools});
  const trace=buildToolCurationTrace({id:randomUUID(),snapshot:shot});assert.equal(trace.calls.length,3);assert.equal(trace.truncated,true);assert.equal(trace.evidenceMetadata.completeTriggerEvidence,true);assert.equal(trace.calls[0].outputShape.type,'unknown');
});

test('service rejects oversized final trace and never dispatches when unavailable',async t=>{
  const f=await fixture(t);const shot=f.preview.snapshot(f.task.id,f.runId);
  const unavailable=createToolCurationService({store:f.store,preview:f.preview});unavailable.start();await assert.rejects(unavailable.request(f.task.id,f.binding()),e=>e.statusCode===503);await unavailable.stop();
  shot.existingTools=Array.from({length:500},(_,i)=>`tool_${i}_${'x'.repeat(115)}`);
  const {buildCurationPreview}=await import('../packages/extensions/tool-curation/tool-curation-trace.mjs');
  shot.preview=buildCurationPreview({taskId:f.task.id,runId:f.runId,userMessageId:f.message.id,objective:'Compare datasets',events:shot.events,existingTools:shot.existingTools});
  // Final trace must retain the whole catalog; it cannot trim evidence to fit.
  const heavy=createToolCurationService({store:f.store,preview:{snapshot:()=>shot},curator:{curate(){throw Error('must not dispatch');}}});heavy.start();
  await assert.rejects(heavy.request(f.task.id,{runId:f.runId,sourceSha256:shot.preview.sourceSha256,previewSha256:shot.preview.previewSha256}),e=>e.statusCode===413);await heavy.stop();assert.equal(f.store.list(f.task.id).length,0);
});

test('normal stop waits for accepted work and blocks new requests; malformed terminal response stays error',async t=>{
  let release;const gate=new Promise(r=>release=r);
  const f=await fixture(t,{curator:{async curate(run,signal,onStarted){onStarted('session','run');await gate;return {result:{...skip(run),traceSha256:'0'.repeat(64)},sessionId:'session',runId:'run'};}}});
  const accepted=await f.service.request(f.task.id,f.binding());let stopped=false;const stopping=f.service.stop().then(()=>stopped=true);
  await new Promise(r=>setImmediate(r));assert.equal(stopped,false);await assert.rejects(f.service.request(f.task.id,f.binding()),e=>e.statusCode===503);release();await stopping;
  const row=f.service.get(f.task.id,accepted.curation.id);assert.equal(row.status,'error');assert.equal(row.curatorSessionId,'session');assert.equal(f.store.isAdmissionHalted(),false);
});

test('restart marks old in-flight requests error without model dispatch and keeps admission halted',async t=>{
  const f=await fixture(t);const old=f.store.create(buildToolCurationTrace({id:randomUUID(),snapshot:f.preview.snapshot(f.task.id,f.runId)})).curation;
  f.store.markRunning(old.id);f.store.setIdentity(old.id,'interrupted','unknown-run');
  let calls=0;const next=createToolCurationService({store:f.store,preview:f.preview,curator:{curate(){calls++;}}});next.start();await next.stop();
  assert.equal(calls,0);assert.equal(next.get(f.task.id,old.id).status,'error');assert.equal(f.store.isAdmissionHalted(),true);
});

test('exact permission hosts reject empty or malformed DNS labels',async t=>{
  const f=await fixture(t);const trace=buildToolCurationTrace({id:randomUUID(),snapshot:f.preview.snapshot(f.task.id,f.runId)}),run={id:trace.curationId,trace,traceSha256:trace.traceSha256};
  for(const host of ['a..b','a.-b','-a.b','a-.b','a'.repeat(64)+'.org']){const result=candidate(run);result.candidate.permissions={profile:'controlled_network',networkHosts:[host]};assert.throws(()=>validateToolCurationResult(run,result));}
  const result=candidate(run);result.candidate.permissions={profile:'controlled_network',networkHosts:['data.example.org']};assert.doesNotThrow(()=>validateToolCurationResult(run,result));
});

test('single consumer bounds accepted work and graceful stop drains every accepted request',async t=>{
  let release,active=0,maxActive=0,calls=0;const gate=new Promise(r=>release=r);
  const f=await fixture(t,{curator:{async curate(run,signal,onStarted){calls++;active++;maxActive=Math.max(maxActive,active);onStarted(`session-${run.id}`,`run-${run.id}`);await gate;active--;return {result:skip(run),sessionId:`session-${run.id}`,runId:`run-${run.id}`};}}});
  const first=await f.service.request(f.task.id,f.binding());
  for(let n=0;n<31;n++){
    const runId=randomUUID(),{message}=f.tasks.beginTurn(f.task.id,'Another completed round');f.tasks.updateExecution(f.task.id,{currentRunId:runId});
    for(let i=0;i<2;i++){f.tasks.appendRunEvent(f.task.id,message.id,runId,'tool_start',{toolCallId:`c${i}`,toolName:'fetch_dataset',args:{id:i}});f.tasks.appendRunEvent(f.task.id,message.id,runId,'tool_end',{toolCallId:`c${i}`,toolName:'fetch_dataset',isError:true,result:{error:'not found'}});}
    f.tasks.appendRunEvent(f.task.id,message.id,runId,'done',{});f.tasks.appendAssistantMessage(f.task.id,'done','complete');
    const p=f.preview.read(f.task.id,runId).preview;await f.service.request(f.task.id,{runId,sourceSha256:p.sourceSha256,previewSha256:p.previewSha256});
  }
  await assert.rejects(f.service.request(f.task.id,{...f.binding(),runId:randomUUID()}),e=>e.statusCode===503);
  assert.equal(f.service.list(f.task.id).length,32);release();await f.service.stop();assert.equal(calls,32);assert.equal(maxActive,1);assert.ok(f.service.list(f.task.id).every(r=>r.status==='skipped'));assert.equal(f.service.get(f.task.id,first.curation.id).status,'skipped');
});

test('storage failure halts in memory without an unhandled worker rejection',async t=>{
  const f=await fixture(t);const broken=new Proxy(f.store,{get(target,name){if(name==='fail')return ()=>{throw Error('private database failure');};const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value;}});
  const service=createToolCurationService({store:broken,preview:f.preview,curator:{async curate(run,signal,onStarted){onStarted('saved','saved-run');throw Error('ordinary curator error');}}});service.start();await service.request(f.task.id,f.binding());await new Promise(r=>setImmediate(r));
  await assert.rejects(service.stop(),e=>e.statusCode===503&&!e.message.includes('private'));
  service.start();await assert.rejects(service.request(f.task.id,f.binding()),e=>e.statusCode===503);assert.equal(f.store.isAdmissionHalted(),true);
});

test('cleanup uncertainty returned with a result is still a durable failure',async t=>{
  const f=await fixture(t,{curator:{async curate(run,signal,onStarted){onStarted('saved','saved-run');return {result:skip(run),sessionId:'saved',runId:'saved-run',cleanupConfirmed:false};}}});
  const {curation}=await f.service.request(f.task.id,f.binding());await f.service.stop();assert.equal(f.service.get(f.task.id,curation.id).status,'error');assert.equal(f.store.isAdmissionHalted(),true);
});

test('database unavailability returns safe 503 at admission and read boundaries',async t=>{
  const f=await fixture(t);let failed=false;
  const broken=new Proxy(f.store,{get(target,name){if(failed&&['find','get','list','isAdmissionHalted'].includes(name))return ()=>{throw Error('PRIVATE STORAGE DATA');};const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value;}});
  const service=createToolCurationService({store:broken,preview:f.preview,curator:{async curate(){throw Error('must not run');}}});service.start();failed=true;
  await assert.rejects(service.request(f.task.id,f.binding()),e=>e.statusCode===503&&!e.message.includes('PRIVATE'));
  assert.throws(()=>service.get(f.task.id,randomUUID()),e=>e.statusCode===503);assert.throws(()=>service.list(f.task.id),e=>e.statusCode===503);
});

test('cleanup uncertainty dominates malformed or conflicting response identities',async t=>{
  for(const response of [{sessionId:'saved',cleanupConfirmed:false},{sessionId:'other',runId:'other-run',cleanupFailed:true},{sessionId:17,outcomeUnknown:true}]){
    const f=await fixture(t,{curator:{async curate(run,signal,onStarted){onStarted('saved','saved-run');return response;}}});
    const {curation}=await f.service.request(f.task.id,f.binding());await f.service.stop();const record=f.service.get(f.task.id,curation.id);
    assert.equal(record.status,'error');assert.equal(record.curatorSessionId,'saved');assert.equal(record.curatorRunId,'saved-run');assert.equal(f.store.isAdmissionHalted(),true);
  }
});

test('frozen catalog is canonical and equivalent aliases keep the existing public preview hashes',async t=>{
  let known=['alpha','zeta'];const f=await fixture(t,{catalog:()=>known});const first=f.preview.snapshot(f.task.id,f.runId);
  known=['sirna_tools_zeta','alpha','sirna_tools_alpha'];const second=f.preview.snapshot(f.task.id,f.runId);
  assert.deepEqual(second.preview,first.preview);assert.deepEqual(second.existingTools,['alpha','zeta']);
  const id=randomUUID();assert.deepEqual(buildToolCurationTrace({id,snapshot:first}),buildToolCurationTrace({id,snapshot:second}));
});

test('candidate names cannot collide with exact or normalized catalog aliases',async t=>{
  const f=await fixture(t),trace=buildToolCurationTrace({id:randomUUID(),snapshot:f.preview.snapshot(f.task.id,f.runId)}),run={id:trace.curationId,trace,traceSha256:trace.traceSha256};
  for(const [existing,name] of [['sirna_tools_dataset_fetch','sirna_tools_dataset_fetch'],['dataset_fetch','sirna_tools_dataset_fetch'],['sirna_tools_dataset_fetch','dataset_fetch']]){
    run.trace.existingTools=[existing];const result=candidate(run);result.candidate.suggestedToolName=name;assert.throws(()=>validateToolCurationResult(run,result));
  }
});

test('nested namespace prefixes preserve original 11A builder hash semantics',async t=>{
  let known=['alpha'];const f=await fixture(t,{catalog:()=>known});const first=f.preview.snapshot(f.task.id,f.runId);
  known=['sirna_tools_sirna_tools_alpha'];const second=f.preview.snapshot(f.task.id,f.runId);
  const {buildCurationPreview}=await import('../packages/extensions/tool-curation/tool-curation-trace.mjs');
  const expected=buildCurationPreview({taskId:f.task.id,runId:f.runId,userMessageId:f.message.id,objective:'Compare datasets',events:second.events,existingTools:known});
  assert.deepEqual(second.preview,expected);assert.notEqual(second.preview.sourceSha256,first.preview.sourceSha256);assert.deepEqual(second.existingTools,['sirna_tools_alpha']);
});

test('uncertain response retains a new valid run identity reported after session callback',async t=>{
  const f=await fixture(t,{curator:{async curate(run,signal,onStarted){onStarted('known-session');return {sessionId:'known-session',runId:'known-run',cleanupConfirmed:false};}}});
  const {curation}=await f.service.request(f.task.id,f.binding());await f.service.stop();const record=f.service.get(f.task.id,curation.id);
  assert.equal(record.curatorSessionId,'known-session');assert.equal(record.curatorRunId,'known-run');assert.equal(record.status,'error');assert.equal(f.store.isAdmissionHalted(),true);
});
