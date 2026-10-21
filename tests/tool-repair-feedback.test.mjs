import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import * as maintenanceModule from '../packages/capability-platform/tool-maintenance-worker.mjs';
import {ToolMaintenanceStore} from '../packages/capability-platform/tool-maintenance-store.mjs';
import {submitRegisteredToolProposal} from '../packages/capability-platform/tool-lifecycle.mjs';
import {approveRegisteredToolProposal} from '../packages/capability-platform/tool-approval-service.mjs';
import {validateRegisteredToolProposal,getLatestToolValidationReport} from '../packages/capability-platform/tool-validation-service.mjs';
import {createDockerValidationRunner} from '../packages/capability-platform/tool-validation-runner.mjs';
import {DockerBoundary} from './helpers/validation-docker-boundary.mjs';
import {TaskStore} from '../packages/task-core/task-store.mjs';
import {createAppServer} from '../apps/api/router.mjs';

const draft=JSON.parse(fs.readFileSync(new URL('../examples/04-tool-contract/proposal.draft.json',import.meta.url)));
function setup(t,changes={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-feedback-'))),cleanup=[];
  t.after(async()=>{for(const close of cleanup.reverse())await close();function unlock(dir){fs.chmodSync(dir,0o700);for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory()&&!e.isSymbolicLink())unlock(file);else if(!e.isSymbolicLink())fs.chmodSync(file,0o600);}}unlock(root);fs.rmSync(root,{recursive:true});});
  const input={...structuredClone(draft),runtimeArtifact:{protocolVersion:'sirna-tool-runtime-artifact/v1',imageDigest:`sha256:${'b'.repeat(64)}`,command:['/usr/bin/node','/opt/tool/main.mjs'],platform:'linux/amd64',createdAt:'2026-10-20T00:00:00.000Z',buildSessionId:randomUUID()},...changes};
  const saved=submitRegisteredToolProposal(input,{root}),id=saved.proposal.id,store=new ToolMaintenanceStore({root});cleanup.push(()=>store.close());
  const worker=maintenanceModule.createToolMaintenance({root,store,validate:async()=>{throw new Error('Reads must not validate');}});cleanup.push(()=>worker.stop());
  const database=path.join(root,'runtime/tool-registry/registry.sqlite');
  async function validate({allPass=false,runResult,syntax=false,image=false}={}){
    const docker=new DockerBoundary({manifest:saved.proposal,input},{runResult:runResult??(({target,envelope})=>({exitCode:allPass&&target==='baseline'&&envelope.input.sequence.startsWith('>')?1:0,timedOut:false,outputLimitExceeded:false,stdout:JSON.stringify({length:allPass?4:99,gcFraction:0.5}),stderr:'PRIVATE_STDERR'}))});
    const exec=docker.exec.bind(docker);docker.exec=async(...args)=>syntax&&args[1][1]==='--check'?{exitCode:1,stdout:'',stderr:'PRIVATE_SYNTAX'}:exec(...args);if(image)docker.sourceMismatch=true;
    const report=await validateRegisteredToolProposal(id,{root,runner:createDockerValidationRunner({docker})});return {report,docker};
  }
  return {root,input,saved,id,store,worker,database,cleanup,validate};
}
function snapshot(root){
  const result={};function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())visit(file);else{
    // SQLite readOnly connections can create WAL/SHM coordination sidecars.
    // Compare original database bytes AND all logical rows, never ignore DB
    // business state or material/report files along with those sidecars.
    if(/\.sqlite-(wal|shm)$/.test(e.name))continue;
    if(e.name.endsWith('.sqlite')){const db=new DatabaseSync(file,{readOnly:true});try{const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();result[path.relative(root,file)+':rows']=Object.fromEntries(tables.map(({name})=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()]));}finally{db.close();}}
    const stat=fs.statSync(file);result[path.relative(root,file)]={hash:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),size:stat.size,mtime:stat.mtimeMs,mode:stat.mode};
  }}}visit(root);return result;
}
function rewriteReport(f,change){const latest=getLatestToolValidationReport(f.id,{root:f.root}),report=structuredClone(latest.report);change(report);const bytes=Buffer.from(JSON.stringify(report));fs.chmodSync(latest.reportPath,0o600);fs.writeFileSync(latest.reportPath,bytes);const db=new DatabaseSync(f.database);try{db.prepare('UPDATE tool_validations SET report_sha256=? WHERE id=?').run(createHash('sha256').update(bytes).digest('hex'),report.validationId);}finally{db.close();}}

