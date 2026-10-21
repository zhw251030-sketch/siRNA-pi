import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {TaskStore} from '../packages/task-core/task-store.mjs';
import {ToolCurationStore} from '../packages/extensions/tool-curation/tool-curation-store.mjs';
import {createToolCurationPreview} from '../packages/extensions/tool-curation/tool-curation-preview.mjs';
import {buildToolCurationTrace,traceSha256} from '../packages/extensions/tool-curation/tool-curation-evidence.mjs';
import {createToolCurationService} from '../packages/extensions/tool-curation/tool-curation-service.mjs';

const week=604800000;
function candidate(run){return {protocolVersion:'sirna-tool-curation-result/v1',curationId:run.id,traceSha256:run.traceSha256,decision:'candidate',summary:'Model recommends a reusable tool.',candidate:{capabilityKey:run.trace.signals[0].capabilityKey,suggestedToolName:'dataset_fetch',capabilityBoundary:'Fetch datasets.',whyExistingToolsAreInsufficient:'No registered dataset fetch tool.',evidenceEventIds:run.trace.signals[0].evidenceEventIds,inputContractSketch:{identifier:'string'},outputContractSketch:{rows:'array'},permissions:{profile:'no_external_access'},buildInstructions:['Implement only this interface.']}};}
function fixture(t,{cooldownMs=week,clock=Date.now,defaultCooldown=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'curation-cooldown-'))),tasks=new TaskStore(path.join(root,'tasks.sqlite')),store=new ToolCurationStore({root});
  const preview=createToolCurationPreview({taskStore:tasks,listExistingTools:()=>[]});const responses=[];
  const service=createToolCurationService({store,preview,...(defaultCooldown?{}:{cooldownMs}),clock,curator:{async curate(run,signal,onStarted){onStarted('session','run');const result=candidate(run);responses.push(result);return {result,sessionId:'session',runId:'run'};}}});service.start();
  t.after(async()=>{await service.stop();store.close();tasks.close();fs.rmSync(root,{recursive:true,force:true});});
  function run({toolName='fetch_dataset',taskId}={}){
    const task=taskId?tasks.getTask(taskId):tasks.createTask({id:randomUUID()}),{message}=tasks.beginTurn(task.id,'Fetch a dataset'),runId=randomUUID();tasks.updateExecution(task.id,{currentRunId:runId});
    for(let i=0;i<3;i++){tasks.appendRunEvent(task.id,message.id,runId,'tool_start',{toolName,toolCallId:`c${i}`,args:{id:i}});tasks.appendRunEvent(task.id,message.id,runId,'tool_end',{toolName,toolCallId:`c${i}`,result:{rows:[1]},isError:false});}
    tasks.appendRunEvent(task.id,message.id,runId,'done',{status:'succeeded'});tasks.appendAssistantMessage(task.id,'done','complete');
    const p=preview.read(task.id,runId).preview;return {taskId:task.id,binding:{runId,sourceSha256:p.sourceSha256,previewSha256:p.previewSha256}};
  }
  async function review(options){service.start();const event=run(options),accepted=await service.request(event.taskId,event.binding);await service.stop();return service.get(event.taskId,accepted.curation.id);}
  function completedAt(id,value){const db=new DatabaseSync(store.databasePath);db.prepare('UPDATE curations SET completed_at=? WHERE id=?').run(value,id);db.close();}
  return {tasks,store,preview,service,responses,run,review,completedAt};
}

test('same capability on a different real task becomes backend skip without mutating original model result',async t=>{
  const f=fixture(t),first=await f.review(),second=await f.review();assert.notEqual(first.taskId,second.taskId);assert.equal(first.status,'candidate');assert.equal(second.status,'skipped');assert.equal(second.result.decision,'skip');assert.match(second.result.summary,/后端冷却规则/);assert.ok(second.result.summary.includes(first.id));assert.equal('candidate' in second.result,false);
  assert.equal(f.responses[1].decision,'candidate');assert.equal(f.responses[1].summary,'Model recommends a reusable tool.');assert.equal(f.service.get(first.taskId,first.id).status,'candidate');
});

