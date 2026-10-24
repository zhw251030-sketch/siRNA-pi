import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ToolAutomationStore} from '../packages/capability-platform/tool-automation-store.mjs';

function input(overrides={}){
  return {proposalId:randomUUID(),sourceTaskId:randomUUID(),curationId:randomUUID(),toolName:'shape_tool',artifactSha256:'a'.repeat(64),...overrides};
}

test('automation store persists open runs and atomically supersedes a repair predecessor',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'tool-automation-'))),f=input();
  const store=new ToolAutomationStore({root});t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const first=store.registerProposal(f);assert.equal(first.phase,'queued');assert.equal(first.attempt,0);assert.equal(first.rootProposalId,f.proposalId);
  store.setPhase(f.proposalId,'validating');store.setPhase(f.proposalId,'repairing');store.setPhase(f.proposalId,'awaiting_replacement');
  const replacement=input({sourceTaskId:f.sourceTaskId,curationId:f.curationId,toolName:f.toolName});
  const next=store.registerProposal(replacement);
  assert.equal(store.get(f.proposalId).phase,'superseded');assert.equal(next.phase,'queued');assert.equal(next.previousProposalId,f.proposalId);assert.equal(next.rootProposalId,f.proposalId);assert.equal(next.attempt,1);
  assert.deepEqual(store.listOpen().map(row=>row.proposalId),[replacement.proposalId]);
  store.close();const reopened=new ToolAutomationStore({root});assert.equal(reopened.get(next.proposalId).rootProposalId,f.proposalId);assert.equal(reopened.get(next.proposalId).attempt,1);reopened.close();
});

test('automation store bounds repair generations and refuses a fourth replacement',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'tool-automation-limit-'))),base=input();
  const store=new ToolAutomationStore({root});t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  let current=store.registerProposal(base);
  for(let attempt=1;attempt<=3;attempt++){
    store.setPhase(current.proposalId,'awaiting_replacement');
    current=store.registerProposal(input({sourceTaskId:base.sourceTaskId,curationId:base.curationId,toolName:base.toolName}));
    assert.equal(current.attempt,attempt);
  }
  store.setPhase(current.proposalId,'awaiting_replacement');
  assert.throws(()=>store.registerProposal(input({sourceTaskId:base.sourceTaskId,curationId:base.curationId,toolName:base.toolName})),/repair|attempt|generation/i);
});

test('automation store rejects malformed phase and mismatched replacement identity',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'tool-automation-invalid-'))),base=input();
  const store=new ToolAutomationStore({root});t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});store.registerProposal(base);
  assert.throws(()=>store.setPhase(base.proposalId,'running'));
  store.setPhase(base.proposalId,'awaiting_replacement');
  const replacement=input({sourceTaskId:base.sourceTaskId,curationId:randomUUID(),toolName:base.toolName});
  assert.throws(()=>store.registerProposal(replacement),/curation|identity/i);
});
