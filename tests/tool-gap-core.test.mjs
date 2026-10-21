import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {gapFixture,gapInput} from './helpers/tool-gap-fixture.mjs';
import {createToolCurationPreview} from '../packages/extensions/tool-curation/tool-curation-preview.mjs';
import {buildCurationPreview} from '../packages/extensions/tool-curation/tool-curation-trace.mjs';
import {buildToolCurationTrace,curationSha256,traceSha256} from '../packages/extensions/tool-curation/tool-curation-evidence.mjs';
import {createToolCurationService} from '../packages/extensions/tool-curation/tool-curation-service.mjs';
import {validateToolCurationResult,toolCurationPrompt} from '../packages/extensions/tool-curation/tool-curation-result.mjs';
import {ToolCurationBuildStore} from '../packages/extensions/tool-curation/tool-curation-build-store.mjs';
import {createToolCurationBuildService} from '../packages/extensions/tool-curation/tool-curation-build-service.mjs';
const storage=await import('../packages/extensions/tool-curation/tool-gap-store.mjs').catch(()=>({}));
const api=await import('../packages/extensions/tool-curation/tool-gap-service.mjs').catch(()=>({}));
function fixture(t){assert.equal(typeof storage.ToolGapStore,'function','trusted gap store is available');const f=gapFixture(t),gaps=new storage.ToolGapStore({root:f.root});f.closers.push(()=>gaps.close());return {...f,gaps,service:api.createToolGapService({store:gaps,taskStore:f.tasks,curationStore:f.curations})};}

