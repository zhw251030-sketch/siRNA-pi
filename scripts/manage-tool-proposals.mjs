// Trusted host CLI. Submitting source stores data; it never executes that source.
import fs from 'node:fs';
import os from 'node:os';
import { readBuildProposal } from './lib/tool-build-files.mjs';
import { submitRegisteredToolProposal, listRegisteredToolProposals, getRegisteredToolProposal } from '../packages/capability-platform/tool-lifecycle.mjs';
import { getLatestToolValidationReport } from '../packages/capability-platform/tool-validation-service.mjs';
import {approveRegisteredToolProposal,listRegisteredToolVersions,getRegisteredToolVersion,getRegisteredToolCatalog} from '../packages/capability-platform/tool-approval-service.mjs';

const root='/home/hanwen/Project/project/siNRA-pi';
try {
  const [action,...values]=process.argv.slice(2);const [value,second]=values;
  const counts={submit:1,list:0,show:1,report:1,approve:2,versions:0,version:2,catalog:0,'catalog-rebuild':0};
  if(!Object.hasOwn(counts,action)||values.length!==counts[action]||values.some(item=>item.startsWith('-'))) {
    throw new Error('Usage: manage-tool-proposals.mjs submit <project-proposal.json> | list | show <UUID> | report <UUID> | approve <UUID> <approvedBy> | versions | version <toolName> <version> | catalog | catalog-rebuild');
  }
  if(process.platform!=='linux'||os.userInfo().username!=='hanwen'||process.cwd()!==root||fs.realpathSync(root)!==root) {
    throw new Error('Run as hanwen from the dedicated Linux project directory, without sudo');
  }
  const result=action==='submit'
    ? submitRegisteredToolProposal(readBuildProposal(value,{root}),{root})
    : action==='show' ? getRegisteredToolProposal(value,{root})
    : action==='report' ? {validation:getLatestToolValidationReport(value,{root})??null}
    : action==='approve' ? approveRegisteredToolProposal(value,second,{root})
    : action==='versions' ? {versions:listRegisteredToolVersions({root}),agentCallable:false}
    : action==='version' ? {...getRegisteredToolVersion(value,second,{root}),agentCallable:false}
    : ['catalog','catalog-rebuild'].includes(action) ? {catalog:getRegisteredToolCatalog({root,rebuild:action==='catalog-rebuild'}),agentCallable:false}
      : {proposals:listRegisteredToolProposals({root}),limit:100,integrityChecked:false,
        executed:false,verified:false,approved:false,activated:false,runtimeArtifactVerified:false};
  console.log(JSON.stringify({ok:true,action,...result},null,2));
} catch(error) {
  console.error(JSON.stringify({ok:false,error:error instanceof Error?error.message:'Proposal operation failed',
    ...(error.proposalId?{proposalId:error.proposalId,artifactPath:error.artifactPath}:{}),
    ...(error.packagePath?{packagePath:error.packagePath}:{}),...(error.temporaryPath?{temporaryPath:error.temporaryPath}:{}),
    ...(error.versionActivated?{versionActivated:true,toolName:error.toolName,version:error.version}:{}),
    executed:false,approved:error.versionActivated===true,activated:error.versionActivated===true,agentCallable:false}));
  process.exitCode=1;
}
