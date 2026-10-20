// Deliberately separate from the browser/task router. Deploy on a private UDS.
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {validateApprovedToolArguments} from '../../packages/capability-platform/tool-approved-execution.mjs';

const LIMIT=262144;
function fail(status,message){throw Object.assign(new Error(message),{status});}
function respond(res,status,value){
  if(res.destroyed||res.writableEnded)return;
  const body=JSON.stringify(value);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store'});res.end(body);
}
function header(req,name){
  let count=0;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)count++;
  if(count!==1||typeof req.headers[name]!=='string')fail(401,'Task capability unavailable');return req.headers[name];
}
function authorize(req,leases,call){
  const authorization=header(req,'authorization');const match=/^Bearer ([a-f0-9]{64})$/.exec(authorization);
  if(!match)fail(401,'Task capability unavailable');
  return leases.authorize({token:match[1],taskId:header(req,'x-sirna-task-id'),agentTurnId:header(req,'x-sirna-agent-turn-id'),call});
}
async function body(req){
  if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))fail(415,'Expected JSON content');
  if(req.headers['content-encoding']!==undefined)fail(415,'Encoded content is unsupported');
  if(Number(req.headers['content-length'])>LIMIT)fail(413,'Request exceeds bound');
  const chunks=[];let size=0;
  let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Request timed out'),{status:408})),15000);timer.unref();});
  try{
    await Promise.race([(async()=>{for await(const chunk of req){size+=chunk.length;if(size>LIMIT)fail(413,'Request exceeds bound');chunks.push(chunk);}})(),timeout]);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail(400,'Invalid JSON request');}
  }finally{clearTimeout(timer);}
}
function publicContent(result){
  if(!Array.isArray(result?.content)||!result.content.length||result.content.some(x=>x?.type!=='text'||typeof x.text!=='string')||Buffer.byteLength(JSON.stringify(result.content))>LIMIT)throw new Error('Invalid tool content');
  return {content:result.content.map(({text})=>({type:'text',text}))};
}
export function createAgentToolsServer({leases,discover}={}){
  if(typeof leases?.authorize!=='function'||typeof discover!=='function')throw new TypeError('Explicit leases and discovery are required');
  const accepted=new Set();let busy=false;
  async function load(taskContext){
    let result;try{result=await discover({taskContext});}catch{fail(503,'Approved tool discovery unavailable');}
    if(!result||!Array.isArray(result.tools)||!Array.isArray(result.rejected)||result.rejected.length)fail(503,'Approved tool discovery unavailable');
    const tools=new Map();
    for(const tool of result.tools){
      if(!tool||!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)||typeof tool.label!=='string'||typeof tool.description!=='string'||typeof tool.execute!=='function'||!tool.parameters||tools.has(tool.name))fail(503,'Approved tool discovery unavailable');
      tools.set(tool.name,tool);
    }
    return tools;
  }
  const server=http.createServer(async(req,res)=>{
    try{
      const list=req.url==='/v1/agent-tools';const match=/^\/v1\/agent-tools\/([a-z][a-z0-9_]{0,63})\/call$/.exec(req.url??'');
      if(!list&&!match)fail(404,'Unknown tool endpoint');
      if(req.method!==(list?'GET':'POST'))fail(405,'Unsupported tool method');
      let handle=authorize(req,leases,!list);
      if(list){
        if(req.headers['transfer-encoding']!==undefined||Number(req.headers['content-length']??0)!==0)fail(400,'Unexpected request content');
        const tools=await load(handle.taskContext);authorize(req,leases,false);
        const result={tools:[...tools.values()].map(tool=>({name:tool.name,label:tool.label,description:tool.description,inputSchema:tool.parameters}))};
        if(Buffer.byteLength(JSON.stringify(result))>LIMIT)fail(503,'Approved tool discovery unavailable');respond(res,200,result);return;
      }
      const input=await body(req);
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'arguments'))fail(400,'Invalid tool request');
      try{validateApprovedToolArguments(input.arguments);}catch{fail(400,'Invalid approved tool arguments');}
      handle=authorize(req,leases,true);
      if(busy)fail(409,'Approved tool executor is busy');
      // Reserve before discovery awaits so no two connections execute concurrently.
      busy=true;
      const operation=handle.run(async()=>{
        const tools=await load(handle.taskContext);const tool=tools.get(match[1]);if(!tool)fail(404,'Unknown approved tool');
        if(handle.signal.aborted)fail(401,'Task capability unavailable');
        const toolCallId=randomUUID();let success=false;
        try{const result=publicContent(await tool.execute(toolCallId,input.arguments,handle.signal));success=true;return result;}
        catch{return {isError:true,content:[{type:'text',text:'Approved tool call failed. Check arguments and inspect the host audit records.'}]};}
        finally{await handle.emit({type:'approved_tool_call',toolName:tool.name,toolCallId,agentRunId:handle.taskContext.agentRunId,success});}
      });
      accepted.add(operation);
      try{respond(res,200,await operation);}finally{accepted.delete(operation);busy=false;}
    }catch(error){
      const status=[400,401,404,405,408,409,413,415,503].includes(error?.status)?error.status:500;
      const messages={400:'Invalid tool request',401:'Task capability unavailable',404:'Unknown tool endpoint',405:'Unsupported tool method',408:'Request timed out',409:'Tool execution unavailable',413:'Request exceeds bound',415:'Expected JSON content',503:'Approved tool discovery unavailable',500:'Tool service unavailable'};
      respond(res,status,{error:messages[status]});req.resume();
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=32;
  server.waitForCalls=async()=>{while(accepted.size)await Promise.allSettled([...accepted]);};
  return server;
}
