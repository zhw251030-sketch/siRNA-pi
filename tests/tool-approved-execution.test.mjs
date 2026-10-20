import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {approvalFixture,writable} from './helpers/approval-fixture.mjs';
import {DockerBoundary} from './helpers/validation-docker-boundary.mjs';
import {approveRegisteredToolProposal} from '../packages/capability-platform/tool-approval-service.mjs';
import {createDockerValidationRunner} from '../packages/capability-platform/tool-validation-runner.mjs';
const api=await import('../packages/capability-platform/tool-approved-execution.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
  const f=await approvalFixture(t);const approval=approveRegisteredToolProposal(f.id,'test operator',{root:f.root});
  const docker=new DockerBoundary({manifest:f.saved.proposal,input:f.input});
  docker.result.stdout='{"length":2,"gcFraction":0.5}';
  const runner=createDockerValidationRunner({docker,purpose:'approved-call'});
  return {...f,approval,docker,runner};
}
function audits(root){
  const dir=path.join(root,'runtime/approved-tool-runs/summarize_target_sequence');
  return fs.existsSync(dir)?fs.readdirSync(dir).map(id=>JSON.parse(fs.readFileSync(path.join(dir,id,'audit.json')))):[];
}

test('approved discovery executes a fresh input with the candidate and durable hash-only audit',async t=>{
  assert.equal(typeof api.discoverApprovedTools,'function');
  const f=await fixture(t);const d=api.discoverApprovedTools({root:f.root,runner:f.runner});
  assert.equal(d.tools.length,1);assert.equal(d.rejected.length,0);assert.equal(d.packages.length,1);
  const tool=d.tools[0];assert.equal(tool.name,'summarize_target_sequence');assert.equal(tool.executionMode,'sequential');
  const id=randomUUID();const r=await tool.execute(id,{input:{sequence:'AC'}});
  assert.deepEqual(JSON.parse(r.content[0].text),{length:2,gcFraction:0.5});
  assert.deepEqual(r.details.output,{length:2,gcFraction:0.5});assert.deepEqual(r.details.workerFiles,[]);assert.equal(r.details.approvedTool,true);
  assert.equal(r.details.packageSha256,f.approval.version.packageSha256);
  const audit=JSON.parse(fs.readFileSync(r.details.auditPath));
  assert.equal(audit.success,true);assert.equal(audit.toolCallId,id);assert.equal(audit.toolId,f.approval.version.toolId);
  assert.equal(audit.protocolVersion,'sirna-approved-tool-audit/v1');assert.equal(audit.inputSha256,hash('{"sequence":"AC"}'));
  assert.equal(audit.outputSha256,hash('{"length":2,"gcFraction":0.5}'));assert.equal(audit.filesDigest,f.docker.filesDigest);
  assert.equal(audit.imageDigest,f.input.runtimeArtifact.imageDigest);assert.equal(audit.operationError,null);
  assert.ok(audit.executionEvidence,'audit must retain independently inspectable container evidence');
  assert.equal(audit.executionEvidence.containerId,'validation-1');assert.equal(audit.executionEvidence.imageDigest,f.input.runtimeArtifact.imageDigest);
  assert.equal(audit.executionEvidence.actualPolicy.networkMode,'none');assert.equal(audit.executionEvidence.actualPolicy.executionUser,'65534:65534');
  assert.equal(audit.executionEvidence.actualPolicy.bindsAbsent,true);assert.equal(audit.cleanupConfirmed,true);
  const text=fs.readFileSync(r.details.auditPath,'utf8');assert.equal(text.includes('"sequence"'),false);assert.equal(text.includes('gcFraction'),false);
  assert.equal(f.docker.calls.filter(c=>c[0]==='createContainer').length,1);
  assert.equal(f.docker.calls.some(c=>c[0]==='exec'&&c[2][1]==='--check'),false);
  const run=f.docker.calls.find(c=>c[0]==='exec'&&c[2][2]==='run');assert.equal(run[2][3],'/opt/tool/main.mjs');
  assert.deepEqual([...f.docker.containers.keys()],['old-unrelated']);
});

