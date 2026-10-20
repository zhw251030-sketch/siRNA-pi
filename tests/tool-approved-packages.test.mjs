import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {submitRegisteredToolProposal} from '../packages/capability-platform/tool-lifecycle.mjs';
import {validateRegisteredToolProposal, getLatestToolValidationReport} from '../packages/capability-platform/tool-validation-service.mjs';
import {readToolProposal} from '../packages/capability-platform/tool-proposals.mjs';

const module = await import('../packages/capability-platform/tool-approved-packages.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const {publishApprovedToolPackage, loadApprovedToolPackage} = module;
const draft = JSON.parse(fs.readFileSync(new URL('../examples/04-tool-contract/proposal.draft.json', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');

function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sirna-approved-')));
  t.after(() => {
    function unlock(directory) {
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) unlock(file);
        else fs.chmodSync(file, 0o600);
      }
    }
    unlock(root); fs.rmSync(root, {recursive:true});
  });
  return root;
}

async function setup(t) {
  const root = temporary(t);
  const input = {...structuredClone(draft), script:'\ufeff// 界 exact CRLF\r\nthrow new Error("never execute candidate");\r\n',
    runtimeArtifact:{protocolVersion:'sirna-tool-runtime-artifact/v1',imageDigest:`sha256:${'b'.repeat(64)}`,
      command:['/usr/bin/node','/opt/tool/main.mjs'],platform:'linux/amd64',createdAt:'2026-10-20T00:00:00.000Z',buildSessionId:randomUUID()}};
  const submitted = submitRegisteredToolProposal(input, {root});
  const id = submitted.proposal.id;
  // Explicit runner fixture: exercises the real service/report persistence only;
  // no Docker, subprocess, candidate/baseline execution or model call occurs.
  const runner = {
    async checkSources() {return {runtimeArtifactVerified:true,executionPolicy:{route:'fixture-only'},
      syntaxChecks:['candidate','baseline'].map(target => ({target,passed:true}))};},
    async run({target, caseInput}) {
      const fails = target === 'baseline' && caseInput.sequence.startsWith('>');
      return {exitCode:fails?1:0,timedOut:false,cancelled:false,protocolValid:!fails,
        output:fails?null:{length:4,gcFraction:0.5},stdout:fails?'':'{"length":4,"gcFraction":0.5}',stderr:'',filesDigest:'a'.repeat(64)};
    },
  };
  await validateRegisteredToolProposal(id, {root, runner});
  const latest = getLatestToolValidationReport(id, {root});
  assert.equal(latest.report.passed, true);
  const saved = readToolProposal(id, {proposalsRoot:path.join(root,'runtime/tool-artifacts/proposals')});
  const approvedRoot = path.join(root,'approved'); fs.mkdirSync(approvedRoot, {mode:0o700});
  const options = {saved, verificationBytes:fs.readFileSync(latest.reportPath), verificationSha256:latest.reportSha256,
    toolId:randomUUID(), approvedBy:'hanwen (fixture)', approvedAt:'2026-10-20T12:00:00.000Z'};
  return {root, approvedRoot, options, latest};
}

test('publishes five immutable files preserving exact registered source and v3 report bytes', async t => {
  assert.equal(typeof publishApprovedToolPackage, 'function');
  assert.equal(typeof loadApprovedToolPackage, 'function');
  const {approvedRoot, options} = await setup(t);
  const before = fs.readdirSync(options.saved.artifactPath).map(name => [name,fs.readFileSync(path.join(options.saved.artifactPath,name))]);
  const result = publishApprovedToolPackage(options, {approvedRoot});
  assert.equal(result.directoryName, `${options.toolId}-1.0.0`);
  assert.equal(result.directory, path.join(approvedRoot,result.directoryName));
  assert.deepEqual(fs.readdirSync(result.directory).sort(), ['approval.json','integrity.json','manifest.json','tool.mjs','verification.json']);
  assert.deepEqual(fs.readFileSync(path.join(result.directory,'tool.mjs')), Buffer.from(options.saved.input.script));
  assert.deepEqual(fs.readFileSync(path.join(result.directory,'verification.json')), options.verificationBytes);
  assert.equal(result.manifest.id, options.toolId);
  assert.equal(result.manifest.proposalId, options.saved.manifest.id);
  assert.equal(result.manifest.version, '1.0.0');
  assert.equal(result.manifest.status, 'approved');
  assert.equal(result.approval.approvedAt, options.approvedAt);
  assert.equal(result.approval.approvedBy, options.approvedBy);
  assert.deepEqual(Object.keys(result.manifest).sort(), ['protocolVersion','id','proposalId','version','status','toolName','name','description',
    'runtime','repeatabilityMode','dependencies','permissions','runtimeArtifact','scriptFile','scriptSha256','createdAt','verifiedAt'].sort());
  const protectedNames = ['approval.json','manifest.json','tool.mjs','verification.json'];
  const expected = hash(protectedNames.map(name => `${name}\0${hash(fs.readFileSync(path.join(result.directory,name)))}\n`).join(''));
  assert.equal(result.packageSha256, expected);
  assert.notEqual(result.packageSha256, options.saved.artifactSha256);
  assert.deepEqual(loadApprovedToolPackage(result.directoryName, {approvedRoot,expectedPackageSha256:expected}), result);
  for (const [name,bytes] of before) assert.deepEqual(fs.readFileSync(path.join(options.saved.artifactPath,name)),bytes);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(result.directory).mode & 0o777, 0o500);
    for (const name of fs.readdirSync(result.directory)) assert.equal(fs.statSync(path.join(result.directory,name)).mode & 0o777, 0o400);
  }
});

