import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
async function fixture(t,handler,options={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sirna-relay-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const socketPath=process.platform==='win32'?`\\\\.\\pipe\\sirna-${randomUUID()}`:path.join(directory,'api.sock');
  const upstream=http.createServer(handler);await new Promise(resolve=>upstream.listen(socketPath,resolve));
  t.after(()=>new Promise(resolve=>{upstream.closeAllConnections();upstream.close(resolve);}));
  const api=await import('../containers/agent-tools-relay/relay.mjs').catch(()=>({}));
  assert.equal(typeof api.createToolRelay,'function','fixed UDS relay is implemented');
  const relay=api.createToolRelay({socketPath,...options});await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{relay.closeAllConnections();relay.close(resolve);}));
  const port=relay.address().port;return {baseUrl:`http://127.0.0.1:${port}`,port};
}
const headers={authorization:`Bearer ${'a'.repeat(64)}`,'x-sirna-task-id':'11111111-1111-4111-8111-111111111111','x-sirna-agent-turn-id':'22222222-2222-4222-8222-222222222222'};
test('relay forwards only fixed tool paths and credential headers to its configured socket',async t=>{
  const observed=[];const f=await fixture(t,async(req,res)=>{let body='';for await(const c of req)body+=c;observed.push({url:req.url,headers:req.headers,body});res.end('{"content":[{"type":"text","text":"ok"}]}');});
  const response=await fetch(`${f.baseUrl}/v1/agent-tools/a/call`,{method:'POST',headers:{...headers,'content-type':'application/json','x-private':'secret'},body:'{"arguments":{"input":{}}}'});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{content:[{type:'text',text:'ok'}]});
  assert.equal(observed[0].url,'/v1/agent-tools/a/call');assert.equal(observed[0].headers.authorization,headers.authorization);
  assert.equal(observed[0].headers['x-sirna-agent-turn-id'],headers['x-sirna-agent-turn-id']);assert.equal(observed[0].headers['x-private'],undefined);
  assert.equal(observed[0].body,'{"arguments":{"input":{}}}');
});
test('relay rejects other routes, query strings, methods and oversized bodies before upstream',async t=>{
  let calls=0;const f=await fixture(t,(_req,res)=>{calls++;res.end('{"tools":[]}');});
  for(const [method,url] of [['GET','/v1/tasks'],['POST','/v1/agent-tools'],['GET','/v1/agent-tools/a/call'],['GET','/v1/agent-tools?x=1'],['POST','/v1/agent-tools/../tasks/call'],['DELETE','/v1/agent-tools']]){
    const result=await fetch(f.baseUrl+url,{method,headers});assert.notEqual(result.status,200);assert.doesNotMatch(await result.text(),/secret/);
  }
  const result=await fetch(f.baseUrl+'/v1/agent-tools/a/call',{method:'POST',headers,body:'x'.repeat(262145)});assert.equal(result.status,413);assert.equal(calls,0);
});
test('relay rejects duplicate authorization and upgrade or CONNECT without forwarding',async t=>{
  let calls=0;const f=await fixture(t,(_req,res)=>{calls++;res.end('{}');});
  const status=await new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:f.port,path:'/v1/agent-tools',headers:{authorization:[headers.authorization,'Bearer second']}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();
  });assert.equal(status,400);
  for(const options of [{method:'CONNECT',path:'example.com:443'},{path:'/v1/agent-tools',headers:{connection:'Upgrade',upgrade:'websocket'}}]){
    const status=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:f.port,...options},res=>{res.resume();resolve(res.statusCode);});req.on('connect',res=>resolve(res.statusCode));req.on('upgrade',()=>reject(new Error('unexpected upgrade')));req.on('error',reject);req.end();});assert.equal(status,400);
  }assert.equal(calls,0);
});
test('relay converts upstream diagnostics, redirects, excess response and timeout into fixed finite errors',async t=>{
  let mode='status';const f=await fixture(t,(_req,res)=>{
    if(mode==='timeout')return;
    if(mode==='redirect'){res.writeHead(302,{location:'http://private/secret'});res.end();return;}
    if(mode==='large'){res.end('x'.repeat(300001));return;}
    res.writeHead(500,{'x-private':'secret'});res.end('secret /private/path');
  },{timeoutMs:60});
  for(mode of ['status','redirect','large','timeout']){
    const result=await fetch(f.baseUrl+'/v1/agent-tools',{headers});assert.equal(result.status,502);
    assert.deepEqual(await result.json(),{error:'Approved tool relay unavailable'});assert.equal(result.headers.get('x-private'),null);
  }
});
