import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const applicationId=1397575502;
const schema=`CREATE TABLE jobs (
  id TEXT PRIMARY KEY NOT NULL, proposal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','interrupted')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  validation_id TEXT, passed INTEGER CHECK(passed IN (0,1)), artifact_sha256 TEXT,
  CHECK ((status='succeeded' AND validation_id IS NOT NULL AND passed IS NOT NULL) OR
    (status!='succeeded' AND validation_id IS NULL AND passed IS NULL))
);
CREATE UNIQUE INDEX one_active_proposal ON jobs(proposal_id) WHERE status IN ('pending','running');
CREATE UNIQUE INDEX one_running_job ON jobs(status) WHERE status='running';
CREATE TABLE requests (request_id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id));
CREATE TABLE control (id INTEGER PRIMARY KEY CHECK(id=1), halted INTEGER NOT NULL CHECK(halted IN (0,1)));`;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class ToolMaintenanceError extends Error {constructor(statusCode,message){super(message);this.statusCode=statusCode;}}
export function maintenanceId(id){if(typeof id!=='string'||!uuid.test(id))throw new ToolMaintenanceError(400,'需要小写 UUID v4。');return id;}
export function maintenanceDirectory(root,...parts){
  if(typeof root!=='string'||!path.isAbsolute(root))throw new Error('Explicit project root required');
  let current=path.resolve(root);
  for(const part of [null,'runtime','tool-maintenance',...parts]){
    if(part){current=path.join(current,part);if(!fs.existsSync(current))fs.mkdirSync(current,{mode:0o700});}
    const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(current)!==current)throw new Error('Unsafe maintenance directory');
  }return current;
}
function inspect(file){
  for(const suffix of ['','-wal','-shm','-journal']){
    try{const target=file+suffix,s=fs.lstatSync(target);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||fs.realpathSync(target)!==target)throw new Error('Unsafe maintenance database file');}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
}
function recognize(db){
  if(db.prepare('PRAGMA application_id').get().application_id!==applicationId||db.prepare('PRAGMA user_version').get().user_version!==1)throw new Error('Unknown maintenance database');
  const statements=schema.split(';').map(x=>x.trim()).filter(Boolean).sort();
  const actual=db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY sql").all().map(x=>x.sql.trim()).sort();
  if(JSON.stringify(actual)!==JSON.stringify(statements))throw new Error('Unknown maintenance schema');
}
function row(r){return r?{id:r.id,proposalId:r.proposal_id,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at,
  ...(r.validation_id?{validationId:r.validation_id,passed:r.passed===1}:{}),
  ...(r.status==='failed'?{error:'验证执行失败，请检查项目内私有运行记录。'}:{}),
  ...(r.status==='interrupted'?{error:'上次执行中断，未自动重试；请先检查已有报告和运行记录。'}:{})}:null;}
