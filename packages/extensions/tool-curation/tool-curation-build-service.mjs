import fs from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {ToolRegistry} from '../../capability-platform/tool-registry.mjs';
import {resolveToolLearningPaths} from '../../capability-platform/tool-lifecycle.mjs';
import {getToolProposalSource} from '../../capability-platform/tool-proposal-source.mjs';
import {repairSource} from '../../capability-platform/tool-repair-contract.mjs';
import {assertCurationBuildInput,buildBinding,buildId,buildRequestId,curationBuildPrompt} from './tool-curation-build-contract.mjs';

const reasons={invalid_id:400,invalid_request:400,not_found:404,unavailable:503,stopped:503,not_candidate:409,invalid_evidence:409,permissions_unsupported:409,existing_tool:409,task_unavailable:409,busy:409,binding_conflict:409,already_requested:409,registration_refused:409,context_too_large:413};
export class ToolCurationBuildError extends Error {constructor(code){super('Tool curation handoff request could not be completed.');this.code=Object.hasOwn(reasons,code)?code:'unavailable';this.statusCode=reasons[this.code];}}
const fail=code=>{throw new ToolCurationBuildError(code);};
const safeError=e=>e instanceof ToolCurationBuildError?e:new ToolCurationBuildError('unavailable');
const ids=(taskId,id)=>{if(!buildId(taskId)||!buildId(id))fail('invalid_id');};
const normalize=name=>name.replace(/^sirna_tools_/,'');

