import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {ToolRegistry} from './tool-registry.mjs';
import {resolveToolLearningPaths,getRegisteredToolProposal,readRegisteredToolVersion} from './tool-lifecycle.mjs';
import {readToolProposal} from './tool-proposals.mjs';
import {assertValidationSupported} from './tool-validation-static.mjs';
import {readLatestValidationReport,readValidationReportBytes} from './tool-validation-reports.mjs';
import {publishApprovedToolPackage,loadApprovedToolPackage} from './tool-approved-packages.mjs';
import {writeActiveToolCatalog,readActiveToolCatalog} from './tool-catalog.mjs';

function must(ok,message){if(!ok)throw new Error(message);}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function open(root,options={readOnly:true}){
  const paths=resolveToolLearningPaths(root);must(fs.existsSync(paths.databasePath),'Unknown proposal or tool registry');
  return {paths,registry:new ToolRegistry(paths.databasePath,options)};
}
export function listRegisteredToolVersions({root}={}){
  const paths=resolveToolLearningPaths(root);if(!fs.existsSync(paths.databasePath))return [];
  const registry=new ToolRegistry(paths.databasePath,{readOnly:true});try{return registry.listToolVersions();}finally{registry.close();}
}
export function getRegisteredToolVersion(toolName,version,{root}={}){
  const {registry}=open(root);try{
    const found=registry.getToolVersion(toolName,version);must(found,'Unknown tool version');
    return {version:found,package:readRegisteredToolVersion(found,{root,registry})};
  }finally{registry.close();}
}
export function getRegisteredToolCatalog({root,rebuild=false}={}){
  const paths=resolveToolLearningPaths(root);
  if(!fs.existsSync(paths.databasePath)){
    must(!rebuild,'No registry to rebuild');return readActiveToolCatalog({root});
  }
  const registry=new ToolRegistry(paths.databasePath,{readOnly:true});
  try{return rebuild?writeActiveToolCatalog({root,registry}):readActiveToolCatalog({root,registry});}finally{registry.close();}
}
export function approveRegisteredToolProposal(id,approvedBy,{root}={}){
  must(typeof approvedBy==='string'&&approvedBy.trim().length>0&&approvedBy.trim().length<=120,'approvedBy must contain 1 to 120 characters');
  approvedBy=approvedBy.trim();
  // Read-only preflight must reject bad evidence before schema or package writes.
  const detail=getRegisteredToolProposal(id,{root});
  must(['verified','approved'].includes(detail.registry.state)&&detail.validation?.passed===true,'Only a verified proposal with a passing validation can be approved');
  const {paths,registry}=open(root,{migrate:true});let published,version;
  try{
    if(detail.registry.state==='approved'){
      version=registry.listToolVersions(detail.registry.toolName).find(item=>item.proposalId===id);
      readRegisteredToolVersion(version,{root,registry});
      const catalog=writeActiveToolCatalog({root,registry});
      // Approval checks stored evidence, not live Agent gateway connectivity.
      return {version,catalog,alreadyApproved:true,approved:true,activated:true,agentCallable:null,callabilityChecked:false};
    }
    must(registry.listToolVersions(detail.registry.toolName).length===0,'A version with this tool name already exists; parent updates are not supported in this step');
    const saved=readToolProposal(id,{proposalsRoot:paths.proposalsRoot,expectedArtifactSha256:detail.registry.artifactSha256});
    assertValidationSupported(saved.input);
    const validation=readLatestValidationReport(id,{root,registry});
    must(validation?.passed===true&&validation.id===detail.validation.id&&validation.reportSha256===detail.validation.reportSha256,'Latest passing validation changed before approval');
    const verificationBytes=readValidationReportBytes(validation.reportPath);
    must(hash(verificationBytes)===validation.reportSha256,'Validation report was modified before approval');
    if(!fs.existsSync(paths.approvedRoot))fs.mkdirSync(paths.approvedRoot,{mode:0o700});
    const toolId=randomUUID();const approvedAt=new Date().toISOString();
    published=publishApprovedToolPackage({saved,verificationBytes,verificationSha256:validation.reportSha256,toolId,approvedBy,approvedAt},{approvedRoot:paths.approvedRoot});
    loadApprovedToolPackage(published.directoryName,{approvedRoot:paths.approvedRoot,expectedPackageSha256:published.packageSha256});
    readToolProposal(id,{proposalsRoot:paths.proposalsRoot,expectedArtifactSha256:detail.registry.artifactSha256});
    const latest=readLatestValidationReport(id,{root,registry});
    must(latest.id===validation.id&&latest.reportSha256===validation.reportSha256,'Latest validation changed while publishing package');
    version=registry.activateVersion({toolId,toolName:saved.manifest.toolName,version:'1.0.0',proposalId:id,
      packageDirectory:published.directoryName,packageSha256:published.packageSha256,imageDigest:saved.manifest.runtimeArtifact.imageDigest,
      approvedBy,approvedAt,validationId:validation.id,reportSha256:validation.reportSha256,artifactSha256:saved.artifactSha256});
    const catalog=writeActiveToolCatalog({root,registry});
    return {version,catalog,alreadyApproved:false,approved:true,activated:true,agentCallable:null,callabilityChecked:false};
  }catch(error){
    error.proposalId=id;if(published)error.packagePath=published.directory;
    if(version){error.versionActivated=true;error.toolName=version.toolName;error.version=version.version;
      error.message=`Version is active but catalog publication or verification failed: ${error.message}`;}
    throw error;
  }finally{registry.close();}
}
