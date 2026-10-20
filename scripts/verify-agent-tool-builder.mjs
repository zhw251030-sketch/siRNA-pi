// Read-only check of the fixed step10J acceptance. No build, submit, business run or model request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {getRegisteredToolProposal} from '../packages/capability-platform/tool-lifecycle.mjs';
import {getRegisteredToolCatalog,getRegisteredToolVersion} from '../packages/capability-platform/tool-approval-service.mjs';
import {DockerEngineClient} from '../packages/capability-platform/docker-engine-client.mjs';
import {TOOL_BASE_IMAGE,TOOL_COMMAND} from '../packages/capability-platform/tool-build-service.mjs';

assert.equal(process.argv.length,2,'This check takes no arguments');
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
assert.equal(root,'/home/hanwen/Project/project/siNRA-pi','Run in the dedicated server checkout');
assert.equal(process.cwd(),root);
const read=file=>JSON.parse(fs.readFileSync(path.resolve(root,file),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=file=>hash(fs.readFileSync(path.resolve(root,file)));
const before=read('runtime/agent-builder-state-before.json'),exercise=read('runtime/agent-builder-exercise.json');
const started=read('runtime/agent-builder-exercise-started.json');
const draft=read('examples/06-agent-tool-build/proposal.draft.json');
function tree(directory){const result={};function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
 const file=path.join(dir,e.name);assert.equal(e.isSymbolicLink(),false);if(e.isDirectory())visit(file);else{assert.ok(e.isFile());result[path.relative(root,file)]=digest(file);}
 }}visit(path.join(root,directory));return result;}
