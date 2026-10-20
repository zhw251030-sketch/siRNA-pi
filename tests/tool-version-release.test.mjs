import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {approvalFixture,writable} from './helpers/approval-fixture.mjs';
import {submitRegisteredToolProposal,getRegisteredToolProposal,readRegisteredToolVersion,assertRegisteredToolParent} from '../packages/capability-platform/tool-lifecycle.mjs';
import {validateRegisteredToolProposal} from '../packages/capability-platform/tool-validation-service.mjs';
import * as service from '../packages/capability-platform/tool-approval-service.mjs';
import {ToolRegistry} from '../packages/capability-platform/tool-registry.mjs';
import {startToolRunAudit} from '../packages/capability-platform/tool-run-audit.mjs';
import {discoverApprovedTools} from '../packages/capability-platform/tool-approved-execution.mjs';
import {spawnSync} from 'node:child_process';
import {readLatestValidationReport} from '../packages/capability-platform/tool-validation-reports.mjs';
import {fileURLToPath} from 'node:url';
import {createToolProposal} from '../packages/capability-platform/tool-proposals.mjs';
import {writeValidationReport} from '../packages/capability-platform/tool-validation-reports.mjs';
import {publishApprovedToolPackage} from '../packages/capability-platform/tool-approved-packages.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const actor='fixture actor';
async function releaseFixture(t){
  const f=await approvalFixture(t);
  const parent=service.approveRegisteredToolProposal(f.id,actor,{root:f.root});
  return {...f,parent};
}
async function verifiedChild(f,parentVersion='1.0.0'){
  const parent=service.getRegisteredToolVersion(f.input.toolName,parentVersion,{root:f.root});
  const source=fs.readFileSync(path.join(parent.package.directory,'tool.mjs'),'utf8');
  const input={...structuredClone(f.input),parent:{toolName:f.input.toolName,version:parentVersion},
    script:source+'\n// new release\n',baseline:{runtime:'node',script:source}};
  const saved=submitRegisteredToolProposal(input,{root:f.root});
  await validateRegisteredToolProposal(saved.proposal.id,{root:f.root,runner:{
    async checkSources(){return {runtimeArtifactVerified:true,executionPolicy:{route:'fixture-boundary'},
      syntaxChecks:['candidate','baseline'].map(target=>({target,passed:true,command:'node --check',exitCode:0,timedOut:false,stdout:'',stderr:''}))};},
    async run(request){const output=request.target==='baseline'?{}:input.benchmarkCases.find(c=>JSON.stringify(c.input)===JSON.stringify(request.caseInput))?.expectedOutput??input.testCases[0].expectedOutput;
      return {exitCode:0,timedOut:false,cancelled:false,protocolValid:true,output,stdout:JSON.stringify(output),stderr:'',
        filesDigest:hash(''),imageDigest:request.manifest.runtimeArtifact.imageDigest};}
  }});
  return {id:saved.proposal.id,input};
}

test('child release retains both complete evidences, same tool identity, and supports another child',async t=>{
  const f=await releaseFixture(t);
  const oldBytes=Object.fromEntries(fs.readdirSync(f.parent.version.packageDirectory?path.join(f.approvedRoot,f.parent.version.packageDirectory):'').map(name=>[name,fs.readFileSync(path.join(f.approvedRoot,f.parent.version.packageDirectory,name))]));
  const c=await verifiedChild(f);
  const child=service.approveRegisteredToolProposal(c.id,actor,{root:f.root});
  assert.equal(child.version.version,'1.0.1');assert.equal(child.version.toolId,f.parent.version.toolId);
  assert.equal(child.version.parentToolId,f.parent.version.toolId);assert.equal(child.version.parentVersion,'1.0.0');
  assert.equal(service.getRegisteredToolVersion(f.input.toolName,'1.0.0',{root:f.root}).version.state,'inactive');
  assert.deepEqual(service.getRegisteredToolVersion(f.input.toolName,'1.0.1',{root:f.root}).package.manifest.parent,{toolName:f.input.toolName,version:'1.0.0'});
  assert.equal(getRegisteredToolProposal(f.id,{root:f.root}).activated,false);
  const next=await verifiedChild(f,'1.0.1');
  assert.equal(service.approveRegisteredToolProposal(next.id,actor,{root:f.root}).version.version,'1.0.2');
  assert.equal(getRegisteredToolProposal(c.id,{root:f.root}).validation.passed,true);
  for(const [name,bytes]of Object.entries(oldBytes))assert.deepEqual(fs.readFileSync(path.join(f.approvedRoot,f.parent.version.packageDirectory,name)),bytes);
});

