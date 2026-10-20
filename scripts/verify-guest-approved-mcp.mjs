// Acceptance test: disposable Docker guest only. Real Pi 1.2.0 resource loader,
// real patched pi-mcp-adapter 2.11.0, real stdio remote MCP, local HTTP fixture.
// Never call session.prompt, a model provider, the registry, or Docker from here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root='/opt/sirna-pi';
assert.equal(process.argv.length,2,'This check takes no arguments');
assert.ok(fs.existsSync('/.dockerenv'),'Run this check only in a disposable Docker guest');
assert.equal(JSON.parse(fs.readFileSync(`${root}/package.json`,'utf8')).name,'sirna-pi');
assert.equal(JSON.parse(fs.readFileSync(`${root}/node_modules/@earendil-works/pi-coding-agent/package.json`,'utf8')).version,'1.2.0');
const adapter='/usr/local/share/agent-compose/pi-mcp-adapter';
assert.equal(JSON.parse(fs.readFileSync(`${adapter}/package.json`,'utf8')).version,'2.11.0');
const contextPath='/workspace/.sirna-task-context.json';
assert.equal(fs.existsSync(contextPath),false,'Use a disposable guest with no existing task context');
const cwd=fs.mkdtempSync('/workspace/approved-mcp-check-');
const agentDir=path.join(cwd,'agent');fs.mkdirSync(agentDir,{mode:0o700});
const context={protocolVersion:'sirna-task-context/v1',taskId:randomUUID(),agentTurnId:randomUUID(),token:randomBytes(32).toString('hex')};
fs.writeFileSync(contextPath,JSON.stringify(context),{flag:'wx',mode:0o600});
Object.assign(process.env,{PI_CODING_AGENT_DIR:agentDir,PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',PI_TELEMETRY:'0'});

let enabled=false,session,unsubscribeErrors;
const counters={lists:0,calls:0,authRejected:0,unexpected:0};
const extensionErrors=[];
const descriptor={name:'summarize_target_sequence',label:'Fixture sequence summary',
  description:'No-model acceptance fixture: summarize the supplied target sequence.',
  inputSchema:{type:'object',properties:{input:{type:'object',properties:{sequence:{type:'string'}},required:['sequence'],additionalProperties:false}},required:['input'],additionalProperties:false}};
function send(res,status,value){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}
const fixture=http.createServer(async(req,res)=>{
  try{
    const expected={authorization:`Bearer ${context.token}`,'x-sirna-task-id':context.taskId,'x-sirna-agent-turn-id':context.agentTurnId};
    for(const [name,value] of Object.entries(expected)){
      let count=0;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)count++;
      if(count!==1||req.headers[name]!==value){counters.authRejected++;send(res,401,{error:'Unauthorized fixture request'});return;}
    }
    if(req.method==='GET'&&req.url==='/v1/agent-tools'){
      counters.lists++;send(res,200,{tools:enabled?[descriptor]:[]});return;
    }
    if(req.method==='POST'&&req.url==='/v1/agent-tools/summarize_target_sequence/call'){
      if(!enabled){counters.unexpected++;send(res,404,{error:'Fixture tool disabled'});return;}
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>262144){send(res,413,{error:'Fixture body too large'});return;}chunks.push(chunk);}
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')),{arguments:{input:{sequence:'ACGT'}}});
      counters.calls++;send(res,200,{content:[{type:'text',text:'{"length":4,"gcFraction":0.5}'}]});return;
    }
    counters.unexpected++;send(res,404,{error:'Unknown fixture route'});
  }catch{counters.unexpected++;send(res,400,{error:'Invalid fixture request'});}
});
fixture.requestTimeout=10000;fixture.headersTimeout=10000;

