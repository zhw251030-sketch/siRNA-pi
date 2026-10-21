// Disposable guest only: real Pi/adapter/stdio MCP, loopback HTTP fixture.
// No session.prompt, model provider, production TaskStore, registry or Docker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {networkInterfaces} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';

const root='/opt/sirna-pi',workspace='/workspace',contextPath=`${workspace}/.sirna-task-context.json`,adapter='/usr/local/share/agent-compose/pi-mcp-adapter';
assert.equal(process.argv.length,2,'This check takes no arguments');
assert.ok(fs.existsSync('/.dockerenv'),'Use a disposable Docker guest');
assert.equal(process.cwd(),workspace,'Use --workdir /workspace with a dedicated disposable bind mount');
assert.equal(fs.realpathSync(workspace),workspace);
assert.ok(Object.values(networkInterfaces()).flat().every(address=>address.internal),'Use --network none; only container loopback is permitted');
assert.equal(fs.readdirSync(workspace).length,0,'Use a new empty workspace, never a task or production workspace');
assert.equal(JSON.parse(fs.readFileSync(`${root}/package.json`,'utf8')).name,'sirna-pi');
assert.equal(JSON.parse(fs.readFileSync(`${root}/node_modules/@earendil-works/pi-coding-agent/package.json`,'utf8')).version,'1.2.0');
assert.equal(JSON.parse(fs.readFileSync(`${adapter}/package.json`,'utf8')).version,'2.11.0');
const cwd=fs.mkdtempSync(`${workspace}/tool-gap-check-`),agentDir=path.join(cwd,'agent');fs.mkdirSync(agentDir,{mode:0o700});
const context={protocolVersion:'sirna-task-context/v1',taskId:randomUUID(),agentTurnId:randomUUID(),token:randomBytes(32).toString('hex')};
const source={taskId:context.taskId,executionSessionId:randomUUID(),sandboxId:'a'.repeat(64),agentTurnId:context.agentTurnId,agentRunId:randomUUID()};
const args={capability:'Compare RNA structures',blocking:true,reason:'No registered structure comparison capability.',desiredInput:{structures:['string']},desiredOutput:{distance:'number'},evidenceEventIds:[]};
const report={id:randomUUID(),taskId:context.taskId,runId:source.agentRunId,userMessageId:randomUUID(),...args,capabilityKey:'compare-rna-structures',createdAt:'2026-10-22T00:00:00.000Z',source,reportSha256:'b'.repeat(64)};
const counters={discoveries:0,reports:0,authRejected:0,unexpected:0},extensionErrors=[];
let session,unsubscribeErrors,contextWritten=false,summary;
const send=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
const fixture=http.createServer(async(req,res)=>{
  try{
    for(const [name,value] of Object.entries({authorization:`Bearer ${context.token}`,'x-sirna-task-id':context.taskId,'x-sirna-agent-turn-id':context.agentTurnId})){
      let count=0;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)count++;
      if(count!==1||req.headers[name]!==value){counters.authRejected++;req.resume();send(res,401,{error:'Unauthorized fixture request'});return;}
    }
    if(req.method==='GET'&&req.url==='/v1/agent-tools'){counters.discoveries++;send(res,200,{tools:[]});return;}
    if(req.method==='POST'&&req.url==='/v1/tool-gaps'){
      let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>32768)throw Error('Excess fixture request');chunks.push(chunk);}
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')),args);counters.reports++;
      send(res,202,{report,deduplicated:false,candidateCreated:false,toolCreated:false,nextGate:'finish_current_turn_then_manual_curator_review'});return;
    }
    counters.unexpected++;req.resume();send(res,404,{error:'Unknown fixture route'});
  }catch{counters.unexpected++;req.resume();send(res,400,{error:'Invalid fixture request'});}
});
fixture.requestTimeout=10000;fixture.headersTimeout=10000;
try{
  fs.writeFileSync(contextPath,JSON.stringify(context),{flag:'wx',mode:0o600});contextWritten=true;
  Object.assign(process.env,{PI_CODING_AGENT_DIR:agentDir,PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',PI_TELEMETRY:'0'});
  await new Promise((resolve,reject)=>{fixture.once('error',reject);fixture.listen(0,'127.0.0.1',resolve);});
  const baseUrl=`http://127.0.0.1:${fixture.address().port}`,configPath=path.join(cwd,'compose-mcp.json');
  fs.writeFileSync(configPath,JSON.stringify({settings:{sampling:false,elicitation:false,outputGuard:true,toolPrefix:'server',requestTimeoutMs:10000},mcpServers:{'sirna-tools':{command:'/usr/bin/node',args:[`${root}/apps/mcp/remote-server.mjs`],env:{SIRNA_APPROVED_TOOLS_URL:baseUrl,SIRNA_TOOL_GAP_URL:baseUrl},lifecycle:'lazy',exposeResources:false}}}),{flag:'wx',mode:0o600});
  process.argv.push('--mcp-config',configPath);
  const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime}=await import('@earendil-works/pi-coding-agent');
  const settingsManager=SettingsManager.inMemory({cacheWarming:'off',retry:{enabled:false},compaction:{enabled:false},enableInstallTelemetry:false,enableAnalytics:false});
  const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager,noExtensions:true,disabledBuiltinExtensions:['mcp'],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[`${adapter}/index.ts`]});
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);loader.getExtensions().runtime.flagValues.set('mcp-config',configPath);
  const modelRuntime=await ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:path.join(agentDir,'models.json'),modelsStorePath:path.join(agentDir,'models-store.json'),allowModelNetwork:false,refreshOnCreate:false});
  ({session}=await createAgentSession({cwd,agentDir,modelRuntime,resourceLoader:loader,settingsManager,tools:['read','write','mcp'],sessionManager:SessionManager.inMemory(cwd)}));
  unsubscribeErrors=session.extensionRunner.onError(error=>extensionErrors.push(error));await session.bindExtensions({});
  const mcp=session.agent.state.tools.find(tool=>tool.name==='mcp');assert.ok(mcp);
  const call=params=>mcp.execute(randomUUID(),params,AbortSignal.timeout(15000)),tool='sirna_tools_report_tool_gap';
  const connected=await call({connect:'sirna-tools'});assert.ok(connected.details?.tools?.includes(tool));
  const described=await call({describe:tool});assert.equal(described.details?.tool?.name,tool);assert.equal(described.details?.error,undefined);
  const result=await call({tool,args:JSON.stringify(args)});assert.notEqual(result.details?.error,'tool_error');assert.equal(result.content.length,1);assert.equal(result.content[0].type,'text');
  const value=JSON.parse(result.content[0].text);assert.deepEqual(value.report,report);assert.equal(value.toolCreated,false);assert.equal(value.candidateCreated,false);assert.equal(value.deduplicated,false);assert.equal(JSON.stringify(value).includes(context.token),false);
  assert.equal(counters.reports,1,'One explicit report must make exactly one HTTP request');assert.equal(counters.authRejected,0);assert.equal(counters.unexpected,0);assert.ok(counters.discoveries>=1);assert.deepEqual(extensionErrors,[]);
  summary={passed:true,piVersion:'1.2.0',adapterVersion:'2.11.0',modelCalls:0,productionStoreAccess:false,externalNetwork:false,authenticatedReportRequests:1,automaticRetries:0,toolCreated:false,candidateCreated:false,contextBound:true};
}finally{
  try{if(session){try{await session.extensionRunner.emit({type:'session_shutdown'});}finally{session.dispose();}}}
  finally{unsubscribeErrors?.();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));if(contextWritten)fs.unlinkSync(contextPath);assert.equal(path.dirname(cwd),workspace);assert.ok(path.basename(cwd).startsWith('tool-gap-check-'));assert.equal(fs.realpathSync(cwd),cwd);fs.rmSync(cwd,{recursive:true});}
}
assert.equal(counters.reports,1,'Shutdown must not issue report retries');assert.deepEqual(extensionErrors,[]);assert.equal(fs.readdirSync(workspace).length,0);
console.log(JSON.stringify({...summary,temporaryStateRemoved:true}));
