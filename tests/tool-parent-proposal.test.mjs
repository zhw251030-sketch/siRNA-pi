import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import * as lifecycle from '../packages/capability-platform/tool-lifecycle.mjs';
import {createToolProposal,readToolProposal} from '../packages/capability-platform/tool-proposals.mjs';
import {approveRegisteredToolProposal,getRegisteredToolVersion} from '../packages/capability-platform/tool-approval-service.mjs';
import {validateRegisteredToolProposal,getLatestToolValidationReport} from '../packages/capability-platform/tool-validation-service.mjs';
import {readLatestValidationReport} from '../packages/capability-platform/tool-validation-reports.mjs';
import {ToolRegistry} from '../packages/capability-platform/tool-registry.mjs';
import {publishApprovedToolPackage} from '../packages/capability-platform/tool-approved-packages.mjs';
import {approvalFixture,writable} from './helpers/approval-fixture.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function parentFixture(t){
  const f=await approvalFixture(t);
  const approved=approveRegisteredToolProposal(f.id,'fixture operator',{root:f.root});
  const input={...structuredClone(f.input),parent:{toolName:f.input.toolName,version:'1.0.0'},
    baseline:{runtime:f.input.runtime,script:f.input.script}};
  const version=approved.version;
  const binding={toolName:f.input.toolName,version:'1.0.0',toolId:version.toolId,
    packageSha256:version.packageSha256,imageDigest:version.imageDigest,scriptSha256:hash(f.input.script),
    baselineScriptSha256:hash(f.input.script),comparisonMode:'registered-parent-source'};
  return {...f,input,version,binding,parentSource:path.join(f.approvedRoot,version.packageDirectory,'tool.mjs')};
}
function snapshot(root){
  const result={};
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    // SQLite may create an empty WAL and shared-memory locks when opening a
    // read-only WAL database. Those coordination files are not persisted data.
    const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);
    else if(entry.name!=='registry.sqlite-shm'&&!(entry.name==='registry.sqlite-wal'&&fs.statSync(file).size===0)) {
      result[path.relative(root,file)]=hash(fs.readFileSync(file));
    }
  }}walk(root);return result;
}
function runner(input,onRun=()=>{}){
  return {async checkSources(){return {runtimeArtifactVerified:true,executionPolicy:{route:'fixture-boundary'},
    syntaxChecks:['candidate','baseline'].map(target=>({target,passed:true,command:'node --check',exitCode:0,timedOut:false,stdout:'',stderr:''}))};},
    async run(request){await onRun(request);
      const output=request.target==='baseline'?{}:input.benchmarkCases.find(c=>JSON.stringify(c.input)===JSON.stringify(request.caseInput))?.expectedOutput??input.testCases[0].expectedOutput;
      return {exitCode:0,timedOut:false,cancelled:false,protocolValid:true,output,stdout:JSON.stringify(output),stderr:'',
        filesDigest:hash(''),imageDigest:request.manifest.runtimeArtifact.imageDigest};
    }};
}
function readBinding(f,input=f.input){
  const registry=new ToolRegistry(f.database,{readOnly:true});
  try{return lifecycle.assertRegisteredToolParent(input,{root:f.root,registry});}finally{registry.close();}
}

