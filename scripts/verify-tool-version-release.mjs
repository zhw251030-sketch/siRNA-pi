// Read-only evidence check for step10I. No release, rollback, tool execution or model request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {getRegisteredToolVersion,getRegisteredToolCatalog} from '../packages/capability-platform/tool-approval-service.mjs';
import {getRegisteredToolProposal} from '../packages/capability-platform/tool-lifecycle.mjs';
import {DockerEngineClient} from '../packages/capability-platform/docker-engine-client.mjs';

assert.equal(process.argv.length,2,'This evidence check takes no arguments');
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
assert.equal(root,'/home/hanwen/Project/project/siNRA-pi','Run from the dedicated server checkout');
const read=file=>JSON.parse(fs.readFileSync(path.resolve(root,file),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const digest=file=>hash(fs.readFileSync(path.resolve(root,file)));
const before=read('runtime/version-release-state-before.json'),exercise=read('runtime/version-release-exercise.json');
const name='summarize_target_sequence',proposalId='4530af22-d8d7-42f0-ac75-fec6ce851466';
function registryRecords(file){const db=new DatabaseSync(path.resolve(root,file),{readOnly:true});try{
 return {schema:db.prepare('PRAGMA user_version').get().user_version,
  tables:Object.fromEntries(['tool_proposals','tool_validations','tool_versions','tool_events'].map(t=>[t,db.prepare(`SELECT * FROM ${t}`).all().map(row=>({...row}))]))};
}finally{db.close();}}
const current=registryRecords('runtime/tool-registry/registry.sqlite');assert.equal(current.schema,4);
const old=getRegisteredToolVersion(name,'1.0.0',{root}),fresh=getRegisteredToolVersion(name,'1.0.1',{root});
assert.equal(current.tables.tool_versions.length,2);assert.equal(old.version.state,'inactive');assert.equal(fresh.version.state,'active');
assert.equal(old.version.runtimeState,'retained');assert.equal(fresh.version.runtimeState,'retained');
assert.equal(fresh.version.toolId,old.version.toolId);assert.equal(fresh.version.parentToolId,old.version.toolId);
assert.equal(fresh.version.parentVersion,'1.0.0');assert.equal(fresh.version.proposalId,proposalId);
assert.deepEqual(fresh.package.manifest.parent,{toolName:name,version:'1.0.0'});
const detail=getRegisteredToolProposal(proposalId,{root});assert.equal(detail.registry.state,'approved');assert.equal(detail.activated,true);
assert.equal(detail.validation.reportSha256,'6c643791ecd07d4f13359a5811544d33d619932d4314e9dbe7f5954e1fab266e');
assert.equal(detail.validation.report.parentComparison.packageSha256,old.version.packageSha256);
assert.equal(detail.validation.report.parentComparison.scriptSha256,old.package.manifest.scriptSha256);
assert.equal(detail.validation.report.parentComparison.baselineScriptSha256,old.package.manifest.scriptSha256);
assert.deepEqual(fs.readFileSync(path.join(fresh.package.directory,'verification.json')),fs.readFileSync(detail.validation.reportPath));
assert.deepEqual(fs.readFileSync(path.join(fresh.package.directory,'tool.mjs')),fs.readFileSync(path.join(root,'runtime/tool-artifacts/proposals',proposalId,'tool.mjs')));
assert.equal(fresh.version.imageDigest,'sha256:c2a82b28889e5ccba46baa68647422614be1467c6e312ec2bced38c6ce94aa47');
assert.equal(old.version.imageDigest,'sha256:e800a6bdb8139da0fb8026a838744a748990a314a025435f5f0a20572ea2ec18');
const catalog=getRegisteredToolCatalog({root});assert.equal(catalog.tools.length,1);
assert.equal(catalog.tools[0].version,'1.0.1');assert.equal(catalog.tools[0].packageSha256,fresh.version.packageSha256);

for(const [file,sha]of Object.entries(before.materials))assert.equal(digest(file),sha);
for(const [file,sha]of Object.entries(before.audits))assert.equal(digest(file),sha);
for(const [file,sha]of Object.entries(before.sessions))assert.equal(digest('runtime/compose-sessions/'+file),sha);
assert.equal(current.tables.tool_proposals.length,before.tables.tool_proposals.length);
for(const row of before.tables.tool_proposals){const now=current.tables.tool_proposals.find(x=>x.id===row.id);assert.ok(now);
 for(const [key,value]of Object.entries(row))if(row.id!==proposalId||!['state','updated_at'].includes(key))assert.deepEqual(now[key],value);
}
assert.deepEqual(current.tables.tool_validations,before.tables.tool_validations);
for(const row of before.tables.tool_versions){const now=current.tables.tool_versions.find(x=>x.tool_id===row.tool_id&&x.version===row.version);assert.ok(now);
 for(const [key,value]of Object.entries(row))if(!['state','updated_at'].includes(key))assert.deepEqual(now[key],value);
}
for(const row of before.tables.tool_events)assert.deepEqual(current.tables.tool_events.find(x=>x.id===row.id),row);
const events=current.tables.tool_events.filter(e=>!before.tables.tool_events.some(old=>old.id===e.id)).sort((a,b)=>a.id-b.id);
assert.deepEqual(events.map(e=>e.event_type),['version_activated','tool_rolled_back','tool_rolled_back']);
assert.ok(events.every(e=>e.actor==='hanwen-via-codex'));
const activated=JSON.parse(events[0].details_json);assert.equal(activated.version,'1.0.1');
assert.equal(activated.proposalId,proposalId);assert.equal(activated.packageSha256,fresh.version.packageSha256);
assert.deepEqual(JSON.parse(events[1].details_json),{toolId:old.version.toolId,fromVersion:'1.0.1',toVersion:'1.0.0',reason:'learning acceptance: restore retained parent'});
assert.deepEqual(JSON.parse(events[2].details_json),{toolId:old.version.toolId,fromVersion:'1.0.0',toVersion:'1.0.1',reason:'learning acceptance: retain verified new version'});
const backups=fs.readdirSync(path.join(root,'runtime/tool-registry')).filter(f=>f.includes('.v3-backup-')&&!before.backups.includes(f));
assert.equal(backups.length,1);const backup=registryRecords('runtime/tool-registry/'+backups[0]);
assert.equal(backup.schema,3);assert.deepEqual(backup.tables,before.tables);

assert.equal(exercise.ok,true);assert.equal(exercise.calls.length,3);assert.equal(exercise.sameMcpProcess,true);
assert.equal(exercise.modelRequests,0);assert.equal(exercise.newBuilds,0);assert.equal(exercise.revalidations,0);
const expected=[{length:11,gcFraction:5/11,baseCounts:{A:3,C:2,G:3,T:3}},
 {length:11,gcFraction:5/11},{length:11,gcFraction:5/11,baseCounts:{A:3,C:2,G:3,T:3}}];
assert.deepEqual(exercise.calls.map(c=>c.version),['1.0.1','1.0.0','1.0.1']);
assert.equal(new Set(exercise.calls.map(c=>c.runId)).size,3);
// Compare the entire audit tree, not only the three declared success records.
const auditFiles=[];
function collectAuditFiles(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
 const file=path.join(directory,entry.name);assert.equal(entry.isSymbolicLink(),false);
 if(entry.isDirectory())collectAuditFiles(file);else{assert.ok(entry.isFile());auditFiles.push(path.relative(root,file));}
}}
collectAuditFiles(path.join(root,'runtime/approved-tool-runs'));
const newAuditFiles=auditFiles.filter(file=>!Object.hasOwn(before.audits,file)).sort();
assert.deepEqual(newAuditFiles,exercise.calls.flatMap(call=>['request.json','audit.json'].map(file=>
 path.join('runtime/approved-tool-runs',name,call.runId,file))).sort());
const docker=new DockerEngineClient(path.join(root,'runtime/docker/run/docker.sock'));
for(let i=0;i<3;i++){
 const call=exercise.calls[i];assert.deepEqual(call.output,expected[i]);assert.deepEqual(call.input,{sequence:'AACCGGGUUUA'});
 assert.match(call.runId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 const auditPath=path.join(root,'runtime/approved-tool-runs',name,call.runId,'audit.json');assert.equal(call.auditPath,auditPath);
 const audit=read(auditPath),request=read(path.join(path.dirname(auditPath),'request.json'));
 const version=i===1?old.version:fresh.version;
 for(const record of [request,audit]){
  assert.equal(record.toolVersion,call.version);assert.equal(record.toolId,version.toolId);assert.equal(record.proposalId,version.proposalId);
  assert.equal(record.packageSha256,version.packageSha256);assert.equal(record.imageDigest,version.imageDigest);
  assert.equal(record.inputSha256,hash(JSON.stringify(call.input)));assert.equal(record.runId,call.runId);
 }
 assert.equal(audit.outputSha256,hash(JSON.stringify(expected[i])));assert.equal(audit.stdoutSha256,hash(JSON.stringify(expected[i])));
 assert.equal(audit.stderrSha256,hash(''));assert.equal(audit.success,true);assert.equal(audit.exitCode,0);assert.equal(audit.cleanupConfirmed,true);
 const evidence=audit.executionEvidence;assert.equal(evidence.imageDigest,version.imageDigest);
 assert.equal(evidence.actualPolicy.executionUser,'65534:65534');assert.equal(evidence.actualPolicy.networkMode,'none');
 assert.equal(evidence.actualPolicy.readonlyRootfs,true);assert.equal(evidence.actualPolicy.bindsAbsent,true);
 assert.equal(evidence.actualPolicy.memoryBytes,1073741824);assert.equal(evidence.actualPolicy.pidsLimit,64);
 await assert.rejects(docker.inspectContainer(evidence.containerId),e=>e.statusCode===404);
}
for(const version of [old.version,fresh.version])assert.equal((await docker.inspectImage(version.imageDigest)).Id,version.imageDigest);
const containers=execFileSync('sh',['scripts/project-docker.sh','ps','--format','{{.ID}} {{.Names}} {{.Image}}'],{cwd:root,encoding:'utf8'}).trim().split('\n').sort();
assert.deepEqual(containers,before.containers);
assert.equal(execFileSync('sh',['scripts/project-docker.sh','ps','-a','--filter','label=sirna.learning.project=siRNA-pi','--format','{{.ID}}'],{cwd:root,encoding:'utf8'}).trim(),'');
const taskDb=new DatabaseSync(path.join(root,'runtime/tasks/tasks.sqlite'),{readOnly:true});try{
 for(const [table,sha]of Object.entries(before.taskData)){assert.ok(['design_tasks','chat_messages','chat_run_events'].includes(table));
  assert.equal(hash(JSON.stringify(taskDb.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())),sha);}
}finally{taskDb.close();}
const secret=fs.statSync(path.join(root,'docs/auth.json'));assert.deepEqual([secret.ino,secret.size,secret.mtimeMs,secret.mode],before.credentialStat);
console.log(JSON.stringify({ok:true,schema:4,migrationBackup:backups[0],oldMaterialsUnchanged:Object.keys(before.materials).length,
 oldTaskRowsUnchanged:true,oldSessionsUnchanged:Object.keys(before.sessions).length,oldRunningContainersUnchanged:containers.length,
 versions:[{version:'1.0.0',state:'inactive',packageSha256:old.version.packageSha256},
  {version:'1.0.1',state:'active',packageSha256:fresh.version.packageSha256}],
 preservedValidationId:detail.validation.id,events:events.map(e=>e.event_type),
 actualCallVersions:exercise.calls.map(c=>c.version),businessExecutions:3,temporaryBusinessContainersAbsent:true,
 modelRequestsRecorded:0,newBuildsRecorded:0,revalidationsRecorded:0},null,2));
