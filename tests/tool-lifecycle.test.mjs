import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { submitRegisteredToolProposal, listRegisteredToolProposals, getRegisteredToolProposal } from '../packages/capability-platform/tool-lifecycle.mjs';

const draft = JSON.parse(fs.readFileSync(new URL('../examples/04-tool-contract/proposal.draft.json', import.meta.url)));
function input() {
  return {...structuredClone(draft),runtimeArtifact:{
    protocolVersion:'sirna-tool-runtime-artifact/v1',imageDigest:`sha256:${'a'.repeat(64)}`,
    command:['/usr/bin/node','/opt/tool/main.mjs'],platform:'linux/amd64',
    createdAt:'2026-10-20T00:00:00.000Z',buildSessionId:randomUUID(),
  }};
}
function temporary(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-registration-')));
  t.after(()=>{
    // Tests own this exact temporary root; relax only its frozen package files.
    function unlock(directory) {
      fs.chmodSync(directory,0o700);
      for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
        const file=path.join(directory,entry.name);
        if(entry.isDirectory()) unlock(file);
        else if(!entry.isSymbolicLink()) fs.chmodSync(file,0o600);
      }
    }
    unlock(root); fs.rmSync(root,{recursive:true});
  });
  return root;
}
function mutate(file, value) { fs.chmodSync(file,0o600); fs.writeFileSync(file,value); }

test('querying an unused project neither creates a registry nor a runtime directory',t=>{
  const root=temporary(t);
  assert.deepEqual(listRegisteredToolProposals({root}),[]);
  assert.throws(()=>getRegisteredToolProposal(randomUUID(),{root}),/Unknown proposal/);
  assert.deepEqual(fs.readdirSync(root),[]);
});

test('incomplete proposals and unknown parent references leave no persistent state',t=>{
  const root=temporary(t);
  assert.throws(()=>submitRegisteredToolProposal(draft,{root}),/runtimeArtifact/);
  assert.throws(()=>submitRegisteredToolProposal({...input(),parent:{toolName:draft.toolName,version:'1.0.0'}},{root}),/parent|version/i);
  assert.deepEqual(fs.readdirSync(root),[]);
});

test('submission survives fresh database connections with a draft package and a submitted event',t=>{
  const root=temporary(t); const proposal=input();
  const result=submitRegisteredToolProposal(proposal,{root});
  assert.equal(result.registry.state,'submitted');
  assert.equal(result.proposal.status,'draft');
  assert.equal(result.proposal.version,'0.1.0-draft');
  assert.equal(result.registered,true);
  for(const flag of ['executed','verified','approved','activated','runtimeArtifactVerified']) assert.equal(result[flag],false);
  assert.deepEqual(listRegisteredToolProposals({root}),[result.registry]);
  proposal.script='throw new Error("changed original");';
  const detail=getRegisteredToolProposal(result.registry.id,{root});
  assert.equal(detail.integrity.packageMatchesRegistration,true);
  assert.equal(detail.proposal.scriptSha256,result.proposal.scriptSha256);
  assert.equal(detail.events.length,1);
  assert.equal(detail.events[0].eventType,'proposal_submitted');
  assert.equal(detail.events[0].actor,'local-cli');
  assert.equal(Object.hasOwn(detail,'input'),false,'source bodies are not returned by the query API');
});

test('two submissions of the same tool are separate proposals without a released version',t=>{
  const root=temporary(t); const proposal=input();
  const a=submitRegisteredToolProposal(proposal,{root});
  const b=submitRegisteredToolProposal(proposal,{root});
  assert.notEqual(a.registry.id,b.registry.id);
  assert.equal(listRegisteredToolProposals({root}).length,2);
  for(const row of listRegisteredToolProposals({root})) {
    assert.equal(row.toolName,draft.toolName);assert.equal(row.state,'submitted');
    assert.equal(Object.hasOwn(row,'version'),false);
  }
});

