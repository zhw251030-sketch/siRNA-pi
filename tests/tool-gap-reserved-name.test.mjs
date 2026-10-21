import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {checkToolProposal,validateToolProposalInput} from '../packages/capability-platform/tool-contract.mjs';
import {submitRegisteredToolProposal} from '../packages/capability-platform/tool-lifecycle.mjs';
import {ToolGapStore} from '../packages/extensions/tool-curation/tool-gap-store.mjs';
import {createToolGapService} from '../packages/extensions/tool-curation/tool-gap-service.mjs';
import {createToolCurationPreview} from '../packages/extensions/tool-curation/tool-curation-preview.mjs';
import {buildCurationPreview} from '../packages/extensions/tool-curation/tool-curation-trace.mjs';
import {buildToolCurationTrace} from '../packages/extensions/tool-curation/tool-curation-evidence.mjs';
import {validateToolCurationResult} from '../packages/extensions/tool-curation/tool-curation-result.mjs';
import {curationBuildPrompt} from '../packages/extensions/tool-curation/tool-curation-build-contract.mjs';
import {ToolCurationBuildStore} from '../packages/extensions/tool-curation/tool-curation-build-store.mjs';
import {createToolCurationBuildService} from '../packages/extensions/tool-curation/tool-curation-build-service.mjs';
import {gapFixture,gapInput} from './helpers/tool-gap-fixture.mjs';
import {proposal,removeBuildTestRoot} from './helpers/tool-build-docker.mjs';

function fullProposal(toolName){return {...proposal(),toolName,runtimeArtifact:{protocolVersion:'sirna-tool-runtime-artifact/v1',imageDigest:'sha256:'+'a'.repeat(64),command:['/usr/bin/node','/opt/tool/main.mjs'],platform:'linux/amd64',createdAt:'2026-10-22T00:00:00.000Z',buildSessionId:'11111111-1111-4111-8111-111111111111'}};}
function candidateRun(t,toolName){
  const f=gapFixture(t),gaps=new ToolGapStore({root:f.root});f.closers.push(()=>gaps.close());
  const service=createToolGapService({store:gaps,taskStore:f.tasks,curationStore:f.curations});const report=service.report(gapInput(),f.context).report;f.finish();
  const preview=createToolCurationPreview({taskStore:f.tasks,listExistingTools:()=>['enumerate_sirna_candidates'],listGapReports:(taskId,runId)=>service.list(taskId,runId)});
  const trace=buildToolCurationTrace({id:randomUUID(),snapshot:preview.snapshot(f.task.id)});
  const result={protocolVersion:'sirna-tool-curation-result/v1',curationId:trace.curationId,traceSha256:trace.traceSha256,decision:'candidate',summary:'A local structure comparator',candidate:{capabilityKey:report.capabilityKey,suggestedToolName:toolName,capabilityBoundary:'Structure distance only',whyExistingToolsAreInsufficient:'No comparator is available',evidenceEventIds:[report.id],inputContractSketch:{structures:'string[]'},outputContractSketch:{distance:'number'},permissions:{profile:'no_external_access'},buildInstructions:['Compare supplied structures locally.']}};
  // Simulate a record saved by the old validator, then exercise every reader.
  f.curations.create(trace);f.curations.markRunning(trace.curationId);f.curations.complete(trace.curationId,result);
  return {...f,run:f.curations.get(f.task.id,trace.curationId),result};
}

