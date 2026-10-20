// Approved packages are evidence, never host imports. Docker is explicit.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual,types} from 'node:util';
import {getRegisteredToolCatalog,getRegisteredToolVersion} from './tool-approval-service.mjs';
import {readToolProposal} from './tool-proposals.mjs';
import {resolveToolLearningPaths} from './tool-lifecycle.mjs';
import {startToolRunAudit,validateToolTaskContext} from './tool-run-audit.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function must(ok,message){if(!ok)throw new Error(message);}
function plain(value){return value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value)&&[null,Object.prototype].includes(Object.getPrototypeOf(value));}
function copy(value,ancestors=new Set()){
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
  must(value&&typeof value==='object'&&!types.isProxy(value)&&!ancestors.has(value),'Expected finite plain JSON data');
  const array=Array.isArray(value);must(array?Object.getPrototypeOf(value)===Array.prototype:plain(value),'Expected plain JSON object');
  const keys=Reflect.ownKeys(value);must(!array||keys.length===value.length+1,'Expected dense JSON array');ancestors.add(value);
  const result=array?[]:{};
  for(const key of keys){
    if(array&&key==='length')continue;
    const prop=Object.getOwnPropertyDescriptor(value,key);
    must(typeof key==='string'&&prop.enumerable&&Object.hasOwn(prop,'value')&&(!array||/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<value.length),'Expected JSON data properties');
    Object.defineProperty(result,key,{value:copy(prop.value,ancestors),enumerable:true,writable:true,configurable:true});
  }
  ancestors.delete(value);return result;
}
export function validateApprovedToolArguments(args){
  const safe=copy(args);must(plain(safe),'Arguments must be {input: <JSON object>}');
  must(!Object.hasOwn(safe,'inputFiles')&&!Object.hasOwn(safe,'outputFiles'),'File transfers are not supported');
  must(Object.keys(safe).length===1&&Object.hasOwn(safe,'input')&&plain(safe.input),'Arguments must contain only a plain input object');
  must(!Object.hasOwn(safe.input,'protocolVersion'),'Business input must not be a protocol envelope');
  must(Buffer.byteLength(JSON.stringify(safe.input))<=65536,'Business input exceeds 65536 bytes');return safe.input;
}
function binding(entry){return Object.fromEntries(['toolId','toolName','version','directoryName','packageSha256','imageDigest'].map(key=>[key,entry[key]]));}
function readBound(root,expected){
  const catalog=getRegisteredToolCatalog({root});const current=catalog.tools.find(entry=>entry.toolName===expected.toolName);
  must(current&&isDeepStrictEqual(binding(current),expected),'Approved tool descriptor is stale');
  const registered=getRegisteredToolVersion(expected.toolName,expected.version,{root});const version=registered.version;
  must(version.toolId===expected.toolId&&version.packageSha256===expected.packageSha256&&version.imageDigest===expected.imageDigest,'Approved tool version changed');
  const saved=readToolProposal(version.proposalId,{proposalsRoot:resolveToolLearningPaths(root).proposalsRoot,expectedArtifactSha256:registered.package.verification.artifactSha256});
  return {registered,saved};
}
// Error messages can contain business logs. Retain only bounded classifications.
function diagnostic(error){
  return {name:typeof error?.name==='string'?error.name.slice(0,80):'Error',code:typeof error?.code==='string'?error.code.slice(0,80):null};
}
function createTool(root,runner,expected,manifest,taskContext){
  return {name:expected.toolName,label:manifest.name,description:manifest.description,
    parameters:{type:'object',properties:{input:{type:'object',additionalProperties:true}},required:['input'],additionalProperties:false},executionMode:'sequential',
    async execute(toolCallId,args,signal){
      const business=validateApprovedToolArguments(args);must(typeof toolCallId==='string'&&UUID.test(toolCallId),'toolCallId must be a UUID v4');
      must(!signal?.aborted,'Approved tool call cancelled before execution');must(runner&&typeof runner.run==='function','An explicit execution runner is required');
      const {registered,saved}=readBound(root,expected);const version=registered.version;
      const audit=startToolRunAudit({root,toolCallId,taskContext,inputSha256:hash(JSON.stringify(business)),identity:{toolName:expected.toolName,toolId:expected.toolId,
        proposalId:version.proposalId,toolVersion:version.version,packageSha256:expected.packageSha256,imageDigest:expected.imageDigest}});
      let result=null,operationError=null,output=null,success=false;
      try{
        must(!signal?.aborted,'Approved tool call cancelled before execution');
        result=await runner.run({target:'candidate',manifest:saved.manifest,input:saved.input,caseInput:business,toolCallId});
        readBound(root,expected);
        output=copy(result.output);
        success=result.exitCode===0&&result.timedOut===false&&result.cancelled===false&&!signal?.aborted&&result.outputLimitExceeded===false&&
          result.protocolValid===true&&plain(output)&&SHA.test(result.filesDigest);
      }catch(error){operationError=error;}
      const containerId=result?.containerId??operationError?.containerId;
      const executionEvidence=typeof containerId==='string'?{containerId:containerId.slice(0,256),imageDigest:expected.imageDigest,
        actualPolicy:result?.actualPolicy?copy(result.actualPolicy):null}:null;
      const record={exitCode:Number.isInteger(result?.exitCode)?result.exitCode:null,timedOut:result?.timedOut===true,
        cancelled:signal?.aborted===true||result?.cancelled===true,protocolValid:result?.protocolValid===true,
        filesDigest:typeof result?.filesDigest==='string'&&SHA.test(result.filesDigest)?result.filesDigest:null,
        stdoutSha256:typeof result?.stdout==='string'?hash(result.stdout):null,stderrSha256:typeof result?.stderr==='string'?hash(result.stderr):null,
        outputSha256:plain(output)?hash(JSON.stringify(output)):null,success,
        error:success?null:operationError?'Approved tool operation failed':'Approved tool execution was unsuccessful',
        operationError:operationError?diagnostic(operationError):null,cleanupError:operationError?.cleanupError?diagnostic(operationError.cleanupError):null,
        cleanupConfirmed:operationError?.cleanupError?false:result?true:null,executionEvidence};
      audit.finish(record);
      if(!success)throw Object.assign(new Error(record.error),{auditPath:audit.auditPath});
      return {content:[{type:'text',text:JSON.stringify(output)}],details:{output,workerFiles:[],auditPath:audit.auditPath,packageSha256:expected.packageSha256,approvedTool:true}};
    }};
}
export function discoverApprovedTools({root,runner,taskContext}={}){
  taskContext=validateToolTaskContext(taskContext);
  const tools=[],packages=[],rejected=[];
  try{
    const catalog=getRegisteredToolCatalog({root});
    for(const entry of catalog.tools){
      const expected=binding(entry);const {registered}=readBound(root,expected);
      tools.push(createTool(root,runner,expected,registered.package.manifest,taskContext));packages.push(registered.package);
    }
  }catch(error){return {tools:[],packages:[],rejected:[{error:typeof error.message==='string'?error.message.slice(0,512):'Approved tool discovery failed'}]};}
  return {tools,packages,rejected};
}
