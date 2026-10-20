// Trusted maintenance entry point; source execution is confined to this
// project's dedicated Docker containers, with no Pi or model requests.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {resolveToolLearningPaths} from '../packages/capability-platform/tool-lifecycle.mjs';
import {validateRegisteredToolProposal} from '../packages/capability-platform/tool-validation-service.mjs';
import {DockerEngineClient} from '../packages/capability-platform/docker-engine-client.mjs';
import {createDockerValidationRunner} from '../packages/capability-platform/tool-validation-runner.mjs';

const root='/home/hanwen/Project/project/siNRA-pi';
let evidenceDirectory;
try{
  const [proposalId,...extra]=process.argv.slice(2);
  if(extra.length||!/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(proposalId??''))throw new Error('Usage: validate-tool-proposal.mjs <proposal-UUID>');
  if(process.platform!=='linux'||os.userInfo().username!=='hanwen'||process.cwd()!==root||fs.realpathSync(root)!==root)throw new Error('Run as hanwen from the dedicated Linux project directory, without sudo');
  resolveToolLearningPaths(root);
  const socket=path.join(root,'runtime/docker/run/docker.sock');
  if(fs.realpathSync(socket)!==socket||!fs.lstatSync(socket).isSocket())throw new Error('Expected this project Docker socket');
  const evidenceRoot=path.join(root,'runtime/tool-validation-runs');
  try{fs.mkdirSync(evidenceRoot,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  if(!fs.lstatSync(evidenceRoot).isDirectory()||fs.lstatSync(evidenceRoot).isSymbolicLink()||fs.realpathSync(evidenceRoot)!==evidenceRoot)throw new Error('Validation evidence directory is redirected');
  evidenceDirectory=path.join(evidenceRoot,randomUUID());fs.mkdirSync(evidenceDirectory,{mode:0o700});
  fs.writeFileSync(path.join(evidenceDirectory,'request.json'),`${JSON.stringify({proposalId,requestedAt:new Date().toISOString(),modelRequests:0})}\n`,{flag:'wx',mode:0o600});
  const journal=fs.openSync(path.join(evidenceDirectory,'events.jsonl'),'wx',0o600);
  let report;
  try{
    const runner=createDockerValidationRunner({docker:new DockerEngineClient(socket),onEvent:async event=>{
      fs.writeSync(journal,`${JSON.stringify({...event,recordedAt:new Date().toISOString()})}\n`);fs.fsyncSync(journal);
    }});
    report=await validateRegisteredToolProposal(proposalId,{root,runner});
  }finally{fs.closeSync(journal);}
  const result={ok:true,proposalId,validationId:report.validationId,state:report.passed?'verified':'verification_failed',
    passed:report.passed,executionCount:report.executionCount,repeatabilityPassed:report.repeatability.passed,
    domainGatePassed:report.domainGatePassed,benchmarkGate:report.benchmarkGate,
    artifactIntegrityPassed:report.artifactIntegrityPassed,runtimeArtifactVerified:report.runtimeArtifactVerified,
    evidenceDirectory,approved:false,activated:false,modelRequests:0};
  fs.writeFileSync(path.join(evidenceDirectory,'result.json'),`${JSON.stringify(result,null,2)}\n`,{flag:'wx',mode:0o600});
  console.log(JSON.stringify(result,null,2));
  if(!report.passed)process.exitCode=2;
}catch(error){
  const result={ok:false,error:error instanceof Error?error.message:'Validation failed',evidenceDirectory,
    ...(error.reportPath?{reportPath:error.reportPath}:{}),...(error.evidencePath?{diagnosticPath:error.evidencePath}:{}),
    ...(error.containerId?{containerId:error.containerId}:{}),approved:false,activated:false};
  if(evidenceDirectory){try{fs.writeFileSync(path.join(evidenceDirectory,'failure.json'),`${JSON.stringify(result,null,2)}\n`,{flag:'wx',mode:0o600});}catch{}}
  console.error(JSON.stringify(result));process.exitCode=1;
}