test('rollback and restore retain evidence; duplicate inactive approval cannot reactivate; allocation never reuses history',async t=>{
  const f=await releaseFixture(t),c=await verifiedChild(f);
  service.approveRegisteredToolProposal(c.id,actor,{root:f.root});
  assert.equal(typeof service.rollbackRegisteredTool,'function');
  const back=service.rollbackRegisteredTool(f.input.toolName,'1.0.0',actor,'exercise rollback',{root:f.root});
  assert.equal(back.version.version,'1.0.0');assert.equal(back.version.state,'active');assert.equal(back.changed,true);
  assert.equal(back.activated,true);assert.equal(back.agentCallable,null);assert.equal(back.callabilityChecked,false);
  assert.equal(back.catalog.tools[0].version,'1.0.0');
  const events=getRegisteredToolProposal(c.id,{root:f.root}).events;
  const repeat=service.approveRegisteredToolProposal(c.id,actor,{root:f.root});
  assert.equal(repeat.activated,false);assert.equal(repeat.version.state,'inactive');assert.deepEqual(getRegisteredToolProposal(c.id,{root:f.root}).events,events);
  const registry=new ToolRegistry(f.database,{readOnly:true});try{
    assert.equal(registry.nextVersion(f.input.toolName,'1.0.0').version,'1.0.2');
    const rollbackEvent=registry.listEvents(f.id).at(-1);
    assert.equal(rollbackEvent.eventType,'tool_rolled_back');assert.equal(rollbackEvent.actor,actor);
    assert.deepEqual(rollbackEvent.details,{toolId:f.parent.version.toolId,fromVersion:'1.0.1',toVersion:'1.0.0',reason:'exercise rollback'});
  }finally{registry.close();}
  const before=getRegisteredToolProposal(f.id,{root:f.root}).events;
  assert.equal(service.rollbackRegisteredTool(f.input.toolName,'1.0.0',actor,'checked no-op',{root:f.root}).changed,false);
  assert.deepEqual(getRegisteredToolProposal(f.id,{root:f.root}).events,before);
  assert.equal(service.rollbackRegisteredTool(f.input.toolName,'1.0.1',actor,'restore',{root:f.root}).changed,true);
  assert.equal(service.getRegisteredToolVersion(f.input.toolName,'1.0.1',{root:f.root}).version.state,'active');
  const next=await verifiedChild(f,'1.0.0');assert.equal(service.approveRegisteredToolProposal(next.id,actor,{root:f.root}).version.version,'1.0.2');
});

test('rollback event failure rolls back both version states and timestamps',async t=>{
  const f=await releaseFixture(t),c=await verifiedChild(f);service.approveRegisteredToolProposal(c.id,actor,{root:f.root});
  const before=service.listRegisteredToolVersions({root:f.root});
  const db=new DatabaseSync(f.database);db.exec("CREATE TRIGGER deny_rollback BEFORE INSERT ON tool_events WHEN NEW.event_type='tool_rolled_back' BEGIN SELECT RAISE(ABORT,'rollback event denied'); END");db.close();
  assert.throws(()=>service.rollbackRegisteredTool(f.input.toolName,'1.0.0',actor,'exercise rollback',{root:f.root}),/rollback event denied/);
  assert.deepEqual(service.listRegisteredToolVersions({root:f.root}),before);
  assert.equal(service.getRegisteredToolCatalog({root:f.root}).tools[0].version,'1.0.1');
});

