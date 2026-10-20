import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {submitRegisteredToolProposal} from '../../packages/capability-platform/tool-lifecycle.mjs';
import {validateRegisteredToolProposal} from '../../packages/capability-platform/tool-validation-service.mjs';
import {createDockerValidationRunner} from '../../packages/capability-platform/tool-validation-runner.mjs';
import {DockerBoundary} from './validation-docker-boundary.mjs';

const draft=JSON.parse(fs.readFileSync(new URL('../../examples/04-tool-contract/proposal.draft.json',import.meta.url)));
export function writable(file,bytes){fs.chmodSync(file,0o600);fs.writeFileSync(file,bytes);}
export async function approvalFixture(t,{validate=true,minNetGain=1}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-approval-')));
  const cleanup=[];
  t.after(()=>{
    for(const dispose of cleanup.reverse())dispose();
    function unlock(dir){fs.chmodSync(dir,0o700);for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);if(entry.isDirectory())unlock(file);else if(!entry.isSymbolicLink())fs.chmodSync(file,0o600);
    }}
    unlock(root);fs.rmSync(root,{recursive:true});
  });
  const input={...structuredClone(draft),minNetGain,runtimeArtifact:{protocolVersion:'sirna-tool-runtime-artifact/v1',
    imageDigest:`sha256:${'b'.repeat(64)}`,command:['/usr/bin/node','/opt/tool/main.mjs'],platform:'linux/amd64',
    createdAt:'2026-10-20T00:00:00.000Z',buildSessionId:randomUUID()}};
  const saved=submitRegisteredToolProposal(input,{root});const id=saved.proposal.id;
  if(validate)await verifyFixtureProposal(root,saved,input);
  return {root,id,input,saved,onCleanup:dispose=>cleanup.push(dispose),database:path.join(root,'runtime/tool-registry/registry.sqlite'),
    approvedRoot:path.join(root,'runtime/tool-artifacts/approved'),catalogPath:path.join(root,'runtime/tool-registry/active-tools.json')};
}
export function verifyFixtureProposal(root,saved,input){
  return validateRegisteredToolProposal(saved.proposal.id,{root,runner:createDockerValidationRunner({
    docker:new DockerBoundary({manifest:saved.proposal,input},{runResult:({envelope,target})=>{
      const fails=target==='baseline'&&envelope.input.sequence.startsWith('>');
      return {exitCode:fails?1:0,timedOut:false,outputLimitExceeded:false,stdout:fails?'':'{"length":4,"gcFraction":0.5}',stderr:fails?'plain DNA only':''};
    }})
  })});
}
