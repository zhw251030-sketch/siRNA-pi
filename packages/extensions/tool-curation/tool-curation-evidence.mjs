import {createHash} from 'node:crypto';
import {validateGapReports} from './tool-gap-contract.mjs';
import {sanitizeCurationEvidence} from './tool-curation-trace.mjs';

export const TOOL_CURATION_TRACE_PROTOCOL='sirna-tool-curation-trace/v1';
export const TOOL_CURATION_RESULT_PROTOCOL='sirna-tool-curation-result/v1';
export const record=value=>value!==null && typeof value==='object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));

// Descriptor checks precede property reads: reject accessors, hooks, cycles,
// exotic prototypes and properties which JSON would silently erase.
export function assertCurationJson(value,{maxDepth=16,maxBytes=65536}={}) {
  const ancestors=new Set();
  function visit(v,depth){
    if(depth>maxDepth)throw Error('JSON depth exceeds limit');
    if(v===null || ['string','boolean'].includes(typeof v) || typeof v==='number' && Number.isFinite(v))return;
    if(typeof v!=='object' || !Array.isArray(v) && !record(v) || ancestors.has(v))throw Error('Expected plain JSON data');
    const array=Array.isArray(v),keys=Reflect.ownKeys(v);
    if(array && (Object.getPrototypeOf(v)!==Array.prototype || keys.length!==v.length+1))throw Error('Expected dense JSON array');
    ancestors.add(v);
    for(const key of keys){
      if(array && key==='length')continue;
      const d=Object.getOwnPropertyDescriptor(v,key);
      if(typeof key!=='string' || !d.enumerable || !Object.hasOwn(d,'value') || ['__proto__','constructor','prototype'].includes(key) || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key)>=v.length))throw Error('Invalid JSON property');
      visit(d.value,depth+1);
    }
    ancestors.delete(v);
  }
  visit(value,0);
  if(Buffer.byteLength(JSON.stringify(value))>maxBytes)throw new RangeError('JSON byte limit exceeded');
}
function canonical(value){return Array.isArray(value)?value.map(canonical):record(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;}
export function curationSha256(value){assertCurationJson(value,{maxDepth:32,maxBytes:8*1024*1024});return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
export function traceSha256(trace){const {traceSha256:ignored,...body}=trace;return curationSha256(body);}

function shape(preview){
  if(typeof preview!=='string' || preview.includes('[truncated]') || preview.includes('[REDACTED]'))return {type:'unknown',reason:'preview_unavailable_or_redacted'};
  let value;try{value=JSON.parse(preview);}catch{return {type:'unknown',reason:'preview_not_json'};}
  function describe(v,depth=0){if(depth>8)return 'unknown';if(v===null)return 'null';if(Array.isArray(v))return {type:'array',items:v.length?describe(v[0],depth+1):'unknown'};if(record(v))return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,describe(x,depth+1)]));return typeof v;}
  return describe(value);
}
function urls(call){const refs=new Map();for(const value of [call.inputPreview,call.outputPreview])for(const match of String(value??'').matchAll(/https?:\/\/[^\s"'<>\\]+/gi)){try{const u=new URL(match[0]);const ref={host:u.hostname,path:u.pathname,queryKeys:[]};refs.set(`${ref.host}${ref.path}`,ref);}catch{}}return [...refs.values()].slice(0,20);}

export function buildToolCurationTrace({id,snapshot}){
  if(typeof id!=='string' || !/^[0-9a-f-]{36}$/i.test(id))throw Error('Invalid curation identity');
  const {preview,existingTools,events}=snapshot??{};
  if(!preview || !Array.isArray(existingTools) || !Array.isArray(events))throw Error('Snapshot is required');
  const {previewSha256,...body}=preview;
  if(curationSha256(body)!==previewSha256)throw Error('Preview digest mismatch');
  const signals=preview.signals.filter(s=>s.evidenceComplete===true);
  const gapReports=validateGapReports(preview.gapReports??[],{taskId:preview.taskId,runId:preview.runId,userMessageId:preview.userMessageId,events});
  if(!preview.eligibleForReview || !signals.length && !gapReports.length)throw Error('No complete triggering signal');
  const ids=new Set(signals.flatMap(s=>s.evidenceEventIds)),eventMap=new Map(events.map(e=>[e.id,e]));
  const calls=preview.calls.filter(c=>ids.has(c.startEventId) && ids.has(c.endEventId)).map(call=>{
    const start=eventMap.get(call.startEventId),end=eventMap.get(call.endEventId);
    if(!start || !end || call.outcome==='unknown' || start.taskId!==preview.taskId || end.taskId!==preview.taskId || start.runId!==preview.runId || end.runId!==preview.runId)throw Error('Incomplete frozen call');
    const startedAt=start.createdAt,completedAt=end.createdAt,durationMs=Date.parse(completedAt)-Date.parse(startedAt);
    return {startEventId:call.startEventId,endEventId:call.endEventId,toolCallId:call.toolCallId,reportedToolName:call.reportedToolName,actualToolName:call.actualToolName,capabilityKey:call.capabilityKey,inputSha256:call.inputSha256,inputShape:shape(call.inputPreview),inputPreview:call.inputPreview,outputShape:shape(call.outputPreview),outputPreview:call.outputPreview,urlReferences:urls(call),isError:call.outcome==='error',startedAt,completedAt,...(Number.isFinite(durationMs)&&durationMs>=0?{durationMs}:{})};
  });
  const included=new Set(calls.flatMap(c=>[c.startEventId,c.endEventId]));
  if([...ids].some(id=>!included.has(id)))throw Error('Trigger evidence is missing');
  const trace={protocolVersion:TOOL_CURATION_TRACE_PROTOCOL,curationId:id,trigger:gapReports.length?'online_gap':'post_run',taskId:preview.taskId,runId:preview.runId,userMessageId:preview.userMessageId,objective:preview.objective,existingTools:[...existingTools],calls,gapReports,truncated:preview.limits.displayTruncated===true,sourceSha256:preview.sourceSha256,previewSha256,signals:structuredClone(signals),evidenceMetadata:{shapeSource:'sanitized_preview',originalInputsAvailable:false,completeTriggerEvidence:true,sourceHashScope:preview.limits.sourceHashScope}};
  if(gapReports.length){
    const gapIds=new Set(gapReports.flatMap(r=>r.evidenceEventIds));
    trace.gapEvidence=events.filter(e=>gapIds.has(e.id)).map(e=>sanitizeCurationEvidence(e,'',0,{complete:true}));
  }
  trace.traceSha256=traceSha256(trace);assertCurationJson(trace,{maxDepth:32,maxBytes:65536});return trace;
}
