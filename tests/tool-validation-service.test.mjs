import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {submitRegisteredToolProposal,getRegisteredToolProposal} from '../packages/capability-platform/tool-lifecycle.mjs';
import {validateRegisteredToolProposal,getLatestToolValidationReport} from '../packages/capability-platform/tool-validation-service.mjs';
import {createDockerValidationRunner} from '../packages/capability-platform/tool-validation-runner.mjs';
import {DockerBoundary} from './helpers/validation-docker-boundary.mjs';

const draft=JSON.parse(fs.readFileSync(new URL('../examples/04-tool-contract/proposal.draft.json',import.meta.url)));
function setup(t,changes={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-validation-')));
  t.after(()=>{function unlock(dir){fs.chmodSync(dir,0o700);for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())unlock(file);else if(!entry.isSymbolicLink())fs.chmodSync(file,0o600);}}unlock(root);fs.rmSync(root,{recursive:true});});
  const input={...structuredClone(draft),runtimeArtifact:{protocolVersion:'sirna-tool-runtime-artifact/v1',imageDigest:`sha256:${'b'.repeat(64)}`,command:['/usr/bin/node','/opt/tool/main.mjs'],platform:'linux/amd64',createdAt:'2026-10-20T00:00:00.000Z',buildSessionId:randomUUID()},...changes};
  const saved=submitRegisteredToolProposal(input,{root});
  return {root,input,saved,id:saved.proposal.id,database:path.join(root,'runtime/tool-registry/registry.sqlite')};
}
function fakeRunner(options={}) {
  const calls=[];let sources=0;
  return {calls,get sourceChecks(){return sources;},async checkSources(){sources++;return {runtimeArtifactVerified:true,executionPolicy:{route:'test-boundary'},syntaxChecks:['candidate','baseline'].map(target=>({target,passed:options.syntax!==false,command:'node --check',exitCode:options.syntax===false?1:0,timedOut:false,stdout:'',stderr:''}))};},
    async run(request){calls.push(structuredClone(request));if(options.error)throw new Error('Injected Docker transport failed');
      const baselineFails=request.target==='baseline'&&request.caseInput.sequence.startsWith('>');
      const output={length:4,gcFraction:0.5};
      const result={exitCode:baselineFails?1:0,timedOut:false,cancelled:false,protocolValid:!baselineFails,output:baselineFails?null:output,stdout:baselineFails?'':JSON.stringify(output),stderr:baselineFails?'plain DNA only':'',filesDigest:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',containerId:`test-${calls.length}`,imageDigest:request.manifest.runtimeArtifact.imageDigest};
      return options.change?options.change(result,request,calls.length):result;
    }};
}
function mutate(file,text){fs.chmodSync(file,0o600);fs.writeFileSync(file,text);}

test('service executes through the real Docker runner with a fresh strict UUID for every call',async t=>{
  const {root,id,saved,input}=setup(t);const ids=[];
  const docker=new DockerBoundary({manifest:saved.proposal,input},{runResult:({envelope,target})=>{
    ids.push(envelope.toolCallId);
    const fails=target==='baseline'&&envelope.input.sequence.startsWith('>');
    return {exitCode:fails?1:0,timedOut:false,outputLimitExceeded:false,stdout:fails?'':'{"length":4,"gcFraction":0.5}',stderr:fails?'plain DNA only':''};
  }});
  const report=await validateRegisteredToolProposal(id,{root,runner:createDockerValidationRunner({docker})});
  assert.equal(report.passed,true);assert.equal(report.executionCount,8);
  assert.equal(ids.length,8);assert.equal(new Set(ids).size,8);
  assert.ok(ids.every(value=>/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)));
  assert.equal(getRegisteredToolProposal(id,{root}).registry.state,'verified');
  assert.deepEqual([...docker.containers.keys()],['old-unrelated']);
});