test('parent material roundtrips in exactly three files and participates in the package digest',async t=>{
  const f=await parentFixture(t);const proposalsRoot=path.dirname(f.saved.registry.artifactPath);
  const saved=createToolProposal(f.input,{proposalsRoot});
  assert.deepEqual(saved.input.parent,f.input.parent);assert.deepEqual(saved.manifest.parent,f.input.parent);
  assert.deepEqual(fs.readdirSync(saved.artifactPath).sort(),['baseline.mjs','manifest.json','tool.mjs']);
  assert.deepEqual(readToolProposal(saved.manifest.id,{proposalsRoot,expectedArtifactSha256:saved.artifactSha256}),saved);
  const digest=createHash('sha256');for(const name of fs.readdirSync(saved.artifactPath).sort()){digest.update(`${name}\0`);digest.update(fs.readFileSync(path.join(saved.artifactPath,name)));}
  assert.equal(saved.artifactSha256,digest.digest('hex'));
  const manifestFile=path.join(saved.artifactPath,'manifest.json');const manifest=JSON.parse(fs.readFileSync(manifestFile));
  manifest.parent.version='2.0.0';writable(manifestFile,JSON.stringify(manifest));
  assert.throws(()=>readToolProposal(saved.manifest.id,{proposalsRoot,expectedArtifactSha256:saved.artifactSha256}),/digest/i);
});
test('parent assertion exposes only the exact verified formal source binding and no-parent stays undefined',async t=>{
  const f=await parentFixture(t);assert.equal(typeof lifecycle.assertRegisteredToolParent,'function');
  assert.deepEqual(readBinding(f),f.binding);
  const original={...f.input};delete original.parent;assert.equal(readBinding(f,original),undefined);
  assert.equal(lifecycle.getRegisteredToolProposal(f.id,{root:f.root}).approved,true);
  assert.equal(getRegisteredToolVersion(f.input.toolName,'1.0.0',{root:f.root}).package.manifest.scriptSha256,f.binding.scriptSha256);
});
for(const [label,change] of [
  ['missing required parent',x=>delete x.parent],
  ['wrong tool',x=>x.parent.toolName='other_tool'],
  ['missing version',x=>x.parent.version='2.0.0'],
  ['weak baseline',x=>x.baseline.script+='\n// changed'],
  ['different runtime',x=>x.baseline.runtime='python'],
])test(`${label} rejects submission before any material or registry writes`,async t=>{
  const f=await parentFixture(t);const input=structuredClone(f.input);change(input);const before=snapshot(f.root);
  assert.throws(()=>lifecycle.submitRegisteredToolProposal(input,{root:f.root}),/parent|baseline|runtime|version/i);
  assert.deepEqual(snapshot(f.root),before);
});
test('same-name parent material check rejects a different tool without writes',async t=>{
  const f=await parentFixture(t);const input={...f.input,parent:{toolName:'other_tool',version:'1.0.0'}};
  const before=snapshot(f.root);assert.throws(()=>createToolProposal(input,{proposalsRoot:path.dirname(f.saved.registry.artifactPath)}),/parent|same/i);
  assert.deepEqual(snapshot(f.root),before);
});
for(const stage of ['submission','preflight'])test(`corrupt formal parent is rejected at ${stage} before new writes or runner access`,async t=>{
  const f=await parentFixture(t);
  const child=stage==='preflight'?lifecycle.submitRegisteredToolProposal(f.input,{root:f.root}):undefined;
  writable(f.parentSource,'changed parent');const before=snapshot(f.root);
  if(child)await assert.rejects(validateRegisteredToolProposal(child.proposal.id,{root:f.root,runner:{checkSources(){assert.fail('runner must not see corrupt parent');},run(){assert.fail('runner must not execute');}}}),/digest|parent/i);
  else assert.throws(()=>lifecycle.submitRegisteredToolProposal(f.input,{root:f.root}),/digest|parent/i);
  assert.deepEqual(snapshot(f.root),before);
});
test('validated child stores the full parent binding and approval preserves that binding in the release',async t=>{
  const f=await parentFixture(t);const saved=lifecycle.submitRegisteredToolProposal(f.input,{root:f.root});
  const report=await validateRegisteredToolProposal(saved.proposal.id,{root:f.root,runner:runner(f.input)});
  assert.equal(report.passed,true);assert.deepEqual(report.parentComparison,f.binding);
  assert.deepEqual(getLatestToolValidationReport(saved.proposal.id,{root:f.root}).report.parentComparison,f.binding);
  const shown=lifecycle.getRegisteredToolProposal(saved.proposal.id,{root:f.root});assert.equal(shown.verified,true);assert.equal(shown.activated,false);
  const approved=approveRegisteredToolProposal(saved.proposal.id,'operator',{root:f.root});
  assert.equal(approved.version.version,'1.0.1');assert.equal(approved.version.parentVersion,'1.0.0');
  assert.deepEqual(getRegisteredToolVersion(f.input.toolName,'1.0.1',{root:f.root}).package.verification.parentComparison,f.binding);
  const parent=getRegisteredToolVersion(f.input.toolName,'1.0.0',{root:f.root}).version;
  assert.equal(parent.proposalId,f.id);assert.equal(parent.state,'inactive');
});
test('a fully valid replacement parent identity during execution cannot substitute the original comparison',async t=>{
  const f=await parentFixture(t);const child=lifecycle.submitRegisteredToolProposal(f.input,{root:f.root});
  const saved=readToolProposal(f.id,{proposalsRoot:path.dirname(f.saved.registry.artifactPath),expectedArtifactSha256:f.saved.registry.artifactSha256});
  const validation=getLatestToolValidationReport(f.id,{root:f.root});const toolId=randomUUID();
  const replacement=publishApprovedToolPackage({saved,verificationBytes:fs.readFileSync(validation.reportPath),
    verificationSha256:validation.reportSha256,toolId,approvedBy:f.version.approvedBy,approvedAt:f.version.approvedAt},{approvedRoot:f.approvedRoot});
  let changed=false;
  await assert.rejects(validateRegisteredToolProposal(child.proposal.id,{root:f.root,runner:runner(f.input,async()=>{
    if(changed)return;changed=true;await Promise.resolve();
    const db=new DatabaseSync(f.database);db.prepare('UPDATE tool_versions SET tool_id=?,package_directory=?,package_sha256=? WHERE tool_id=?')
      .run(toolId,replacement.directoryName,replacement.packageSha256,f.version.toolId);db.close();
    // The replacement passes the full reader: only comparison to the original
    // binding can distinguish this case from an unchanged parent.
    assert.equal(readBinding(f).toolId,toolId);
  })}),/parent binding changed/i);
  const registry=new ToolRegistry(f.database,{readOnly:true});try{
    assert.equal(registry.getProposal(child.proposal.id).state,'submitted');assert.equal(registry.latestValidation(child.proposal.id),undefined);
  }finally{registry.close();}
});
for(const change of ['corrupt source','changed identity'])test(`${change} during awaited execution cannot register a passed child`,async t=>{
  const f=await parentFixture(t);const saved=lifecycle.submitRegisteredToolProposal(f.input,{root:f.root});let changed=false;let failure;
  await assert.rejects(validateRegisteredToolProposal(saved.proposal.id,{root:f.root,runner:runner(f.input,async()=>{
    if(changed)return;changed=true;await Promise.resolve();
    if(change==='corrupt source')writable(f.parentSource,'changed parent');
    else {const db=new DatabaseSync(f.database);db.prepare("UPDATE tool_versions SET image_digest=? WHERE tool_id=?").run(`sha256:${'d'.repeat(64)}`,f.version.toolId);db.close();}
  })}),error=>{failure=error;return /parent|digest|identity|published/i.test(error.message);});
  assert.ok(failure.evidencePath);assert.ok(fs.existsSync(failure.evidencePath));
  const registry=new ToolRegistry(f.database,{readOnly:true});try{
    assert.equal(registry.getProposal(saved.proposal.id).state,'submitted');assert.equal(registry.latestValidation(saved.proposal.id),undefined);
  }finally{registry.close();}
});
for(const change of ['missing','mismatched','extra field'])test(`${change} report parent binding is rejected even with a matching report index digest`,async t=>{
  const f=await parentFixture(t);const saved=lifecycle.submitRegisteredToolProposal(f.input,{root:f.root});
  await validateRegisteredToolProposal(saved.proposal.id,{root:f.root,runner:runner(f.input)});
  const latest=getLatestToolValidationReport(saved.proposal.id,{root:f.root});const report=structuredClone(latest.report);
  if(change==='missing')delete report.parentComparison;
  else if(change==='mismatched')report.parentComparison.packageSha256='e'.repeat(64);
  else report.parentComparison.extra=true;
  const bytes=Buffer.from(JSON.stringify(report));writable(latest.reportPath,bytes);
  const db=new DatabaseSync(f.database);db.prepare('UPDATE tool_validations SET report_sha256=? WHERE id=?').run(hash(bytes),latest.id);db.close();
  assert.throws(()=>getLatestToolValidationReport(saved.proposal.id,{root:f.root}),/parent|binding/i);
  assert.throws(()=>lifecycle.getRegisteredToolProposal(saved.proposal.id,{root:f.root}),/parent|binding/i);
  const registry=new ToolRegistry(f.database,{readOnly:true});try{
    assert.throws(()=>readLatestValidationReport(saved.proposal.id,{root:f.root,registry}),/parent|binding/i);
  }finally{registry.close();}
});
