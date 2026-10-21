// Only this narrow, fixed contract may cross the host/guest error boundary.
// Separate brands distinguish contract comparison, pre-intent admission, and
// validated HTTP feedback. Error properties/code/status alone prove nothing.
const fields=['toolName','runtime','dependencies','permissions','repeatabilityMode','smokeInput','testCases','baseline','benchmarkCases','minNetGain','parent'];
const violations=new WeakMap(),preIntent=new WeakMap(),remote=new WeakMap();
const version='sirna-builder-rejection/v1',code='repair_contract_mismatch',outcome='not_registered';
const message='Repair proposal was not registered. Restore the listed frozen fields from the original proposal, then submit using the same finalized build. If the original proposal has no parent, omit parent. parent identifies a formal tool version, not the previous repair proposal.';
function selected(value){
  if(!Array.isArray(value)||!value.length||value.length>fields.length||value.some(f=>!fields.includes(f))||new Set(value).size!==value.length)return undefined;
  return fields.filter(f=>value.includes(f));
}
function branded(store,value){const error=new Error('Repair frozen contract differs');store.set(error,Object.freeze([...value]));return error;}
function envelope(value){return {error:{protocolVersion:version,code,outcome,fields:[...value]}};}
export function repairContractViolation(value){const safe=selected(value);if(!safe)throw new TypeError('Invalid contract fields');return branded(violations,safe);}
// Called only around registrationPolicy before any proposal_submit intent.
export function confirmRepairPreIntent(error){const value=violations.get(error);return value?branded(preIntent,value):undefined;}
export function builderRejectionEnvelope(error){const value=preIntent.get(error);return value?envelope(value):undefined;}
function exact(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));}
export function readBuilderRejection(value){
  if(!exact(value,['error'])||!exact(value.error,['protocolVersion','code','outcome','fields']))return undefined;
  const e=value.error,safe=selected(e.fields);
  if(!safe||e.protocolVersion!==version||e.code!==code||e.outcome!==outcome)return undefined;
  return branded(remote,safe);
}
export function builderRejectionContent(error){const value=remote.get(error);return value?JSON.stringify({...envelope(value).error,message}):undefined;}
