// Explicit reports are claims, not permission grants or proof of a real gap.
// Fields follow reference 67d2754. Local keys retain all Unicode letters/numbers
// and reject empty names; the reference retains ASCII/basic CJK and has a fallback.
// Local trusted-source binding is also stricter.
import {types} from 'node:util';
import {assertCurationJson,curationSha256,record} from './tool-curation-evidence.mjs';
import {sanitizeCurationEvidence} from './tool-curation-trace.mjs';
import {validateToolTaskContext} from '../../capability-platform/tool-run-audit.mjs';

const messages={400:'Invalid tool gap report.',404:'Tool gap task or run was not found.',409:'Tool gap report conflicts with the current task evidence.',413:'Tool gap report exceeds the bounded evidence envelope.',503:'Tool gap persistence is unavailable.'};
export class ToolGapError extends Error {constructor(statusCode){super(messages[statusCode]??messages[503]);this.statusCode=Object.hasOwn(messages,statusCode)?statusCode:503;}}
export const gapFail=status=>{throw new ToolGapError(status);};
export const gapCapabilityKey=capability=>capability.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,160);
export function assertGapJson(value,options){
  const seen=new Set();
  function proxies(v,depth=0){if(v&&typeof v==='object'){if(types.isProxy(v)||depth>(options?.maxDepth??16))gapFail(400);if(seen.has(v))return;seen.add(v);for(const d of Object.values(Object.getOwnPropertyDescriptors(v)))if(Object.hasOwn(d,'value'))proxies(d.value,depth+1);}}
  // Inspect descriptors before JSON validation can invoke a nested proxy trap.
  try{proxies(value);assertCurationJson(value,options);}catch(e){if(e instanceof ToolGapError)throw e;gapFail(e instanceof RangeError?413:400);}
}
export function validateGapInput(input){
  assertGapJson(input,{maxDepth:16,maxBytes:32768});
  if(!record(input)||Object.keys(input).some(k=>!['capability','blocking','reason','desiredInput','desiredOutput','evidenceEventIds'].includes(k)))gapFail(400);
  for(const [field,min,max] of [['capability',3,500],['reason',3,4000]])if(typeof input[field]!=='string'||input[field].trim().length<min||input[field].trim().length>max)gapFail(400);
  if(typeof input.blocking!=='boolean')gapFail(400);
  for(const field of ['desiredInput','desiredOutput']){if(!record(input[field]))gapFail(400);assertGapJson(input[field],{maxDepth:16,maxBytes:4096});}
  const refs=Object.hasOwn(input,'evidenceEventIds')?input.evidenceEventIds:[];
  if(!Array.isArray(refs)||refs.length>100||new Set(refs).size!==refs.length||refs.some(v=>typeof v!=='string'||!v.trim()||v.length>500))gapFail(400);
  const safe=sanitizeCurationEvidence({...input,capability:input.capability.trim(),reason:input.reason.trim(),evidenceEventIds:refs},'',0,{complete:true});
  if(!gapCapabilityKey(safe.capability))gapFail(400);
  return safe;
}
export function gapReportSha256(report){const {reportSha256:ignored,...body}=report;return curationSha256(body);}
export function validateGapReport(report){
  assertGapJson(report,{maxDepth:20,maxBytes:32768});
  const fields=['id','taskId','runId','userMessageId','capability','capabilityKey','blocking','reason','desiredInput','desiredOutput','evidenceEventIds','createdAt','source','reportSha256'];
  if(!record(report)||Object.keys(report).length!==fields.length||fields.some(k=>!Object.hasOwn(report,k)))gapFail(409);
  const input=Object.fromEntries(['capability','blocking','reason','desiredInput','desiredOutput','evidenceEventIds'].map(k=>[k,report[k]]));
  if(curationSha256(validateGapInput(input))!==curationSha256(input))gapFail(409);
  let source;try{source=validateToolTaskContext(report.source);}catch{gapFail(409);}
  if(!source||source.taskId!==report.taskId||source.agentRunId!==report.runId||typeof report.userMessageId!=='string'||!report.userMessageId||!/^[a-f0-9-]{36}$/.test(report.id)||typeof report.createdAt!=='string'||!Number.isFinite(Date.parse(report.createdAt))||report.capabilityKey!==gapCapabilityKey(report.capability)||report.reportSha256!==gapReportSha256(report))gapFail(409);
  return structuredClone(report);
}
export function validateGapReports(reports,{taskId,runId,userMessageId,events}){
  assertGapJson(reports,{maxDepth:24,maxBytes:32768});
  if(!Array.isArray(reports)||reports.length>10)gapFail(413);
  if(events.some(e=>e.taskId!==taskId||e.runId!==runId||e.userMessageId!==userMessageId))gapFail(409);
  const ids=new Set(),keys=new Set(),eventIds=new Set(events.map(e=>e.id));
  return reports.map(value=>{const r=validateGapReport(value);if(r.taskId!==taskId||r.runId!==runId||r.userMessageId!==userMessageId||ids.has(r.id)||keys.has(r.capabilityKey)||r.evidenceEventIds.some(id=>!eventIds.has(id)))gapFail(409);ids.add(r.id);keys.add(r.capabilityKey);return r;});
}
