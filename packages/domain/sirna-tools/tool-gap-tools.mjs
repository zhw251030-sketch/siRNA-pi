const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=value=>typeof value==='string'&&value.length>0;
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
// Public wire validation also binds the only two identities known inside guest.
export function validateToolGapResponse(value,status,context){
  if(!exact(value,['report','deduplicated','candidateCreated','toolCreated','nextGate'])||typeof value.deduplicated!=='boolean'||status!==(value.deduplicated?200:202)||value.candidateCreated!==false||value.toolCreated!==false||value.nextGate!=='finish_current_turn_then_manual_curator_review')throw Error('Invalid report response');
  const r=value.report;
  if(!exact(r,['id','taskId','runId','userMessageId','capability','capabilityKey','blocking','reason','desiredInput','desiredOutput','evidenceEventIds','createdAt','source','reportSha256'])||!['id','taskId','runId','userMessageId','capability','capabilityKey','reason','createdAt'].every(key=>text(r[key]))||typeof r.blocking!=='boolean'||!object(r.desiredInput)||!object(r.desiredOutput)||!Array.isArray(r.evidenceEventIds)||r.evidenceEventIds.some(id=>!text(id))||!/^[a-f0-9]{64}$/.test(r.reportSha256))throw Error('Invalid report response');
  if(!exact(r.source,['taskId','executionSessionId','sandboxId','agentTurnId','agentRunId'])||Object.values(r.source).some(v=>!text(v))||r.source.taskId!==r.taskId||r.source.agentRunId!==r.runId||r.taskId!==context.taskId||r.source.agentTurnId!==context.agentTurnId)throw Error('Invalid report identity');
  if(!['id','taskId','userMessageId'].every(key=>uuid(r[key]))||!['taskId','executionSessionId','agentTurnId'].every(key=>uuid(r.source[key]))||!/^[a-f0-9]{64}$/.test(r.source.sandboxId)||!/^[A-Za-z0-9_-]{1,256}$/.test(r.runId)||!Number.isFinite(Date.parse(r.createdAt)))throw Error('Invalid report identity');
  return value;
}
export function createToolGapTools({service}={}){
  if(typeof service?.report!=='function')throw new TypeError('Explicit report service required');
  return [{name:'report_tool_gap',label:'Report a reusable tool gap',description:'Report a missing reusable capability evidenced in this task. This saves an Agent claim only; blocking is your judgment. Does not create, build, approve or enable tools. Finish this turn, then a human may explicitly request independent Curator review.',
    parameters:{type:'object',additionalProperties:false,required:['capability','blocking','reason','desiredInput','desiredOutput'],properties:{capability:{type:'string',minLength:3,maxLength:500},blocking:{type:'boolean'},reason:{type:'string',minLength:3,maxLength:4000},desiredInput:{type:'object'},desiredOutput:{type:'object'},evidenceEventIds:{type:'array',maxItems:100,uniqueItems:true,items:{type:'string',minLength:1,maxLength:500}}}},executionMode:'sequential',
    execute:async(_id,args,signal)=>({content:[{type:'text',text:JSON.stringify(await service.report(args,signal))}]})}];
}
