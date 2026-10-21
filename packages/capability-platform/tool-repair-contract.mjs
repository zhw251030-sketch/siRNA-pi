import {isDeepStrictEqual,types} from 'node:util';
import {createHash} from 'node:crypto';
import {validateToolTaskContext} from './tool-run-audit.mjs';
import {repairContractViolation} from '../domain/sirna-tools/builder-rejection.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const repairRequestId=id=>`auto-tool-repair:${id}`;
export const repairHash=value=>createHash('sha256').update(value).digest('hex');
export function repairSource(value){
  const source=validateToolTaskContext(value);
  if(!source||source.agentRunId==='pending')throw new Error('An activated task source is required');
  return source;
}
export function repairAssociation(value){
  const fields=['requestId','rootProposalId','previousProposalId','attempt'];
  if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==fields.length)throw new Error('Invalid repair association');
  for(const field of fields){const d=Object.getOwnPropertyDescriptor(value,field);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw new Error('Invalid repair association');}
  if(!uuid.test(value.rootProposalId)||!uuid.test(value.previousProposalId)||value.requestId!==repairRequestId(value.previousProposalId)||!Number.isInteger(value.attempt)||value.attempt<1||value.attempt>3)throw new Error('Invalid repair lineage');
  return Object.fromEntries(fields.map(f=>[f,value[f]]));
}
export function frozenToolContract(input){
  const result={};
  for(const f of ['toolName','runtime','dependencies','permissions','repeatabilityMode','smokeInput','testCases','baseline','benchmarkCases'])result[f]=input[f];
  result.minNetGain=input.minNetGain??1;result.parent=input.parent??null;
  return result;
}
export function assertRepairContract(original,next){
  if(original.runtimeArtifact.buildSessionId===next.runtimeArtifact?.buildSessionId)throw new Error('Repair must preserve the original contract and use a new build session');
  const before=frozenToolContract(original),after=frozenToolContract(next);
  const changed=Object.keys(before).filter(f=>!isDeepStrictEqual(before[f],after[f])||f==='parent'&&Object.hasOwn(original,f)!==Object.hasOwn(next,f));
  if(changed.length)throw repairContractViolation(changed);
}
export function assertRepairPredecessor(current,previous,source,previousSource){
  if(!previousSource||source.taskId!==previousSource.taskId||source.executionSessionId!==previousSource.executionSessionId||source.sandboxId!==previousSource.sandboxId||
    current.attempt!==previous.attempt+1||current.rootProposalId!==previous.rootProposalId)throw new Error('Repair predecessor source or depth differs');
}
