// Read-only acceptance for the fixed Step10L exercise. Private historical
// baseline is required; this does not submit jobs or execute tools/models.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {getLatestToolValidationReport} from '../packages/capability-platform/tool-validation-service.mjs';
import {root,proposalId,preserve} from '../runtime/maintenance-state.mjs';

assert.equal(process.cwd(),root);assert.equal(process.argv.length,2);
const preservation=await preserve({validated:true});
const latest=getLatestToolValidationReport(proposalId,{root}),report=latest.report;
assert.equal(report.artifactSha256,'b57eb4bd612e32f26a7287d3867feeb99fb4835823b831a3350364f0bbc18729');
assert.equal(report.passed,true);assert.equal(report.artifactIntegrityPassed,true);assert.equal(report.runtimeArtifactVerified,true);
assert.equal(report.staticCheck.passed,true);assert.equal(report.syntaxChecks.length,2);assert.ok(report.syntaxChecks.every(s=>s.passed));
assert.equal(report.repeatability.passed,true);assert.equal(report.domainGatePassed,true);assert.equal(report.domainCases.length,3);
assert.ok(report.domainCases.every(c=>c.expectationPassed));assert.equal(report.benchmarks.length,2);assert.equal(report.executionCount,9);
assert.deepEqual(report.benchmarkGate,{candidateScore:2,baselineScore:1,netGain:1,minNetGain:1,passed:true});
const db=new DatabaseSync(path.join(root,'runtime/tool-maintenance/jobs.sqlite'),{readOnly:true});let job;
try{
 const jobs=db.prepare('SELECT * FROM jobs ORDER BY rowid').all();assert.equal(jobs.length,1);job=jobs[0];
 assert.equal(job.proposal_id,proposalId);assert.equal(job.status,'succeeded');assert.equal(job.validation_id,latest.id);assert.equal(job.passed,1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM requests').get().n,1);
}finally{db.close();}
const directory=path.join(root,'runtime/tool-maintenance/runs',job.id);
const read=file=>JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));
assert.equal(read('request.json').modelRequests,0);assert.equal(read('result.json').modelRequests,0);
assert.equal(read('result.json').validationId,latest.id);
const events=fs.readFileSync(path.join(directory,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
const created=events.filter(e=>e.type==='validation_container_created'),cleaned=events.filter(e=>e.type==='validation_container_cleaned');
assert.equal(created.length,11);assert.equal(cleaned.length,11);assert.equal(new Set(created.map(e=>e.containerId)).size,11);
assert.deepEqual(created.map(e=>e.containerId).sort(),cleaned.map(e=>e.containerId).sort());
for(const e of created){assert.equal(e.actualPolicy.networkMode,'none');assert.equal(e.actualPolicy.user,'65534:65534');assert.equal(e.actualPolicy.readonlyRootfs,true);}
assert.equal(execFileSync('sh',['scripts/project-docker.sh','ps','-a','--filter','label=sirna.learning.project=siRNA-pi','--format','{{.ID}}'],{encoding:'utf8'}).trim(),'');
const api=async route=>{const r=await fetch('http://127.0.0.1:3000'+route,{headers:{Connection:'close'},signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);return r.json();};
const list=await api('/v1/tool-proposals'),entry=list.proposals.find(p=>p.id===proposalId);
assert.equal(entry.state,'verified');assert.equal(entry.latestJob.id,job.id);assert.equal(entry.latestJob.status,'succeeded');
const {summary}=await api(`/v1/tool-proposals/${proposalId}/validation-summary`);
assert.equal(summary.validationId,latest.id);assert.equal(summary.passed,true);assert.equal(summary.executionCount,9);
assert.deepEqual(summary.benchmarkGate,report.benchmarkGate);assert.deepEqual(summary.domainCases,{passed:3,total:3});
console.log(JSON.stringify({proposalId,jobId:job.id,validationId:latest.id,reportSha256:latest.reportSha256,
 state:entry.state,jobStatus:job.status,passed:report.passed,syntaxChecks:2,businessExecutions:9,containersCreated:11,containersCleaned:11,
 domainCases:summary.domainCases,benchmarkGate:report.benchmarkGate,modelRequests:0,approved:false,activated:false,...preservation},null,2));
