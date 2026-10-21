// Submission and read-back only. Execution, validation and approval are separate
// lifecycle operations and are intentionally not wired into this entry point.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import { checkToolProposal } from './tool-contract.mjs';
import { createToolProposal, readToolProposal } from './tool-proposals.mjs';
import { ToolRegistry } from './tool-registry.mjs';
import { readLatestValidationReport } from './tool-validation-reports.mjs';
import {loadApprovedToolPackage} from './tool-approved-packages.mjs';
import {toolVersion,earlierParent} from './tool-version.mjs';
import {repairSource,repairAssociation,assertRepairContract,assertRepairPredecessor} from './tool-repair-contract.mjs';
import {getToolProposalSource} from './tool-proposal-source.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function checkedId(id) {
  if(typeof id!=='string'||!uuid.test(id)) throw new Error('Proposal ID must be a lowercase UUID v4');
}
function exists(filename) {
  try { fs.lstatSync(filename);return true; }
  catch(error) { if(error.code==='ENOENT') return false;throw error; }
}
function directory(filename) {
  const stat=fs.lstatSync(filename);
  if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(filename)!==filename) {
    throw new Error('Refusing a linked or redirected registry directory');
  }
}
export function resolveToolLearningPaths(root,create=false) {
  if(typeof root!=='string'||!path.isAbsolute(root)) throw new Error('An explicit absolute project root is required');
  root=path.resolve(root);directory(root);
  const runtime=path.join(root,'runtime');
  const registryRoot=path.join(runtime,'tool-registry');
  const artifactsRoot=path.join(runtime,'tool-artifacts');
  const proposalsRoot=path.join(artifactsRoot,'proposals');
  const approvedRoot=path.join(artifactsRoot,'approved');
  for(const target of [runtime,registryRoot,artifactsRoot,proposalsRoot]) {
    if(create&&!exists(target)) {
      try { fs.mkdirSync(target,{mode:0o700}); }
      catch(error) { if(error.code!=='EEXIST') throw error; }
    }
    if(exists(target)) directory(target);
  }
  if(exists(approvedRoot))directory(approvedRoot);
  return {proposalsRoot,approvedRoot,databasePath:path.join(registryRoot,'registry.sqlite'),catalogPath:path.join(registryRoot,'active-tools.json')};
}
function flags(report,version) {
  // Registration metadata never probes a deployed Agent gateway.
  return {registered:true,executed:report?.executionPerformed===true,verified:report?.passed===true,approved:!!version,activated:version?.state==='active',agentCallable:null,callabilityChecked:false,runtimeArtifactVerified:report?.runtimeArtifactVerified===true};
}
function integrity(artifactSha256) {
  return {packageMatchesRegistration:true,sourceHashesMatch:true,artifactSha256};
}

export function submitRegisteredToolProposal(input,{root,actor='local-cli',taskContext,repair}={}) {
  if(!['local-cli','web-agent'].includes(actor))throw new TypeError('Invalid proposal actor');
  const preflight=checkToolProposal(input);
  if(!preflight.ok) throw new Error(`${preflight.code}: ${preflight.error}`);
  if(taskContext!==undefined){taskContext=repairSource(taskContext);if(actor!=='web-agent')throw new Error('Source requires web-agent actor');}
  if(repair!==undefined){
    repair=repairAssociation(repair);if(!taskContext)throw new Error('Repair requires task source');
    const previous=getToolProposalSource(repair.previousProposalId,{root});
    assertRepairPredecessor(repair,previous,taskContext,previous.source);assertRepairContract(previous.input,input);
  }
  // Parent evidence must be resolved without creating even the registry roots.
  const existingPaths=resolveToolLearningPaths(root);
  let existingRegistry;
  try {
    if(exists(existingPaths.databasePath))existingRegistry=new ToolRegistry(existingPaths.databasePath,{readOnly:true});
    if(!Object.hasOwn(input,'parent')&&existingRegistry?.listToolVersions(input.toolName).length) {
      throw new Error('An existing formal tool requires an explicit parent version');
    }
    assertRegisteredToolParent(input,{root,registry:existingRegistry});
  } finally { existingRegistry?.close(); }
  const paths=resolveToolLearningPaths(root,true);
  const saved=createToolProposal(input,{proposalsRoot:paths.proposalsRoot});
  let registry;
  try {
    registry=new ToolRegistry(paths.databasePath);
    const row=registry.registerProposal({id:saved.manifest.id,toolName:saved.manifest.toolName,
      artifactPath:saved.artifactPath,artifactSha256:saved.artifactSha256,
      permissionProfile:saved.manifest.permissions.profile,imageDigest:saved.manifest.runtimeArtifact.imageDigest},
    {actor,...(taskContext?{taskContext}:{}),...(repair?{repair}:{})});
    return {proposal:saved.manifest,registry:row,integrity:integrity(saved.artifactSha256),...flags()};
  } catch(error) {
    const failure=new Error(`Proposal material saved but registration failed: ${error.message}`,{cause:error});
    failure.proposalId=saved.manifest.id;failure.artifactPath=saved.artifactPath;throw failure;
  } finally { registry?.close(); }
}

export function listRegisteredToolProposals({root}={}) {
  const paths=resolveToolLearningPaths(root);
  if(!exists(paths.databasePath)) return [];
  const registry=new ToolRegistry(paths.databasePath,{readOnly:true});
  try { return registry.listProposals(); }
  finally { registry.close(); }
}

