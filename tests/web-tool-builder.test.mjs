import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {BuildDocker,COMMAND,proposal,removeBuildTestRoot} from './helpers/tool-build-docker.mjs';
import {createToolCallLeases} from '../packages/capability-platform/tool-call-leases.mjs';
import {createAgentToolsServer} from '../apps/api/agent-tools.mjs';
import {createRemoteMcpServer} from '../apps/mcp/remote-server.mjs';
import {ToolRegistry} from '../packages/capability-platform/tool-registry.mjs';
import {createToolRelay} from '../containers/agent-tools-relay/relay.mjs';
import {AgentComposeRuntime} from '../packages/agent-runtime/agent-compose-runtime.mjs';
import {TaskStore} from '../packages/task-core/task-store.mjs';
import {TaskMessageService} from '../packages/task-core/task-message-service.mjs';
import {createToolBuilderClient} from '../apps/mcp/tool-builder-client.mjs';
import {createApprovedMcpServer} from '../apps/mcp/approved-server.mjs';
import {createRemoteToolDiscovery} from '../apps/mcp/remote-client.mjs';
import {createToolBuilderTools} from '../packages/domain/sirna-tools/tool-builder-tools.mjs';
const api=await import('../packages/capability-platform/task-tool-builders.mjs').catch(()=>({}));
const owner=()=>({taskId:randomUUID(),executionSessionId:randomUUID(),sandboxId:'a'.repeat(64),agentTurnId:randomUUID()});
const headers=lease=>({authorization:`Bearer ${lease.context.token}`,'x-sirna-task-id':lease.context.taskId,'x-sirna-agent-turn-id':lease.context.agentTurnId,'content-type':'application/json'});
async function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-builder-')));const docker=new BuildDocker();
  assert.equal(typeof api.createTaskToolBuilders,'function','web builder coordinator is implemented');
  const leases=createToolCallLeases(),builders=api.createTaskToolBuilders({root,docker});const owned=[];
  const events=[];const begin=(activate=true,signal)=>{const context=owner();const lease=leases.begin({...context,signal,onCall:event=>events.push(event)});owned.push(lease);if(activate)lease.activate('host-run');return {lease,context};};
  const cleanup=[];
  const server=createAgentToolsServer({leases,builders,discover:async()=>({tools:[],rejected:[]})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{for(const lease of owned)await lease.close().catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const close of cleanup.reverse())await close();removeBuildTestRoot(root);});
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  const request=(lease,route='',method='POST',args={})=>fetch(baseUrl+(route||'/v1/build-sessions'),{method,headers:headers(lease),body:method==='DELETE'?undefined:JSON.stringify(args)});
  return {root,docker,leases,builders,begin,server,baseUrl,request,events,onCleanup:close=>cleanup.push(close)};
}
test('six guest MCP tools use fixed HTTP routes and submit real material owned by the activated host turn',async t=>{
  const f=await fixture(t);const {lease,context}=f.begin();const contextPath=path.join(f.root,'context.json');fs.writeFileSync(contextPath,JSON.stringify(lease.context));
  const mcp=createRemoteMcpServer({baseUrl:f.baseUrl,builderUrl:f.baseUrl,contextPath,pollIntervalMs:0});
  const client=new Client({name:'web-builder',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await mcp.close();});await mcp.connect(b);await client.connect(a);
  const tools=(await client.listTools()).tools;const names=['create_tool_build_session','write_tool_build_file','run_tool_build_command','cancel_tool_build_session','finalize_tool_build','propose_exploration_tool'];
  for(const name of names){const tool=tools.find(x=>x.name===name);assert.ok(tool,name);assert.equal(tool.annotations.readOnlyHint,false);assert.equal(tool.annotations.idempotentHint,false);}
  const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  const spare=(await call(names[0])).session.id;await call(names[3],{sessionId:spare});
  const id=(await call(names[0])).session.id,p=proposal();await call(names[1],{sessionId:id,path:'/opt/tool/main.mjs',content:p.script});await call(names[2],{sessionId:id,command:'true'});
  const final=await call(names[4],{sessionId:id,command:COMMAND});const submitted=await call(names[5],{...p,runtimeArtifact:final.artifact});assert.equal(submitted.state,'submitted');
  const registry=new ToolRegistry(path.join(f.root,'runtime/tool-registry/registry.sqlite'),{readOnly:true});try{assert.equal(registry.listActiveTools().length,0);assert.equal(registry.getProposal(submitted.proposalId).state,'submitted');assert.equal(registry.listEvents(submitted.proposalId)[0].actor,'web-agent');}finally{registry.close();}
  const events=fs.readFileSync(path.join(f.root,'runtime/tool-builds',id,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events[0].taskContext,{...context,agentRunId:'host-run'});assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'runtime/tool-builds',id,'finalized.json'))).taskContext,{...context,agentRunId:'host-run'});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'runtime/tool-builds',id,'proposal-result.json'))).taskContext,{...context,agentRunId:'host-run'});
  assert.doesNotMatch(JSON.stringify(events),new RegExp(lease.context.token));await lease.close();assert.equal(f.docker.containers.size,0);
  assert.equal(f.events.length,7);assert.equal(f.events.every(event=>event.type==='builder_tool_call'&&event.agentRunId==='host-run'&&event.success&&/^[0-9a-f-]{36}$/.test(event.toolCallId)),true);
});
test('fixed UDS relay carries real builder material and host body rejection has no Docker effects',async t=>{
  const f=await fixture(t),first=f.begin();await new Promise(resolve=>f.server.close(resolve));
  const socketPath=process.platform==='win32'?`\\\\.\\pipe\\sirna-builder-${randomUUID()}`:path.join(f.root,'api.sock');await new Promise(resolve=>f.server.listen(socketPath,resolve));
  const relay=createToolRelay({socketPath});await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{relay.closeAllConnections();relay.close(resolve);}));
  const base=`http://127.0.0.1:${relay.address().port}`;
  const created=await fetch(base+'/v1/build-sessions',{method:'POST',headers:headers(first.lease),body:'{}'});assert.equal(created.status,201);const id=(await created.json()).session.id;const before=f.docker.calls.length;
  for(const [body,status,extra]of [['{"taskContext":{}}',400,{}],['x'.repeat(1048577),413,{}],['{"extra":',400,{}],['{}',415,{'content-type':'text/plain'}],['{}',415,{'content-encoding':'gzip'}]]){
    const response=await fetch(base+'/v1/build-sessions',{method:'POST',headers:{...headers(first.lease),...extra},body});assert.equal(response.status,status);assert.doesNotMatch(await response.text(),/private|\/host/);
  }
  assert.equal(f.docker.calls.length,before);const write=await fetch(base+`/v1/build-sessions/${id}/files`,{method:'PUT',headers:headers(first.lease),body:JSON.stringify({path:'/opt/tool/main.mjs',content:'//'+ 'é'.repeat(99999)})});assert.equal(write.status,200);
  await first.lease.close();assert.equal(f.docker.containers.size,0);
});
test('task abort revokes immediately and final turn close removes its builder containers',async t=>{
  const f=await fixture(t),controller=new AbortController(),first=f.begin(true,controller.signal);assert.equal((await f.request(first.lease)).status,201);controller.abort();assert.equal((await f.request(first.lease)).status,401);await first.lease.close();assert.equal(f.docker.containers.size,0);const next=f.begin();assert.equal((await f.request(next.lease)).status,201);
});
test('pending, forged, other-turn and revoked requests cannot own or reuse build sessions',async t=>{
  const f=await fixture(t);const pending=f.begin(false);assert.equal((await f.request(pending.lease)).status,409);
  const first=f.begin();const response=await f.request(first.lease);assert.equal(response.status,201);const id=(await response.json()).session.id;
  const second=f.begin();assert.equal((await f.request(second.lease,`/v1/build-sessions/${id}/exec`,'POST',{command:'true'})).status,409);
  const forged={context:{...first.lease.context,agentTurnId:randomUUID()}};assert.equal((await f.request(forged)).status,401);
  await first.lease.close();assert.equal((await f.request(first.lease)).status,401);assert.equal(f.docker.containers.size,0);
  assert.equal((await f.request(second.lease,`/v1/build-sessions/${id}/exec`,'POST',{command:'true'})).status,409);
  assert.equal((await f.request(second.lease)).status,201);await second.lease.close();assert.equal(f.docker.containers.size,0);
});
test('turn close revokes synchronously then drains accepted HTTP work before cleanup and slot release',async t=>{
  const f=await fixture(t),first=f.begin();const id=(await (await f.request(first.lease)).json()).session.id;
  let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const exec=f.docker.exec.bind(f.docker);f.docker.exec=async(...args)=>{if(args[1][0]==='/bin/sh'){entered();await gate;}return exec(...args);};
  const run=f.request(first.lease,`/v1/build-sessions/${id}/exec`,'POST',{command:'true'});await ready;const closing=first.lease.close();let drained=false;const draining=f.server.waitForCalls().then(()=>drained=true);
  assert.equal((await f.request(first.lease)).status,401);const second=f.begin();assert.equal((await f.request(second.lease)).status,409);assert.equal(f.docker.containers.size,1);assert.equal(drained,false);
  release();assert.equal((await run).status,200);await closing;await draining;assert.equal(f.docker.containers.size,0);assert.equal((await f.request(second.lease)).status,201);
});
test('unknown container cleanup keeps the global slot occupied and errors omit private diagnostics',async t=>{
  const f=await fixture(t),first=f.begin();await f.request(first.lease);const remove=f.docker.removeContainer.bind(f.docker);f.docker.removeContainer=async()=>{throw new Error('private /host/token');};
  await assert.rejects(first.lease.close(),/cleanup unknown/);const second=f.begin();const result=await f.request(second.lease);assert.equal(result.status,409);assert.doesNotMatch(await result.text(),/private|host|token/);f.docker.removeContainer=remove;
});
test('real task service retains host builder call identity in reopened SQLite history',async t=>{
  const f=await fixture(t);const sandboxId='b'.repeat(64),workspace_path=`/data/sandboxes/2026/10/21/${sandboxId}/workspace`;
  const workspace=path.join(f.root,'runtime/agent-compose',workspace_path);fs.mkdirSync(path.join(workspace,'input'),{recursive:true});
  const executor={async up(){return {project:{id:'p'.repeat(64)}};},async bootstrap(update){await update({id:'boot',sandbox_id:sandboxId,status:'succeeded',exit_code:0});},async inspectSandbox(){return {sandbox_id:sandboxId,workspace_path,driver:'docker',vm_status:'running'};}};
  const threadId='builder-thread',rpc={async hasActiveRuns(){return false;},async run(request,callbacks){
    const runId='builder-rpc-run';await callbacks.onStarted({runId,sandboxId});const context=JSON.parse(fs.readFileSync(path.join(workspace,'.sirna-task-context.json')));
    assert.equal((await f.request({context})).status,201);
    const provider=path.join(workspace,'../state/agents/providers');fs.mkdirSync(path.join(provider,'pi/sessions'),{recursive:true});fs.writeFileSync(path.join(provider,'pi.json'),JSON.stringify({threadId}));fs.writeFileSync(path.join(provider,'pi/sessions/context.jsonl'),JSON.stringify({type:'session',id:threadId,cwd:'/workspace'})+'\n'+JSON.stringify({type:'message',message:{role:'assistant',content:[]}})+'\n');
    const result={provider:'pi',threadId,finalText:'Submitted no proposal.',finalTextSource:'provider_message'};await callbacks.onAgentEvent({name:'step_start',payload:{step:1}});await callbacks.onAgentEvent({name:'text_delta',payload:{step:1,text:result.finalText}});await callbacks.onAgentEvent({name:'step_end',payload:{step:1,stopReason:'stop',rawStopReason:'stop'}});await callbacks.onTurnCompleted(JSON.stringify({...result,type:'agent_turn_completed',stopReason:'completed'}));
    return {runId,sandboxId,status:'succeeded',resultJson:JSON.stringify({...result,type:'result',stopReason:'eof'})};
  }};
  const runtime=new AgentComposeRuntime({root:f.root,executor,rpc,toolCallLeases:f.leases,toolBuildersAvailable:true});const database=path.join(f.root,'tasks.sqlite');const store=new TaskStore(database);f.onCleanup(()=>store.close());const service=new TaskMessageService({taskStore:store,agentRuntime:runtime});
  const {task}=await service.createTask('builder-history-create');const handle=await service.start({taskId:task.id,message:'build',requestId:'builder-history-message'},()=>{});const completed=await handle.completion;assert.equal(completed.assistantMessage.status,'complete');assert.equal(f.docker.containers.size,0);
  const reopened=new TaskStore(database);try{const event=reopened.listRunEvents(task.id).find(item=>item.payload.type==='builder_tool_call');assert.ok(event,'host builder call must survive task history');assert.equal(event.type,'progress_message');assert.equal(event.payload.toolName,'create_tool_build_session');assert.equal(event.payload.agentRunId,'builder-rpc-run');assert.equal(event.payload.success,true);}finally{reopened.close();}
});
test('host bounds JSON escaped builder output and never serves an oversized success body',async t=>{
  const f=await fixture(t),first=f.begin();const id=(await(await f.request(first.lease)).json()).session.id;f.docker.debug.stdout='\u0000'.repeat(65536);
  const result=await f.request(first.lease,`/v1/build-sessions/${id}/exec`,'POST',{command:'true'});assert.equal(result.status,500);assert.ok((await result.text()).length<128);
});
test('client timeout is finite, never replays an accepted create and turn close drains its unknown outcome',async t=>{
  const f=await fixture(t),first=f.begin();const contextPath=path.join(f.root,'client-context.json');fs.writeFileSync(contextPath,JSON.stringify(first.lease.context));
  const client=createToolBuilderClient({baseUrl:f.baseUrl,contextPath,timeoutMs:60});let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const start=f.docker.startContainer.bind(f.docker);f.docker.startContainer=async(...args)=>{entered();await gate;return start(...args);};
  const result=assert.rejects(client.create({}),/accepted operation may have completed/);await ready;await result;assert.equal(f.docker.containers.size,1);
  let closed=false;const closing=first.lease.close().then(()=>closed=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);release();await closing;await f.server.waitForCalls();assert.equal(f.docker.containers.size,0);assert.equal(f.docker.calls.filter(call=>call.method==='createContainer').length,1);
});
test('client rejects oversized proposals, endpoint routes and aborted calls before host effects',async t=>{
  const f=await fixture(t),first=f.begin();const contextPath=path.join(f.root,'client-context.json');fs.writeFileSync(contextPath,JSON.stringify(first.lease.context));
  for(const baseUrl of [f.baseUrl+'/extra',f.baseUrl+'?route=elsewhere',f.baseUrl+'#x','file:///tmp/private'])assert.throws(()=>createToolBuilderClient({baseUrl,contextPath}));
  const client=createToolBuilderClient({baseUrl:f.baseUrl,contextPath});await assert.rejects(client.propose({script:'x'.repeat(1048577)}),/unavailable/);const controller=new AbortController();controller.abort();await assert.rejects(client.create({},controller.signal),/unavailable/);assert.equal(f.docker.calls.length,0);
});
test('MCP preserves the builder unknown-outcome warning after a real accepted HTTP create times out',async t=>{
  const f=await fixture(t),first=f.begin();const contextPath=path.join(f.root,'mcp-timeout-context.json');fs.writeFileSync(contextPath,JSON.stringify(first.lease.context));
  const service=createToolBuilderClient({baseUrl:f.baseUrl,contextPath,timeoutMs:60});
  const mcp=createApprovedMcpServer({discover:createRemoteToolDiscovery({baseUrl:f.baseUrl,contextPath}),builderTools:createToolBuilderTools({service})});
  const client=new Client({name:'builder-unknown-outcome',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();f.onCleanup(async()=>{await client.close();await mcp.close();});await mcp.connect(b);await client.connect(a);
  let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const start=f.docker.startContainer.bind(f.docker);f.docker.startContainer=async(...args)=>{entered();await gate;return start(...args);};
  const call=client.callTool({name:'create_tool_build_session',arguments:{}});await ready;let result;
  try{result=await call;}finally{release();await f.server.waitForCalls();}
  assert.equal(result.isError,true);assert.equal(result.content[0].text,'Tool builder call failed; an accepted operation may have completed. Inspect the host records before retrying.');
  assert.doesNotMatch(JSON.stringify(result),/Approved tool|Remote builder|private|\/host\//);assert.equal(f.docker.calls.filter(item=>item.method==='createContainer').length,1);
  await first.lease.close();assert.equal(f.docker.containers.size,0);
});
