import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {ToolMaintenanceStore} from '../packages/capability-platform/tool-maintenance-store.mjs';
import {createToolMaintenance} from '../packages/capability-platform/tool-maintenance-worker.mjs';
import {createMaintenanceValidator} from '../packages/capability-platform/tool-maintenance-validation.mjs';
import {submitRegisteredToolProposal} from '../packages/capability-platform/tool-lifecycle.mjs';
import {getLatestToolValidationReport} from '../packages/capability-platform/tool-validation-service.mjs';
import {TaskStore} from '../packages/task-core/task-store.mjs';
import {createAppServer} from '../apps/api/router.mjs';
import {DockerBoundary} from './helpers/validation-docker-boundary.mjs';

const draft=JSON.parse(fs.readFileSync(new URL('../examples/04-tool-contract/proposal.draft.json',import.meta.url)));
function setup(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-maintenance-')));
  const store=new ToolMaintenanceStore({root});
  const cleanup=[];
  t.after(async()=>{for(const close of cleanup.reverse())await close();store.close();const unlock=dir=>{fs.chmodSync(dir,0o700);for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory()&&!e.isSymbolicLink())unlock(file);else if(!e.isSymbolicLink())fs.chmodSync(file,0o600);}};unlock(root);fs.rmSync(root,{recursive:true});});
  const proposal=()=>{const input={...structuredClone(draft),runtimeArtifact:{protocolVersion:'sirna-tool-runtime-artifact/v1',imageDigest:`sha256:${'b'.repeat(64)}`,command:['/usr/bin/node','/opt/tool/main.mjs'],platform:'linux/amd64',createdAt:'2026-10-20T00:00:00.000Z',buildSessionId:randomUUID()}};const saved=submitRegisteredToolProposal(input,{root});return {input,saved,id:saved.proposal.id};};
  return {root,store,proposal,cleanup};
}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