test('trusted current turn persists one normalized capability without creating any candidate',t=>{
  const f=fixture(t),a=f.service.report(gapInput(),f.context),b=f.service.report(gapInput({capability:' compare RNA STRUCTURES!! ',reason:'Another report must not overwrite the first.'}),f.context);
  assert.equal(a.candidateCreated,false);assert.equal(a.toolCreated,false);assert.equal(a.nextGate,'finish_current_turn_then_manual_curator_review');assert.equal(a.deduplicated,false);assert.equal(b.deduplicated,true);assert.equal(b.report.id,a.report.id);assert.equal(b.report.reason,a.report.reason);
  assert.equal(a.report.capabilityKey,'compare-rna-structures');assert.deepEqual(a.report.source,f.context);assert.equal(a.report.userMessageId,f.message.id);assert.equal(f.gaps.list(f.task.id,f.runId).length,1);assert.deepEqual(f.service.list(f.task.id,f.runId),[a.report]);assert.deepEqual(f.curations.list(f.task.id),[]);
});
test('foreign identities, old users, terminal events and frozen rounds cannot add reports',t=>{
  const f=fixture(t);for(const field of ['taskId','executionSessionId','agentRunId'])assert.throws(()=>f.service.report(gapInput(),{...f.context,[field]:randomUUID()}),e=>[404,409].includes(e.statusCode));
  assert.throws(()=>f.service.report(gapInput({taskId:f.task.id}),f.context),e=>e.statusCode===400);
  assert.throws(()=>f.service.report(gapInput({evidenceEventIds:[randomUUID()]}),f.context),e=>e.statusCode===409);
  f.finish();assert.throws(()=>f.service.report(gapInput(),f.context),e=>e.statusCode===409);assert.equal(f.gaps.list(f.task.id,f.runId).length,0);
});
test('strict JSON, object sketches, unique references and redaction are enforced before persistence',t=>{
  const f=fixture(t);const getter={...gapInput()};Object.defineProperty(getter,'reason',{enumerable:true,get(){throw Error('must not execute getter');}});
  for(const args of [getter,gapInput({blocking:'false'}),gapInput({capability:'!?!!'}),gapInput({desiredInput:[]}),gapInput({desiredOutput:JSON.parse('{"constructor":{}}')}),gapInput({evidenceEventIds:['x','x']}),gapInput({evidenceEventIds:['']}),gapInput({desiredInput:{x:undefined}})])assert.throws(()=>f.service.report(args,f.context),e=>e.statusCode===400);
  assert.throws(()=>f.service.report(gapInput({desiredInput:{x:'a'.repeat(4096)}}),f.context),e=>e.statusCode===413);
  const report=f.service.report(gapInput({reason:'Call https://user:pass@example.test/path?token=private and token=private',desiredInput:{token:'secret',url:'https://example.test/?key=private'}}),f.context).report;
  assert.ok(!JSON.stringify(report).includes('private'));assert.equal(report.desiredInput.token,'[REDACTED]');assert.match(report.reportSha256,/^[a-f0-9]{64}$/);
});
test('per-run capacity is bounded while duplicate reports still return the first stored record',t=>{
  const f=fixture(t);for(let i=0;i<10;i++)f.service.report(gapInput({capability:`Capability ${i}`}),f.context);
  assert.equal(f.service.report(gapInput({capability:'Capability 0'}),f.context).deduplicated,true);assert.throws(()=>f.service.report(gapInput({capability:'Capability eleven'}),f.context),e=>e.statusCode===413);assert.equal(f.gaps.list(f.task.id,f.runId).length,10);
});
test('database reopen retains reports, immutable rows reject updates, and read-only cannot create',t=>{
  const f=fixture(t),report=f.service.report(gapInput(),f.context).report;
  const db=new DatabaseSync(f.gaps.databasePath);assert.throws(()=>db.prepare('UPDATE gap_reports SET report_json=? WHERE id=?').run('{}',report.id));db.close();
  const reopened=new storage.ToolGapStore({root:f.root,readOnly:true});try{assert.deepEqual(reopened.list(f.task.id,f.runId),[report]);assert.throws(()=>reopened.create({...gapInput({capability:'Another capability'}),taskId:f.task.id,runId:f.runId,userMessageId:f.message.id,source:f.context}));}finally{reopened.close();}
});
test('unrecognized schema and database hard links are rejected instead of migrated',t=>{
  const f=gapFixture(t),folder=path.join(f.root,'runtime','tool-gaps');fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,'gaps.sqlite'),db=new DatabaseSync(file);db.exec('CREATE TABLE unrelated(x)');db.close();assert.throws(()=>new storage.ToolGapStore({root:f.root}));
  fs.unlinkSync(file);const other=path.join(f.root,'other.sqlite'),linked=new DatabaseSync(other);linked.close();fs.linkSync(other,file);assert.throws(()=>new storage.ToolGapStore({root:f.root}));
});
function previewFor(f,listGapReports=(taskId,runId)=>f.service.list(taskId,runId)){return createToolCurationPreview({taskStore:f.tasks,listExistingTools:()=>[],listGapReports});}
function candidate(run,report){return {protocolVersion:'sirna-tool-curation-result/v1',curationId:run.id,traceSha256:run.traceSha256,decision:'candidate',summary:'Compare the supplied structures',candidate:{capabilityKey:report.capabilityKey,suggestedToolName:'compare_rna_shapes',capabilityBoundary:'Structure distance only',whyExistingToolsAreInsufficient:'Existing tools do not compare structures',evidenceEventIds:[report.id],inputContractSketch:{structures:'string[]'},outputContractSketch:{distance:'number'},permissions:{profile:'no_external_access'},buildInstructions:['Implement a deterministic local distance; do not access network.']}};}
test('gap-only finished turn freezes full reports without fabricating repeated-call signals',t=>{
  const f=fixture(t),first=f.service.report(gapInput(),f.context),preview=previewFor(f);assert.throws(()=>preview.read(f.task.id),e=>e.statusCode===409);f.finish();
  const snapshot=preview.snapshot(f.task.id);assert.equal(snapshot.preview.eligibleForReview,true);assert.deepEqual(snapshot.preview.signals,[]);assert.deepEqual(snapshot.preview.gapReports,[first.report]);
  const trace=buildToolCurationTrace({id:randomUUID(),snapshot});assert.equal(trace.trigger,'online_gap');assert.deepEqual(trace.calls,[]);assert.equal(trace.gapReports[0].id,first.report.id);assert.deepEqual(trace.gapEvidence,[]);
});
test('gap evidence freezes sanitized referenced public events and binds both preview digests',t=>{
  const f=fixture(t);const event=f.tasks.appendRunEvent(f.task.id,f.message.id,f.runId,'progress_message',{url:'https://user:pass@example.test/path?token=PRIVATE',token:'PRIVATE',text:'Need local comparator'});
  const first=f.service.report(gapInput({evidenceEventIds:[event.id]}),f.context).report;f.finish();
  const plain=previewFor(f,()=>[]).snapshot(f.task.id),snapshot=previewFor(f).snapshot(f.task.id),trace=buildToolCurationTrace({id:randomUUID(),snapshot});
  assert.notEqual(snapshot.preview.sourceSha256,plain.preview.sourceSha256);assert.notEqual(snapshot.preview.previewSha256,plain.preview.previewSha256);assert.equal(trace.gapEvidence[0].id,event.id);assert.equal(trace.gapEvidence[0].payload.text,'Need local comparator');assert.ok(!JSON.stringify(trace).includes('PRIVATE'));assert.equal(trace.gapReports[0].id,first.id);
  const bad=structuredClone(snapshot);bad.preview.gapReports[0].reason='Tampered';const {previewSha256:ignored,...body}=bad.preview;bad.preview.previewSha256=curationSha256(body);assert.throws(()=>buildToolCurationTrace({id:randomUUID(),snapshot:bad}));
});
test('foreign, tampered and oversized reports cannot become partial previews',t=>{
  const f=fixture(t),report=f.service.report(gapInput(),f.context).report;f.finish();
  for(const reports of [[{...report,taskId:randomUUID()}],[{...report,reason:'altered'}]])assert.throws(()=>previewFor(f,()=>reports).read(f.task.id),e=>e.statusCode===409);
  assert.throws(()=>previewFor(f,()=>Array(11).fill(report)).read(f.task.id),e=>e.statusCode===413);
});
test('no-gap callback preserves old preview bytes, and a legal large sketch is saved whole',t=>{
  const f=fixture(t),array=Array(600).fill(0);const saved=f.service.report(gapInput({desiredInput:{array}}),f.context).report;assert.equal(saved.desiredInput.array.length,600);f.finish();
  const old=createToolCurationPreview({taskStore:f.tasks,listExistingTools:()=>[]}).read(f.task.id),empty=previewFor(f,()=>[]).read(f.task.id);assert.equal(JSON.stringify(empty),JSON.stringify(old));assert.equal(Object.hasOwn(old.preview,'gapReports'),false);
});
test('one manual independent review accepts gap IDs and leaves candidate available to existing Builder view',async t=>{
  const f=fixture(t),report=f.service.report(gapInput(),f.context).report;f.finish();const preview=previewFor(f);let calls=0;
  const review=createToolCurationService({store:f.curations,preview,curator:{async curate(run,signal,onStarted){calls++;const sessionId=randomUUID(),runId=randomUUID();onStarted(sessionId,runId);return {sessionId,runId,result:candidate(run,report),cleanupConfirmed:true};}}});review.start();
  const p=preview.read(f.task.id).preview,binding={runId:f.runId,sourceSha256:p.sourceSha256,previewSha256:p.previewSha256};const a=await review.request(f.task.id,binding),b=await review.request(f.task.id,binding);await review.stop();assert.equal(b.deduplicated,true);assert.equal(calls,1);
  const record=f.curations.get(f.task.id,a.curation.id);assert.equal(record.trigger,'online_gap');assert.equal(record.status,'candidate');assert.match(toolCurationPrompt(record),/model.*claim|claim.*model/i);
  const builds=new ToolCurationBuildStore({root:f.root});f.closers.push(()=>builds.close());const build=createToolCurationBuildService({root:f.root,store:builds,curationStore:f.curations,taskStore:f.tasks,taskMessages:{},agentRuntime:{async describe(){return {backend:'agent-compose',sandboxId:f.context.sandboxId,supportsLifecycle:true,builderToolsAvailable:true};},async assertWorkspaceIdle(){}},listExistingTools:()=>[]});f.closers.push(()=>build.stop());const view=await build.view(f.task.id,record.id);assert.equal(view.eligible,true);assert.match(view.prompt,/compare_rna_shapes/);assert.equal(f.tasks.listMessages(f.task.id).length,2);
});
test('gap candidate must cite its own capability report and may only add frozen events from that group',t=>{
  const f=fixture(t),event=f.event,one=f.service.report(gapInput({evidenceEventIds:[event.id]}),f.context).report,two=f.service.report(gapInput({capability:'Find RNA targets'}),f.context).report;f.finish();const trace=buildToolCurationTrace({id:randomUUID(),snapshot:previewFor(f).snapshot(f.task.id)}),run={id:trace.curationId,traceSha256:trace.traceSha256,trace};
  const value=candidate(run,one);assert.deepEqual(validateToolCurationResult(run,value),value);value.candidate.evidenceEventIds=[one.id,event.id];assert.doesNotThrow(()=>validateToolCurationResult(run,value));
  for(const refs of [[event.id],[two.id],[one.id,two.id],[one.id,randomUUID()]]){value.candidate.evidenceEventIds=refs;assert.throws(()=>validateToolCurationResult(run,value));}
  value.candidate.evidenceEventIds=[one.id];trace.gapEvidence[0].payload.status='tampered';assert.throws(()=>validateToolCurationResult(run,value));
});
test('explicit null references are rejected rather than treated as omitted',t=>{
  const f=fixture(t);assert.throws(()=>f.service.report(gapInput({evidenceEventIds:null}),f.context),e=>e.statusCode===400);
});
test('nested proxies are rejected without invoking proxy traps',t=>{
  const f=fixture(t);
  let traps=0;const proxy=new Proxy({x:1},{getPrototypeOf(){traps++;throw Error('private proxy trap');}});assert.throws(()=>f.service.report(gapInput({desiredInput:{proxy}}),f.context),e=>e.statusCode===400);assert.equal(traps,0);assert.deepEqual(f.gaps.list(f.task.id,f.runId),[]);
});
test('a configured broken gap reader cannot silently produce a no-gap preview',t=>{
  const f=fixture(t);f.finish();assert.throws(()=>previewFor(f,()=>undefined).read(f.task.id),e=>e.statusCode===409);
});
test('aggregate report bytes reject the next unique payload while preserving duplicates',t=>{
  const f=fixture(t),input=gapInput({desiredInput:{x:'x'.repeat(3900)},desiredOutput:{x:'x'.repeat(3900)},reason:'a'.repeat(3900)});for(let i=0;i<2;i++)f.service.report({...input,capability:`Large capability ${i}`},f.context);
  assert.throws(()=>f.service.report({...input,capability:'Large capability three'},f.context),e=>e.statusCode===413);assert.equal(f.gaps.list(f.task.id,f.runId).length,2);assert.equal(f.service.report({...input,capability:'Large capability 0'},f.context).deduplicated,true);
});
test('a complete referenced event that exceeds trace envelope is refused instead of clipped',t=>{
  const f=fixture(t),event=f.tasks.appendRunEvent(f.task.id,f.message.id,f.runId,'progress_message',{text:'x'.repeat(66000)});f.service.report(gapInput({evidenceEventIds:[event.id]}),f.context);f.finish();
  assert.throws(()=>buildToolCurationTrace({id:randomUUID(),snapshot:previewFor(f).snapshot(f.task.id)}),e=>e instanceof RangeError);
});
test('frozen review and old user bindings refuse new reports even if task running metadata is forged back',t=>{
  const f=fixture(t);f.service.report(gapInput(),f.context);f.finish();const trace=buildToolCurationTrace({id:randomUUID(),snapshot:previewFor(f).snapshot(f.task.id)});f.curations.create(trace);f.tasks.updateExecution(f.task.id,{status:'running'});assert.throws(()=>f.service.report(gapInput({capability:'New capability'}),f.context),e=>e.statusCode===409);
  const g=fixture(t);g.tasks.appendAssistantMessage(g.task.id,'Incomplete old round','complete');g.tasks.beginTurn(g.task.id,'Another user request');g.tasks.updateExecution(g.task.id,{currentRunId:g.runId});assert.throws(()=>g.service.report(gapInput(),g.context),e=>e.statusCode===409);assert.deepEqual(g.gaps.list(g.task.id,g.runId),[]);
});
test('read-side report count is bounded before decoding untrusted persisted JSON',t=>{
  const f=fixture(t),db=new DatabaseSync(f.gaps.databasePath);for(let i=0;i<11;i++)db.prepare('INSERT INTO gap_reports VALUES(?,?,?,?,?,?)').run(randomUUID(),f.task.id,f.runId,`cap-${i}`,'x','{}');db.close();assert.throws(()=>f.gaps.list(f.task.id,f.runId),e=>e.statusCode===413);
});
test('persisted payload tampering is detected and guarded schema cannot be reopened after a guard is removed',t=>{
  const f=fixture(t),saved=f.service.report(gapInput(),f.context).report,db=new DatabaseSync(f.gaps.databasePath);assert.throws(()=>db.prepare('DELETE FROM gap_reports WHERE id=?').run(saved.id));db.exec('DROP TRIGGER gap_report_immutable');const changed={...saved,reason:'Tampered persisted reason'};db.prepare('UPDATE gap_reports SET report_json=? WHERE id=?').run(JSON.stringify(changed),saved.id);db.close();assert.throws(()=>f.gaps.list(f.task.id,f.runId),e=>e.statusCode===409);assert.throws(()=>new storage.ToolGapStore({root:f.root,readOnly:true}));
});
for(const suffix of ['-wal','-shm','-journal'])test(`gap database refuses hardlinked ${suffix} before touching unrelated content`,t=>{
  const f=gapFixture(t),created=new storage.ToolGapStore({root:f.root}),file=created.databasePath;created.close();const other=path.join(f.root,'preserved');fs.writeFileSync(other,'preserved');fs.linkSync(other,file+suffix);assert.throws(()=>new storage.ToolGapStore({root:f.root}));assert.equal(fs.readFileSync(other,'utf8'),'preserved');
});
test('gap database refuses a redirected runtime parent',t=>{
  const f=gapFixture(t),elsewhere=path.join(f.root,'elsewhere');fs.mkdirSync(elsewhere);fs.symlinkSync(elsewhere,path.join(f.root,'runtime','tool-gaps'),process.platform==='win32'?'junction':'dir');assert.throws(()=>new storage.ToolGapStore({root:f.root}));assert.deepEqual(fs.readdirSync(elsewhere),[]);
});
