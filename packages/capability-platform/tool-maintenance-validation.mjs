import fs from 'node:fs';
import path from 'node:path';
import {maintenanceDirectory,maintenanceId} from './tool-maintenance-store.mjs';
import {createDockerValidationRunner} from './tool-validation-runner.mjs';
import {validateRegisteredToolProposal} from './tool-validation-service.mjs';

export function createMaintenanceValidator({root,docker}){
  return async(proposalId,job)=>{
    maintenanceId(proposalId);maintenanceId(job.id);
    const directory=path.join(maintenanceDirectory(root,'runs'),job.id);
    fs.mkdirSync(directory,{mode:0o700}); // Exclusive per job, never append to an old attempt.
    const write=(name,value)=>{const fd=fs.openSync(path.join(directory,name),'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
    write('request.json',{jobId:job.id,proposalId,requestedAt:new Date().toISOString(),modelRequests:0});
    const journal=fs.openSync(path.join(directory,'events.jsonl'),'wx',0o600);let bytes=0;
    try{
      const runner=createDockerValidationRunner({docker,purpose:'validation',onEvent:async event=>{
        const line=JSON.stringify({...event,recordedAt:new Date().toISOString()})+'\n';bytes+=Buffer.byteLength(line);
        if(bytes>16*1024*1024)throw new Error('Validation journal capacity exceeded');
        fs.writeSync(journal,line);fs.fsyncSync(journal);
      }});
      const report=await validateRegisteredToolProposal(proposalId,{root,runner});
      write('result.json',{jobId:job.id,proposalId,validationId:report.validationId,passed:report.passed,executionCount:report.executionCount,modelRequests:0});return report;
    }catch(error){
      // A real infrastructure error may include an unacknowledged Docker create.
      // Pause the queue until a trusted operator checks private evidence, rather
      // than repeatedly spending resources after an uncertain execution.
      error.maintenanceUnsafe=true;
      try{write('failure.json',{jobId:job.id,proposalId,error:error.message,validationId:error.validationId,reportPath:error.reportPath,evidencePath:error.evidencePath,containerId:error.containerId});}catch{/* Original failure wins. */}throw error;}
    finally{fs.closeSync(journal);}
  };
}
