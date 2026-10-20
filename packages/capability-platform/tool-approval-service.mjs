import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ToolRegistry} from './tool-registry.mjs';
import {resolveToolLearningPaths,getRegisteredToolProposal,readRegisteredToolVersion,assertRegisteredToolParent} from './tool-lifecycle.mjs';
import {readToolProposal} from './tool-proposals.mjs';
import {assertValidationSupported} from './tool-validation-static.mjs';
import {readLatestValidationReport,readValidationReportBytes} from './tool-validation-reports.mjs';
import {publishApprovedToolPackage,loadApprovedToolPackage} from './tool-approved-packages.mjs';
import {writeActiveToolCatalog,readActiveToolCatalog} from './tool-catalog.mjs';
import {maintenanceText,toolVersion} from './tool-version.mjs';

function must(ok,message){if(!ok)throw new Error(message);}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// A prospective release adds its own frame to the retained ancestor chain.
const releaseContext=name=>({visiting:new Set([`${name}@prospective-release`]),packages:new Map()});
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
  approvedBy=maintenanceText(approvedBy,'approvedBy');
  // Read-only preflight must reject bad evidence before schema or package writes.
  const detail=getRegisteredToolProposal(id,{root});
  must(['verified','approved'].includes(detail.registry.state)&&detail.validation?.passed===true,'Only a verified proposal with a passing validation can be approved');
  if(detail.registry.state!=='approved'&&detail.proposal.parent){
    const {registry}=open(root);
    try{readLatestValidationReport(id,{root,registry,context:releaseContext(detail.registry.toolName)});}
    finally{registry.close();}
  }
  const {paths,registry}=open(root,{migrate:true});let published,version,changed=false;
  try{
    if(detail.registry.state==='approved'){
      version=registry.listToolVersions(detail.registry.toolName).find(item=>item.proposalId===id);
      readRegisteredToolVersion(version,{root,registry});
      const catalog=writeActiveToolCatalog({root,registry});
      // Approval checks stored evidence, not live Agent gateway connectivity.
      return {version,catalog,alreadyApproved:true,approved:true,activated:version.state==='active',agentCallable:null,callabilityChecked:false};
    }
    const saved=readToolProposal(id,{proposalsRoot:paths.proposalsRoot,expectedArtifactSha256:detail.registry.artifactSha256});
    assertValidationSupported(saved.input);
    const validation=readLatestValidationReport(id,{root,registry,context:releaseContext(saved.manifest.toolName)});
    must(validation?.passed===true&&validation.id===detail.validation.id&&validation.reportSha256===detail.validation.reportSha256,'Latest passing validation changed before approval');
    const verificationBytes=readValidationReportBytes(validation.reportPath);
    must(hash(verificationBytes)===validation.reportSha256,'Validation report was modified before approval');
    if(!fs.existsSync(paths.approvedRoot))fs.mkdirSync(paths.approvedRoot,{mode:0o700});
    const parent=assertRegisteredToolParent(saved.input,{root,registry,context:releaseContext(saved.manifest.toolName)});
    const {toolId,version:versionNumber}=registry.nextVersion(saved.manifest.toolName,parent?.version);
    const approvedAt=new Date().toISOString();
    published=publishApprovedToolPackage({saved,verificationBytes,verificationSha256:validation.reportSha256,toolId,version:versionNumber,approvedBy,approvedAt},{approvedRoot:paths.approvedRoot});
    loadApprovedToolPackage(published.directoryName,{approvedRoot:paths.approvedRoot,expectedPackageSha256:published.packageSha256});
    readToolProposal(id,{proposalsRoot:paths.proposalsRoot,expectedArtifactSha256:detail.registry.artifactSha256});
    const latest=readLatestValidationReport(id,{root,registry});
    must(latest.id===validation.id&&latest.reportSha256===validation.reportSha256,'Latest validation changed while publishing package');
    version=registry.activateVersion({toolId,toolName:saved.manifest.toolName,version:versionNumber,proposalId:id,
      packageDirectory:published.directoryName,packageSha256:published.packageSha256,imageDigest:saved.manifest.runtimeArtifact.imageDigest,
      approvedBy,approvedAt,validationId:validation.id,reportSha256:validation.reportSha256,artifactSha256:saved.artifactSha256,
      ...(parent?{parentToolId:parent.toolId,parentVersion:parent.version,parentPackageSha256:parent.packageSha256}:{})},
    {verifyEvidence:()=>{
      readToolProposal(id,{proposalsRoot:paths.proposalsRoot,expectedArtifactSha256:saved.artifactSha256});
      const current=readLatestValidationReport(id,{root,registry,context:releaseContext(saved.manifest.toolName)});
      must(current.id===validation.id&&current.reportSha256===validation.reportSha256,'Latest validation changed before activation');
      loadApprovedToolPackage(published.directoryName,{approvedRoot:paths.approvedRoot,expectedPackageSha256:published.packageSha256});
    }});
    changed=true;
    const catalog=writeActiveToolCatalog({root,registry});
    return {version,catalog,alreadyApproved:false,approved:true,activated:true,agentCallable:null,callabilityChecked:false};
  }catch(error){
    error.proposalId=id;if(published)error.packagePath=published.directory;
    if(version){error.versionActivated=version.state==='active';error.activeStateChanged=changed;
      error.approved=true;error.activated=version.state==='active';error.toolName=version.toolName;error.version=version.version;
      error.message=`Approval is stored (${version.state}); catalog publication or verification failed; use catalog-rebuild: ${error.message}`;}
    throw error;
  }finally{registry.close();}
}

export function rollbackRegisteredTool(toolName,versionNumber,actor,reason,{root}={}){
  // Text validation precedes even a writable registry open or explicit migration.
  actor=maintenanceText(actor,'actor');reason=maintenanceText(reason,'reason',1000);toolVersion(versionNumber);
  const inspected=getRegisteredToolVersion(toolName,versionNumber,{root});
  const {registry}=open(root,{migrate:true});let version,changed=false;
  try{
    const target=registry.getToolVersion(toolName,versionNumber);
    must(target&&target.toolId===inspected.version.toolId&&target.packageSha256===inspected.version.packageSha256,'Rollback target identity changed');
    const previous=registry.getActiveTool(toolName);
    changed=previous?.version!==versionNumber;
    version=registry.rollbackTool(toolName,versionNumber,actor,reason,{verifyEvidence:()=>{
      changed=registry.getActiveTool(toolName)?.version!==versionNumber;
      const current=registry.getToolVersion(toolName,versionNumber);
      must(current.toolId===inspected.version.toolId&&current.packageSha256===inspected.version.packageSha256,'Rollback target identity changed');
      readRegisteredToolVersion(current,{root,registry});
    }});
    const catalog=writeActiveToolCatalog({root,registry});
    return {version,catalog,approved:true,activated:true,changed,agentCallable:null,callabilityChecked:false};
  }catch(error){
    if(version){
      error.versionActivated=true;error.activeStateChanged=changed;error.approved=true;error.activated=true;
      error.toolName=version.toolName;error.version=version.version;
      error.message=`Rollback target is active; catalog publication or verification failed; use catalog-rebuild: ${error.message}`;
    }
    throw error;
  }finally{registry.close();}
}
