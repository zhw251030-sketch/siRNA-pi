import {getRegisteredToolProposal,resolveToolLearningPaths} from './tool-lifecycle.mjs';
import {readToolProposal} from './tool-proposals.mjs';
import {repairSource,repairAssociation,assertRepairContract,assertRepairPredecessor} from './tool-repair-contract.mjs';

// Only immutable registered material plus its exact submission event establish
// origin. Old records are not inferred from tool names or current task lists.
export function getToolProposalSource(id,{root,visiting=new Set()}={}){
  if(visiting.has(id)||visiting.size>=4)throw new Error('Malformed or cyclic repair ancestry');
  visiting.add(id);
  try{
    const saved=getRegisteredToolProposal(id,{root});
    const events=saved.events.filter(e=>e.eventType==='proposal_submitted');
    if(events.length!==1)throw new Error('Expected exactly one proposal submission');
    const event=events[0],details=event.details;
    if(event.proposalId!==id||event.toolName!==saved.registry.toolName||details.proposalId!==id||details.artifactSha256!==saved.registry.artifactSha256)throw new Error('Submission identity differs from immutable material');
    const material=readToolProposal(id,{proposalsRoot:resolveToolLearningPaths(root).proposalsRoot,expectedArtifactSha256:saved.registry.artifactSha256});
    const source=details.source===undefined?null:repairSource(details.source);
    if(source&&event.actor!=='web-agent')throw new Error('Source requires a trusted web actor');
    const repair=details.repair===undefined?null:repairAssociation(details.repair);
    const result={source,repair,rootProposalId:repair?.rootProposalId??id,attempt:repair?.attempt??0,input:material.input,registry:saved.registry,validation:saved.validation};
    if(repair){
      if(!source||repair.previousProposalId===id)throw new Error('Invalid repair source');
      const previous=getToolProposalSource(repair.previousProposalId,{root,visiting});
      assertRepairPredecessor(repair,previous,source,previous.source);
      assertRepairContract(previous.input,material.input);
    }
    return result;
  }finally{visiting.delete(id);}
}
