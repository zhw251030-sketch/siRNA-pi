// Trusted host CLI. Submitting source stores data; it never executes that source.
import fs from 'node:fs';
import os from 'node:os';
import { readBuildProposal } from './lib/tool-build-files.mjs';
import { submitRegisteredToolProposal, listRegisteredToolProposals, getRegisteredToolProposal } from '../packages/capability-platform/tool-lifecycle.mjs';

const root='/home/hanwen/Project/project/siNRA-pi';
try {
  const [action,value,...extra]=process.argv.slice(2);
  if(extra.length||!['submit','list','show'].includes(action)||
    (action==='list'?value!==undefined:typeof value!=='string'||value.startsWith('-'))) {
    throw new Error('Usage: manage-tool-proposals.mjs submit <project-proposal.json> | list | show <proposal-UUID>');
  }
  if(process.platform!=='linux'||os.userInfo().username!=='hanwen'||process.cwd()!==root||fs.realpathSync(root)!==root) {
    throw new Error('Run as hanwen from the dedicated Linux project directory, without sudo');
  }
  const result=action==='submit'
    ? submitRegisteredToolProposal(readBuildProposal(value,{root}),{root})
    : action==='show' ? getRegisteredToolProposal(value,{root})
      : {proposals:listRegisteredToolProposals({root}),limit:100,integrityChecked:false,
        executed:false,verified:false,approved:false,activated:false,runtimeArtifactVerified:false};
  console.log(JSON.stringify({ok:true,action,...result},null,2));
} catch(error) {
  console.error(JSON.stringify({ok:false,error:error instanceof Error?error.message:'Proposal operation failed',
    ...(error.proposalId?{proposalId:error.proposalId,artifactPath:error.artifactPath}:{}),
    executed:false,verified:false,approved:false,activated:false,runtimeArtifactVerified:false}));
  process.exitCode=1;
}
