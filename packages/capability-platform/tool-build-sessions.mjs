import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createBuildEvidence} from '../../scripts/lib/tool-build-files.mjs';
import {TOOL_BASE_IMAGE,TOOL_COMMAND,toolBuildRuntime as r} from './tool-build-service.mjs';
import {checkToolProposal} from './tool-contract.mjs';
import {submitRegisteredToolProposal,resolveToolLearningPaths} from './tool-lifecycle.mjs';
import {ToolRegistry} from './tool-registry.mjs';
import {readToolProposal} from './tool-proposals.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEEPALIVE=['/bin/sh','-c','while :; do sleep 3600; done'];
const must=(ok,message)=>{if(!ok)throw new Error(message);};
const flags={verified:false,approved:false,activated:false};
export function copyToolBuilderArguments(value){const copy=r.jsonCopy(value);must(r.object(copy)&&Buffer.byteLength(JSON.stringify(copy))<=1048576,'Invalid or oversized builder arguments');return JSON.parse(JSON.stringify(copy));}
function fields(value,required,optional=[]){const v=copyToolBuilderArguments(value);must(required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>[...required,...optional].includes(k)),'Invalid builder argument fields');return v;}
function commandVector(command){must(isDeepStrictEqual(command,TOOL_COMMAND),'Unsupported runtime command');}
function publicSession(s){return {id:s.id,state:s.state,createdAt:s.createdAt};}
export function createToolBuildSessionService({root,docker,ttlMs=300000,maxLiveSessions=4,maxSessions=32}={}){
  must(typeof root==='string'&&path.isAbsolute(root)&&docker,'Explicit root and Docker are required');
  for(const [value,max]of [[ttlMs,86400000],[maxLiveSessions,4],[maxSessions,32]])must(Number.isInteger(value)&&value>=1&&value<=max,'Invalid session limits');
  const sessions=new Map();let busy=false,closing=false,accepted=Promise.resolve(),closePromise;
  const journal=(s,event)=>s.evidence.appendEvent({...event,sessionId:s.id,recordedAt:new Date().toISOString()});
  const intent=(s,type,details={})=>journal(s,{type,...details});
  async function effect(s,type,operation,details={}){intent(s,`${type}_requested`,details);return operation();}
  async function remove(s,owned=s.owned){
    await effect(s,'cleanup',()=>r.cleanup(docker,owned,async e=>journal(s,e)));
    s.cleanupConfirmed=!owned.containerId;
  }
  async function fail(s,error){s.state='failed';clearTimeout(s.timer);let cleanupError;
    if(error.cleanupError){cleanupError=error;s.cleanupConfirmed=false;}
    else try{await remove(s);}catch(e){cleanupError=e;s.cleanupConfirmed=false;}
    if(s.creatingUnknown)s.cleanupConfirmed=false;
    try{journal(s,{type:'session_failed',error:error.message,cleanupError:cleanupError?.message,cleanupConfirmed:s.cleanupConfirmed});}catch{}
    const failure=new Error(`Tool build failed; cleanup ${s.cleanupConfirmed?'confirmed':'unknown'}.`,{cause:error});failure.cleanupConfirmed=s.cleanupConfirmed;throw failure;
  }
  function arm(s){clearTimeout(s.timer);if(s.state!=='running'||closing)return;
    s.timer=setTimeout(()=>{if(busy){arm(s);return;}void serial(async()=>{intent(s,'session_expired');await remove(s);s.state='expired';journal(s,{type:'session_expired_completed',cleanupConfirmed:s.cleanupConfirmed});}).catch(error=>{s.state='failed';s.cleanupConfirmed=false;try{journal(s,{type:'expiry_failed',error:error.message,cleanupConfirmed:false});}catch{}});},ttlMs);s.timer.unref();
  }
  function serial(fn){if(closing)return Promise.reject(new Error('Tool builder is closed'));if(busy)return Promise.reject(new Error('Tool builder is busy'));busy=true;
    const promise=(async()=>{try{return await fn();}finally{busy=false;}})();accepted=promise.catch(()=>{});return promise;
  }
  function lookup(id){must(typeof id==='string'&&UUID.test(id)&&sessions.has(id),'Unknown build session');return sessions.get(id);}
  function sessionOperation(s,fn){return serial(async()=>{clearTimeout(s.timer);try{return await fn();}finally{arm(s);}});}
  async function checked(s,owned=s.owned){return r.inspectPolicy(await docker.inspectContainer(owned.containerId),s.id,owned.role,TOOL_BASE_IMAGE,KEEPALIVE);}
  async function base(s){const image=await docker.inspectImage(TOOL_BASE_IMAGE);must(image?.Id===TOOL_BASE_IMAGE&&image.Os==='linux'&&image.Architecture==='amd64'&&r.noVolumes(image),'Fixed base image differs');journal(s,{type:'base_image_checked',...r.imageSummary(image)});}
  async function provision(s,owned){await base(s);owned.containerId=await effect(s,'container_create',async()=>{
      s.creatingUnknown=true;const id=await docker.createContainer(`sirna-learning-tool-${owned.role}-${s.id}`,r.configuration(TOOL_BASE_IMAGE,s.id,owned.role,KEEPALIVE));
      must(typeof id==='string'&&id.length>0,'Docker returned no container');owned.containerId=id;s.creatingUnknown=false;return id;
    });journal(s,{type:'container_created',containerId:owned.containerId,role:owned.role});await checked(s,owned);await effect(s,'container_start',()=>docker.startContainer(owned.containerId));}
  async function exec(s,owned,cmd,user='0:0',timeoutMs=10000){return effect(s,'container_exec',()=>docker.exec(owned.containerId,cmd,{timeoutMs,user}),{command:cmd,user,timeoutMs});}
  async function upload(s,owned,source){const chunks=Buffer.from(source).toString('base64').match(/.{1,60000}/g)??[''];const result=await exec(s,owned,['/usr/bin/node','-e',r.WRITE_SOURCE,...chunks]);journal(s,{type:'source_uploaded',result});must(result.exitCode===0,'Source upload failed');}
  function readback(s){const paths=resolveToolLearningPaths(root);const registry=new ToolRegistry(paths.databasePath,{readOnly:true});try{const row=registry.getProposal(s.proposal.proposalId);must(row&&row.state==='submitted'&&row.imageDigest===s.artifact.imageDigest,'Proposal readback differs');const saved=readToolProposal(row.id,{proposalsRoot:paths.proposalsRoot,expectedArtifactSha256:row.artifactSha256});must(isDeepStrictEqual(saved.input,s.proposalInput),'Proposal material readback differs');return {...s.proposal};}finally{registry.close();}}
  return {
    create(args={}){fields(args,[]);return serial(async()=>{
      must(sessions.size<maxSessions&&[...sessions.values()].filter(s=>s.owned.containerId||s.creatingUnknown).length<maxLiveSessions,'Build session limit reached');
      const id=randomUUID();const evidence=createBuildEvidence(root,id);const s={id,evidence,state:'creating',createdAt:new Date().toISOString(),cleanupConfirmed:true,owned:{sessionId:id,role:'build',containerId:null,imageDigest:TOOL_BASE_IMAGE}};sessions.set(id,s);
      try{intent(s,'session_create');await provision(s,s.owned);await upload(s,s.owned,'');s.state='running';journal(s,{type:'session_running'});arm(s);return {session:publicSession(s)};}catch(e){return fail(s,e);}
    });},
    write(args){const v=fields(args,['sessionId','path','content']);must(v.path==='/opt/tool/main.mjs'&&typeof v.content==='string'&&v.content.isWellFormed()&&v.content.trim()&&Buffer.byteLength(v.content)<=200000,'Invalid source path or content');const s=lookup(v.sessionId);must(s.state==='running','Session is not running');return sessionOperation(s,async()=>{try{
      intent(s,'source_write',{path:v.path,sourceSha256:createHash('sha256').update(v.content).digest('hex')});await checked(s);await upload(s,s.owned,v.content);s.source=v.content;s.successfulDebug=false;s.sourceSha256=createHash('sha256').update(v.content).digest('hex');journal(s,{type:'source_written',sourceSha256:s.sourceSha256});return {sessionId:s.id,path:v.path,sourceSha256:s.sourceSha256};
    }catch(e){return fail(s,e);}});},
    run(args){const v=fields(args,['sessionId','command'],['timeoutMs']);must(typeof v.command==='string'&&v.command.trim()&&Buffer.byteLength(v.command)<=20000,'Invalid build command');r.controls(v.timeoutMs??10000);const s=lookup(v.sessionId);must(s.state==='running','Session is not running');return sessionOperation(s,async()=>{try{
      intent(s,'debug_run',{command:v.command,timeoutMs:v.timeoutMs??10000});await checked(s);const raw=await exec(s,s.owned,['/bin/sh','-c',v.command],'65534:65534',v.timeoutMs??10000);journal(s,{type:'debug_result',result:raw});
      must(Number.isInteger(raw.exitCode)&&typeof raw.stdout==='string'&&typeof raw.stderr==='string','Invalid debug result');must(Buffer.byteLength(raw.stdout)+Buffer.byteLength(raw.stderr)<=65536,'Debug output bound exceeded');if(raw.exitCode===0&&s.source!==undefined)s.successfulDebug=true;
      return {sessionId:s.id,exitCode:raw.exitCode,stdout:raw.stdout,stderr:raw.stderr,timedOut:false,success:raw.exitCode===0};
    }catch(e){return fail(s,e);}});},
    finalize(args){const v=fields(args,['sessionId','command']);commandVector(v.command);const s=lookup(v.sessionId);must(s.state==='running'||s.state==='finalized','Session cannot be finalized');return sessionOperation(s,async()=>{
      if(s.state==='finalized')return structuredClone(s.result);must(s.source!==undefined&&s.successfulDebug,'Write source and complete a successful debug command first');
      try{intent(s,'finalize',{sourceSha256:s.sourceSha256});await checked(s);await effect(s,'container_stop',()=>docker.stopContainer(s.owned.containerId));await remove(s);s.owned={sessionId:s.id,role:'package',containerId:null,imageDigest:TOOL_BASE_IMAGE};await provision(s,s.owned);await upload(s,s.owned,s.source);
        const syntax=await exec(s,s.owned,['/usr/bin/node','--check','/opt/tool/main.mjs']);journal(s,{type:'syntax_checked',result:syntax});must(syntax.exitCode===0,'Candidate syntax check failed');
        const hash=await exec(s,s.owned,['/usr/bin/node','-e',r.READ_HASH]);journal(s,{type:'source_readback',result:hash});must(hash.exitCode===0&&hash.stdout.trim()===s.sourceSha256,'Source readback differs');await effect(s,'container_stop',()=>docker.stopContainer(s.owned.containerId));
        const createdAt=new Date().toISOString();const config={Entrypoint:[],Cmd:[...TOOL_COMMAND],User:'65534:65534',WorkingDir:'/tmp',Env:[],Labels:{...r.labels(s.id,'runtime'),'sirna.tool.runtime':'true','sirna.tool.source-sha256':s.sourceSha256,'sirna.tool.base-image':TOOL_BASE_IMAGE,'sirna.tool.created-at':createdAt}};
        const imageDigest=await effect(s,'image_commit',()=>docker.commitContainer(s.owned.containerId,'sirna-learning-tool-runtime',s.id,config));
        const artifact=r.artifactData({protocolVersion:'sirna-tool-runtime-artifact/v1',imageDigest,command:[...TOOL_COMMAND],platform:'linux/amd64',createdAt,buildSessionId:s.id});r.verifyImage(await docker.inspectImage(imageDigest),artifact);await remove(s);
        s.artifact=JSON.parse(JSON.stringify(artifact));s.result={sessionId:s.id,artifact:s.artifact,sourceSha256:s.sourceSha256,...flags};s.evidence.write('finalized.json',{...s.result,script:s.source});journal(s,{type:'finalized',artifact:s.artifact,sourceSha256:s.sourceSha256,...flags});s.state='finalized';return structuredClone(s.result);
      }catch(e){return fail(s,e);}
    });},
    cancel(args){const v=fields(args,['sessionId']);const s=lookup(v.sessionId);must(['running','cancelled'].includes(s.state),'Session cannot be cancelled');return sessionOperation(s,async()=>{if(s.state==='cancelled')return {sessionId:s.id,state:s.state,cleanupConfirmed:s.cleanupConfirmed};try{intent(s,'cancel');await remove(s);s.state='cancelled';journal(s,{type:'cancelled',cleanupConfirmed:true});return {sessionId:s.id,state:s.state,cleanupConfirmed:true};}catch(e){return fail(s,e);}});},
    propose(input){const v=copyToolBuilderArguments(input);const check=checkToolProposal(v);must(check.ok,'Invalid tool proposal');must(v.runtime==='node'&&v.dependencies.length===0&&v.repeatabilityMode==='exact'&&v.permissions.profile==='no_external_access','Unsupported proposal configuration');const s=lookup(v.runtimeArtifact.buildSessionId);must(s.state==='finalized'&&isDeepStrictEqual(v.runtimeArtifact,s.artifact)&&v.script===s.source,'Proposal differs from finalized source or artifact');
      return sessionOperation(s,async()=>{if(s.proposal){must(isDeepStrictEqual(v,s.proposalInput),'Conflicting proposal repeat');return readback(s);}must(!s.proposalAttempted,'Proposal submission uncertain; inspect private evidence');
        intent(s,'proposal_submit',{proposal:v});s.proposalAttempted=true;try{const saved=submitRegisteredToolProposal(v,{root});s.proposalInput=v;s.proposal={proposalId:saved.proposal.id,toolName:saved.proposal.toolName,state:saved.registry.state,registered:true,...flags};const result=readback(s);journal(s,{type:'proposal_registered',...result});s.evidence.write('proposal-result.json',result);return result;}catch(error){try{journal(s,{type:'proposal_submission_failed',error:error.message,proposalId:error.proposalId});}catch{}throw new Error('Proposal submission failed; inspect private evidence');}
      });},
    close(){if(closePromise)return closePromise;closing=true;for(const s of sessions.values())clearTimeout(s.timer);closePromise=(async()=>{await accepted;let failed=false;for(const s of sessions.values()){if(s.creatingUnknown)failed=true;if(s.owned.containerId){try{intent(s,'close_cleanup');await remove(s);if(s.state==='running')s.state='cancelled';}catch(error){failed=true;s.state='failed';s.cleanupConfirmed=false;try{journal(s,{type:'close_cleanup_failed',error:error.message,cleanupConfirmed:false});}catch{}}} }if(failed)throw new Error('Tool builder close cleanup unknown');})();return closePromise;},
  };
}