for(const mutation of ['parent package','parent source','candidate source'])test(`activation rechecks ${mutation} after preflight under its write lock`,async t=>{
  const f=await releaseFixture(t),c=await verifiedChild(f),activate=ToolRegistry.prototype.activateVersion;
  t.mock.method(ToolRegistry.prototype,'activateVersion',function(input,options){
    if(mutation==='parent package'){
      const db=new DatabaseSync(f.database);db.prepare("UPDATE tool_versions SET package_sha256=? WHERE version='1.0.0'").run('e'.repeat(64));db.close();
    }else{
      const source=mutation==='parent source'?path.join(f.approvedRoot,f.parent.version.packageDirectory,'tool.mjs'):
        path.join(f.root,'runtime/tool-artifacts/proposals',c.id,'tool.mjs');
      writable(source,'changed after service preflight');
    }
    return activate.call(this,input,options);
  });
  assert.throws(()=>service.approveRegisteredToolProposal(c.id,actor,{root:f.root}),/digest|parent|changed/i);
  const registry=new ToolRegistry(f.database,{readOnly:true});try{
    assert.equal(registry.getActiveTool(f.input.toolName).version,'1.0.0');assert.equal(registry.getProposal(c.id).state,'verified');
    assert.equal(registry.listToolVersions().length,1);assert.equal(registry.listEvents(c.id).length,2);
  }finally{registry.close();}
});

test('failed child activation event preserves previous active version, candidate state and retained unregistered package',async t=>{
  const f=await releaseFixture(t),c=await verifiedChild(f),before=service.listRegisteredToolVersions({root:f.root});
  const db=new DatabaseSync(f.database);db.exec("CREATE TRIGGER deny_child BEFORE INSERT ON tool_events WHEN NEW.event_type='version_activated' BEGIN SELECT RAISE(ABORT,'child event denied'); END");db.close();
  assert.throws(()=>service.approveRegisteredToolProposal(c.id,actor,{root:f.root}),error=>/child event denied/.test(error.message)&&fs.existsSync(error.packagePath));
  assert.deepEqual(service.listRegisteredToolVersions({root:f.root}),before);
  assert.equal(getRegisteredToolProposal(c.id,{root:f.root}).registry.state,'verified');
});

test('inactive repeat approval with catalog failure reports retained approval without claiming activation',async t=>{
  const f=await releaseFixture(t),c=await verifiedChild(f);service.approveRegisteredToolProposal(c.id,actor,{root:f.root});
  service.rollbackRegisteredTool(f.input.toolName,'1.0.0',actor,'setup',{root:f.root});
  fs.renameSync(f.catalogPath,`${f.catalogPath}.old`);fs.mkdirSync(f.catalogPath);
  assert.throws(()=>service.approveRegisteredToolProposal(c.id,actor,{root:f.root}),error=>
    error.versionActivated===false&&error.activeStateChanged===false&&error.approved===true&&error.activated===false);
});

test('rollback catalog failure reports the committed target and explicit rebuild repairs the projection',async t=>{
  const f=await releaseFixture(t),c=await verifiedChild(f);service.approveRegisteredToolProposal(c.id,actor,{root:f.root});
  fs.renameSync(f.catalogPath,`${f.catalogPath}.old`);fs.mkdirSync(f.catalogPath);
  assert.throws(()=>service.rollbackRegisteredTool(f.input.toolName,'1.0.0',actor,'exercise rollback',{root:f.root}),error=>
    error.versionActivated===true&&error.activeStateChanged===true&&error.version==='1.0.0'&&/catalog.*rebuild/i.test(error.message));
  assert.equal(service.getRegisteredToolVersion(f.input.toolName,'1.0.0',{root:f.root}).version.state,'active');
  fs.renameSync(f.catalogPath,`${f.catalogPath}.blocker`);
  assert.equal(service.getRegisteredToolCatalog({root:f.root,rebuild:true}).tools[0].version,'1.0.0');
});

