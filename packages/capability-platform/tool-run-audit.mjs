// Durable, exclusive execution evidence. Business data is represented by hashes.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function must(ok,message){if(!ok)throw new Error(message);}
function directory(file){
  const stat=fs.lstatSync(file,{bigint:true});
  must(stat.isDirectory()&&!stat.isSymbolicLink()&&fs.realpathSync(file)===file,'Audit directory must be real and without links');return stat;
}
function ordinary(file){
  const stat=fs.lstatSync(file,{bigint:true});
  must(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n&&fs.realpathSync(file)===file,'Audit file must be ordinary with one link');return stat;
}
function stable(before,after){must(['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].every(key=>before[key]===after[key]),'Audit request changed');}
function write(file,bytes){
  const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW??0),0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.fchmodSync(fd,0o400);}finally{fs.closeSync(fd);}
  ordinary(file);
}
function bytes(value){return Buffer.from(`${JSON.stringify(value,null,2)}\n`);}

export function validateToolTaskContext(value){
  if(value===undefined)return undefined;
  const keys=['taskId','executionSessionId','sandboxId','agentTurnId','agentRunId'];
  must(value&&typeof value==='object'&&!types.isProxy(value)&&[null,Object.prototype].includes(Object.getPrototypeOf(value)),'Invalid tool task context');
  must(Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)),'Invalid tool task context fields');
  const safe={};
  for(const key of keys){const field=Object.getOwnPropertyDescriptor(value,key);must(field.enumerable&&Object.hasOwn(field,'value')&&typeof field.value==='string','Invalid tool task context field');safe[key]=field.value;}
  must(UUID.test(safe.taskId)&&UUID.test(safe.executionSessionId)&&UUID.test(safe.agentTurnId)&&/^[a-f0-9]{64}$/.test(safe.sandboxId)&&/^[A-Za-z0-9_-]{1,256}$/.test(safe.agentRunId),'Invalid tool task context identity');
  return Object.freeze(safe);
}

export function startToolRunAudit({root,identity,toolCallId,inputSha256,taskContext}={}){
  taskContext=validateToolTaskContext(taskContext);
  must(typeof root==='string'&&path.isAbsolute(root),'Audit requires an absolute root');root=path.resolve(root);directory(root);
  must(identity&&/^[a-z][a-z0-9_]{0,63}$/.test(identity.toolName),'Invalid audit tool name');
  must(UUID.test(toolCallId)&&UUID.test(identity.toolId)&&UUID.test(identity.proposalId),'Invalid audit UUID v4 identity');
  must(identity.toolVersion==='1.0.0'&&SHA.test(identity.packageSha256)&&SHA.test(inputSha256)&&/^sha256:[a-f0-9]{64}$/.test(identity.imageDigest),'Invalid audit version or digest');
  const parents=[root,path.join(root,'runtime'),path.join(root,'runtime/approved-tool-runs'),path.join(root,'runtime/approved-tool-runs',identity.toolName)];
  const snapshots=[];
  for(const dir of parents){
    try{directory(dir);}catch(error){if(error.code!=='ENOENT')throw error;fs.mkdirSync(dir,{mode:0o700});}
    snapshots.push([dir,directory(dir)]);
  }
  const runId=toolCallId;const runDirectory=path.join(parents.at(-1),runId);fs.mkdirSync(runDirectory,{mode:0o700});snapshots.push([runDirectory,directory(runDirectory)]);
  function checkDirectories(){for(const [dir,before]of snapshots){const after=directory(dir);must(before.dev===after.dev&&before.ino===after.ino,'Audit directory changed');}}
  const request={protocolVersion:'sirna-approved-tool-audit/v1',runId,toolCallId,toolName:identity.toolName,proposalId:identity.proposalId,
    toolVersion:identity.toolVersion,toolId:identity.toolId,packageSha256:identity.packageSha256,imageDigest:identity.imageDigest,inputSha256,startedAt:new Date().toISOString()};
  if(taskContext!==undefined)request.taskContext=taskContext;
  const requestPath=path.join(runDirectory,'request.json');const auditPath=path.join(runDirectory,'audit.json');
  checkDirectories();const requestBytes=bytes(request);write(requestPath,requestBytes);const requestStat=ordinary(requestPath);
  let finished=false;
  return {requestPath,auditPath,finish(fields){
    must(!finished,'Audit already finished');checkDirectories();
    const current=ordinary(requestPath);stable(requestStat,current);
    const fd=fs.openSync(requestPath,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    try{stable(current,fs.fstatSync(fd,{bigint:true}));must(hash(fs.readFileSync(fd))===hash(requestBytes),'Audit request changed');stable(current,fs.fstatSync(fd,{bigint:true}));}
    finally{fs.closeSync(fd);}
    stable(current,ordinary(requestPath));
    const allowed=['exitCode','timedOut','cancelled','protocolValid','filesDigest','stdoutSha256','stderrSha256','outputSha256','success','error','operationError','cleanupError','cleanupConfirmed','executionEvidence'];
    must(fields&&Object.keys(fields).every(key=>allowed.includes(key))&&typeof fields.success==='boolean','Invalid terminal audit fields');
    const audit={...request,finishedAt:new Date().toISOString(),exitCode:null,timedOut:false,cancelled:false,protocolValid:false,
      filesDigest:null,stdoutSha256:null,stderrSha256:null,outputSha256:null,success:false,error:null,operationError:null,cleanupError:null,cleanupConfirmed:null,executionEvidence:null,...fields};
    const content=bytes(audit);must(content.length<=16384,'Audit evidence exceeds bound');
    // Publish only flushed bytes. A failed fsync leaves a private staging file,
    // never an apparently complete success. link is exclusive (unlike rename).
    const staging=path.join(runDirectory,`.audit.${randomUUID()}.tmp`);
    checkDirectories();write(staging,content);checkDirectories();
    fs.linkSync(staging,auditPath);fs.unlinkSync(staging);ordinary(auditPath);finished=true;return audit;
  }};
}
