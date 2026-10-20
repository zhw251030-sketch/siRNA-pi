import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ToolRegistry} from '../packages/capability-platform/tool-registry.mjs';
import {submitRegisteredToolProposal,getRegisteredToolProposal} from '../packages/capability-platform/tool-lifecycle.mjs';
import {getLatestToolValidationReport} from '../packages/capability-platform/tool-validation-service.mjs';
import {approvalFixture,writable,verifyFixtureProposal} from './helpers/approval-fixture.mjs';
const service=await import('../packages/capability-platform/tool-approval-service.mjs').catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND'&&error.message.includes('tool-approval-service.mjs'))return {};throw error;
});
const actor='hanwen (delegated learning step)';
test('approval service provides the explicit publication boundary',()=>assert.equal(typeof service.approveRegisteredToolProposal,'function'));
test('approval publishes the verified snapshot and reopens a truthful approved state',async t=>{
  const {root,id,saved}=await approvalFixture(t);
  const before=getLatestToolValidationReport(id,{root});const original=fs.readFileSync(before.reportPath);
  const result=await service.approveRegisteredToolProposal(id,actor,{root});
  assert.equal(result.version.version,'1.0.0');assert.notEqual(result.version.toolId,id);
  assert.equal(result.version.state,'active');assert.equal(result.version.proposalId,id);
  assert.equal(result.approved,true);assert.equal(result.activated,true);assert.equal(result.agentCallable,false);
  assert.equal(result.alreadyApproved,false);assert.equal(result.catalog.tools.length,1);
  const detail=service.getRegisteredToolVersion(saved.proposal.toolName,'1.0.0',{root});
  assert.equal(detail.package.manifest.id,result.version.toolId);
  assert.equal(detail.package.approval.approvedAt,result.version.approvedAt);
  assert.equal(detail.package.approval.approvedBy,actor);
  assert.deepEqual(fs.readFileSync(path.join(detail.package.directory,'verification.json')),original);
  assert.deepEqual(fs.readFileSync(path.join(detail.package.directory,'tool.mjs')),fs.readFileSync(path.join(saved.registry.artifactPath,'tool.mjs')));
  const shown=getRegisteredToolProposal(id,{root});
  assert.equal(shown.proposal.status,'draft');assert.equal(shown.registry.state,'approved');
  assert.equal(shown.approved,true);assert.equal(shown.activated,true);assert.equal(shown.agentCallable,false);
  assert.equal(shown.verified,true);assert.equal(shown.events.length,3);
  assert.equal(shown.events.at(-1).eventType,'version_activated');
  assert.deepEqual(getLatestToolValidationReport(id,{root}),before);
  assert.equal(service.listRegisteredToolVersions({root}).length,1);
});
test('repeated approval preserves version, approval actor, timestamp, package and event history',async t=>{
  const {root,id}=await approvalFixture(t);const first=await service.approveRegisteredToolProposal(id,actor,{root});
  const events=getRegisteredToolProposal(id,{root}).events;
  const again=await service.approveRegisteredToolProposal(id,'another operator',{root});
  assert.equal(again.alreadyApproved,true);assert.deepEqual(again.version,first.version);
  assert.deepEqual(getRegisteredToolProposal(id,{root}).events,events);
});
for(const [name,options] of [['submitted',{validate:false}],['failed',{minNetGain:2}]])test(`${name} proposal cannot create an approved package or catalog`,async t=>{
  const {root,id,approvedRoot,catalogPath}=await approvalFixture(t,options);
  await assert.rejects(async()=>service.approveRegisteredToolProposal(id,actor,{root}),/passing|verified/i);
  assert.equal(fs.existsSync(approvedRoot),false);assert.equal(fs.existsSync(catalogPath),false);
});
for(const target of ['source','report'])test(`${target} tampering prevents publication before writes`,async t=>{
  const {root,id,saved,approvedRoot}=await approvalFixture(t);const report=getLatestToolValidationReport(id,{root});
  const file=target==='source'?path.join(saved.registry.artifactPath,'tool.mjs'):report.reportPath;
  writable(file,Buffer.concat([fs.readFileSync(file),Buffer.from('\n')]));
  await assert.rejects(async()=>service.approveRegisteredToolProposal(id,actor,{root}),/digest|modified/i);
  assert.equal(fs.existsSync(approvedRoot),false);
});
test('catalog write failure reports committed activation and retry repairs without another event',async t=>{
  const {root,id,catalogPath}=await approvalFixture(t);fs.mkdirSync(catalogPath);
  let failure;
  await assert.rejects(async()=>service.approveRegisteredToolProposal(id,actor,{root}),error=>{failure=error;return error.versionActivated===true;});
  const registry=new ToolRegistry(path.join(root,'runtime/tool-registry/registry.sqlite'),{readOnly:true});
  assert.equal(registry.getProposal(id).state,'approved');const version=registry.listToolVersions()[0];
  const events=registry.listEvents(id);registry.close();
  assert.equal(failure.version,'1.0.0');assert.equal(failure.proposalId,id);
  fs.renameSync(catalogPath,`${catalogPath}.test-blocker`);
  const retry=await service.approveRegisteredToolProposal(id,actor,{root});
  assert.deepEqual(retry.version,version);assert.equal(retry.alreadyApproved,true);
  assert.deepEqual(getRegisteredToolProposal(id,{root}).events,events);
  assert.equal(retry.catalog.tools.length,1);
});
test('database event failure retains an unregistered package and rolls back proposal and version',async t=>{
  const {root,id,database}=await approvalFixture(t);const db=new DatabaseSync(database);
  db.exec("CREATE TRIGGER reject_approval BEFORE INSERT ON tool_events WHEN NEW.event_type='version_activated' BEGIN SELECT RAISE(ABORT,'test rejection'); END");db.close();
  let failure;
  await assert.rejects(async()=>service.approveRegisteredToolProposal(id,actor,{root}),error=>{failure=error;return /test rejection/.test(error.message);});
  assert.ok(failure.packagePath);assert.equal(fs.existsSync(failure.packagePath),true);
  const registry=new ToolRegistry(database,{readOnly:true});
  assert.equal(registry.getProposal(id).state,'verified');assert.deepEqual(registry.listToolVersions(),[]);
  assert.equal(registry.listEvents(id).length,2);registry.close();
});
test('a second verified proposal cannot silently replace the first version of the same name',async t=>{
  const {root,id,input}=await approvalFixture(t);await service.approveRegisteredToolProposal(id,actor,{root});
  const other=submitRegisteredToolProposal(input,{root});
  await verifyFixtureProposal(root,other,input);
  assert.equal(getRegisteredToolProposal(other.proposal.id,{root}).verified,true);
  const registry=new ToolRegistry(path.join(root,'runtime/tool-registry/registry.sqlite'),{readOnly:true});
  assert.equal(registry.getActiveTool(input.toolName).proposalId,id);registry.close();
  await assert.rejects(async()=>service.approveRegisteredToolProposal(other.proposal.id,actor,{root}),/already exists|parent/i);
  assert.equal(service.listRegisteredToolVersions({root}).length,1);
});
test('approved package modification blocks repeat approval and proposal details',async t=>{
  const {root,id,approvedRoot}=await approvalFixture(t);const first=await service.approveRegisteredToolProposal(id,actor,{root});
  const file=path.join(approvedRoot,first.version.packageDirectory,'tool.mjs');writable(file,'throw new Error("changed")');
  await assert.rejects(async()=>service.approveRegisteredToolProposal(id,actor,{root}),/digest|modified|hash/i);
  assert.throws(()=>getRegisteredToolProposal(id,{root}),/digest|modified|hash/i);
});
test('empty approval actor has no publication side effect',async t=>{
  const {root,id,approvedRoot}=await approvalFixture(t);
  await assert.rejects(async()=>service.approveRegisteredToolProposal(id,'  ',{root}),/approvedBy|actor/i);
  assert.equal(fs.existsSync(approvedRoot),false);
});
for(const target of ['source','report'])test(`${target} changed while package is published cannot be activated`,async t=>{
  const {root,id,saved,database,approvedRoot}=await approvalFixture(t);
  const validation=getLatestToolValidationReport(id,{root});
  const file=target==='source'?path.join(saved.registry.artifactPath,'tool.mjs'):validation.reportPath;
  const rename=fs.renameSync;let changed=false;
  t.mock.method(fs,'renameSync',function(from,to){
    const result=rename(from,to);
    if(path.dirname(to)===approvedRoot&&!changed){changed=true;writable(file,Buffer.concat([fs.readFileSync(file),Buffer.from('\n')]));}
    return result;
  });
  let failure;await assert.rejects(async()=>service.approveRegisteredToolProposal(id,actor,{root}),error=>{failure=error;return /digest|modified/.test(error.message);});
  assert.equal(changed,true);assert.equal(fs.existsSync(failure.packagePath),true);
  const registry=new ToolRegistry(database,{readOnly:true});
  try{assert.equal(registry.getProposal(id).state,'verified');assert.deepEqual(registry.listToolVersions(),[]);assert.equal(registry.listEvents(id).length,2);}
  finally{registry.close();}
});
test('activation binds the exact latest validation even if it changes after preflight',async t=>{
  const {root,id,database}=await approvalFixture(t);const activate=ToolRegistry.prototype.activateVersion;
  const newerId=randomUUID();
  t.mock.method(ToolRegistry.prototype,'activateVersion',function(input){
    this.recordValidation({id:newerId,proposalId:id,passed:true,reportPath:path.join(root,'newer.json'),reportSha256:'e'.repeat(64)});
    return activate.call(this,input);
  });
  await assert.rejects(async()=>service.approveRegisteredToolProposal(id,actor,{root}),/validation|evidence|changed/i);
  const registry=new ToolRegistry(database,{readOnly:true});
  try{assert.equal(registry.getProposal(id).latestValidationId,newerId);assert.equal(registry.getProposal(id).state,'verified');assert.deepEqual(registry.listToolVersions(),[]);}
  finally{registry.close();}
});
