// Disposable guest acceptance: real Pi 1.2.0, patched adapter 2.11.0 and stdio
// remote-server; only the authenticated host HTTP service is a local fixture.
// No session.prompt, provider call, registry access or Docker execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {networkInterfaces} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const root='/opt/sirna-pi',workspace='/workspace';
const adapter='/usr/local/share/agent-compose/pi-mcp-adapter';
const contextPath='/workspace/.sirna-task-context.json';
assert.equal(process.argv.length,2,'This check takes no arguments');
assert.ok(fs.existsSync('/.dockerenv'),'Use a disposable Docker guest');
assert.equal(process.cwd(),workspace,'Run with --workdir /workspace');
assert.equal(fs.realpathSync(workspace),workspace,'Workspace must not be redirected');
assert.ok(Object.values(networkInterfaces()).flat().every(address=>address.internal),
  'Use --network none; the only permitted HTTP traffic is container loopback');
assert.equal(JSON.parse(fs.readFileSync(`${root}/package.json`,'utf8')).name,'sirna-pi');
assert.equal(JSON.parse(fs.readFileSync(`${root}/node_modules/@earendil-works/pi-coding-agent/package.json`,'utf8')).version,'1.2.0');
assert.equal(JSON.parse(fs.readFileSync(`${adapter}/package.json`,'utf8')).version,'2.11.0');
assert.equal(fs.existsSync(contextPath),false,'Do not run against an existing task context');

// The parent is schema-valid. The fixture represents a repair whose original
// contract omitted it; no image, candidate or build session actually exists.
const proposal={
  name:'Builder feedback fixture',toolName:'builder_feedback_fixture',
  description:'No-model acceptance fixture for a frozen-contract submission rejection.',
  runtime:'node',script:'process.stdout.write(JSON.stringify({count:3}));\n',
  repeatabilityMode:'exact',smokeInput:{values:[2,4,6]},dependencies:[],
  testCases:[{name:'three values',input:{values:[2,4,6]},expectedOutput:{count:3}}],
  baseline:{runtime:'node',script:'process.stdout.write(JSON.stringify({count:0}));\n'},
  benchmarkCases:[{name:'three values comparison',input:{values:[2,4,6]},expectedOutput:{count:3}}],
  minNetGain:1,parent:{toolName:'builder_feedback_fixture',version:'1.0.0'},
  permissions:{profile:'no_external_access'},
  runtimeArtifact:{protocolVersion:'sirna-tool-runtime-artifact/v1',
    imageDigest:'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    command:['/usr/bin/node','/opt/tool/main.mjs'],platform:'linux/amd64',
    createdAt:'2026-10-21T00:00:00.000Z',buildSessionId:'11111111-1111-4111-8111-111111111111'},
};
const cwd=fs.mkdtempSync(`${workspace}/builder-feedback-check-`);
const agentDir=path.join(cwd,'agent');
const context={protocolVersion:'sirna-task-context/v1',taskId:randomUUID(),
  agentTurnId:randomUUID(),token:randomBytes(32).toString('hex')};
const counters={lists:0,proposals:0,authRejected:0,unexpected:0};
const extensionErrors=[];
const privateDiagnostic='fixture-private-diagnostic-must-not-reach-pi';
let mode='known',session,unsubscribeErrors,contextWritten=false,summary;

function send(res,status,value){
  if(res.destroyed||res.writableEnded)return;
  const text=JSON.stringify(value);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8',
    'content-length':Buffer.byteLength(text),'cache-control':'no-store'});
  res.end(text);
}
const fixture=http.createServer(async(req,res)=>{
  try{
    const headers={authorization:`Bearer ${context.token}`,
      'x-sirna-task-id':context.taskId,'x-sirna-agent-turn-id':context.agentTurnId};
    for(const [name,value] of Object.entries(headers)){
      let count=0;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)count++;
      if(count!==1||req.headers[name]!==value){
        counters.authRejected++;req.resume();send(res,401,{error:'Unauthorized fixture request'});return;
      }
    }
    if(req.method==='GET'&&req.url==='/v1/agent-tools'){
      counters.lists++;send(res,200,{tools:[]});return;
    }
    if(req.method==='POST'&&req.url==='/v1/tool-proposals'){
      counters.proposals++;
      assert.match(req.headers['content-type']??'',/^application\/json(?:;\s*charset=utf-8)?$/i);
      let size=0;const chunks=[];
      for await(const chunk of req){
        size+=chunk.length;
        if(size>1048576){counters.unexpected++;req.resume();send(res,413,{error:'Fixture body too large'});return;}
        chunks.push(chunk);
      }
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')),proposal);
      if(mode==='known')send(res,409,{error:{protocolVersion:'sirna-builder-rejection/v1',
        code:'repair_contract_mismatch',outcome:'not_registered',fields:['parent']}});
      else send(res,502,{error:privateDiagnostic});
      return;
    }
    counters.unexpected++;req.resume();send(res,404,{error:'Unknown fixture route'});
  }catch{
    counters.unexpected++;req.resume();send(res,400,{error:'Invalid fixture request'});
  }
});
fixture.requestTimeout=10000;fixture.headersTimeout=10000;

