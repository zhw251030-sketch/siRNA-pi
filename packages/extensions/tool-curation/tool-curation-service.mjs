import {randomUUID} from 'node:crypto';
import {assertCurationJson,buildToolCurationTrace} from './tool-curation-evidence.mjs';
import {validateToolCurationResult} from './tool-curation-result.mjs';

export class ToolCurationError extends Error {constructor(statusCode,message){super(message);this.statusCode=statusCode;}}
const fail=(status,message)=>{throw new ToolCurationError(status,message);};
const digest=/^[a-f0-9]{64}$/;
const runIdentity=/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$/i;

export function createToolCurationService({store,preview,curator}){
  let accepting=false,initialized=false,worker=null,storageFault=false;
  const queue=[];
  function storage(action){
    try{return action();}catch{
      storageFault=true;accepting=false;queue.length=0;
      try{store.haltAdmission();}catch{/* Preserve in-memory halt if SQLite is unavailable. */}
      fail(503,'Independent curator persistence is unavailable; operator inspection is required.');
    }
  }
  async function consume(){
    while(queue.length){
      const id=queue.shift();
      if(store.isAdmissionHalted()){store.fail(id,{message:'Not dispatched because a prior curator outcome requires operator recovery.'});continue;}
      let run;
      try{
        run=store.markRunning(id);
        const response=await curator.curate(structuredClone(run),new AbortController().signal,(sessionId,runId)=>store.setIdentity(id,sessionId,runId));
        // Latch uncertainty before touching identities, but retain any newly
        // reported valid identity first. A conflicting/malformed identity must
        // never mask the uncertainty or overwrite the onStarted identity.
        const uncertain=response?.cleanupFailed===true||response?.outcomeUnknown===true||response?.cleanupConfirmed===false;
        const uncertainty={cleanupFailed:response?.cleanupFailed,outcomeUnknown:response?.outcomeUnknown,cleanupConfirmed:response?.cleanupConfirmed};
        let identityError;
        try{
          if(!response||typeof response.sessionId!=='string'||typeof response.runId!=='string'||!response.runId)throw Error('Curator success omitted execution identity');
          store.setIdentity(id,response.sessionId,response.runId);
        }catch(error){identityError=error;}
        if(uncertain)throw Object.assign(identityError??Error('Curator execution was not confirmed'),uncertainty);
        if(identityError)throw identityError;
        const result=validateToolCurationResult(run,response.result);
        store.complete(id,result);
      }catch(error){
        store.fail(id,{halt:error?.cleanupFailed===true||error?.outcomeUnknown===true||error?.cleanupConfirmed===false,message:error?.cleanupFailed===true||error?.cleanupConfirmed===false?'Curator cleanup could not be confirmed. Operator recovery required; no retry was attempted.':error?.outcomeUnknown===true?'Curator execution outcome unconfirmed. Operator recovery required; no retry was attempted.':'Independent curator did not complete a valid review; no retry was attempted.'});
      }
    }
  }
  function schedule(){
    if(!worker)worker=Promise.resolve().then(consume).catch(()=>{
      // A failed durable update makes the dispatch boundary uncertain. Keep
      // accepted records for startup recovery, halt this instance immediately,
      // and never turn a detached worker rejection into an automatic retry.
      storageFault=true;accepting=false;queue.length=0;
      try{store.haltAdmission();}catch{/* Startup recovery will see in-flight rows. */}
    }).finally(()=>{worker=null;if(queue.length&&!storageFault)schedule();});
  }
  return {
    start(){if(!initialized){storage(()=>store.recoverInterrupted());initialized=true;}accepting=true;},
    async stop(){accepting=false;while(worker)await worker;if(storageFault)fail(503,'Independent curator persistence failed; shutdown requires operator inspection.');},
    async request(taskId,binding){
      if(!accepting||storageFault||!curator||typeof curator.curate!=='function'||storage(()=>store.isAdmissionHalted()))fail(503,'Independent curator is unavailable; operator recovery may be required.');
      try{assertCurationJson(binding,{maxDepth:2,maxBytes:1024});}catch{fail(400,'Invalid curation request.');}
      if(!binding||Object.keys(binding).some(k=>!['runId','sourceSha256','previewSha256'].includes(k))||!runIdentity.test(binding.runId)||!digest.test(binding.sourceSha256)||!digest.test(binding.previewSha256))fail(400,'Invalid curation request binding.');
      const old=storage(()=>store.find(taskId,binding.runId));
      if(old){if(old.sourceSha256!==binding.sourceSha256||old.previewSha256!==binding.previewSha256)fail(409,'This run is already bound to another frozen preview.');return {curation:old,deduplicated:true};}
      if(queue.length+(worker?1:0)>=32)fail(503,'Independent curator admission queue is full.');
      let snapshot;
      try{snapshot=preview.snapshot(taskId,binding.runId);}catch(error){if(Number.isInteger(error.statusCode))fail(error.statusCode,error.message);fail(503,'Saved preview evidence is unavailable.');}
      if(!snapshot.preview)fail(404,'No saved run was found.');
      if(snapshot.preview.sourceSha256!==binding.sourceSha256||snapshot.preview.previewSha256!==binding.previewSha256)fail(409,'Preview changed; refresh before requesting review.');
      if(!snapshot.preview.eligibleForReview||!snapshot.preview.signals.some(s=>s.evidenceComplete))fail(409,'No complete eligible triggering evidence is available.');
      let trace;
      try{trace=buildToolCurationTrace({id:randomUUID(),snapshot});}catch(error){fail(error instanceof RangeError?413:409,'Frozen evidence cannot be represented completely within the review envelope.');}
      const result=storage(()=>store.create(trace));
      if(!result.deduplicated){queue.push(result.curation.id);schedule();}
      return result;
    },
    list(taskId){return storage(()=>store.list(taskId));},
    get(taskId,id){const row=storage(()=>store.get(taskId,id));if(!row)fail(404,'Independent review was not found.');return row;},
  };
}
