import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {assertCurationJson,TOOL_CURATION_TRACE_PROTOCOL,traceSha256} from './tool-curation-evidence.mjs';
import {validateToolCurationResult} from './tool-curation-result.mjs';

const APPLICATION_ID=0x53435431;
const now=()=>new Date().toISOString();
function directory(root,relative,readOnly){
  let current=root;
  if(!path.isAbsolute(root)||fs.realpathSync(root)!==root||!fs.statSync(root).isDirectory())throw Error('Invalid project directory path');
  for(const name of relative.split('/')){
    current=path.join(current,name);
    if(!fs.existsSync(current)&&!readOnly)fs.mkdirSync(current,{mode:0o700});
    if(fs.realpathSync(current)!==current||!fs.lstatSync(current).isDirectory())throw Error('Invalid curation directory path');
  }
  return current;
}
function rowRecord(row,full=true){
  if(!row)return undefined;
  const trace=JSON.parse(row.trace_json);
  assertCurationJson(trace,{maxDepth:32,maxBytes:65536});
  if(trace.traceSha256!==row.trace_sha256||traceSha256(trace)!==row.trace_sha256||trace.curationId!==row.id||trace.taskId!==row.task_id||trace.runId!==row.run_id||trace.userMessageId!==row.user_message_id||trace.sourceSha256!==row.source_sha256||trace.previewSha256!==row.preview_sha256)throw Error('Frozen trace digest or binding mismatch');
  if(!['post_run','online_gap'].includes(trace.trigger))throw Error('Invalid frozen trigger');
  const record={id:row.id,taskId:row.task_id,runId:row.run_id,userMessageId:row.user_message_id,trigger:trace.trigger,status:row.status,sourceSha256:row.source_sha256,previewSha256:row.preview_sha256,traceSha256:row.trace_sha256,requestedAt:row.requested_at};
  for(const [key,column] of Object.entries({startedAt:'started_at',completedAt:'completed_at',curatorSessionId:'curator_session_id',curatorRunId:'curator_run_id',error:'error'}))if(row[column]!==null)record[key]=row[column];
  if(full)record.trace=trace;
  if(row.result_json!==null)record.result=JSON.parse(row.result_json);
  return record;
}

