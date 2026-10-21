import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validateToolTaskContext} from '../../capability-platform/tool-run-audit.mjs';
import {validateGapInput,validateGapReport,gapReportSha256,gapCapabilityKey,gapFail,assertGapJson} from './tool-gap-contract.mjs';
const APPLICATION_ID=0x53475031;
const SCHEMA=`CREATE TABLE gap_reports (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT NOT NULL,capability_key TEXT NOT NULL,report_sha256 TEXT NOT NULL,report_json TEXT NOT NULL CHECK(length(CAST(report_json AS BLOB))<=32768),UNIQUE(task_id,run_id,capability_key))`;
const IMMUTABLE=`CREATE TRIGGER gap_report_immutable BEFORE UPDATE ON gap_reports BEGIN SELECT RAISE(ABORT,'Tool gap report is immutable'); END`;
const NO_DELETE=`CREATE TRIGGER gap_report_no_delete BEFORE DELETE ON gap_reports BEGIN SELECT RAISE(ABORT,'Tool gap report is immutable'); END`;
function ordinary(file){const s=fs.lstatSync(file);if(s.isSymbolicLink()||!s.isFile()||s.nlink!==1||fs.realpathSync(file)!==file)throw Error('Invalid gap database path');}
function folder(root,readOnly){if(fs.realpathSync(root)!==root||!fs.lstatSync(root).isDirectory())throw Error('Invalid gap root');let current=root;for(const name of ['runtime','tool-gaps']){current=path.join(current,name);if(!fs.existsSync(current)&&!readOnly)fs.mkdirSync(current,{mode:0o700});if(fs.realpathSync(current)!==current||!fs.lstatSync(current).isDirectory())throw Error('Invalid gap directory');}return current;}
function rowReport(row){const report=validateGapReport(JSON.parse(row.report_json));if(report.id!==row.id||report.taskId!==row.task_id||report.runId!==row.run_id||report.capabilityKey!==row.capability_key||report.reportSha256!==row.report_sha256)gapFail(409);return report;}
export class ToolGapStore {
  #db;
  constructor({root,readOnly=false}){
    if(typeof root!=='string'||!path.isAbsolute(root))throw Error('Absolute gap root required');
    this.databasePath=path.join(folder(path.resolve(root),readOnly),'gaps.sqlite');
    let exists=false;try{fs.lstatSync(this.databasePath);exists=true;ordinary(this.databasePath);}catch(e){if(e.code!=='ENOENT')throw e;}
    for(const suffix of ['-wal','-shm','-journal'])try{ordinary(this.databasePath+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(readOnly&&!exists)throw Error('Gap database missing');
    this.#db=new DatabaseSync(this.databasePath,{readOnly});
    try{
      if(exists){
        const id=Object.values(this.#db.prepare('PRAGMA application_id').get())[0],version=Object.values(this.#db.prepare('PRAGMA user_version').get())[0];
        const objects=this.#db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.sql);
        if(id!==APPLICATION_ID||version!==1||JSON.stringify(objects)!==JSON.stringify([IMMUTABLE,NO_DELETE,SCHEMA]))throw Error('Unrecognized gap schema');
      }else {this.#db.exec(`BEGIN IMMEDIATE; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;${SCHEMA};${IMMUTABLE};${NO_DELETE};COMMIT;`);if(process.platform!=='win32')fs.chmodSync(this.databasePath,0o600);}
      this.#db.exec(`PRAGMA busy_timeout=5000;${readOnly?'':'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;'}`);
    }catch(e){this.#db.close();throw e;}
  }
  close(){this.#db.close();}
  list(taskId,runId){
    const bounds=this.#db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(report_json AS BLOB))),0) AS bytes FROM gap_reports WHERE task_id=? AND run_id=?').get(taskId,runId);
    if(bounds.n>10||bounds.bytes>32768)gapFail(413);
    const reports=this.#db.prepare('SELECT * FROM gap_reports WHERE task_id=? AND run_id=? ORDER BY rowid LIMIT 11').all(taskId,runId).map(rowReport);
    assertGapJson(reports,{maxDepth:24,maxBytes:32768});if(reports.length>10)gapFail(413);return reports;
  }
  create(input){
    assertGapJson(input,{maxDepth:20,maxBytes:65536});
    if(Object.keys(input).some(k=>!['capability','blocking','reason','desiredInput','desiredOutput','evidenceEventIds','taskId','runId','userMessageId','source'].includes(k)))gapFail(400);
    const business=validateGapInput(Object.fromEntries(Object.entries(input).filter(([k])=>!['taskId','runId','userMessageId','source'].includes(k))));
    let source;try{source=validateToolTaskContext(input.source);}catch{gapFail(409);}
    if(!source||input.taskId!==source.taskId||input.runId!==source.agentRunId||typeof input.userMessageId!=='string'||!input.userMessageId)gapFail(409);
    const capabilityKey=gapCapabilityKey(business.capability);
    this.#db.exec('BEGIN IMMEDIATE');try{
      const old=this.#db.prepare('SELECT * FROM gap_reports WHERE task_id=? AND run_id=? AND capability_key=?').get(input.taskId,input.runId,capabilityKey);
      if(old){const result={report:rowReport(old),deduplicated:true};this.#db.exec('COMMIT');return result;}
      const report={id:randomUUID(),taskId:input.taskId,runId:input.runId,userMessageId:input.userMessageId,...business,capabilityKey,createdAt:new Date().toISOString(),source};report.reportSha256=gapReportSha256(report);validateGapReport(report);
      const reports=this.list(input.taskId,input.runId);if(reports.length>=10)gapFail(413);assertGapJson([...reports,report],{maxDepth:24,maxBytes:32768});
      this.#db.prepare('INSERT INTO gap_reports VALUES(?,?,?,?,?,?)').run(report.id,report.taskId,report.runId,capabilityKey,report.reportSha256,JSON.stringify(report));this.#db.exec('COMMIT');return {report,deduplicated:false};
    }catch(e){this.#db.exec('ROLLBACK');throw e;}
  }
}
