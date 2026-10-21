import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {TaskStore} from '../../packages/task-core/task-store.mjs';
import {ToolCurationStore} from '../../packages/extensions/tool-curation/tool-curation-store.mjs';
export const gapInput=(extra={})=>({capability:'Compare RNA structures',blocking:false,reason:'No existing tool compares these structures.',desiredInput:{structures:['string']},desiredOutput:{distance:'number'},...extra});
export function gapFixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sirna-gap-'))),tasks=new TaskStore(path.join(root,'tasks.sqlite')),curations=new ToolCurationStore({root});
  const task=tasks.createTask({id:randomUUID()}),{message}=tasks.beginTurn(task.id,'Compare two RNA structures'),runId=randomUUID();tasks.updateExecution(task.id,{currentRunId:runId});
  const event=tasks.appendRunEvent(task.id,message.id,runId,'run_status',{status:'running'});
  const context={taskId:task.id,executionSessionId:task.executionSessionId,sandboxId:'a'.repeat(64),agentTurnId:randomUUID(),agentRunId:runId};
  const closers=[];t.after(()=>{for(const close of closers.reverse())close();curations.close();tasks.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,tasks,curations,task,message,runId,event,context,closers,finish(){tasks.appendRunEvent(task.id,message.id,runId,'done',{status:'succeeded'});tasks.appendAssistantMessage(task.id,'Finished','complete');}};
}
