// Private-network bridge to one host Unix socket. This is not a general proxy.
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const errorBody=Buffer.from(JSON.stringify({error:'Approved tool relay unavailable'}));
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
export function createToolRelay({socketPath,timeoutMs=30000}={}){
  if(typeof socketPath!=='string'||!socketPath||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new TypeError('A fixed tool socket and finite timeout are required');
  const server=http.createServer({maxHeaderSize:8192},async(req,res)=>{
    const signal=AbortSignal.timeout(timeoutMs);
    try{
      const list=req.method==='GET'&&req.url==='/v1/agent-tools';
      const call=req.method==='POST'&&/^\/v1\/agent-tools\/[a-z][a-z0-9_]{0,63}\/call$/.test(req.url);
      if(!list&&!call){req.resume();reply(res,404);return;}
      const headers={};
      for(const name of ['authorization','x-sirna-task-id','x-sirna-agent-turn-id']){
        let count=0;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)count++;
        if(count>1){req.resume();reply(res,400);return;}
        if(count!==1||typeof req.headers[name]!=='string'){req.resume();reply(res,401);return;}
        headers[name]=req.headers[name];
      }
      if(!/^Bearer [0-9a-f]{64}$/.test(headers.authorization)){req.resume();reply(res,401);return;}
      if(Number(req.headers['content-length'])>262144){req.resume();reply(res,413);return;}
      const body=await readBounded(req,262144,signal);
      if(list&&body.length){reply(res,400);return;}
      if(call)headers['content-type']='application/json';headers['content-length']=body.length;
      const result=await new Promise((resolve,reject)=>{
        const upstream=http.request({socketPath,path:req.url,method:req.method,headers,signal},async response=>{
          try{
            if(response.statusCode!==200){response.resume();const error=new Error('upstream');error.upstreamStatus=response.statusCode;throw error;}
            if(Number(response.headers['content-length'])>300000){response.destroy();throw new Error('large response');}
            let output;try{output=await readBounded(response,300000,signal);}catch{response.destroy();throw new Error('response unavailable');}
            const value=JSON.parse(output.toString('utf8'));
            const allowed=list?['tools']:['content','isError'];
            if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key))||
              !Array.isArray(list?value.tools:value.content))throw new Error('response unavailable');
            resolve(output);
          }catch(error){reject(error);}
        });upstream.once('error',()=>reject(new Error('upstream unavailable')));upstream.end(body);
      });reply(res,200,result);
    }catch(error){reply(res,error.status===413?413:[400,401,403,404,409,413,503].includes(error.upstreamStatus)?error.upstreamStatus:502);}
  });
  server.headersTimeout=timeoutMs;server.requestTimeout=timeoutMs;server.timeout=timeoutMs;
  const rejectTunnel=(_req,socket)=>{socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');};
  server.on('connect',rejectTunnel);server.on('upgrade',rejectTunnel);
  server.on('clientError',(_error,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
  return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  createToolRelay({socketPath:'/run/sirna-tools/api.sock'}).listen(7420,'0.0.0.0');
}
