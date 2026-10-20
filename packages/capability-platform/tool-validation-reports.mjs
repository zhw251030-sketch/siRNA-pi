// Private report files are immutable snapshots indexed by the registry. Neither
// report paths from SQLite nor malformed JSON are trusted as arbitrary input.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const limit=16*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function must(ok,message){if(!ok)throw new Error(message);}
function directory(target,create=false){
  if(create&&!fs.existsSync(target))fs.mkdirSync(target,{mode:0o700});
  const stat=fs.lstatSync(target);
  must(stat.isDirectory()&&!stat.isSymbolicLink()&&fs.realpathSync(target)===target,'Report directory is linked or redirected');
}
function location(root,proposalId,validationId,create=false){
  must(typeof root==='string'&&path.isAbsolute(root),'Explicit report project root required');
  must(typeof proposalId==='string'&&uuid.test(proposalId)&&typeof validationId==='string'&&uuid.test(validationId),'Invalid report identity');
  root=path.resolve(root);directory(root);
  let target=root;
  for(const part of ['runtime','tool-artifacts','validations',proposalId]){target=path.join(target,part);directory(target,create);}
  return path.join(target,`${validationId}.json`);
}
function write(file,value){
  const bytes=Buffer.from(`${JSON.stringify(value,null,2)}\n`);
  must(bytes.length<=limit,'Validation report exceeds the 16MiB limit');
  const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(process.platform!=='win32')fs.chmodSync(file,0o400);
  return {reportPath:file,reportSha256:hash(bytes)};
}
export function writeValidationReport(report,{root}){
  return write(location(root,report.proposalId,report.validationId,true),report);
}
export function writeValidationFailure(proposalId,validationId,error,{root}){
  const file=location(root,proposalId,validationId,true).replace(/\.json$/,'.failure.json');
  write(file,{proposalId,validationId,recordedAt:new Date().toISOString(),completed:false,
    error:error instanceof Error?error.message:'Validation infrastructure failed',
    ...(error.containerId?{containerId:error.containerId}:{}),...(error.reportPath?{unregisteredReportPath:error.reportPath}:{})});
  return file;
}
export function readValidationReportBytes(file){
  const before=fs.lstatSync(file,{bigint:true});
  must(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size<=BigInt(limit),'Report must be a bounded ordinary file with one link');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{
    const opened=fs.fstatSync(fd,{bigint:true});
    const buffer=Buffer.alloc(Number(before.size)+1);let received=0;
    while(received<buffer.length){const n=fs.readSync(fd,buffer,received,buffer.length-received,null);if(!n)break;received+=n;}
    const bytes=buffer.subarray(0,received);
    const after=fs.fstatSync(fd,{bigint:true});const named=fs.lstatSync(file,{bigint:true});
    for(const stat of [opened,after,named])for(const key of ['dev','ino','size','mtimeNs','ctimeNs','nlink'])must(stat[key]===before[key],'Report changed while reading');
    must(bytes.length===Number(before.size)&&bytes.length<=limit,'Report size changed or exceeds size limit');return bytes;
  }finally{fs.closeSync(fd);}
}
export function readLatestValidationReport(proposalId,{root,registry}){
  const proposal=registry.getProposal(proposalId);must(proposal,'Unknown proposal');
  const index=registry.latestValidation(proposalId);
  if(!index){must(!proposal.latestValidationId&&!['verified','verification_failed','approved'].includes(proposal.state),'Validation state has no matching report');return undefined;}
  const expected=location(root,proposalId,index.id);
  must(index.proposalId===proposalId&&index.reportPath===expected,'Registered report path or identity is outside its fixed root');
  const bytes=readValidationReportBytes(expected);must(hash(bytes)===index.reportSha256,'Validation report digest mismatch; report was modified');
  let report;try{report=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('Validation report must be valid UTF-8 JSON');}
  must(report&&report.protocolVersion==='sirna-tool-validation/v3'&&report.validationId===index.id&&report.proposalId===proposalId&&
    report.passed===index.passed&&report.artifactSha256===proposal.artifactSha256,'Validation report identity or conclusion differs from registration');
  must(proposal.latestValidationId===index.id&&(index.passed?['verified','approved'].includes(proposal.state):proposal.state==='verification_failed'),'Proposal state differs from latest validation');
  return {...index,report};
}