test('missing registry discovery is read-only and submitted tools are excluded',async t=>{
  assert.equal(typeof api.discoverApprovedTools,'function');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-no-registry-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  assert.deepEqual(api.discoverApprovedTools({root}),{tools:[],packages:[],rejected:[]});assert.deepEqual(fs.readdirSync(root),[]);
  const f=await approvalFixture(t,{validate:false});assert.deepEqual(api.discoverApprovedTools({root:f.root}),{tools:[],packages:[],rejected:[]});
});

test('discovery refuses corrupt registry, stale catalog and changed package without Docker',async t=>{
  assert.equal(typeof api.discoverApprovedTools,'function');
  for(const kind of ['registry','catalog','package']){
    const f=await fixture(t);
    if(kind==='registry')writable(f.database,'not sqlite');
    if(kind==='catalog')writable(f.catalogPath,'{}');
    if(kind==='package')writable(path.join(f.approvedRoot,f.approval.version.packageDirectory,'tool.mjs'),'changed');
    const d=api.discoverApprovedTools({root:f.root,runner:f.runner});assert.equal(d.tools.length,0);assert.ok(d.rejected.length>0);assert.equal(f.docker.calls.length,0);
  }
});

test('descriptor rechecks catalog and package immediately before execution',async t=>{
  assert.equal(typeof api.discoverApprovedTools,'function');
  for(const kind of ['catalog','package']){
    const f=await fixture(t);const tool=api.discoverApprovedTools({root:f.root,runner:f.runner}).tools[0];
    writable(kind==='catalog'?f.catalogPath:path.join(f.approvedRoot,f.approval.version.packageDirectory,'tool.mjs'),'changed');
    await assert.rejects(tool.execute(randomUUID(),{input:{sequence:'AC'}}));assert.equal(f.docker.calls.length,0);
  }
});

test('strict defensive argument validation rejects host behavior and unsupported transfers before Docker',async t=>{
  assert.equal(typeof api.validateApprovedToolArguments,'function');
  const input={nested:[1,{ok:true}]};const copy=api.validateApprovedToolArguments({input});input.nested[1].ok=false;assert.deepEqual(copy,{nested:[1,{ok:true}]});
  let accessed=false;const getter={};Object.defineProperty(getter,'input',{enumerable:true,get(){accessed=true;return {};}});
  const cyclic={};cyclic.x=cyclic;
  const bad=[{},null,[],{input:[]},{input:{},extra:true},{input:{},inputFiles:[]},{input:{},outputFiles:[]},
    {input:{protocolVersion:'sirna-approved-tool-call/v1',toolCallId:randomUUID(),input:{}}},{input:{x:'x'.repeat(65536)}},
    {input:cyclic},{input:{x:NaN}},{input:{x:undefined}},{input:{x:1n}},{input:{x:new Date()}},getter,
    {input:new Proxy({},{getPrototypeOf(){accessed=true;return Object.prototype;}})}];
  const f=await fixture(t);const tool=api.discoverApprovedTools({root:f.root,runner:f.runner}).tools[0];
  for(const args of bad){assert.throws(()=>api.validateApprovedToolArguments(args));await assert.rejects(tool.execute(randomUUID(),args));}
  assert.equal(accessed,false);assert.equal(f.docker.calls.length,0);
  await assert.rejects(tool.execute('not-uuid',{input:{}}));assert.equal(f.docker.calls.length,0);
});

test('absent runner and pre-aborted signal cannot execute or create run evidence',async t=>{
  assert.equal(typeof api.discoverApprovedTools,'function');const f=await fixture(t);
  await assert.rejects(api.discoverApprovedTools({root:f.root}).tools[0].execute(randomUUID(),{input:{}}),/runner/i);
  const controller=new AbortController();controller.abort();
  await assert.rejects(api.discoverApprovedTools({root:f.root,runner:f.runner}).tools[0].execute(randomUUID(),{input:{}},controller.signal),/cancel|abort/i);
  assert.equal(f.docker.calls.length,0);assert.deepEqual(audits(f.root),[]);
});

