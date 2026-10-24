import fs from 'node:fs';
import {getRegisteredToolProposal,listRegisteredToolProposals,resolveToolLearningPaths} from './tool-lifecycle.mjs';
import {ToolRegistry} from './tool-registry.mjs';
import {getLatestToolValidationReport} from './tool-validation-service.mjs';
import {maintenanceId,ToolMaintenanceError} from './tool-maintenance-store.mjs';
import {getToolRepairFeedback} from './tool-repair-feedback.mjs';

// One trusted web process owns this worker. A restart never assumes an unknown
// Docker execution is safe to repeat. Other maintenance CLIs remain manual.
export function createToolMaintenance({root,store,validate,canValidate=()=>true,onError=()=>{}}){
  let started=false,accepting=true,pump=null,wakeRequested=false;
  function proposal(id){maintenanceId(id);const {databasePath}=resolveToolLearningPaths(root);let found;
    if(fs.existsSync(databasePath)){const registry=new ToolRegistry(databasePath,{readOnly:true});try{found=registry.getProposal(id);}finally{registry.close();}}
    if(!found)throw new ToolMaintenanceError(404,'没有找到这个候选。');return found;}
  function ready(id){if(!canValidate(id))throw new ToolMaintenanceError(409,'此候选正在修订，暂不能验证。');const p=proposal(id);if(!['submitted','verification_failed'].includes(p.state))throw new ToolMaintenanceError(409,'此候选当前不可排队验证。');
    // Material, source hashes, registry identity and any parent/latest evidence
    // are checked by the established reader, never by browser assertions.
    getRegisteredToolProposal(id,{root});return p;
  }
  function wake(){if(!started||!accepting)return;if(pump){wakeRequested=true;return;}wakeRequested=false;
    pump=Promise.resolve().then(async()=>{
      while(accepting){const job=store.claim();if(!job)break;
        try{const current=ready(job.proposalId);const binding=store.binding(job.id);if(binding&&binding!==current.artifactSha256)throw new Error('Queued artifact identity changed');
          const report=await validate(job.proposalId,job);store.finish(job.id,report);}
        catch(error){if(error.cleanupError||error.containerId||error.maintenanceUnsafe){accepting=false;store.failUnsafe(job.id);}else store.finish(job.id,null);
          try{onError(error,job);}catch{/* diagnostics must not restart execution */}}
      }
    }).catch(error=>{accepting=false;try{onError(error);}catch{}}).finally(()=>{pump=null;if(wakeRequested)wake();});
  }
  return {
    start(){if(!started){store.interruptRunning();started=true;if(store.halted())accepting=false;wake();}return Promise.resolve();},
    status(){return {accepting:accepting&&!store.halted(),halted:store.halted()};},
    latest(id){proposal(id);return store.latest(id);},
    enqueue(id,requestId,{artifactSha256=null}={}){if(!accepting)throw new ToolMaintenanceError(503,'Maintenance is stopping');maintenanceId(id);maintenanceId(requestId);if(artifactSha256!==null&&(!/^[a-f0-9]{64}$/.test(artifactSha256)))throw new ToolMaintenanceError(400,'Invalid artifact binding');
      const previous=store.getByRequest(requestId);
      // A retry still receives its original result if validation already changed
      // proposal state; it must not become a new execution or a spurious 409.
      if(previous){if(previous.proposalId!==id)throw new ToolMaintenanceError(409,'Request key belongs to a different proposal');if(artifactSha256!==null&&previous.artifactSha256!==artifactSha256)throw new ToolMaintenanceError(409,'Request key is bound to a different artifact.');return {job:previous,deduplicated:true};}
      const current=ready(id);if(artifactSha256!==null&&current.artifactSha256!==artifactSha256)throw new ToolMaintenanceError(409,'候选产物摘要已变化，拒绝自动入队。');const result=store.enqueue(id,requestId,{artifactSha256:current.artifactSha256});wake();return result;},
    list(){return listRegisteredToolProposals({root}).map(p=>({id:p.id,toolName:p.toolName,state:p.state,createdAt:p.createdAt,updatedAt:p.updatedAt,latestValidationId:p.latestValidationId??null,latestJob:store.latest(p.id)}));},
    feedback(id){proposal(id);if(['pending','running'].includes(store.latest(id)?.status))return null;return getToolRepairFeedback(id,{root});},
    summary(id){proposal(id);const latest=getLatestToolValidationReport(id,{root});if(!latest)return null;
      const r=latest.report;return {proposalId:id,validationId:r.validationId,passed:r.passed,verifiedAt:r.verifiedAt,
        artifactIntegrityPassed:r.artifactIntegrityPassed,runtimeArtifactVerified:r.runtimeArtifactVerified,
        staticPassed:r.staticCheck.passed,syntaxPassed:r.syntaxChecks.every(c=>c.passed),repeatabilityPassed:r.repeatability.passed,
        domainGatePassed:r.domainGatePassed,domainCases:{passed:r.domainCases.filter(c=>c.expectationPassed).length,total:r.domainCases.length},
        benchmarkGate:{candidateScore:r.benchmarkGate.candidateScore,baselineScore:r.benchmarkGate.baselineScore,netGain:r.benchmarkGate.netGain,minNetGain:r.benchmarkGate.minNetGain,passed:r.benchmarkGate.passed},executionCount:r.executionCount};},
    async drain(){while(pump)await pump;},
    async stop(){accepting=false;if(pump)await pump;},
  };
}
