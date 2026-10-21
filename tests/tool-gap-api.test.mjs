import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createToolCallLeases} from '../packages/capability-platform/tool-call-leases.mjs';
import {createAgentToolsServer} from '../apps/api/agent-tools.mjs';
import {createRemoteMcpServer} from '../apps/mcp/remote-server.mjs';
import {createToolRelay} from '../containers/agent-tools-relay/relay.mjs';
import {gapFixture,gapInput} from './helpers/tool-gap-fixture.mjs';
import {ToolGapStore} from '../packages/extensions/tool-curation/tool-gap-store.mjs';
import {createToolGapService} from '../packages/extensions/tool-curation/tool-gap-service.mjs';
import {createToolGapClient} from '../apps/mcp/tool-gap-client.mjs';

const input={capability:'Summarize target sequence',blocking:true,reason:'No registered batch summary tool',desiredInput:{sequence:'ACGU'},desiredOutput:{count:4},evidenceEventIds:[]};
const identity=()=>({taskId:randomUUID(),executionSessionId:randomUUID(),sandboxId:'a'.repeat(64),agentTurnId:randomUUID()});
const headers=lease=>({authorization:`Bearer ${lease.context.token}`,'x-sirna-task-id':lease.context.taskId,'x-sirna-agent-turn-id':lease.context.agentTurnId,'content-type':'application/json'});
function response(context,duplicate=false){return {report:{id:randomUUID(),taskId:context.taskId,runId:context.agentRunId,userMessageId:randomUUID(),...input,capabilityKey:'summarize-target-sequence',createdAt:'2026-10-22T00:00:00.000Z',source:{...context},reportSha256:'a'.repeat(64)},deduplicated:duplicate,candidateCreated:false,toolCreated:false,nextGate:'finish_current_turn_then_manual_curator_review'};}
async function fixture(t,{report}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sirna-gap-http-')),leases=createToolCallLeases(),owned=[],saved=[];
  let discoveries=0;const toolGaps={report:report??((args,context)=>{assert.deepEqual(args,input);const old=saved.find(v=>v.report.taskId===context.taskId);if(old)return {...old,deduplicated:true};const value=response(context);saved.push(value);return value;})};
  const server=createAgentToolsServer({leases,toolGaps,discover:async()=>{discoveries++;return {tools:[],rejected:[]};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const lease of owned)await lease.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  const begin=(active=true,signal)=>{const context=identity(),lease=leases.begin({...context,signal});owned.push(lease);if(active)lease.activate('b'.repeat(64));return {lease,context:{...context,agentRunId:'b'.repeat(64)}};};
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  const post=(lease,args=input)=>fetch(baseUrl+'/v1/tool-gaps',{method:'POST',headers:headers(lease),body:JSON.stringify(args)});
  return {root,server,leases,begin,post,saved,baseUrl,discoveries:()=>discoveries};
}

test('private report route requires live activated lease and persists exact host identity without approved discovery',async t=>{
  const f=await fixture(t),pending=f.begin(false);assert.equal((await f.post(pending.lease)).status,409);
  const {lease,context}=f.begin();assert.equal((await f.post({context:{...lease.context,taskId:randomUUID()}})).status,401);
  const accepted=await f.post(lease);assert.equal(accepted.status,202);const value=await accepted.json();assert.equal(value.toolCreated,false);assert.equal(value.candidateCreated,false);assert.deepEqual(value.report.source,context);assert.equal(JSON.stringify(value).includes(lease.context.token),false);
  const duplicate=await f.post(lease);assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).report.id,value.report.id);assert.equal(f.saved.length,1);assert.equal(f.discoveries(),0);
  await lease.close();assert.equal((await f.post(lease)).status,401);
});

test('report transport rejects forged source fields, wrong routes and oversized request before service',async t=>{
  const f=await fixture(t),{lease}=f.begin();
  for(const args of [{...input,taskId:lease.context.taskId},{...input,source:{}},{...input,taskContext:{}},{...input,runId:'fake'}])assert.equal((await f.post(lease,args)).status,400);
  for(const route of ['/v1/tool-gaps?x=1','/v1/tool-gaps/other','/v1/tasks/tool-gaps'])assert.equal((await fetch(f.baseUrl+route,{method:'POST',headers:headers(lease),body:JSON.stringify(input)})).status,404);
  assert.equal((await fetch(f.baseUrl+'/v1/tool-gaps',{headers:headers(lease)})).status,405);
  assert.equal((await fetch(f.baseUrl+'/v1/tool-gaps',{method:'POST',headers:headers(lease),body:'x'.repeat(32769)})).status,413);assert.equal(f.saved.length,0);
});