function edit(result, name, bytes) {
  fs.chmodSync(result.directory,0o700);
  const file=path.join(result.directory,name);
  if(fs.existsSync(file))fs.chmodSync(file,0o600);
  fs.writeFileSync(file,bytes);
}
function rehash(result) {
  const files=Object.fromEntries(['approval.json','manifest.json','tool.mjs','verification.json'].map(name=>[name,hash(fs.readFileSync(path.join(result.directory,name)))]));
  edit(result,'integrity.json',`${JSON.stringify({protocolVersion:'sirna-approved-tool-integrity/v1',
    packageSha256:hash(Object.keys(files).sort().map(name=>`${name}\0${files[name]}\n`).join('')),files},null,2)}\n`);
}

for (const name of ['manifest.json','approval.json','verification.json','integrity.json','tool.mjs']) {
  test(`rejects modified ${name} against trusted package digest`,async t=>{
    const {approvedRoot,options}=await setup(t);const result=publishApprovedToolPackage(options,{approvedRoot});
    edit(result,name,Buffer.concat([fs.readFileSync(path.join(result.directory,name)),Buffer.from(' ')]));
    assert.throws(()=>loadApprovedToolPackage(result.directoryName,{approvedRoot,expectedPackageSha256:result.packageSha256}),/digest|integrity|modified|canonical/i);
  });
}
test('rejects extra file, oversized source, and malformed UTF8/JSON without exposing content',async t=>{
  const {approvedRoot,options}=await setup(t);const result=publishApprovedToolPackage(options,{approvedRoot});
  edit(result,'baseline.mjs','not published');
  assert.throws(()=>loadApprovedToolPackage(result.directoryName,{approvedRoot}),/exact|file set/i);
  fs.unlinkSync(path.join(result.directory,'baseline.mjs'));
  edit(result,'tool.mjs',Buffer.alloc(200001));
  assert.throws(()=>loadApprovedToolPackage(result.directoryName,{approvedRoot}),/limit|bounded/i);
  edit(result,'tool.mjs',Buffer.from(options.saved.input.script));
  for(const bytes of [Buffer.from('{"secret":"do-not-echo"'),Buffer.from([0xff])]){
    edit(result,'manifest.json',bytes);
    assert.throws(()=>loadApprovedToolPackage(result.directoryName,{approvedRoot}),error=>/UTF-8 JSON/.test(error.message)&&!error.message.includes('do-not-echo'));
  }
});

for(const [name,change] of [
  ['report digest',o=>{o.verificationSha256='a'.repeat(64);}],
  ['report proposal',o=>{const r=JSON.parse(o.verificationBytes);r.proposalId=randomUUID();o.verificationBytes=Buffer.from(JSON.stringify(r));o.verificationSha256=hash(o.verificationBytes);}],
  ['report validation id',o=>{const r=JSON.parse(o.verificationBytes);r.validationId='bad';o.verificationBytes=Buffer.from(JSON.stringify(r));o.verificationSha256=hash(o.verificationBytes);}],
  ['report material',o=>{const r=JSON.parse(o.verificationBytes);r.artifactSha256='a'.repeat(64);o.verificationBytes=Buffer.from(JSON.stringify(r));o.verificationSha256=hash(o.verificationBytes);}],
  ['failed report',o=>{const r=JSON.parse(o.verificationBytes);r.passed=false;o.verificationBytes=Buffer.from(JSON.stringify(r));o.verificationSha256=hash(o.verificationBytes);}],
  ['report timestamp',o=>{const r=JSON.parse(o.verificationBytes);r.verifiedAt='2026-10-20';o.verificationBytes=Buffer.from(JSON.stringify(r));o.verificationSha256=hash(o.verificationBytes);}],
  ['source digest',o=>{o.saved.input.script+='changed';}],
  ['lossy source',o=>{o.saved.input.script+='\ud800';}],
  ['same identity',o=>{o.toolId=o.saved.manifest.id;}],
  ['empty actor',o=>{o.approvedBy=' ';}],
  ['overlong actor',o=>{o.approvedBy='x'.repeat(121);}],
  ['noncanonical time',o=>{o.approvedAt='2026-10-20';}],
  ['unsupported runtime',o=>{o.saved.input.runtime='python';}],
])test(`refuses ${name} before publishing`,async t=>{
  assert.equal(typeof publishApprovedToolPackage,'function');
  const {approvedRoot,options}=await setup(t);change(options);
  assert.throws(()=>publishApprovedToolPackage(options,{approvedRoot}));
  assert.deepEqual(fs.readdirSync(approvedRoot),[]);
});

