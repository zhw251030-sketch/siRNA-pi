import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentComposeRuntime} from '../packages/agent-runtime/agent-compose-runtime.mjs';
import {ComposeSessionStore} from '../packages/agent-runtime/compose-session-store.mjs';
import {createComposeExecutor} from '../packages/agent-runtime/compose-executor.mjs';
import {spawnSync} from 'node:child_process';

test('curator guard empties declared tools and blocks every tool at execution', async () => {
  const {default:guard}=await import('../containers/agent-compose-guest/curator-guard.mjs');
  const hooks=new Map();let active;
  guard({on:(name,hook)=>hooks.set(name,hook),setActiveTools:names=>{active=names;}});
  await hooks.get('session_start')({},{});assert.deepEqual(active,[]);
  for(const toolName of ['read','write','bash','mcp','arbitrary']) {
    let aborted=false;const result=await hooks.get('tool_call')({toolName,input:{}},{abort(){aborted=true;}});
    assert.equal(result.block,true);assert.equal(result.terminate,true);assert.equal(aborted,true);assert.ok(result.reason);
  }
});

test('fixed roles isolate stores and reject foreign metadata, preserving legacy designer', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'curator-role-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const designer=new AgentComposeRuntime({root}),curator=new AgentComposeRuntime({root,agentName:'tool-curator'});
  const d=await designer.create(),c=await curator.create();
  assert.equal(designer.owns(c.id),false);assert.equal(curator.owns(d.id),false);
  assert.equal(c.agentName,'tool-curator');assert.equal(d.agentName,'designer');
  assert.ok(fs.existsSync(path.join(root,'runtime/tool-curation/sessions',`${c.id}.json`)));
  assert.throws(()=>new ComposeSessionStore(root,{agentName:'other'}),/role/i);
  const foreign=path.join(root,'runtime/compose-sessions',`${c.id}.json`);
  fs.copyFileSync(curator.store.file(c.id),foreign);assert.throws(()=>designer.store.load(c.id),/role/i);
  assert.equal(designer.owns(c.id),false);
  delete d.agentName;fs.writeFileSync(designer.store.file(d.id),JSON.stringify(d));assert.equal(designer.store.load(d.id).id,d.id);
  delete c.agentName;fs.writeFileSync(curator.store.file(c.id),JSON.stringify(c));assert.throws(()=>curator.store.load(c.id),/role/i);
  assert.throws(()=>new AgentComposeRuntime({root,agentName:'tool-curator',toolCallLeases:{}}),/curator|lease/i);
});

function fakeRuntime({events=[],persisted={},removeError,runError,hang=false}={}) {
  const sessionId=randomUUID(),runId=randomUUID();const order=[];
  return {sessionId,runId,order,agentName:'tool-curator',
    async create(){order.push('create');return {id:sessionId};},
    async run(request,emit,signal){order.push('run');assert.equal(request.sessionId,sessionId);assert.equal(request.prepareWorkspace,undefined);
      emit({type:'session',runId});
      if(hang)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
      for(const event of events)emit(event);
      if(runError)throw runError;
    },
    async status(){return {id:sessionId,runs:[{runId,accepted:true,status:'succeeded',modelResponses:1,toolCalls:0,...persisted}]};},
    async remove(id){assert.equal(id,sessionId);order.push('remove');if(removeError)throw removeError;return {id,runtimeReleased:true,status:'stopped'};},
  };
}
const review={id:randomUUID(),traceSha256:'a'.repeat(64),trace:{signals:[],existingTools:[]}};
const output=JSON.stringify({protocolVersion:'sirna-tool-curation-result/v1',curationId:review.id,traceSha256:review.traceSha256,decision:'skip',summary:'No stable boundary.'});
function goodEvents(){return [{type:'assistant_message',text:output},{type:'done',status:'succeeded'}];}

test('curator persists identity before submission and returns only validated successful single response after release',async()=>{
  const {createAgentToolCurator}=await import('../packages/extensions/tool-curation/agent-tool-curator.mjs');
  const runtime=fakeRuntime({events:goodEvents()});const identities=[];
  const response=await createAgentToolCurator({runtime}).curate(review,undefined,(...ids)=>{runtime.order.push('identity');identities.push(ids);});
  assert.deepEqual(runtime.order,['create','identity','run','identity','remove']);
  assert.deepEqual(identities,[[runtime.sessionId],[runtime.sessionId,runtime.runId]]);
  assert.equal(response.runId,runtime.runId);assert.equal(response.result.decision,'skip');assert.equal(response.cleanupConfirmed,true);
});

