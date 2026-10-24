import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const applicationId=1397903953;
const phases=['queued','validating','repairing','awaiting_replacement','approving','completed','failed','superseded'];
const openPhases=['queued','validating','repairing','awaiting_replacement','approving'];
const schema=`CREATE TABLE runs (
  proposal_id TEXT PRIMARY KEY NOT NULL,
  source_task_id TEXT NOT NULL,
  curation_id TEXT,
  tool_name TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  root_proposal_id TEXT NOT NULL,
  previous_proposal_id TEXT,
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 3),
  phase TEXT NOT NULL CHECK(phase IN ('queued','validating','repairing','awaiting_replacement','approving','completed','failed','superseded')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX runs_open ON runs(phase,created_at);
CREATE INDEX runs_source_tool ON runs(source_task_id,tool_name,created_at DESC);`;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha=/^[a-f0-9]{64}$/;
const fail=message=>{throw new Error(message);};

function directory(root){
  if(typeof root!=='string'||!path.isAbsolute(root))fail('Explicit automation root required');
  let current=path.resolve(root);
  for(const name of [null,'runtime','tool-automation']){
    if(name){current=path.join(current,name);try{fs.mkdirSync(current,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}}
    const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(current)!==current)fail('Unsafe automation directory');
  }
  return current;
}
function inspect(file){
  for(const suffix of ['','-wal','-shm','-journal']){
    try{const target=file+suffix,stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||fs.realpathSync(target)!==target)fail('Unsafe automation database');}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
function recognize(db){
  if(db.prepare('PRAGMA application_id').get().application_id!==applicationId||db.prepare('PRAGMA user_version').get().user_version!==1)fail('Unknown automation database');
  const expected=schema.split(';').map(value=>value.trim()).filter(Boolean).sort();
  const actual=db.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL').all().map(row=>row.sql.trim()).sort();
  if(JSON.stringify(actual)!==JSON.stringify(expected))fail('Unknown automation schema');
}
function input(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!uuid.test(value.proposalId)||!uuid.test(value.sourceTaskId)||
    (value.curationId!==undefined&&value.curationId!==null&&!uuid.test(value.curationId))||typeof value.toolName!=='string'||!/^[a-z][a-z0-9_]{2,63}$/.test(value.toolName)||
    !sha.test(value.artifactSha256))fail('Invalid automation proposal');
  return {proposalId:value.proposalId,sourceTaskId:value.sourceTaskId,curationId:value.curationId??null,toolName:value.toolName,artifactSha256:value.artifactSha256};
}
function row(value){
  if(!value)return null;
  return {proposalId:value.proposal_id,sourceTaskId:value.source_task_id,curationId:value.curation_id??null,toolName:value.tool_name,artifactSha256:value.artifact_sha256,
    rootProposalId:value.root_proposal_id,previousProposalId:value.previous_proposal_id??null,attempt:value.attempt,phase:value.phase,lastError:value.last_error??null,createdAt:value.created_at,updatedAt:value.updated_at};
}

export class ToolAutomationStore {
  #db;
  constructor({root,databasePath}={}){
    const file=databasePath?path.resolve(databasePath):path.join(directory(root),'runs.sqlite');
    if(databasePath){const parent=path.dirname(file);if(!fs.existsSync(parent))fs.mkdirSync(parent,{recursive:true,mode:0o700});const stat=fs.lstatSync(parent);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(parent)!==parent)fail('Unsafe automation directory');}
    inspect(file);
    if(fs.existsSync(file)){const probe=new DatabaseSync(file,{readOnly:true});try{recognize(probe);}finally{probe.close();}}
    else{const fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);const db=new DatabaseSync(file);try{db.exec(`BEGIN IMMEDIATE;${schema}PRAGMA application_id=${applicationId};PRAGMA user_version=1;COMMIT;`);}finally{db.close();}}
    inspect(file);this.databasePath=file;this.#db=new DatabaseSync(file);this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');recognize(this.#db);
  }
  #transaction(fn){this.#db.exec('BEGIN IMMEDIATE');try{const value=fn();this.#db.exec('COMMIT');return value;}catch(error){try{this.#db.exec('ROLLBACK');}catch{/* preserve original error */}throw error;}}
  get(id){if(typeof id!=='string'||!uuid.test(id))fail('Invalid automation proposal id');return row(this.#db.prepare('SELECT * FROM runs WHERE proposal_id=?').get(id));}
  getRun(id){return this.get(id);}
  list(limit=100){if(!Number.isSafeInteger(limit)||limit<1||limit>1000)fail('Invalid automation list limit');return this.#db.prepare('SELECT * FROM runs ORDER BY created_at DESC,proposal_id DESC LIMIT ?').all(limit).map(row);}
  listOpen(limit=100){if(!Number.isSafeInteger(limit)||limit<1||limit>1000)fail('Invalid automation list limit');const marks=openPhases.map(()=>'?').join(',');return this.#db.prepare(`SELECT * FROM runs WHERE phase IN (${marks}) ORDER BY created_at ASC,proposal_id ASC LIMIT ?`).all(...openPhases,limit).map(row);}
  listOpenRuns(limit=100){return this.listOpen(limit);}
  registerProposal(value){
    const p=input(value),existing=this.get(p.proposalId);if(existing){if(existing.sourceTaskId!==p.sourceTaskId||existing.toolName!==p.toolName||existing.artifactSha256!==p.artifactSha256)fail('Automation proposal binding conflict');return existing;}
    return this.#transaction(()=>{
      const again=row(this.#db.prepare('SELECT * FROM runs WHERE proposal_id=?').get(p.proposalId));if(again)return again;
      const previous=row(this.#db.prepare("SELECT * FROM runs WHERE source_task_id=? AND tool_name=? AND phase IN ('repairing','awaiting_replacement') ORDER BY created_at DESC LIMIT 1").get(p.sourceTaskId,p.toolName));
      if(previous&&previous.attempt>=3)fail('Repair generation limit reached');
      if(previous&&previous.curationId&&p.curationId&&previous.curationId!==p.curationId)fail('Replacement curation identity differs');
      const now=new Date().toISOString(),rootProposalId=previous?.rootProposalId??p.proposalId,attempt=previous?previous.attempt+1:0;
      if(previous)this.#db.prepare("UPDATE runs SET phase='superseded',last_error=NULL,updated_at=? WHERE proposal_id=? AND phase!='superseded'").run(now,previous.proposalId);
      this.#db.prepare('INSERT INTO runs(proposal_id,source_task_id,curation_id,tool_name,artifact_sha256,root_proposal_id,previous_proposal_id,attempt,phase,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'+"'queued'"+',?,?,?)').run(p.proposalId,p.sourceTaskId,p.curationId,p.toolName,p.artifactSha256,rootProposalId,previous?.proposalId??null,attempt,null,now,now);
      return this.get(p.proposalId);
    });
  }
  setPhase(id,phase,lastError=null){
    if(!phases.includes(phase)||lastError!==null&&(typeof lastError!=='string'||lastError.length>4000))fail('Invalid automation phase');
    const changed=this.#db.prepare('UPDATE runs SET phase=?,last_error=?,updated_at=? WHERE proposal_id=?').run(phase,lastError,new Date().toISOString(),id);
    if(changed.changes!==1)fail('Unknown automation proposal');return this.get(id);
  }
  close(){if(this.#db){this.#db.close();this.#db=undefined;}}
}
