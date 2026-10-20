import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {approvalFixture} from './helpers/approval-fixture.mjs';
import {DockerBoundary} from './helpers/validation-docker-boundary.mjs';
import {approveRegisteredToolProposal} from '../packages/capability-platform/tool-approval-service.mjs';
import {createDockerValidationRunner} from '../packages/capability-platform/tool-validation-runner.mjs';
import {discoverApprovedTools} from '../packages/capability-platform/tool-approved-execution.mjs';
const leasesApi=await import('../packages/capability-platform/tool-call-leases.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const httpApi=await import('../apps/api/agent-tools.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const identity=()=>({taskId:randomUUID(),executionSessionId:randomUUID(),sandboxId:'a'.repeat(64),agentTurnId:randomUUID()});
function begin(leases,extra={}){return leases.begin({...identity(),...extra});}
function headers(lease){return {authorization:`Bearer ${lease.context.token}`,'x-sirna-task-id':lease.context.taskId,'x-sirna-agent-turn-id':lease.context.agentTurnId,'content-type':'application/json'};}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function fixture(t){
  assert.equal(typeof leasesApi.createToolCallLeases,'function');assert.equal(typeof httpApi.createAgentToolsServer,'function');
  const f=await approvalFixture(t);approveRegisteredToolProposal(f.id,'test operator',{root:f.root});
  const docker=new DockerBoundary({manifest:f.saved.proposal,input:f.input});docker.result.stdout='{"length":2,"gcFraction":0.5}';
  const runner=createDockerValidationRunner({docker,purpose:'approved-call'});const leases=leasesApi.createToolCallLeases();
  const server=httpApi.createAgentToolsServer({leases,discover:({taskContext})=>discoverApprovedTools({root:f.root,runner,taskContext})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await server.waitForCalls();});
  const lease=begin(leases);return {...f,docker,leases,server,base,lease};
}
async function call(f,lease=f.lease,body={arguments:{input:{sequence:'AC'}}}){
  const response=await fetch(`${f.base}/v1/agent-tools/summarize_target_sequence/call`,{method:'POST',headers:headers(lease),body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}
function audit(f){const root=path.join(f.root,'runtime/approved-tool-runs/summarize_target_sequence');return fs.readdirSync(root).map(id=>JSON.parse(fs.readFileSync(path.join(root,id,'audit.json'))));}

test('pending discovery exposes only descriptors; activation binds server-derived audit identity',async t=>{
  const f=await fixture(t);const response=await fetch(`${f.base}/v1/agent-tools`,{headers:headers(f.lease)});
  const list=await response.json();assert.equal(response.status,200);assert.deepEqual(Object.keys(list),['tools']);
  assert.deepEqual(Object.keys(list.tools[0]).sort(),['description','inputSchema','label','name']);
  assert.equal((await call(f)).status,409);assert.equal(f.docker.calls.length,0);
  f.lease.activate('real-compose-run');const result=await call(f);assert.equal(result.status,200);assert.deepEqual(result.body,{content:[{type:'text',text:'{"length":2,"gcFraction":0.5}'}]});
  const saved=audit(f)[0];assert.deepEqual(saved.taskContext,{taskId:f.lease.context.taskId,executionSessionId:saved.taskContext.executionSessionId,sandboxId:'a'.repeat(64),agentTurnId:f.lease.context.agentTurnId,agentRunId:'real-compose-run'});
  assert.match(saved.taskContext.executionSessionId,/^[a-f0-9-]{36}$/);assert.notEqual(saved.toolCallId,saved.taskContext.agentRunId);assert.equal(JSON.stringify(saved).includes(f.lease.context.token),false);
  await f.lease.close();
});

test('authentication rejects absent, forged, duplicate and mismatched credentials before discovery',async t=>{
  const f=await fixture(t);
  for(const patch of [{authorization:''},{authorization:`Bearer ${'a'.repeat(64)}`},{'x-sirna-task-id':randomUUID()},{'x-sirna-agent-turn-id':randomUUID()}]){
    const r=await fetch(`${f.base}/v1/agent-tools`,{headers:{...headers(f.lease),...patch}});assert.equal(r.status,401);
  }
  const duplicate=await new Promise((resolve,reject)=>{const req=http.request(`${f.base}/v1/agent-tools`,{headers:{...headers(f.lease),authorization:[headers(f.lease).authorization,headers(f.lease).authorization]}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
  assert.equal(duplicate,401);assert.equal(f.docker.calls.length,0);await f.lease.close();
});

test('strict routes, body envelope and business arguments never reach the runner',async t=>{
  const f=await fixture(t);f.lease.activate('run');
  for(const route of ['/v1/agent-tools?x=1','/v1/agent-tools/../agent-tools','//v1/agent-tools','http://elsewhere/v1/agent-tools','/v1/tasks']){
    const status=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:f.server.address().port,path:route,headers:headers(f.lease)},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});assert.equal(status,404,route);
  }
  for(const body of [{arguments:{input:{}},taskContext:identity()},{arguments:{input:{},extra:true}},{arguments:{input:[]}},{arguments:{input:{protocolVersion:'bad'}}},{arguments:{input:{x:'x'.repeat(65536)}}}])assert.equal((await call(f,f.lease,body)).status,400);
  const bad=await fetch(`${f.base}/v1/agent-tools/summarize_target_sequence/call`,{method:'POST',headers:headers(f.lease),body:'{'});assert.equal(bad.status,400);
  const large=await fetch(`${f.base}/v1/agent-tools/summarize_target_sequence/call`,{method:'POST',headers:headers(f.lease),body:'x'.repeat(262145)});assert.equal(large.status,413);
  assert.equal(f.docker.calls.length,0);await f.lease.close();
});

test('close revokes synchronously, drains accepted execution, and reports a minimal terminal event',async t=>{
  const f=await fixture(t);const gate=deferred(),entered=deferred();const events=[];
  const id=identity();const lease=begin(f.leases,{...id,onCall:event=>events.push(event)});lease.activate('actual-run');
  f.docker.runResult=async()=>{entered.resolve();await gate.promise;return f.docker.result;};
  const accepted=call(f,lease);await entered.promise;let closed=false;const closing=lease.close().then(()=>closed=true);
  assert.equal((await call(f,lease)).status,401);assert.equal(closed,false);assert.equal(events.length,0);gate.resolve();
  assert.equal((await accepted).status,200);await closing;await lease.close();
  assert.deepEqual(events,[{type:'approved_tool_call',toolName:'summarize_target_sequence',toolCallId:audit(f)[0].toolCallId,agentRunId:'actual-run',success:true}]);assert.deepEqual(audit(f)[0].taskContext,{...id,agentRunId:'actual-run'});await f.lease.close();
});

test('task abort revokes immediately while accepted work completes cleanup and a canceled audit',async t=>{
  const f=await fixture(t);const gate=deferred(),entered=deferred(),controller=new AbortController();const lease=begin(f.leases,{signal:controller.signal});lease.activate('abort-run');
  f.docker.runResult=async()=>{entered.resolve();await gate.promise;return f.docker.result;};
  const accepted=call(f,lease);await entered.promise;controller.abort();assert.equal((await call(f,lease)).status,401);gate.resolve();
  const result=await accepted;assert.equal(result.body.isError,true);await lease.close();assert.equal(audit(f)[0].cancelled,true);assert.equal(audit(f)[0].cleanupConfirmed,true);await f.lease.close();
});

test('server serializes actual execution across tasks and keeps reservation after client disconnect',async t=>{
  const f=await fixture(t);f.lease.activate('first');const second=begin(f.leases);second.activate('second');
  const gate=deferred(),entered=deferred();f.docker.runResult=async()=>{entered.resolve();await gate.promise;return f.docker.result;};
  const req=http.request(`${f.base}/v1/agent-tools/summarize_target_sequence/call`,{method:'POST',headers:headers(f.lease)});req.on('error',()=>{});req.end(JSON.stringify({arguments:{input:{sequence:'AC'}}}));
  await entered.promise;req.destroy();assert.equal((await call(f,second)).status,409);
  let drained=false;const draining=f.server.waitForCalls().then(()=>drained=true);await new Promise(r=>setImmediate(r));assert.equal(drained,false);
  gate.resolve();await draining;assert.equal(audit(f)[0].success,true);assert.equal(audit(f)[0].cleanupConfirmed,true);
  assert.equal((await call(f,second)).status,200);assert.equal(audit(f).length,2);await Promise.all([f.lease.close(),second.close()]);
});

test('ordinary failures including failed cleanup return fixed error content and retain terminal audit',async t=>{
  const f=await fixture(t);f.lease.activate('failed-run');f.docker.removeFailure=true;
  const result=await call(f);assert.equal(result.status,200);assert.equal(result.body.isError,true);assert.deepEqual(Object.keys(result.body).sort(),['content','isError']);
  assert.equal(JSON.stringify(result.body).includes(f.root),false);assert.equal(audit(f)[0].success,false);assert.equal(audit(f)[0].cleanupConfirmed,false);await f.lease.close();
});

test('lease identities and activation are strict; restart and old turns cannot authorize',async()=>{
  assert.equal(typeof leasesApi.createToolCallLeases,'function');const leases=leasesApi.createToolCallLeases();
  for(const patch of [{taskId:'bad'},{executionSessionId:'bad'},{sandboxId:'bad'},{agentTurnId:'bad'}])assert.throws(()=>begin(leases,patch));
  const lease=begin(leases);assert.match(lease.context.token,/^[a-f0-9]{64}$/);assert.equal(lease.context.protocolVersion,'sirna-task-context/v1');
  assert.throws(()=>lease.activate('../wrong'));lease.activate('real-run');assert.throws(()=>lease.activate('different-run'));await lease.close();assert.throws(()=>lease.activate('real-run'));
});

test('streamed oversized request receives a bounded rejection without executing',async t=>{
  const f=await fixture(t);f.lease.activate('streamed-run');
  const result=await new Promise((resolve,reject)=>{
    const req=http.request(`${f.base}/v1/agent-tools/summarize_target_sequence/call`,{method:'POST',headers:{...headers(f.lease),'transfer-encoding':'chunked'}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,text}));});
    req.on('error',reject);req.write('x'.repeat(262144));req.end('x');
  });
  assert.equal(result.status,413);assert.ok(result.text.length<128);assert.equal(f.docker.calls.length,0);await f.lease.close();
});