export class ToolMaintenanceStore {
  #db;
  constructor({root}){
    const file=path.join(maintenanceDirectory(root),'jobs.sqlite');inspect(file);
    if(fs.existsSync(file)){const probe=new DatabaseSync(file,{readOnly:true});try{recognize(probe);}finally{probe.close();}}
    else{const fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);const db=new DatabaseSync(file);try{db.exec(`BEGIN IMMEDIATE;${schema}INSERT INTO control VALUES(1,0);PRAGMA application_id=${applicationId};PRAGMA user_version=1;COMMIT;`);}finally{db.close();}}
    inspect(file);this.#db=new DatabaseSync(file);this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');recognize(this.#db);
  }
  #transaction(fn){this.#db.exec('BEGIN IMMEDIATE');try{const result=fn();this.#db.exec('COMMIT');return result;}catch(e){this.#db.exec('ROLLBACK');throw e;}}
  get(id){return row(this.#db.prepare('SELECT * FROM jobs WHERE id=?').get(maintenanceId(id)));}
  getByRequest(id){return row(this.#db.prepare('SELECT j.* FROM jobs j JOIN requests r ON r.job_id=j.id WHERE r.request_id=?').get(maintenanceId(id)));}
  latest(id){return row(this.#db.prepare('SELECT * FROM jobs WHERE proposal_id=? ORDER BY rowid DESC LIMIT 1').get(maintenanceId(id)));}
  list(limit=100){if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ToolMaintenanceError(400,'Invalid job list limit');return this.#db.prepare('SELECT * FROM jobs ORDER BY rowid DESC LIMIT ?').all(limit).map(row);}
  binding(id){return this.#db.prepare('SELECT artifact_sha256 AS artifactSha256 FROM jobs WHERE id=?').get(maintenanceId(id))?.artifactSha256;}
  halted(){return this.#db.prepare('SELECT halted FROM control WHERE id=1').get()?.halted!==0;}
  halt(){this.#db.prepare('UPDATE control SET halted=1 WHERE id=1').run();}
  enqueue(proposalId,requestId,{artifactSha256=null}={}){maintenanceId(proposalId);maintenanceId(requestId);if(artifactSha256!==null&&!/^[a-f0-9]{64}$/.test(artifactSha256))throw new Error('Invalid artifact binding');return this.#transaction(()=>{
    const previous=this.getByRequest(requestId);if(previous){if(previous.proposalId!==proposalId)throw new ToolMaintenanceError(409,'Request key belongs to a different proposal');return {job:previous,deduplicated:true};}
    let job=row(this.#db.prepare("SELECT * FROM jobs WHERE proposal_id=? AND status IN ('pending','running')").get(proposalId));const deduplicated=!!job;
    if(!job){if(this.#db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('pending','running')").get().n>=100)throw new ToolMaintenanceError(429,'Maintenance queue capacity reached');
      const id=randomUUID(),now=new Date().toISOString();this.#db.prepare("INSERT INTO jobs(id,proposal_id,status,created_at,updated_at,artifact_sha256) VALUES (?,?,'pending',?,?,?)").run(id,proposalId,now,now,artifactSha256);job=this.get(id);}
    // Alias keys must remain bound after the active job finishes as well.
    if(this.#db.prepare('SELECT count(*) AS n FROM requests WHERE job_id=?').get(job.id).n>=32)throw new ToolMaintenanceError(429,'Maintenance request alias capacity reached');
    this.#db.prepare('INSERT INTO requests VALUES (?,?)').run(requestId,job.id);return {job,deduplicated};
  });}
  claim(){return this.#transaction(()=>{
    if(this.halted()||this.#db.prepare("SELECT 1 FROM jobs WHERE status='running'").get())return null;
    const next=this.#db.prepare("SELECT id FROM jobs WHERE status='pending' ORDER BY rowid LIMIT 1").get();if(!next)return null;
    this.#db.prepare("UPDATE jobs SET status='running',updated_at=? WHERE id=?").run(new Date().toISOString(),next.id);return this.get(next.id);
  });}
  finish(id,result){maintenanceId(id);if(result){maintenanceId(result.validationId);if(typeof result.passed!=='boolean')throw new Error('Invalid validation outcome');}
    const changed=this.#db.prepare("UPDATE jobs SET status=?,updated_at=?,validation_id=?,passed=? WHERE id=? AND status='running'").run(result?'succeeded':'failed',new Date().toISOString(),result?.validationId??null,result?Number(result.passed):null,id);
    if(changed.changes!==1)throw new Error('Only running jobs can finish');return this.get(id);
  }
  failUnsafe(id){return this.#transaction(()=>{
    // Preserve a running recovery marker if either terminal persistence or
    // durable halt fails. Never commit failed while uncertain resources remain.
    const failed=this.finish(id,null);this.halt();return failed;
  });}
  interruptRunning(){return this.#transaction(()=>{
    const count=this.#db.prepare("UPDATE jobs SET status='interrupted',updated_at=? WHERE status='running'").run(new Date().toISOString()).changes;
    // A crashed runner may still own a KEEP_ALIVE container. Commit both the
    // interruption and pause together, even if a report was already persisted.
    if(count>0)this.halt();return count;
  });}
  close(){if(this.#db){this.#db.close();this.#db=undefined;}}
}
