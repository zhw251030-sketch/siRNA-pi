import {createHash,randomUUID} from 'node:crypto';
import {ToolCurationError} from './tool-curation-service.mjs';
import {assertCurationJson,buildToolCurationTrace} from './tool-curation-evidence.mjs';
import {buildRequestId,curationBuildPrompt} from './tool-curation-build-contract.mjs';
import {getToolProposalSource} from '../../capability-platform/tool-proposal-source.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const runIdentity=/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$/i;
const fail=(status,message)=>{throw new ToolCurationError(status,message);};

// Observations are intentionally process-local. Only the existing Curator
// store owns durable admission, task/run uniqueness, and accepted work.
export function createToolCurationCoordinator({root,taskStore,preview,curation,toolCurationBuild,toolMaintenance,toolRepair,toolAutomation,toolApproval,approveTool,automaticValidation=false,automaticRepair=false,automaticApproval=false,approvalActor='agent-auto-pipeline',isReady,isTaskBusy=()=>false,intervalMs=1000,maxReviews=3,maxBuilds=maxReviews,maxValidations=maxBuilds,maxRepairs=maxValidations,maxApprovals=maxValidations}={}){
  if(!Number.isInteger(maxReviews)||maxReviews<1||maxReviews>10||!Number.isInteger(intervalMs)||intervalMs<1||intervalMs>2147483647)throw Error('Invalid coordinator review budget or interval configuration');
  if(!Number.isInteger(maxBuilds)||maxBuilds<1||maxBuilds>10)throw Error('Invalid coordinator Builder budget configuration');
  if(typeof automaticValidation!=='boolean'||typeof automaticRepair!=='boolean'||typeof automaticApproval!=='boolean'||!Number.isInteger(maxValidations)||maxValidations<1||maxValidations>10||!Number.isInteger(maxRepairs)||maxRepairs<1||maxRepairs>10||!Number.isInteger(maxApprovals)||maxApprovals<1||maxApprovals>10)throw Error('Invalid coordinator validation configuration');
  if(!taskStore||!preview||!curation||typeof isReady!=='function'||typeof isTaskBusy!=='function')throw Error('Incomplete coordinator configuration');
  if(toolCurationBuild!==undefined&&typeof toolCurationBuild.start!=='function')throw Error('Invalid coordinator Builder service');
  if(toolMaintenance!==undefined&&typeof toolMaintenance.enqueue!=='function')throw Error('Invalid coordinator maintenance service');
  if(toolRepair!==undefined&&typeof toolRepair.start!=='function')throw Error('Invalid coordinator repair service');
  if(toolApproval!==undefined&&(typeof toolApproval.enqueue!=='function'||typeof toolApproval.latest!=='function'))throw Error('Invalid coordinator approval worker');
  if(approveTool!==undefined&&typeof approveTool!=='function')throw Error('Invalid coordinator approval service');
  if(typeof approvalActor!=='string'||approvalActor.trim().length===0||approvalActor.length>120)throw Error('Invalid coordinator approval actor');
  if(toolAutomation!==undefined&&(typeof toolAutomation.registerProposal!=='function'||typeof toolAutomation.get!=='function'||typeof toolAutomation.listOpen!=='function'||typeof toolAutomation.setPhase!=='function'))throw Error('Invalid coordinator automation store');
  let started=false,enabled=false,attempts=0,buildAttempts=0,validationAttempts=0,repairAttempts=0,approvalAttempts=0,generation=0,reason='stopped',timer,worker;
  const pending=new Map(),seen=new Set(),automaticCurations=new Set(),dispatchedBuilds=new Set(),automaticBuilds=new Set(),validationTickets=new Set(),automaticValidationProposals=new Map(),automaticRepairTickets=new Set(),automaticApprovalProposals=new Set(),buildWork=new Set(),validationWork=new Set(),repairWork=new Set(),approvalWork=new Set(),automationWork=new Set(),recent=[];
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
    const event={taskId:input.taskId,runId:input.runId,userMessageId:input.userMessageId};
    if(!started||!enabled){record(event,'ignored',started?'builder_disabled':'stopped',input.id);return;}
    automaticCurations.add(input.id);
    dispatchedBuilds.add(input.id);
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
    // Reserve provenance synchronously before invoking Builder. A very fast
    // runtime may settle the ticket before the start promise's microtask runs.
    automaticBuilds.add(input.id);
    let operation;
    try{operation=Promise.resolve(toolCurationBuild.start(input.taskId,input.id,frozen.binding));}
    catch(error){automaticBuilds.delete(input.id);record(event,'error',error?.statusCode===409?'builder_busy':'builder_error',input.id);return;}
    const tracked=operation.then(result=>{if(!result?.handoff||result?.deduplicated)automaticBuilds.delete(input.id);record(event,'admitted',result?.deduplicated?'builder_deduplicated':'builder_dispatched',input.id);},error=>{automaticBuilds.delete(input.id);record(event,'error',error?.statusCode===409?'builder_busy':'builder_error',input.id);});
    buildWork.add(tracked);tracked.finally(()=>buildWork.delete(tracked));
  }
  const validationRequestId=(curationId,proposalId,artifactSha256)=>{
    const chars=createHash('sha256').update(`automatic-tool-validation:v1\0${proposalId}\0${curationId}\0${artifactSha256}`).digest('hex').split('');
    chars[12]='4';chars[16]=(Number.parseInt(chars[16],16)&3|8).toString(16);
    return `${chars.slice(0,8).join('')}-${chars.slice(8,12).join('')}-${chars.slice(12,16).join('')}-${chars.slice(16,20).join('')}-${chars.slice(20,32).join('')}`;
  };
  const approvalRequestId=proposalId=>{
    const chars=createHash('sha256').update(`automatic-tool-approval:v1\0${proposalId}\0${approvalActor}`).digest('hex').split('');
    chars[12]='4';chars[16]=(Number.parseInt(chars[16],16)&3|8).toString(16);
    return `${chars.slice(0,8).join('')}-${chars.slice(8,12).join('')}-${chars.slice(12,16).join('')}-${chars.slice(16,20).join('')}-${chars.slice(20,32).join('')}`;
  };
  function automationEvent(run){return {taskId:run.sourceTaskId,runId:run.sourceRunId??'unknown',userMessageId:run.sourceUserMessageId??'unknown'};}
  function automationPhase(proposalId,phase,error=null){try{toolAutomation?.setPhase(proposalId,phase,error);}catch{/* Durable automation state is fail-closed and never replaces the source evidence. */}}
  function queueValidation(input,event){
    if(!automaticValidation){record(event,'ignored','validation_disabled',input.curationId);return;}
    if(!toolMaintenance){record(event,'ignored','validation_unconfigured',input.curationId);return;}
    if(automaticValidationProposals.has(input.proposalId))return;
    if(validationAttempts>=maxValidations){automationPhase(input.proposalId,'failed','validation_budget_exhausted');record(event,'ignored','validation_budget_exhausted',input.curationId);return;}
    if(typeof input.proposalId!=='string'||typeof input.artifactSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.artifactSha256)||typeof input.curationId!=='string'){
      automationPhase(input.proposalId,'failed','invalid_validation_binding');record(event,'ignored','invalid_validation_binding',input.curationId);return;
    }
    if(toolAutomation&&!toolAutomation.get(input.proposalId)){
      if(typeof input.toolName!=='string'||!/^[a-z][a-z0-9_]{2,63}$/.test(input.toolName)){record(event,'ignored','automation_tool_name_missing',input.curationId);return;}
      try{toolAutomation.registerProposal({proposalId:input.proposalId,sourceTaskId:event.taskId,sourceRunId:event.runId,sourceUserMessageId:event.userMessageId,curationId:input.curationId,toolName:input.toolName,artifactSha256:input.artifactSha256});}
      catch{record(event,'error','automation_registration_failed',input.curationId);return;}
    }
    validationAttempts++;automaticValidationProposals.set(input.proposalId,{curationId:input.curationId,taskId:event.taskId,runId:event.runId,userMessageId:event.userMessageId,artifactSha256:input.artifactSha256,toolName:input.toolName});
    const requestId=validationRequestId(input.curationId,input.proposalId,input.artifactSha256),operation=(()=>{try{return Promise.resolve(toolMaintenance.enqueue(input.proposalId,requestId,{artifactSha256:input.artifactSha256}));}catch(error){return Promise.reject(error);}})();
    const tracked=operation.then(result=>{automationPhase(input.proposalId,'validating');record(event,'admitted',result?.deduplicated?'validation_deduplicated':'validation_queued',input.curationId);},error=>{automaticValidationProposals.delete(input.proposalId);automationPhase(input.proposalId,'failed',error?.statusCode===409?'validation_busy':'validation_enqueue_failed');record(event,'error',error?.statusCode===409?'validation_busy':'validation_error',input.curationId);});
    validationWork.add(tracked);tracked.finally(()=>validationWork.delete(tracked));
  }
  function queueApproval(input,event){
    if(!started||!enabled){record(event,'ignored',started?'approval_disabled':'stopped',input.curationId);return;}
    if(!automaticApproval){automationPhase(input.proposalId,'approving');record(event,'admitted','validation_passed_waiting_approval',input.curationId);return;}
    if(!toolApproval&&!approveTool){automationPhase(input.proposalId,'failed','approval_unconfigured');record(event,'ignored','approval_unconfigured',input.curationId);return;}
    if(automaticApprovalProposals.has(input.proposalId))return;
    if(approvalAttempts>=maxApprovals){automationPhase(input.proposalId,'failed','approval_budget_exhausted');record(event,'ignored','approval_budget_exhausted',input.curationId);return;}
    if(typeof input.proposalId!=='string'){
      automationPhase(input.proposalId,'failed','invalid_approval_binding');record(event,'ignored','invalid_approval_binding',input.curationId);return;
    }
    approvalAttempts++;automaticApprovalProposals.add(input.proposalId);automationPhase(input.proposalId,'approving');
    if(toolApproval){
      const requestId=approvalRequestId(input.proposalId);
      let operation;
      try{operation=Promise.resolve(toolApproval.enqueue(input.proposalId,requestId,{approvedBy:approvalActor}));}
      catch(error){operation=Promise.reject(error);}
      const tracked=operation.then(result=>{record(event,'admitted',result?.deduplicated?'approval_deduplicated':'approval_queued',input.curationId);},error=>{automaticApprovalProposals.delete(input.proposalId);automationPhase(input.proposalId,'failed',error?.statusCode===409?'approval_conflict':'approval_enqueue_failed');record(event,'error',error?.statusCode===409?'approval_conflict':'approval_enqueue_failed',input.curationId);});
      approvalWork.add(tracked);tracked.finally(()=>approvalWork.delete(tracked));
      return;
    }
    let operation;
    try{operation=Promise.resolve(approveTool(input.proposalId,approvalActor));}
    catch(error){operation=Promise.reject(error);}
    const tracked=operation.then(result=>{
      if(!result||result.approved!==true||result.activated!==true)throw Error('Approval did not produce an active version');
      automaticApprovalProposals.delete(input.proposalId);automationPhase(input.proposalId,'completed');record(event,'admitted','approval_completed',input.curationId);
    }).catch(error=>{
      automaticApprovalProposals.delete(input.proposalId);
      if(error?.approved===true&&(error?.activated===true||error?.versionActivated===true)){
        automationPhase(input.proposalId,'completed','approval_committed_projection_error');record(event,'admitted','approval_committed',input.curationId);
      }else{
        automationPhase(input.proposalId,'failed','approval_failed');record(event,'error','approval_failed',input.curationId);
      }
    });
    approvalWork.add(tracked);tracked.finally(()=>approvalWork.delete(tracked));
  }
  function observeApproval(input){
    try{assertCurationJson(input,{maxDepth:2,maxBytes:4096});}catch{return;}
    if(!toolApproval||!input||input.protocolVersion!=='sirna-tool-approval/v1'||typeof input.proposalId!=='string'||typeof input.jobId!=='string'||!['succeeded','failed'].includes(input.status))return;
    let run;try{run=toolAutomation?.get(input.proposalId);}catch{return;}
    if(!run||run.phase!=='approving')return;
    let durable;try{durable=toolApproval.latest(input.proposalId);}catch{return;}
    if(!durable||durable.id!==input.jobId||!['succeeded','failed'].includes(durable.status)||durable.status!==input.status)return;
    const event=automationEvent(run);
    automaticApprovalProposals.delete(input.proposalId);
    if(durable.status==='succeeded'&&durable.approved===true&&durable.activated===true){automationPhase(input.proposalId,'completed');record(event,'admitted','approval_completed',run.curationId);}
    else{automationPhase(input.proposalId,'failed','approval_failed');record(event,'error','approval_failed',run.curationId);}
  }
  function observeBuilder(input){
    try{assertCurationJson(input,{maxDepth:4,maxBytes:8192});}catch{return;}
    if(!input||typeof input.curationId!=='string'||input.requestId!==buildRequestId(input.curationId)||!automaticBuilds.has(input.curationId)||validationTickets.has(input.curationId))return;
    validationTickets.add(input.curationId);
    const event={taskId:input.taskId??'unknown',runId:input.runId??'unknown',userMessageId:input.userMessageId??'unknown'};
    if(!started||!enabled){record(event,'ignored',started?'disabled':'stopped',input.curationId);return;}
    if(input.phase!=='submitted'){
      record(event,'ignored','validation_suppressed',input.curationId);return;
    }
    queueValidation({...input},event);
  }
  function observeMaintenance(input){
    try{assertCurationJson(input,{maxDepth:3,maxBytes:4096});}catch{return;}
    if(!input||typeof input.proposalId!=='string')return;
    let saved;try{saved=toolAutomation?.get(input.proposalId);}catch{return;}
    if(saved&&saved.phase!=='validating')return;
    const source=automaticValidationProposals.get(input.proposalId)??(saved?{curationId:saved.curationId,taskId:saved.sourceTaskId,runId:saved.sourceRunId??'unknown',userMessageId:saved.sourceUserMessageId??'unknown',artifactSha256:saved.artifactSha256,toolName:saved.toolName}:null);
    if(!source||automaticRepairTickets.has(input.proposalId))return;
    const event={taskId:source.taskId,runId:source.runId,userMessageId:source.userMessageId};
    if(input.status==='failed'){automationPhase(input.proposalId,'failed','validation_execution_failed');record(event,'ignored','repair_suppressed',source.curationId);return;}
    if(input.status!=='succeeded')return;
    if(input.passed===true){queueApproval({proposalId:input.proposalId,curationId:source.curationId},event);return;}
    if(input.passed!==false)return;
    automaticRepairTickets.add(input.proposalId);
    if(!started||!enabled){record(event,'ignored',started?'repair_disabled':'stopped',source.curationId);return;}
    if(!automaticRepair){automationPhase(input.proposalId,'failed','automatic_repair_disabled');record(event,'ignored','repair_disabled',source.curationId);return;}
    if(!toolRepair){automationPhase(input.proposalId,'failed','repair_unconfigured');record(event,'ignored','repair_unconfigured',source.curationId);return;}
    if(repairAttempts>=maxRepairs){automationPhase(input.proposalId,'failed','repair_budget_exhausted');record(event,'ignored','repair_budget_exhausted',source.curationId);return;}
    if(input.artifactSha256!==source.artifactSha256||typeof input.validationId!=='string'||typeof input.reportSha256!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.validationId)||!/^[a-f0-9]{64}$/.test(input.reportSha256)){
      automationPhase(input.proposalId,'failed','repair_feedback_unavailable');record(event,'ignored','repair_feedback_unavailable',source.curationId);return;
    }
    repairAttempts++;
    automationPhase(input.proposalId,'repairing');
    let operation;
    try{operation=Promise.resolve(toolRepair.start(input.proposalId,{validationId:input.validationId,reportSha256:input.reportSha256}));}
    catch(error){automationPhase(input.proposalId,'failed',error?.statusCode===409?'repair_busy':'repair_error');record(event,'error',error?.statusCode===409?'repair_busy':'repair_error',source.curationId);return;}
    const tracked=operation.then(result=>record(event,'admitted',result?.deduplicated?'repair_deduplicated':'repair_queued',source.curationId),error=>{automationPhase(input.proposalId,'failed',error?.statusCode===409?'repair_busy':'repair_error');record(event,'error',error?.statusCode===409?'repair_busy':'repair_error',source.curationId);});
    repairWork.add(tracked);tracked.finally(()=>repairWork.delete(tracked));
  }
  function observeRepair(input){
    try{assertCurationJson(input,{maxDepth:3,maxBytes:4096});}catch{return;}
    if(!toolAutomation||!input||typeof input.proposalId!=='string')return;
    let run;try{run=toolAutomation.get(input.proposalId);}catch{return;}if(!run)return;
    const event=automationEvent(run);
    if(input.phase==='awaiting_replacement'){automationPhase(input.proposalId,'awaiting_replacement');record(event,'admitted','awaiting_replacement',run.curationId);return;}
    if(input.phase!=='superseded'||typeof input.replacementProposalId!=='string')return;
    if(input.rootProposalId!==run.rootProposalId||input.attempt!==run.attempt||typeof input.replacementArtifactSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.replacementArtifactSha256))return;
    const replacement={proposalId:input.replacementProposalId,sourceTaskId:run.sourceTaskId,sourceRunId:run.sourceRunId,sourceUserMessageId:run.sourceUserMessageId,curationId:run.curationId,toolName:typeof input.replacementToolName==='string'?input.replacementToolName:run.toolName,artifactSha256:input.replacementArtifactSha256};
    try{const next=toolAutomation.registerProposal(replacement);queueValidation({...replacement,...next},automationEvent(next));record(event,'admitted','replacement_queued',next.curationId);}catch{record(event,'error','replacement_registration_failed',run.curationId);}
  }
  async function reconcileAutomation(){
    if(!toolAutomation||!automaticValidation||!started||!enabled)return;
    for(const run of toolAutomation.listOpen()){
      if(!started||!enabled)break;
      if(automationWork.has(run.proposalId))continue;
      const task=Promise.resolve().then(async()=>{
        const event=automationEvent(run);
        if(run.phase==='queued'){queueValidation({proposalId:run.proposalId,curationId:run.curationId,toolName:run.toolName,artifactSha256:run.artifactSha256},event);return;}
        if(run.phase==='validating'){
          const job=toolMaintenance?.latest?.(run.proposalId);if(!job||['pending','running'].includes(job.status))return;
          if(job.status==='failed'||job.status==='interrupted'){automationPhase(run.proposalId,'failed','validation_execution_failed');return;}
          if(job.status==='succeeded'&&job.passed===true){queueApproval({proposalId:run.proposalId,curationId:run.curationId},event);return;}
          if(job.status==='succeeded'&&job.passed===false){let feedback=null;try{feedback=toolMaintenance.feedback(run.proposalId);}catch{}if(feedback)observeMaintenance({proposalId:run.proposalId,status:'succeeded',passed:false,validationId:feedback.validationId,reportSha256:feedback.reportSha256,artifactSha256:run.artifactSha256});else automationPhase(run.proposalId,'failed','repair_feedback_unavailable');}
          return;
        }
        if(run.phase==='approving'){
          if(toolApproval){const job=toolApproval.latest(run.proposalId);if(job&&['succeeded','failed'].includes(job.status))observeApproval({protocolVersion:'sirna-tool-approval/v1',jobId:job.id,proposalId:run.proposalId,status:job.status,approved:job.approved===true,activated:job.activated===true});}
          else queueApproval({proposalId:run.proposalId,curationId:run.curationId},event);
          return;
        }
        if((run.phase==='repairing'||run.phase==='awaiting_replacement')&&toolRepair){let status;try{status=toolRepair.status(run.proposalId);}catch{return;}const repair=status?.repair;if(!repair)return;if(repair.replacementProposalId&&root){try{const next=getToolProposalSource(repair.replacementProposalId,{root});observeRepair({protocolVersion:'sirna-tool-repair/v1',proposalId:run.proposalId,rootProposalId:run.rootProposalId,attempt:run.attempt,phase:'superseded',replacementProposalId:repair.replacementProposalId,replacementArtifactSha256:next.registry.artifactSha256,replacementToolName:next.input.toolName});}catch{/* A malformed successor remains outside automation. */}return;}if(repair.phase==='awaiting_replacement')automationPhase(run.proposalId,'awaiting_replacement');else if(repair.phase==='failed'||repair.phase==='interrupted')automationPhase(run.proposalId,'failed',repair.phase);}
      });
      automationWork.add(task);task.finally(()=>automationWork.delete(task));await task;
    }
  }
  function runOnce(){
    if(worker)return worker;
    if(!started||!enabled)return Promise.resolve();
    worker=Promise.resolve().then(async()=>{await consume();await reconcileAutomation();}).finally(()=>{worker=undefined;});
    return worker;
  }
  function status(){return structuredClone({protocolVersion:'sirna-tool-curation-automation/v1',started,enabled,maxReviews,attempts,remaining:maxReviews-attempts,maxBuilds,buildAttempts,buildRemaining:maxBuilds-buildAttempts,automaticValidation,maxValidations,validationAttempts,validationRemaining:maxValidations-validationAttempts,automaticRepair,maxRepairs,repairAttempts,repairRemaining:maxRepairs-repairAttempts,automaticApproval,maxApprovals,approvalAttempts,approvalRemaining:maxApprovals-approvalAttempts,pending:pending.size,reason,recent});}
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
      if(validationWork.size)await Promise.allSettled([...validationWork]);
      if(repairWork.size)await Promise.allSettled([...repairWork]);
      if(approvalWork.size)await Promise.allSettled([...approvalWork]);
      if(automationWork.size)await Promise.allSettled([...automationWork]);
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
    observeBuilder,
    observeMaintenance,
    observeRepair,
    observeApproval,
    runOnce,
  };
}