test('nonzero, timeout, overflow, invalid protocol and invalid digest never return success',async t=>{
  assert.equal(typeof api.discoverApprovedTools,'function');
  for(const kind of ['exit','timeout','overflow','protocol','digest']){
    const f=await fixture(t);
    if(kind==='exit')f.docker.result.exitCode=1;if(kind==='timeout')f.docker.result.timedOut=true;
    if(kind==='overflow')f.docker.result.outputLimitExceeded=true;if(kind==='protocol')f.docker.result.stdout='[]';if(kind==='digest')f.docker.filesDigest='invalid';
    const tool=api.discoverApprovedTools({root:f.root,runner:f.runner}).tools[0];await assert.rejects(tool.execute(randomUUID(),{input:{sequence:'AC'}}));
    assert.equal(audits(f.root)[0].success,false);assert.deepEqual([...f.docker.containers.keys()],['old-unrelated']);
  }
});

test('operation failures and unconfirmed cleanup retain bounded false audits',async t=>{
  assert.equal(typeof api.discoverApprovedTools,'function');
  for(const kind of ['source','cleanup','unconfirmed']){
    const f=await fixture(t);if(kind==='source')f.docker.sourceMismatch=true;if(kind==='cleanup')f.docker.removeFailure=true;if(kind==='unconfirmed')f.docker.pretendRemoved=true;
    const tool=api.discoverApprovedTools({root:f.root,runner:f.runner}).tools[0];await assert.rejects(tool.execute(randomUUID(),{input:{sequence:'AC'}}));
    const audit=audits(f.root)[0];assert.equal(audit.success,false);assert.ok(audit.operationError);assert.ok(JSON.stringify(audit).length<8000);
    assert.equal(audit.cleanupConfirmed,kind==='source'?null:false);
    if(kind!=='source'){assert.ok(audit.executionEvidence,'failed cleanup must identify the unresolved container');assert.equal(audit.executionEvidence.containerId,'validation-1');assert.ok(audit.cleanupError);}
  }
});

test('post-execution tamper and cancellation after launch are audited without success',async t=>{
  assert.equal(typeof api.discoverApprovedTools,'function');
  for(const kind of ['tamper','cancel']){
    const f=await fixture(t);const controller=new AbortController();
    f.docker.runResult=()=>{
      if(kind==='tamper')writable(path.join(f.approvedRoot,f.approval.version.packageDirectory,'tool.mjs'),'changed');else controller.abort();
      return f.docker.result;
    };
    const tool=api.discoverApprovedTools({root:f.root,runner:f.runner}).tools[0];await assert.rejects(tool.execute(randomUUID(),{input:{sequence:'AC'}},controller.signal));
    const audit=audits(f.root)[0];assert.equal(audit.success,false);assert.equal(audit.cancelled,kind==='cancel');
    assert.deepEqual([...f.docker.containers.keys()],['old-unrelated']);
  }
});

test('audit path blockage prevents any Docker operation',async t=>{
  assert.equal(typeof api.discoverApprovedTools,'function');const f=await fixture(t);
  fs.writeFileSync(path.join(f.root,'runtime/approved-tool-runs'),'blocked');
  const tool=api.discoverApprovedTools({root:f.root,runner:f.runner}).tools[0];await assert.rejects(tool.execute(randomUUID(),{input:{sequence:'AC'}}));assert.equal(f.docker.calls.length,0);
});

test('request fsync failure prevents Docker and terminal write failure cannot return success',async t=>{
  const original=fs.fsyncSync;t.after(()=>{fs.fsyncSync=original;});
  for(const phase of ['request','terminal']){
    const f=await fixture(t);let count=0;
    fs.fsyncSync=(fd)=>{count++;if(count===(phase==='request'?1:2))throw new Error('disk sync unavailable');return original(fd);};
    const tool=api.discoverApprovedTools({root:f.root,runner:f.runner}).tools[0];
    const id=randomUUID();await assert.rejects(tool.execute(id,{input:{sequence:'AC'}}),/sync/);
    assert.equal(f.docker.calls.some(c=>c[0]==='createContainer'),phase==='terminal');
    assert.equal(fs.existsSync(path.join(f.root,'runtime/approved-tool-runs/summarize_target_sequence',id,'audit.json')),false,'unflushed success must not be published as terminal evidence');
    fs.fsyncSync=original;
  }
});
