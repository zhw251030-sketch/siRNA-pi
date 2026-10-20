const string={type:'string'};
const sessionId={type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'};
const schema=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const cases={type:'array',minItems:1,maxItems:100,items:schema({name:{type:'string',minLength:3,maxLength:120},input:{type:'object'},expectedOutput:{type:'object',minProperties:1}})};
const proposalSchema=schema({name:{type:'string',minLength:3,maxLength:80},toolName:{type:'string',pattern:'^[a-z][a-z0-9_]{0,63}$'},description:{type:'string',minLength:10,maxLength:1000},runtime:{enum:['node']},script:{type:'string',minLength:1,maxLength:200000},repeatabilityMode:{enum:['exact']},smokeInput:{type:'object',minProperties:1},dependencies:{type:'array',maxItems:0},testCases:cases,baseline:schema({runtime:{enum:['bash','python','node']},script:{type:'string',minLength:1,maxLength:200000}}),benchmarkCases:cases,minNetGain:{type:'integer',minimum:1,maximum:100},parent:schema({toolName:{type:'string',pattern:'^[a-z][a-z0-9_]{0,63}$'},version:{type:'string',pattern:'^\\d+\\.\\d+\\.\\d+$'}}),permissions:schema({profile:{enum:['no_external_access']}}),runtimeArtifact:schema({protocolVersion:{const:'sirna-tool-runtime-artifact/v1'},imageDigest:{type:'string',pattern:'^sha256:[0-9a-f]{64}$'},command:{type:'array',items:string,minItems:2,maxItems:2},platform:{const:'linux/amd64'},createdAt:string,buildSessionId:sessionId})},['name','toolName','description','runtime','script','repeatabilityMode','smokeInput','dependencies','testCases','baseline','benchmarkCases','permissions','runtimeArtifact']);

export function createToolBuilderTools({service}={}){
 if(!service)throw new TypeError('Explicit builder service required');
 return [
  ['create_tool_build_session','Create a disposable fixed Node build session. No network, installations or host access.',schema({}),'create'],
  ['write_tool_build_file','Replace the single declared UTF-8 source /opt/tool/main.mjs. Invalidates previous debug success.',schema({sessionId,path:{const:'/opt/tool/main.mjs',type:'string'},content:{type:'string',minLength:1,maxLength:200000}}),'write'],
  ['run_tool_build_command','Run a shell string inside the owned disposable container as 65534. No network or host mounts. Success is debugging, not verification.',schema({sessionId,command:{type:'string',minLength:1,maxLength:20000},timeoutMs:{type:'integer',minimum:100,maximum:30000,default:10000}},['sessionId','command']),'run'],
  ['cancel_tool_build_session','Cancel an unfinished owned build session and report cleanup confirmation.',schema({sessionId}),'cancel'],
  ['finalize_tool_build','Package only declared source into a clean fixed-base immutable image. Requires successful debug since write. Command must be /usr/bin/node /opt/tool/main.mjs. No verification or approval.',schema({sessionId,command:{type:'array',items:string,minItems:2,maxItems:2}}),'finalize'],
  ['propose_exploration_tool','Submit a complete flat proposal with this service’s exact finalized source and artifact. Submission never validates, approves or activates.',proposalSchema,'propose'],
 ].map(([name,description,parameters,method])=>({name,label:name,description,parameters,executionMode:'sequential',
   execute:async(_id,args,signal)=>{const result=await service[method](args,signal);return {content:[{type:'text',text:JSON.stringify(result)}]};}}));
}