for(const target of ['target','ancestor'])test(`corrupt rollback ${target} fails before states or events change`,async t=>{
  const f=await releaseFixture(t),c=await verifiedChild(f);const child=service.approveRegisteredToolProposal(c.id,actor,{root:f.root});
  service.rollbackRegisteredTool(f.input.toolName,'1.0.0',actor,'setup',{root:f.root});
  const before=service.listRegisteredToolVersions({root:f.root});
  const pkg=target==='target'?child.version:f.parent.version;
  writable(path.join(f.approvedRoot,pkg.packageDirectory,'tool.mjs'),'corrupt');
  assert.throws(()=>service.rollbackRegisteredTool(f.input.toolName,'1.0.1',actor,'must reject',{root:f.root}),/digest|source|parent/i);
  assert.deepEqual(service.listRegisteredToolVersions({root:f.root}),before);
  const db=new DatabaseSync(f.database,{readOnly:true});try{assert.equal(db.prepare("SELECT count(*) n FROM tool_events WHERE event_type='tool_rolled_back'").get().n,1);}finally{db.close();}
});

for(const [label,bad]of [['empty','  '],['control','fixture\nactor']])test(`${label} maintenance actor or reason fails before any filesystem write`,async t=>{
  const f=await releaseFixture(t);const before=fs.readFileSync(f.database);
  let writes=0;const open=fs.openSync,mkdir=fs.mkdirSync;
  t.mock.method(fs,'openSync',function(file,flags,...args){if(typeof flags==='string'&&/[wa]/.test(flags))writes++;return open.call(this,file,flags,...args);});
  t.mock.method(fs,'mkdirSync',function(...args){writes++;return mkdir.apply(this,args);});
  assert.throws(()=>service.approveRegisteredToolProposal(f.id,bad,{root:f.root}),/approvedBy|actor|controls/);
  assert.throws(()=>service.rollbackRegisteredTool(f.input.toolName,'1.0.0',bad,'reason',{root:f.root}),/actor|controls/);
  assert.throws(()=>service.rollbackRegisteredTool(f.input.toolName,'1.0.0',actor,bad,{root:f.root}),/reason|controls/);
  assert.equal(writes,0);assert.deepEqual(fs.readFileSync(f.database),before);
});

test('audit preserves the actual canonical release version and rejects ambiguous or unsafe versions before writes',async t=>{
  const f=await releaseFixture(t);
  const settings=version=>({root:f.root,toolCallId:randomUUID(),inputSha256:'a'.repeat(64),identity:{
    toolName:f.input.toolName,toolId:f.parent.version.toolId,proposalId:f.id,toolVersion:version,
    packageSha256:f.parent.version.packageSha256,imageDigest:f.parent.version.imageDigest}});
  const run=startToolRunAudit(settings('1.0.1'));run.finish({success:false});
  assert.equal(JSON.parse(fs.readFileSync(run.auditPath)).toolVersion,'1.0.1');
  const registry=new ToolRegistry(f.database,{readOnly:true});try{
    for(const version of ['01.0.0','1.0.01','-1.0.0','1.0','1.0.1-beta','1.0.1\n','9007199254740992.0.0']){
      assert.throws(()=>startToolRunAudit(settings(version)),/version/);
      assert.throws(()=>registry.getToolVersion(f.input.toolName,version),/version/);
    }
  }finally{registry.close();}
});

test('discovery exposes only active child, rejects a stale descriptor before launch, and audits active-change during execution as failure',async t=>{
  const f=await releaseFixture(t);let runs=0;
  const runner={async run(){runs++;return {output:{ok:true},stdout:'{}',stderr:'',exitCode:0,timedOut:false,cancelled:false,
    outputLimitExceeded:false,protocolValid:true,filesDigest:hash('')};}};
  const old=discoverApprovedTools({root:f.root,runner}).tools[0];
  const c=await verifiedChild(f);service.approveRegisteredToolProposal(c.id,actor,{root:f.root});
  const active=discoverApprovedTools({root:f.root,runner});assert.equal(active.tools.length,1);assert.equal(active.packages[0].manifest.version,'1.0.1');
  await assert.rejects(old.execute(randomUUID(),{input:{sequence:'AC'}}),/stale/);assert.equal(runs,0);
  const success=await active.tools[0].execute(randomUUID(),{input:{sequence:'AC'}});
  assert.equal(JSON.parse(fs.readFileSync(success.details.auditPath)).toolVersion,'1.0.1');
  const concurrent={async run(){service.rollbackRegisteredTool(f.input.toolName,'1.0.0',actor,'change during run',{root:f.root});return runner.run();}};
  const tool=discoverApprovedTools({root:f.root,runner:concurrent}).tools[0];let failure;
  await assert.rejects(tool.execute(randomUUID(),{input:{sequence:'AC'}}),error=>{failure=error;return /operation failed/.test(error.message);});
  const audit=JSON.parse(fs.readFileSync(failure.auditPath));assert.equal(audit.success,false);assert.equal(audit.toolVersion,'1.0.1');assert.ok(audit.operationError);
  assert.equal(service.getRegisteredToolVersion(f.input.toolName,'1.0.0',{root:f.root}).version.state,'active');
});