test('does not overwrite existing destination and attaches retained paths on filesystem failure',async t=>{
  const {approvedRoot,options}=await setup(t);const result=publishApprovedToolPackage(options,{approvedRoot});
  assert.throws(()=>publishApprovedToolPackage(options,{approvedRoot}),error=>error.packagePath===result.directory&&typeof error.temporaryPath==='string');
  assert.equal(loadApprovedToolPackage(result.directoryName,{approvedRoot}).packageSha256,result.packageSha256);
  const second={...options,toolId:randomUUID()};const original=fs.renameSync;
  fs.renameSync=function(){throw new Error('injected rename failure');};
  try{assert.throws(()=>publishApprovedToolPackage(second,{approvedRoot}),error=>
    /injected rename/.test(error.message)&&fs.existsSync(error.temporaryPath)&&error.packagePath===path.join(approvedRoot,`${second.toolId}-1.0.0`));}
  finally{fs.renameSync=original;}
});

test('requires existing real root and valid basename and expected SHA',async t=>{
  const {root,approvedRoot,options}=await setup(t);
  assert.throws(()=>publishApprovedToolPackage(options,{approvedRoot:path.join(root,'missing','approved')}));
  assert.equal(fs.existsSync(path.join(root,'missing')),false);
  const result=publishApprovedToolPackage(options,{approvedRoot});
  for(const directoryName of ['../escape',`${options.toolId}-2.0.0`,result.directory,'invalid'])assert.throws(()=>loadApprovedToolPackage(directoryName,{approvedRoot}));
  for(const expectedPackageSha256 of ['invalid','0'.repeat(64)])assert.throws(()=>loadApprovedToolPackage(result.directoryName,{approvedRoot,expectedPackageSha256}));
});

for(const [name,file,mutate] of [
  ['manifest identity','manifest.json',m=>{m.id=randomUUID();}],
  ['manifest draft field','manifest.json',m=>{m.smokeInput={x:1};}],
  ['approval proposal','approval.json',m=>{m.proposalId=randomUUID();}],
  ['approval time','approval.json',m=>{m.approvedAt='bad';}],
  ['report conclusion','verification.json',m=>{m.passed=false;}],
  ['report timestamp','verification.json',m=>{m.verifiedAt='bad';}],
])test(`rejects cross-file ${name} even with recomputed integrity`,async t=>{
  const {approvedRoot,options}=await setup(t);const result=publishApprovedToolPackage(options,{approvedRoot});
  const value=JSON.parse(fs.readFileSync(path.join(result.directory,file)));mutate(value);edit(result,file,JSON.stringify(value));rehash(result);
  assert.throws(()=>loadApprovedToolPackage(result.directoryName,{approvedRoot}));
});

test('rejects hard linked package files',async t=>{
  const {root,approvedRoot,options}=await setup(t);const result=publishApprovedToolPackage(options,{approvedRoot});
  fs.linkSync(path.join(result.directory,'tool.mjs'),path.join(root,'linked-source'));
  assert.throws(()=>loadApprovedToolPackage(result.directoryName,{approvedRoot}),/link|ordinary|regular/i);
});

