import {validateToolTaskContext} from '../../capability-platform/tool-run-audit.mjs';
import {ToolGapError,gapFail,validateGapInput,validateGapReports} from './tool-gap-contract.mjs';
export {ToolGapError} from './tool-gap-contract.mjs';
export function createToolGapService({store,taskStore,curationStore}){
  function storage(action){try{return action();}catch(e){if(e instanceof ToolGapError)throw e;gapFail(503);}}
  function evidence(taskId,runId){
    const task=storage(()=>taskStore.getTask(taskId));if(!task)gapFail(404);
    const source=storage(()=>taskStore.readRunEvidence(taskId,runId));if(!source)gapFail(404);if(source.tooLarge)gapFail(413);
    if(source.inconsistent||source.userMessage?.role!=='user'||source.events.some(e=>e.taskId!==taskId||e.runId!==runId||e.userMessageId!==source.userMessage.id))gapFail(409);
    return {task,...source};
  }
  return {
    report(input,taskContext){
      const business=validateGapInput(input);let context;try{context=validateToolTaskContext(taskContext);}catch{gapFail(409);}if(!context)gapFail(409);
      const {task,userMessage,events}=evidence(context.taskId,context.agentRunId);
      const latest=storage(()=>taskStore.listMessages(task.id)).filter(m=>m.role==='user').at(-1);
      if(task.status!=='running'||task.currentRunId!==context.agentRunId||task.executionSessionId!==context.executionSessionId||latest?.id!==userMessage.id||events.some(e=>['done','error'].includes(e.type))||storage(()=>curationStore.find(task.id,context.agentRunId)))gapFail(409);
      const ids=new Set(events.map(e=>e.id));if(business.evidenceEventIds.some(id=>!ids.has(id)))gapFail(409);
      const result=storage(()=>store.create({...business,taskId:task.id,runId:context.agentRunId,userMessageId:userMessage.id,source:context}));
      return {...result,candidateCreated:false,toolCreated:false,nextGate:'finish_current_turn_then_manual_curator_review'};
    },
    list(taskId,runId){const {userMessage,events}=evidence(taskId,runId);return validateGapReports(storage(()=>store.list(taskId,runId)),{taskId,runId,userMessageId:userMessage.id,events});},
  };
}
