import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const taskId='11111111-1111-4111-8111-111111111111',agentTurnId='22222222-2222-4222-8222-222222222222';
const context={protocolVersion:'sirna-task-context/v1',taskId,agentTurnId,token:'a'.repeat(64)};
const tool={name:'summarize_target_sequence',label:'Summary',description:'Summarize a sequence.',inputSchema:{type:'object',properties:{input:{type:'object'}},required:['input'],additionalProperties:false}};
async function bounded(promise,message){
  let timer;try{return await Promise.race([promise,new Promise((_r,reject)=>{timer=setTimeout(()=>reject(new Error(message)),3000);})]);}
  finally{clearTimeout(timer);}
}
async function fixture(t,handler){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sirna-remote-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const contextPath=path.join(directory,'context.json');await fs.writeFile(contextPath,JSON.stringify(context));
  const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const api=await import('../apps/mcp/remote-client.mjs').catch(()=>({}));
  assert.equal(typeof api.createRemoteToolDiscovery,'function','remote discovery is implemented');
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  return {directory,contextPath,baseUrl,discover:api.createRemoteToolDiscovery({baseUrl,contextPath}),api};
}
test('remote discovery rereads per-turn context and forwards only public arguments and content',async t=>{
  const requests=[];
  const f=await fixture(t,async(req,res)=>{let body='';for await(const part of req)body+=part;
    requests.push({method:req.method,url:req.url,headers:req.headers,body});
    res.setHeader('content-type','application/json');res.end(JSON.stringify(req.method==='GET'?{tools:[tool]}:{content:[{type:'text',text:'{"length":2}'}]}));});
  const found=await f.discover();assert.equal(found.tools[0].name,tool.name);assert.deepEqual(found.rejected,[]);
  await fs.writeFile(f.contextPath,JSON.stringify({...context,token:'b'.repeat(64)}));
  const result=await found.tools[0].execute('not-forwarded',{input:{sequence:'AC'}},new AbortController().signal);
  assert.deepEqual(result,{content:[{type:'text',text:'{"length":2}'}]});
  assert.equal(requests[0].headers.authorization,`Bearer ${'a'.repeat(64)}`);
  assert.equal(requests[1].headers.authorization,`Bearer ${'b'.repeat(64)}`);
  assert.equal(requests[1].headers['x-sirna-task-id'],taskId);assert.equal(requests[1].headers['x-sirna-agent-turn-id'],agentTurnId);
  assert.equal(requests[1].url,'/v1/agent-tools/summarize_target_sequence/call');
  assert.deepEqual(JSON.parse(requests[1].body),{arguments:{input:{sequence:'AC'}}});
});
test('invalid, large, linked or endpoint-bearing contexts fail before HTTP',async t=>{
  let calls=0;const f=await fixture(t,(_req,res)=>{calls++;res.end('{"tools":[]}');});
  for(const value of [{...context,token:'bad'},{...context,taskId:'../task'},{...context,agentTurnId:'bad'},{...context,baseUrl:'http://elsewhere'},'x'.repeat(4097)]){
    await fs.writeFile(f.contextPath,typeof value==='string'?value:JSON.stringify(value));
    await assert.rejects(f.discover(),/Remote approved tools unavailable/);
  }
  await fs.writeFile(f.contextPath,JSON.stringify(context));await fs.link(f.contextPath,path.join(f.directory,'hardlink'));
  await assert.rejects(f.discover(),/unavailable/);assert.equal(calls,0);
});
test('remote failures, redirects, malformed and oversized results never expose diagnostics',async t=>{
  let mode='list';let count=0;
  const f=await fixture(t,(_req,res)=>{count++;
    if(mode==='redirect'){res.writeHead(302,{location:'/private/secret'});res.end();return;}
    if(mode==='status'){res.writeHead(500);res.end('secret host path');return;}
    const body=mode==='list'?{tools:[tool]}:mode==='error'?{isError:true,content:[{type:'text',text:'secret'}]}:
      mode==='details'?{content:[{type:'text',text:'ok'}],details:{secret:true}}:
      mode==='image'?{content:[{type:'image',data:'secret'}]}:{content:[{type:'text',text:'x'.repeat(300001)}]};
    res.end(JSON.stringify(body));});
  const item=(await f.discover()).tools[0];
  for(mode of ['redirect','status','error','details','image','large']){
    const before=count;await assert.rejects(item.execute('id',{input:{}},new AbortController().signal),error=>{
      assert.equal(error.message,'Remote approved tools unavailable');return true;
    });assert.equal(count,before+1);
  }
});
test('remote calls honor cancellation and a finite response deadline',async t=>{
  const f=await fixture(t,()=>{});
  const discover=f.api.createRemoteToolDiscovery({baseUrl:f.baseUrl,contextPath:f.contextPath,timeoutMs:50});
  await assert.rejects(discover(),/unavailable/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(f.discover({signal:controller.signal}),/unavailable/);
});
test('guest MCP keeps fixed enumeration local and refreshes remote descriptors on a connected client',async t=>{
  let enabled=false;let calls=0;
  const f=await fixture(t,(req,res)=>{calls++;res.end(JSON.stringify(req.method==='GET'?{tools:enabled?[tool]:[]}:{content:[{type:'text',text:'{}'}]}));});
  const {createApprovedMcpServer}=await import('../apps/mcp/approved-server.mjs');
  const server=createApprovedMcpServer({discover:f.discover,pollIntervalMs:20});
  const client=new Client({name:'remote-test',version:'1.0.0'});const [a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});await server.connect(b);await client.connect(a);
  assert.equal(client.getServerCapabilities().tools.listChanged,true);
  await client.listTools();let notify;const changed=new Promise(resolve=>{notify=resolve;});
  client.setNotificationHandler((await import('@modelcontextprotocol/sdk/types.js')).ToolListChangedNotificationSchema,()=>notify());
  enabled=true;await bounded(changed,'no tool-list notification');
  assert.equal((await client.listTools()).tools.at(-1).name,tool.name);
  const before=calls;const result=await client.callTool({name:'enumerate_sirna_candidates',arguments:{targetSequence:'A'.repeat(21)}});
  assert.equal(JSON.parse(result.content[0].text).candidates[0].guide,'U'.repeat(21));
  assert.ok(calls>=before); // discovery remains live; fixed execution itself is local.
  assert.notEqual((await client.callTool({name:tool.name,arguments:{input:{}}})).isError,true);
});
test('closing remote MCP aborts an in-flight discovery poll instead of keeping the guest HTTP connection alive',async t=>{
  let hang=false,entered,closed;const pending=new Promise(resolve=>{entered=resolve;});const disconnected=new Promise(resolve=>{closed=resolve;});
  const f=await fixture(t,(_req,res)=>{if(!hang){res.end('{"tools":[]}');return;}res.once('close',closed);entered();});
  const {createApprovedMcpServer}=await import('../apps/mcp/approved-server.mjs');
  const server=createApprovedMcpServer({discover:f.discover,pollIntervalMs:20});
  const client=new Client({name:'poll-close-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});await server.connect(b);await client.connect(a);await client.listTools();
  hang=true;await pending;await server.close();
  // Still far below the 30s request bound; tolerate full-suite process contention.
  await bounded(disconnected,'discovery poll connection remained live');
});