for(const name of ['report_tool_gap','sirna_tools_report_tool_gap']){
  test(`Curator refuses reserved ${name} despite an otherwise valid gap candidate`,t=>{
    const f=candidateRun(t,name);assert.throws(()=>validateToolCurationResult(f.run,f.result),/tool name/i);
  });
  test(`Builder prompt and view refuse previously saved candidate named ${name}`,async t=>{
    const f=candidateRun(t,name);assert.throws(()=>curationBuildPrompt(f.run),/tool name/i);
    const builds=new ToolCurationBuildStore({root:f.root});f.closers.push(()=>builds.close());
    const service=createToolCurationBuildService({root:f.root,store:builds,curationStore:f.curations,taskStore:f.tasks,taskMessages:{},agentRuntime:{async describe(){return {backend:'agent-compose',sandboxId:f.context.sandboxId,supportsLifecycle:true,builderToolsAvailable:true};},async assertWorkspaceIdle(){}},listExistingTools:()=>['enumerate_sirna_candidates']});
    const view=await service.view(f.task.id,f.run.id);await service.stop();assert.equal(view.eligible,false);assert.equal(view.reason,'invalid_evidence');assert.equal(view.handoff,null);assert.equal(Object.hasOwn(view,'prompt'),false);assert.equal(f.tasks.listMessages(f.task.id).length,2);assert.deepEqual(builds.activeForTask(f.task.id),[]);
  });
  test(`proposal admission rejects reserved ${name} before creating registry or proposal material`,t=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-builder-')));t.after(()=>removeBuildTestRoot(root));const input=fullProposal(name);
    assert.throws(()=>submitRegisteredToolProposal(input,{root}),/TOOL_PROPOSAL_INVALID/);assert.deepEqual(fs.readdirSync(root),[]);
    assert.throws(()=>validateToolProposalInput(input),/toolName/i);const preflight=checkToolProposal(input);assert.equal(preflight.ok,false);assert.equal(preflight.code,'TOOL_PROPOSAL_INVALID');assert.equal(preflight.registered,false);assert.equal(preflight.executed,false);
  });
}

test('ordinary and similar tool names remain valid for candidates and proposal admission',t=>{
  for(const name of ['compare_rna_shapes','sirna_tools_compare_rna_shapes','report_tool_gap_summary','my_report_tool_gap']){
    const f=candidateRun(t,name);assert.doesNotThrow(()=>validateToolCurationResult(f.run,f.result));assert.match(curationBuildPrompt(f.run).prompt,new RegExp(name));assert.equal(checkToolProposal(fullProposal(name)).ok,true);
  }
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-builder-')));t.after(()=>removeBuildTestRoot(root));const saved=submitRegisteredToolProposal(fullProposal('compare_rna_shapes'),{root});assert.equal(saved.registry.toolName,'compare_rna_shapes');assert.equal(saved.registered,true);assert.equal(saved.executed,false);assert.equal(saved.activated,false);
});

test('reserved-name admission does not change the recorded c418659 no-gap hashes or envelope bytes',()=>{
  const scope={taskId:'legacy-task',runId:'legacy-run',userMessageId:'legacy-user',objective:'Compare datasets'};
  const events=Array.from({length:3},(_,i)=>[{...scope,id:'start-'+i,type:'tool_start',sequence:i*2+1,createdAt:'2026-10-21T00:00:00.000Z',payload:{toolCallId:'call-'+i,toolName:'fetch_dataset',args:{identifier:i%2}}},{...scope,id:'end-'+i,type:'tool_end',sequence:i*2+2,createdAt:'2026-10-21T00:00:01.000Z',payload:{toolCallId:'call-'+i,toolName:'fetch_dataset',isError:false,result:{rows:[1,2]}}}]).flat();
  const existingTools=['enumerate_sirna_candidates'],preview=buildCurationPreview({...scope,events,existingTools}),trace=buildToolCurationTrace({id:'11111111-1111-4111-8111-111111111111',snapshot:{preview,existingTools,events}});
  // Independently recorded from the actual c418659 modules via git show.
  assert.equal(preview.sourceSha256,'a466a0200f3c6dac7d67982d6073af28a61329972693703f8c410e967a9a2194');
  assert.equal(preview.previewSha256,'e03e8552f851f2ffa85ede5560aaa9b897c0c12b6d6716a3e127e61d9af15a22');
  assert.equal(trace.traceSha256,'99605b2a3960fb3c4ffb14bfac5aa47be11eb7cea8f57eb53332d797446af86c');
  assert.equal(Buffer.byteLength(JSON.stringify(preview)),1945);assert.equal(Buffer.byteLength(JSON.stringify(trace)),2615);assert.deepEqual(trace.existingTools,['enumerate_sirna_candidates']);assert.equal(Object.hasOwn(preview,'gapReports'),false);
});