for(const [name,options,unknown] of [
  ['tool invocation',{events:[{type:'tool_start'},...goodEvents()],persisted:{toolCalls:1}},true],
  ['multiple responses',{events:goodEvents(),persisted:{modelResponses:2}},false],
  ['missing response',{events:goodEvents(),persisted:{modelResponses:0}},false],
  ['missing done',{events:[{type:'assistant_message',text:output}]},true],
  ['failed done',{events:[{type:'done',status:'failed'}],persisted:{status:'failed',outcomeUnconfirmed:true}},true],
  ['error event',{events:[{type:'error'},...goodEvents()]},true],
  ['malformed JSON',{events:[{type:'assistant_message',text:'{}'},{type:'done',status:'succeeded'}]},false],
  ['unconfirmed release',{events:goodEvents(),removeError:Error('private cleanup')},false],
])test(`curator fails closed on ${name}, releases and retains identity`,async()=>{
  const {createAgentToolCurator}=await import('../packages/extensions/tool-curation/agent-tool-curator.mjs');
  const runtime=fakeRuntime(options);const ids=[];
  await assert.rejects(createAgentToolCurator({runtime}).curate(review,undefined,(...v)=>ids.push(v)),e=>{
    assert.equal(e.sessionId,runtime.sessionId);assert.equal(e.runId,runtime.runId);
    assert.equal(e.outcomeUnknown===true,unknown);assert.equal(e.cleanupFailed===true,Boolean(options.removeError));
    assert.ok(!e.message.includes('private'));return true;
  });assert.equal(runtime.order.at(-1),'remove');assert.deepEqual(ids.at(-1),[runtime.sessionId,runtime.runId]);
});

test('curator timeout aborts its single attempt and awaits release',async()=>{
  const {createAgentToolCurator}=await import('../packages/extensions/tool-curation/agent-tool-curator.mjs');
  const runtime=fakeRuntime({hang:true});
  await assert.rejects(createAgentToolCurator({runtime,timeoutMs:5}).curate(review),e=>e.outcomeUnknown===true);
  assert.deepEqual(runtime.order,['create','run','remove']);
});

test('executor stages the public profile through existing manager data mount and chooses only fixed curator agent',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'curator-executor-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=fs.readFileSync(new URL('../agent-compose-curator.yml',import.meta.url));fs.writeFileSync(path.join(root,'agent-compose-curator.yml'),source);
  const calls=[];const sandbox='a'.repeat(64);
  const execute=async(program,args)=>{calls.push([program,args]);return {stdout:JSON.stringify(args.includes('up')?{project:{id:'curator-project'}}:{id:'boot',sandbox_id:sandbox,status:'succeeded',exit_code:0})};};
  const curator=createComposeExecutor(root,{agentName:'tool-curator',execute});
  await curator.up();await curator.bootstrap(()=>{});
  assert.deepEqual(fs.readFileSync(path.join(root,'runtime/agent-compose/data/curator-config/agent-compose.yml')),source);
  assert.deepEqual(calls[0],['sh',[path.join(root,'scripts/project-agent-compose.sh'),'--file','/data/curator-config/agent-compose.yml','up']]);
  assert.deepEqual(calls[1][1].slice(1),['--file','/data/curator-config/agent-compose.yml','run','--detach','--keep-running','tool-curator','--command','mkdir -p /workspace/input /workspace/work /workspace/output /workspace/tool-drafts']);
  assert.throws(()=>createComposeExecutor('/project',{agentName:'arbitrary'}),/role/i);
  fs.unlinkSync(path.join(root,'agent-compose-curator.yml'));
  calls.length=0;await createComposeExecutor(root,{execute}).up();assert.deepEqual(calls[0][1],[path.join(root,'scripts/project-agent-compose.sh'),'up']);
});

