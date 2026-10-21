import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {assertCurationJson} from './tool-curation-evidence.mjs';
import {buildHash,buildId,curationBuildAssociation} from './tool-curation-build-contract.mjs';
import {repairSource} from '../../capability-platform/tool-repair-contract.mjs';

const applicationId=0x53434231;
const schema=`CREATE TABLE builds (
  curation_id TEXT PRIMARY KEY NOT NULL, request_id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL,
  payload_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('dispatching','running','submitted','no_proposal','failed','outcome_unknown')),
  submission_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(submission_uncertain IN (0,1)),
  user_message_id TEXT, run_id TEXT, registration_source_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX builds_task ON builds(task_id);
CREATE TRIGGER builds_frozen BEFORE UPDATE OF curation_id,request_id,task_id,payload_json,payload_sha256,created_at ON builds
BEGIN SELECT RAISE(ABORT,'Frozen handoff is immutable'); END;
CREATE TRIGGER builds_identity BEFORE UPDATE OF user_message_id,run_id,registration_source_json,submission_uncertain ON builds
WHEN (OLD.user_message_id IS NOT NULL AND NEW.user_message_id IS NOT OLD.user_message_id)
 OR (OLD.run_id IS NOT NULL AND NEW.run_id IS NOT OLD.run_id)
 OR (OLD.registration_source_json IS NOT NULL AND NEW.registration_source_json IS NOT OLD.registration_source_json)
 OR (OLD.submission_uncertain=1 AND NEW.submission_uncertain!=1)
BEGIN SELECT RAISE(ABORT,'Handoff identity is immutable'); END;`;
const phases=['dispatching','running','submitted','no_proposal','failed','outcome_unknown'];
function folder(root,readOnly){
  if(typeof root!=='string'||!path.isAbsolute(root))throw Error('Explicit handoff root required');
  let current=path.resolve(root);
  for(const name of [null,'runtime','tool-curation-build']){
    if(name){current=path.join(current,name);if(!readOnly)try{fs.mkdirSync(current,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}}
    const s=fs.lstatSync(current);if(s.isSymbolicLink()||!s.isDirectory()||fs.realpathSync(current)!==current)throw Error('Unsafe handoff directory');
  }return current;
}
function inspect(file){for(const suffix of ['','-wal','-shm','-journal'])try{const target=file+suffix,s=fs.lstatSync(target);if(s.isSymbolicLink()||!s.isFile()||s.nlink!==1||fs.realpathSync(target)!==target)throw Error('Unsafe handoff database');}catch(e){if(e.code!=='ENOENT')throw e;}}
function recognize(db){
  if(db.prepare('PRAGMA application_id').get().application_id!==applicationId||db.prepare('PRAGMA user_version').get().user_version!==1)throw Error('Unknown handoff database');
  // Trigger bodies contain semicolons; compare the full DDL without depending
  // on sqlite_master ordering or SQLite's removal of final statement delimiters.
  const actual=db.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name').all().map(r=>r.sql.trim());
  const statements=[schema.slice(0,schema.indexOf('CREATE INDEX')).trim().replace(/;$/,''),schema.slice(schema.indexOf('CREATE INDEX'),schema.indexOf('CREATE TRIGGER')).trim().replace(/;$/,''),...schema.slice(schema.indexOf('CREATE TRIGGER')).split(/(?=CREATE TRIGGER)/).filter(Boolean).map(s=>s.trim().replace(/;$/,''))];
  if(JSON.stringify(actual.sort())!==JSON.stringify(statements.sort()))throw Error('Unknown handoff schema');
}
function payload(value){
  assertCurationJson(value,{maxDepth:8,maxBytes:300000});curationBuildAssociation({requestId:value.requestId,curationId:value.curationId,...value.binding});
  if(!buildId(value.taskId)||!buildId(value.executionSessionId)||typeof value.sandboxId!=='string'||!value.sandboxId||!/^[a-z][a-z0-9_]{2,63}$/.test(value.toolName)||typeof value.prompt!=='string'||value.prompt!==value.prompt.trim()||value.prompt.length>120000||Buffer.byteLength(value.prompt)>256*1024||buildHash(value.prompt)!==value.binding.promptSha256)throw Error('Invalid frozen handoff');
  return value;
}
function row(value){if(!value)return null;if(buildHash(value.payload_json)!==value.payload_sha256)throw Error('Handoff digest differs');const p=payload(JSON.parse(value.payload_json));if(p.curationId!==value.curation_id||p.requestId!==value.request_id||p.taskId!==value.task_id)throw Error('Handoff identity differs');const registrationSource=value.registration_source_json===null?null:repairSource(JSON.parse(value.registration_source_json));if(registrationSource&&(registrationSource.taskId!==p.taskId||registrationSource.executionSessionId!==p.executionSessionId||registrationSource.sandboxId!==p.sandboxId||registrationSource.agentRunId!==value.run_id))throw Error('Handoff registration source differs');return {...p,phase:value.phase,userMessageId:value.user_message_id,runId:value.run_id,registrationSource,submissionUncertain:value.submission_uncertain===1,createdAt:value.created_at,updatedAt:value.updated_at};}

export class ToolCurationBuildStore {
  #db;
  constructor({root,readOnly=false}){
    this.databasePath=path.join(folder(root,readOnly),'builds.sqlite');inspect(this.databasePath);const exists=fs.existsSync(this.databasePath);
    if(exists){const probe=new DatabaseSync(this.databasePath,{readOnly:true});try{recognize(probe);}finally{probe.close();}}
    else{if(readOnly)throw Error('Handoff database not found');const fd=fs.openSync(this.databasePath,'wx',0o600);fs.closeSync(fd);const db=new DatabaseSync(this.databasePath);try{db.exec(`BEGIN IMMEDIATE;${schema}PRAGMA application_id=${applicationId};PRAGMA user_version=1;COMMIT;`);}finally{db.close();}}
    inspect(this.databasePath);this.#db=new DatabaseSync(this.databasePath,{readOnly});try{recognize(this.#db);this.#db.exec(`PRAGMA busy_timeout=5000;${readOnly?'':'PRAGMA synchronous=FULL;'}`);}catch(e){this.#db.close();throw e;}
  }
  get(id){return row(this.#db.prepare('SELECT * FROM builds WHERE curation_id=?').get(id));}
  byRequest(id){return row(this.#db.prepare('SELECT * FROM builds WHERE request_id=?').get(id));}
  activeForTask(id){return this.#db.prepare("SELECT * FROM builds WHERE task_id=? AND phase IN ('dispatching','running')").all(id).map(row);}
  create(value){const p=payload(value),json=JSON.stringify(p),now=new Date().toISOString();this.#db.prepare("INSERT INTO builds(curation_id,request_id,task_id,payload_json,payload_sha256,phase,created_at,updated_at) VALUES(?,?,?,?,?,'dispatching',?,?)").run(p.curationId,p.requestId,p.taskId,json,buildHash(json),now,now);return this.get(p.curationId);}
  update(id,phase,{userMessageId,runId,registrationSource,submissionUncertain=false}={}){
    if(!phases.includes(phase)||userMessageId!==undefined&&!buildId(userMessageId)||runId!==undefined&&(typeof runId!=='string'||!runId||runId.length>128))throw Error('Invalid handoff state');
    const source=registrationSource===undefined?null:JSON.stringify(repairSource(registrationSource));
    this.#db.prepare('UPDATE builds SET phase=?,user_message_id=COALESCE(?,user_message_id),run_id=COALESCE(?,run_id),registration_source_json=COALESCE(?,registration_source_json),submission_uncertain=MAX(submission_uncertain,?),updated_at=? WHERE curation_id=?').run(phase,userMessageId??null,runId??null,source,submissionUncertain?1:0,new Date().toISOString(),id);return this.get(id);
  }
  recover(){return this.#db.prepare("UPDATE builds SET phase='outcome_unknown',updated_at=? WHERE phase IN ('dispatching','running')").run(new Date().toISOString()).changes;}
  close(){this.#db?.close();this.#db=undefined;}
}
