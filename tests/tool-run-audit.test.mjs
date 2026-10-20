import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const api=await import('../packages/capability-platform/tool-run-audit.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-run-audit-')));t.after(()=>{
  for(const file of fs.readdirSync(root,{recursive:true}).reverse()){const full=path.join(root,file);if(!fs.lstatSync(full).isSymbolicLink())fs.chmodSync(full,0o700);}
  fs.rmSync(root,{recursive:true,force:true});
});return root;}
function settings(root){return {root,toolCallId:randomUUID(),inputSha256:'a'.repeat(64),identity:{toolName:'summarize_target_sequence',toolId:randomUUID(),proposalId:randomUUID(),toolVersion:'1.0.0',packageSha256:'b'.repeat(64),imageDigest:`sha256:${'c'.repeat(64)}`}};}
test('request is flushed before finish and exclusive terminal audit preserves request identity',t=>{
  assert.equal(typeof api.startToolRunAudit,'function');const root=fixture(t);const options=settings(root);
  const write=fs.fsyncSync;let synced=0;fs.fsyncSync=(...args)=>{synced++;return write(...args);};t.after(()=>{fs.fsyncSync=write;});
  const run=api.startToolRunAudit(options);assert.ok(synced>=1);assert.equal(fs.existsSync(run.auditPath),false);
  const request=JSON.parse(fs.readFileSync(run.requestPath));assert.equal(request.toolCallId,options.toolCallId);assert.equal(request.inputSha256,options.inputSha256);
  run.finish({success:false,error:'Execution failed'});assert.ok(synced>=2);const audit=JSON.parse(fs.readFileSync(run.auditPath));
  assert.equal(audit.startedAt,request.startedAt);assert.equal(audit.runId,request.runId);assert.equal(audit.success,false);
  assert.throws(()=>run.finish({success:true}),/exist|finish/i);assert.equal(JSON.parse(fs.readFileSync(run.auditPath)).success,false);
  assert.throws(()=>api.startToolRunAudit(options),/exist/i);
  if(process.platform!=='win32'){assert.equal(fs.statSync(run.auditPath).mode&0o777,0o400);assert.equal(fs.statSync(path.dirname(run.auditPath)).mode&0o777,0o700);}
});
test('writer rejects unsafe identities before creating runtime',t=>{
  assert.equal(typeof api.startToolRunAudit,'function');const root=fixture(t);
  for(const mutate of [o=>o.identity.toolName='../escape',o=>o.toolCallId='bad',o=>o.inputSha256='bad',o=>o.identity.packageSha256='bad']){
    const options=settings(root);mutate(options);assert.throws(()=>api.startToolRunAudit(options));assert.deepEqual(fs.readdirSync(root),[]);
  }
});
test('optional task context is a strict immutable server identity preserved in request and terminal evidence',t=>{
  const root=fixture(t),options=settings(root);const context={taskId:randomUUID(),executionSessionId:randomUUID(),sandboxId:'a'.repeat(64),agentTurnId:randomUUID(),agentRunId:'compose-run_12'};
  const run=api.startToolRunAudit({...options,taskContext:context});const expected={...context};context.agentRunId='changed';
  assert.deepEqual(JSON.parse(fs.readFileSync(run.requestPath)).taskContext,expected);run.finish({success:true});assert.deepEqual(JSON.parse(fs.readFileSync(run.auditPath)).taskContext,expected);
});
test('invalid and extra task context fields fail before writing evidence',t=>{
  const root=fixture(t);const valid={taskId:randomUUID(),executionSessionId:randomUUID(),sandboxId:'a'.repeat(64),agentTurnId:randomUUID(),agentRunId:'compose-run'};
  for(const bad of [null,{}, {...valid,taskId:'bad'},{...valid,executionSessionId:'bad'},{...valid,sandboxId:'bad'},{...valid,agentTurnId:'bad'},{...valid,agentRunId:'../bad'},{...valid,token:'secret'}])assert.throws(()=>api.startToolRunAudit({...settings(root),taskContext:bad}));
  assert.deepEqual(fs.readdirSync(root),[]);
});
test('linked parent and linked or altered request cannot publish terminal evidence',t=>{
  assert.equal(typeof api.startToolRunAudit,'function');const root=fixture(t);fs.mkdirSync(path.join(root,'runtime'));fs.mkdirSync(path.join(root,'elsewhere'));
  const redirected=path.join(root,'runtime/approved-tool-runs');fs.symlinkSync(path.join(root,'elsewhere'),redirected,'junction');
  assert.throws(()=>api.startToolRunAudit(settings(root)),/link|real|ordinary/i);assert.deepEqual(fs.readdirSync(path.join(root,'elsewhere')),[]);fs.unlinkSync(redirected);
  const run=api.startToolRunAudit(settings(root));fs.chmodSync(run.requestPath,0o600);fs.writeFileSync(run.requestPath,'changed');
  assert.throws(()=>run.finish({success:true}),/request|changed/i);assert.equal(fs.existsSync(run.auditPath),false);
  const next=api.startToolRunAudit(settings(root));const linked=path.join(root,'request-link');fs.linkSync(next.requestPath,linked);
  assert.throws(()=>next.finish({success:true}),/link|ordinary/i);assert.equal(fs.existsSync(next.auditPath),false);
});
