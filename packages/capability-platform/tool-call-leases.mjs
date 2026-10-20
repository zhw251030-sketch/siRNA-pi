// Each capability belongs to one server-selected task turn; never persisted.
import {randomBytes} from 'node:crypto';
import {validateToolTaskContext} from './tool-run-audit.mjs';

function failure(status,message){return Object.assign(new Error(message),{status});}
export function createToolCallLeases(){
  const entries=new Map();
  return {
    begin({taskId,executionSessionId,sandboxId,agentTurnId,signal,onCall}={}){
      const identity=validateToolTaskContext({taskId,executionSessionId,sandboxId,agentTurnId,agentRunId:'pending'});
      if(signal!==undefined&&!(signal instanceof AbortSignal))throw new TypeError('Expected task AbortSignal');
      if(onCall!==undefined&&typeof onCall!=='function')throw new TypeError('Expected onCall callback');
      const token=randomBytes(32).toString('hex');const controller=new AbortController();
      const entry={identity,revoked:false,taskContext:undefined,controller,onCall,inflight:new Set(),resources:new Map()};entries.set(token,entry);
      function revoke(){entry.revoked=true;entries.delete(token);}
      function abort(){revoke();controller.abort();}
      if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
      let closing;
      return {
        context:Object.freeze({protocolVersion:'sirna-task-context/v1',taskId,agentTurnId,token}),
        activate(agentRunId){
          if(entry.revoked)throw failure(401,'Task capability revoked');
          const context=validateToolTaskContext({...identity,agentRunId});
          if(entry.taskContext&&entry.taskContext.agentRunId!==agentRunId)throw failure(409,'Task capability already activated');
          entry.taskContext=context;
        },
        close(){
          // Revoke before returning any promise: a racing request must fail.
          revoke();
          if(!closing)closing=(async()=>{try{
            await Promise.allSettled([...entry.inflight]);
            const closed=await Promise.allSettled([...entry.resources.values()].map(resource=>Promise.resolve().then(()=>resource.close())));
            if(closed.some(result=>result.status==='rejected'))throw new Error('Task resource cleanup unknown');
          }finally{signal?.removeEventListener('abort',abort);}})();
          return closing;
        },
      };
    },
    authorize({token,taskId,agentTurnId,call=false}={}){
      const entry=typeof token==='string'&&entries.get(token);
      function check(){
        if(!entry||entry.revoked||entry.identity.taskId!==taskId||entry.identity.agentTurnId!==agentTurnId)throw failure(401,'Task capability unavailable');
        if(call&&!entry.taskContext)throw failure(409,'Task run is not activated');
      }
      check();
      return {taskContext:entry.taskContext,signal:entry.controller.signal,
        ownResource(key,create){
          check();if(!entry.taskContext)throw failure(409,'Task run is not activated');
          if(entry.resources.has(key))return entry.resources.get(key);
          // Synchronous construction/registration prevents revocation racing ownership.
          const resource=create();if(!resource||typeof resource.close!=='function'||typeof resource.then==='function')throw new TypeError('Expected synchronous owned resource');
          entry.resources.set(key,resource);return resource;
        },
        run(operation){
          check();
          const pending=Promise.resolve().then(operation);entry.inflight.add(pending);
          pending.then(()=>entry.inflight.delete(pending),()=>entry.inflight.delete(pending));return pending;
        },
        async emit(event){
          if(entry.onCall)try{await entry.onCall(Object.freeze({...event}));}catch{/* A UI observer cannot rewrite durable tool outcome. */}
        },
      };
    },
  };
}