test('rejects symlinked package directory and approved root',async t=>{
  const {root,approvedRoot,options}=await setup(t);const result=publishApprovedToolPackage(options,{approvedRoot});
  const rootLink=path.join(root,'root-link');
  try{fs.symlinkSync(approvedRoot,rootLink,process.platform==='win32'?'junction':'dir');}
  catch(error){if(error.code==='EPERM'){t.skip('Symlink creation unavailable');return;}throw error;}
  assert.throws(()=>loadApprovedToolPackage(result.directoryName,{approvedRoot:rootLink}),/link|real/i);
  const otherId=randomUUID();fs.symlinkSync(result.directory,path.join(approvedRoot,`${otherId}-1.0.0`),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>loadApprovedToolPackage(`${otherId}-1.0.0`,{approvedRoot}),/link|real/i);
});
test('rejects symlinked source file',async t=>{
  const {approvedRoot,options}=await setup(t);const result=publishApprovedToolPackage(options,{approvedRoot});
  fs.chmodSync(result.directory,0o700);fs.unlinkSync(path.join(result.directory,'tool.mjs'));
  try{fs.symlinkSync(path.join(options.saved.artifactPath,'tool.mjs'),path.join(result.directory,'tool.mjs'));}
  catch(error){if(error.code==='EPERM'){t.skip('File symlink creation unavailable on this Windows host');return;}throw error;}
  assert.throws(()=>loadApprovedToolPackage(result.directoryName,{approvedRoot}),/link|ordinary|regular/i);
});

test('rejects reserialized integrity metadata even when its values and trusted digest are unchanged',async t=>{
  const {approvedRoot,options}=await setup(t);const result=publishApprovedToolPackage(options,{approvedRoot});
  const integrity=JSON.parse(fs.readFileSync(path.join(result.directory,'integrity.json')));
  edit(result,'integrity.json',Buffer.from(`${JSON.stringify({files:integrity.files,packageSha256:integrity.packageSha256,protocolVersion:integrity.protocolVersion},null,2)}\n`));
  assert.throws(()=>loadApprovedToolPackage(result.directoryName,{approvedRoot,expectedPackageSha256:result.packageSha256}),/canonical|integrity/i);
});

test('rejects non-string manifest identifiers even if JSON arrays coerce to UUID strings',async t=>{
  const {approvedRoot,options}=await setup(t);const result=publishApprovedToolPackage(options,{approvedRoot});
  const manifest=JSON.parse(fs.readFileSync(path.join(result.directory,'manifest.json')));manifest.id=[manifest.id];
  const manifestBytes=Buffer.from(JSON.stringify(manifest));edit(result,'manifest.json',manifestBytes);
  const approval=JSON.parse(fs.readFileSync(path.join(result.directory,'approval.json')));approval.approvedManifestSha256=hash(manifestBytes);
  edit(result,'approval.json',JSON.stringify(approval));rehash(result);
  assert.throws(()=>loadApprovedToolPackage(result.directoryName,{approvedRoot}),/identity/i);
});

test('detects earlier file changing while later package bytes are being read',async t=>{
  const {approvedRoot,options}=await setup(t);const result=publishApprovedToolPackage(options,{approvedRoot});
  const original=fs.readSync;let changed=false;
  fs.readSync=function(fd,buffer,offset,length,position){
    const count=original.call(this,fd,buffer,offset,length,position);
    if(!changed&&count&&buffer.subarray(offset,offset+count).toString('utf8').includes('never execute candidate')){
      changed=true;const file=path.join(result.directory,'approval.json');fs.chmodSync(file,0o600);fs.utimesSync(file,new Date(),new Date('2020-01-01'));
    }
    return count;
  };
  try{assert.throws(()=>loadApprovedToolPackage(result.directoryName,{approvedRoot}),/changed/i);}
  finally{fs.readSync=original;}
  assert.equal(changed,true);
});

for(const [name,limit]of [['manifest.json',1024*1024],['approval.json',1024*1024],['integrity.json',1024*1024],['verification.json',16*1024*1024]]){
  test(`rejects ${name} above its bounded read limit`,async t=>{
    const {approvedRoot,options}=await setup(t);const result=publishApprovedToolPackage(options,{approvedRoot});
    fs.chmodSync(path.join(result.directory,name),0o600);
    fs.truncateSync(path.join(result.directory,name),limit+1);
    assert.throws(()=>loadApprovedToolPackage(result.directoryName,{approvedRoot}),/bounded|limit/i);
  });
}

test('rejects an accessor or Proxy in the saved snapshot without invoking its getter',async t=>{
  const {approvedRoot,options}=await setup(t);let invoked=false;
  const saved={...options.saved};Object.defineProperty(saved,'input',{enumerable:true,get(){invoked=true;return options.saved.input;}});
  assert.throws(()=>publishApprovedToolPackage({...options,saved},{approvedRoot}),/data properties/);
  assert.equal(invoked,false);
  assert.throws(()=>publishApprovedToolPackage({...options,saved:new Proxy(options.saved,{get(){invoked=true;}})},{approvedRoot}),/plain JSON/);
  assert.equal(invoked,false);assert.deepEqual(fs.readdirSync(approvedRoot),[]);
});
