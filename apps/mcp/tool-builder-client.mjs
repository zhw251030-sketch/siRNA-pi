import {readContext} from './remote-client.mjs';
const unavailable=()=>new Error('Remote builder unavailable; an accepted operation may have completed. Inspect host records before retrying.');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function createToolBuilderClient({baseUrl,contextPath='/workspace/.sirna-task-context.json',timeoutMs=300000}={}){
  let endpoint;try{endpoint=new URL(baseUrl);}catch{throw unavailable();}
  if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000)throw unavailable();
  async function request(operation,args={},signal){
    try{
      let method,route,body,expected;
      if(operation==='create'){method='POST';route='/v1/build-sessions';body=args;expected=201;}
      else if(operation==='propose'){method='POST';route='/v1/tool-proposals';body=args;expected=201;}
      else{
        if(!args||!UUID.test(args.sessionId))throw unavailable();const {sessionId,...rest}=args;
        const routes={write:['PUT','files'],run:['POST','exec'],cancel:['DELETE',''],finalize:['POST','finalize']};
        [method]=routes[operation];route=`/v1/build-sessions/${sessionId}${routes[operation][1]?'/'+routes[operation][1]:''}`;expected=200;
        if(operation==='cancel'){if(Object.keys(rest).length)throw unavailable();}else body=rest;
      }
      const serialized=body===undefined?undefined:JSON.stringify(body);if(serialized!==undefined&&Buffer.byteLength(serialized)>1048576)throw unavailable();
      const context=await readContext(contextPath);const deadline=AbortSignal.timeout(timeoutMs);
      const response=await fetch(new URL(route,endpoint),{method,redirect:'error',headers:{authorization:`Bearer ${context.token}`,'x-sirna-task-id':context.taskId,'x-sirna-agent-turn-id':context.agentTurnId,...(serialized===undefined?{}:{'content-type':'application/json'})},body:serialized,signal:signal?AbortSignal.any([signal,deadline]):deadline});
      if(response.status!==expected||!response.body||Number(response.headers.get('content-length'))>300000){await response.body?.cancel();throw unavailable();}
      const reader=response.body.getReader();const chunks=[];let length=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>300000)throw unavailable();chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
      const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!value||typeof value!=='object'||Array.isArray(value))throw unavailable();return value;
    }catch{throw unavailable();}
  }
  return Object.fromEntries(['create','write','run','cancel','finalize','propose'].map(operation=>[operation,(args,signal)=>request(operation,args,signal)]));
}