test('trusted CLI accepts rollback arity but retains its dedicated-host guard',t=>{
  // Never inherit a deployment cwd: this CLI is authorized to modify its real
  // registry when Linux/user/cwd all match. A fresh explicit cwd always fails it.
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-cli-host-guard-')));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/manage-tool-proposals.mjs',import.meta.url)),
    'rollback','summarize_target_sequence','1.0.0',actor,'exercise rollback'],{cwd,encoding:'utf8',windowsHide:true});
  assert.equal(run.status,1);assert.match(JSON.parse(run.stderr).error,/dedicated Linux/);
  assert.deepEqual(fs.readdirSync(cwd),[]);
});

test('a switch between catalog verification and version lookup refuses an inactive descriptor before launch',async t=>{
  const f=await releaseFixture(t),c=await verifiedChild(f);service.approveRegisteredToolProposal(c.id,actor,{root:f.root});
  let runs=0,switched=false;
  const runner={async run(){runs++;return {output:{ok:true},stdout:'{}',stderr:'',exitCode:0,timedOut:false,cancelled:false,
    outputLimitExceeded:false,protocolValid:true,filesDigest:hash('')};}};
  const tool=discoverApprovedTools({root:f.root,runner}).tools[0];
  const getVersion=ToolRegistry.prototype.getToolVersion;
  t.mock.method(ToolRegistry.prototype,'getToolVersion',function(name,version){
    if(!switched&&name===f.input.toolName&&version==='1.0.1'){
      switched=true;service.rollbackRegisteredTool(name,'1.0.0',actor,'switch after catalog read',{root:f.root});
    }
    return getVersion.call(this,name,version);
  });
  await assert.rejects(tool.execute(randomUUID(),{input:{sequence:'AC'}}));
  assert.equal(switched,true);assert.equal(runs,0);
  assert.equal(fs.existsSync(path.join(f.root,'runtime/approved-tool-runs')),false);
});

