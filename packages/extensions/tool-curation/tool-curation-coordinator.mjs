import {randomUUID} from 'node:crypto';
import {ToolCurationError} from './tool-curation-service.mjs';
import {assertCurationJson,buildToolCurationTrace} from './tool-curation-evidence.mjs';
import {curationBuildPrompt} from './tool-curation-build-contract.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const runIdentity=/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$/i;
const fail=(status,message)=>{throw new ToolCurationError(status,message);};

// Observations are intentionally process-local. Only the existing Curator
// store owns durable admission, task/run uniqueness, and accepted work.
export function createToolCurationCoordinator({taskStore,preview,curation,toolCurationBuild,isReady,isTaskBusy=()=>false,intervalMs=1000,maxReviews=3,maxBuilds=maxReviews}={}){
  if(!Number.isInteger(maxReviews)||maxReviews<1||maxReviews>10||!Number.isInteger(intervalMs)||intervalMs<1||intervalMs>2147483647)throw Error('Invalid coordinator review budget or interval configuration');
  if(!Number.isInteger(maxBuilds)||maxBuilds<1||maxBuilds>10)throw Error('Invalid coordinator Builder budget configuration');
  if(!taskStore||!preview||!curation||typeof isReady!=='function'||typeof isTaskBusy!=='function')throw Error('Incomplete coordinator configuration');
  if(toolCurationBuild!==undefined&&typeof toolCurationBuild.start!=='function')throw Error('Invalid coordinator Builder service');
  let started=false,enabled=false,attempts=0,buildAttempts=0,generation=0,reason='stopped',timer,worker;
  const pending=new Map(),seen=new Set(),automaticCurations=new Set(),dispatchedBuilds=new Set(),buildWork=new Set(),recent=[];
  const keyOf=event=>`${event.taskId}/${event.runId}`;
  function record(event,state,label,curationId){
    recent.push({taskId:event.taskId,runId:event.runId,userMessageId:event.userMessageId,state,reason:label,...(curationId?{curationId}:{})});
    if(recent.length>20)recent.shift();
  }
  function close(label){enabled=false;reason=label;generation++;pending.clear();}
  function remove(event,label){pending.delete(keyOf(event));record(event,'ignored',label);}
  function currentTask(event){
    const task=taskStore.getTask(event.taskId);
    if(!task||task.currentRunId!==event.runId||task.status==='stopped')return undefined;
    const source=taskStore.readRunEvidence(event.taskId,event.runId);
    if(!source||source.tooLarge||source.inconsistent||source.userMessage?.id!==event.userMessageId||source.userMessage.role!=='user')return undefined;
    return task;
  }
  async function consume(){
    for(const event of [...pending.values()]){
      if(!started||!enabled)break;
      if(!pending.has(keyOf(event)))continue;
      const epoch=generation;
      let requested=false;
      try{
        let task=currentTask(event);
        if(!task){remove(event,'stale_run');continue;}
        if(task.status==='running')continue;
        const ready=await isReady(task);
        // A delayed readiness result must never resurrect disabled observations
        // or dispatch against a replacement turn or stopped task.
        if(!started||!enabled||epoch!==generation||!pending.has(keyOf(event)))continue;
        task=currentTask(event);
        if(!task){remove(event,'stale_run');continue;}
        if(!ready||task.status==='running')continue;
        // Promise reactions can reserve lifecycle work after async readiness
        // resolves. Recheck synchronously; admission below has no further await.
        if(isTaskBusy(event.taskId))continue;
        let snapshot;
        try{
          snapshot=preview.snapshot(event.taskId,event.runId);
          const p=snapshot.preview;
          if(!p||p.taskId!==event.taskId||p.runId!==event.runId||p.userMessageId!==event.userMessageId)throw Error('Invalid preview binding');
          // Validate the complete frozen envelope before spending an attempt.
          buildToolCurationTrace({id:randomUUID(),snapshot});
        }catch(error){
          if(error?.statusCode===503)throw error;
          remove(event,'ineligible_preview');continue;
        }
        const previous=curation.find(event.taskId,event.runId);
        pending.delete(keyOf(event));
        if(previous){record(event,'deduplicated','existing_review',previous.id);continue;}
        if(attempts>=maxReviews){close('budget_exhausted');break;}
        const p=snapshot.preview;
        attempts++;
        // Reservation and service admission have no intervening await. An
        // unknown/rejected request still costs this conservative attempt.
        requested=true;
        const result=await curation.request(event.taskId,{runId:event.runId,sourceSha256:p.sourceSha256,previewSha256:p.previewSha256},{automatic:true});
        if(!result.deduplicated)automaticCurations.add(result.curation.id);
        if(attempts>=maxReviews)close('budget_exhausted');
        record(event,result.deduplicated?'deduplicated':'admitted',result.deduplicated?'existing_review':'review_requested',result.curation.id);
      }catch{
        if(!requested&&(!started||!enabled||epoch!==generation))continue;
        record(event,'error','unavailable');
        if(started)close('unavailable');
      }
    }
  }
  function observeCuration(input,metadata={}){
    try{assertCurationJson(input,{maxDepth:32,maxBytes:65536});}catch{record({taskId:'unknown',runId:'unknown',userMessageId:'unknown'},'ignored','invalid_curation');return;}
    if(!input||metadata?.automatic!==true||typeof input.id!=='string'||dispatchedBuilds.has(input.id))return;
    automaticCurations.add(input.id);
    dispatchedBuilds.add(input.id);
    const event={taskId:input.taskId,runId:input.runId,userMessageId:input.userMessageId};
    if(input.status!=='candidate'){
      record(event,'ignored',input.status==='skipped'?'curation_skip':'curation_error',input.id);return;
    }
    if(!toolCurationBuild){
      record(event,'ignored','builder_unconfigured',input.id);return;
    }
    if(buildAttempts>=maxBuilds){
      record(event,'ignored','builder_budget_exhausted',input.id);return;
    }
    if(isTaskBusy(input.taskId)){
      record(event,'ignored','builder_busy',input.id);return;
    }
    let frozen;
    try{frozen=curationBuildPrompt(input);}catch{record(event,'ignored','invalid_candidate',input.id);return;}
    buildAttempts++;
    let operation;
    try{operation=Promise.resolve(toolCurationBuild.start(input.taskId,input.id,frozen.binding));}
    catch(error){record(event,'error',error?.statusCode===409?'builder_busy':'builder_error',input.id);return;}
    const tracked=operation.then(result=>record(event,'admitted',result?.deduplicated?'builder_deduplicated':'builder_dispatched',input.id),error=>record(event,'error',error?.statusCode===409?'builder_busy':'builder_error',input.id));
    buildWork.add(tracked);tracked.finally(()=>buildWork.delete(tracked));
  }
  function runOnce(){
    if(worker)return worker;
    if(!started||!enabled)return Promise.resolve();
    worker=Promise.resolve().then(consume).finally(()=>{worker=undefined;});
    return worker;
  }
  function status(){return structuredClone({protocolVersion:'sirna-tool-curation-automation/v1',started,enabled,maxReviews,attempts,remaining:maxReviews-attempts,maxBuilds,buildAttempts,buildRemaining:maxBuilds-buildAttempts,pending:pending.size,reason,recent});}
  return {
    start(){
      if(started)return;
      started=true;enabled=false;reason=attempts>=maxReviews?'budget_exhausted':'disabled';
      timer=setInterval(()=>{void runOnce();},intervalMs);timer.unref?.();
    },
    async stop(){
      started=false;close('stopped');clearInterval(timer);timer=undefined;
      if(worker)await worker;
      if(buildWork.size)await Promise.allSettled([...buildWork]);
    },
    configure(input){
      if(!started)fail(503,'Automatic curation is unavailable.');
      try{assertCurationJson(input,{maxDepth:1,maxBytes:1024});}catch{fail(400,'Expected only a boolean enabled field.');}
      if(!input||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'enabled')||typeof input.enabled!=='boolean')fail(400,'Expected only a boolean enabled field.');
      if(input.enabled&&attempts>=maxReviews)fail(409,'Automatic curation review budget is exhausted for this service startup.');
      if(!input.enabled)close('disabled');
      else {enabled=true;reason='enabled';}
      return status();
    },
    status,
    observeRun(input){
      try{assertCurationJson(input,{maxDepth:1,maxBytes:2048});}catch{fail(400,'Invalid saved run notification.');}
      if(!input||Object.keys(input).some(k=>!['taskId','runId','userMessageId','requestId'].includes(k))||!uuid.test(input.taskId)||!uuid.test(input.userMessageId)||!runIdentity.test(input.runId)||Object.hasOwn(input,'requestId')&&(typeof input.requestId!=='string'||input.requestId.length>1024))fail(400,'Invalid saved run notification.');
      const event={taskId:input.taskId,runId:input.runId,userMessageId:input.userMessageId};
      if(input.requestId?.startsWith('auto-tool-curation-build:')){record(event,'ignored','builder_source');return;}
      if(!started||!enabled){record(event,'ignored',started?'disabled':'stopped');return;}
      const key=keyOf(event);
      if(seen.has(key)){record(event,'deduplicated','observed_run');return;}
      if(seen.size>=256||pending.size>=32){record(event,'ignored','capacity_exhausted');close('capacity_exhausted');return;}
      seen.add(key);pending.set(key,event);record(event,'queued','new_run');
      queueMicrotask(()=>{void runOnce();});
    },
    observeCuration,
    runOnce,
  };
}