function tables(file,names){const db=new DatabaseSync(path.resolve(root,file),{readOnly:true});try{
 return {schema:db.prepare('PRAGMA user_version').get().user_version,tables:Object.fromEntries(names.map(t=>[t,db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map(r=>({...r}))]))};
}finally{db.close();}}
const current=tables('runtime/tool-registry/registry.sqlite',['tool_proposals','tool_validations','tool_versions','tool_events']);assert.equal(current.schema,4);
for(const table of ['tool_validations','tool_versions'])assert.deepEqual(current.tables[table],before.tables[table]);
for(const table of ['tool_proposals','tool_events']){
 for(const row of before.tables[table])assert.deepEqual(current.tables[table].find(r=>r.id===row.id),row);
 assert.equal(current.tables[table].length,before.tables[table].length+1);
}
assert.equal(exercise.ok,true);assert.equal(exercise.sameMcpProcess,true);assert.equal(exercise.modelRequests,0);
assert.equal(exercise.debugBusinessExecutions,1);assert.equal(exercise.freshBusinessExecutions,1);assert.equal(exercise.newImages,1);assert.equal(exercise.revalidations,0);assert.equal(exercise.newApprovedCalls,0);
assert.equal(exercise.calls.length,14);assert.equal(exercise.calls.filter(c=>c.negative).length,5);
const id=exercise.proposal.proposalId;const detail=getRegisteredToolProposal(id,{root});
assert.equal(detail.registry.state,'submitted');assert.equal(detail.proposal.toolName,'summarize_numeric_values');
assert.equal(detail.verified,false);assert.equal(detail.approved,false);assert.equal(detail.activated,false);assert.equal(detail.validation,undefined);
assert.deepEqual(detail.proposal.runtimeArtifact,exercise.artifact);assert.equal(detail.proposal.scriptSha256,hash(draft.script));
assert.equal(fs.readFileSync(path.join(detail.registry.artifactPath,'tool.mjs'),'utf8'),draft.script);
const addedEvents=current.tables.tool_events.filter(e=>!before.tables.tool_events.some(old=>old.id===e.id));
assert.equal(addedEvents[0].event_type,'proposal_submitted');assert.equal(addedEvents[0].proposal_id,id);
for(const [file,sha]of Object.entries(before.materials))assert.equal(digest(file),sha);
const addedMaterials=Object.keys(tree('runtime/tool-artifacts')).filter(f=>!Object.hasOwn(before.materials,f));
assert.deepEqual(addedMaterials.sort(),['manifest.json','tool.mjs','baseline.mjs'].map(f=>path.join('runtime/tool-artifacts/proposals',id,f)).sort());
assert.deepEqual(tree('runtime/approved-tool-runs'),before.audits);
assert.equal(digest('runtime/tool-registry/active-tools.json'),before.catalogSha256);
const catalog=getRegisteredToolCatalog({root});assert.equal(catalog.tools.length,1);assert.equal(catalog.tools[0].toolName,'summarize_target_sequence');assert.equal(catalog.tools[0].version,'1.0.1');
const active=getRegisteredToolVersion('summarize_target_sequence','1.0.1',{root});assert.equal(active.version.packageSha256,'ec49bc242af211202f21fa216c6576d7595bb315cabe0955aac07428082937ec');
const old=getRegisteredToolVersion('summarize_target_sequence','1.0.0',{root});assert.equal(old.version.state,'inactive');
const sessionFiles=fs.readdirSync(path.join(root,'runtime/compose-sessions')).filter(f=>f.endsWith('.json')).sort();assert.deepEqual(sessionFiles,Object.keys(before.sessions).sort());
for(const [file,sha]of Object.entries(before.sessions))assert.equal(digest('runtime/compose-sessions/'+file),sha);
const task=tables('runtime/tasks/tasks.sqlite',['design_tasks','chat_messages','chat_run_events']);
for(const [name,rows]of Object.entries(task.tables))assert.equal(hash(JSON.stringify(rows)),before.taskData[name]);
const st=fs.statSync(path.join(root,'docs/auth.json'));assert.deepEqual([st.ino,st.size,st.mtimeMs,st.mode],before.credentialStat);
const dockerCli=(...a)=>execFileSync('sh',['scripts/project-docker.sh',...a],{cwd:root,encoding:'utf8'}).trim();
assert.deepEqual(dockerCli('ps','--format','{{.ID}} {{.Names}} {{.Image}}').split('\n').sort(),before.containers);
assert.equal(dockerCli('ps','-a','--filter','label=sirna.learning.project=siRNA-pi','--format','{{.ID}}'),'');
const currentImages=[...new Set(dockerCli('images','--no-trunc','--format','{{.ID}}').split('\n'))].sort();assert.deepEqual(currentImages,[...started.initialImages,exercise.artifact.imageDigest].sort());
const buildIds=fs.readdirSync(path.join(root,'runtime/tool-builds')).filter(id=>!started.initialBuildDirectories.includes(id)).sort();
assert.deepEqual(buildIds,[exercise.sessionId,exercise.cancelled.sessionId].sort());
const events=id=>fs.readFileSync(path.join(root,'runtime/tool-builds',id,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
const built=events(exercise.sessionId),cancelled=events(exercise.cancelled.sessionId);
assert.equal(built.filter(e=>e.type==='finalized').length,1);assert.equal(built.filter(e=>e.type==='image_commit_requested').length,1);
assert.equal(built.filter(e=>e.type==='proposal_registered').length,1);assert.equal(built.filter(e=>e.type==='debug_result').length,1);
const debugExec=built.find(e=>e.type==='container_exec_requested'&&e.command[0]==='/bin/sh');assert.equal(debugExec.user,'65534:65534');
assert.deepEqual(JSON.parse(built.find(e=>e.type==='debug_result').result.stdout),{count:3,sum:12,mean:4});
assert.equal(cancelled.find(e=>e.type==='cancelled').cleanupConfirmed,true);
const finalized=read(`runtime/tool-builds/${exercise.sessionId}/finalized.json`);assert.deepEqual(finalized.artifact,exercise.artifact);assert.equal(finalized.script,draft.script);
const fresh=read('runtime/agent-builder-fresh-run.json');assert.equal(fresh.result.exitCode,0);assert.equal(fresh.result.timedOut,false);assert.equal(fresh.result.protocolValid,true);
assert.deepEqual(fresh.result.output,{count:2,sum:0,mean:0});assert.equal(fresh.result.imageDigest,exercise.artifact.imageDigest);
assert.equal(fresh.result.actualPolicy.user,'65534:65534');assert.equal(fresh.result.actualPolicy.hostConfig.networkMode,'none');assert.equal(fresh.result.actualPolicy.hostConfig.readonlyRootfs,true);
assert.equal(fresh.result.actualPolicy.hostConfig.memory,1073741824);assert.equal(fresh.result.actualPolicy.hostConfig.pidsLimit,64);assert.equal(fresh.result.actualPolicy.hostConfig.bindsAbsent,true);
const inspection=read('runtime/agent-builder-inspection.json');assert.equal(inspection.cleanupConfirmed,true);assert.equal(inspection.imageDigest,exercise.artifact.imageDigest);
assert.deepEqual(inspection.actual.mounts,[]);assert.deepEqual(inspection.output,{sourceSha256:hash(draft.script),markerPresent:false,uid:65534});
const docker=new DockerEngineClient(path.join(root,'runtime/docker/run/docker.sock'));
const containers=[...built,...cancelled].filter(e=>e.type==='container_created').map(e=>e.containerId).concat(fresh.result.containerId,inspection.containerId);
assert.equal(containers.length,5);assert.equal(new Set(containers).size,5);
for(const containerId of containers)await assert.rejects(docker.inspectContainer(containerId),e=>e.statusCode===404);
const image=await docker.inspectImage(exercise.artifact.imageDigest);assert.equal(image.Id,exercise.artifact.imageDigest);assert.deepEqual(image.Config.Cmd,TOOL_COMMAND);assert.equal(image.Config.User,'65534:65534');
assert.equal(image.Config.Labels['sirna.tool.build-session'],exercise.sessionId);assert.equal(image.Config.Labels['sirna.tool.base-image'],TOOL_BASE_IMAGE);assert.equal(image.Config.Labels['sirna.tool.source-sha256'],hash(draft.script));
const health=await(await fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(5000)})).json();assert.equal(health.ready,true);assert.equal(health.busy,false);
console.log(JSON.stringify({ok:true,step:'10J',proposalId:id,toolName:detail.proposal.toolName,state:detail.registry.state,imageDigest:exercise.artifact.imageDigest,
 artifactSha256:detail.registry.artifactSha256,sourceSha256:detail.proposal.scriptSha256,activeVersion:'1.0.1',newProposals:1,newValidations:0,newVersions:0,newEvents:1,
 debugBusinessExecutions:1,freshBusinessExecutions:1,temporaryContainersRemoved:5,modelRequests:0,oldMaterialsUnchanged:18,oldAuditFilesUnchanged:12,oldSessionsUnchanged:11,oldRunningContainersUnchanged:4}));