function schema3Fixture(t,changeSchema=sql=>sql){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-v3-release-')));
  const database=path.join(root,'registry.sqlite');let db=new DatabaseSync(database);
  t.after(()=>{if(db?.isOpen)db.close();fs.rmSync(root,{recursive:true,force:true});});
  db.exec(changeSchema(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE tool_proposals(id TEXT PRIMARY KEY NOT NULL,tool_name TEXT NOT NULL,state TEXT NOT NULL,artifact_path TEXT NOT NULL,artifact_sha256 TEXT NOT NULL,permission_profile TEXT NOT NULL,image_digest TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,latest_validation_id TEXT REFERENCES tool_validations(id));
    CREATE TABLE tool_events(id INTEGER PRIMARY KEY AUTOINCREMENT,proposal_id TEXT NOT NULL REFERENCES tool_proposals(id),event_type TEXT NOT NULL,actor TEXT NOT NULL,tool_name TEXT NOT NULL,details_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE tool_validations(id TEXT PRIMARY KEY NOT NULL,proposal_id TEXT NOT NULL REFERENCES tool_proposals(id),passed INTEGER NOT NULL CHECK(passed IN (0,1)),report_path TEXT NOT NULL,report_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE tool_versions(tool_id TEXT PRIMARY KEY NOT NULL,tool_name TEXT NOT NULL,version TEXT NOT NULL CHECK(version='1.0.0'),state TEXT NOT NULL CHECK(state='active'),proposal_id TEXT NOT NULL REFERENCES tool_proposals(id),package_directory TEXT NOT NULL,package_sha256 TEXT NOT NULL,image_digest TEXT NOT NULL,runtime_state TEXT NOT NULL CHECK(runtime_state='retained'),approved_by TEXT NOT NULL,approved_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX tool_versions_name ON tool_versions(tool_name);
    CREATE UNIQUE INDEX tool_versions_name_version ON tool_versions(tool_name,version);
    CREATE UNIQUE INDEX tool_versions_proposal ON tool_versions(proposal_id);
    PRAGMA application_id=1397903433; PRAGMA user_version=3;`));
  const id=randomUUID(),tool=randomUUID(),validation=randomUUID();
  db.prepare("INSERT INTO tool_proposals VALUES(?,'sequence_summary','approved',?,?,'no_external_access',?,'old','old',NULL)").run(id,path.join(root,'proposal'),'a'.repeat(64),`sha256:${'b'.repeat(64)}`);
  db.prepare("INSERT INTO tool_validations VALUES(?,?,1,?,?,'old')").run(validation,id,path.join(root,'report'),'c'.repeat(64));
  db.prepare('UPDATE tool_proposals SET latest_validation_id=? WHERE id=?').run(validation,id);
  db.prepare("INSERT INTO tool_versions VALUES(?,'sequence_summary','1.0.0','active',?,?,?,?,'retained','old actor','old','old')").run(tool,id,`${tool}-1.0.0`,'d'.repeat(64),`sha256:${'b'.repeat(64)}`);
  db.prepare("INSERT INTO tool_events(proposal_id,event_type,actor,tool_name,details_json,created_at) VALUES(?,'version_activated','old actor','sequence_summary','{}','old')").run(id);
  const before=Object.fromEntries(['tool_proposals','tool_validations','tool_events','tool_versions'].map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));
  return {root,database,db,before};
}

test('explicit schema3 migration backs up committed WAL rows and preserves every original row',t=>{
  const {root,database,db,before}=schema3Fixture(t);
  const old=new ToolRegistry(database,{readOnly:true});assert.equal(old.getActiveTool('sequence_summary').version,'1.0.0');old.close();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);
  const upgraded=new ToolRegistry(database,{migrate:true});upgraded.close();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);
  const backups=fs.readdirSync(root).filter(name=>name.includes('.v3-backup-'));assert.equal(backups.length,1);
  const backupPath=path.join(root,backups[0]);if(process.platform!=='win32')assert.equal(fs.statSync(backupPath).mode&0o777,0o600);
  const backup=new DatabaseSync(backupPath,{readOnly:true});try{
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version,3);
    for(const [table,rows]of Object.entries(before)){
      assert.deepEqual(backup.prepare(`SELECT * FROM ${table}`).all(),rows);
      assert.deepEqual(db.prepare(`SELECT ${Object.keys(rows[0]).join(',')} FROM ${table}`).all(),rows);
    }
  }finally{backup.close();}
  assert.deepEqual({...db.prepare('SELECT parent_tool_id,parent_version FROM tool_versions').get()},{parent_tool_id:null,parent_version:null});
});

for(const [label,change]of [
  ['version constraint',sql=>sql.replace("CHECK(version='1.0.0')","CHECK(version='1.0.0' OR version='1.0.1')")],
  ['foreign key',sql=>sql.replace('proposal_id TEXT NOT NULL REFERENCES tool_proposals(id),package_directory','proposal_id TEXT NOT NULL,package_directory')],
  ['collated unique index',sql=>sql.replace('tool_versions(tool_name);','tool_versions(tool_name COLLATE NOCASE);')],
  ['changed constraint literal',sql=>'PRAGMA ignore_check_constraints=ON;'+sql.replace("CHECK(state='active')","CHECK(state='a c t i v e')")],
])test(`unrecognized schema3 ${label} fails without backup or changes`,t=>{
  const {root,database,db,before}=schema3Fixture(t,change);
  assert.throws(()=>new ToolRegistry(database,{migrate:true}),/recogniz|schema|constraint|index/);
  assert.equal(fs.readdirSync(root).some(name=>name.includes('-backup-')),false);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);
  for(const [table,rows]of Object.entries(before))assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(),rows);
});

test('failed schema3 migration rolls back table changes and retains a readable consistent backup',t=>{
  const {root,database,db,before}=schema3Fixture(t);
  db.exec('CREATE VIEW tool_versions_v3 AS SELECT 1 sentinel');
  assert.throws(()=>new ToolRegistry(database,{migrate:true}),/migration failed/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);
  for(const [table,rows]of Object.entries(before))assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(),rows);
  const backups=fs.readdirSync(root).filter(name=>name.includes('.v3-backup-'));assert.equal(backups.length,1);
  const backup=new DatabaseSync(path.join(root,backups[0]),{readOnly:true});try{
    assert.deepEqual(backup.prepare('SELECT * FROM tool_versions').all(),before.tool_versions);
  }finally{backup.close();}
});

for(const corruption of ['wrong identity','self parent','forward parent'])test(`malformed lineage ${corruption} fails boundedly before rollback mutations`,async t=>{
  const f=await releaseFixture(t),c=await verifiedChild(f);service.approveRegisteredToolProposal(c.id,actor,{root:f.root});
  const db=new DatabaseSync(f.database);db.exec('PRAGMA foreign_keys=OFF');
  if(corruption==='wrong identity')db.prepare("UPDATE tool_versions SET parent_tool_id=? WHERE version='1.0.1'").run(randomUUID());
  else db.prepare("UPDATE tool_versions SET parent_version=? WHERE version='1.0.1'").run(corruption==='self parent'?'1.0.1':'1.0.2');
  const before=db.prepare('SELECT * FROM tool_versions').all(),events=db.prepare('SELECT * FROM tool_events').all();db.close();
  assert.throws(()=>service.getRegisteredToolVersion(f.input.toolName,'1.0.1',{root:f.root}),error=>
    !(error instanceof RangeError)&&/parent|lineage|order/.test(error.message));
  assert.throws(()=>service.rollbackRegisteredTool(f.input.toolName,'1.0.1',actor,'must reject',{root:f.root}),/parent|lineage|order/);
  const check=new DatabaseSync(f.database,{readOnly:true});try{
    assert.deepEqual(check.prepare('SELECT * FROM tool_versions').all(),before);assert.deepEqual(check.prepare('SELECT * FROM tool_events').all(),events);
  }finally{check.close();}
});

test('the same lineage traversal context crosses historical, report and resolver recursion edges',async t=>{
  const f=await releaseFixture(t),c=await verifiedChild(f);const approved=service.approveRegisteredToolProposal(c.id,actor,{root:f.root});
  const registry=new ToolRegistry(f.database,{readOnly:true});
  const settings=()=>({root:f.root,registry,context:{visiting:new Set([`${f.input.toolName}@1.0.0`]),packages:new Map()}});
  try{
    assert.throws(()=>readRegisteredToolVersion(approved.version,settings()),/cyclic|depth/);
    assert.throws(()=>readLatestValidationReport(c.id,settings()),/cyclic|depth/);
    assert.throws(()=>assertRegisteredToolParent(c.input,settings()),/cyclic|depth/);
    const context={visiting:new Set(Array.from({length:64},(_,i)=>`ancestor_${i}@1.0.0`)),packages:new Map()};
    assert.throws(()=>readRegisteredToolVersion(approved.version,{root:f.root,registry,context}),/depth/);
  }finally{registry.close();}
});

// Build authentic, digest-bound retained fixture evidence through the real
// storage/package APIs. Only the final prospective release uses the approval
// service: repeating full ancestor walks during setup would obscure this edge.
async function maximumDepthFixture(t){
  const f=await releaseFixture(t);let parent=f.parent.version;
  const reportTemplate=getRegisteredToolProposal(f.id,{root:f.root}).validation.report;
  const registry=new ToolRegistry(f.database);
  try{
    for(let patch=1;patch<=63;patch++){
      const input={...structuredClone(f.input),parent:{toolName:f.input.toolName,version:parent.version},
        baseline:{runtime:'node',script:f.input.script}};
      const saved=createToolProposal(input,{proposalsRoot:path.join(f.root,'runtime/tool-artifacts/proposals')});
      registry.registerProposal({id:saved.manifest.id,toolName:input.toolName,artifactPath:saved.artifactPath,artifactSha256:saved.artifactSha256,
        permissionProfile:'no_external_access',imageDigest:input.runtimeArtifact.imageDigest});
      const validationId=randomUUID(),verifiedAt=new Date().toISOString();
      const report={...structuredClone(reportTemplate),proposalId:saved.manifest.id,validationId,verifiedAt,
        artifactSha256:saved.artifactSha256,parentComparison:{toolName:input.toolName,version:parent.version,toolId:parent.toolId,
          packageSha256:parent.packageSha256,imageDigest:parent.imageDigest,scriptSha256:hash(input.script),
          baselineScriptSha256:hash(input.script),comparisonMode:'registered-parent-source'}};
      const written=writeValidationReport(report,{root:f.root});
      registry.recordValidation({id:validationId,proposalId:saved.manifest.id,passed:true,...written});
      const version=`1.0.${patch}`;
      const published=publishApprovedToolPackage({saved,verificationBytes:fs.readFileSync(written.reportPath),
        verificationSha256:written.reportSha256,toolId:parent.toolId,version,approvedBy:actor,approvedAt:verifiedAt},{approvedRoot:f.approvedRoot});
      parent=registry.activateVersion({toolId:parent.toolId,toolName:input.toolName,version,proposalId:saved.manifest.id,
        packageDirectory:published.directoryName,packageSha256:published.packageSha256,imageDigest:input.runtimeArtifact.imageDigest,
        approvedBy:actor,approvedAt:verifiedAt,validationId,reportSha256:written.reportSha256,artifactSha256:saved.artifactSha256,
        parentToolId:parent.toolId,parentVersion:parent.version,parentPackageSha256:parent.packageSha256});
    }
  }finally{registry.close();}
  service.getRegisteredToolCatalog({root:f.root,rebuild:true});
  return {...f,last:parent};
}

test('prospective depth65 is rejected before package or activation writes; a shallow child can still claim the next version',async t=>{
  const f=await maximumDepthFixture(t);assert.equal(f.last.version,'1.0.63');
  assert.equal(service.getRegisteredToolVersion(f.input.toolName,'1.0.63',{root:f.root}).version.state,'active');
  const child=await verifiedChild(f,'1.0.63');
  const before=service.listRegisteredToolVersions({root:f.root}),packages=fs.readdirSync(f.approvedRoot).sort();
  const db=new DatabaseSync(f.database,{readOnly:true});const events=db.prepare('SELECT * FROM tool_events').all();db.close();
  assert.throws(()=>service.approveRegisteredToolProposal(child.id,actor,{root:f.root}),error=>
    /depth/.test(error.message)&&error.versionActivated!==true);
  assert.deepEqual(service.listRegisteredToolVersions({root:f.root}),before);
  assert.deepEqual(fs.readdirSync(f.approvedRoot).sort(),packages);
  assert.equal(getRegisteredToolProposal(child.id,{root:f.root}).registry.state,'verified');
  const check=new DatabaseSync(f.database,{readOnly:true});try{assert.deepEqual(check.prepare('SELECT * FROM tool_events').all(),events);}finally{check.close();}
  assert.equal(service.getRegisteredToolCatalog({root:f.root}).tools[0].version,'1.0.63');
  const shallow=await verifiedChild(f,'1.0.0');
  const released=service.approveRegisteredToolProposal(shallow.id,actor,{root:f.root});
  assert.equal(released.version.version,'1.0.64');assert.equal(released.catalog.tools[0].version,'1.0.64');
});