export class ToolCurationStore {
  #db;
  constructor({root,readOnly=false}){
    if(typeof root!=='string'||!path.isAbsolute(root))throw Error('An absolute project root is required');
    const folder=directory(path.resolve(root),'runtime/tool-curation',readOnly);
    this.databasePath=path.join(folder,'curation.sqlite');
    let databaseStat;
    try{databaseStat=fs.lstatSync(this.databasePath);}catch(error){if(error.code!=='ENOENT')throw error;}
    const exists=databaseStat!==undefined;
    if(exists && (databaseStat.isSymbolicLink() || !databaseStat.isFile() || databaseStat.nlink!==1 || fs.realpathSync(this.databasePath)!==this.databasePath))throw Error('Invalid curation database path');
    for(const suffix of ['-wal','-shm','-journal']){
      const sidecar=this.databasePath+suffix;
      let stat;try{stat=fs.lstatSync(sidecar);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||fs.realpathSync(sidecar)!==sidecar)throw Error('Invalid SQLite sidecar path');
    }
    if(readOnly&&!exists)throw Error('Curation database does not exist');
    this.#db=new DatabaseSync(this.databasePath,{readOnly});
    try{
      if(exists){
        const id=Object.values(this.#db.prepare('PRAGMA application_id').get())[0],version=Object.values(this.#db.prepare('PRAGMA user_version').get())[0];
        const tables=this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);
        if(id!==APPLICATION_ID||version!==1||JSON.stringify(tables)!==JSON.stringify(['curation_meta','curations']))throw Error('Unrecognized curation database schema');
        const columns=this.#db.prepare('PRAGMA table_info(curations)').all().map(r=>r.name);
        if(JSON.stringify(columns)!==JSON.stringify(['id','task_id','run_id','user_message_id','source_sha256','preview_sha256','trace_sha256','trace_json','status','requested_at','started_at','completed_at','curator_session_id','curator_run_id','result_json','error']))throw Error('Unrecognized curation database schema');
        if(this.#db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('curation_trace_immutable','curation_identity_immutable')").get().n!==2)throw Error('Unrecognized curation schema guards');
      }else{
        this.#db.exec(`BEGIN IMMEDIATE;
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
          CREATE TABLE curation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO curation_meta VALUES ('admission_halted','0');
          CREATE TABLE curations (
            id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, user_message_id TEXT NOT NULL,
            source_sha256 TEXT NOT NULL, preview_sha256 TEXT NOT NULL, trace_sha256 TEXT NOT NULL,
            trace_json TEXT NOT NULL CHECK(length(CAST(trace_json AS BLOB))<=65536),
            status TEXT NOT NULL CHECK(status IN ('waiting','running','skipped','candidate','error')),
            requested_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
            curator_session_id TEXT, curator_run_id TEXT, result_json TEXT, error TEXT,
            UNIQUE(task_id,run_id)
          );
          CREATE TRIGGER curation_trace_immutable BEFORE UPDATE OF id,task_id,run_id,user_message_id,source_sha256,preview_sha256,trace_sha256,trace_json,requested_at ON curations
            BEGIN SELECT RAISE(ABORT,'Frozen curation trace is immutable'); END;
          CREATE TRIGGER curation_identity_immutable BEFORE UPDATE OF curator_session_id,curator_run_id ON curations
            WHEN (OLD.curator_session_id IS NOT NULL AND NEW.curator_session_id IS NOT OLD.curator_session_id)
              OR (OLD.curator_run_id IS NOT NULL AND NEW.curator_run_id IS NOT OLD.curator_run_id)
            BEGIN SELECT RAISE(ABORT,'Curator identity is immutable'); END;
          COMMIT;`);
        if(process.platform!=='win32')fs.chmodSync(this.databasePath,0o600);
      }
      this.#db.exec(`PRAGMA busy_timeout=5000;${readOnly?'':'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'}`);
    }catch(error){this.#db.close();throw error;}
  }
  close(){this.#db.close();}
  #transaction(action){this.#db.exec('BEGIN IMMEDIATE');try{const result=action();this.#db.exec('COMMIT');return result;}catch(e){this.#db.exec('ROLLBACK');throw e;}}
  #byId(id){return rowRecord(this.#db.prepare('SELECT * FROM curations WHERE id=?').get(id));}
  get(taskId,id){return rowRecord(this.#db.prepare('SELECT * FROM curations WHERE task_id=? AND id=?').get(taskId,id));}
  find(taskId,runId){return rowRecord(this.#db.prepare('SELECT * FROM curations WHERE task_id=? AND run_id=?').get(taskId,runId));}
  list(taskId){return this.#db.prepare('SELECT * FROM curations WHERE task_id=? ORDER BY requested_at DESC,id DESC LIMIT 100').all(taskId).map(r=>rowRecord(r,false));}
  findRecentCandidate(capabilityKey,{excludeId,since,until}){
    const time=value=>typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;
    const lower=time(since),upper=time(until);
    if(typeof capabilityKey!=='string'||!capabilityKey||typeof excludeId!=='string'||!Number.isFinite(lower)||!Number.isFinite(upper)||lower>upper)throw Error('Invalid candidate cooldown lookup');
    // The display list is capped at 100. Inspect durable candidates directly,
    // validating stored bindings before deciding they cannot be a duplicate.
    for(const row of this.#db.prepare("SELECT * FROM curations WHERE status='candidate' AND id!=? ORDER BY completed_at DESC,id DESC").iterate(excludeId)){
      const candidate=rowRecord(row),completedAt=Date.parse(candidate.completedAt);
      const result=validateToolCurationResult(candidate,candidate.result);
      if(result.decision!=='candidate'||!Number.isFinite(completedAt))throw Error('Invalid persisted candidate');
      if(completedAt>=lower&&completedAt<=upper&&result.candidate.capabilityKey===capabilityKey)return candidate;
    }
    return undefined;
  }
  create(trace){
    assertCurationJson(trace,{maxDepth:32,maxBytes:65536});
    if(trace.protocolVersion!==TOOL_CURATION_TRACE_PROTOCOL||!['post_run','online_gap'].includes(trace.trigger)||trace.traceSha256!==traceSha256(trace))throw Error('Invalid frozen trace');
    for(const field of ['curationId','taskId','runId','userMessageId','sourceSha256','previewSha256'])if(typeof trace[field]!=='string'||!trace[field])throw Error('Incomplete frozen trace binding');
    return this.#transaction(()=>{
      const old=this.find(trace.taskId,trace.runId);
      if(old){if(old.sourceSha256!==trace.sourceSha256||old.previewSha256!==trace.previewSha256)throw Error('Curation binding conflict');return {curation:old,deduplicated:true};}
      this.#db.prepare(`INSERT INTO curations(id,task_id,run_id,user_message_id,source_sha256,preview_sha256,trace_sha256,trace_json,status,requested_at) VALUES(?,?,?,?,?,?,?,?,'waiting',?)`)
        .run(trace.curationId,trace.taskId,trace.runId,trace.userMessageId,trace.sourceSha256,trace.previewSha256,trace.traceSha256,JSON.stringify(trace),now());
      return {curation:this.#byId(trace.curationId),deduplicated:false};
    });
  }
  markRunning(id){const changed=this.#db.prepare("UPDATE curations SET status='running',started_at=? WHERE id=? AND status='waiting'").run(now(),id);if(changed.changes!==1)throw Error('Curation cannot start');return this.#byId(id);}
  setIdentity(id,sessionId,runId){
    if(typeof sessionId!=='string'||!sessionId.trim()||sessionId.length>256||runId!==undefined&&(typeof runId!=='string'||!runId.trim()||runId.length>256))throw Error('Invalid curator identity');
    const row=this.#byId(id);if(!row||row.status!=='running')throw Error('Curation is not running');
    this.#db.prepare('UPDATE curations SET curator_session_id=?,curator_run_id=COALESCE(?,curator_run_id) WHERE id=?').run(sessionId,runId??null,id);
  }
  complete(id,result){
    assertCurationJson(result,{maxDepth:16,maxBytes:49152});
    if(!['skip','candidate'].includes(result.decision))throw Error('Invalid terminal result');
    const changed=this.#db.prepare('UPDATE curations SET status=?,result_json=?,completed_at=? WHERE id=? AND status=\'running\'').run(result.decision==='skip'?'skipped':'candidate',JSON.stringify(result),now(),id);
    if(changed.changes!==1)throw Error('Curation cannot complete');
  }
  fail(id,{halt=false,message='Independent curator failed; no retry was attempted.'}={}){
    this.#transaction(()=>{this.#db.prepare("UPDATE curations SET status='error',error=?,completed_at=? WHERE id=? AND status IN ('waiting','running')").run(message,now(),id);if(halt)this.#db.prepare("UPDATE curation_meta SET value='1' WHERE key='admission_halted'").run();});
  }
  isAdmissionHalted(){return this.#db.prepare("SELECT value FROM curation_meta WHERE key='admission_halted'").get()?.value!=='0';}
  haltAdmission(){this.#db.prepare("UPDATE curation_meta SET value='1' WHERE key='admission_halted'").run();}
  recoverInterrupted(){
    return this.#transaction(()=>{const changed=this.#db.prepare("UPDATE curations SET status='error',error='Interrupted curation; execution outcome unconfirmed. Operator recovery required; never retried.',completed_at=? WHERE status IN ('waiting','running')").run(now()).changes;if(changed)this.#db.prepare("UPDATE curation_meta SET value='1' WHERE key='admission_halted'").run();return Number(changed);});
  }
  // Deliberately operator-only. The service and HTTP layer must never call it.
  recoverAdmission(){this.#db.prepare("UPDATE curation_meta SET value='0' WHERE key='admission_halted'").run();}
}