test('submission stores candidate and baseline as data without executing host-side source',t=>{
  const root=temporary(t); const candidate=path.join(root,'candidate-executed'); const baseline=path.join(root,'baseline-executed');
  const proposal=input();
  proposal.script=`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(candidate)}, 'bad');`;
  proposal.baseline.script=`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(baseline)}, 'bad');`;
  const saved=submitRegisteredToolProposal(proposal,{root});
  assert.equal(saved.executed,false);assert.equal(saved.runtimeArtifactVerified,false);
  assert.equal(fs.existsSync(candidate),false);assert.equal(fs.existsSync(baseline),false);
  assert.equal(getRegisteredToolProposal(saved.registry.id,{root}).registry.state,'submitted');
});

test('show rejects changed source and manifest without advancing registry state',t=>{
  const root=temporary(t);
  for(const target of ['tool.mjs','manifest.json']) {
    const saved=submitRegisteredToolProposal(input(),{root});
    const file=path.join(saved.registry.artifactPath,target);
    const bytes=fs.readFileSync(file,'utf8');
    mutate(file,target==='tool.mjs'?`${bytes}\n// modified` : bytes.replace('合同教学','变更材料'));
    assert.throws(()=>getRegisteredToolProposal(saved.registry.id,{root}),/digest|hash|integrity|match/i);
  }
  assert.ok(listRegisteredToolProposals({root}).every(row=>row.state==='submitted'));
});

test('database metadata cannot redirect package reads outside the fixed proposal root',t=>{
  const root=temporary(t); const saved=submitRegisteredToolProposal(input(),{root});
  const db=new DatabaseSync(path.join(root,'runtime/tool-registry/registry.sqlite'));
  db.prepare('UPDATE tool_proposals SET artifact_path=? WHERE id=?').run(root,saved.registry.id);db.close();
  assert.throws(()=>getRegisteredToolProposal(saved.registry.id,{root}),/path|root/i);
});

test('database tool identity, permission and image must agree with the frozen manifest',t=>{
  const root=temporary(t);
  for(const [column,value] of [['tool_name','other_tool'],['permission_profile','controlled_network'],['image_digest',`sha256:${'b'.repeat(64)}`]]) {
    const saved=submitRegisteredToolProposal(input(),{root});
    const db=new DatabaseSync(path.join(root,'runtime/tool-registry/registry.sqlite'));
    db.prepare(`UPDATE tool_proposals SET ${column}=? WHERE id=?`).run(value,saved.registry.id);db.close();
    assert.throws(()=>getRegisteredToolProposal(saved.registry.id,{root}),/metadata|identity|match/i);
  }
});

test('failed registry insertion retains a locatable package but adds neither proposal nor event',t=>{
  const root=temporary(t); const first=submitRegisteredToolProposal(input(),{root});
  const db=new DatabaseSync(path.join(root,'runtime/tool-registry/registry.sqlite'));
  db.exec("CREATE TRIGGER block_registration BEFORE INSERT ON tool_events BEGIN SELECT RAISE(ABORT, 'blocked event'); END;");db.close();
  let failure;
  try { submitRegisteredToolProposal(input(),{root}); } catch(error) { failure=error; }
  assert.ok(failure);assert.ok(failure.proposalId);assert.ok(failure.artifactPath);
  assert.equal(fs.existsSync(path.join(failure.artifactPath,'manifest.json')),true);
  assert.deepEqual(listRegisteredToolProposals({root}),[first.registry]);
  assert.equal(getRegisteredToolProposal(first.registry.id,{root}).events.length,1);
});

test('invalid IDs and linked runtime roots are rejected before reading external material',t=>{
  const root=temporary(t);
  for(const id of ['../outside','',null]) assert.throws(()=>getRegisteredToolProposal(id,{root}),/ID|UUID/i);
  const external=path.join(root,'external');fs.mkdirSync(external);
  fs.symlinkSync(external,path.join(root,'runtime'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>submitRegisteredToolProposal(input(),{root}),/link|redirect|directory/i);
  assert.deepEqual(fs.readdirSync(external),[]);
});
