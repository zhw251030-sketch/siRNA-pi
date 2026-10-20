import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {writeTaskToolContext} from '../packages/agent-runtime/task-tool-context.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tool-context-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspacePath='runtime/agent-compose/data/sandboxes/2026/10/21/'+ 'a'.repeat(64)+'/workspace';
  fs.mkdirSync(path.join(root,workspacePath),{recursive:true});
  const context={protocolVersion:'sirna-task-context/v1',taskId:randomUUID(),agentTurnId:randomUUID(),token:'c'.repeat(64)};
  return {root,workspacePath,context,file:path.join(root,workspacePath,'.sirna-task-context.json')};
}
test('context is private, renewable for same task and cleanup does not erase a newer turn',t=>{
  const f=fixture(t); const remove=writeTaskToolContext(f);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file,'utf8')),f.context);
  if(process.platform!=='win32')assert.equal(fs.statSync(f.file).mode&0o777,0o600);
  const next={...f.context,agentTurnId:randomUUID(),token:'d'.repeat(64)};
  const removeNext=writeTaskToolContext({...f,context:next});
  assert.throws(remove,/changed/); assert.deepEqual(JSON.parse(fs.readFileSync(f.file,'utf8')),next);
  removeNext(); assert.equal(fs.existsSync(f.file),false);
});
test('context rejects foreign task, bad path, hard links and invalid credentials before mutation',t=>{
  const f=fixture(t); writeTaskToolContext(f);
  assert.throws(()=>writeTaskToolContext({...f,context:{...f.context,taskId:randomUUID()}}));
  assert.throws(()=>writeTaskToolContext({...f,workspacePath:'../outside'}));
  assert.throws(()=>writeTaskToolContext({...f,context:{...f.context,token:'bad'}}));
  const linked=path.join(f.root,'link'); fs.linkSync(f.file,linked);
  assert.throws(()=>writeTaskToolContext(f));
  assert.equal(fs.readFileSync(linked,'utf8'),fs.readFileSync(f.file,'utf8'));
});
