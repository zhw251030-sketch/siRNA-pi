import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createToolRelay} from '../containers/agent-tools-relay/relay.mjs';
import {createToolBuilderClient} from '../apps/mcp/tool-builder-client.mjs';
import {createApprovedMcpServer} from '../apps/mcp/approved-server.mjs';
import {createToolBuilderTools} from '../packages/domain/sirna-tools/tool-builder-tools.mjs';

const valid={error:{protocolVersion:'sirna-builder-rejection/v1',code:'repair_contract_mismatch',outcome:'not_registered',fields:['parent']}};
const change=patch=>JSON.stringify({error:{...valid.error,...patch}});
// The upstream is intentionally adversarial; HTTP, relay, client and MCP are real.
// Accepting arbitrary error properties/status or omitting strict validation must
// break these tests, and no private string may reach the model-facing result.
const invalid=[
  ['ordinary error text',{body:'private /host/secret-token'}],
  ['malformed JSON',{body:'{"error":'}],
  ['invalid UTF8',{body:Buffer.from([0xc3,0x28])}],
  ['wrong content type',{body:JSON.stringify(valid),contentType:'text/plain'}],
  ['missing version',{body:change({protocolVersion:undefined})}],
  ['unknown version',{body:change({protocolVersion:'sirna-builder-rejection/v999'})}],
  ['unknown code',{body:change({code:'private-secret-token'})}],
  ['unknown outcome',{body:change({outcome:'registered'})}],
  ['extra diagnostic',{body:change({message:'private /host/secret-token'})}],
  ['extra envelope member',{body:JSON.stringify({...valid,trace:'/host/secret-token'})}],
  ['empty fields',{body:change({fields:[]})}],
  ['unknown field',{body:change({fields:['/host/secret-token']})}],
  ['duplicate field',{body:change({fields:['parent','parent']})}],
  ['non-array fields',{body:change({fields:'parent'})}],
  ['null envelope',{body:'null'}],
  ['oversized declared rejection',{body:JSON.stringify(valid)+' '.repeat(2049),declared:true}],
  ['oversized chunked rejection',{body:JSON.stringify(valid)+' '.repeat(2049)}],
  ['server failure with valid-looking envelope',{status:500,body:JSON.stringify(valid)}],
  ['success-status error envelope',{status:201,body:JSON.stringify(valid)}],
  ['timeout',{timeout:true}],
  ['timeout during rejection body',{stall:true}],
];

for(const throughRelay of [false,true])test(`${throughRelay?'relay':'direct'} HTTP rejection boundary preserves unknown outcomes through actual MCP`,async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-rejection-'))),contextPath=path.join(root,'context.json');
  fs.writeFileSync(contextPath,JSON.stringify({protocolVersion:'sirna-task-context/v1',taskId:randomUUID(),agentTurnId:randomUUID(),token:'a'.repeat(64)}));
  let response={body:JSON.stringify(valid)},requests=0;
  const upstream=http.createServer(async(req,res)=>{
    for await(const _chunk of req){}requests++;const r=response;
    if(r.timeout)return;
    res.writeHead(r.status??409,{'content-type':r.contentType??'application/json',...(r.declared?{'content-length':Buffer.byteLength(r.body)}:{})});
    if(r.stall){res.write('{"error":');return;}res.end(r.body);
  });
  const socketPath=process.platform==='win32'?`\\\\.\\pipe\\sirna-rejection-${randomUUID()}`:path.join(root,'api.sock');
  if(throughRelay)await new Promise(r=>upstream.listen(socketPath,r));else await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const relay=throughRelay?createToolRelay({socketPath,builderTimeoutMs:200}):undefined;
  if(relay)await new Promise(r=>relay.listen(0,'127.0.0.1',r));
  const baseUrl=`http://127.0.0.1:${(relay??upstream).address().port}`;
  const service=createToolBuilderClient({baseUrl,contextPath,timeoutMs:300});
  const mcp=createApprovedMcpServer({discover:async()=>({tools:[],rejected:[]}),builderTools:createToolBuilderTools({service})});
  const client=new Client({name:'error-boundary-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{
    await client.close();await mcp.close();if(relay){relay.closeAllConnections();await new Promise(r=>relay.close(r));}
    upstream.closeAllConnections();await new Promise(r=>upstream.close(r));
    assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));assert.match(path.basename(root),/^sirna-rejection-[A-Za-z0-9]+$/);fs.rmSync(root,{recursive:true});
  });
  await mcp.connect(b);await client.connect(a);
  for(const [name,fixture] of invalid)await t.test(name,async()=>{
    response=fixture;const before=requests;
    const result=await client.callTool({name:'propose_exploration_tool',arguments:{}});
    assert.equal(result.isError,true);
    assert.equal(result.content[0].text,'Tool builder call failed; an accepted operation may have completed. Inspect the host records before retrying.');
    assert.doesNotMatch(JSON.stringify(result),/secret-token|\/host\/|not_registered|repair_contract_mismatch/);
    assert.equal(requests-before,1,'a failure must never replay the request');
  });
  await t.test('a valid refusal on another operation stays unknown',async()=>{
    response={body:JSON.stringify(valid)};
    const result=await client.callTool({name:'create_tool_build_session',arguments:{}});assert.equal(result.isError,true);
    assert.match(result.content[0].text,/accepted operation may have completed/);assert.doesNotMatch(result.content[0].text,/not_registered/);
  });
});
