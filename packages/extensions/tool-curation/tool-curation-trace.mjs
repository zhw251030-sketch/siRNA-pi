import { createHash } from 'node:crypto';
import {validateGapReports} from './tool-gap-contract.mjs';

// Independent preview protocol. Digests describe saved public records, not
// original provider requests. No model, filesystem, catalog or runtime access.
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const hash = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const secret = /^(?:authorization|proxy-authorization|cookies?|set-cookie|api[-_]?key|.*(?:access|refresh)[-_]?token|token|password|passwd|secret|client[-_]?secret|private[-_]?key|(?:verification|retrieval|evidence)[-_]?(?:id|token))$/i;
function textSafe(value) {
  return value.replace(/https?:\/\/[^\s<>"'`]+/gi, raw => {
    try { const u = new URL(raw); u.username='';u.password='';u.search='';u.hash='';return u.href; }
    catch { return '[REDACTED URL]'; }
  }).replace(/(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;"']+/gi,'$1[REDACTED]')
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret)\s*[=:]\s*)[^\s,;"']+/gi,'$1[REDACTED]')
    .replace(/((?:verification|retrieval|evidence)[-_]?(?:id|token)\s*[=:]\s*)[^\s,;"']+/gi,'$1[REDACTED]')
    .replace(/(--(?:api[-_]?key|token|password|secret)\s+)[^\s"']+/gi,'$1[REDACTED]')
    .replace(/("(?:api[-_]?key|authorization|password|token|secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,'$1"[REDACTED]"');
}
export function sanitizeCurationEvidence(v, key='', depth=0, {complete=false}={}) {
  if(secret.test(key)) return '[REDACTED]';
  if(depth>16 && !complete) return '[truncated]';
  if(typeof v==='string') {
    if(/^[\[{\"]/.test(v.trim())) {
      try { return JSON.stringify(sanitizeCurationEvidence(JSON.parse(v),'',depth+1,{complete})); } catch { /* text fallback */ }
    }
    return textSafe(v);
  }
  if(Array.isArray(v)) return [...(complete?v:v.slice(0,500)).map(x=>sanitizeCurationEvidence(x,'',depth+1,{complete})),...(!complete&&v.length>500?['[truncated]']:[])];
  if(object(v)) {
    const entries=Object.entries(v);
    return Object.fromEntries([...(complete?entries:entries.slice(0,500)).map(([k,x])=>[textSafe(k),sanitizeCurationEvidence(x,k,depth+1,{complete})]),...(!complete&&entries.length>500?[['[truncated]',true]]:[])]);
  }
  return v;
}
const sanitize=sanitizeCurationEvidence;
function clip(value, max=1400) {
  const s = typeof value==='string' ? value : JSON.stringify(value ?? null);
  if(Buffer.byteLength(s)<=max) return s;
  let out='';for(const ch of s) { if(Buffer.byteLength(out+ch)>max-20) break;out+=ch; }
  return out+'…[truncated]';
}
function parseInput(value) {
  if(typeof value==='string') { try { value=JSON.parse(value); } catch { return null; } }
  if(!object(value) || value.truncated === true || value._truncated === true || value.omitted === true) return null;
  return value;
}
function inputFor(args, mcp) {
  const outer=parseInput(args); if(!outer) return null;
  return mcp ? parseInput(outer.args ?? outer.arguments ?? outer.parameters) : outer;
}
// Control names follow the reference 67d2754 trace's explicit ignored set,
// plus local legacy spellings. Substrings such as "repair" remain business names.
const controls=new Set(['get_goal','create_goal','update_goal','report_tool_gap',
  'create_tool_build_session','cancel_tool_build_session','run_tool_build_command',
  'write_tool_build_file','finalize_tool_build','propose_exploration_tool',
  'get_verification_bundle','read_verification_message','read_verification_artifact',
  'list_verification_evidence','read_verification_attempt','check_verification_artifact',
  'search_verification_sources','fetch_verification_source',
  'goal_create','goal_update','proposal_submit']);
const normalizedTool = name => typeof name==='string' ? name.replace(/^(?:sirna_tools_|goal_verifier_tools_)/, '') : '';
function excluded(name, mcp, args, details, existing) {
  if(['read','write','edit'].includes(name.toLowerCase())) return 'file_operation';
  if(controls.has(name)) return 'governance_operation';
  if(mcp && (['list','search','describe','connect','status','resources','prompts'].includes(args?.mode) || details?.mode && details.mode!=='call' || !name || name==='mcp')) return 'mcp_meta_operation';
  if(existing.has(name)) return 'existing_tool';
  return null;
}
function capability(name, input) {
  const encoded=JSON.stringify(input ?? {});
  const url=encoded.match(/https?:\/\/[^\s"\\<>]+/i)?.[0];
  if(url) { try { return `network:${new URL(url).hostname.toLowerCase()}`; } catch { /* fallback */ } }
  if(/^(?:bash|shell|exec|execute)$/i.test(name)) {
    const command=input?.command ?? input?.cmd ?? input?.script;
    const first=typeof command==='string' ? command.trim().match(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*([\w./-]+)/)?.[1] : null;
    return `bash:${first?.split('/').at(-1) || 'unknown'}`;
  }
  return `tool:${name}`;
}

export function buildCurationPreview({taskId,runId,userMessageId,objective='',events,existingTools=[],gapReports=[]}) {
  if(!Array.isArray(events)) throw new TypeError('events must be an array');
  const eventIds=new Set();
  for(const event of events) {
    if(event.taskId!==taskId || event.runId!==runId || event.userMessageId!==userMessageId) throw new TypeError('event scope binding mismatch');
    if(typeof event.id!=='string' || !event.id) throw new TypeError('event identity required');
    if(eventIds.has(event.id)) throw new TypeError('duplicate event identity');eventIds.add(event.id);
  }
  gapReports=validateGapReports(gapReports,{taskId,runId,userMessageId,events});
  const existing=new Set(existingTools.map(t=>normalizedTool(typeof t==='string'?t:t?.name)).filter(Boolean));
  const starts=events.filter(e=>e.type==='tool_start');
  const groups=new Map();const calls=[];const excludedDetails=[];let excludedCalls=0,incompleteCalls=0;
  for(const start of starts) {
    const p=start.payload ?? {}; const id=p.toolCallId;
    const matches=events.filter(e=>e.type==='tool_end' && e.payload?.toolCallId===id);
    const repeated=starts.filter(e=>e.payload?.toolCallId===id).length!==1;
    const end=matches.length===1?matches[0]:null;const ep=end?.payload;
    const paired=typeof id==='string' && id.length>0 && !repeated && end && events.indexOf(end)>events.indexOf(start) && ep.toolName===p.toolName;
    const args=parseInput(p.args);
    let result=ep?.result;if(typeof result==='string') {try {result=JSON.parse(result);}catch {/* output remains text */}}
    const details=object(result?.details)?result.details:{};
    const mcp=p.toolName==='mcp';
    // pi-mcp-adapter 2.11: start.tool may be server-prefixed; details.tool
    // carries the unprefixed actual name and mcpResult preserves inner errors.
    const actual=mcp ? (normalizedTool(args?.tool) || 'mcp') : normalizedTool(p.toolName ?? 'unknown');
    const identityConflict=mcp && details.tool!==undefined && normalizedTool(details.tool)!==actual;
    const reason=excluded(String(actual),mcp,args,details,existing);
    if(reason) {
      excludedCalls++;
      excludedDetails.push({startEventId:clip(textSafe(start.id),160),actualToolName:clip(textSafe(String(actual)),160),reason});
      continue;
    }
    const input=inputFor(p.args,mcp);
    let outcome='unknown';
    if(paired && !identityConflict && typeof ep.isError==='boolean') {
      if(ep.isError || details.mcpResult?.isError===true || result?.isError===true) outcome='error';
      else if(!mcp || object(details.mcpResult) && !result?.truncated && (details.mcpResult.isError===false || details.mcpResult.isError===undefined && Array.isArray(details.mcpResult.content))) outcome='success';
    }
    if(outcome==='unknown') incompleteCalls++;
    const safeName=clip(textSafe(String(actual)),160);
    const key=clip(textSafe(capability(safeName,input)),180);
    const inputSha256=input ? hash(input) : null;
    const call={startEventId:clip(textSafe(start.id),160),...(end?{endEventId:clip(textSafe(end.id),160)}:{}),toolCallId:clip(textSafe(String(id ?? '')),160),reportedToolName:clip(textSafe(String(p.toolName ?? 'unknown')),160),actualToolName:safeName,capabilityKey:key,inputSha256,inputPreview:clip(sanitize(input ?? '[input unavailable]')),outcome};
    if(end) call.outputPreview=clip(sanitize(ep.result));
    if(outcome==='unknown') call.exclusionReason='incomplete_or_conflicting_call';
    calls.push(call);
    if(outcome!=='unknown') {
      let group=groups.get(key);if(!group){group={capabilityKey:key,callCount:0,inputs:new Set(),errorCount:0,ids:[]};groups.set(key,group);}
      group.callCount++;if(inputSha256) group.inputs.add(inputSha256);if(outcome==='error') group.errorCount++;
      group.ids.push(call.startEventId,call.endEventId);
    }
  }
  const shown=calls.slice(-12);const visible=new Set(shown.flatMap(c=>[c.startEventId,c.endEventId]).filter(Boolean));
  const qualified=[...groups.values()].filter(g=>(g.callCount>=3 && g.inputs.size>=2)||g.errorCount>=2);
  const signals=qualified.slice(0,20).map(g=>({capabilityKey:g.capabilityKey,callCount:g.callCount,distinctInputs:g.inputs.size,errorCount:g.errorCount,evidenceEventIds:g.ids.filter(id=>visible.has(id)),evidenceComplete:g.ids.every(id=>visible.has(id))}));
  const preview={protocolVersion:'sirna-tool-curation-preview/v1',taskId,runId,userMessageId,objective:clip(sanitize(String(objective)),2000),sourceSha256:hash({taskId,runId,userMessageId,objective,events,existingTools:[...existing].sort()}),eligibleForReview:qualified.length>0,summary:{toolStarts:starts.length,consideredCalls:calls.length,excludedCalls,incompleteCalls,omittedCalls:Math.max(0,calls.length-12)},calls:shown,signals,limits:{maxCalls:12,maxSignals:20,maxPreviewBytes:65536,omittedSignals:Math.max(0,qualified.length-20),displayTruncated:calls.length>12 || qualified.length>20 || Buffer.byteLength(String(objective))>2000,sourceHashScope:'canonical_saved_inputs_with_normalized_tool_catalog'}};
  preview.excludedCalls=excludedDetails.slice(-20);
  preview.limits.maxExcludedCalls=20;
  preview.limits.omittedExcludedCalls=Math.max(0,excludedDetails.length-20);
  if(preview.limits.omittedExcludedCalls) preview.limits.displayTruncated=true;
  if(shown.some(c=>c.inputPreview.includes('[truncated]') || c.outputPreview?.includes('[truncated]'))) preview.limits.displayTruncated=true;
  if(gapReports.length){
    preview.gapReports=sanitize(gapReports, '', 0, {complete:true});
    preview.eligibleForReview=true;
    preview.sourceSha256=hash({taskId,runId,userMessageId,objective,events,existingTools:[...existing].sort(),gapReports});
    // Complete report payloads cannot be silently reduced to fit an envelope.
    if(Buffer.byteLength(JSON.stringify({...preview,previewSha256:'0'.repeat(64)}))>65536)throw new RangeError('Gap preview exceeds byte limit');
  }
  // Reserve the final hash in the byte budget; bounded metadata above normally
  // stays below 64 KiB, but never silently exceed the published envelope.
  while(Buffer.byteLength(JSON.stringify({...preview,previewSha256:'0'.repeat(64)}))>65536) {
    preview.limits.displayTruncated=true;
    if(preview.calls.length) {preview.calls.shift();preview.summary.omittedCalls++;}
    else if(preview.excludedCalls.length) {preview.excludedCalls.shift();preview.limits.omittedExcludedCalls++;}
    else if(preview.signals.length) {preview.signals.pop();preview.limits.omittedSignals++;}
    else throw new RangeError('preview identity exceeds byte limit');
    const shownIds=new Set(preview.calls.flatMap(c=>[c.startEventId,c.endEventId]));
    for(const signal of preview.signals) {const before=signal.evidenceEventIds.length;signal.evidenceEventIds=signal.evidenceEventIds.filter(id=>shownIds.has(id));if(before!==signal.evidenceEventIds.length) signal.evidenceComplete=false;}
  }
  return {...preview,previewSha256:hash(preview)};
}