test('slow request rechecks lease after body and canceled turn cannot persist',async t=>{
  for(const revoke of ['abort','close']){
    const f=await fixture(t),controller=new AbortController(),{lease}=f.begin(true,controller.signal);
    let authorized;const ready=new Promise(resolve=>authorized=resolve),original=f.leases.authorize.bind(f.leases);f.leases.authorize=args=>{const handle=original(args);authorized();return handle;};
    const body=JSON.stringify(input);let request;
    const result=new Promise((resolve,reject)=>{request=http.request(f.baseUrl+'/v1/tool-gaps',{method:'POST',headers:{...headers(lease),'content-length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});request.on('error',reject);request.write(body.slice(0,10));});
    await ready;if(revoke==='abort')controller.abort();else await lease.close();request.end(body.slice(10));assert.equal(await result,401,revoke);assert.equal(f.saved.length,0);
  }
});

test('shutdown drains accepted report work through lease handle tracking',async t=>{
  let enter,release;const ready=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  const f=await fixture(t,{report:async(_args,context)=>{enter();await gate;return response(context);}}),{lease}=f.begin();
  const request=f.post(lease);await ready;let done=false;const drained=f.server.waitForCalls().then(()=>done=true);const closing=lease.close();await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);release();assert.equal((await request).status,202);await drained;await closing;assert.equal(done,true);
});

test('explicit MCP report category is writable and reaches report route with no fixed argument validator',async t=>{
  const f=await fixture(t),{lease}=f.begin();const contextPath=path.join(f.root,'context.json');fs.writeFileSync(contextPath,JSON.stringify(lease.context));
  const mcp=createRemoteMcpServer({baseUrl:f.baseUrl,gapUrl:f.baseUrl,contextPath,pollIntervalMs:0}),client=new Client({name:'gap-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await mcp.close();});await mcp.connect(b);await client.connect(a);
  const listed=(await client.listTools()).tools.find(tool=>tool.name==='report_tool_gap');assert.ok(listed);assert.equal(listed.annotations.readOnlyHint,false);assert.equal(listed.annotations.idempotentHint,false);
  const discoveries=f.discoveries();const reply=await client.callTool({name:'report_tool_gap',arguments:input});assert.notEqual(reply.isError,true);assert.equal(JSON.parse(reply.content[0].text).toolCreated,false);assert.equal(f.saved.length,1);assert.equal(f.discoveries(),discoveries,'Reporting cannot trigger approved-tool discovery');
});

test('real UDS relay preserves report creation/duplicate semantics and denies alternate route',async t=>{
  const f=await fixture(t),{lease}=f.begin();await new Promise(resolve=>f.server.close(resolve));const socketPath=process.platform==='win32'?`\\\\.\\pipe\\sirna-gap-${randomUUID()}`:path.join(f.root,'api.sock');await new Promise(resolve=>f.server.listen(socketPath,resolve));
  const relay=createToolRelay({socketPath});await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{relay.closeAllConnections();relay.close(resolve);}));const base=`http://127.0.0.1:${relay.address().port}`;
  for(const status of [202,200]){const r=await fetch(base+'/v1/tool-gaps',{method:'POST',headers:headers(lease),body:JSON.stringify(input)});assert.equal(r.status,status);assert.equal((await r.json()).deduplicated,status===200);}
  assert.equal((await fetch(base+'/v1/tool-gaps?x=1',{method:'POST',headers:headers(lease),body:'{}'})).status,404);assert.equal(f.saved.length,1);
});

test('client rejects redirects, oversized or contradictory response with one request and safe errors',async t=>{
  const api=await import('../apps/mcp/tool-gap-client.mjs').catch(()=>({}));assert.equal(typeof api.createToolGapClient,'function');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gap-client-')),context=identity(),lease={context:{protocolVersion:'sirna-task-context/v1',taskId:context.taskId,agentTurnId:context.agentTurnId,token:'a'.repeat(64)}};const contextPath=path.join(root,'context.json');fs.writeFileSync(contextPath,JSON.stringify(lease.context));
  let count=0,mode='redirect';const fixture=http.createServer((req,res)=>{count++;req.resume();if(mode==='redirect'){res.writeHead(302,{location:'/private-token'});res.end();return;}if(mode==='large'){res.writeHead(202,{'content-type':'application/json'});res.end('x'.repeat(65537));return;}const value=response({...context,agentRunId:'b'.repeat(64)},mode==='mismatch');if(mode==='identity')value.report.taskId=randomUUID();if(mode==='source')value.report.source.sandboxId='forged';if(mode==='created')value.toolCreated=true;res.writeHead(202,{'content-type':'application/json'});res.end(JSON.stringify(value));});await new Promise(r=>fixture.listen(0,'127.0.0.1',r));t.after(()=>{fixture.closeAllConnections();fixture.close();fs.rmSync(root,{recursive:true,force:true});});
  const client=api.createToolGapClient({baseUrl:`http://127.0.0.1:${fixture.address().port}`,contextPath});
  for(mode of ['redirect','large','mismatch','identity','source','created']){const before=count;await assert.rejects(client.report(input),error=>{assert.doesNotMatch(error.message,/private-token|127\.0\.0\.1|a{64}/);return true;});assert.equal(count,before+1,mode);}
});

test('actual TaskStore and gap SQLite persist only live run and MCP duplicate returns unchanged report',async t=>{
  const f=gapFixture(t),store=new ToolGapStore({root:f.root});f.closers.push(()=>store.close());const toolGaps=createToolGapService({store,taskStore:f.tasks,curationStore:f.curations}),leases=createToolCallLeases();
  const lease=leases.begin(f.context);lease.activate(f.runId);const server=createAgentToolsServer({leases,toolGaps,discover:async()=>{throw Error('Report must not discover approved tools');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await lease.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const post=args=>fetch(`http://127.0.0.1:${server.address().port}/v1/tool-gaps`,{method:'POST',headers:headers(lease),body:JSON.stringify(args)});
  const first=await post(gapInput());assert.equal(first.status,202);const saved=await first.json();assert.deepEqual(saved.report.source,f.context);assert.equal(saved.toolCreated,false);assert.equal(saved.candidateCreated,false);
  const contextPath=path.join(f.root,'mcp-context.json');fs.writeFileSync(contextPath,JSON.stringify(lease.context));const mcp=createRemoteMcpServer({baseUrl:`http://127.0.0.1:${server.address().port}`,gapUrl:`http://127.0.0.1:${server.address().port}`,contextPath,pollIntervalMs:0}),client=new Client({name:'real-gap-service',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();t.after(async()=>{await client.close();await mcp.close();});await mcp.connect(b);await client.connect(a);
  const duplicate=await client.callTool({name:'report_tool_gap',arguments:gapInput({reason:'Different repeat reason must not overwrite'})});assert.notEqual(duplicate.isError,true);assert.deepEqual(JSON.parse(duplicate.content[0].text).report,saved.report);assert.equal(JSON.parse(duplicate.content[0].text).deduplicated,true);assert.deepEqual(toolGaps.list(f.task.id,f.runId),[saved.report]);
  f.finish();const stale=await post(gapInput({capability:'Different capability'}));assert.equal(stale.status,409);assert.equal(toolGaps.list(f.task.id,f.runId).length,1);
});

test('relay rejects contradictory gap status, malformed identity, oversized response and unapproved statuses',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gap-relay-contract-')),socketPath=process.platform==='win32'?`\\\\.\\pipe\\sirna-gap-contract-${randomUUID()}`:path.join(root,'api.sock'),context={...identity(),agentRunId:'b'.repeat(64)},lease={context:{taskId:context.taskId,agentTurnId:context.agentTurnId,token:'a'.repeat(64)}};
  let mode='mismatch',calls=0;const upstream=http.createServer((req,res)=>{calls++;req.resume();let value=response(context,mode==='mismatch');if(mode==='source')value.report.source.sandboxId='bad';if(mode==='tool')value.toolCreated=true;if(mode==='identity')value.report.source.agentTurnId=randomUUID();res.writeHead(mode==='unexpected'?201:mode==='redirect'?302:202,{'content-type':'application/json',...(mode==='redirect'?{location:'http://private/token'}:{})});res.end(mode==='large'?'x'.repeat(65537):JSON.stringify(value));});await new Promise(r=>upstream.listen(socketPath,r));
  const relay=createToolRelay({socketPath});await new Promise(r=>relay.listen(0,'127.0.0.1',r));t.after(async()=>{relay.closeAllConnections();await new Promise(r=>relay.close(r));upstream.closeAllConnections();await new Promise(r=>upstream.close(r));fs.rmSync(root,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${relay.address().port}/v1/tool-gaps`;
  for(mode of ['mismatch','source','tool','identity','large','unexpected','redirect']){const before=calls;const reply=await fetch(url,{method:'POST',headers:headers(lease),body:JSON.stringify(input)});assert.equal(reply.status,502,mode);assert.doesNotMatch(await reply.text(),/private|token|a{64}/);assert.equal(calls,before+1);}
  const before=calls;assert.equal((await fetch(url,{method:'POST',headers:headers(lease),body:'x'.repeat(32769)})).status,413);assert.equal(calls,before);
});

test('client rereads task context for each report and rejects oversized input before sending',async t=>{
  const f=await fixture(t),first=f.begin(),second=f.begin(),contextPath=path.join(f.root,'rotating-context.json');fs.writeFileSync(contextPath,JSON.stringify(first.lease.context));const client=createToolGapClient({baseUrl:f.baseUrl,contextPath});
  const one=await client.report(input);assert.equal(one.report.taskId,first.lease.context.taskId);fs.writeFileSync(contextPath,JSON.stringify(second.lease.context));const two=await client.report(input);assert.equal(two.report.taskId,second.lease.context.taskId);assert.notEqual(one.report.id,two.report.id);
  await assert.rejects(client.report({...input,reason:'x'.repeat(32769)}),/Tool gap report unavailable/);assert.equal(f.saved.length,2);fs.writeFileSync(contextPath,'{}');await assert.rejects(client.report(input),/Tool gap report unavailable/);assert.equal(f.saved.length,2);
});

test('service statusCode errors retain safe public status and never leak private diagnostics',async t=>{
  let statusCode=400;const f=await fixture(t,{report:()=>{throw Object.assign(new Error('/private/token'),{statusCode});}}),{lease}=f.begin();
  for(statusCode of [400,404,409,413,503,418]){const reply=await f.post(lease);assert.equal(reply.status,statusCode===418?503:statusCode);assert.doesNotMatch(await reply.text(),/private|token/);}
});
