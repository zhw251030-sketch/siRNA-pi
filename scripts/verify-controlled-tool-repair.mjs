// Read-only audit of observed Step10N evidence; ok does not mean repair success.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ComposeSessionStore} from '../packages/agent-runtime/compose-session-store.mjs';
import {DockerEngineClient} from '../packages/capability-platform/docker-engine-client.mjs';
import {getToolProposalSource} from '../packages/capability-platform/tool-proposal-source.mjs';
import {assertRepairContract,frozenToolContract} from '../packages/capability-platform/tool-repair-contract.mjs';
import {checkToolProposal} from '../packages/capability-platform/tool-contract.mjs';
import {createToolRepair,ToolRepairError} from '../packages/capability-platform/tool-repair-service.mjs';
import {getLatestToolValidationReport} from '../packages/capability-platform/tool-validation-service.mjs';
import {root,read,hash,preserve} from '../runtime/repair-state.mjs';
assert.equal(process.cwd(),root);assert.equal(process.argv.length,2);
const preserved=await preserve({phase:'ended'}),receipt=read('runtime/repair-exercise-started.json'),before=read('runtime/repair-state-before.json');
const expected={taskId:'245a0189-ed75-4d88-8305-cc4a0a44eb03',sessionId:'c35692f2-01f1-4845-a481-fb084b9f61ec',proposalId:'b1bf4288-e3dd-4552-906d-f1ba1e4991f0',rootBuildId:'cea3258f-a2fe-4661-8045-33d175ad6322',repairBuildId:'006e1d55-f5d4-45d2-b956-25dbc28134d7',validationId:'872f96e1-6dcc-4f4e-a036-6b2577be4a6c',reportSha256:'aab1f6d1c562f828338c63f29314ea507c06d46b1c0ec62f4d608670d9f17c10',repairImage:'sha256:fdde4b1505f52eb815b6f716343ef548fb382f620a698bebddbeed8088d6a2fc'};
assert.equal(receipt.taskId,expected.taskId);
const api=async route=>{const r=await fetch('http://127.0.0.1:3000'+route,{headers:{Connection:'close'},signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);return r.json();};
const history=await api(`/v1/tasks/${receipt.taskId}/messages`);assert.equal(history.task.status,'stopped');
const session=new ComposeSessionStore(root).load(history.task.executionSessionId);
assert.equal(session.id,expected.sessionId);
assert.equal(session.runtimeReleased,true);assert.equal(session.runs.length,2);assert.ok(session.runs.every(r=>r.status==='succeeded'));
assert.equal(history.messages.length,4);assert.deepEqual(history.messages.map(m=>[m.role,m.status]),[['user','complete'],['assistant','complete'],['user','complete'],['assistant','complete']]);
// Terminal chat persistence is distinct from successful candidate submission.
const savedHistoryBytes=fs.readFileSync('runtime/repair-repair-running-history.json'),savedHistory=JSON.parse(savedHistoryBytes);
assert.equal(savedHistory.task.id,expected.taskId);assert.deepEqual(savedHistory.messages,history.messages);
const db=new DatabaseSync('runtime/tool-registry/registry.sqlite',{readOnly:true});let added,validations;
try{added=db.prepare('SELECT * FROM tool_proposals ORDER BY rowid').all().slice(before.tables.tool_proposals.length);validations=db.prepare('SELECT * FROM tool_validations ORDER BY rowid').all().slice(before.tables.tool_validations.length);}finally{db.close();}
assert.equal(added.length,1);assert.equal(added[0].id,expected.proposalId);assert.equal(validations.length,1);
const original=getToolProposalSource(added[0].id,{root});assert.equal(original.attempt,0);assert.equal(original.repair,null);assert.equal(original.registry.state,'verification_failed');
const draft=read('examples/09-controlled-tool-repair/proposal.draft.json');assert.deepEqual(original.input,{...draft,runtimeArtifact:original.input.runtimeArtifact});
const proposeCalls=history.runEvents.filter(e=>e.type==='tool_start'&&e.payload.toolName==='mcp'&&e.payload.args?.tool==='sirna_tools_propose_exploration_tool');assert.equal(proposeCalls.length,2);
const inputs=proposeCalls.map((e,index)=>{assert.equal(e.runId,session.runs[index].runId);assert.equal(typeof e.payload.args.args,'string');return JSON.parse(e.payload.args.args);});
const [rootInput,repairInput]=inputs;assert.deepEqual(rootInput,original.input);for(const input of inputs)assert.equal(checkToolProposal(input).ok,true);
assert.equal(Object.hasOwn(original.input,'parent'),false);assert.deepEqual(repairInput.parent,{toolName:'summarize_numeric_range_repair',version:'1.0.0'});
assert.throws(()=>assertRepairContract(original.input,repairInput),/preserve the original contract/);
const {parent:oldParent,...oldFrozen}=frozenToolContract(original.input),{parent:changedParent,...repairFrozen}=frozenToolContract(repairInput);assert.equal(oldParent,null);assert.deepEqual(changedParent,repairInput.parent);assert.deepEqual(repairFrozen,oldFrozen);assert.equal(repairInput.name,original.input.name);assert.notEqual(repairInput.script,original.input.script);
// Pure in-memory diagnostic; never submitted, registered, or executed.
const diagnosticInput=structuredClone(repairInput);delete diagnosticInput.parent;assert.equal(checkToolProposal(diagnosticInput).ok,true);assert.doesNotThrow(()=>assertRepairContract(original.input,diagnosticInput));
const proposalOutcomes=history.runEvents.filter(e=>e.payload.type==='builder_tool_call'&&e.payload.toolName==='propose_exploration_tool');assert.deepEqual(proposalOutcomes.map(e=>[e.runId,e.payload.success]),session.runs.map((r,index)=>[r.runId,index===0]));
const repairResponse=history.runEvents.filter(e=>e.type==='tool_end'&&e.payload.toolCallId===proposeCalls[1].payload.toolCallId);assert.equal(repairResponse.length,1);assert.equal(repairResponse[0].payload.isError,true);assert.ok(repairResponse[0].payload.result.content.some(c=>c.type==='text'&&c.text.includes('Tool builder call failed; an accepted operation may have completed.')));
assert.equal(rootInput.runtimeArtifact.buildSessionId,expected.rootBuildId);assert.equal(repairInput.runtimeArtifact.buildSessionId,expected.repairBuildId);assert.equal(repairInput.runtimeArtifact.imageDigest,expected.repairImage);
const oldBuildIds=new Set(Object.keys(before.builds).map(f=>f.split(/[\\/]/)[2]));
const newBuildIds=fs.readdirSync('runtime/tool-builds',{withFileTypes:true}).filter(d=>d.isDirectory()&&!oldBuildIds.has(d.name)).map(d=>d.name).sort();
assert.deepEqual(newBuildIds,[expected.rootBuildId,expected.repairBuildId].sort());
const docker=new DockerEngineClient(path.join(root,'runtime/docker/run/docker.sock'));let buildContainers=0;const successfulBuildCommandsByTurn=[];
for(const [index,input] of inputs.entries()){
 const run=session.runs[index],owner={taskId:receipt.taskId,executionSessionId:session.id,sandboxId:session.sandboxId,agentTurnId:run.agentTurnId,agentRunId:run.runId};if(index===0)assert.deepEqual(original.source,owner);
 const buildId=input.runtimeArtifact.buildSessionId,events=fs.readFileSync(`runtime/tool-builds/${buildId}/events.jsonl`,'utf8').trim().split('\n').map(JSON.parse);
 for(const e of events){assert.deepEqual(e.taskContext,owner);assert.equal(e.sessionId,buildId);}
 const created=events.filter(e=>e.type==='container_created'),cleaned=events.filter(e=>e.type==='container_cleaned');assert.equal(created.length,2);assert.deepEqual(created.map(e=>e.containerId).sort(),cleaned.map(e=>e.containerId).sort());
 for(const e of created){await assert.rejects(docker.inspectContainer(e.containerId),error=>error.statusCode===404);buildContainers++;}
 if(index===0){const saved=read(`runtime/tool-builds/${buildId}/proposal-result.json`);assert.equal(saved.proposalId,original.registry.id);}
 else {assert.equal(fs.existsSync(`runtime/tool-builds/${buildId}/proposal-result.json`),false);assert.equal(events.some(e=>['proposal_submit','proposal_registered','proposal_submission_failed','session_failed'].includes(e.type)),false);}
 const finalized=read(`runtime/tool-builds/${buildId}/finalized.json`);assert.equal(finalized.script,input.script);assert.equal(finalized.sourceSha256,hash(input.script));assert.deepEqual(finalized.artifact,input.runtimeArtifact);assert.deepEqual(finalized.taskContext,owner);
 const finalEvents=events.filter(e=>e.type==='finalized');assert.equal(finalEvents.length,1);assert.deepEqual(finalEvents[0].artifact,input.runtimeArtifact);assert.equal(finalEvents[0].sourceSha256,hash(input.script));
 const image=await docker.inspectImage(input.runtimeArtifact.imageDigest);assert.equal(image.Id,input.runtimeArtifact.imageDigest);assert.equal(image.Config.Labels['sirna.tool.source-sha256'],hash(input.script));
 const commands=history.runEvents.filter(e=>e.runId===run.runId&&e.payload.type==='builder_tool_call'&&e.payload.toolName==='run_tool_build_command'&&e.payload.success===true);assert.equal(commands.length,1);successfulBuildCommandsByTurn.push(commands.length);
 const debug=events.filter(e=>e.type==='debug_result');assert.equal(debug.length,1);assert.equal(debug[0].result.exitCode,0);assert.equal(debug[0].result.stderr,'');
 const outputs=debug[0].result.stdout.trim().split('\n').map(JSON.parse);assert.deepEqual(outputs,index===0?[{count:3,min:-2,max:5,range:7}]:[{count:3,min:-2,max:5,range:7},{count:3,min:2,max:6,range:4},{count:1,min:-3,max:-3,range:0}]);
}
const oldReport=getLatestToolValidationReport(original.registry.id,{root});assert.equal(oldReport.id,expected.validationId);assert.equal(oldReport.reportSha256,expected.reportSha256);assert.equal(oldReport.report.passed,false);
assert.deepEqual(oldReport.report.domainCases.map(c=>c.expectationPassed),[false,true,true]);assert.deepEqual(oldReport.report.domainCases[0].run.output,{count:3,min:6,max:4,range:-2});
assert.deepEqual(oldReport.report.benchmarkGate,{candidateScore:1,baselineScore:1,netGain:0,minNetGain:1,passed:false});
const jobsDb=new DatabaseSync('runtime/tool-maintenance/jobs.sqlite',{readOnly:true});let jobs;
try{jobs=jobsDb.prepare('SELECT * FROM jobs ORDER BY rowid').all().slice(before.jobRows.jobs.length);}finally{jobsDb.close();}
assert.equal(jobs.length,1);let validationContainers=0;
for(const job of jobs){assert.equal(job.proposal_id,original.registry.id);assert.equal(job.status,'succeeded');const events=fs.readFileSync(`runtime/tool-maintenance/runs/${job.id}/events.jsonl`,'utf8').trim().split('\n').map(JSON.parse),created=events.filter(e=>e.type==='validation_container_created'),cleaned=events.filter(e=>e.type==='validation_container_cleaned');assert.equal(created.length,11);assert.deepEqual(created.map(e=>e.containerId).sort(),cleaned.map(e=>e.containerId).sort());for(const e of created){await assert.rejects(docker.inspectContainer(e.containerId),error=>error.statusCode===404);validationContainers++;}}
const repairDb=new DatabaseSync('runtime/tool-repair/repairs.sqlite',{readOnly:true});let ticket;
try{const rows=repairDb.prepare('SELECT * FROM repairs').all();assert.equal(rows.length,1);ticket=rows[0];}finally{repairDb.close();}
assert.equal(ticket.proposal_id,original.registry.id);assert.equal(ticket.phase,'awaiting_replacement');assert.equal(hash(ticket.payload_json),ticket.payload_sha256);
const payload=JSON.parse(ticket.payload_json);assert.equal(payload.prompt,history.messages[2].content);assert.equal(payload.promptSha256,hash(payload.prompt));assert.equal(payload.validationId,oldReport.id);assert.equal(payload.reportSha256,oldReport.reportSha256);
assert.equal(payload.requestId,`auto-tool-repair:${original.registry.id}`);assert.equal(history.messages[2].clientRequestId,payload.requestId);
assert.deepEqual(payload.contract,frozenToolContract(original.input));assert.ok(payload.prompt.includes(JSON.stringify(original.input)));assert.ok(payload.prompt.includes(JSON.stringify(oldReport.report)));
// Reconstruct only the saved pre-propose registration view. The real ticket is
// not reopened: all task/store methods below are read-only in-memory facades.
const repairRun=session.runs[1],repairContext={taskId:receipt.taskId,executionSessionId:session.id,sandboxId:session.sandboxId,agentTurnId:repairRun.agentTurnId,agentRunId:repairRun.runId};
const diagnosticTicket={...payload,phase:'running'},diagnosticRepair=createToolRepair({root,store:{byRequest:requestId=>requestId===payload.requestId?diagnosticTicket:null,activeForTask:taskId=>taskId===receipt.taskId?[diagnosticTicket]:[]},taskStore:{getTask:taskId=>taskId===receipt.taskId?{...history.task,status:'running',currentRunId:repairRun.runId}:null,listMessages:()=>history.messages.slice(0,3),listRunEvents:()=>history.runEvents.filter(e=>e.runId===repairRun.runId&&e.sequence<proposeCalls[1].sequence)}});
assert.throws(()=>diagnosticRepair.registration(repairInput,repairContext),error=>error instanceof ToolRepairError&&error.code==='registration_refused');
const diagnosticAssociation=diagnosticRepair.registration(diagnosticInput,repairContext);assert.deepEqual(diagnosticAssociation,{requestId:payload.requestId,rootProposalId:original.registry.id,previousProposalId:original.registry.id,attempt:1});
const status=await api(`/v1/tool-proposals/${original.registry.id}/repair-status`);assert.equal(status.repair.phase,'awaiting_replacement');assert.equal(status.repair.replacementProposalId,null);assert.equal(status.canRepair,false);assert.equal(status.sourceTaskId,receipt.taskId);
assert.equal((await api('/v1/tool-proposals/cf7cc77a-b835-4c0c-8946-1b1f25d3749b/repair-status')).sourceTaskId,null);
const workspace=path.resolve(root,session.workspacePath);assert.equal(fs.existsSync(path.join(workspace,'.sirna-task-context.json')),false);
const nativeDir=path.resolve(workspace,'../state/agents/providers/pi/sessions'),native=fs.readdirSync(nativeDir).filter(f=>f.endsWith('.jsonl')).map(f=>path.join(nativeDir,f)).find(f=>JSON.parse(fs.readFileSync(f,'utf8').split('\n')[0]).id===session.piSessionId);assert.ok(native);
const nativeBytes=fs.readFileSync(native),messages=nativeBytes.toString().trim().split('\n').map(JSON.parse).filter(x=>x.type==='message').map(x=>x.message),model=messages.filter(m=>m.role==='assistant'),calls=model.flatMap(m=>m.content.filter(c=>c.type==='toolCall'));
const usageKnown=model.every(m=>['input','output','cacheRead','cacheWrite','totalTokens'].every(k=>Number.isSafeInteger(m.usage?.[k])&&m.usage[k]>=0));
const usageTotals=usageKnown?Object.fromEntries(['input','output','cacheRead','cacheWrite','totalTokens'].map(k=>[k,model.reduce((n,m)=>n+m.usage[k],0)])):null;
const errors=messages.filter(m=>m.role==='toolResult'&&m.isError).map(m=>({toolName:m.toolName,toolCallId:m.toolCallId}));
assert.deepEqual(await preserve({phase:'ended'}),preserved);
console.log(JSON.stringify({ok:true,auditScope:'observed_evidence_only',outcome:'repair_submission_rejected',taskId:receipt.taskId,sourceSessionId:session.id,rootProposalId:original.registry.id,replacementProposalId:null,attemptedRepairBuildId:expected.repairBuildId,rootValidationId:oldReport.id,newValidationId:null,rootReportSha256:oldReport.reportSha256,newReportSha256:null,rootPassed:false,replacementPassed:null,modelRepairSucceeded:false,proposalSchemaValid:true,frozenContractUnchanged:false,parentContractViolated:true,otherFrozenFieldsUnchanged:true,diagnosticRegistration:{inMemoryOnly:true,actualPayloadRefused:true,parentOmissionAssociation:diagnosticAssociation,submitted:false,registered:false,executed:false},sourceContextsMatch:true,repairPhase:status.repair.phase,rootTurns:1,repairTurns:1,proposeCalls:2,registeredNewProposals:1,modelResponses:model.length,piToolCalls:calls.length,toolErrors:errors,usageKnown,usageTotals,actualCostKnown:false,successfulBuildCommandCalls:2,successfulBuildCommandsByTurn,repairDebugCases:3,buildContainers,validationContainers,allTemporaryContainersRemoved:true,guestReleased:true,approved:false,activated:false,savedRunningHistorySha256:hash(savedHistoryBytes),nativeSessionSha256:hash(nativeBytes),...preserved},null,2));