test('durable idempotency binds every retry key, deduplicates unfinished jobs and rejects cross-proposal reuse',t=>{
  const {root,store}=setup(t);const id=randomUUID(),key=randomUUID(),alias=randomUUID();
  const first=store.enqueue(id,key);assert.equal(first.job.status,'pending');
  assert.equal(store.enqueue(id,key).job.id,first.job.id);
  assert.equal(store.enqueue(id,alias).job.id,first.job.id);
  assert.throws(()=>store.enqueue(randomUUID(),alias),/different proposal/);
  assert.equal(store.claim().id,first.job.id);store.finish(first.job.id,{validationId:randomUUID(),passed:false});
  assert.equal(store.enqueue(id,alias).job.id,first.job.id);
  assert.notEqual(store.enqueue(id,randomUUID()).job.id,first.job.id);
  const reopened=new ToolMaintenanceStore({root});try{assert.equal(reopened.getByRequest(key).id,first.job.id);}finally{reopened.close();}
});
test('atomic claim permits only one running across independent connections and enforces running-only completion',t=>{
  const {root,store,cleanup}=setup(t);const peer=new ToolMaintenanceStore({root});cleanup.push(()=>peer.close());
  const a=store.enqueue(randomUUID(),randomUUID()).job,b=store.enqueue(randomUUID(),randomUUID()).job;
  assert.throws(()=>store.finish(b.id,{validationId:randomUUID(),passed:true}),/running/);
  assert.equal(store.claim().id,a.id);assert.equal(peer.claim(),null);
  store.finish(a.id,{validationId:randomUUID(),passed:false});assert.equal(peer.claim().id,b.id);
});
test('startup interrupts unknown running work and durably halts pending work and acceptance through a second restart',async t=>{
  const {root,store,proposal}=setup(t);const a=proposal(),b=proposal(),key=randomUUID();
  const old=store.enqueue(a.id,key).job;store.claim();store.enqueue(b.id,randomUUID());
  const runs=[];const worker=createToolMaintenance({root,store,validate:async id=>{runs.push(id);return {validationId:randomUUID(),passed:false};}});
  await worker.start();await worker.drain();
  assert.deepEqual(runs,[]);assert.equal(store.get(old.id).status,'interrupted');assert.equal(store.latest(b.id).status,'pending');
  assert.equal(store.halted(),true);assert.throws(()=>worker.enqueue(a.id,key),e=>e.statusCode===503);await worker.stop();
  const restarted=createToolMaintenance({root,store,validate:async id=>{runs.push(id);return {validationId:randomUUID(),passed:false};}});
  await restarted.start();await restarted.drain();assert.deepEqual(runs,[]);assert.equal(restarted.status().halted,true);
  assert.equal(store.latest(b.id).status,'pending');assert.throws(()=>restarted.enqueue(b.id,randomUUID()),e=>e.statusCode===503);await restarted.stop();
});
test('pending-only startup without a previous halt resumes the accepted job',async t=>{
  const {root,store,proposal}=setup(t);const p=proposal(),runs=[];
  const worker=createToolMaintenance({root,store,validate:async id=>{runs.push(id);return {validationId:randomUUID(),passed:false};}});
  const job=worker.enqueue(p.id,randomUUID()).job;await worker.start();await worker.drain();assert.deepEqual(runs,[p.id]);assert.equal(store.get(job.id).status,'succeeded');assert.equal(store.halted(),false);await worker.stop();
});
test('enqueue refuses when an automatic handoff artifact digest differs from the registered proposal',async t=>{
  const {root,store,proposal}=setup(t),p=proposal();const worker=createToolMaintenance({root,store,validate:async()=>({validationId:randomUUID(),passed:false})});
  assert.throws(()=>worker.enqueue(p.id,randomUUID(),{artifactSha256:'0'.repeat(64)}),e=>e.statusCode===409);assert.equal(store.list().length,0);await worker.stop();
});
test('duplicate maintenance request refuses a different artifact binding',async t=>{
  const {root,store,proposal}=setup(t),p=proposal(),worker=createToolMaintenance({root,store,validate:async()=>({validationId:randomUUID(),passed:false})}),requestId=randomUUID();
  worker.enqueue(p.id,requestId,{artifactSha256:p.saved.integrity.artifactSha256});
  assert.throws(()=>worker.enqueue(p.id,requestId,{artifactSha256:'0'.repeat(64)}),e=>e.statusCode===409);assert.equal(store.list().length,1);await worker.stop();
});
test('recovery rolls back interrupted rows if halt persistence fails and commits both outcomes on retry',t=>{
  const {root,store,cleanup}=setup(t);const job=store.enqueue(randomUUID(),randomUUID()).job;store.claim();
  const file=path.join(root,'runtime/tool-maintenance/jobs.sqlite'),db=new DatabaseSync(file);cleanup.push(()=>db.close());
  db.exec("CREATE TRIGGER reject_recovery_halt BEFORE UPDATE OF halted ON control BEGIN SELECT RAISE(ABORT,'injected halt write failure'); END");
  assert.throws(()=>store.interruptRunning(),/injected halt write failure/);assert.equal(store.get(job.id).status,'running');assert.equal(store.halted(),false);
  db.exec('DROP TRIGGER reject_recovery_halt');assert.equal(store.interruptRunning(),1);assert.equal(store.get(job.id).status,'interrupted');assert.equal(store.halted(),true);
  const reopened=new ToolMaintenanceStore({root});try{assert.equal(reopened.get(job.id).status,'interrupted');assert.equal(reopened.halted(),true);assert.equal(reopened.interruptRunning(),0);assert.equal(reopened.halted(),true);}finally{reopened.close();}
});
test('worker serializes real queued jobs; shutdown rejects acceptance and waits for in-flight persistence without claiming pending',async t=>{
  const {root,store,proposal}=setup(t);const a=proposal(),b=proposal(),entered=deferred(),release=deferred();
  const worker=createToolMaintenance({root,store,validate:async()=>{entered.resolve();await release.promise;return {validationId:randomUUID(),passed:false};}});
  const first=worker.enqueue(a.id,randomUUID()).job;worker.enqueue(b.id,randomUUID());await worker.start();await entered.promise;
  let stopped=false;const stop=worker.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);
  assert.throws(()=>worker.enqueue(a.id,randomUUID()),/stopping/);release.resolve();await stop;
  assert.equal(store.get(first.id).status,'succeeded');assert.equal(store.latest(b.id).status,'pending');assert.equal(store.get(first.id).passed,false);
});
test('a job accepted while the idle pump is settling is not stranded until another request',async t=>{
  const {root,store,proposal}=setup(t);const {id}=proposal();
  const worker=createToolMaintenance({root,store,validate:async()=>({validationId:randomUUID(),passed:false})});
  await worker.start();const job=worker.enqueue(id,randomUUID()).job;await worker.drain();assert.equal(store.get(job.id).status,'succeeded');await worker.stop();
});
test('a persisted complete report with an unfinished job is interrupted on restart without repeating real Docker execution',async t=>{
  const {root,store,proposal}=setup(t);const {id,input,saved}=proposal();
  const docker=new DockerBoundary({manifest:saved.proposal,input},{runResult:({target,envelope})=>({exitCode:target==='baseline'&&envelope.input.sequence.startsWith('>')?1:0,timedOut:false,outputLimitExceeded:false,stdout:'{"length":4,"gcFraction":0.5}',stderr:''})});
  const validate=createMaintenanceValidator({root,docker}),key=randomUUID();const old=store.enqueue(id,key,{artifactSha256:saved.integrity.artifactSha256}).job;store.claim();
  const report=await validate(id,old);assert.equal(report.passed,true);const before=docker.calls.length;
  const worker=createToolMaintenance({root,store,validate});await worker.start();await worker.drain();assert.equal(docker.calls.length,before);assert.equal(store.get(old.id).status,'interrupted');
  assert.equal(worker.summary(id).passed,true);assert.equal(store.halted(),true);assert.throws(()=>worker.enqueue(id,key),e=>e.statusCode===503);assert.throws(()=>worker.enqueue(id,randomUUID()),e=>e.statusCode===503);await worker.stop();
});
test('graceful HTTP shutdown drains a real validation report and private journal while preserving the next pending job',async t=>{
  const {root,store,proposal,cleanup}=setup(t);const p=proposal(),next=proposal(),entered=deferred(),release=deferred();let calls=0;
  const docker=new DockerBoundary({manifest:p.saved.proposal,input:p.input},{runResult:async()=>{if(++calls===1){entered.resolve();await release.promise;}return {exitCode:0,timedOut:false,outputLimitExceeded:false,stdout:'{"length":4,"gcFraction":0.5}',stderr:''};}});
  const worker=createToolMaintenance({root,store,validate:createMaintenanceValidator({root,docker})});
  const tasks=new TaskStore(path.join(root,'tasks.sqlite'));const server=createAppServer({taskStore:tasks,toolMaintenance:worker});server.listen(0,'127.0.0.1');await once(server,'listening');await worker.start();
  cleanup.push(async()=>{release.resolve();await worker.stop();await new Promise(r=>{server.close(r);server.closeAllConnections();});tasks.close();});
  const url=`http://127.0.0.1:${server.address().port}`;
  const accepted=await fetch(`${url}/v1/tool-proposals/${p.id}/validate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID()})});assert.equal(accepted.status,202);const {job}=await accepted.json();await entered.promise;
  worker.enqueue(next.id,randomUUID());let finished=false;const stopped=worker.stop().then(()=>{finished=true;});const closed=new Promise(r=>{server.close(r);server.closeAllConnections();});await closed;assert.equal(finished,false);
  release.resolve();await stopped;assert.equal(store.get(job.id).status,'succeeded');assert.equal(worker.summary(p.id).executionCount,8);assert.equal(store.latest(next.id).status,'pending');assert.equal(docker.containers.size,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'runtime/tool-maintenance/runs',job.id,'result.json'))).validationId,worker.summary(p.id).validationId);
});
test('infrastructure failure stays failed with fixed safe error and a fresh explicit retry key',async t=>{
  const {root,store,proposal}=setup(t);const {id}=proposal();const worker=createToolMaintenance({root,store,validate:async()=>{throw new Error('/private/secret token=TOPSECRET');}});
  worker.enqueue(id,randomUUID());await worker.start();await worker.drain();
  assert.equal(store.latest(id).status,'failed');assert.doesNotMatch(JSON.stringify(worker.list()),/TOPSECRET|\/private/);
  worker.enqueue(id,randomUUID());await worker.drain();assert.equal(store.list().length,2);await worker.stop();
});
test('a changed queue material binding fails before Docker and verified state cannot be queued',async t=>{
  const {root,store,proposal}=setup(t),p=proposal();let calls=0;
  const worker=createToolMaintenance({root,store,validate:async()=>{calls++;return {validationId:randomUUID(),passed:true};}});
  const job=worker.enqueue(p.id,randomUUID()).job;
  const queue=new DatabaseSync(path.join(root,'runtime/tool-maintenance/jobs.sqlite'));queue.prepare('UPDATE jobs SET artifact_sha256=? WHERE id=?').run('0'.repeat(64),job.id);queue.close();
  await worker.start();await worker.drain();assert.equal(calls,0);assert.equal(store.get(job.id).status,'failed');
  const registry=new DatabaseSync(path.join(root,'runtime/tool-registry/registry.sqlite'));registry.prepare("UPDATE tool_proposals SET state='verified' WHERE id=?").run(p.id);registry.close();
  assert.throws(()=>worker.enqueue(p.id,randomUUID()),e=>e.statusCode===409);await worker.stop();
});
test('unknown Docker cleanup halts further claims durably across restart and refuses new acceptance',async t=>{
  const {root,store,proposal}=setup(t),a=proposal(),b=proposal();
  const worker=createToolMaintenance({root,store,validate:async()=>{throw Object.assign(new Error('unknown /private container'),{cleanupError:new Error('unconfirmed'),containerId:'secret'});}});
  worker.enqueue(a.id,randomUUID());const pending=worker.enqueue(b.id,randomUUID()).job;await worker.start();await worker.drain();
  assert.equal(store.get(pending.id).status,'pending');assert.throws(()=>worker.enqueue(b.id,randomUUID()),e=>e.statusCode===503);await worker.stop();
  assert.equal(store.latest(a.id).status,'failed');assert.equal(store.halted(),true);
  let calls=0;const restarted=createToolMaintenance({root,store,validate:async()=>{calls++;}});await restarted.start();await restarted.drain();assert.equal(calls,0);assert.equal(restarted.status().accepting,false);await restarted.stop();
});
for(const unsafe of ['cleanupError','containerId','maintenanceUnsafe'])test(`unsafe ${unsafe} failure rolls back terminal state when halt cannot persist and restart preserves pending work`,async t=>{
  const {root,store,proposal,cleanup}=setup(t),a=proposal(),b=proposal();const errors=[];
  const worker=createToolMaintenance({root,store,onError:error=>errors.push(error.message),validate:async()=>{throw Object.assign(new Error('uncertain Docker execution'),{[unsafe]:unsafe==='cleanupError'?new Error('cleanup unknown'):unsafe==='containerId'?'private-container':true});}});
  const active=worker.enqueue(a.id,randomUUID()).job,pending=worker.enqueue(b.id,randomUUID()).job;
  const file=path.join(root,'runtime/tool-maintenance/jobs.sqlite'),db=new DatabaseSync(file);cleanup.push(()=>db.close());
  db.exec("CREATE TRIGGER reject_unsafe_halt BEFORE UPDATE OF halted ON control BEGIN SELECT RAISE(ABORT,'injected unsafe halt write failure'); END");
  await worker.start();await worker.drain();
  assert.equal(store.get(active.id).status,'running');assert.equal(store.halted(),false);assert.equal(store.get(pending.id).status,'pending');assert.equal(worker.status().accepting,false);
  assert.ok(errors.includes('injected unsafe halt write failure'));assert.throws(()=>worker.enqueue(b.id,randomUUID()),e=>e.statusCode===503);await worker.stop();
  db.exec('DROP TRIGGER reject_unsafe_halt');let executions=0;
  const restart=createToolMaintenance({root,store,validate:async()=>{executions++;}});await restart.start();await restart.drain();
  assert.equal(store.get(active.id).status,'interrupted');assert.equal(store.halted(),true);assert.equal(store.get(pending.id).status,'pending');assert.equal(executions,0);await restart.stop();
  const second=createToolMaintenance({root,store,validate:async()=>{executions++;}});await second.start();await second.drain();
  assert.equal(second.status().halted,true);assert.equal(executions,0);assert.equal(store.get(pending.id).status,'pending');assert.throws(()=>second.enqueue(b.id,randomUUID()),e=>e.statusCode===503);await second.stop();
});
test('store rejects malformed identifiers, over-capacity pending requests and oversized list requests',t=>{
  const {store}=setup(t);assert.throws(()=>store.enqueue('../bad',randomUUID()));assert.throws(()=>store.enqueue(randomUUID(),'key'));
  for(let i=0;i<100;i++)store.enqueue(randomUUID(),randomUUID());
  assert.throws(()=>store.enqueue(randomUUID(),randomUUID()),/capacity/);assert.throws(()=>store.list(101));
});
test('one pending job cannot accumulate unbounded idempotency aliases while existing retries remain available',t=>{
  const {store}=setup(t),id=randomUUID(),key=randomUUID();const original=store.enqueue(id,key).job;
  for(let i=1;i<32;i++)assert.equal(store.enqueue(id,randomUUID()).job.id,original.id);
  assert.throws(()=>store.enqueue(id,randomUUID()),e=>e.statusCode===429);assert.equal(store.enqueue(id,key).job.id,original.id);
});
test('store refuses unrelated SQLite before modification and redirected/hardlinked database and sidecars',t=>{
  const {root,store}=setup(t);store.close();const file=path.join(root,'runtime/tool-maintenance/jobs.sqlite');
  const db=new DatabaseSync(file);db.exec('PRAGMA application_id=123');db.close();const before=fs.readFileSync(file);
  assert.throws(()=>new ToolMaintenanceStore({root}));assert.deepEqual(fs.readFileSync(file),before);
  fs.renameSync(file,file+'.old');fs.linkSync(file+'.old',file);assert.throws(()=>new ToolMaintenanceStore({root}));fs.unlinkSync(file);
  fs.linkSync(file+'.old',file+'-wal');assert.throws(()=>new ToolMaintenanceStore({root}));
});
test('production validation factory executes existing validator/runner, retains private journal and reads a safe failed report summary',async t=>{
  const {root,store,proposal}=setup(t);const {id,input,saved}=proposal();
  const docker=new DockerBoundary({manifest:saved.proposal,input},{runResult:()=>({exitCode:0,timedOut:false,outputLimitExceeded:false,stdout:'{"length":4,"gcFraction":0.5}',stderr:''})});
  const worker=createToolMaintenance({root,store,validate:createMaintenanceValidator({root,docker})});
  const job=worker.enqueue(id,randomUUID()).job;await worker.start();await worker.drain();
  assert.equal(store.get(job.id).status,'succeeded');assert.equal(store.get(job.id).passed,false);
  const summary=worker.summary(id);assert.equal(summary.passed,false);assert.equal(summary.benchmarkGate.netGain,0);assert.equal(summary.domainCases.total,2);
  assert.doesNotMatch(JSON.stringify(summary),/reportPath|stdout|stderr|script|SECRET|containerId/);
  assert.ok(fs.statSync(path.join(root,'runtime/tool-maintenance/runs',job.id,'events.jsonl')).size>0);
  assert.equal(docker.containers.size,1);
  const latest=getLatestToolValidationReport(id,{root});fs.chmodSync(latest.reportPath,0o600);fs.appendFileSync(latest.reportPath,' ');
  assert.throws(()=>worker.summary(id));await worker.stop();
});
test('queue rejects approved/verified proposals and detects damaged material before acceptance',async t=>{
  const {root,store,proposal}=setup(t);const {id,saved}=proposal();const worker=createToolMaintenance({root,store,validate:async()=>{}});
  const source=path.join(root,'runtime/tool-artifacts/proposals',id,'candidate.mjs');
  const file=path.join(path.dirname(source),saved.proposal.scriptFile);fs.chmodSync(file,0o600);fs.appendFileSync(file,'//tamper');
  assert.throws(()=>worker.enqueue(id,randomUUID()));assert.equal(store.list().length,0);await worker.stop();
});

test('HTTP exposes only safe lists/summaries, explicit 202 queueing and shared Origin/body boundaries',async t=>{
  const {root,store,proposal,cleanup}=setup(t);const {id}=proposal();const worker=createToolMaintenance({root,store,validate:async()=>{}});
  const tasks=new TaskStore(path.join(root,'tasks.sqlite'));const server=createAppServer({taskStore:tasks,toolMaintenance:worker});server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanup.push(async()=>{await worker.stop();await new Promise(r=>{server.close(r);server.closeAllConnections();});tasks.close();});
  const url=`http://127.0.0.1:${server.address().port}`;const post=(body,headers={})=>fetch(`${url}/v1/tool-proposals/${id}/validate`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const listed=await (await fetch(url+'/v1/tool-proposals')).json();assert.equal(listed.proposals[0].id,id);assert.doesNotMatch(JSON.stringify(listed),/artifactPath|script|\/runtime|imageDigest/);
  assert.equal((await post({requestId:randomUUID()},{Origin:'http://evil.test'})).status,403);
  assert.equal((await post({requestId:'bad'})).status,400);assert.equal((await post({requestId:randomUUID(),approve:true})).status,400);
  assert.equal((await post({requestId:'x'.repeat(4096)})).status,413);
  const key=randomUUID();const accepted=await post({requestId:key});assert.equal(accepted.status,202);const body=await accepted.json();assert.equal(body.job.status,'pending');assert.equal((await (await post({requestId:key})).json()).job.id,body.job.id);
  assert.equal((await fetch(`${url}/v1/tool-proposals/${id}/validation-summary`)).status,200);
  assert.equal((await fetch(`${url}/v1/tool-proposals/${randomUUID()}/validation-summary`)).status,404);
  assert.equal((await fetch(url+'/tools.mjs')).status,200);
  const registry=new DatabaseSync(path.join(root,'runtime/tool-registry/registry.sqlite'));registry.prepare("UPDATE tool_proposals SET state='verified' WHERE id=?").run(id);registry.close();
  const incomplete=await fetch(`${url}/v1/tool-proposals/${id}/validation-summary`);assert.equal(incomplete.status,500);assert.doesNotMatch(await incomplete.text(),/reportPath|registry|runtime\//);
});
