import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {submitRegisteredToolProposal,resolveToolLearningPaths} from '../packages/capability-platform/tool-lifecycle.mjs';
import {ToolRegistry} from '../packages/capability-platform/tool-registry.mjs';
import {TaskStore} from '../packages/task-core/task-store.mjs';
import {TaskMessageService} from '../packages/task-core/task-message-service.mjs';
import {ToolMaintenanceStore} from '../packages/capability-platform/tool-maintenance-store.mjs';
import {createToolMaintenance} from '../packages/capability-platform/tool-maintenance-worker.mjs';
import {validateRegisteredToolProposal,getLatestToolValidationReport} from '../packages/capability-platform/tool-validation-service.mjs';
import {createDockerValidationRunner} from '../packages/capability-platform/tool-validation-runner.mjs';
import {DockerBoundary} from './helpers/validation-docker-boundary.mjs';
import {BuildDocker,COMMAND} from './helpers/tool-build-docker.mjs';
import {createToolBuildSessionService} from '../packages/capability-platform/tool-build-sessions.mjs';
import {createAppServer} from '../apps/api/router.mjs';

const api=await import('../packages/capability-platform/tool-repair-service.mjs').catch(()=>({}));
const storage=await import('../packages/capability-platform/tool-repair-store.mjs').catch(()=>({}));
const sources=await import('../packages/capability-platform/tool-proposal-source.mjs').catch(()=>({}));
const draft=JSON.parse(fs.readFileSync(new URL('../examples/04-tool-contract/proposal.draft.json',import.meta.url)));
const context=()=>({taskId:randomUUID(),executionSessionId:randomUUID(),sandboxId:'a'.repeat(64),agentTurnId:randomUUID(),agentRunId:randomUUID()});
const input=()=>({...structuredClone(draft),runtimeArtifact:{protocolVersion:'sirna-tool-runtime-artifact/v1',imageDigest:`sha256:${'b'.repeat(64)}`,command:['/usr/bin/node','/opt/tool/main.mjs'],platform:'linux/amd64',createdAt:'2026-10-20T00:00:00.000Z',buildSessionId:randomUUID()}});
function temporary(t,cleanup=[]){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-repair-')));t.after(async()=>{for(const close of cleanup.reverse())await close();assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));assert.match(path.basename(root),/^sirna-repair-[A-Za-z0-9]+$/);function unlock(dir){fs.chmodSync(dir,0o700);for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory()&&!e.isSymbolicLink())unlock(p);else if(!e.isSymbolicLink())fs.chmodSync(p,0o600);}}unlock(root);fs.rmSync(root,{recursive:true});});return root;}
function registry(root,fn){const r=new ToolRegistry(resolveToolLearningPaths(root).databasePath);try{return fn(r);}finally{r.close();}}
async function setup(t,{source=true,changes={},run}={}){
  assert.equal(typeof api.createToolRepair,'function','controlled repair service is implemented');
  const cleanup=[],root=temporary(t,cleanup),tasks=new TaskStore(path.join(root,'tasks.sqlite')),ctx=context();
  const task=tasks.createTask({id:ctx.executionSessionId});ctx.taskId=task.id;
  const p={...input(),...changes},saved=submitRegisteredToolProposal(p,{root,actor:source?'web-agent':'local-cli',...(source?{taskContext:ctx}:{})});
  const queue=new ToolMaintenanceStore({root}),runErrors=[];let repair;
  const maintenance=createToolMaintenance({root,store:queue,canValidate:id=>!repair?.active(id),validate:async()=>{throw new Error('No implicit validation');}});
  const runtime={describe:async()=>({backend:'agent-compose',sandboxId:ctx.sandboxId,supportsLifecycle:true,builderToolsAvailable:true,runtimeReleased:false,stopUnconfirmed:false}),
    assertWorkspaceIdle:async()=>({status:'idle'}),run:async(request,emit,signal)=>{const c={...ctx,agentRunId:randomUUID(),agentTurnId:randomUUID()};emit({type:'run_status',status:'running',runId:c.agentRunId});if(run){try{await run({request,emit,signal,ctx:c,repair,tasks,root});}catch(error){runErrors.push(error);throw error;}}else{emit({type:'text_delta',delta:'I submitted a tool (words only).'});emit({type:'done',status:'succeeded',runId:c.agentRunId});}}};
  const messages=new TaskMessageService({taskStore:tasks,agentRuntime:runtime});
  let store=new storage.ToolRepairStore({root});
  const create=()=>api.createToolRepair({root,store,taskStore:tasks,taskMessages:messages,agentRuntime:runtime,maintenance});
  repair=create();
  cleanup.push(async()=>{await repair.stop();await maintenance.stop();store.close();queue.close();tasks.close();assert.deepEqual(runErrors,[],'runtime callback assertions must not be swallowed by the task service');});
  async function validate(id=saved.proposal.id,allPass=false){const row=registry(root,r=>r.getProposal(id));const {readToolProposal}=await import('../packages/capability-platform/tool-proposals.mjs');const material=readToolProposal(id,{proposalsRoot:resolveToolLearningPaths(root).proposalsRoot,expectedArtifactSha256:row.artifactSha256});const docker=new DockerBoundary(material,{runResult:({target,envelope})=>({exitCode:allPass&&target==='baseline'&&envelope.input.sequence.startsWith('>')?1:0,timedOut:false,outputLimitExceeded:false,stdout:JSON.stringify({length:allPass?4:99,gcFraction:0.5}),stderr:''})});await validateRegisteredToolProposal(id,{root,runner:createDockerValidationRunner({docker})});const v=getLatestToolValidationReport(id,{root});return {validationId:v.id,reportSha256:v.reportSha256};}
  const body=await validate();
  return {root,tasks,ctx,task,p,saved,id:saved.proposal.id,queue,maintenance,runtime,messages,cleanup,get repair(){return repair;},get store(){return store;},body,validate,
    async reopen(){await repair.stop();store.close();store=new storage.ToolRepairStore({root});repair=create();return repair;}};
}

test('host source persists atomically in submission and survives reopening, while old and CLI records stay sourceless',t=>{
  const root=temporary(t),ctx=context(),p=input(),saved=submitRegisteredToolProposal(p,{root,actor:'web-agent',taskContext:ctx});
  assert.deepEqual(registry(root,r=>r.listEvents(saved.proposal.id)[0].details.source),ctx);
  assert.equal(typeof sources.getToolProposalSource,'function');
  assert.deepEqual(sources.getToolProposalSource(saved.proposal.id,{root}).source,ctx);
  for(const actor of ['local-cli','web-agent']){const old=submitRegisteredToolProposal(input(),{root,actor});assert.equal(sources.getToolProposalSource(old.proposal.id,{root}).source,null);}
  for(const options of [{actor:'local-cli',taskContext:ctx},{actor:'web-agent',taskContext:{...ctx,agentRunId:'pending'}}])assert.throws(()=>submitRegisteredToolProposal(input(),{root,...options}));
  assert.throws(()=>submitRegisteredToolProposal({...input(),taskContext:ctx},{root,actor:'web-agent'}));
  const db=new DatabaseSync(resolveToolLearningPaths(root).databasePath);db.exec("CREATE TRIGGER deny_source BEFORE INSERT ON tool_events BEGIN SELECT RAISE(ABORT,'stop'); END");db.close();
  const before=registry(root,r=>r.listProposals().length);assert.throws(()=>submitRegisteredToolProposal(input(),{root,actor:'web-agent',taskContext:ctx}));assert.equal(registry(root,r=>r.listProposals().length),before);
});

test('one explicit dispatch saves the complete original proposal and report; words alone are awaiting replacement; retries survive restart',async t=>{
  const f=await setup(t);assert.equal(f.repair.status(f.id).canRepair,true);
  const first=await f.repair.start(f.id,f.body);assert.equal(first.deduplicated,false);
  const second=await f.repair.start(f.id,f.body);assert.equal(second.deduplicated,true);
  await f.repair.drain();assert.equal(f.repair.status(f.id).repair.phase,'awaiting_replacement');assert.match(f.repair.status(f.id).repair.message,/未收到新候选/);
  const user=f.tasks.listMessages(f.task.id).find(m=>m.role==='user');assert.equal(user.clientRequestId,`auto-tool-repair:${f.id}`);const payload=JSON.parse(user.content.slice(user.content.indexOf('{')));assert.deepEqual(payload.proposal,f.p);assert.deepEqual(payload.report,getLatestToolValidationReport(f.id,{root:f.root}).report);assert.ok(user.content.includes(f.body.reportSha256));assert.match(user.content,/propose/);
  assert.equal(f.tasks.listMessages(f.task.id).length,2);assert.doesNotMatch(JSON.stringify(f.repair.status(f.id)),/prompt|script|sandboxId|agentRunId|stdout/);
  await f.reopen();f.repair.recover();assert.equal((await f.repair.start(f.id,f.body)).deduplicated,true);assert.equal(f.tasks.listMessages(f.task.id).length,2);
  await assert.rejects(f.repair.start(f.id,{...f.body,reportSha256:'c'.repeat(64)}),e=>e.statusCode===409);
});

test('concurrent requests reserve before asynchronous runtime readiness and dispatch only one durable message',async t=>{
  const f=await setup(t);let release;f.runtime.assertWorkspaceIdle=()=>new Promise(r=>release=r);
  const first=f.repair.start(f.id,f.body),second=f.repair.start(f.id,f.body);await new Promise(r=>setImmediate(r));
  assert.throws(()=>f.maintenance.enqueue(f.id,randomUUID()),e=>e.statusCode===409);
  release({status:'idle'});const results=await Promise.all([first,second]);assert.deepEqual(results.map(x=>x.deduplicated),[false,true]);await f.repair.drain();assert.equal(f.tasks.listMessages(f.task.id).filter(m=>m.role==='user').length,1);
});

for(const cause of ['no-source','stopped','busy','pending','halted','passing','unknown-runtime','report','material'])test(`${cause} preflight refuses before a ticket or task message`,async t=>{
  const f=await setup(t,{source:cause!=='no-source'});
  if(cause==='stopped')f.tasks.updateExecution(f.task.id,{status:'stopped'});
  if(cause==='busy')f.tasks.beginTurn(f.task.id,'other message',randomUUID());
  if(cause==='pending')f.queue.enqueue(f.id,randomUUID());
  if(cause==='halted')f.queue.halt();
  if(cause==='passing')await f.validate(f.id,true);
  if(cause==='unknown-runtime')f.runtime.assertWorkspaceIdle=async()=>{throw new Error('PRIVATE');};
  if(['report','material'].includes(cause)){const file=cause==='report'?getLatestToolValidationReport(f.id,{root:f.root}).reportPath:path.join(f.saved.registry.artifactPath,'tool.mjs');fs.chmodSync(file,0o600);fs.appendFileSync(file,' ');}
  const count=f.tasks.listMessages(f.task.id).length;await assert.rejects(f.repair.start(f.id,f.body),e=>e.statusCode>=400&&!e.message.includes('PRIVATE'));assert.equal(f.store.get(f.id),null);assert.equal(f.tasks.listMessages(f.task.id).length,count);
  if(cause!=='unknown-runtime')assert.equal(f.repair.status(f.id).canRepair,false);
});

for(const mode of ['canceled','failed','no-done','save-failed'])test(`${mode} completion cannot claim a successful repair`,async t=>{
  const f=await setup(t,{run:async({emit,ctx,tasks})=>{if(mode==='save-failed'){const db=new DatabaseSync(tasks.databasePath);db.exec("CREATE TRIGGER fail_assistant BEFORE INSERT ON chat_messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'disk failure'); END");db.close();}emit({type:'text_delta',delta:'done'});if(mode!=='no-done')emit({type:'done',status:mode==='save-failed'?'succeeded':mode,runId:ctx.agentRunId});}});
  await f.repair.start(f.id,f.body);await f.repair.drain();assert.equal(f.repair.status(f.id).repair.phase,'failed');assert.equal((await f.repair.start(f.id,f.body)).deduplicated,true);assert.equal(f.tasks.listMessages(f.task.id).filter(m=>m.role==='user').length,1);
});

test('real replacement event wins over late completion failure and transaction admits only one candidate per ticket',async t=>{
  let replacement;
  const f=await setup(t,{run:async({ctx,repair,root,emit})=>{const p={...input(),script:draft.script+'\n// fixed'};const association=repair.registration(p,ctx);replacement=submitRegisteredToolProposal(p,{root,actor:'web-agent',taskContext:ctx,repair:association});assert.throws(()=>repair.registration({...p,runtimeArtifact:{...p.runtimeArtifact,buildSessionId:randomUUID()}},ctx));assert.throws(()=>submitRegisteredToolProposal({...p,runtimeArtifact:{...p.runtimeArtifact,buildSessionId:randomUUID()}},{root,actor:'web-agent',taskContext:ctx,repair:association}));emit({type:'done',status:'failed',runId:ctx.agentRunId});}});
  await f.repair.start(f.id,f.body);await f.repair.drain();assert.equal(f.repair.status(f.id).repair.phase,'superseded');assert.equal(f.repair.status(f.id).repair.replacementProposalId,replacement.proposal.id);assert.equal(replacement.registry.state,'submitted');
  assert.equal(registry(f.root,r=>r.getRepairReplacement(`auto-tool-repair:${f.id}`)).proposalId,replacement.proposal.id);
});

test('only current task, session, run and repair message can register and frozen fields cannot be changed',async t=>{
  const f=await setup(t,{run:async({ctx,repair,tasks,emit})=>{const p=input();
    for(const field of ['taskId','executionSessionId','agentRunId'])assert.throws(()=>repair.registration(p,{...ctx,[field]:randomUUID()}));
    for(const [field,value] of Object.entries({toolName:'another_tool',runtime:'python',dependencies:['x'],permissions:{profile:'controlled_network'},repeatabilityMode:'statistical',smokeInput:{n:1},testCases:[],baseline:{runtime:'node',script:'x'},benchmarkCases:[],minNetGain:0,parent:{toolName:p.toolName,version:'1.0.0'}}))assert.throws(()=>repair.registration({...p,[field]:value},ctx),field);
    assert.throws(()=>repair.registration({...p,runtimeArtifact:{...p.runtimeArtifact,buildSessionId:f.p.runtimeArtifact.buildSessionId}},ctx));
    assert.equal(repair.registration(p,ctx).attempt,1);
    const db=new DatabaseSync(tasks.databasePath);db.prepare("UPDATE chat_messages SET client_request_id=? WHERE task_id=? AND role='user'").run(randomUUID(),ctx.taskId);db.close();assert.throws(()=>repair.registration(p,ctx));emit({type:'done',status:'succeeded',runId:ctx.agentRunId});}});
  await f.repair.start(f.id,f.body);await f.repair.drain();assert.equal(registry(f.root,r=>r.listProposals().length),1);
});

test('three linked replacement generations are accepted and the fourth cannot dispatch',async t=>{
  let replacement;
  const f=await setup(t,{run:async({ctx,repair,root,emit})=>{const p=input();replacement=submitRegisteredToolProposal(p,{root,actor:'web-agent',taskContext:ctx,repair:repair.registration(p,ctx)});emit({type:'done',status:'succeeded',runId:ctx.agentRunId});}});
  let id=f.id,body=f.body;
  for(let attempt=1;attempt<=3;attempt++){await f.repair.start(id,body);await f.repair.drain();id=replacement.proposal.id;assert.equal(f.repair.status(id).attempt,attempt);assert.equal(f.repair.status(id).rootProposalId,f.id);body=await f.validate(id);}
  assert.equal(f.repair.status(id).canRepair,false);await assert.rejects(f.repair.start(id,body),e=>e.statusCode===409);assert.equal(f.tasks.listMessages(f.task.id).filter(m=>m.role==='user').length,3);
});

test('startup interrupts an accepted unknown dispatch without replay and preserves a committed successor projection',async t=>{
  const f=await setup(t);await f.repair.start(f.id,f.body);await f.repair.drain();const db=new DatabaseSync(path.join(f.root,'runtime/tool-repair/repairs.sqlite'));db.prepare("UPDATE repairs SET phase='dispatching' WHERE proposal_id=?").run(f.id);db.close();await f.reopen();assert.equal(f.repair.status(f.id).repair.phase,'dispatching');f.repair.recover();assert.equal(f.repair.status(f.id).repair.phase,'interrupted');assert.equal((await f.repair.start(f.id,f.body)).deduplicated,true);assert.equal(f.tasks.listMessages(f.task.id).length,2);
});

test('HTTP strict report binding, body limit, safe errors and synchronous shutdown rejection',async t=>{
  let release,entered;const ready=new Promise(r=>entered=r);
  const f=await setup(t,{run:async({emit,ctx})=>{entered();await new Promise(r=>release=r);emit({type:'done',status:'succeeded',runId:ctx.agentRunId});}});
  const server=createAppServer({taskStore:f.tasks,agentRuntime:f.runtime,taskMessages:f.messages,toolMaintenance:f.maintenance,toolRepair:f.repair});server.listen(0,'127.0.0.1');await once(server,'listening');f.cleanup.push(async()=>{release?.();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
  const url=`http://127.0.0.1:${server.address().port}/v1/tool-proposals/${f.id}`;
  assert.equal((await fetch(url+'/repair-status')).status,200);
  for(const [body,status] of [[{...f.body,taskId:f.task.id},400],[{validationId:f.body.validationId},400],[{...f.body,extra:'x'.repeat(4096)},413]]){const response=await fetch(url+'/repair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,status);}
  const response=await fetch(url+'/repair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(f.body)});assert.equal(response.status,202);await ready;
  let drained=false;const stopping=f.repair.stop().then(()=>drained=true);assert.equal(f.repair.status(f.id).canRepair,false);await new Promise(r=>setImmediate(r));assert.equal(drained,false);release();await stopping;await server.waitForTaskCompletion();assert.equal(drained,true);
});

test('real finalized builder invokes admission and preserves identical receipt before a second-candidate rejection',async t=>{
  let successor;
  const f=await setup(t,{run:async({ctx,repair,root,emit})=>{
    const builder=createToolBuildSessionService({root,docker:new BuildDocker(),taskContext:ctx,registrationPolicy:repair.registration});
    try{let first,firstInput;for(let n=0;n<2;n++){
      const build=(await builder.create()).session.id;const p=input();await builder.write({sessionId:build,path:'/opt/tool/main.mjs',content:p.script});await builder.run({sessionId:build,command:'true'});p.runtimeArtifact=(await builder.finalize({sessionId:build,command:COMMAND})).artifact;
      if(n===0){firstInput=p;first=await builder.propose(p);successor=first.proposalId;assert.equal((await builder.propose(p)).proposalId,successor);}
      else{await assert.rejects(builder.propose(p));assert.equal((await builder.propose(firstInput)).proposalId,successor);}
    }}finally{await builder.close();}emit({type:'done',status:'succeeded',runId:ctx.agentRunId});
  }});
  await f.repair.start(f.id,f.body);await f.repair.drain();assert.ok(successor);assert.equal(f.repair.status(f.id).repair.replacementProposalId,successor);assert.equal(registry(f.root,r=>r.listProposals().length),2);
});

test('status reads do not change business rows or files and report switching cannot dispatch a stale identity',async t=>{
  const f=await setup(t);const before=fs.readFileSync(path.join(f.root,'runtime/tool-repair/repairs.sqlite'));const events=registry(f.root,r=>r.listEvents(f.id));const state=f.repair.status(f.id);for(let i=0;i<3;i++)assert.deepEqual(f.repair.status(f.id),state);assert.deepEqual(fs.readFileSync(path.join(f.root,'runtime/tool-repair/repairs.sqlite')),before);assert.deepEqual(registry(f.root,r=>r.listEvents(f.id)),events);
  await f.validate();await assert.rejects(f.repair.start(f.id,f.body),e=>e.code==='report_conflict');assert.equal(f.store.get(f.id),null);assert.equal(f.tasks.listMessages(f.task.id).length,0);
});

test('ordinary unrelated later work is a root, but terminal repair-message replay cannot bypass the chain budget',async t=>{
  let lastCtx;
  const f=await setup(t,{run:async({ctx,emit})=>{lastCtx=ctx;emit({type:'done',status:'succeeded',runId:ctx.agentRunId});}});await f.repair.start(f.id,f.body);await f.repair.drain();
  f.tasks.updateExecution(f.task.id,{status:'running',currentRunId:lastCtx.agentRunId});assert.throws(()=>f.repair.registration(input(),lastCtx));f.tasks.updateExecution(f.task.id,{status:'idle'});
  f.tasks.beginTurn(f.task.id,'A separate capability',randomUUID());const next={...lastCtx,agentRunId:randomUUID(),agentTurnId:randomUUID()};f.tasks.updateExecution(f.task.id,{currentRunId:next.agentRunId});assert.equal(f.repair.registration({...input(),toolName:'unrelated_capability'},next),undefined);
});

for(const mutation of ['actor','source','association','duplicate','cycle'])test(`tampered ${mutation} submission evidence cannot claim trusted runnable source`,async t=>{
  const f=await setup(t),db=new DatabaseSync(resolveToolLearningPaths(f.root).databasePath);
  const event=db.prepare("SELECT * FROM tool_events WHERE proposal_id=? AND event_type='proposal_submitted'").get(f.id),details=JSON.parse(event.details_json);
  if(mutation==='actor')db.prepare('UPDATE tool_events SET actor=? WHERE id=?').run('local-cli',event.id);
  else if(mutation==='duplicate')db.prepare('INSERT INTO tool_events(proposal_id,event_type,actor,tool_name,details_json,created_at) VALUES(?,?,?,?,?,?)').run(event.proposal_id,event.event_type,event.actor,event.tool_name,event.details_json,event.created_at);
  else{if(mutation==='source')details.source.agentRunId='pending';if(mutation==='association')details.proposalId=randomUUID();if(mutation==='cycle')details.repair={requestId:`auto-tool-repair:${f.id}`,rootProposalId:f.id,previousProposalId:f.id,attempt:1};db.prepare('UPDATE tool_events SET details_json=? WHERE id=?').run(JSON.stringify(details),event.id);}db.close();
  assert.equal(f.repair.status(f.id).canRepair,false);await assert.rejects(f.repair.start(f.id,f.body));assert.equal(f.store.get(f.id),null);
});

test('oversized complete source context is refused before runtime inspection or message persistence',async t=>{
  const f=await setup(t,{changes:{script:'//'+ 'x'.repeat(120000)}});f.runtime.describe=async()=>{throw new Error('Should never inspect runtime');};assert.equal(f.repair.status(f.id).canRepair,false);assert.equal(f.repair.status(f.id).reason,'context_too_large');await assert.rejects(f.repair.start(f.id,f.body),e=>e.code==='context_too_large'&&e.statusCode===413);assert.equal(f.store.get(f.id),null);assert.equal(f.tasks.listMessages(f.task.id).length,0);
});

test('known canceled source turn cannot submit a root or consume a repair ticket during final persistence',async t=>{
  const f=await setup(t,{run:async({ctx,repair,emit})=>{emit({type:'done',status:'canceled',runId:ctx.agentRunId});assert.throws(()=>repair.registration(input(),ctx),e=>e.code==='registration_refused');}});
  await f.repair.start(f.id,f.body);await f.repair.drain();assert.equal(f.repair.status(f.id).repair.phase,'failed');assert.equal(registry(f.root,r=>r.listProposals().length),1);
});

test('successor remains discoverable after more than 100 newer submissions and restart marks only unknown turn state',async t=>{
  let successor;
  const f=await setup(t,{run:async({ctx,repair,root,emit})=>{const p=input();successor=submitRegisteredToolProposal(p,{root,actor:'web-agent',taskContext:ctx,repair:repair.registration(p,ctx)}).proposal.id;emit({type:'done',status:'succeeded',runId:ctx.agentRunId});}});await f.repair.start(f.id,f.body);await f.repair.drain();
  registry(f.root,r=>{for(let n=0;n<101;n++)r.registerProposal({id:randomUUID(),toolName:'newer_record',artifactPath:path.join(f.root,`unused-${n}`),artifactSha256:'d'.repeat(64),permissionProfile:'no_external_access',imageDigest:`sha256:${'b'.repeat(64)}`});assert.equal(r.getRepairReplacement(`auto-tool-repair:${f.id}`).proposalId,successor);});
  const db=new DatabaseSync(path.join(f.root,'runtime/tool-repair/repairs.sqlite'));db.prepare("UPDATE repairs SET phase='running' WHERE proposal_id=?").run(f.id);db.close();await f.reopen();f.repair.recover();assert.equal(f.store.get(f.id).phase,'interrupted');assert.equal(f.repair.status(f.id).repair.phase,'superseded');assert.equal(f.repair.status(f.id).repair.replacementProposalId,successor);
});

test('repair store rejects an alien schema, hardlinks and redirected directories without adopting them',t=>{
  assert.equal(typeof storage.ToolRepairStore,'function');const root=temporary(t);fs.mkdirSync(path.join(root,'runtime/tool-repair'),{recursive:true});const file=path.join(root,'runtime/tool-repair/repairs.sqlite');fs.writeFileSync(file,'unrelated');const bytes=fs.readFileSync(file);assert.throws(()=>new storage.ToolRepairStore({root}));assert.deepEqual(fs.readFileSync(file),bytes);fs.unlinkSync(file);
  const store=new storage.ToolRepairStore({root});store.close();const linked=path.join(root,'runtime/tool-repair/linked.sqlite');fs.linkSync(file,linked);assert.throws(()=>new storage.ToolRepairStore({root}));fs.unlinkSync(linked);
  const db=new DatabaseSync(file);db.exec('CREATE TABLE unexpected (x TEXT)');db.close();assert.throws(()=>new storage.ToolRepairStore({root}));
  const other=temporary(t);fs.symlinkSync(root,path.join(other,'runtime'),'junction');assert.throws(()=>new storage.ToolRepairStore({root:other}));
});

test('failure after durable dispatch never auto-resends and stopped service refuses a fresh request',async t=>{
  const f=await setup(t);const db=new DatabaseSync(f.tasks.databasePath);db.exec("CREATE TRIGGER fail_user BEFORE INSERT ON chat_messages WHEN NEW.role='user' BEGIN SELECT RAISE(ABORT,'disk failure'); END");db.close();const result=await f.repair.start(f.id,f.body);assert.equal(result.repair.phase,'failed');assert.equal(f.tasks.listMessages(f.task.id).length,0);await f.reopen();f.repair.recover();assert.equal((await f.repair.start(f.id,f.body)).deduplicated,true);assert.equal(f.tasks.listMessages(f.task.id).length,0);
  const g=await setup(t);await g.repair.stop();await assert.rejects(g.repair.start(g.id,g.body),e=>e.code==='stopped');assert.equal(g.store.get(g.id),null);
});
