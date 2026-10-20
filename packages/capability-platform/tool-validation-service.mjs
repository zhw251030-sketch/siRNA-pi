import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ToolRegistry} from './tool-registry.mjs';
import {resolveToolLearningPaths,assertRegisteredToolParent} from './tool-lifecycle.mjs';
import {readToolProposal} from './tool-proposals.mjs';
import {assertValidationSupported,checkValidationSource} from './tool-validation-static.mjs';
import {validationCasePassed,validationRunsRepeatable} from './tool-validation.mjs';
import {writeValidationReport,writeValidationFailure,readLatestValidationReport} from './tool-validation-reports.mjs';

function must(ok,message){if(!ok)throw new Error(message);}
function identity(row,saved,paths){
  must(row.artifactPath===path.join(paths.proposalsRoot,row.id)&&row.toolName===saved.manifest.toolName&&
    row.permissionProfile===saved.manifest.permissions.profile&&row.imageDigest===saved.manifest.runtimeArtifact.imageDigest,
  'Registry identity metadata does not match the proposal manifest');
}
export function getLatestToolValidationReport(id,{root}={}){
  const paths=resolveToolLearningPaths(root);
  must(fs.existsSync(paths.databasePath),'Unknown proposal');
  const registry=new ToolRegistry(paths.databasePath,{readOnly:true});
  try{return readLatestValidationReport(id,{root,registry});}finally{registry.close();}
}
export async function validateRegisteredToolProposal(id,{root,runner}={}){
  const paths=resolveToolLearningPaths(root);
  must(fs.existsSync(paths.databasePath),'Unknown proposal');
  must(runner&&typeof runner.checkSources==='function'&&typeof runner.run==='function','Explicit validation runner required');
  let registry=new ToolRegistry(paths.databasePath,{readOnly:true});let row;let saved;let parentComparison;
  try{
    row=registry.getProposal(id);must(row,'Unknown proposal');
    must(['submitted','verification_failed','verified'].includes(row.state),`Cannot validate proposal state ${row.state}`);
    saved=readToolProposal(id,{proposalsRoot:paths.proposalsRoot,expectedArtifactSha256:row.artifactSha256});identity(row,saved,paths);
    parentComparison=assertRegisteredToolParent(saved.input,{root,registry});
    assertValidationSupported(saved.input);
  }finally{registry.close();}
  const validationId=randomUUID();let reportPath;
  // Upgrade only a recognized, supported proposal's write path; constructor
  // makes a consistent v1 backup before its additive schema migration.
  registry=new ToolRegistry(paths.databasePath,{migrate:true});
  try{
    const {manifest,input}=saved;
    const staticCheck=checkValidationSource(manifest,input);
    const checked=await runner.checkSources({manifest,input});
    must(Array.isArray(checked.syntaxChecks)&&checked.syntaxChecks.length===2&&
      checked.syntaxChecks.filter(x=>x.target==='candidate').length===1&&checked.syntaxChecks.filter(x=>x.target==='baseline').length===1,
    'Runner did not return both source checks');
    const syntaxChecks=checked.syntaxChecks;const dependencyChecks=[];
    const canRun=staticCheck.passed&&checked.runtimeArtifactVerified===true&&syntaxChecks.every(x=>x.passed===true);
    let executionCount=0;const call=async(target,caseInput)=>{
      executionCount++;
      const result=await runner.run({target,manifest,input,caseInput,toolCallId:randomUUID()});
      return result;
    };
    const repeatability={mode:manifest.repeatabilityMode,passed:false};const domainCases=[];const benchmarks=[];
    if(canRun){
      repeatability.firstRun=await call('candidate',manifest.smokeInput);
      repeatability.secondRun=await call('candidate',manifest.smokeInput);
      repeatability.passed=validationRunsRepeatable(repeatability.firstRun,repeatability.secondRun,manifest.repeatabilityMode);
      for(const entry of manifest.testCases){const run=await call('candidate',entry.input);domainCases.push({name:entry.name,expectationPassed:validationCasePassed(run,entry.expectedOutput),run});}
      for(const entry of manifest.benchmarkCases){
        const candidateRun=await call('candidate',entry.input);const baselineRun=await call('baseline',entry.input);
        benchmarks.push({name:entry.name,candidatePassed:validationCasePassed(candidateRun,entry.expectedOutput),
          baselinePassed:validationCasePassed(baselineRun,entry.expectedOutput),candidateRun,baselineRun});
      }
    }
    const domainGatePassed=domainCases.length>0&&domainCases.every(x=>x.expectationPassed);
    const candidateScore=benchmarks.filter(x=>x.candidatePassed).length;const baselineScore=benchmarks.filter(x=>x.baselinePassed).length;
    const netGain=candidateScore-baselineScore;const minNetGain=manifest.minNetGain??1;
    const benchmarkGate={candidateScore,baselineScore,netGain,minNetGain,passed:benchmarks.length>0&&netGain>=minNetGain};
    // Re-resolve after every awaited boundary has completed. A lost or changed
    // parent is infrastructure failure, never a successful comparison.
    const currentParent=assertRegisteredToolParent(input,{root,registry});
    must(isDeepStrictEqual(currentParent,parentComparison),'Registered parent binding changed during validation');
    let artifactIntegrityPassed=true;
    try{
      const current=registry.getProposal(id);must(current&&current.artifactSha256===row.artifactSha256,'Registry material identity changed');
      identity(current,readToolProposal(id,{proposalsRoot:paths.proposalsRoot,expectedArtifactSha256:row.artifactSha256}),paths);
    }catch{artifactIntegrityPassed=false;}
    const passed=artifactIntegrityPassed&&canRun&&repeatability.passed&&domainGatePassed&&benchmarkGate.passed;
    const report={protocolVersion:'sirna-tool-validation/v3',validationId,proposalId:id,verifiedAt:new Date().toISOString(),
      artifactSha256:row.artifactSha256,artifactIntegrityPassed,isolatedExecution:true,unprivilegedUid:65534,
      environment:{nodeVersion:process.version,platform:process.platform,architecture:process.arch},
      staticCheck,syntaxChecks,dependencyChecks,repeatability,domainCases,domainGatePassed,benchmarks,benchmarkGate,passed,
      runtimeArtifactVerified:checked.runtimeArtifactVerified===true,executionPerformed:executionCount>0,executionCount,
      executionPolicy:checked.executionPolicy,
      ...(parentComparison?{parentComparison}:{}),
      scope:{runtime:'node',permissionProfile:'no_external_access',dependencies:'none declared',filesDigest:'actual isolated work directory; temporary files outside it are excluded',cpuQuota:false},
      ...(artifactIntegrityPassed?{}:{artifactIntegrityError:'Registered material could not be verified after execution; artifactSha256 identifies the original registered snapshot'})};
    const persisted=writeValidationReport(report,{root});reportPath=persisted.reportPath;
    registry.recordValidation({id:validationId,proposalId:id,passed,...persisted});
    return report;
  }catch(error){
    if(reportPath)error.reportPath=reportPath;
    error.validationId=validationId;error.proposalId=id;
    try{error.evidencePath=writeValidationFailure(id,validationId,error,{root});}catch{/* Preserve original error and any report already saved. */}
    throw error;
  }finally{registry.close();}
}
