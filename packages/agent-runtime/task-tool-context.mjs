// A guest-readable, one-turn capability. Never include its bytes in model prompts.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {executionId} from './compose-session-store.mjs';

function check(ok) { if(!ok) throw new Error('Invalid task tool context'); }
function read(file) {
  const s=fs.lstatSync(file);
  check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=4096&&fs.realpathSync(file)===file);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try { const current=fs.fstatSync(fd);check(current.dev===s.dev&&current.ino===s.ino);return fs.readFileSync(fd,'utf8'); }
  finally { fs.closeSync(fd); }
}
export function writeTaskToolContext({root,workspacePath,context}) {
  root=path.resolve(root);
  check(fs.realpathSync(root)===root&&/^runtime\/agent-compose\/data\/sandboxes\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{64}\/workspace$/.test(workspacePath));
  let directory=root;
  for(const part of workspacePath.split('/')) {
    directory=path.join(directory,part);check(fs.realpathSync(directory)===directory&&fs.lstatSync(directory).isDirectory());
  }
  check(context&&context.protocolVersion==='sirna-task-context/v1'&&executionId.test(context.taskId)&&executionId.test(context.agentTurnId)&&/^[a-f0-9]{64}$/.test(context.token));
  check(Object.keys(context).sort().join(',')==='agentTurnId,protocolVersion,taskId,token');
  const file=path.join(directory,'.sirna-task-context.json');
  let previous;
  try { previous=read(file); } catch(error) { if(error.code!=='ENOENT')throw error; }
  if(previous!==undefined) {
    const saved=JSON.parse(previous);check(saved.protocolVersion==='sirna-task-context/v1'&&saved.taskId===context.taskId);
  }
  const bytes=JSON.stringify(context)+'\n';const staging=path.join(directory,`.sirna-task-context.${randomUUID()}.tmp`);
  const fd=fs.openSync(staging,'wx',0o600);
  try { fs.writeFileSync(fd,bytes);fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // Same-UID hostile filesystem writers are outside the project trust boundary.
  fs.renameSync(staging,file);
  let removed=false;
  return () => {
    if(removed)return;
    if(read(file)!==bytes)throw new Error('Task tool context changed before cleanup');
    fs.unlinkSync(file);removed=true;
  };
}
