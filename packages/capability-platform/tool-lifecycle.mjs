// Submission and read-back only. Execution, validation and approval are separate
// lifecycle operations and are intentionally not wired into this entry point.
import fs from 'node:fs';
import path from 'node:path';
import { checkToolProposal } from './tool-contract.mjs';
import { createToolProposal, readToolProposal } from './tool-proposals.mjs';
import { ToolRegistry } from './tool-registry.mjs';

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
function pathsFor(root,create=false) {
  if(typeof root!=='string'||!path.isAbsolute(root)) throw new Error('An explicit absolute project root is required');
  root=path.resolve(root);directory(root);
  const runtime=path.join(root,'runtime');
  const registryRoot=path.join(runtime,'tool-registry');
  const artifactsRoot=path.join(runtime,'tool-artifacts');
  const proposalsRoot=path.join(artifactsRoot,'proposals');
  for(const target of [runtime,registryRoot,artifactsRoot,proposalsRoot]) {
    if(create&&!exists(target)) {
      try { fs.mkdirSync(target,{mode:0o700}); }
      catch(error) { if(error.code!=='EEXIST') throw error; }
    }
    if(exists(target)) directory(target);
  }
  return {proposalsRoot,databasePath:path.join(registryRoot,'registry.sqlite')};
}
function flags() {
  return {registered:true,executed:false,verified:false,approved:false,activated:false,runtimeArtifactVerified:false};
}
function integrity(artifactSha256) {
  return {packageMatchesRegistration:true,sourceHashesMatch:true,artifactSha256};
}

export function submitRegisteredToolProposal(input,{root}={}) {
  const preflight=checkToolProposal(input);
  if(!preflight.ok) throw new Error(`${preflight.code}: ${preflight.error}`);
  if(Object.hasOwn(input,'parent')) throw new Error('Parent versions are not supported until tool version management is implemented');
  const paths=pathsFor(root,true);
  const saved=createToolProposal(input,{proposalsRoot:paths.proposalsRoot});
  let registry;
  try {
    registry=new ToolRegistry(paths.databasePath);
    const row=registry.registerProposal({id:saved.manifest.id,toolName:saved.manifest.toolName,
      artifactPath:saved.artifactPath,artifactSha256:saved.artifactSha256,
      permissionProfile:saved.manifest.permissions.profile,imageDigest:saved.manifest.runtimeArtifact.imageDigest},
    {actor:'local-cli'});
    return {proposal:saved.manifest,registry:row,integrity:integrity(saved.artifactSha256),...flags()};
  } catch(error) {
    const failure=new Error(`Proposal material saved but registration failed: ${error.message}`,{cause:error});
    failure.proposalId=saved.manifest.id;failure.artifactPath=saved.artifactPath;throw failure;
  } finally { registry?.close(); }
}

export function listRegisteredToolProposals({root}={}) {
  const paths=pathsFor(root);
  if(!exists(paths.databasePath)) return [];
  const registry=new ToolRegistry(paths.databasePath,{readOnly:true});
  try { return registry.listProposals(); }
  finally { registry.close(); }
}

export function getRegisteredToolProposal(id,{root}={}) {
  checkedId(id);
  const paths=pathsFor(root);
  if(!exists(paths.databasePath)) throw new Error('Unknown proposal');
  const registry=new ToolRegistry(paths.databasePath,{readOnly:true});
  try {
    const row=registry.getProposal(id);
    if(!row) throw new Error('Unknown proposal');
    if(row.artifactPath!==path.join(paths.proposalsRoot,id)) throw new Error('Registered artifact path is outside its fixed proposal root');
    const saved=readToolProposal(id,{proposalsRoot:paths.proposalsRoot,expectedArtifactSha256:row.artifactSha256});
    if(row.toolName!==saved.manifest.toolName||row.permissionProfile!==saved.manifest.permissions.profile||
      row.imageDigest!==saved.manifest.runtimeArtifact.imageDigest) throw new Error('Registry identity metadata does not match the proposal manifest');
    if(row.state!=='submitted') throw new Error('This learning step only supports submitted proposal records');
    return {proposal:saved.manifest,registry:row,integrity:integrity(saved.artifactSha256),events:registry.listEvents(id),...flags()};
  } finally { registry.close(); }
}
