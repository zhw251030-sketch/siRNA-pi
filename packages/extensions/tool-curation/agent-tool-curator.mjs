import {toolCurationPrompt,parseToolCurationResult} from './tool-curation-result.mjs';

const safeFailure='Independent Curator did not complete a confirmed review.';
export function createAgentToolCurator({runtime,timeoutMs=180000}) {
  if (runtime?.agentName !== 'tool-curator' || !Number.isInteger(timeoutMs) || timeoutMs<=0 || timeoutMs>180000) throw new Error('Invalid dedicated Curator runtime or timeout');
  return {async curate(review,externalSignal,onStarted=()=>{}) {
    let sessionId,runId,answer,done,failed=false,cleanupFailed=false,outcomeUnknown=false,confirmed=false,attempted=false,result,error;
    const controller=new AbortController();
    const signal=externalSignal?AbortSignal.any([controller.signal,externalSignal]):controller.signal;
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const session=await runtime.create();sessionId=session.id;
      onStarted(sessionId); // Durable identity precedes any model submission.
      if(signal.aborted)throw Error(safeFailure);
      attempted=true;
      let runtimeError=false;
      try {await runtime.run({sessionId,message:toolCurationPrompt(review)},event=>{
        if((event.type==='session'||event.type==='run_status'&&event.status==='running') && event.runId && event.runId!==runId) {
          if(runId){failed=true;controller.abort();return;}
          runId=event.runId;onStarted(sessionId,runId);
        }
        if(event.type==='tool_start'||event.type==='error') {failed=true;controller.abort();}
        if(event.type==='assistant_message') {
          if(answer!==undefined || typeof event.text!=='string' || Buffer.byteLength(event.text)>49152){failed=true;controller.abort();}
          else answer=event.text;
        }
        if(event.type==='done') {
          if(done!==undefined || event.status!=='succeeded'){failed=true;controller.abort();}
          done=event.status;
        }
      },signal);}catch{runtimeError=true;}
      const saved=await runtime.status(sessionId);
      const accepted=saved.runs.findLast(item=>item.accepted);
      if(!runId && accepted) {runId=accepted.runId;onStarted(sessionId,runId);}
      const run=saved.runs.find(item=>item.runId===runId);
      outcomeUnknown=runtimeError||failed||signal.aborted||done!=='succeeded'||!run?.accepted||run?.status!=='succeeded'||Boolean(run?.outcomeUnconfirmed||run?.stopUnconfirmed);
      if(outcomeUnknown)throw Error(safeFailure);
      // A confirmed successful but unsuitable response is an ordinary rejection,
      // not an unknown infrastructure outcome.
      confirmed=true;
      if(run.modelResponses!==1||run.toolCalls!==0||answer===undefined)throw Error(safeFailure);
      result=parseToolCurationResult(review,answer);
    } catch (cause) {
      error=Error(safeFailure);
      if(!confirmed && attempted)outcomeUnknown=true;
    } finally {
      clearTimeout(timer);
      if(sessionId) {
        try {
          const released=await runtime.remove(sessionId);
          if(released?.runtimeReleased!==true||released?.status!=='stopped')throw Error(safeFailure);
        } catch {cleanupFailed=true;error??=Error(safeFailure);}
      }
    }
    if(error)throw Object.assign(error,{sessionId,runId,...(outcomeUnknown?{outcomeUnknown:true}:{}),...(cleanupFailed?{cleanupFailed:true,cleanupConfirmed:false}:{})});
    return {result,sessionId,runId,cleanupConfirmed:true};
  }};
}
