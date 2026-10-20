import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import fs from 'node:fs';
import path from 'node:path';
import {approvalFixture,writable} from './helpers/approval-fixture.mjs';
import {DockerBoundary} from './helpers/validation-docker-boundary.mjs';
import {approveRegisteredToolProposal} from '../packages/capability-platform/tool-approval-service.mjs';
import {discoverApprovedTools} from '../packages/capability-platform/tool-approved-execution.mjs';
import {createDockerValidationRunner} from '../packages/capability-platform/tool-validation-runner.mjs';
import * as api from '../apps/mcp/approved-server.mjs';
const descriptor=execute=>({name:'summarize_target_sequence',label:'Summarize sequence',description:'An approved sequence summary.',
  parameters:{type:'object',properties:{input:{type:'object'}},required:['input'],additionalProperties:false},
  executionMode:'sequential',execute});
async function connect(t,discover){
  assert.equal(typeof api.createApprovedMcpServer,'function','host MCP adapter must exist');
  const server=api.createApprovedMcpServer({discover});
  const client=new Client({name:'approved-tool-contract-test',version:'1.0.0'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});
  await server.connect(b);await client.connect(a);return client;
}
test('host MCP discovers changing descriptors and retains the real fixed tool',async t=>{
  let enabled=false;
  const client=await connect(t,()=>({tools:enabled?[descriptor(async()=>({content:[]}))]:[],packages:[],rejected:[]}));
  assert.deepEqual((await client.listTools()).tools.map(x=>x.name),['enumerate_sirna_candidates']);
  enabled=true;const tools=(await client.listTools()).tools;
  assert.deepEqual(tools.map(x=>x.name),['enumerate_sirna_candidates','summarize_target_sequence']);
  assert.deepEqual(tools[1].inputSchema.required,['input']);
  assert.deepEqual(tools[1].annotations,{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false});
  const fixed=await client.callTool({name:'enumerate_sirna_candidates',arguments:{targetSequence:'A'.repeat(21)}});
  assert.equal(JSON.parse(fixed.content[0].text).candidates[0].guide,'U'.repeat(21));
  enabled=false;assert.equal((await client.callTool({name:'summarize_target_sequence',arguments:{input:{}}})).isError,true);
});
test('MCP forwards business arguments with platform call ID and only returns public content',async t=>{
  let observed;
  const client=await connect(t,()=>({tools:[descriptor(async(id,args,signal)=>{
    observed={id,args,signal};return {content:[{type:'text',text:'{"length":2,"gcFraction":0.5}'}],
      details:{auditPath:'/private/audit.json',packageSha256:'private-hash',output:{length:2}}};
  })],packages:[],rejected:[]}));
  const result=await client.callTool({name:'summarize_target_sequence',arguments:{input:{sequence:'AC'}}});
  assert.deepEqual(result,{content:[{type:'text',text:'{"length":2,"gcFraction":0.5}'}]});
  assert.deepEqual(observed.args,{input:{sequence:'AC'}});
  assert.match(observed.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(typeof observed.signal.aborted,'boolean');
});
test('MCP accepts short names allowed by the proposal contract',async t=>{
  const client=await connect(t,()=>({tools:[{...descriptor(async()=>({content:[{type:'text',text:'{}'}]})),name:'a'}],rejected:[]}));
  assert.equal((await client.listTools()).tools.at(-1).name,'a');
  assert.notEqual((await client.callTool({name:'a',arguments:{input:{}}})).isError,true);
});
test('MCP carries a valid 64KiB business result even when transport JSON escapes it again',async t=>{
  const output=JSON.stringify({x:'\\'.repeat(32760)});assert.ok(Buffer.byteLength(output)<=65536);
  const client=await connect(t,()=>({tools:[descriptor(async()=>({content:[{type:'text',text:output}]}))],rejected:[]}));
  const result=await client.callTool({name:'summarize_target_sequence',arguments:{input:{}}});
  assert.notEqual(result.isError,true);assert.equal(result.content[0].text,output);
});
test('rejected discovery and name collisions fail visibly instead of hiding registered tools',async t=>{
  let mode='rejected';
  const client=await connect(t,()=>mode==='rejected'?{tools:[],rejected:[{error:'/private/corrupted.json'}]}:
    {tools:[{...descriptor(async()=>({content:[]})),name:'enumerate_sirna_candidates'}],rejected:[]});
  await assert.rejects(client.listTools(),/unavailable/i);
  mode='collision';await assert.rejects(client.listTools(),/collision/i);
  const result=await client.callTool({name:'summarize_target_sequence',arguments:{input:{}}});
  assert.equal(result.isError,true);assert.equal(JSON.stringify(result).includes('/private'),false);
});
test('tool failures and invalid results return errors without host diagnostics',async t=>{
  let mode='throw';
  const client=await connect(t,()=>({tools:[descriptor(async()=>{
    if(mode==='throw')throw new Error('secret /private/audit.json');
    return {content:[{type:'image',data:'private',mimeType:'image/png'}],details:{secret:true}};
  })],rejected:[]}));
  for(const value of ['throw','invalid']){
    mode=value;const result=await client.callTool({name:'summarize_target_sequence',arguments:{input:{}}});
    assert.equal(result.isError,true);assert.doesNotMatch(JSON.stringify(result),/private|secret/);
  }
  assert.equal((await client.callTool({name:'unknown',arguments:{}})).isError,true);
  assert.equal((await client.callTool({name:'enumerate_sirna_candidates',arguments:{targetSequence:'AC'}})).isError,true);
});
test('overlapping approved calls are refused and the slot is released after completion',async t=>{
  let started,finish;const entered=new Promise(resolve=>{started=resolve;});const gate=new Promise(resolve=>{finish=resolve;});let count=0;
  const client=await connect(t,()=>({tools:[descriptor(async()=>{count++;started();await gate;return {content:[{type:'text',text:'{}'}]};})],rejected:[]}));
  const first=client.callTool({name:'summarize_target_sequence',arguments:{input:{}}});await entered;
  const second=await client.callTool({name:'summarize_target_sequence',arguments:{input:{}}});
  assert.equal(second.isError,true);assert.match(second.content[0].text,/busy/i);assert.equal(count,1);
  finish();assert.notEqual((await first).isError,true);
  assert.notEqual((await client.callTool({name:'summarize_target_sequence',arguments:{input:{}}})).isError,true);assert.equal(count,2);
});
test('real registered discovery, MCP arguments and execution audit connect without exposing host paths',async t=>{
  const f=await approvalFixture(t);const approved=approveRegisteredToolProposal(f.id,'MCP integration test',{root:f.root});
  const docker=new DockerBoundary({manifest:f.saved.proposal,input:f.input});docker.result.stdout='{"length":2,"gcFraction":0.5}';
  const runner=createDockerValidationRunner({docker,purpose:'approved-call'});
  const client=await connect(t,()=>discoverApprovedTools({root:f.root,runner}));
  assert.equal((await client.listTools()).tools.at(-1).name,'summarize_target_sequence');
  for(const args of [{sequence:'AC'},{input:{sequence:'AC'},outputFiles:[]},{input:{sequence:'AC'},toolCallId:'client-supplied'}]){
    assert.equal((await client.callTool({name:'summarize_target_sequence',arguments:args})).isError,true);
  }
  assert.equal(docker.calls.length,0);assert.equal(fs.existsSync(path.join(f.root,'runtime/approved-tool-runs')),false);
  const result=await client.callTool({name:'summarize_target_sequence',arguments:{input:{sequence:'AC'}}});
  assert.deepEqual(result,{content:[{type:'text',text:'{"length":2,"gcFraction":0.5}'}]});
  const dir=path.join(f.root,'runtime/approved-tool-runs/summarize_target_sequence');const ids=fs.readdirSync(dir);assert.equal(ids.length,1);
  const audit=JSON.parse(fs.readFileSync(path.join(dir,ids[0],'audit.json')));assert.equal(audit.success,true);assert.equal(audit.packageSha256,approved.version.packageSha256);
  writable(path.join(f.approvedRoot,approved.version.packageDirectory,'tool.mjs'),'changed');
  const before=docker.calls.length;assert.equal((await client.callTool({name:'summarize_target_sequence',arguments:{input:{sequence:'AC'}}})).isError,true);
  assert.equal(docker.calls.length,before);assert.deepEqual(fs.readdirSync(dir),ids);
});
