// Read-only verification of the controlled step10K web exercise; no model/build execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {ComposeSessionStore,executionId} from '../packages/agent-runtime/compose-session-store.mjs';
import {DockerEngineClient} from '../packages/capability-platform/docker-engine-client.mjs';
import {getRegisteredToolProposal} from '../packages/capability-platform/tool-lifecycle.mjs';
import {getRegisteredToolCatalog} from '../packages/capability-platform/tool-approval-service.mjs';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
assert.equal(root,'/home/hanwen/Project/project/siNRA-pi');assert.equal(process.cwd(),root);
const [taskId,mode,...extra]=process.argv.slice(2);assert.ok(executionId.test(taskId)&&['completed','ended'].includes(mode)&&!extra.length);
const read=file=>JSON.parse(fs.readFileSync(path.resolve(root,file),'utf8'));
const hash=data=>createHash('sha256').update(data).digest('hex');
const response=await fetch(`http://127.0.0.1:3000/v1/tasks/${taskId}/messages`,{headers:{Connection:'close'}});assert.equal(response.status,200);const history=await response.json();
assert.equal(history.task.status,mode==='ended'?'stopped':'idle');
const store=new ComposeSessionStore(root),session=store.load(history.task.executionSessionId);store.assertConversation(session);
assert.equal(session.remoteApprovedTools,true);assert.equal(session.remoteBuilderTools,true);assert.equal(session.runs.length,1);
const run=session.runs[0];assert.equal(run.status,'succeeded');assert.equal(run.runId,history.task.currentRunId);
assert.equal(history.messages.length,2);assert.equal(history.messages[1].status,'complete');
const owner={taskId,executionSessionId:session.id,sandboxId:session.sandboxId,agentTurnId:run.agentTurnId,agentRunId:run.runId};
const workspace=path.join(root,session.workspacePath);assert.equal(fs.existsSync(path.join(workspace,'.sirna-task-context.json')),false);
const nativeDir=path.join(workspace,'../state/agents/providers/pi/sessions');
const native=fs.readdirSync(nativeDir).filter(f=>f.endsWith('.jsonl')).map(f=>path.join(nativeDir,f)).find(f=>JSON.parse(fs.readFileSync(f,'utf8').split('\n')[0]).id===session.piSessionId);assert.ok(native);
const nativeBytes=fs.readFileSync(native);const messages=nativeBytes.toString().trim().split('\n').map(JSON.parse).filter(x=>x.type==='message').map(x=>x.message);
const tools=messages.filter(m=>m.role==='assistant').flatMap(m=>m.content.filter(c=>c.type==='toolCall'));
const discoveryErrors=messages.filter(m=>m.role==='toolResult'&&m.isError).map(m=>{
 const call=tools.find(c=>c.id===m.toolCallId);assert.equal(call?.name,'mcp');assert.equal(typeof call.arguments.describe,'object');assert.equal(call.arguments.tool,undefined);
 assert.ok(m.content.some(c=>c.type==='text'&&c.text.includes('describe: must be string')));
 return {toolCallId:call.id,operation:'mcp.describe',cause:'describe must be string'};
});assert.equal(discoveryErrors.length,2);
const usage=messages.filter(m=>m.role==='assistant').map(m=>m.usage);assert.equal(usage.length,16);
const usageTotals={};for(const key of ['input','output','cacheRead','cacheWrite','totalTokens']){assert.ok(usage.every(u=>Number.isSafeInteger(u?.[key])&&u[key]>=0));usageTotals[key]=usage.reduce((sum,u)=>sum+u[key],0);}
const names=['create_tool_build_session','write_tool_build_file','run_tool_build_command','cancel_tool_build_session','finalize_tool_build','propose_exploration_tool'];
const calls=tools.filter(c=>c.name==='mcp'&&names.some(n=>c.arguments?.tool?.endsWith(n)));
const callName=c=>names.find(n=>c.arguments.tool.endsWith(n));
const args=c=>typeof c.arguments.args==='string'?JSON.parse(c.arguments.args):c.arguments.args;
const result=c=>{const m=messages.find(m=>m.role==='toolResult'&&m.toolCallId===c.id);assert.ok(m&&!m.isError);return JSON.parse(m.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'));};
assert.equal(calls.length,8);for(const name of names)assert.equal(calls.filter(c=>callName(c)===name).length,name==='create_tool_build_session'?3:1);
const create=calls.filter(c=>callName(c)==='create_tool_build_session').map(result);const built=result(calls.find(c=>callName(c)==='finalize_tool_build'));
const submitted=result(calls.find(c=>callName(c)==='propose_exploration_tool'));const cancelled=result(calls.find(c=>callName(c)==='cancel_tool_build_session'));
assert.equal(submitted.state,'submitted');assert.equal(submitted.registered,true);for(const key of ['verified','approved','activated'])assert.equal(submitted[key],false);
const draft=read('examples/07-web-tool-build/proposal.draft.json');
assert.deepEqual(args(calls.find(c=>callName(c)==='write_tool_build_file')),{sessionId:built.sessionId,path:'/opt/tool/main.mjs',content:draft.script});
assert.deepEqual(args(calls.find(c=>callName(c)==='propose_exploration_tool')),{...draft,runtimeArtifact:built.artifact});
const debug=result(calls.find(c=>callName(c)==='run_tool_build_command'));assert.equal(debug.exitCode,0);assert.deepEqual(JSON.parse(debug.stdout),{count:3,min:2,max:6,range:4});
assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.cleanupConfirmed,true);
const createdIds=create.map(r=>r.session.id);assert.equal(new Set(createdIds).size,3);assert.ok(createdIds.includes(built.sessionId)&&createdIds.includes(cancelled.sessionId));
const leftoverId=createdIds.find(id=>![built.sessionId,cancelled.sessionId].includes(id));assert.ok(leftoverId);
const docker=new DockerEngineClient(path.join(root,'runtime/docker/run/docker.sock'));let removed=0;
for(const id of createdIds){const events=fs.readFileSync(path.join(root,'runtime/tool-builds',id,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 for(const e of events)assert.deepEqual(e.taskContext,owner);
 for(const e of events.filter(e=>e.type==='container_created')){await assert.rejects(docker.inspectContainer(e.containerId),e=>e.statusCode===404);removed++;}
 if(id===leftoverId)assert.ok(events.some(e=>e.type==='close_cleanup'));
}
assert.equal(removed,4);const frozen=read(`runtime/tool-builds/${built.sessionId}/finalized.json`);assert.deepEqual(frozen.taskContext,owner);assert.equal(frozen.script,draft.script);
const saved=read(`runtime/tool-builds/${built.sessionId}/proposal-result.json`);assert.deepEqual(saved.taskContext,owner);assert.equal(saved.proposalId,submitted.proposalId);
const detail=getRegisteredToolProposal(submitted.proposalId,{root});assert.equal(detail.registry.state,'submitted');assert.equal(detail.proposal.toolName,draft.toolName);assert.equal(detail.validation,undefined);
assert.deepEqual(detail.proposal.runtimeArtifact,built.artifact);assert.equal(detail.proposal.scriptSha256,hash(draft.script));assert.equal(fs.readFileSync(path.join(detail.registry.artifactPath,'tool.mjs'),'utf8'),draft.script);
const image=await docker.inspectImage(built.artifact.imageDigest);assert.equal(image.Id,built.artifact.imageDigest);assert.equal(image.Config.User,'65534:65534');assert.equal(image.Config.Labels['sirna.tool.source-sha256'],hash(draft.script));
const events=history.runEvents.filter(e=>e.payload?.type==='builder_tool_call');assert.equal(events.length,8);assert.ok(events.every(e=>e.payload.success===true&&e.runId===run.runId));
assert.equal(new Set(events.map(e=>e.payload.toolCallId)).size,8);
assert.equal(tools.some(c=>c.name==='read'&&c.arguments.path.includes('.sirna-task-context')),false);
const outputName='web-build-result.json';const output=fs.readFileSync(path.join(workspace,'output',outputName));
const reported=JSON.parse(output);assert.deepEqual(reported,{debug,finalized:built,proposal:submitted,cancelled,unfinishedSessionId:leftoverId});
assert.deepEqual(fs.readFileSync(path.join(root,'runtime/task-files',taskId,'output',outputName)),output);
const download=await fetch(`http://127.0.0.1:3000/v1/tasks/${taskId}/files/output/${outputName}?download=true`);assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),output);
const before=read('runtime/web-builder-state-before.json');const db=new DatabaseSync(path.join(root,'runtime/tool-registry/registry.sqlite'),{readOnly:true});
try{for(const table of ['tool_proposals','tool_validations','tool_versions','tool_events']){
 const rows=db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(r=>({...r}));assert.deepEqual(rows.slice(0,before.tables[table].length),before.tables[table]);
 assert.equal(rows.length,before.tables[table].length+(['tool_proposals','tool_events'].includes(table)?1:0));
 if(table==='tool_events'){const e=rows.at(-1);assert.equal(e.actor,'web-agent');assert.equal(e.event_type,'proposal_submitted');assert.equal(e.proposal_id,submitted.proposalId);}
}}finally{db.close();}
const catalog=getRegisteredToolCatalog({root});assert.equal(catalog.tools.find(t=>t.toolName==='summarize_target_sequence').version,'1.0.1');assert.equal(catalog.tools.some(t=>t.toolName===draft.toolName),false);
if(mode==='ended'){assert.equal(session.runtimeReleased,true);const info=JSON.parse(execFileSync('sh',['scripts/project-agent-compose.sh','inspect','sandbox',session.sandboxId],{cwd:root,encoding:'utf8'}));const sandbox=info.sandbox??info;assert.equal(sandbox.vm_status,'stopped');assert.equal(sandbox.stopped_runtime_state,'released');}
console.log(JSON.stringify({ok:true,mode,...owner,piSessionId:session.piSessionId,proposalId:submitted.proposalId,toolName:draft.toolName,state:submitted.state,
 buildSessionId:built.sessionId,cancelledSessionId:cancelled.sessionId,autoCleanedSessionId:leftoverId,imageDigest:built.artifact.imageDigest,sourceSha256:hash(draft.script),artifactSha256:detail.registry.artifactSha256,
 modelResponses:run.modelResponses,piToolCalls:tools.length,builderToolCalls:calls.length,discoveryErrors,usageTotals,actualCostKnown:false,debugOutput:JSON.parse(debug.stdout),temporaryContainersRemoved:removed,newProposals:1,newValidations:0,newVersions:0,
 ownerContextMatches:true,taskCapabilityFileRemoved:true,archiveAndDownloadMatch:true,activeVersion:'1.0.1',nativeSessionSha256:hash(nativeBytes),outputSha256:hash(output),guestReleased:mode==='ended'},null,2));
