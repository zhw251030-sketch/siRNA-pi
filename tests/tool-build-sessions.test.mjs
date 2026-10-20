import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BuildDocker,COMMAND,proposal,removeBuildTestRoot} from './helpers/tool-build-docker.mjs';
import {ToolRegistry} from '../packages/capability-platform/tool-registry.mjs';
import {executeToolArtifact} from '../packages/capability-platform/tool-build-service.mjs';
const api=await import('../packages/capability-platform/tool-build-sessions.mjs').catch(()=>({}));
export function fixture(t,{allowUnknownClose=false,...options}={}){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-builder-')));const docker=new BuildDocker();
  assert.equal(typeof api.createToolBuildSessionService,'function','session controller must implement consumer workflow');
  const service=api.createToolBuildSessionService({root,docker,...options});t.after(async()=>{try{if(allowUnknownClose)await assert.rejects(service.close(),/unknown/);else await service.close();}finally{removeBuildTestRoot(root);}});return {root,docker,service};}
test('real evidence and registry submit a clean source-only finalized image, with idempotent identities',async t=>{
  const {root,docker,service}=fixture(t);const created=await service.create();const id=created.session.id;
  assert.deepEqual(Object.keys(created.session).sort(),['createdAt','id','state']);assert.equal(created.session.state,'running');
  const p=proposal();await service.write({sessionId:id,path:'/opt/tool/main.mjs',content:p.script});
  const debug=await service.run({sessionId:id,command:'touch /tmp/build-only-marker; echo example'});assert.equal(debug.exitCode,0);
  const result=await service.finalize({sessionId:id,command:COMMAND});assert.equal(result.verified,false);
  const image=docker.images.get(result.artifact.imageDigest);assert.equal(image.files.has('/tmp/build-only-marker'),false);assert.equal(Buffer.from(image.files.get('/opt/tool/main.mjs')).toString(),p.script);
  assert.deepEqual((await service.finalize({sessionId:id,command:COMMAND})).artifact,result.artifact);assert.equal(docker.commits,1);
  assert.equal((await executeToolArtifact(result.artifact,{n:2},{docker})).output.n,2);
  const saved=await service.propose({...p,runtimeArtifact:result.artifact});assert.equal(saved.state,'submitted');assert.equal(saved.verified,false);assert.equal(saved.activated,false);
  const repeated=await service.propose({...p,runtimeArtifact:result.artifact});assert.equal(repeated.proposalId,saved.proposalId);
  const registry=new ToolRegistry(path.join(root,'runtime/tool-registry/registry.sqlite'),{readOnly:true});try{assert.equal(registry.getProposal(saved.proposalId).state,'submitted');assert.equal(registry.listActiveTools().length,0);}finally{registry.close();}
  assert.equal(docker.containers.size,0);const events=fs.readFileSync(path.join(root,'runtime/tool-builds',id,'events.jsonl'),'utf8');assert.match(events,/proposal_registered/);
  await assert.rejects(service.propose({...p,name:'Conflicting repeat',runtimeArtifact:result.artifact}),/conflict/i);
});
test('invalid transitions, source limits, foreign sessions and extra fields have no Docker effects',async t=>{
 const {service,docker,root}=fixture(t);const id=(await service.create()).session.id;const before=docker.calls.length;
 for(const call of [()=>service.create({extra:1}),()=>service.write({sessionId:id,path:'/tmp/a',content:'x'}),()=>service.write({sessionId:id,path:'/opt/tool/main.mjs',content:'é'.repeat(100001)}),()=>service.write({sessionId:id,path:'/opt/tool/main.mjs',content:'x',extra:1}),()=>service.run({sessionId:id,command:'echo hi',timeoutMs:99}),()=>service.run({sessionId:id,command:'x'.repeat(20001)}),()=>service.finalize({sessionId:id,command:['/bin/sh']}),()=>service.finalize({sessionId:id,command:COMMAND}),()=>service.cancel({sessionId:'1b259aaf-e661-40a3-a372-e166bdff2963'})])await assert.rejects(async()=>call());
 assert.equal(docker.calls.length,before);assert.equal(fs.existsSync(path.join(root,'runtime/tool-registry')),false);
 const foreign=api.createToolBuildSessionService({root,docker});await assert.rejects(async()=>foreign.cancel({sessionId:id}),/Unknown/);await foreign.close();
 await service.write({sessionId:id,path:'/opt/tool/main.mjs',content:'console.log(1)'});await service.run({sessionId:id,command:'true'});await service.write({sessionId:id,path:'/opt/tool/main.mjs',content:'console.log(2)'});await assert.rejects(service.finalize({sessionId:id,command:COMMAND}),/successful debug/);
 await service.cancel({sessionId:id});await assert.rejects(async()=>service.run({sessionId:id,command:'true'}));
});
test('busy operations refuse; close drains accepted run then confirms owned cleanup',async t=>{
 const {service,docker}=fixture(t);const id=(await service.create()).session.id;let release,entered;const ready=new Promise(r=>entered=r);const exec=docker.exec.bind(docker);
 docker.exec=async(...args)=>{if(args[1][0]==='/bin/sh'){entered();await new Promise(r=>release=r);}return exec(...args);};
 const run=service.run({sessionId:id,command:'true'});await ready;await assert.rejects(service.cancel({sessionId:id}),/busy/);const closing=service.close();await assert.rejects(service.create(),/closed/);assert.equal(docker.containers.size,1);release();await run;await closing;assert.equal(docker.containers.size,0);
});
test('nonzero command remains editable while transport timeout and excessive output invalidate session',async t=>{
 for(const mode of ['nonzero','timeout','output']){
 const {service,docker,root}=fixture(t);const id=(await service.create()).session.id;
 if(mode==='nonzero')docker.debug.exitCode=2;
 if(mode==='output')docker.debug.stdout='x'.repeat(65537);
 if(mode==='timeout'){const exec=docker.exec.bind(docker);docker.exec=async(...a)=>{if(a[1][0]==='/bin/sh')throw Object.assign(new Error('private timeout'),{code:'DOCKER_TIMEOUT'});return exec(...a);};}
 if(mode==='nonzero'){assert.equal((await service.run({sessionId:id,command:'false'})).success,false);await service.write({sessionId:id,path:'/opt/tool/main.mjs',content:'console.log(1)'});}
 else{await assert.rejects(service.run({sessionId:id,command:'bad'}),e=>e.cleanupConfirmed===true);assert.equal(docker.containers.size,0);await assert.rejects(async()=>service.run({sessionId:id,command:'true'}));assert.match(fs.readFileSync(path.join(root,'runtime/tool-builds',id,'events.jsonl'),'utf8'),/session_failed/);}
 }
});
test('cleanup failure preserves unknown status, and close retries only the owned container',async t=>{
 const {service,docker,root}=fixture(t);const id=(await service.create()).session.id;docker.failAt='removeContainer';await assert.rejects(service.cancel({sessionId:id}),e=>e.cleanupConfirmed===false);
 assert.equal(docker.containers.size,1);assert.match(fs.readFileSync(path.join(root,'runtime/tool-builds',id,'events.jsonl'),'utf8'),/"cleanupConfirmed":false/);await service.close();assert.equal(docker.containers.size,0);
});
test('idle TTL cleans containers and session limits refuse without creating evidence or containers',async t=>{
 const {service,docker}=fixture(t,{ttlMs:15,maxLiveSessions:1,maxSessions:2});const id=(await service.create()).session.id;await assert.rejects(service.create(),/limit/);await new Promise(r=>setTimeout(r,70));assert.equal(docker.containers.size,0);await assert.rejects(async()=>service.cancel({sessionId:id}));const id2=(await service.create()).session.id;await service.cancel({sessionId:id2});await assert.rejects(service.create(),/limit/);
});
test('linked evidence parent and journal failures stop before container side effects',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-linked-')));const outside=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-outside-')));t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});fs.symlinkSync(outside,path.join(root,'runtime'),'junction');const docker=new BuildDocker();const service=api.createToolBuildSessionService({root,docker});await assert.rejects(service.create(),/linked|redirected/);assert.equal(docker.calls.length,0);await service.close();
 const f=fixture(t);const id=(await f.service.create()).session.id;const journal=path.join(f.root,'runtime/tool-builds',id,'events.jsonl');fs.unlinkSync(journal);fs.mkdirSync(journal);const before=f.docker.calls.length;await assert.rejects(f.service.write({sessionId:id,path:'/opt/tool/main.mjs',content:'console.log(1)'}));assert.equal(f.docker.calls.length,before);fs.rmdirSync(journal);fs.writeFileSync(journal,'');
});
test('forged artifact or source mismatch cannot register, and finalization hash mismatch is terminal',async t=>{
 const {service,docker,root}=fixture(t);const id=(await service.create()).session.id;const p=proposal();await service.write({sessionId:id,path:'/opt/tool/main.mjs',content:p.script});await service.run({sessionId:id,command:'true'});const {artifact}=await service.finalize({sessionId:id,command:COMMAND});
 for(const invalid of [{...p,script:'console.log(1)',runtimeArtifact:artifact},{...p,runtimeArtifact:{...artifact,imageDigest:`sha256:${'a'.repeat(64)}`}}])await assert.rejects(async()=>service.propose(invalid));assert.equal(fs.existsSync(path.join(root,'runtime/tool-registry')),false);await assert.rejects(async()=>service.write({sessionId:id,path:'/opt/tool/main.mjs',content:'x'}));
 const id2=(await service.create()).session.id;await service.write({sessionId:id2,path:'/opt/tool/main.mjs',content:p.script});await service.run({sessionId:id2,command:'true'});const exec=docker.exec.bind(docker);docker.exec=async(...a)=>{const result=await exec(...a);if(a[1][2]?.includes('createHash'))result.stdout='0'.repeat(64);return result;};await assert.rejects(service.finalize({sessionId:id2,command:COMMAND}),e=>e.cleanupConfirmed===true);assert.equal(docker.containers.size,0);assert.equal(docker.commits,1);
});
test('source rejects lone surrogates before writes so frozen text equals actual UTF-8 bytes',async t=>{
 const {service,docker}=fixture(t);const id=(await service.create()).session.id;const count=docker.calls.length;await assert.rejects(async()=>service.write({sessionId:id,path:'/opt/tool/main.mjs',content:'//\ud800'}));assert.equal(docker.calls.length,count);
});
test('ownership and actual policy corruption fail closed without removing a foreign container',async t=>{
 const {service,docker}=fixture(t);const id=(await service.create()).session.id;const container=[...docker.containers.values()][0];container.Config.Labels['sirna.learning.project']='foreign';
 await assert.rejects(service.run({sessionId:id,command:'true'}),e=>e.cleanupConfirmed===false);assert.equal(docker.containers.size,1);container.Config.Labels['sirna.learning.project']='siRNA-pi';
});
test('uncertain failed registration cannot blindly retry and persisted material remains available',async t=>{
 const {service,root}=fixture(t);const p=proposal();const id=(await service.create()).session.id;await service.write({sessionId:id,path:'/opt/tool/main.mjs',content:p.script});await service.run({sessionId:id,command:'true'});const {artifact}=await service.finalize({sessionId:id,command:COMMAND});
 fs.mkdirSync(path.join(root,'runtime/tool-registry'));fs.mkdirSync(path.join(root,'runtime/tool-registry/registry.sqlite'));await assert.rejects(service.propose({...p,runtimeArtifact:artifact}),/submission failed/);await assert.rejects(service.propose({...p,runtimeArtifact:artifact}),/uncertain/);
});
test('lost create response reports unknown cleanup, and close cannot claim confirmation for an unknown container',async t=>{
 const {service,docker,root}=fixture(t,{allowUnknownClose:true});const create=docker.createContainer.bind(docker);docker.createContainer=async(...a)=>{await create(...a);throw new Error('lost response');};
 await assert.rejects(service.create(),e=>e.cleanupConfirmed===false);assert.equal(docker.containers.size,1);const id=fs.readdirSync(path.join(root,'runtime/tool-builds'))[0];assert.match(fs.readFileSync(path.join(root,'runtime/tool-builds',id,'events.jsonl'),'utf8'),/"cleanupConfirmed":false/);
 await assert.rejects(service.close(),/unknown/);
});
test('bounded byte limits allow full source and combined output without accepting malformed JSON accessors',async t=>{
 const {service,docker}=fixture(t);const id=(await service.create()).session.id;const content='//'+ 'é'.repeat(99999);await service.write({sessionId:id,path:'/opt/tool/main.mjs',content});docker.debug={exitCode:0,stdout:'é'.repeat(32767),stderr:'ok'};const result=await service.run({sessionId:id,command:'x'.repeat(20000),timeoutMs:30000});assert.equal(Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr),65536);
 let getterCalled=false;const bad={sessionId:id,path:'/opt/tool/main.mjs',get content(){getterCalled=true;return 'bad';}};await assert.rejects(async()=>service.write(bad));assert.equal(getterCalled,false);const final=await service.finalize({sessionId:id,command:COMMAND});assert.equal(Buffer.from(docker.images.get(final.artifact.imageDigest).files.get('/opt/tool/main.mjs')).toString(),content);
});
test('unknown cleanup still consumes live capacity so failed containers cannot bypass the limit',async t=>{
 const {service,docker}=fixture(t,{maxLiveSessions:1});const id=(await service.create()).session.id;docker.failAt='removeContainer';await assert.rejects(service.cancel({sessionId:id}));await assert.rejects(service.create(),/limit/);
});