export function createToolCurationBuildService({root,store,curationStore,taskStore,taskMessages,agentRuntime,listExistingTools}){
  let accepting=true;
  const pending=new Map(),turns=new Set(),uncertain=new Set();
  function candidate(taskId,id){
    const run=curationStore.get(taskId,id);if(!run)fail('not_found');if(run.status!=='candidate')fail('not_candidate');
    let frozen;try{frozen=curationBuildPrompt(run);}catch(e){fail(e instanceof RangeError?'context_too_large':'invalid_evidence');}
    if(run.result.candidate.permissions.profile!=='no_external_access')fail('permissions_unsupported');
    return {run,...frozen};
  }
  function catalog(toolName){
    if(typeof listExistingTools!=='function')fail('unavailable');
    const names=listExistingTools();if(!Array.isArray(names)||names.some(n=>typeof n!=='string'))fail('unavailable');
    if(names.some(n=>normalize(n)===normalize(toolName)))fail('existing_tool');
  }
  function eligible(taskId,id,{own=false}={}){
    if(!accepting)fail('stopped');const frozen=candidate(taskId,id),task=taskStore.getTask(taskId);
    if(!task||!['idle','failed'].includes(task.status))fail(task?.status==='running'?'busy':'task_unavailable');
    if(!own&&[...pending.values()].some(p=>p.taskId===taskId)||store.activeForTask(taskId).length)fail('busy');
    if(typeof agentRuntime?.describe!=='function'||typeof agentRuntime?.assertWorkspaceIdle!=='function')fail('task_unavailable');
    catalog(frozen.run.result.candidate.suggestedToolName);return {task,...frozen};
  }
  function registered(ticket){
    const {databasePath}=resolveToolLearningPaths(root);if(!fs.existsSync(databasePath))return null;
    const registry=new ToolRegistry(databasePath,{readOnly:true});let receipt;
    try{receipt=registry.getCurationProposal(ticket.requestId);}finally{registry.close();}
    if(!receipt)return null;
    const source=getToolProposalSource(receipt.proposalId,{root});
    const user=taskStore.getMessageByClientRequestId(ticket.taskId,ticket.requestId);
    if(!isDeepStrictEqual(source.curation,{requestId:ticket.requestId,curationId:ticket.curationId,...ticket.binding})||!isDeepStrictEqual(source.source,ticket.registrationSource)||!user||user.id!==ticket.userMessageId||user.content!==ticket.prompt||!taskStore.listRunEvents(ticket.taskId).some(e=>e.userMessageId===user.id&&e.runId===source.source.agentRunId))fail('invalid_evidence');
    return receipt.proposalId;
  }
  function handoff(ticket){
    if(!ticket)return null;const proposalId=registered(ticket);
    return {curationId:ticket.curationId,taskId:ticket.taskId,sourceTaskId:ticket.taskId,requestId:ticket.requestId,phase:ticket.phase,proposalId,userMessageId:ticket.userMessageId,runId:ticket.runId,createdAt:ticket.createdAt,updatedAt:ticket.updatedAt};
  }
  function runtimeDescription(description){if(description?.backend!=='agent-compose'||description.supportsLifecycle!==true||description.builderToolsAvailable!==true||description.runtimeReleased||description.stopUnconfirmed||typeof description.sandboxId!=='string'||!description.sandboxId)fail('task_unavailable');return description;}
  async function describe(task){try{return runtimeDescription(await agentRuntime.describe(task.executionSessionId));}catch{fail('task_unavailable');}}
  async function view(taskId,id){
    try{
      ids(taskId,id);
      function history(){const ticket=store.get(id);if(ticket&&ticket.taskId!==taskId)fail('not_found');return ticket?{eligible:false,reason:'already_requested',binding:ticket.binding,prompt:ticket.prompt,handoff:handoff(ticket)}:null;}
      // Persisted history is readable even when task/runtime is stopped.
      const saved=history();if(saved)return saved;
      let frozen;try{frozen=eligible(taskId,id);const session=frozen.task.executionSessionId;await describe(frozen.task);const accepted=history();if(accepted)return accepted;frozen=eligible(taskId,id);if(frozen.task.executionSessionId!==session)fail('task_unavailable');return {eligible:true,reason:null,binding:frozen.binding,prompt:frozen.prompt,handoff:null};}
      catch(e){const accepted=history();if(accepted)return accepted;if(e instanceof ToolCurationBuildError&&['not_found','invalid_id','unavailable'].includes(e.code))throw e;return {eligible:false,reason:e instanceof ToolCurationBuildError?e.code:'invalid_evidence',handoff:null};}
    }catch(e){throw safeError(e);}
  }
  function finish(id,result){
    const ticket=store.get(id),user=taskStore.getMessageByClientRequestId(ticket.taskId,ticket.requestId),messages=taskStore.listMessages(ticket.taskId);
    const events=taskStore.listRunEvents(ticket.taskId).filter(e=>e.userMessageId===user?.id&&e.runId===result?.finalRunId);
    const assistant=messages.find(m=>m.id===result?.assistantMessage?.id&&m.role==='assistant'&&m.sequence===user?.sequence+1);
    const done=events.filter(e=>e.type==='done').at(-1),proposalId=registered(ticket);
    const completionKnown=user?.content===ticket.prompt&&assistant&&done;
    const confirmed=!ticket.submissionUncertain&&!uncertain.has(id)&&completionKnown&&assistant.status==='complete'&&result?.task?.status==='idle'&&done.payload.status==='succeeded'&&!events.some(e=>e.type==='error');
    // currentRunId can still describe an earlier run; only this result and its
    // durable message/event association establish the actual dispatch identity.
    store.update(id,confirmed?(proposalId?'submitted':'no_proposal'):(proposalId||!completionKnown||ticket.submissionUncertain||uncertain.has(id)?'outcome_unknown':'failed'),{...(user?{userMessageId:user.id}:{}),...(events.length?{runId:result.finalRunId}:{}),submissionUncertain:uncertain.has(id)});
  }
  function track(id,completion){
    const tracked=Promise.resolve(completion).then(result=>finish(id,result)).catch(()=>{try{store.update(id,'outcome_unknown');}catch{/* Ticket remains reserved; never replay. */}});
    turns.add(tracked);tracked.then(()=>turns.delete(tracked));
  }
  async function dispatch(taskId,id,binding){
    let frozen=eligible(taskId,id,{own:true});if(!isDeepStrictEqual(frozen.binding,binding))fail('binding_conflict');
    let description;try{description=await describe(frozen.task);await agentRuntime.assertWorkspaceIdle(frozen.task.executionSessionId);}catch{fail('task_unavailable');}
    const executionSessionId=frozen.task.executionSessionId;
    frozen=eligible(taskId,id,{own:true});if(frozen.task.executionSessionId!==executionSessionId)fail('task_unavailable');if(!isDeepStrictEqual(frozen.binding,binding))fail('binding_conflict');
    const ticket=store.create({curationId:id,taskId,executionSessionId,sandboxId:description.sandboxId,requestId:buildRequestId(id),toolName:frozen.run.result.candidate.suggestedToolName,binding,prompt:frozen.prompt});
    let turn;try{turn=await taskMessages.start({taskId,requestId:ticket.requestId,message:ticket.prompt},()=>{});}catch{try{store.update(id,'outcome_unknown');}catch{}return {handoff:handoff(store.get(id)??ticket),deduplicated:false};}
    // Establish draining before any identity/status write can throw.
    track(id,turn.completion);
    try{store.update(id,'running',{...(turn.userMessage?.id?{userMessageId:turn.userMessage.id}:{})});}catch{}
    return {handoff:handoff(store.get(id)??ticket),deduplicated:false};
  }
  function start(taskId,id,value){
    try{
      ids(taskId,id);let binding;try{binding=buildBinding(value);}catch{fail('invalid_request');}
      const old=store.get(id);if(old){if(old.taskId!==taskId)fail('not_found');if(!isDeepStrictEqual(old.binding,binding))fail('binding_conflict');return Promise.resolve({handoff:handoff(old),deduplicated:true});}
      const prior=pending.get(id);if(prior){if(prior.taskId!==taskId||!isDeepStrictEqual(prior.binding,binding))fail('binding_conflict');return prior.promise.then(r=>({...r,deduplicated:true}));}
      if(!accepting)fail('stopped');if([...pending.values()].some(p=>p.taskId===taskId))fail('busy');
      const promise=Promise.resolve().then(()=>dispatch(taskId,id,binding)).catch(e=>{throw safeError(e);});pending.set(id,{taskId,binding,promise});promise.then(()=>pending.delete(id),()=>pending.delete(id));return promise;
    }catch(e){return Promise.reject(safeError(e));}
  }
  function registration(input,context){
    try{
      const ctx=repairSource(context),task=taskStore.getTask(ctx.taskId),latest=taskStore.listMessages(ctx.taskId).findLast(m=>m.role==='user');
      if(!latest||!task||task.status!=='running'||task.executionSessionId!==ctx.executionSessionId||task.currentRunId!==ctx.agentRunId)fail('registration_refused');
      const ticket=latest.clientRequestId?store.byRequest(latest.clientRequestId):null;
      if(!ticket){if(store.activeForTask(ctx.taskId).length||latest.clientRequestId?.startsWith('auto-tool-curation-build:'))fail('registration_refused');return undefined;}
      const events=taskStore.listRunEvents(ctx.taskId).filter(e=>e.userMessageId===latest.id&&e.runId===ctx.agentRunId);
      if(!events.length||events.some(e=>['done','error'].includes(e.type)))fail('registration_refused');
      if(uncertain.has(ticket.curationId)||ticket.submissionUncertain||!['dispatching','running'].includes(ticket.phase)||ticket.taskId!==ctx.taskId||ticket.executionSessionId!==ctx.executionSessionId||ticket.sandboxId!==ctx.sandboxId||latest.content!==ticket.prompt||ticket.userMessageId&&latest.id!==ticket.userMessageId||registered(ticket))fail('registration_refused');
      const frozen=candidate(ctx.taskId,ticket.curationId);if(!isDeepStrictEqual(frozen.binding,ticket.binding)||frozen.prompt!==ticket.prompt||ticket.registrationSource&&!isDeepStrictEqual(ticket.registrationSource,ctx))fail('registration_refused');catalog(ticket.toolName);assertCurationBuildInput(input,ticket.toolName);
      // The lease's exact activated identity is latched before registration.
      // This is not a proposal receipt; the registry transaction creates it.
      store.update(ticket.curationId,ticket.phase,{userMessageId:latest.id,runId:ctx.agentRunId,registrationSource:ctx});
      return {requestId:ticket.requestId,curationId:ticket.curationId,...ticket.binding};
    }catch{fail('registration_refused');}
  }
  registration.onSubmissionFailure=(association,context)=>{
    const ticket=store.byRequest(association?.requestId);
    if(!ticket||!isDeepStrictEqual(ticket.registrationSource,repairSource(context)))fail('registration_refused');
    uncertain.add(ticket.curationId);store.update(ticket.curationId,'outcome_unknown',{submissionUncertain:true});
  };
  async function drain(){while(pending.size||turns.size)await Promise.allSettled([...pending.values()].map(p=>p.promise).concat([...turns]));}
  return {view,start,registration,active:taskId=>[...pending.values()].some(p=>p.taskId===taskId)||store.activeForTask(taskId).length>0,recover(){try{return store.recover();}catch(e){throw safeError(e);}},stop(){accepting=false;return drain();}};
}