test('curator profile staging refuses unknown bytes and non-files before any CLI call',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'curator-profile-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'agent-compose-curator.yml');fs.copyFileSync(new URL('../agent-compose-curator.yml',import.meta.url),source);
  let calls=0;const executor=createComposeExecutor(root,{agentName:'tool-curator',execute:async()=>{calls++;return {stdout:'{}'};}});
  await executor.up();const target=path.join(root,'runtime/agent-compose/data/curator-config/agent-compose.yml');
  fs.writeFileSync(target,'unrecognized configuration');await assert.rejects(executor.up(),/config|profile/i);assert.equal(fs.readFileSync(target,'utf8'),'unrecognized configuration');assert.equal(calls,1);
  fs.unlinkSync(target);fs.unlinkSync(source);fs.mkdirSync(source);await assert.rejects(executor.up(),/config|profile/i);assert.equal(calls,1);
});
test('curator profile staging rejects linked directories without touching their target',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'curator-profile-link-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.copyFileSync(new URL('../agent-compose-curator.yml',import.meta.url),path.join(root,'agent-compose-curator.yml'));
  const external=path.join(root,'unrelated');fs.mkdirSync(external);
  const parent=path.join(root,'runtime/agent-compose/data');fs.mkdirSync(parent,{recursive:true});
  fs.symlinkSync(external,path.join(parent,'curator-config'),process.platform==='win32'?'junction':'dir');
  let calls=0;const executor=createComposeExecutor(root,{agentName:'tool-curator',execute:async()=>{calls++;return {stdout:'{}'};}});
  await assert.rejects(executor.up());assert.equal(calls,0);assert.deepEqual(fs.readdirSync(external),[]);
});

test('curator wrapper preserves runner arguments then overrides tool exposure and loads guard explicitly',{skip:process.platform==='win32'?'POSIX wrapper execution is verified on Linux':false},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'curator-wrapper-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const wrapper=fs.readFileSync(new URL('../containers/agent-compose-guest/pi-curator.sh',import.meta.url),'utf8');
  const capture=path.join(root,'capture.mjs');fs.writeFileSync(capture,'console.log(JSON.stringify(process.argv.slice(2)))');
  const settings=path.join(root,'settings.json');fs.writeFileSync(settings,'{}');
  const state=path.join(root,'state');
  const script=path.join(root,'pi.sh');fs.writeFileSync(script,wrapper.replaceAll('/root/.pi/agent',state).replaceAll('/opt/sirna-pi/settings.json',settings).replace('/usr/bin/node',process.execPath).replace('/opt/sirna-pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',capture));
  const result=spawnSync('sh',[script,'--model','agent-compose/MiniMax-M3','--tools','read','--session-dir','/sessions','untrusted prompt'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const args=JSON.parse(result.stdout);
  assert.deepEqual(args.slice(0,7),['--model','agent-compose/MiniMax-M3','--tools','read','--session-dir','/sessions','untrusted prompt']);
  const {parseArgs}=await import('../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js');
  const parsed=parseArgs(args);assert.equal(parsed.noTools,true);assert.deepEqual(parsed.excludeTools,['*']);
  assert.equal(parsed.noExtensions,true);assert.equal(parsed.noMcp,true);assert.deepEqual(parsed.extensions,['/opt/sirna-pi/curator-guard.mjs']);
  assert.deepEqual(parsed.messages,['untrusted prompt']);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state,'settings.json'),'utf8')),{});
});

test('real curator runtime sends only frozen prompt, creates no sample, and logs in its own namespace',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'curator-dispatch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const sandbox='b'.repeat(64),workspace_path=`/data/sandboxes/2026/10/21/${sandbox}/workspace`;
  const workspace=path.join(root,'runtime/agent-compose',workspace_path);fs.mkdirSync(workspace,{recursive:true});
  let sent;
  const executor={up:async()=>({project:{id:'curator-project'}}),bootstrap:async cb=>cb({id:'boot',sandbox_id:sandbox,status:'succeeded'}),inspectSandbox:async()=>({sandbox_id:sandbox,workspace_path,driver:'docker'})};
  const rpc={hasActiveRuns:async()=>false,run:async(request,callbacks)=>{sent=request;await callbacks.onStarted({runId:'curator-run',sandboxId:sandbox});throw Error('synthetic stop');}};
  const runtime=new AgentComposeRuntime({root,agentName:'tool-curator',executor,rpc});const s=await runtime.create();const events=[];
  await runtime.run({sessionId:s.id,message:'frozen trace only'},e=>events.push(e));
  assert.equal(sent.agentName,'tool-curator');assert.equal(sent.prompt,'frozen trace only');
  assert.equal(fs.existsSync(path.join(workspace,'input/numbers.csv')),false);
  assert.match((await runtime.status(s.id)).eventLogPath,/^runtime\/tool-curation\/events\//);
  assert.equal(events.at(-1).status,'failed');
  await assert.rejects(runtime.run({sessionId:s.id,message:'bad',prepareWorkspace:async()=>[]},()=>{}),/hydration/);
});