test('cooldown defaults off; different capability, expired and future candidates remain candidates',async t=>{
  const legacy=fixture(t,{defaultCooldown:true});assert.equal((await legacy.review()).status,'candidate');assert.equal((await legacy.review()).status,'candidate');
  const now=Date.parse('2026-10-22T12:00:00.000Z');
  for(const [label,offset] of [['expired',-week-1],['future',1]])await t.test(label,async t=>{const f=fixture(t,{clock:()=>now}),one=await f.review();f.completedAt(one.id,new Date(now+offset).toISOString());assert.equal((await f.review()).status,'candidate');});
  const f=fixture(t),one=await f.review(),other=await f.review({toolName:'different_tool'});assert.equal(one.status,'candidate');assert.equal(other.status,'candidate');
});

test('inclusive seven-day boundaries and skipped results do not extend original cooldown',async t=>{
  let now=Date.parse('2026-10-22T12:00:00.000Z');const f=fixture(t,{clock:()=>now}),first=await f.review();f.completedAt(first.id,new Date(now-week).toISOString());const skipped=await f.review();assert.equal(skipped.status,'skipped');
  now++;assert.equal((await f.review()).status,'candidate');
  const g=fixture(t,{clock:()=>now}),atUpper=await g.review();g.completedAt(atUpper.id,new Date(now).toISOString());assert.equal((await g.review()).status,'skipped');
});

test('lookup searches beyond list window and returns a detached fully validated matching record',async t=>{
  const f=fixture(t),first=await f.review();
  for(let i=0;i<101;i++){
    const e=f.run({taskId:first.taskId,toolName:'another_tool'}),trace=buildToolCurationTrace({id:randomUUID(),snapshot:f.preview.snapshot(e.taskId,e.binding.runId)});f.store.create(trace);
  }
  assert.equal(f.store.list(first.taskId).length,100);assert.ok(!f.store.list(first.taskId).some(r=>r.id===first.id));
  const found=f.store.findRecentCandidate(first.result.candidate.capabilityKey,{excludeId:randomUUID(),since:Date.now()-week,until:Date.now()});assert.equal(found.id,first.id);assert.deepEqual(found.trace,first.trace);found.result.summary='modified';assert.equal(f.store.get(first.taskId,first.id).result.summary,'Model recommends a reusable tool.');
  assert.equal(f.store.findRecentCandidate(first.result.candidate.capabilityKey,{excludeId:first.id,since:0,until:Date.now()}),undefined);assert.equal((await f.review()).status,'skipped');
});

test('corrupted candidate result or trace binding fails closed rather than bypassing cooldown',async t=>{
  for(const corruption of ['result','trace','time'])await t.test(corruption,async t=>{
    const f=fixture(t),first=await f.review(),db=new DatabaseSync(f.store.databasePath);
    if(corruption==='result')db.prepare('UPDATE curations SET result_json=? WHERE id=?').run(JSON.stringify({...first.result,traceSha256:'0'.repeat(64)}),first.id);
    if(corruption==='trace'){db.exec('DROP TRIGGER curation_trace_immutable');db.prepare('UPDATE curations SET trace_json=? WHERE id=?').run(JSON.stringify({...first.trace,objective:'changed'}),first.id);}
    if(corruption==='time')db.prepare('UPDATE curations SET completed_at=? WHERE id=?').run('invalid-time',first.id);db.close();
    assert.throws(()=>f.store.findRecentCandidate(first.result.candidate.capabilityKey,{excludeId:randomUUID(),since:Date.now()-week,until:Date.now()}));
    const next=await f.review();assert.equal(next.status,'error');assert.equal(next.result,undefined);assert.match(next.error,/no retry/);
  });
});

test('optional trigger override validates before hashing and default no-gap trace bytes stay unchanged',async t=>{
  const f=fixture(t),event=f.run(),snapshot=f.preview.snapshot(event.taskId,event.binding.runId),id=randomUUID();
  const base=buildToolCurationTrace({id,snapshot}),same=buildToolCurationTrace({id,snapshot,trigger:'post_run'});assert.deepEqual(base,same);assert.equal(base.trigger,'post_run');
  const online=buildToolCurationTrace({id,snapshot,trigger:'online_gap'});assert.equal(online.trigger,'online_gap');assert.equal(online.traceSha256,traceSha256(online));assert.notEqual(online.traceSha256,base.traceSha256);assert.throws(()=>buildToolCurationTrace({id,snapshot,trigger:'unsafe'}));
});
