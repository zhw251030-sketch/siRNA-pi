import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ToolRegistry} from '../packages/capability-platform/tool-registry.mjs';
import {approvalFixture,writable} from './helpers/approval-fixture.mjs';
const catalog=await import('../packages/capability-platform/tool-catalog.mjs').catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND'&&error.message.includes('tool-catalog.mjs'))return {};throw error;
});
const service=await import('../packages/capability-platform/tool-approval-service.mjs').catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND'&&error.message.includes('tool-approval-service.mjs'))return {};throw error;
});
test('catalog provides explicit read and rebuild boundaries',()=>{
  assert.equal(typeof catalog.readActiveToolCatalog,'function');assert.equal(typeof catalog.writeActiveToolCatalog,'function');
});
test('catalog is anchored to registry selection and verified package, including every reference field',async t=>{
  const {root,id,database,onCleanup}=await approvalFixture(t);const approved=await service.approveRegisteredToolProposal(id,'operator',{root});
  const registry=new ToolRegistry(database,{readOnly:true});onCleanup(()=>registry.close());
  const result=catalog.readActiveToolCatalog({root,registry});
  assert.equal(result.protocolVersion,'sirna-tool-catalog/v1');assert.equal(result.tools.length,1);
  const version=approved.version;
  assert.deepEqual(result.tools[0],{toolId:version.toolId,toolName:version.toolName,version:'1.0.0',
    directoryName:version.packageDirectory,packageSha256:version.packageSha256,imageDigest:version.imageDigest});
});
test('catalog replacement with a different package digest is rejected and explicit rebuild repairs it',async t=>{
  const {root,id,database,catalogPath,onCleanup}=await approvalFixture(t);await service.approveRegisteredToolProposal(id,'operator',{root});
  const registry=new ToolRegistry(database,{readOnly:true});onCleanup(()=>registry.close());
  const value=JSON.parse(fs.readFileSync(catalogPath));value.tools[0].packageSha256='0'.repeat(64);writable(catalogPath,JSON.stringify(value));
  assert.throws(()=>catalog.readActiveToolCatalog({root,registry}),/catalog|registry|digest/i);
  const rebuilt=catalog.writeActiveToolCatalog({root,registry});
  assert.notEqual(rebuilt.tools[0].packageSha256,'0'.repeat(64));assert.deepEqual(catalog.readActiveToolCatalog({root,registry}),rebuilt);
});
for(const repair of ['explicit rebuild','repeat approval'])test(`${repair} repairs an oversized ordinary catalog without changing version or events`,async t=>{
  const {root,id,database,catalogPath,onCleanup}=await approvalFixture(t);
  const approved=await service.approveRegisteredToolProposal(id,'operator',{root});
  const registry=new ToolRegistry(database,{readOnly:true});onCleanup(()=>registry.close());
  const versions=registry.listToolVersions();const events=registry.listEvents(id);
  fs.truncateSync(catalogPath,1024*1024+1);
  assert.equal(fs.lstatSync(catalogPath).size,1024*1024+1);
  assert.throws(()=>catalog.readActiveToolCatalog({root,registry}),/bounded|size|1 MiB/i);
  let rebuilt;
  if(repair==='explicit rebuild')rebuilt=service.getRegisteredToolCatalog({root,rebuild:true});
  else{
    const repeated=await service.approveRegisteredToolProposal(id,'another operator',{root});
    assert.equal(repeated.alreadyApproved,true);assert.deepEqual(repeated.version,approved.version);
    rebuilt=repeated.catalog;
  }
  assert.deepEqual(rebuilt.tools,approved.catalog.tools);
  assert.ok(fs.statSync(catalogPath).size<=1024*1024);
  assert.deepEqual(catalog.readActiveToolCatalog({root,registry}),rebuilt);
  assert.deepEqual(registry.listToolVersions(),versions);assert.deepEqual(registry.listEvents(id),events);
});
for(const type of ['directory','hard link'])test(`catalog ${type} is rejected by both read and rebuild`,async t=>{
  const {root,id,database,catalogPath,onCleanup}=await approvalFixture(t);
  await service.approveRegisteredToolProposal(id,'operator',{root});
  const original=`${catalogPath}.original`;fs.renameSync(catalogPath,original);
  if(type==='directory')fs.mkdirSync(catalogPath);else fs.linkSync(original,catalogPath);
  const registry=new ToolRegistry(database,{readOnly:true});onCleanup(()=>registry.close());
  assert.throws(()=>catalog.readActiveToolCatalog({root,registry}),/link|ordinary/i);
  assert.throws(()=>catalog.writeActiveToolCatalog({root,registry}),/link|ordinary/i);
});
test('missing active catalog is an explicit error, not an empty tool list',async t=>{
  const {root,id,database,catalogPath,onCleanup}=await approvalFixture(t);await service.approveRegisteredToolProposal(id,'operator',{root});
  fs.renameSync(catalogPath,`${catalogPath}.original`);
  const registry=new ToolRegistry(database,{readOnly:true});onCleanup(()=>registry.close());
  assert.throws(()=>catalog.readActiveToolCatalog({root,registry}),/catalog|missing/i);
});
test('catalog read never creates a database or writes a catalog for an empty project',async t=>{
  const {root,catalogPath,onCleanup}=await approvalFixture(t,{validate:false});
  const registry=new ToolRegistry(path.join(root,'runtime/tool-registry/registry.sqlite'),{readOnly:true});onCleanup(()=>registry.close());
  assert.deepEqual(catalog.readActiveToolCatalog({root,registry}).tools,[]);
  assert.equal(fs.existsSync(catalogPath),false);
});
test('catalog cannot hide a tampered active package behind a correct registry entry',async t=>{
  const {root,id,database,approvedRoot,onCleanup}=await approvalFixture(t);const approved=await service.approveRegisteredToolProposal(id,'operator',{root});
  writable(path.join(approvedRoot,approved.version.packageDirectory,'verification.json'),'{}');
  const registry=new ToolRegistry(database,{readOnly:true});onCleanup(()=>registry.close());
  assert.throws(()=>catalog.readActiveToolCatalog({root,registry}),/digest|modified|hash/i);
  assert.throws(()=>catalog.writeActiveToolCatalog({root,registry}),/digest|modified|hash/i);
});
test('catalog file links are rejected by both read and rebuild',async t=>{
  const {root,id,database,catalogPath,onCleanup}=await approvalFixture(t);await service.approveRegisteredToolProposal(id,'operator',{root});
  const original=`${catalogPath}.original`;fs.renameSync(catalogPath,original);
  try{fs.symlinkSync(original,catalogPath,'file');}catch(error){if(process.platform==='win32'&&error.code==='EPERM'){t.skip('Windows file symlinks require privilege');return;}throw error;}
  const registry=new ToolRegistry(database,{readOnly:true});onCleanup(()=>registry.close());
  assert.throws(()=>catalog.readActiveToolCatalog({root,registry}),/link|ordinary/i);
  assert.throws(()=>catalog.writeActiveToolCatalog({root,registry}),/link|ordinary/i);
});
test('malformed catalog does not echo its contents and explicit rebuild restores it',async t=>{
  const {root,id,database,catalogPath,onCleanup}=await approvalFixture(t);await service.approveRegisteredToolProposal(id,'operator',{root});
  const registry=new ToolRegistry(database,{readOnly:true});onCleanup(()=>registry.close());
  writable(catalogPath,'{"SENSITIVE_SENTINEL"');
  assert.throws(()=>catalog.readActiveToolCatalog({root,registry}),error=>!error.message.includes('SENSITIVE_SENTINEL')&&/JSON/.test(error.message));
  assert.equal(catalog.writeActiveToolCatalog({root,registry}).tools.length,1);
});
test('catalog facade on an unused project is read-only and rejects rebuild without a registry',async t=>{
  const {root}=await approvalFixture(t,{validate:false});const empty=path.join(root,'empty');fs.mkdirSync(empty);
  assert.deepEqual(service.getRegisteredToolCatalog({root:empty}).tools,[]);
  assert.throws(()=>service.getRegisteredToolCatalog({root:empty,rebuild:true}),/registry/i);
  assert.deepEqual(fs.readdirSync(empty),[]);
});
