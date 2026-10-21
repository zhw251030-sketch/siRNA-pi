// Private-network bridge to one host Unix socket. This is not a general proxy.
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const errorBody=Buffer.from(JSON.stringify({error:'Approved tool relay unavailable'}));
// This container mounts this one file only. Keep the wire allowlist local;
// the host and guest independently validate the same small public contract.
function repairRejection(output){
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(output));
  const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
  const fields=['toolName','runtime','dependencies','permissions','repeatabilityMode','smokeInput','testCases','baseline','benchmarkCases','minNetGain','parent'];
  if(!exact(value,['error'])||!exact(value.error,['protocolVersion','code','outcome','fields']))throw new Error('unavailable');
  const e=value.error;
  if(e.protocolVersion!=='sirna-builder-rejection/v1'||e.code!=='repair_contract_mismatch'||e.outcome!=='not_registered'||!Array.isArray(e.fields)||!e.fields.length||e.fields.length>fields.length||e.fields.some(f=>!fields.includes(f))||new Set(e.fields).size!==e.fields.length)throw new Error('unavailable');
  return Buffer.from(JSON.stringify({error:{protocolVersion:'sirna-builder-rejection/v1',code:'repair_contract_mismatch',outcome:'not_registered',fields:fields.filter(f=>e.fields.includes(f))}}));
}
function gapResponse(output,status,headers){
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(output));
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
  const text=v=>typeof v==='string'&&v.length>0;
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
  if(!exact(value,['report','deduplicated','candidateCreated','toolCreated','nextGate'])||typeof value.deduplicated!=='boolean'||status!==(value.deduplicated?200:202)||value.candidateCreated!==false||value.toolCreated!==false||value.nextGate!=='finish_current_turn_then_manual_curator_review')throw new Error('unavailable');
  const r=value.report;
  if(!exact(r,['id','taskId','runId','userMessageId','capability','capabilityKey','blocking','reason','desiredInput','desiredOutput','evidenceEventIds','createdAt','source','reportSha256'])||!['id','taskId','runId','userMessageId','capability','capabilityKey','reason','createdAt'].every(k=>text(r[k]))||typeof r.blocking!=='boolean'||!object(r.desiredInput)||!object(r.desiredOutput)||!Array.isArray(r.evidenceEventIds)||r.evidenceEventIds.some(id=>!text(id))||!/^[a-f0-9]{64}$/.test(r.reportSha256)||!exact(r.source,['taskId','executionSessionId','sandboxId','agentTurnId','agentRunId'])||Object.values(r.source).some(v=>!text(v))||r.taskId!==headers['x-sirna-task-id']||r.source.taskId!==r.taskId||r.source.agentRunId!==r.runId||r.source.agentTurnId!==headers['x-sirna-agent-turn-id'])throw new Error('unavailable');
  if(!['id','taskId','userMessageId'].every(k=>uuid(r[k]))||!['taskId','executionSessionId','agentTurnId'].every(k=>uuid(r.source[k]))||!/^[a-f0-9]{64}$/.test(r.source.sandboxId)||!/^[A-Za-z0-9_-]{1,256}$/.test(r.runId)||!Number.isFinite(Date.parse(r.createdAt)))throw new Error('unavailable');
  return output;
}
function reply(res,status,body=errorBody){
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{'content-type':'application/json','content-length':body.length,'cache-control':'no-store'});res.end(body);
}
function readBounded(stream,limit,signal){
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0;
    const finish=(error)=>{stream.off('data',data);stream.off('end',end);stream.off('error',fail);stream.off('aborted',fail);signal.removeEventListener('abort',abort);error?reject(error):resolve(Buffer.concat(chunks));};
    const fail=()=>finish(new Error('unavailable'));
    const data=part=>{size+=part.length;if(size>limit){const error=new Error('limit');error.status=413;finish(error);stream.resume();}else chunks.push(part);};
    const end=()=>finish();const abort=()=>{finish(new Error('deadline'));stream.resume();};
    if(signal.aborted){reject(new Error('deadline'));return;}
    stream.on('data',data);stream.once('end',end);stream.once('error',fail);stream.once('aborted',fail);signal.addEventListener('abort',abort,{once:true});
  });
}
export function createToolRelay({socketPath,timeoutMs=30000,builderTimeoutMs=310000}={}){
  if(typeof socketPath!=='string'||!socketPath||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isInteger(builderTimeoutMs)||builderTimeoutMs<1||builderTimeoutMs>310000)throw new TypeError('A fixed tool socket and finite timeout are required');
  const server=http.createServer({maxHeaderSize:8192},async(req,res)=>{
    try{
      const list=req.method==='GET'&&req.url==='/v1/agent-tools';
      const call=req.method==='POST'&&/^\/v1\/agent-tools\/[a-z][a-z0-9_]{0,63}\/call$/.test(req.url);
      const gap=req.method==='POST'&&req.url==='/v1/tool-gaps';
      const id='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
      const create=req.method==='POST'&&(req.url==='/v1/build-sessions'||req.url==='/v1/tool-proposals');
      const build=create||req.method==='DELETE'&&new RegExp(`^/v1/build-sessions/${id}$`).test(req.url)||req.method==='PUT'&&new RegExp(`^/v1/build-sessions/${id}/files$`).test(req.url)||req.method==='POST'&&new RegExp(`^/v1/build-sessions/${id}/(?:exec|finalize)$`).test(req.url);
      if(!list&&!call&&!build&&!gap){req.resume();reply(res,404);return;}
      const signal=AbortSignal.timeout(build?builderTimeoutMs:timeoutMs);const requestLimit=gap?32768:build?1048576:262144;
      const headers={};
      for(const name of ['authorization','x-sirna-task-id','x-sirna-agent-turn-id']){
        let count=0;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)count++;
        if(count>1){req.resume();reply(res,400);return;}
        if(count!==1||typeof req.headers[name]!=='string'){req.resume();reply(res,401);return;}
        headers[name]=req.headers[name];
      }
      if(!/^Bearer [0-9a-f]{64}$/.test(headers.authorization)){req.resume();reply(res,401);return;}
      if(req.headers['content-encoding']!==undefined){req.resume();reply(res,415);return;}
      if(Number(req.headers['content-length'])>requestLimit){req.resume();reply(res,413);return;}
      // Reading a slow body never inherits the long Docker operation deadline.
      const body=await readBounded(req,requestLimit,AbortSignal.any([signal,AbortSignal.timeout(15000)]));
      if((list||req.method==='DELETE')&&body.length){reply(res,400);return;}
      if(call||gap||build&&req.method!=='DELETE')headers['content-type']=req.headers['content-type']??'application/json';headers['content-length']=body.length;
      const result=await new Promise((resolve,reject)=>{
        const upstream=http.request({socketPath,path:req.url,method:req.method,headers,signal},async response=>{
          try{
            if(gap&&[200,202].includes(response.statusCode)){
              if(Number(response.headers['content-length'])>65536||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers['content-type']??'')){response.destroy();throw new Error('unavailable');}
              let output;try{output=await readBounded(response,65536,signal);gapResponse(output,response.statusCode,headers);}catch{response.destroy();throw new Error('unavailable');}
              resolve({status:response.statusCode,body:output});return;
            }
            if(req.method==='POST'&&req.url==='/v1/tool-proposals'&&response.statusCode===409){
              try{
                if(Number(response.headers['content-length'])>2048||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers['content-type']??''))throw new Error('unavailable');
                const output=await readBounded(response,2048,signal);resolve({status:409,body:repairRejection(output)});return;
              }catch{response.destroy();const error=new Error('upstream');error.upstreamStatus=409;throw error;}
            }
            if(gap||response.statusCode!==(create?201:200)){response.resume();const error=new Error('upstream');error.upstreamStatus=response.statusCode;throw error;}
            if(Number(response.headers['content-length'])>300000){response.destroy();throw new Error('large response');}
            let output;try{output=await readBounded(response,300000,signal);}catch{response.destroy();throw new Error('response unavailable');}
            const value=JSON.parse(output.toString('utf8'));
            const allowed=list?['tools']:['content','isError'];
            if(!value||typeof value!=='object'||Array.isArray(value)||!build&&(Object.keys(value).some(key=>!allowed.includes(key))||
              !Array.isArray(list?value.tools:value.content)))throw new Error('response unavailable');
            resolve({status:create?201:200,body:output});
          }catch(error){reject(error);}
        });upstream.once('error',()=>reject(new Error('upstream unavailable')));upstream.end(body);
      });reply(res,result.status,result.body);
    }catch(error){reply(res,error.status===413?413:[400,401,403,404,405,408,409,413,415,503].includes(error.upstreamStatus)?error.upstreamStatus:502);}
  });
  server.headersTimeout=10000;server.requestTimeout=15000;server.timeout=0;
  const rejectTunnel=(_req,socket)=>{socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');};
  server.on('connect',rejectTunnel);server.on('upgrade',rejectTunnel);
  server.on('clientError',(_error,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
  return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  createToolRelay({socketPath:'/run/sirna-tools/api.sock'}).listen(7420,'0.0.0.0');
}
