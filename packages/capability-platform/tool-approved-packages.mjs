// Immutable version packages. Source and reports are data only: this
// module never imports candidate code, starts a process or invokes a model.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {TextDecoder, types} from 'node:util';
import {validateToolProposalInput} from './tool-contract.mjs';
import {assertValidationSupported} from './tool-validation-static.mjs';
import {toolVersion,earlierParent,maintenanceText} from './tool-version.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA=/^[0-9a-f]{64}$/;
const DIRECTORY=/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-(.+)$/;
const NAMES=['approval.json','integrity.json','manifest.json','tool.mjs','verification.json'];
const PROTECTED=['approval.json','manifest.json','tool.mjs','verification.json'];
const JSON_LIMIT=1024*1024;
const MANIFEST_FIELDS=['protocolVersion','id','proposalId','version','status','toolName','name','description',
  'runtime','repeatabilityMode','dependencies','permissions','runtimeArtifact','scriptFile','scriptSha256','createdAt','verifiedAt'];
const APPROVAL_FIELDS=['protocolVersion','proposalId','version','approvedBy','approvedAt','approvedManifestSha256','verificationSha256'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(`${JSON.stringify(value,null,2)}\n`);
function must(ok,message){if(!ok)throw new Error(message);}
function plainData(value,ancestors=new Set()) {
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
  must(value&&typeof value==='object'&&!types.isProxy(value)&&!ancestors.has(value),'Package input must be plain JSON data');
  const array=Array.isArray(value);const prototype=Object.getPrototypeOf(value);
  must(array?prototype===Array.prototype:prototype===Object.prototype||prototype===null,'Package input must be plain JSON data');
  const keys=Reflect.ownKeys(value);must(!array||keys.length===value.length+1,'Package input must be dense JSON data');
  ancestors.add(value);
  for(const key of keys){
    if(array&&key==='length')continue;
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    must(typeof key==='string'&&descriptor.enumerable&&Object.hasOwn(descriptor,'value')&&
      (!array||/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<value.length),'Package input must have data properties');
    plainData(descriptor.value,ancestors);
  }
  ancestors.delete(value);
}
function exact(value,fields,label){
  must(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key)),`${label} must contain the exact protocol fields`);
}
function timestamp(value,label){must(typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value,`${label} must be a canonical ISO timestamp`);}
function actor(value){maintenanceText(value,'approvedBy');}
function utf8(bytes){return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
function parse(bytes,label){try{return JSON.parse(utf8(bytes));}catch{throw new Error(`${label} must be valid UTF-8 JSON`);}}
function packageDigest(files){return hash(PROTECTED.map(name=>`${name}\0${files[name]}\n`).join(''));}
function same(before,after){return ['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].every(key=>before[key]===after[key]);}
function stable(before,after){must(same(before,after),'Approved package file or directory changed while reading');}
function directory(target){
  const stat=fs.lstatSync(target,{bigint:true});
  must(stat.isDirectory()&&!stat.isSymbolicLink()&&fs.realpathSync(target)===path.resolve(target),'Approved package directory must be real without links');
  return stat;
}
function rootDirectory(approvedRoot){
  must(typeof approvedRoot==='string'&&path.isAbsolute(approvedRoot),'approvedRoot must be an absolute existing directory');
  const root=path.resolve(approvedRoot);directory(root);return root;
}
function regular(stat,limit){must(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n&&stat.size<=BigInt(limit),'Approved package file must be bounded, regular and have one link');}
function read(file,limit){
  const before=fs.lstatSync(file,{bigint:true});regular(before,limit);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{
    const opened=fs.fstatSync(fd,{bigint:true});regular(opened,limit);stable(before,opened);
    const buffer=Buffer.alloc(Number(opened.size)+1);let count=0;
    while(count<buffer.length){const n=fs.readSync(fd,buffer,count,buffer.length-count,null);if(!n)break;count+=n;}
    must(count===Number(opened.size),'Approved file size changed while reading');
    stable(opened,fs.fstatSync(fd,{bigint:true}));stable(before,fs.lstatSync(file,{bigint:true}));
    return {bytes:buffer.subarray(0,count),stat:before};
  }finally{fs.closeSync(fd);}
}
function manifestValid(manifest,source){
  exact(manifest,Object.hasOwn(manifest,'parent')?[...MANIFEST_FIELDS,'parent']:MANIFEST_FIELDS,'Approved manifest');
  must(manifest.protocolVersion==='sirna-approved-tool/v1'&&typeof manifest.id==='string'&&UUID.test(manifest.id)&&
    typeof manifest.proposalId==='string'&&UUID.test(manifest.proposalId)&&
    manifest.id!==manifest.proposalId&&manifest.status==='approved','Invalid approved manifest identity, version or status');
  toolVersion(manifest.version);
  if(Object.hasOwn(manifest,'parent')){
    exact(manifest.parent,['toolName','version'],'Approved parent');
    must(manifest.parent.toolName===manifest.toolName&&earlierParent(manifest.parent.version,manifest.version),'Invalid approved parent identity or version order');
  }else must(manifest.version==='1.0.0','A child approved manifest requires a parent');
  must(manifest.runtime==='node'&&manifest.scriptFile==='tool.mjs'&&manifest.repeatabilityMode==='exact'&&
    Array.isArray(manifest.dependencies)&&manifest.dependencies.length===0&&manifest.permissions?.profile==='no_external_access'&&manifest.runtimeArtifact,
    'Approved manifest supports only node, no dependencies, no_external_access and exact');
  timestamp(manifest.createdAt,'createdAt');timestamp(manifest.verifiedAt,'verifiedAt');
  must(SHA.test(manifest.scriptSha256)&&hash(source)===manifest.scriptSha256,'Approved source digest mismatch');
  let script;try{script=utf8(source);}catch{throw new Error('Approved source must be valid UTF-8');}
  validateToolProposalInput(Object.fromEntries(['name','toolName','description','runtime','repeatabilityMode','dependencies','permissions','runtimeArtifact']
    .map(key=>[key,manifest[key]]).concat([['script',script]])));
}
function verificationValid(verification,proposalId,artifactSha256){
  must(verification&&typeof verification==='object'&&!Array.isArray(verification)&&verification.protocolVersion==='sirna-tool-validation/v3'&&
    typeof verification.validationId==='string'&&UUID.test(verification.validationId)&&verification.proposalId===proposalId&&
    typeof verification.artifactSha256==='string'&&SHA.test(verification.artifactSha256)&&
    (artifactSha256===undefined||verification.artifactSha256===artifactSha256)&&verification.passed===true&&
    verification.artifactIntegrityPassed===true&&verification.runtimeArtifactVerified===true,'Validation report identity, material or passing conclusion is invalid');
  timestamp(verification.verifiedAt,'verifiedAt');
}
function approvalValid(approval,manifest,manifestBytes,verificationBytes){
  exact(approval,APPROVAL_FIELDS,'Approval record');
  must(approval.protocolVersion==='sirna-tool-approval/v1'&&approval.proposalId===manifest.proposalId&&approval.version===manifest.version,
    'Approval record identity differs from approved manifest');
  actor(approval.approvedBy);must(approval.approvedBy===approval.approvedBy.trim(),'Approval actor must be trimmed');timestamp(approval.approvedAt,'approvedAt');
  must(approval.approvedManifestSha256===hash(manifestBytes)&&approval.verificationSha256===hash(verificationBytes),'Approval record digest mismatch');
}
function context(error,packagePath,temporaryPath){
  const failure=error instanceof Error?error:new Error('Approved package operation failed');
  failure.packagePath=packagePath;if(temporaryPath!==undefined)failure.temporaryPath=temporaryPath;return failure;
}

/** Load real bounded files; the optional registry digest is the trust anchor. */
export function loadApprovedToolPackage(directoryName,{approvedRoot,expectedPackageSha256}={}){
  must(typeof directoryName==='string'&&DIRECTORY.test(directoryName),'Approved directoryName must be a tool UUID and version basename');
  toolVersion(DIRECTORY.exec(directoryName)[2]);
  const root=rootDirectory(approvedRoot);const target=path.join(root,directoryName);
  try{
    must(expectedPackageSha256===undefined||typeof expectedPackageSha256==='string'&&SHA.test(expectedPackageSha256),'expectedPackageSha256 must be a lowercase SHA-256 hex digest');
    const rootBefore=directory(root);const before=directory(target);const snapshots=new Map();
    const names=fs.readdirSync(target).sort();must(names.length===NAMES.length&&names.every((name,index)=>name===NAMES[index]),'Approved package must contain the exact five file set');
    const files={};
    for(const name of NAMES){
      const file=path.join(target,name);const result=read(file,name==='tool.mjs'?200000:name==='verification.json'?16*1024*1024:JSON_LIMIT);
      files[name]=result.bytes;snapshots.set(file,result.stat);
    }
    const manifest=parse(files['manifest.json'],'Approved manifest');manifestValid(manifest,files['tool.mjs']);
    must(directoryName===`${manifest.id}-${manifest.version}`,'Approved package directory identity mismatch');
    const integrity=parse(files['integrity.json'],'Package integrity');
    exact(integrity,['protocolVersion','packageSha256','files'],'Package integrity');
    must(integrity.protocolVersion==='sirna-approved-tool-integrity/v1','Invalid package integrity protocol');
    exact(integrity.files,PROTECTED,'Integrity file set');
    // integrity.json is deliberately outside its own digest. Canonical bytes
    // reject edits (including trailing whitespace) to that unprotected record.
    const canonicalIntegrity={protocolVersion:integrity.protocolVersion,packageSha256:integrity.packageSha256,
      files:Object.fromEntries(PROTECTED.map(name=>[name,integrity.files[name]]))};
    must(files['integrity.json'].equals(json(canonicalIntegrity)),'Package integrity must use canonical JSON bytes');
    for(const name of PROTECTED)must(integrity.files[name]===hash(files[name]),'Approved package file digest mismatch');
    const packageSha256=packageDigest(integrity.files);
    must(integrity.packageSha256===packageSha256&&(expectedPackageSha256===undefined||expectedPackageSha256===packageSha256),'Approved package digest mismatch');
    const approval=parse(files['approval.json'],'Approval record');approvalValid(approval,manifest,files['manifest.json'],files['verification.json']);
    const verification=parse(files['verification.json'],'Verification report');verificationValid(verification,manifest.proposalId);
    must(verification.verifiedAt===manifest.verifiedAt,'Verification timestamp differs from approved manifest');
    for(const [file,stat]of snapshots)stable(stat,fs.lstatSync(file,{bigint:true}));
    stable(before,directory(target));stable(rootBefore,directory(root));
    return {directory:target,directoryName,manifest,approval,verification,packageSha256};
  }catch(error){throw context(error,target);}
}

/** Publish one new immutable package. Failures retain any temporary evidence. */
export function publishApprovedToolPackage({saved,verificationBytes,verificationSha256,toolId,version='1.0.0',approvedBy,approvedAt},{approvedRoot}={}){
  plainData(saved);validateToolProposalInput(saved.input);assertValidationSupported(saved.input);
  toolVersion(version);
  must(JSON.stringify(saved.input.parent)===JSON.stringify(saved.manifest.parent),'Saved proposal parent differs from manifest');
  must(typeof toolId==='string'&&UUID.test(toolId)&&typeof saved.manifest.id==='string'&&UUID.test(saved.manifest.id)&&toolId!==saved.manifest.id,'New toolId must be a distinct lowercase UUID v4');
  actor(approvedBy);timestamp(approvedAt,'approvedAt');
  must(Buffer.isBuffer(verificationBytes)&&verificationBytes.length<=16*1024*1024&&typeof verificationSha256==='string'&&SHA.test(verificationSha256)&&
    hash(verificationBytes)===verificationSha256,'Verification report digest or byte limit mismatch');
  const verification=parse(verificationBytes,'Verification report');verificationValid(verification,saved.manifest.id,saved.artifactSha256);
  must(typeof saved.artifactSha256==='string'&&SHA.test(saved.artifactSha256),'Invalid saved proposal material digest');
  const source=Buffer.from(saved.input.script,'utf8');
  must(utf8(source)===saved.input.script&&source.length<=200000,'Source must round-trip through UTF-8 within its byte limit');
  const manifest={protocolVersion:'sirna-approved-tool/v1',id:toolId,proposalId:saved.manifest.id,version,status:'approved',
    ...Object.fromEntries(['toolName','name','description','runtime','repeatabilityMode','dependencies','permissions','runtimeArtifact','scriptFile','scriptSha256','createdAt']
      .map(key=>[key,saved.manifest[key]])),verifiedAt:verification.verifiedAt,
    ...(saved.manifest.parent?{parent:saved.manifest.parent}:{})};
  manifestValid(manifest,source);
  for(const key of ['toolName','name','description','runtime','repeatabilityMode','dependencies','permissions','runtimeArtifact'])
    must(JSON.stringify(saved.input[key])===JSON.stringify(saved.manifest[key]),'Saved proposal input differs from manifest');
  const manifestBytes=json(manifest);
  const approval={protocolVersion:'sirna-tool-approval/v1',proposalId:manifest.proposalId,version,approvedBy:approvedBy.trim(),approvedAt,
    approvedManifestSha256:hash(manifestBytes),verificationSha256};
  const bytes={'manifest.json':manifestBytes,'tool.mjs':source,'verification.json':Buffer.from(verificationBytes),'approval.json':json(approval)};
  const fileDigests=Object.fromEntries(PROTECTED.map(name=>[name,hash(bytes[name])]));
  const packageSha256=packageDigest(fileDigests);
  bytes['integrity.json']=json({protocolVersion:'sirna-approved-tool-integrity/v1',packageSha256,files:fileDigests});
  for(const name of ['manifest.json','approval.json','integrity.json'])must(bytes[name].length<=JSON_LIMIT,'Approved JSON exceeds byte limit');
  const root=rootDirectory(approvedRoot);const directoryName=`${toolId}-${version}`;const target=path.join(root,directoryName);
  const temporary=path.join(root,`.${directoryName}.${randomUUID()}.tmp`);
  try{
    must(!fs.existsSync(target),'Approved destination already exists');
    // lstat catches dangling symlinks too, which existsSync deliberately hides.
    try{fs.lstatSync(target);throw new Error('Approved destination already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
    fs.mkdirSync(temporary,{mode:0o700});
    for(const name of NAMES){
      const file=path.join(temporary,name);const fd=fs.openSync(file,'wx',0o600);
      try{fs.writeFileSync(fd,bytes[name]);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      if(process.platform!=='win32')fs.chmodSync(file,0o400);
    }
    if(process.platform!=='win32')fs.chmodSync(temporary,0o500);
    directory(root);
    try{fs.lstatSync(target);throw new Error('Approved destination already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
    fs.renameSync(temporary,target);
    return loadApprovedToolPackage(directoryName,{approvedRoot:root,expectedPackageSha256:packageSha256});
  }catch(error){throw context(error,target,temporary);}
}
