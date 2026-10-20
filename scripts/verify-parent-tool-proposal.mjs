// Read-only acceptance of the step 10H example. Does not build, validate,
// approve, execute a business tool, or call a model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {getRegisteredToolProposal,resolveToolLearningPaths} from '../packages/capability-platform/tool-lifecycle.mjs';
import {getRegisteredToolVersion,getRegisteredToolCatalog} from '../packages/capability-platform/tool-approval-service.mjs';
import {readToolProposal} from '../packages/capability-platform/tool-proposals.mjs';
import {DockerEngineClient} from '../packages/capability-platform/docker-engine-client.mjs';
import {TOOL_BASE_IMAGE} from '../packages/capability-platform/tool-build-service.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const [id,...extra]=process.argv.slice(2);
assert.ok(!extra.length&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id??''));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const detail=getRegisteredToolProposal(id,{root});assert.equal(detail.registry.state,'verified');
assert.equal(detail.verified,true);assert.equal(detail.approved,false);assert.equal(detail.activated,false);
assert.deepEqual(detail.proposal.parent,{toolName:'summarize_target_sequence',version:'1.0.0'});
const parent=getRegisteredToolVersion('summarize_target_sequence','1.0.0',{root});
assert.equal(parent.version.state,'active');assert.equal(parent.version.runtimeState,'retained');
const saved=readToolProposal(id,{proposalsRoot:resolveToolLearningPaths(root).proposalsRoot,expectedArtifactSha256:detail.registry.artifactSha256});
const parentBytes=fs.readFileSync(path.join(parent.package.directory,'tool.mjs'));
assert.deepEqual(Buffer.from(saved.input.baseline.script),parentBytes);
assert.equal(saved.input.baseline.runtime,parent.package.manifest.runtime);
const report=detail.validation.report;assert.equal(report.passed,true);assert.equal(report.artifactIntegrityPassed,true);
assert.deepEqual(report.parentComparison,{toolName:parent.version.toolName,version:'1.0.0',toolId:parent.version.toolId,
  packageSha256:parent.version.packageSha256,imageDigest:parent.version.imageDigest,scriptSha256:hash(parentBytes),
  baselineScriptSha256:hash(parentBytes),comparisonMode:'registered-parent-source'});
const expected=[
  {length:4,gcFraction:0.5,baseCounts:{A:1,C:1,G:1,T:1}},
  {length:11,gcFraction:0.45454545454545453,baseCounts:{A:3,C:2,G:3,T:3}},
  {length:6,gcFraction:0.6666666666666666,baseCounts:{A:1,C:2,G:2,T:1}},
];
assert.equal(report.domainCases.length,3);assert.equal(report.benchmarks.length,3);
for(let i=0;i<3;i++){
  assert.equal(report.domainCases[i].expectationPassed,true);assert.deepEqual(report.domainCases[i].run.output,expected[i]);
  assert.equal(report.benchmarks[i].candidatePassed,true);assert.deepEqual(report.benchmarks[i].candidateRun.output,expected[i]);
  assert.equal(report.benchmarks[i].baselinePassed,i===0);
  assert.deepEqual(report.benchmarks[i].baselineRun.output,{length:expected[i].length,gcFraction:expected[i].gcFraction});
}
assert.deepEqual(report.benchmarkGate,{candidateScore:3,baselineScore:1,netGain:2,minNetGain:1,passed:true});
assert.equal(report.repeatability.passed,true);assert.deepEqual(report.repeatability.firstRun.output,expected[0]);
assert.equal(report.repeatability.firstRun.stdout,report.repeatability.secondRun.stdout);
assert.equal(report.repeatability.firstRun.filesDigest,report.repeatability.secondRun.filesDigest);
const runs=[report.repeatability.firstRun,report.repeatability.secondRun,...report.domainCases.map(c=>c.run),
  ...report.benchmarks.flatMap(c=>[c.candidateRun,c.baselineRun])];
assert.equal(report.executionCount,11);assert.equal(runs.length,11);assert.equal(new Set(runs.map(r=>r.containerId)).size,11);
const docker=new DockerEngineClient(path.join(root,'runtime/docker/run/docker.sock'));
for(const run of runs){
  assert.equal(run.exitCode,0);assert.equal(run.protocolValid,true);assert.equal(run.timedOut,false);
  assert.equal(run.actualPolicy.executionUser,'65534:65534');assert.equal(run.actualPolicy.networkMode,'none');
  assert.equal(run.actualPolicy.readonlyRootfs,true);assert.equal(run.actualPolicy.bindsAbsent,true);
  assert.equal(run.actualPolicy.memoryBytes,1073741824);assert.equal(run.actualPolicy.pidsLimit,64);
  await assert.rejects(docker.inspectContainer(run.containerId),error=>error.statusCode===404);
}
for(const benchmark of report.benchmarks){
  assert.equal(benchmark.candidateRun.imageDigest,saved.manifest.runtimeArtifact.imageDigest);
  assert.equal(benchmark.baselineRun.imageDigest,TOOL_BASE_IMAGE);
}
const buildDirectory=path.join(root,'runtime/tool-builds',saved.manifest.runtimeArtifact.buildSessionId);
const build=read(path.join(buildDirectory,'result.json'));
assert.equal(build.checks.length,3);assert.equal(build.sourceSha256,saved.manifest.scriptSha256);
assert.deepEqual(build.buildSmoke.output,expected[0]);
for(let i=0;i<3;i++){
  assert.equal(build.checks[i].passed,true);assert.deepEqual(build.checks[i].output,expected[i]);
  await assert.rejects(docker.inspectContainer(build.checks[i].containerId),error=>error.statusCode===404);
}
const buildEvents=fs.readFileSync(path.join(buildDirectory,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const buildContainerIds=[...new Set(buildEvents.filter(e=>['build_container_created','run_container_created'].includes(e.type)).map(e=>e.containerId))];
assert.equal(buildContainerIds.length,4);
for(const containerId of buildContainerIds)await assert.rejects(docker.inspectContainer(containerId),error=>error.statusCode===404);
const image=await docker.inspectImage(saved.manifest.runtimeArtifact.imageDigest);
assert.equal(image.Config.Labels['sirna.tool.source-sha256'],saved.manifest.scriptSha256);
const catalog=getRegisteredToolCatalog({root});const current=catalog.tools.find(t=>t.toolName==='summarize_target_sequence');
assert.equal(current.toolId,parent.version.toolId);assert.equal(current.version,'1.0.0');
assert.equal(current.packageSha256,parent.version.packageSha256);assert.equal(current.imageDigest,parent.version.imageDigest);
assert.deepEqual(detail.events.map(e=>e.eventType),['proposal_submitted','validation_passed']);
console.log(JSON.stringify({ok:true,proposalId:id,validationId:report.validationId,state:detail.registry.state,
  parentComparison:report.parentComparison,candidateImageDigest:saved.manifest.runtimeArtifact.imageDigest,
  candidateSourceSha256:saved.manifest.scriptSha256,proposalSha256:saved.artifactSha256,
  reportSha256:detail.validation.reportSha256,buildSessionId:saved.manifest.runtimeArtifact.buildSessionId,
  buildBusinessExecutions:4,validationBusinessExecutions:11,benchmarkGate:report.benchmarkGate,
  parentBaselineBytesEqual:true,temporaryBusinessContainersAbsent:true,currentVersion:'1.0.0',
  approved:false,activated:false,modelRequests:0},null,2));
