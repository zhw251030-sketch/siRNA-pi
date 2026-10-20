// Guest-only public protocol client. No registry, runner, or host path is present.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
const unavailable=()=>new Error('Remote approved tools unavailable');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const namePattern=/^[a-z][a-z0-9_]{0,63}$/;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>object(value)&&Object.keys(value).every(key=>allowed.includes(key));
async function readContext(filename){
  const before=await fs.lstat(filename);
  if(!before.isFile()||before.nlink!==1||before.size>4096)throw unavailable();
  const file=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try{
    const opened=await file.stat();
    if(!opened.isFile()||opened.nlink!==1||opened.size>4096||opened.dev!==before.dev||opened.ino!==before.ino)throw unavailable();
    const buffer=Buffer.alloc(4097);const {bytesRead}=await file.read(buffer,0,4097,0);
    const after=await file.stat();
    if(bytesRead>4096||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)throw unavailable();
    const context=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
    if(!keys(context,['protocolVersion','taskId','agentTurnId','token'])||context.protocolVersion!=='sirna-task-context/v1'||
      !uuid.test(context.taskId)||!uuid.test(context.agentTurnId)||typeof context.token!=='string'||!/^[0-9a-f]{64}$/.test(context.token))throw unavailable();
    return context;
  }finally{await file.close();}
}
async function jsonResponse(response){
  if(response.status!==200||!response.body)throw unavailable();
  if(Number(response.headers.get('content-length'))>300000)throw unavailable();
  const reader=response.body.getReader();let size=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>300000)throw unavailable();chunks.push(Buffer.from(value));}}
  finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createRemoteToolDiscovery({baseUrl,contextPath='/workspace/.sirna-task-context.json',fetchImpl=globalThis.fetch,timeoutMs=30000}={}){
  let endpoint;try{endpoint=new URL(baseUrl);}catch{throw unavailable();}
  if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash||
    !Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||typeof fetchImpl!=='function')throw unavailable();
  async function request(route,args,signal){
    try{
      const context=await readContext(contextPath);
      const body=args===undefined?undefined:JSON.stringify({arguments:args});
      if(body!==undefined&&Buffer.byteLength(body)>262144)throw unavailable();
      const response=await fetchImpl(new URL(route,endpoint),{method:body===undefined?'GET':'POST',redirect:'error',
        headers:{authorization:`Bearer ${context.token}`,'x-sirna-task-id':context.taskId,'x-sirna-agent-turn-id':context.agentTurnId,
          ...(body===undefined?{}:{'content-type':'application/json'})},body,
        signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
      return await jsonResponse(response);
    }catch{throw unavailable();}
  }
  return async function discover({signal}={}){
    try{
      const result=await request('/v1/agent-tools',undefined,signal);
      if(!keys(result,['tools'])||!Array.isArray(result.tools)||result.tools.length>100)throw unavailable();
      const names=new Set();const tools=result.tools.map(tool=>{
        if(!keys(tool,['name','label','description','inputSchema'])||!namePattern.test(tool.name)||names.has(tool.name)||
          typeof tool.label!=='string'||tool.label.length>256||typeof tool.description!=='string'||tool.description.length>16384||!object(tool.inputSchema))throw unavailable();
        names.add(tool.name);
        return {name:tool.name,label:tool.label,description:tool.description,parameters:tool.inputSchema,
          executionMode:'sequential',async execute(_id,args,callSignal){
            const output=await request(`/v1/agent-tools/${tool.name}/call`,args,callSignal);
            if(!keys(output,['content','isError'])||output.isError!==undefined&&output.isError!==false||!Array.isArray(output.content)||output.content.length===0||
              output.content.some(item=>!keys(item,['type','text'])||item.type!=='text'||typeof item.text!=='string')||Buffer.byteLength(JSON.stringify(output.content))>262144)throw unavailable();
            return {content:output.content.map(({text})=>({type:'text',text}))};
          }};
      });return {tools,rejected:[]};
    }catch{throw unavailable();}
  };
}