test('failed feedback binds actual report and frozen expected cases without writes or private execution details',async t=>{
  const f=setup(t);await f.validate();const before=snapshot(f.root);
  assert.equal(typeof f.worker.feedback,'function','read-only repair feedback is available');
  const feedback=f.worker.feedback(f.id),latest=getLatestToolValidationReport(f.id,{root:f.root});
  assert.equal(feedback.protocolVersion,'sirna-tool-repair-feedback/v1');assert.equal(feedback.proposalId,f.id);assert.equal(feedback.toolName,'summarize_target_sequence');
  assert.equal(feedback.artifactSha256,f.saved.integrity.artifactSha256);assert.equal(feedback.validationId,latest.id);assert.equal(feedback.reportSha256,latest.reportSha256);
  assert.equal(feedback.gates.domain,'failed');assert.equal(feedback.domainCases.total,2);assert.equal(feedback.domainCases.entries[0].status,'failed');
  assert.deepEqual(JSON.parse(feedback.domainCases.entries[0].input.json),{sequence:'ACGT'});assert.deepEqual(JSON.parse(feedback.domainCases.entries[0].expected.json),{length:4,gcFraction:0.5});assert.deepEqual(JSON.parse(feedback.domainCases.entries[0].actual.json),{length:99,gcFraction:0.5});
  assert.deepEqual(feedback.benchmarkGate,{candidateScore:0,baselineScore:0,netGain:0,minNetGain:1,passed:false});
  assert.deepEqual(feedback.comparisonContract.expectedOutput,{objects:'recursive-subset',arrays:'same-length-and-order',scalars:'Object.is-without-coercion-or-tolerance'});
  assert.deepEqual(feedback.comparisonContract.repeatability,{successfulRuns:2,identicalFields:['stdout','stderr','filesDigest']});
  assert.deepEqual(feedback.comparisonContract.benchmark,{candidateScore:'count-of-matching-candidate-runs',baselineScore:'count-of-matching-baseline-runs',netGain:'candidateScore - baselineScore',passCondition:'nonempty-and-netGain >= minNetGain'});
  assert.match(feedback.prompt,/预览|preview/);assert.match(feedback.prompt,new RegExp(feedback.reportSha256));assert.match(feedback.prompt,/submitted/);assert.match(feedback.prompt,/parent/);assert.match(feedback.prompt,/镜像/);
  assert.doesNotMatch(JSON.stringify(feedback),/PRIVATE_|"stdout":|"stderr":|"containerId":|"executionPolicy":|"scriptFile":|"artifactPath":/);assert.ok(!JSON.stringify(feedback).includes(f.root));
  assert.deepEqual(f.worker.feedback(f.id),feedback);assert.deepEqual(snapshot(f.root),before);
  const direct=await import('../packages/capability-platform/tool-repair-feedback.mjs');assert.deepEqual(direct.getToolRepairFeedback(f.id,{root:f.root}),feedback);
});
test('all passing domain cases still explain failed fixed net-gain comparison',async t=>{
  const f=setup(t);await f.validate({runResult:()=>({exitCode:0,timedOut:false,outputLimitExceeded:false,stdout:'{"length":4,"gcFraction":0.5}',stderr:''})});
  assert.equal(typeof f.worker.feedback,'function');const r=f.worker.feedback(f.id);assert.equal(r.gates.domain,'passed');assert.equal(r.gates.benchmark,'failed');assert.equal(r.domainCases.entries.every(x=>x.status==='passed'),true);assert.equal(r.benchmarkGate.netGain,0);assert.equal(r.benchmarkGate.minNetGain,1);
});
test('no report, passed and approved return null; unknown candidates fail with 404',async t=>{
  const f=setup(t);assert.equal(typeof f.worker.feedback,'function');assert.equal(f.worker.feedback(f.id),null);assert.throws(()=>f.worker.feedback(randomUUID()),e=>e.statusCode===404);
  await f.validate({allPass:true});assert.equal(f.worker.feedback(f.id),null);approveRegisteredToolProposal(f.id,'test-reviewer',{root:f.root});assert.equal(f.worker.feedback(f.id),null);
});
for(const kind of ['syntax','static'])test(`${kind} blocked reports mark every unexecuted case not_run`,async t=>{
  const f=setup(t,kind==='static'?{script:'fetch("https://example.com")'}:{});await f.validate({syntax:kind==='syntax',image:kind==='image'});
  assert.equal(typeof f.worker.feedback,'function');const r=f.worker.feedback(f.id);assert.equal(r.gates.domain,'not_run');assert.equal(r.gates.benchmark,'not_run');assert.equal(r.gates.repeatability,'not_run');
  assert.equal(r.domainCases.entries.every(x=>x.status==='not_run'&&x.actual===null),true);assert.equal(r.benchmarkCases.entries.every(x=>x.candidate.status==='not_run'&&x.baseline.status==='not_run'),true);
});
test('image verification infrastructure failure produces no repair feedback',async t=>{
  const f=setup(t);await assert.rejects(f.validate({image:true}),/digest/);assert.equal(typeof f.worker.feedback,'function');assert.equal(f.worker.feedback(f.id),null);
});
for(const [name,run,want] of [
  ['protocol',{exitCode:0,timedOut:false,outputLimitExceeded:false,stdout:'PRIVATE_INVALID_PROTOCOL',stderr:'PRIVATE_STDERR'},'invalid_protocol'],
  ['timeout',{exitCode:null,timedOut:true,outputLimitExceeded:false,stdout:'{}',stderr:''},'timed_out'],
  ['overflow',{exitCode:0,timedOut:false,outputLimitExceeded:true,stdout:'{}',stderr:''},'output_limit'],
  ['exit',{exitCode:7,timedOut:false,outputLimitExceeded:false,stdout:'{}',stderr:''},'execution_failed'],
])test(`${name} runs expose safe failure classification`,async t=>{
  const f=setup(t);await f.validate({runResult:()=>run});assert.equal(typeof f.worker.feedback,'function');const r=f.worker.feedback(f.id);assert.equal(r.domainCases.entries[0].run.status,want);assert.equal(r.domainCases.entries[0].status,'failed');assert.doesNotMatch(JSON.stringify(r),/PRIVATE_/);
});
for(const kind of ['report','material','association','score','missing-case','incomplete','missing-output','invalid-stdout'])test(`${kind} corruption is refused instead of emitted as repair evidence`,async t=>{
  const f=setup(t);await f.validate();assert.equal(typeof f.worker.feedback,'function');
  if(kind==='material'){const file=path.join(f.saved.registry.artifactPath,'tool.mjs');fs.chmodSync(file,0o600);fs.appendFileSync(file,'//modified');}
  else if(kind==='report'){const {reportPath}=getLatestToolValidationReport(f.id,{root:f.root});fs.chmodSync(reportPath,0o600);fs.appendFileSync(reportPath,' ');}
  else rewriteReport(f,r=>{if(kind==='association')r.domainCases.reverse();if(kind==='score')r.benchmarkGate.candidateScore=2;if(kind==='missing-case')r.domainCases.pop();if(kind==='incomplete')delete r.repeatability;if(kind==='missing-output')delete r.domainCases[0].run.output;if(kind==='invalid-stdout')r.domainCases[0].run.stdout='not JSON';});
  assert.throws(()=>f.worker.feedback(f.id));
});
test('large business JSON previews remain bounded with truthful omission markers and a total response cap',async t=>{
  const cases=Array.from({length:25},(_,n)=>({name:`case ${n}`,input:{sequence:'ACGT',text:'🧬'.repeat(1800)},expectedOutput:{text:'🧬'.repeat(1800)}}));
  const f=setup(t,{testCases:cases,benchmarkCases:cases});
  // Existing execution scope permits <=10 cases. Build a valid complete future
  // report using the trusted report writer/registry, never relax the validator.
  const {writeValidationReport}=await import('../packages/capability-platform/tool-validation-reports.mjs');const {ToolRegistry}=await import('../packages/capability-platform/tool-registry.mjs');
  const output={text:'actual'.repeat(4000)},run={exitCode:0,timedOut:false,cancelled:false,protocolValid:true,output,stdout:JSON.stringify(output),stderr:'PRIVATE',filesDigest:'a'.repeat(64)};
  const report={protocolVersion:'sirna-tool-validation/v3',validationId:randomUUID(),proposalId:f.id,artifactSha256:f.saved.integrity.artifactSha256,artifactIntegrityPassed:true,verifiedAt:'2026-10-21T00:00:00.000Z',runtimeArtifactVerified:true,staticCheck:{passed:true,violations:[]},syntaxChecks:['candidate','baseline'].map(target=>({target,passed:true})),repeatability:{mode:'exact',passed:true,firstRun:run,secondRun:run},domainCases:cases.map(x=>({name:x.name,expectationPassed:false,run})),domainGatePassed:false,benchmarks:cases.map(x=>({name:x.name,candidatePassed:false,baselinePassed:false,candidateRun:run,baselineRun:run})),benchmarkGate:{candidateScore:0,baselineScore:0,netGain:0,minNetGain:1,passed:false},executionPerformed:true,executionCount:77,passed:false};
  const registry=new ToolRegistry(f.database,{migrate:true});try{registry.recordValidation({id:report.validationId,proposalId:f.id,passed:false,...writeValidationReport(report,{root:f.root})});}finally{registry.close();}
  assert.equal(typeof f.worker.feedback,'function');const r=f.worker.feedback(f.id);assert.equal(r.domainCases.total,25);assert.equal(r.domainCases.shown,20);assert.equal(r.domainCases.omitted,5);assert.equal(r.benchmarkCases.entries.length,20);assert.equal(r.benchmarkCases.omitted,5);
  for(const c of [...r.domainCases.entries,...r.benchmarkCases.entries])for(const p of [c.input,c.expected,c.actual,c.candidate?.actual,c.baseline?.actual].filter(Boolean)){assert.ok(Buffer.byteLength(JSON.stringify(p))<=4096);assert.equal(p.truncated,true);assert.match(p.json,/omitted/);assert.ok(p.totalBytes>4096);}
  assert.ok(Buffer.byteLength(JSON.stringify(r))<=256*1024);
});
test('HTTP feedback is GET-only, safe on errors, readonly and suppressed for pending/running jobs',async t=>{
  const f=setup(t);await f.validate();const tasks=new TaskStore(path.join(f.root,'tasks.sqlite'));const server=createAppServer({taskStore:tasks,toolMaintenance:f.worker});server.listen(0,'127.0.0.1');await once(server,'listening');f.cleanup.push(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});tasks.close();});
  const url=`http://127.0.0.1:${server.address().port}/v1/tool-proposals/`,endpoint=url+f.id+'/repair-feedback';const before=snapshot(f.root);
  const response=await fetch(endpoint);assert.equal(response.status,200);assert.equal((await response.json()).feedback.proposalId,f.id);
  for(const method of ['POST','PUT','DELETE'])assert.equal((await fetch(endpoint,{method})).status,404);
  assert.equal((await fetch(url+randomUUID()+'/repair-feedback')).status,404);assert.deepEqual(snapshot(f.root),before);
  const queued=f.store.enqueue(f.id,randomUUID());for(const status of ['pending','running']){if(status==='running')f.store.claim();assert.deepEqual(await (await fetch(endpoint)).json(),{feedback:null});}
  f.store.finish(queued.job.id,null);const latest=getLatestToolValidationReport(f.id,{root:f.root});fs.chmodSync(latest.reportPath,0o600);fs.appendFileSync(latest.reportPath,' ');
  const broken=await fetch(endpoint);assert.equal(broken.status,500);assert.doesNotMatch(await broken.text(),/reportPath|digest|runtime|PRIVATE/);
});