let summary;
try{
  await new Promise((resolve,reject)=>{fixture.once('error',reject);fixture.listen(0,'127.0.0.1',resolve);});
  const baseUrl=`http://127.0.0.1:${fixture.address().port}`;
  const launchLog=path.join(cwd,'remote-launches.jsonl');
  const probePath=path.join(cwd,'launch-probe.mjs');
  // A preload records only process identity, so the production remote-server
  // entrypoint remains unchanged and reconnection cannot pass unnoticed.
  fs.writeFileSync(probePath,`import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(launchLog)},JSON.stringify({pid:process.pid})+'\\n',{mode:0o600});\n`,{flag:'wx',mode:0o600});
  const configPath=path.join(cwd,'compose-mcp.json');
  fs.writeFileSync(configPath,JSON.stringify({settings:{sampling:false,elicitation:false,outputGuard:true,toolPrefix:'server',requestTimeoutMs:10000},
    mcpServers:{'sirna-tools':{command:'/usr/bin/node',args:['--import',pathToFileURL(probePath).href,`${root}/apps/mcp/remote-server.mjs`],
      env:{SIRNA_APPROVED_TOOLS_URL:baseUrl},lifecycle:'lazy',exposeResources:false}}}),{flag:'wx',mode:0o600});
  process.argv.push('--mcp-config',configPath);
  const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime}=await import('@earendil-works/pi-coding-agent');
  const settingsManager=SettingsManager.inMemory({cacheWarming:'off',retry:{enabled:false},compaction:{enabled:false},enableInstallTelemetry:false,enableAnalytics:false});
  const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager,noExtensions:true,disabledBuiltinExtensions:['mcp'],
    noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[`${adapter}/index.ts`]});
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[],'Real adapter failed to load');
  loader.getExtensions().runtime.flagValues.set('mcp-config',configPath);
  const modelRuntime=await ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:path.join(agentDir,'models.json'),
    modelsStorePath:path.join(agentDir,'models-store.json'),allowModelNetwork:false,refreshOnCreate:false});
  ({session}=await createAgentSession({cwd,agentDir,modelRuntime,resourceLoader:loader,settingsManager,
    tools:['read','write','mcp'],sessionManager:SessionManager.inMemory(cwd)}));
  unsubscribeErrors=session.extensionRunner.onError(error=>extensionErrors.push(error));
  await session.bindExtensions({});
  assert.deepEqual(session.getActiveToolNames().sort(),['mcp','read','write']);
  const mcp=session.agent.state.tools.find(tool=>tool.name==='mcp');assert.ok(mcp,'MCP gateway is active');
  const call=params=>mcp.execute(randomUUID(),params,AbortSignal.timeout(15000));
  const fixed='sirna_tools_enumerate_sirna_candidates',dynamic='sirna_tools_summarize_target_sequence';
  const connected=await call({connect:'sirna-tools'});
  assert.deepEqual(connected.details?.tools,[fixed],'Initial connection must expose only the fixed tool');
  assert.deepEqual((await call({server:'sirna-tools'})).details?.tools,[fixed]);
  const initialLaunches=fs.readFileSync(launchLog,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(initialLaunches.length,1,'Exactly one real stdio MCP process started');

  enabled=true;
  // describe reads the adapter metadata without invoking search/list refresh.
  // Appearance here proves the MCP notification updated the existing cache.
  const deadline=Date.now()+10000;let described;
  do{described=await call({describe:dynamic});if(described.details?.tool?.name===dynamic)break;await delay(100);}while(Date.now()<deadline);
  assert.equal(described.details?.tool?.name,dynamic,'listChanged did not refresh the connected adapter');
  const search=await call({search:'summarize_target_sequence'});
  assert.deepEqual(search.details?.matches,[{server:'sirna-tools',tool:dynamic}]);
  assert.deepEqual((await call({server:'sirna-tools'})).details?.tools,[fixed,dynamic]);
  const result=await call({tool:dynamic,args:JSON.stringify({input:{sequence:'ACGT'}})});
  assert.equal(result.details?.error,undefined,'Real MCP call returned an error');
  const texts=result.content.filter(item=>item.type==='text').map(item=>item.text);
  assert.equal(texts.length,1);assert.deepEqual(JSON.parse(texts[0]),{length:4,gcFraction:0.5});assert.equal(counters.calls,1);

  enabled=false;
  assert.deepEqual((await call({server:'sirna-tools'})).details?.tools,[fixed]);
  const rejected=await call({tool:dynamic,args:JSON.stringify({input:{sequence:'ACGT'}})});
  assert.ok(rejected.details?.error,'A removed tool must fail explicitly');assert.match(JSON.stringify(rejected.content),/not found|unknown/i);
  assert.equal(counters.calls,1,'Removed tool must not reach fixture execution');
  assert.deepEqual(fs.readFileSync(launchLog,'utf8').trim().split('\n').map(line=>JSON.parse(line)),initialLaunches,'Refresh restarted the MCP connection');
  assert.equal(counters.authRejected,0);assert.equal(counters.unexpected,0);assert.ok(counters.lists>=4);
  assert.deepEqual(extensionErrors,[],'Pi extension runtime reported an error');assert.deepEqual(loader.getExtensions().errors,[]);
  summary={passed:true,piVersion:'1.2.0',adapterVersion:'2.11.0',modelCalls:0,registryExecutions:0,dockerExecutions:0,
    activeTools:session.getActiveToolNames(),initialFixedOnly:true,notificationRefresh:true,searchRefresh:true,listRefresh:true,
    realAdapterCall:true,removedToolRefused:true,retainedMcpProcess:true,fixtureCalls:counters.calls,authenticatedDiscoveries:counters.lists,extensionErrors:0};
}finally{
  try{if(session){await session.extensionRunner.emit({type:'session_shutdown'});session.dispose();}}
  finally{unsubscribeErrors?.();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));fs.unlinkSync(contextPath);}
}
assert.deepEqual(extensionErrors,[],'Pi extension shutdown reported an error');
console.log(JSON.stringify(summary));
