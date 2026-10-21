import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {ToolCurationStore} from '../packages/extensions/tool-curation/tool-curation-store.mjs';
import {buildToolCurationTrace,traceSha256} from '../packages/extensions/tool-curation/tool-curation-evidence.mjs';
import {buildCurationPreview} from '../packages/extensions/tool-curation/tool-curation-trace.mjs';
function trace(){const taskId=randomUUID(),runId=randomUUID(),userMessageId=randomUUID();const events=[];for(let i=0;i<3;i++){const common={taskId,runId,userMessageId,createdAt:'2026-10-21T00:00:00.000Z'};events.push({...common,id:`s${i}`,type:'tool_start',payload:{toolCallId:`c${i}`,toolName:'calculate',args:{x:i}}},{...common,id:`e${i}`,type:'tool_end',payload:{toolCallId:`c${i}`,toolName:'calculate',isError:false,result:{x:i}}});}return buildToolCurationTrace({id:randomUUID(),snapshot:{preview:buildCurationPreview({taskId,runId,userMessageId,events,existingTools:[]}),events,existingTools:[]}});}
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'curation-store-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('durable unique binding and immutable SQL trace survive readonly reopen',t=>{
  const root=fixture(t),store=new ToolCurationStore({root}),evidence=trace(),duplicate={...evidence,curationId:randomUUID()};duplicate.traceSha256=traceSha256(duplicate);const first=store.create(evidence),again=store.create(duplicate);assert.equal(first.curation.id,again.curation.id);assert.equal(again.deduplicated,true);
  const db=new DatabaseSync(store.databasePath);assert.throws(()=>db.prepare('UPDATE curations SET trace_json = ? WHERE id = ?').run('{}',first.curation.id),/immutable/i);db.close();store.close();
  const readonly=new ToolCurationStore({root,readOnly:true});assert.deepEqual(readonly.get(evidence.taskId,first.curation.id).trace,evidence);assert.throws(()=>readonly.create(trace()));readonly.close();
});
test('read paths reject corrupted frozen bytes instead of returning an unverified trace',t=>{
  const root=fixture(t),store=new ToolCurationStore({root}),record=store.create(trace()).curation;
  const db=new DatabaseSync(store.databasePath);db.exec('DROP TRIGGER curation_trace_immutable');const changed={...record.trace,objective:'changed'};
  db.prepare('UPDATE curations SET trace_json=? WHERE id=?').run(JSON.stringify(changed),record.id);db.close();
  assert.throws(()=>store.get(record.taskId,record.id),/digest|hash|frozen/i);assert.throws(()=>store.list(record.taskId),/digest|hash|frozen/i);store.close();
});
test('identity cannot be rebound and list remains bounded without frozen payloads',t=>{
  const root=fixture(t),store=new ToolCurationStore({root}),one=store.create(trace()).curation;store.markRunning(one.id);store.setIdentity(one.id,'session');store.setIdentity(one.id,'session','run');store.setIdentity(one.id,'session');
  assert.throws(()=>store.setIdentity(one.id,'other','run'),/immutable/);assert.throws(()=>store.setIdentity(one.id,'session','other'),/immutable/);assert.equal(store.get(one.taskId,one.id).curatorRunId,'run');
  for(let i=0;i<101;i++){const item=trace();item.taskId=one.taskId;item.traceSha256=traceSha256(item);store.create(item);}
  const listed=store.list(one.taskId);assert.equal(listed.length,100);assert.ok(listed.every(r=>!('trace' in r)));store.close();
});
test('startup recovery errors old waiting/running records without dispatch or changing frozen bytes',t=>{
  const root=fixture(t),store=new ToolCurationStore({root}),a=store.create(trace()).curation,b=store.create(trace()).curation;store.markRunning(b.id);store.setIdentity(b.id,'session-x','run-x');store.close();
  const next=new ToolCurationStore({root});next.recoverInterrupted();for(const old of [a,b]){const row=next.get(old.taskId,old.id);assert.equal(row.status,'error');assert.deepEqual(row.trace,old.trace);assert.match(row.error,/unconfirmed/i);}assert.equal(next.isAdmissionHalted(),true);next.recoverAdmission();assert.equal(next.isAdmissionHalted(),false);next.close();
});
test('unrecognized databases and unsafe symlink parents are refused without schema mutation',t=>{
  const root=fixture(t);fs.mkdirSync(path.join(root,'runtime','tool-curation'),{recursive:true});const file=path.join(root,'runtime','tool-curation','curation.sqlite'),db=new DatabaseSync(file);db.exec('CREATE TABLE business (value TEXT)');db.close();assert.throws(()=>new ToolCurationStore({root}),/schema|recognized/i);
  const check=new DatabaseSync(file);assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name),['business']);check.close();
  const linked=fixture(t),target=fixture(t);fs.symlinkSync(target,path.join(linked,'runtime'),process.platform==='win32'?'junction':'dir');assert.throws(()=>new ToolCurationStore({root:linked}),/directory|path/i);
});
test('linked SQLite sidecars are refused before SQLite can follow them',t=>{
  const root=fixture(t),store=new ToolCurationStore({root}),file=store.databasePath;store.close();const targetRoot=fixture(t),target=path.join(targetRoot,'outside');fs.writeFileSync(target,'preserved');
  fs.symlinkSync(process.platform==='win32'?targetRoot:target,`${file}-wal`,process.platform==='win32'?'junction':undefined);assert.throws(()=>new ToolCurationStore({root}),/path/i);assert.equal(fs.readFileSync(target,'utf8'),'preserved');
});
test('dangling database link is rejected without creating a database outside its root',t=>{
  const root=fixture(t),outside=path.join(fixture(t),'must-not-exist.sqlite');fs.mkdirSync(path.join(root,'runtime','tool-curation'),{recursive:true});
  const file=path.join(root,'runtime','tool-curation','curation.sqlite');
  try{fs.symlinkSync(outside,file,process.platform==='win32'?'file':undefined);}catch(error){if(process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)){t.skip('Windows file symlink privilege unavailable; Linux must run this regression.');return;}throw error;}
  let opened;try{assert.throws(()=>{opened=new ToolCurationStore({root});},/path/i);}finally{opened?.close();}
  assert.equal(fs.existsSync(outside),false);
});
for(const suffix of ['', '-wal','-shm','-journal'])test(`hardlinked SQLite ${suffix||'database'} cannot mutate an unrelated file`,t=>{
  const root=fixture(t),initial=new ToolCurationStore({root}),file=initial.databasePath;initial.close();
  const outside=path.join(fixture(t),'unrelated');
  if(suffix){fs.writeFileSync(outside,Buffer.alloc(4096,0x61));fs.linkSync(outside,file+suffix);}
  else fs.linkSync(file,outside);
  const original=fs.readFileSync(outside);let opened;
  try{assert.throws(()=>{opened=new ToolCurationStore({root});},/path/i);}finally{opened?.close();}
  assert.deepEqual(fs.readFileSync(outside),original);
});