test('pre-dispatch failure never records a provisional runtime ID as a daemon run identity',async()=>{
  const {createAgentToolCurator}=await import('../packages/extensions/tool-curation/agent-tool-curator.mjs');
  const runtime=fakeRuntime();const provisional=randomUUID(),ids=[];
  runtime.run=async(request,emit)=>{runtime.order.push('run');emit({type:'error',runId:provisional});emit({type:'done',runId:provisional,status:'failed'});};
  runtime.status=async()=>({runs:[{runId:provisional,status:'failed'}]});
  await assert.rejects(createAgentToolCurator({runtime}).curate(review,undefined,(...v)=>ids.push(v)));
  assert.deepEqual(ids,[[runtime.sessionId]]);
});
test('accepted identity saved by runtime remains recoverable when its first callback throws',async()=>{
  const {createAgentToolCurator}=await import('../packages/extensions/tool-curation/agent-tool-curator.mjs');
  const runtime=fakeRuntime();const ids=[];
  runtime.run=async()=>{throw Error('event persistence interrupted');};
  runtime.status=async()=>({runs:[{runId:runtime.runId,accepted:true,status:'failed',outcomeUnconfirmed:true}]});
  await assert.rejects(createAgentToolCurator({runtime}).curate(review,undefined,(...v)=>ids.push(v)),e=>e.outcomeUnknown===true);
  assert.deepEqual(ids,[[runtime.sessionId],[runtime.sessionId,runtime.runId]]);
});

test('installed Pi loads the explicit guard despite noExtensions and blocks undeclared calls without a model',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'curator-pi-guard-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime}=await import('@earendil-works/pi-coding-agent');
  const settingsManager=SettingsManager.inMemory({cacheWarming:'off',retry:{enabled:false},compaction:{enabled:false},enableInstallTelemetry:false,enableAnalytics:false});
  const guard=path.resolve('containers/agent-compose-guest/curator-guard.mjs');
  const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager,noExtensions:true,disabledBuiltinExtensions:['mcp'],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[guard]});
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  const modelRuntime=await ModelRuntime.create({authPath:path.join(root,'auth.json'),modelsPath:path.join(root,'models.json'),modelsStorePath:path.join(root,'models-store.json'),allowModelNetwork:false,refreshOnCreate:false});
  const model={id:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://127.0.0.1:0',reasoning:false,input:['text'],contextWindow:8192,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const {session}=await createAgentSession({cwd:root,agentDir:root,modelRuntime,model,resourceLoader:loader,settingsManager,noTools:'all',excludeTools:['*'],sessionManager:SessionManager.inMemory(root)});
  try {await session.bindExtensions({});assert.deepEqual(session.getActiveToolNames(),[]);
    for(const toolName of ['read','mcp','unknown'])assert.equal((await session.extensionRunner.emitToolCall({type:'tool_call',toolCallId:'blocked-'+toolName,toolName,input:{}})).block,true);
    // A deliberately signal-ignoring fake catches local loop continuation,
    // independently of transport cancellation and the host's delayed stop.
    let requests=0,toolStarts=0;
    session.subscribe(event=>{if(event.type==='tool_execution_start')toolStarts++;});
    session.agent.streamFunction=()=>{
      requests++;
      const message={role:'assistant',content:requests===1?[{type:'toolCall',id:'unknown-call',name:'read',arguments:{path:'secret'}}]:[{type:'text',text:'skip'}],stopReason:requests===1?'toolUse':'stop',provider:'fake',model:'fake',api:'openai-completions',timestamp:0,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      return {async *[Symbol.asyncIterator](){yield {type:'done',message};},result:async()=>message};
    };
    await session.agent.prompt('frozen synthetic fixture');
    assert.equal(requests,1,'unknown tool must never cause a second provider dispatch');
    assert.equal(toolStarts,0,'tool intent must stop locally before tool execution');
    const response=session.messages.find(message=>message.role==='assistant');assert.equal(response.stopReason,'aborted');assert.equal(response.content[0].name,'read');
  }finally{await session.extensionRunner?.emit({type:'session_shutdown'});session.dispose();}
});
