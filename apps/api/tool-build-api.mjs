// Reference-shaped build routes on the existing private authenticated gateway.
import {randomUUID} from 'node:crypto';
import {builderRejectionEnvelope} from '../../packages/domain/sirna-tools/builder-rejection.mjs';
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const names={create:'create_tool_build_session',write:'write_tool_build_file',run:'run_tool_build_command',cancel:'cancel_tool_build_session',finalize:'finalize_tool_build',propose:'propose_exploration_tool'};
export function toolBuildRoute(method,url){
  if(url==='/v1/build-sessions'&&method==='POST')return {operation:'create',status:201};
  if(url==='/v1/tool-proposals'&&method==='POST')return {operation:'propose',status:201};
  const match=new RegExp(`^/v1/build-sessions/(${UUID})(?:/(files|exec|finalize))?$`).exec(url??'');
  if(!match)return undefined;
  const operation=({'PUT:files':'write','POST:exec':'run','POST:finalize':'finalize','DELETE:':'cancel'})[`${method}:${match[2]??''}`];
  return operation?{operation,sessionId:match[1],status:200}:undefined;
}
export function createToolBuildApi({builders,authorize,readBody,respond,track}={}){
  return async function handle(req,res){
    const route=toolBuildRoute(req.method,req.url);if(!route||!builders)return false;
    authorize(req,true);
    let args;
    if(route.operation==='cancel'){
      if(req.headers['transfer-encoding']!==undefined||Number(req.headers['content-length']??0)!==0)throw Object.assign(new Error('Unexpected body'),{status:400});args={};
    }else args=await readBody(req,1048576);
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.hasOwn(args,'sessionId'))throw Object.assign(new Error('Invalid builder request'),{status:400});
    const handle=authorize(req,true);
    const operation=handle.run(async()=>{
      const toolCallId=randomUUID();let success=false;
      try{
      if(handle.signal.aborted)throw Object.assign(new Error('Capability unavailable'),{status:401});
      const service=builders.acquire(handle);
      try{const result=await service[route.operation](route.sessionId?{...args,sessionId:route.sessionId}:args);success=true;return {status:route.status,value:result};}
      catch(error){
        const rejected=route.operation==='propose'?builderRejectionEnvelope(error):undefined;
        if(rejected)return {status:409,value:rejected};
        if(error?.status===409)throw error;
        // Diagnostics stay in owned journals. Unknown sessions cannot cross turns.
        const status=/Unknown build session|busy|limit reached|not running|cannot be|closed/.test(error.message)?409:400;
        throw Object.assign(new Error('Builder operation unavailable'),{status});
      }
      }finally{await handle.emit({type:'builder_tool_call',toolName:names[route.operation],toolCallId,agentRunId:handle.taskContext.agentRunId,success});}
    });
    await track(operation,async()=>{const result=await operation;respond(res,result.status,result.value);});return true;
  };
}
