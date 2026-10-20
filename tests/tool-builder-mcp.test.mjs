import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createToolBuildSessionService} from '../packages/capability-platform/tool-build-sessions.mjs';
import {BuildDocker,COMMAND,proposal,removeBuildTestRoot} from './helpers/tool-build-docker.mjs';
const api=await import('../apps/mcp/tool-builder-server.mjs').catch(()=>({}));
async function connect(t){assert.equal(typeof api.createToolBuilderMcpServer,'function','dedicated six-tool host adapter exists');const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-mcp-builder-')));const docker=new BuildDocker();const service=createToolBuildSessionService({root,docker});const server=api.createToolBuilderMcpServer({service});const client=new Client({name:'builder-test',version:'1.0.0'});const [a,b]=InMemoryTransport.createLinkedPair();t.after(async()=>{try{await client.close();await server.close();}finally{removeBuildTestRoot(root);}});await server.connect(b);await client.connect(a);return {client,server,service,docker,root};}
const result=r=>JSON.parse(r.content[0].text);
test('literal six MCP contracts execute complete real filesystem and registry submission',async t=>{
 const {client}=await connect(t);const tools=(await client.listTools()).tools;assert.deepEqual(tools.map(t=>t.name),['create_tool_build_session','write_tool_build_file','run_tool_build_command','cancel_tool_build_session','finalize_tool_build','propose_exploration_tool']);assert.deepEqual(tools[1].inputSchema.required,['sessionId','path','content']);assert.deepEqual(tools[2].inputSchema.required,['sessionId','command']);assert.equal(tools[4].inputSchema.properties.command.type,'array');assert.ok(tools[5].inputSchema.required.includes('runtimeArtifact'));assert.equal(tools[5].inputSchema.properties.input,undefined);
 const call=async(name,args)=>{const response=await client.callTool({name,arguments:args});assert.notEqual(response.isError,true,JSON.stringify(response));return result(response);};
 const id=(await call('create_tool_build_session',{})).session.id;const p=proposal();await call('write_tool_build_file',{sessionId:id,path:'/opt/tool/main.mjs',content:p.script});await call('run_tool_build_command',{sessionId:id,command:'true'});const finalized=await call('finalize_tool_build',{sessionId:id,command:COMMAND});const saved=await call('propose_exploration_tool',{...p,runtimeArtifact:finalized.artifact});assert.equal(saved.state,'submitted');assert.equal(saved.verified,false);assert.equal(saved.approved,false);assert.equal(saved.activated,false);const id2=(await call('create_tool_build_session',{})).session.id;assert.equal((await call('cancel_tool_build_session',{sessionId:id2})).cleanupConfirmed,true);
});
test('MCP safe errors reject invalid JSON bounds, unknown tool and host diagnostics',async t=>{
 const {client,docker}=await connect(t);for(const [name,args]of [['unknown',{}],['create_tool_build_session',{extra:'sensitive-marker'}],['create_tool_build_session',{x:'x'.repeat(1048577)}]]){const response=await client.callTool({name,arguments:args});assert.equal(response.isError,true);assert.doesNotMatch(JSON.stringify(response),/sensitive-marker|\/host\/diagnostic/);}
 docker.failAt='inspectImage';const response=await client.callTool({name:'create_tool_build_session',arguments:{}});assert.equal(response.isError,true);assert.doesNotMatch(JSON.stringify(response),/\/host\/diagnostic/);
});
test('host CLI guard runs in explicit temporary cwd and leaves no project runtime',()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-builder-cli-')));try{const cli=fileURLToPath(new URL('../scripts/tool-builder-mcp.mjs',import.meta.url));const response=spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8',timeout:10000});assert.equal(response.status,1);assert.equal(response.stdout,'');assert.match(response.stderr,/initialization failed/);assert.deepEqual(fs.readdirSync(root),[]);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('MCP busy refusal and EOF/signal lifecycle drain real accepted build operations',async t=>{
 for(const event of ['end','SIGTERM']){
  const {client,server,docker}=await connect(t);let release,entered;const ready=new Promise(r=>entered=r);const start=docker.startContainer.bind(docker);
  docker.startContainer=async id=>{entered();await new Promise(r=>release=r);return start(id);};
  const call=client.callTool({name:'create_tool_build_session',arguments:{}});await ready;const busy=await client.callTool({name:'create_tool_build_session',arguments:{}});assert.equal(busy.isError,true);assert.match(busy.content[0].text,/busy/);
  const input=new EventEmitter(),signals=new EventEmitter();let failure;const stop=api.installToolBuilderShutdown(server,{input,signals,onFailure:e=>failure=e});(event==='end'?input:signals).emit(event);assert.equal(docker.containers.size,1);release();assert.notEqual((await call).isError,true);await stop();assert.equal(failure,undefined);assert.equal(docker.containers.size,0);assert.equal(input.listenerCount('end'),0);assert.equal(signals.listenerCount('SIGTERM'),0);
 }
});