/** Bind a published package back to its registered proposal and latest evidence. */
export function readRegisteredToolVersion(version,{root,registry,context={visiting:new Set(),packages:new Map()}}) {
  if(!version||!['active','inactive'].includes(version.state)||version.runtimeState!=='retained')throw new Error('No retained tool version');
  toolVersion(version.version);
  const key=`${version.toolName}@${version.version}`;
  if(context.visiting.has(key)||context.visiting.size>=64)throw new Error('Malformed or cyclic tool parent lineage exceeds safe depth');
  if(context.packages.has(key))return context.packages.get(key);
  context.visiting.add(key);
  try{
  const paths=resolveToolLearningPaths(root);
  const proposal=registry.getProposal(version.proposalId);
  if(!proposal||proposal.state!=='approved'||proposal.toolName!==version.toolName||proposal.imageDigest!==version.imageDigest||
    proposal.artifactPath!==path.join(paths.proposalsRoot,proposal.id))throw new Error('Published version differs from its approved proposal');
  const saved=readToolProposal(proposal.id,{proposalsRoot:paths.proposalsRoot,expectedArtifactSha256:proposal.artifactSha256});
  if(saved.input.parent){
    if(saved.input.parent.toolName!==version.toolName||version.parentToolId!==version.toolId||
      version.parentVersion!==saved.input.parent.version||!earlierParent(version.parentVersion,version.version))throw new Error('Malformed parent identity or version lineage order');
    const parent=registry.getToolVersion(version.toolName,version.parentVersion);
    if(!parent||parent.toolId!==version.toolId)throw new Error('Parent tool identity differs from child');
  }else if(version.version!=='1.0.0'||version.parentToolId!==undefined||version.parentVersion!==undefined)throw new Error('Initial version has invalid parent lineage');
  const validation=readLatestValidationReport(proposal.id,{root,registry,context});
  const pkg=loadApprovedToolPackage(version.packageDirectory,{approvedRoot:paths.approvedRoot,expectedPackageSha256:version.packageSha256});
  const manifest=pkg.manifest;
  if(!isDeepStrictEqual(manifest.parent,saved.manifest.parent))throw new Error('Published parent differs from submitted material');
  if(manifest.id!==version.toolId||manifest.proposalId!==proposal.id||manifest.toolName!==version.toolName||manifest.version!==version.version||
    pkg.approval.approvedBy!==version.approvedBy||pkg.approval.approvedAt!==version.approvedAt||
    pkg.approval.verificationSha256!==validation.reportSha256||pkg.verification.validationId!==validation.id||
    pkg.verification.artifactSha256!==proposal.artifactSha256)throw new Error('Published package differs from registered identity or validation');
  for(const field of ['name','description','runtime','repeatabilityMode','dependencies','permissions','runtimeArtifact','scriptFile','scriptSha256','createdAt']){
    if(!isDeepStrictEqual(manifest[field],saved.manifest[field]))throw new Error('Published manifest differs from submitted material');
  }
  context.packages.set(key,pkg);return pkg;
  }finally{context.visiting.delete(key);}
}

/** Resolve complete retained parent evidence without executing source. */
export function assertRegisteredToolParent(input,{root,registry,context}={}) {
  if(!Object.hasOwn(input,'parent'))return undefined;
  const parent=input.parent;
  if(!parent||parent.toolName!==input.toolName)throw new Error('parent must have the same toolName as the proposal');
  toolVersion(parent.version);
  const version=registry?.getToolVersion(parent.toolName,parent.version);
  if(!version)throw new Error('Unknown registered parent version');
  const pkg=readRegisteredToolVersion(version,{root,registry,context});
  if(input.baseline?.runtime!==pkg.manifest.runtime)throw new Error('Baseline runtime differs from the registered parent');
  const baselineScriptSha256=createHash('sha256').update(input.baseline.script,'utf8').digest('hex');
  if(baselineScriptSha256!==pkg.manifest.scriptSha256)throw new Error('Baseline source differs from the registered parent');
  return {toolName:version.toolName,version:version.version,toolId:version.toolId,
    packageSha256:version.packageSha256,imageDigest:version.imageDigest,scriptSha256:pkg.manifest.scriptSha256,
    baselineScriptSha256,comparisonMode:'registered-parent-source'};
}

export function getRegisteredToolProposal(id,{root}={}) {
  checkedId(id);
  const paths=resolveToolLearningPaths(root);
  if(!exists(paths.databasePath)) throw new Error('Unknown proposal');
  const registry=new ToolRegistry(paths.databasePath,{readOnly:true});
  try {
    const row=registry.getProposal(id);
    if(!row) throw new Error('Unknown proposal');
    if(row.artifactPath!==path.join(paths.proposalsRoot,id)) throw new Error('Registered artifact path is outside its fixed proposal root');
    const saved=readToolProposal(id,{proposalsRoot:paths.proposalsRoot,expectedArtifactSha256:row.artifactSha256});
    if(row.toolName!==saved.manifest.toolName||row.permissionProfile!==saved.manifest.permissions.profile||
      row.imageDigest!==saved.manifest.runtimeArtifact.imageDigest) throw new Error('Registry identity metadata does not match the proposal manifest');
    if(!['submitted','verified','verification_failed','approved'].includes(row.state)) throw new Error('This learning step only supports submitted, validated or approved proposal records');
    assertRegisteredToolParent(saved.input,{root,registry});
    const validation=readLatestValidationReport(id,{root,registry});
    const version=row.state==='approved'?registry.listToolVersions(row.toolName).find(item=>item.proposalId===id):undefined;
    if(row.state==='approved')readRegisteredToolVersion(version,{root,registry});
    return {proposal:saved.manifest,registry:row,integrity:integrity(saved.artifactSha256),events:registry.listEvents(id),
      ...(validation?{validation}:{}),...(version?{version}:{}),...flags(validation?.report,version)};
  } finally { registry.close(); }
}