try{
  fs.mkdirSync(agentDir,{mode:0o700});
  fs.writeFileSync(contextPath,JSON.stringify(context),{flag:'wx',mode:0o600});contextWritten=true;
  Object.assign(process.env,{PI_CODING_AGENT_DIR:agentDir,PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',PI_TELEMETRY:'0'});
  await new Promise((resolve,reject)=>{fixture.once('error',reject);fixture.listen(0,'127.0.0.1',resolve);});
  const baseUrl=`http://127.0.0.1:${fixture.address().port}`;
  const launchLog=path.join(cwd,'remote-launches.jsonl'),probePath=path.join(cwd,'launch-probe.mjs');
  // Record only process identity, keeping the real remote-server entrypoint.
  fs.writeFileSync(probePath,`import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(launchLog)},JSON.stringify({pid:process.pid})+'\\n',{mode:0o600});\n`,{flag:'wx',mode:0o600});
  const configPath=path.join(cwd,'compose-mcp.json');
  fs.writeFileSync(configPath,JSON.stringify({settings:{sampling:false,elicitation:false,
    outputGuard:true,toolPrefix:'server',requestTimeoutMs:10000},mcpServers:{'sirna-tools':{
      command:'/usr/bin/node',args:['--import',pathToFileURL(probePath).href,`${root}/apps/mcp/remote-server.mjs`],
      env:{SIRNA_APPROVED_TOOLS_URL:baseUrl,SIRNA_TOOL_BUILDER_URL:baseUrl},
      lifecycle:'lazy',exposeResources:false}}}),{flag:'wx',mode:0o600});
  process.argv.push('--mcp-config',configPath);
  const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime}=
    await import('@earendil-works/pi-coding-agent');
  const settingsManager=SettingsManager.inMemory({cacheWarming:'off',retry:{enabled:false},
    compaction:{enabled:false},enableInstallTelemetry:false,enableAnalytics:false});
  const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager,noExtensions:true,
    disabledBuiltinExtensions:['mcp'],noSkills:true,noPromptTemplates:true,noThemes:true,
    noContextFiles:true,additionalExtensionPaths:[`${adapter}/index.ts`]});
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[],'Real adapter failed to load');
  loader.getExtensions().runtime.flagValues.set('mcp-config',configPath);
  const modelRuntime=await ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),
    modelsPath:path.join(agentDir,'models.json'),modelsStorePath:path.join(agentDir,'models-store.json'),
    allowModelNetwork:false,refreshOnCreate:false});
  ({session}=await createAgentSession({cwd,agentDir,modelRuntime,resourceLoader:loader,settingsManager,
    tools:['read','write','mcp'],sessionManager:SessionManager.inMemory(cwd)}));
  unsubscribeErrors=session.extensionRunner.onError(error=>extensionErrors.push(error));
  await session.bindExtensions({});
  assert.deepEqual(session.getActiveToolNames().sort(),['mcp','read','write']);
  const mcp=session.agent.state.tools.find(tool=>tool.name==='mcp');assert.ok(mcp,'MCP gateway is active');
  const call=params=>mcp.execute(randomUUID(),params,AbortSignal.timeout(15000));
  const connected=await call({connect:'sirna-tools'});
  const tool='sirna_tools_propose_exploration_tool';
  assert.ok(connected.details?.tools?.includes(tool),'Explicit builder configuration did not expose propose');
  const described=await call({describe:tool});
  assert.equal(described.details?.error,undefined);
  assert.equal(described.details?.tool?.name,tool);assert.equal(described.details?.server,'sirna-tools');
  assert.equal(described.content.length,1);assert.equal(described.content[0].type,'text');
  const descriptionParts=described.content[0].text.split('\n\nParameters:\n');
  assert.equal(descriptionParts.length,2,'Adapter describe must expose one parameter schema');
  assert.ok(descriptionParts[1].trim(),'Adapter parameter schema must not be empty');
  // Adapter 2.11.0 decorates MCP isError text. Verify its complete schema footer
  // against the same adapter's describe output; never search for a JSON fragment.
  const errorPrefix='Error: ',schemaFooter='\n\nExpected parameters:\n'+descriptionParts[1];
  const launches=()=>fs.readFileSync(launchLog,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const firstLaunch=launches();assert.equal(firstLaunch.length,1,'Exactly one stdio MCP process must start');
  const texts=result=>{
    assert.equal(result.details?.error,'tool_error','MCP isError must be visible through adapter details.error');
    assert.ok(Array.isArray(result.content),'The adapter must retain error content');
    assert.equal(result.content.length,1,'Expected one bounded text error');
    assert.equal(result.content[0].type,'text');const text=result.content[0].text;
    assert.equal(text.includes(privateDiagnostic),false,'Private HTTP diagnostics reached Pi');
    assert.ok(text.startsWith(errorPrefix),'Missing the verified adapter error prefix');
    assert.ok(text.endsWith(schemaFooter),'Error schema footer differs from adapter describe metadata');
    assert.equal(text.indexOf(schemaFooter),text.length-schemaFooter.length,'Duplicate adapter schema footer');
    return text.slice(errorPrefix.length,-schemaFooter.length);
  };

  const knownText=texts(await call({tool,args:JSON.stringify(proposal)}));
  assert.equal(counters.proposals,1,'Known rejection must issue exactly one authenticated POST');
  let known;
  assert.doesNotThrow(()=>{known=JSON.parse(knownText);},
    'Known contract rejection was replaced with generic unavailable text');
  assert.deepEqual(Object.keys(known).sort(),['code','fields','message','outcome','protocolVersion']);
  assert.equal(known.protocolVersion,'sirna-builder-rejection/v1');
  assert.equal(known.code,'repair_contract_mismatch');
  assert.equal(known.outcome,'not_registered');assert.deepEqual(known.fields,['parent']);
  assert.equal(typeof known.message,'string');assert.match(known.message,/parent/i);
  assert.match(known.message,/omit|absen|省略|未提供|没有/i,'Guidance must preserve omission of parent');
  assert.doesNotMatch(knownText,/operation may have completed/i,
    'A confirmed pre-submission rejection must not claim an unknown result');

  mode='unknown';
  const unknownText=texts(await call({tool,args:JSON.stringify(proposal)}));
  assert.match(unknownText,/accepted operation may have completed/i);
  assert.match(unknownText,/Inspect (?:the )?host records before retrying/i);
  assert.doesNotMatch(unknownText,/not_registered|repair_contract_mismatch/);
  assert.equal(unknownText.includes(privateDiagnostic),false,'Private HTTP diagnostics reached Pi');
  assert.equal(counters.proposals,2,'Two explicit calls must not trigger automatic retries');
  assert.equal(counters.authRejected,0);assert.equal(counters.unexpected,0);assert.ok(counters.lists>=1);
  assert.deepEqual(launches(),firstLaunch,'The rejection must not restart the MCP process');
  assert.deepEqual(extensionErrors,[],'Pi extension runtime reported an error');
  assert.deepEqual(loader.getExtensions().errors,[]);
  summary={passed:true,piVersion:'1.2.0',adapterVersion:'2.11.0',modelCalls:0,
    registryExecutions:0,dockerExecutions:0,externalNetwork:false,knownRejectionVisible:true,
    parentOmissionGuidance:true,unknownOutcomePreserved:true,privateDiagnosticsHidden:true,
    authenticatedProposalRequests:counters.proposals,authenticatedDiscoveries:counters.lists,
    automaticRetries:0,retainedMcpProcess:true,adapterErrorDecorationVerified:true,extensionErrors:0};
}finally{
  try{
    if(session){try{await session.extensionRunner.emit({type:'session_shutdown'});}finally{session.dispose();}}
  }finally{
    unsubscribeErrors?.();fixture.closeAllConnections();
    await new Promise(resolve=>fixture.close(resolve));
    if(contextWritten)fs.unlinkSync(contextPath);
    // Only remove this invocation's unique, direct /workspace child.
    assert.equal(path.dirname(cwd),workspace);
    assert.ok(path.basename(cwd).startsWith('builder-feedback-check-'));
    assert.equal(fs.realpathSync(cwd),cwd);
    fs.rmSync(cwd,{recursive:true});
  }
}
assert.deepEqual(extensionErrors,[],'Pi extension shutdown reported an error');
assert.equal(counters.proposals,2,'Shutdown must not trigger an automatic proposal retry');
assert.equal(counters.authRejected,0);assert.equal(counters.unexpected,0);
assert.equal(fs.existsSync(contextPath),false);assert.equal(fs.existsSync(cwd),false);
console.log(JSON.stringify({...summary,temporaryStateRemoved:true}));
