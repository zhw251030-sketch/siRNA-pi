import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {repairHash,repairRequestId,repairSource} from './tool-repair-contract.mjs';

const applicationId=1397903952;
const schema=`CREATE TABLE repairs (
  proposal_id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL UNIQUE,
  source_task_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('dispatching','running','awaiting_replacement','superseded','failed','interrupted')),
  payload_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  error_code TEXT CHECK(error_code IN ('dispatch_unknown','completion_failed','interrupted'))
);
CREATE INDEX repairs_source_task ON repairs(source_task_id);`;
const phases=new Set(['dispatching','running','awaiting_replacement','superseded','failed','interrupted']);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function directory(root){
  if(typeof root!=='string'||!path.isAbsolute(root))throw new Error('Explicit repair root required');
  let current=path.resolve(root);
  for(const part of [null,'runtime','tool-repair']){
    if(part){current=path.join(current,part);try{fs.mkdirSync(current,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}}
    const s=fs.lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(current)!==current)throw new Error('Unsafe repair directory');
  }
  return current;
}
function inspect(file){for(const suffix of ['','-wal','-shm','-journal']){try{const target=file+suffix,s=fs.lstatSync(target);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||fs.realpathSync(target)!==target)throw new Error('Unsafe repair database');}catch(e){if(e.code!=='ENOENT')throw e;}}}
function recognize(db){
  if(db.prepare('PRAGMA application_id').get().application_id!==applicationId||db.prepare('PRAGMA user_version').get().user_version!==1)throw new Error('Unknown repair database');
  const expected=schema.split(';').map(x=>x.trim()).filter(Boolean).sort(),actual=db.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL').all().map(r=>r.sql.trim()).sort();
  if(JSON.stringify(expected)!==JSON.stringify(actual))throw new Error('Unknown repair schema');
}
function payload(value){
  if(!value||!uuid.test(value.proposalId)||value.requestId!==repairRequestId(value.proposalId)||!uuid.test(value.rootProposalId)||!Number.isInteger(value.attempt)||value.attempt<1||value.attempt>3||!uuid.test(value.validationId)||!/^[a-f0-9]{64}$/.test(value.reportSha256)||!/^[a-f0-9]{64}$/.test(value.artifactSha256))throw new Error('Invalid repair ticket');
  repairSource(value.source);
  if(typeof value.prompt!=='string'||value.prompt.length>120000||Buffer.byteLength(value.prompt)>256*1024||repairHash(value.prompt)!==value.promptSha256)throw new Error('Invalid repair prompt');
  if(repairHash(JSON.stringify(value.contract))!==value.contractSha256)throw new Error('Invalid frozen repair contract');
  return value;
}
function row(r){
  if(!r)return null;
  if(repairHash(r.payload_json)!==r.payload_sha256)throw new Error('Repair ticket integrity differs');
  const data=payload(JSON.parse(r.payload_json));
  if(data.proposalId!==r.proposal_id||data.requestId!==r.request_id||data.source.taskId!==r.source_task_id)throw new Error('Repair identity differs');
  return {...data,phase:r.phase,createdAt:r.created_at,updatedAt:r.updated_at,errorCode:r.error_code};
}
// The prompt and evidence identity are immutable. Public projections live in
// the service and never include these private records or raw exception text.
export class ToolRepairStore {
  #db;
  constructor({root}){
    const file=path.join(directory(root),'repairs.sqlite');inspect(file);
    if(fs.existsSync(file)){const probe=new DatabaseSync(file,{readOnly:true});try{recognize(probe);}finally{probe.close();}}
    else{const fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);const db=new DatabaseSync(file);try{db.exec(`BEGIN IMMEDIATE;${schema}PRAGMA application_id=${applicationId};PRAGMA user_version=1;COMMIT;`);}finally{db.close();}}
    inspect(file);this.#db=new DatabaseSync(file);this.#db.exec('PRAGMA busy_timeout=5000');recognize(this.#db);
  }
  get(id){return row(this.#db.prepare('SELECT * FROM repairs WHERE proposal_id=?').get(id));}
  byRequest(id){return row(this.#db.prepare('SELECT * FROM repairs WHERE request_id=?').get(id));}
  activeForTask(id){return this.#db.prepare("SELECT * FROM repairs WHERE source_task_id=? AND phase IN ('dispatching','running')").all(id).map(row);}
  create(value){
    const data=payload(value),json=JSON.stringify(data),now=new Date().toISOString();
    this.#db.prepare("INSERT INTO repairs(proposal_id,request_id,source_task_id,phase,payload_json,payload_sha256,created_at,updated_at) VALUES(?,?,?,'dispatching',?,?,?,?)").run(data.proposalId,data.requestId,data.source.taskId,json,repairHash(json),now,now);
    return this.get(data.proposalId);
  }
  update(id,phase,errorCode=null){
    if(!phases.has(phase)||![null,'dispatch_unknown','completion_failed','interrupted'].includes(errorCode))throw new Error('Invalid repair phase');
    // Never overwrite an independently reconciled successor with a late failure.
    this.#db.prepare("UPDATE repairs SET phase=?,error_code=?,updated_at=? WHERE proposal_id=? AND phase!='superseded'").run(phase,errorCode,new Date().toISOString(),id);return this.get(id);
  }
  recover(){return this.#db.prepare("UPDATE repairs SET phase='interrupted',error_code='interrupted',updated_at=? WHERE phase IN ('dispatching','running')").run(new Date().toISOString()).changes;}
  close(){if(this.#db){this.#db.close();this.#db=undefined;}}
}