for(const code of ['DOCKER_TIMEOUT','DOCKER_OUTPUT_LIMIT'])test(`baseline-only ${code} is infrastructure failure with no validation registration`,async t=>{
  const {root,id,saved,input,database}=setup(t);const before=getRegisteredToolProposal(id,{root});
  let baselineCalls=0;let candidateCalls=0;
  const docker=new DockerBoundary({manifest:saved.proposal,input},{runResult:({target})=>{
    if(target==='baseline'){
      baselineCalls++;
      throw Object.assign(new Error('Docker baseline control transport interrupted'),{code});
    }
    candidateCalls++;
    return {exitCode:0,timedOut:false,outputLimitExceeded:false,stdout:'{"length":4,"gcFraction":0.5}',stderr:''};
  }});
  let captured;
  await assert.rejects(validateRegisteredToolProposal(id,{root,runner:createDockerValidationRunner({docker})}),error=>{
    captured=error;return error.code===code;
  });
  assert.ok(candidateCalls>0);assert.equal(baselineCalls,1);
  assert.ok(captured.evidencePath);assert.equal(fs.existsSync(captured.evidencePath),true);
  assert.equal(captured.reportPath,undefined);
  const after=getRegisteredToolProposal(id,{root});
  assert.equal(after.registry.state,'submitted');assert.deepEqual(after.events,before.events);
  assert.equal(after.registry.latestValidationId,before.registry.latestValidationId);
  assert.equal(getLatestToolValidationReport(id,{root}),undefined);
  const db=new DatabaseSync(database,{readOnly:true});
  assert.equal(db.prepare('SELECT count(*) AS n FROM tool_validations').get().n,0);db.close();
  assert.deepEqual([...docker.containers.keys()],['old-unrelated']);
});
test('validation records eight independent cases and survives reopening with truthful state',async t=>{
  const {root,id,database}=setup(t);const runner=fakeRunner();
  assert.equal(getLatestToolValidationReport(id,{root}),undefined);
  const report=await validateRegisteredToolProposal(id,{root,runner});
  assert.equal(report.protocolVersion,'sirna-tool-validation/v3');assert.equal(report.passed,true);
  assert.equal(report.repeatability.passed,true);assert.equal(report.domainGatePassed,true);
  assert.deepEqual(report.benchmarkGate,{candidateScore:2,baselineScore:1,netGain:1,minNetGain:1,passed:true});
  assert.equal(runner.calls.length,8);assert.equal(new Set(runner.calls.map(x=>x.toolCallId)).size,8);
  assert.equal(runner.calls.filter(x=>x.target==='baseline').length,2);
  const latest=getLatestToolValidationReport(id,{root});assert.deepEqual(latest.report,report);
  assert.equal(latest.reportSha256,createHash('sha256').update(fs.readFileSync(latest.reportPath)).digest('hex'));
  const shown=getRegisteredToolProposal(id,{root});assert.equal(shown.registry.state,'verified');assert.equal(shown.verified,true);
  assert.equal(shown.executed,true);assert.equal(shown.approved,false);assert.equal(shown.activated,false);
  assert.equal(shown.events.at(-1).eventType,'validation_passed');
  const db=new DatabaseSync(database,{readOnly:true});assert.equal(db.prepare('SELECT count(*) AS n FROM tool_validations').get().n,1);db.close();
});
for(const [name,runnerOptions,reportGate] of [
  ['syntax',{syntax:false},r=>r.syntaxChecks.every(x=>x.passed)],
  ['repeatability',{change:(r,q,n)=>n===2?{...r,filesDigest:'a'.repeat(64)}:r},r=>r.repeatability.passed],
  ['domain',{change:(r,q,n)=>n===3?{...r,output:{length:99},stdout:'{"length":99}'}:r},r=>r.domainGatePassed],
  ['benchmark',{change:(r,q,n)=>n===5?{...r,output:{length:99},stdout:'{"length":99}'}:r},r=>r.benchmarkGate.passed],
]) test(`${name} failure saves failed report without approval`,async t=>{
  const {root,id}=setup(t);const runner=fakeRunner(runnerOptions);
  const report=await validateRegisteredToolProposal(id,{root,runner});assert.equal(report.passed,false);assert.equal(reportGate(report),false);
  assert.equal(getRegisteredToolProposal(id,{root}).registry.state,'verification_failed');
  if(name==='syntax')assert.equal(runner.calls.length,0);
});
test('static violation in baseline blocks all execution and remains inspectable',async t=>{
  const {root,id}=setup(t,{baseline:{runtime:'node',script:'fetch("https://example.com")'}});const runner=fakeRunner();
  const report=await validateRegisteredToolProposal(id,{root,runner});assert.equal(report.staticCheck.passed,false);assert.equal(report.passed,false);
  assert.equal(runner.calls.length,0);assert.equal(report.executionPerformed,false);
});
test('unsupported scope does not access Docker or change submitted state',async t=>{
  const {root,id}=setup(t,{repeatabilityMode:'contract'});const runner=fakeRunner();
  await assert.rejects(validateRegisteredToolProposal(id,{root,runner}),/support/i);
  assert.equal(runner.sourceChecks,0);assert.equal(getRegisteredToolProposal(id,{root}).registry.state,'submitted');
});
test('registered material changed before validation is rejected before Docker access',async t=>{
  const {root,id,saved}=setup(t);const runner=fakeRunner();mutate(path.join(saved.registry.artifactPath,'tool.mjs'),'changed');
  await assert.rejects(validateRegisteredToolProposal(id,{root,runner}),/digest/i);assert.equal(runner.sourceChecks,0);
});
test('material changed during run fails integrity and retains report without claiming verified',async t=>{
  const {root,id,saved,database}=setup(t);const runner=fakeRunner({change:(r,q,n)=>{if(n===1)mutate(path.join(saved.registry.artifactPath,'tool.mjs'),'changed');return r;}});
  const report=await validateRegisteredToolProposal(id,{root,runner});assert.equal(report.artifactIntegrityPassed,false);assert.equal(report.passed,false);
  const db=new DatabaseSync(database,{readOnly:true});assert.equal(db.prepare('SELECT state FROM tool_proposals WHERE id=?').get(id).state,'verification_failed');db.close();
  assert.equal(getLatestToolValidationReport(id,{root}).report.passed,false);
});
test('transport failure saves private diagnostic and leaves proposal unverified',async t=>{
  const {root,id,database}=setup(t);let captured;
  await assert.rejects(validateRegisteredToolProposal(id,{root,runner:fakeRunner({error:true})}),error=>{captured=error;return /transport/.test(error.message);});
  assert.ok(captured.evidencePath);assert.equal(fs.existsSync(captured.evidencePath),true);
  assert.equal(getRegisteredToolProposal(id,{root}).registry.state,'submitted');
  const db=new DatabaseSync(database,{readOnly:true});assert.equal(db.prepare('SELECT count(*) AS n FROM tool_validations').get().n,0);db.close();
});
test('report tampering and database report path redirection are refused',async t=>{
  const {root,id,database}=setup(t);await validateRegisteredToolProposal(id,{root,runner:fakeRunner()});
  const latest=getLatestToolValidationReport(id,{root});const bytes=fs.readFileSync(latest.reportPath);
  mutate(latest.reportPath,'SECRET_MALFORMED');assert.throws(()=>getLatestToolValidationReport(id,{root}),/digest|modified/i);
  mutate(latest.reportPath,bytes);
  const db=new DatabaseSync(database);db.prepare('UPDATE tool_validations SET report_path=?').run(path.join(root,'elsewhere.json'));db.close();
  assert.throws(()=>getLatestToolValidationReport(id,{root}),/path|root/i);
});
test('database event failure rolls back state and keeps an unregistered report for diagnosis',async t=>{
  const {root,id,database}=setup(t);const db=new DatabaseSync(database);db.exec("CREATE TRIGGER stop_validation BEFORE INSERT ON tool_events WHEN NEW.event_type='validation_passed' BEGIN SELECT RAISE(ABORT,'blocked'); END;");db.close();
  let captured;await assert.rejects(validateRegisteredToolProposal(id,{root,runner:fakeRunner()}),e=>{captured=e;return /blocked/.test(e.message);});
  assert.ok(captured.reportPath);assert.equal(fs.existsSync(captured.reportPath),true);
  assert.equal(getRegisteredToolProposal(id,{root}).registry.state,'submitted');assert.equal(getLatestToolValidationReport(id,{root}),undefined);
});
test('terminal proposal rejected before any candidate or syntax operation',async t=>{
  const {root,id,database}=setup(t);const db=new DatabaseSync(database);db.prepare("UPDATE tool_proposals SET state='rejected'").run();db.close();
  const runner=fakeRunner();await assert.rejects(validateRegisteredToolProposal(id,{root,runner}),/state|rejected|validate/i);assert.equal(runner.sourceChecks,0);
});
