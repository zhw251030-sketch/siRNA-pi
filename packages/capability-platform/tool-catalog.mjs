// A catalog is a checked projection of the registry, not an authority to execute.
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {resolveToolLearningPaths,readRegisteredToolVersion} from './tool-lifecycle.mjs';

const limit=1024*1024;
function must(value,message){if(!value)throw new Error(message);}
function stat(file){try{return fs.lstatSync(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return undefined;throw error;}}
function regular(file,info){must(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1n&&fs.realpathSync(file)===file,'Catalog must be an ordinary file without links');}
function stable(a,b){for(const key of ['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'])must(a[key]===b[key],'Catalog changed while reading');}
function toolsFromRegistry(root,registry){
  const versions=registry?registry.listActiveTools():[];
  return versions.map(version=>{
    readRegisteredToolVersion(version,{root,registry});
    return {toolId:version.toolId,toolName:version.toolName,version:version.version,directoryName:version.packageDirectory,
      packageSha256:version.packageSha256,imageDigest:version.imageDigest};
  }).sort((a,b)=>a.toolName<b.toolName?-1:a.toolName>b.toolName?1:0);
}
function read(file){
  const before=stat(file);if(!before)return undefined;regular(file,before);
  must(before.size<=BigInt(limit),'Catalog exceeds 1 MiB');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{
    stable(before,fs.fstatSync(fd,{bigint:true}));
    const bytes=Buffer.alloc(Number(before.size)+1);let n=0;
    while(n<bytes.length){const got=fs.readSync(fd,bytes,n,bytes.length-n,null);if(!got)break;n+=got;}
    must(n===Number(before.size),'Catalog size changed');
    stable(before,fs.fstatSync(fd,{bigint:true}));stable(before,fs.lstatSync(file,{bigint:true}));
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,n)));}
    catch{throw new Error('Catalog must be valid UTF-8 JSON');}
  }finally{fs.closeSync(fd);}
}
export function readActiveToolCatalog({root,registry}){
  const {catalogPath}=resolveToolLearningPaths(root);const tools=toolsFromRegistry(root,registry);
  const result=read(catalogPath);
  if(result===undefined){must(tools.length===0,'Active tool catalog is missing; explicitly rebuild it');return {protocolVersion:'sirna-tool-catalog/v1',generatedAt:null,tools:[]};}
  must(result&&Object.keys(result).sort().join(',')==='generatedAt,protocolVersion,tools'&&result.protocolVersion==='sirna-tool-catalog/v1'&&
    typeof result.generatedAt==='string'&&Number.isFinite(Date.parse(result.generatedAt))&&new Date(result.generatedAt).toISOString()===result.generatedAt&&
    isDeepStrictEqual(result.tools,tools),'Catalog differs from the current registry or has an invalid contract');
  return result;
}
export function writeActiveToolCatalog({root,registry}){
  must(registry,'Explicit registry required to rebuild catalog');
  const {catalogPath}=resolveToolLearningPaths(root);const tools=toolsFromRegistry(root,registry);
  const previous=stat(catalogPath);if(previous)regular(catalogPath,previous);
  const catalog={protocolVersion:'sirna-tool-catalog/v1',generatedAt:new Date().toISOString(),tools};
  const bytes=Buffer.from(`${JSON.stringify(catalog,null,2)}\n`);must(bytes.length<=limit,'Catalog exceeds 1 MiB');
  const temporary=path.join(path.dirname(catalogPath),`.catalog.${randomUUID()}.tmp`);
  const fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  // Recheck the fixed destination and current DB projection before publication.
  const current=stat(catalogPath);if(current)regular(catalogPath,current);
  must(isDeepStrictEqual(tools,toolsFromRegistry(root,registry)),'Registry changed while rebuilding catalog');
  try{fs.renameSync(temporary,catalogPath);}catch(error){error.temporaryPath=temporary;throw error;}
  return readActiveToolCatalog({root,registry});
}
