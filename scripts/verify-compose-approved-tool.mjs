// Read-only acceptance for the step 10G web exercise. No model/tool execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {ComposeSessionStore,executionId} from '../packages/agent-runtime/compose-session-store.mjs';
import {DockerEngineClient} from '../packages/capability-platform/docker-engine-client.mjs';
import {getRegisteredToolCatalog} from '../packages/capability-platform/tool-approval-service.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const [taskId,mode,...extra]=process.argv.slice(2);assert.ok(executionId.test(taskId)&&['completed','ended'].includes(mode)&&!extra.length);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const response=await fetch(`http://127.0.0.1:3000/v1/tasks/${taskId}/messages`);assert.equal(response.status,200);const history=await response.json();
assert.equal(history.task.status,mode==='ended'?'stopped':'idle');assert.equal(history.execution.approvedToolsAvailable,true);
const store=new ComposeSessionStore(root);const session=store.load(history.task.executionSessionId);store.assertConversation(session);
assert.equal(session.remoteApprovedTools,true);assert.equal(session.runs.length,1);const run=session.runs[0];assert.equal(run.status,'succeeded');
assert.equal(run.runId,history.task.currentRunId);assert.equal(history.messages.length,2);assert.equal(history.messages[1].status,'complete');
const workspace=path.join(root,session.workspacePath);assert.equal(fs.existsSync(path.join(workspace,'.sirna-task-context.json')),false);
const dir=path.join(root,'runtime/approved-tool-runs/summarize_target_sequence');
const matches=fs.readdirSync(dir).map(id=>JSON.parse(fs.readFileSync(path.join(dir,id,'audit.json')))).filter(a=>a.taskContext?.taskId===taskId);
assert.equal(matches.length,1);const audit=matches[0];
assert.deepEqual(audit.taskContext,{taskId,executionSessionId:session.id,sandboxId:session.sandboxId,agentTurnId:run.agentTurnId,agentRunId:run.runId});
assert.equal(audit.success,true);assert.equal(audit.cleanupConfirmed,true);assert.equal(audit.toolVersion,'1.0.0');
const catalog=getRegisteredToolCatalog({root});const tool=catalog.tools.find(t=>t.toolName==='summarize_target_sequence');assert.ok(tool);
assert.equal(audit.toolId,tool.toolId);assert.equal(audit.packageSha256,tool.packageSha256);assert.equal(audit.imageDigest,tool.imageDigest);
const input={sequence:'AACCGGGUUUA'},output={length:11,gcFraction:5/11};
assert.equal(audit.inputSha256,hash(JSON.stringify(input)));assert.equal(audit.outputSha256,hash(JSON.stringify(output)));
const fileBytes=fs.readFileSync(path.join(workspace,'output/approved-summary.json'));
assert.deepEqual(JSON.parse(fileBytes.toString()),output);
const saved=fs.readFileSync(path.join(root,'runtime/task-files',taskId,'output/approved-summary.json'));assert.deepEqual(saved,fileBytes);
const download=await fetch(`http://127.0.0.1:3000/v1/tasks/${taskId}/files/output/approved-summary.json?download=true`);assert.equal(download.status,200);
assert.deepEqual(Buffer.from(await download.arrayBuffer()),fileBytes);
const calls=history.runEvents.filter(e=>e.payload?.type==='approved_tool_call');assert.equal(calls.length,1);
assert.equal(calls[0].payload.toolCallId,audit.toolCallId);assert.equal(calls[0].payload.success,true);assert.equal(calls[0].runId,run.runId);
const nativeDir=path.join(workspace,'../state/agents/providers/pi/sessions');
const native=fs.readdirSync(nativeDir).filter(f=>f.endsWith('.jsonl')).map(f=>path.join(nativeDir,f)).find(f=>JSON.parse(fs.readFileSync(f,'utf8').split('\n')[0]).id===session.piSessionId);assert.ok(native);
const nativeBytes=fs.readFileSync(native);const records=nativeBytes.toString().trim().split('\n').map(JSON.parse);
const messages=records.filter(r=>r.type==='message').map(r=>r.message);
const tools=messages.filter(m=>m.role==='assistant').flatMap(m=>m.content.filter(c=>c.type==='toolCall'));
const business=tools.filter(c=>c.name==='mcp'&&c.arguments?.tool?.endsWith('summarize_target_sequence'));
assert.equal(business.length,1);assert.deepEqual(JSON.parse(business[0].arguments.args),{input});
const nativeResult=messages.find(m=>m.role==='toolResult'&&m.toolCallId===business[0].id);assert.ok(nativeResult&&!nativeResult.isError);
assert.deepEqual(JSON.parse(nativeResult.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')),output);
const writes=tools.filter(c=>c.name==='write');assert.equal(writes.length,1);assert.equal(writes[0].arguments.path,'/workspace/output/approved-summary.json');
assert.deepEqual(Buffer.from(writes[0].arguments.content),fileBytes);
assert.ok(tools.some(c=>c.name==='read'&&c.arguments.path==='/workspace/output/approved-summary.json'));
assert.equal(tools.some(c=>c.name==='read'&&c.arguments.path.includes('.sirna-task-context')),false);
const docker=new DockerEngineClient(path.join(root,'runtime/docker/run/docker.sock'));
await assert.rejects(docker.inspectContainer(audit.executionEvidence.containerId),e=>e.statusCode===404);
if(mode==='ended'){
  assert.equal(session.runtimeReleased,true);
  const info=JSON.parse(execFileSync('sh',['scripts/project-agent-compose.sh','inspect','sandbox',session.sandboxId],{cwd:root,encoding:'utf8'}));
  const sandbox=info.sandbox??info;assert.equal(sandbox.vm_status,'stopped');assert.equal(sandbox.stopped_runtime_state,'released');
}
console.log(JSON.stringify({ok:true,mode,taskId,executionSessionId:session.id,sandboxId:session.sandboxId,piSessionId:session.piSessionId,
  agentTurnId:run.agentTurnId,agentRunId:run.runId,toolCallId:audit.toolCallId,toolName:audit.toolName,toolId:audit.toolId,version:audit.toolVersion,
  packageSha256:audit.packageSha256,input,output,modelResponses:run.modelResponses,piToolCalls:tools.length,approvedToolExecutions:1,
  auditContextMatches:true,toolContainerAbsent:true,taskCapabilityFileRemoved:true,originalResultBytes:fileBytes.length,resultSha256:hash(fileBytes),
  archiveAndDownloadMatch:true,nativeSessionSha256:hash(nativeBytes),nativeSessionBytes:nativeBytes.length,guestReleased:mode==='ended'},null,2));
