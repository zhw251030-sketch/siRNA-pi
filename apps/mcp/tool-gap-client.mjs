import {readContext} from './remote-client.mjs';
import {validateToolGapResponse} from '../../packages/domain/sirna-tools/tool-gap-tools.mjs';
const unavailable=()=>new Error('Tool gap report unavailable; inspect saved reports before explicitly retrying.');
export function createToolGapClient({baseUrl,contextPath='/workspace/.sirna-task-context.json',timeoutMs=10000}={}){
  let endpoint;try{endpoint=new URL(baseUrl);}catch{throw unavailable();}
  if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw unavailable();
  return {async report(args,signal){
    try{
      const serialized=JSON.stringify(args);if(typeof serialized!=='string'||Buffer.byteLength(serialized)>32768)throw unavailable();
      const context=await readContext(contextPath),deadline=AbortSignal.timeout(timeoutMs);
      const response=await fetch(new URL('/v1/tool-gaps',endpoint),{method:'POST',redirect:'error',headers:{authorization:`Bearer ${context.token}`,'x-sirna-task-id':context.taskId,'x-sirna-agent-turn-id':context.agentTurnId,'content-type':'application/json'},body:serialized,signal:signal?AbortSignal.any([signal,deadline]):deadline});
      if(![200,202].includes(response.status)||!response.body||Number(response.headers.get('content-length'))>65536||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')){await response.body?.cancel();throw unavailable();}
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)throw unavailable();chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
      return validateToolGapResponse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),response.status,context);
    }catch{throw unavailable();}
  }};
}
