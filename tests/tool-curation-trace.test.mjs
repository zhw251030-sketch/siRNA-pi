import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const modulePath = '../packages/extensions/tool-curation/tool-curation-trace.mjs';
let buildCurationPreview;
try { ({ buildCurationPreview } = await import(modulePath)); } catch (e) { if(e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const base = {taskId:'task',runId:'run',userMessageId:'message',objective:'寻找可复用能力',existingTools:[]};
function eventsFor(inputs, name='bash', result={content:[{type:'text',text:'done'}]}) {
  return inputs.flatMap((args,i)=>[
    {id:`s${i}`,taskId:'task',runId:'run',userMessageId:'message',sequence:i*2+1,type:'tool_start',payload:{type:'tool_start',toolCallId:`c${i}`,toolName:name,args}},
    {id:`e${i}`,taskId:'task',runId:'run',userMessageId:'message',sequence:i*2+2,type:'tool_end',payload:{type:'tool_end',toolCallId:`c${i}`,toolName:name,result,isError:false}},
  ]);
}
const build = (events, rest={}) => { assert.equal(typeof buildCurationPreview,'function','preview builder must be implemented'); return buildCurationPreview({...base,events,...rest}); };

test('three business calls and two canonical inputs qualify; same input does not',()=>{
  const p=build(eventsFor([{command:'python one'},{command:'python two'},{command:'python one'}]));
  assert.equal(p.eligibleForReview,true); assert.equal(p.signals[0].callCount,3); assert.equal(p.signals[0].distinctInputs,2);
  assert.equal(build(eventsFor([{command:'python one'},{command:'python one'},{command:'python one'}])).eligibleForReview,false);
  assert.equal(build(eventsFor([{command:'python one'},{command:'python two'}])).eligibleForReview,false);
});
test('actual MCP params and nested MCP error determine identity and error threshold',()=>{
  const p=build(eventsFor([{mode:'call',server:'web',tool:'fetch',args:{url:'https://example.org/a'}},{mode:'call',server:'web',tool:'fetch',args:{url:'https://example.org/b'}}],'mcp',{details:{mcpResult:{isError:true,content:[]}}}));
  assert.equal(p.calls[0].actualToolName,'fetch'); assert.equal(p.calls[0].outcome,'error'); assert.equal(p.signals[0].errorCount,2); assert.equal(p.eligibleForReview,true);
  assert.match(p.calls[0].capabilityKey,/example\.org/);
});
test('existing tool, MCP meta, file and governance operations exclude payloads',()=>{
  for(const [name,args,existingTools] of [['read',{path:'PRIVATE'},[]],['write',{content:'PRIVATE'},[]],['mcp',{mode:'list',args:'PRIVATE'},[]],['mcp',{mode:'call',tool:'proposal_submit',args:{secret:'PRIVATE'}},[]],['mcp',{mode:'call',tool:'goal_create',args:{secret:'PRIVATE'}},[]],['fetch',{url:'PRIVATE'},['fetch']]]) {
    const p=build(eventsFor([args],name),{existingTools}); assert.equal(p.summary.excludedCalls,1); assert.equal(p.calls.length,0); assert.ok(!JSON.stringify(p).includes('PRIVATE'));
  }
});
test('cross task/run/message is rejected instead of pairing unrelated events',()=>{
  for(const field of ['taskId','runId','userMessageId']) {const events=eventsFor([{command:'python one'}]);events[1][field]='other';assert.throws(()=>build(events),/bind|scope/i);}
});
test('missing, duplicate, mismatched and out-of-order ends cannot report success',()=>{
  const all=eventsFor([{command:'python one'}]);
  for(const events of [[all[0]],[...all,{...all[1],id:'duplicate'}],[all[1],all[0]],[all[0],{...all[1],payload:{...all[1].payload,toolName:'other'}}]]) {
    const p=build(events);assert.equal(p.calls[0].outcome,'unknown');assert.equal(p.summary.incompleteCalls,1);assert.equal(p.eligibleForReview,false);
  }
  const unknown=eventsFor([{command:'python one'}]);delete unknown[1].payload.isError;assert.equal(build(unknown).calls[0].outcome,'unknown');
});
test('JSON strings, nested secrets and URL credentials query fragments never leak',()=>{
  const args={command:'curl https://user:PASS@example.org/a?api_key=QUERY#FRAG',data:JSON.stringify({nested:{apiKey:'SECRET',authorization:'Bearer AUTH'}})};
  const p=build(eventsFor([args],'bash',{content:[{type:'text',text:JSON.stringify({password:'OUTPUT',url:'https://me:OTHER@example.org/?token=ABC#XYZ'})}]}),{objective:'url https://user:OBJ@example.org/?key=OBJQUERY#OBJFRAG'});
  const text=JSON.stringify(p);for(const secret of ['PASS','QUERY','FRAG','SECRET','AUTH','OUTPUT','OTHER','ABC','XYZ','OBJ']) assert.ok(!text.includes(secret),secret);
  assert.ok(text.includes('[REDACTED]'));
});
test('unparseable and truncated inputs cannot manufacture distinct inputs',()=>{
  const p=build(eventsFor(['{"command":','{"different":','{"last":']));assert.equal(p.eligibleForReview,false);
  assert.equal(p.calls[0].inputSha256,null);
  const q=build(eventsFor([{truncated:true,text:'a'},{truncated:true,text:'b'},{truncated:true,text:'c'}]));assert.equal(q.eligibleForReview,false);
});
test('only last twelve calls display; full-round evidence outside window is explicit',()=>{
  const p=build(eventsFor(Array.from({length:15},(_,i)=>({command:`python ${i}`}))));
  assert.equal(p.calls.length,12);assert.equal(p.calls[0].startEventId,'s3');assert.equal(p.summary.omittedCalls,3);assert.equal(p.signals[0].callCount,15);assert.equal(p.signals[0].evidenceComplete,false);
});
test('canonical hashes stable for object key order and preview hash covers final bounded object',()=>{
  const a=eventsFor([{command:'python x',a:1}]);const b=structuredClone(a);b[0].payload.args={a:1,command:'python x'};
  assert.equal(build(a).sourceSha256,build(b).sourceSha256);
  const p=build(eventsFor(Array.from({length:200},(_,i)=>({command:`python ${i}`,data:'中'.repeat(10000)}))),{objective:'中'.repeat(100000)});
  assert.ok(Buffer.byteLength(JSON.stringify(p))<=65536);assert.equal(p.limits.displayTruncated,true);
  const canon=v=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
  const {previewSha256,...rest}=p;assert.equal(previewSha256,createHash('sha256').update(JSON.stringify(canon(rest))).digest('hex'));
});
test('no secret leaks through tool names identifiers or network grouping',()=>{
  const p=build(eventsFor([{url:'https://u:PASS@example.org/a?token=SECRET#FRAG'}],'https://u:PASS@example.org/?token=SECRET#FRAG'));
  assert.ok(!JSON.stringify(p).includes('PASS'));assert.ok(!JSON.stringify(p).includes('SECRET'));
});
test('saved adapter MCP JSON args determine distinct inputs and actual tool names',()=>{
  const events=eventsFor([{tool:'sirna_tools_fetch',args:'{"url":"https://example.org/a"}'},{tool:'sirna_tools_fetch',args:'{"url":"https://example.org/b"}'},{tool:'sirna_tools_fetch',args:'{"url":"https://example.org/c"}'}],'mcp',{details:{mode:'call',tool:'fetch',mcpResult:{isError:false,content:[]}}});
  const p=build(events);assert.equal(p.calls[0].actualToolName,'fetch');assert.equal(p.signals[0].distinctInputs,3);assert.match(p.calls[0].inputPreview,/example.org\/a/);
  assert.equal(build(events,{existingTools:['fetch']}).summary.excludedCalls,3);
});
test('MCP inner errors in JSON results and unknown inner result do not become success',()=>{
  const events=eventsFor([{tool:'sirna_tools_fetch',args:'{}'}],'mcp',JSON.stringify({details:{mode:'call',tool:'fetch',mcpResult:{isError:true}}}));
  assert.equal(build(events).calls[0].outcome,'error');
  const missing=eventsFor([{tool:'web_fetch',args:'{}'}],'mcp',{});assert.equal(build(missing).calls[0].outcome,'unknown');
});
test('duplicate start IDs and event IDs cannot contribute eligible signals',()=>{
  const events=eventsFor([{command:'python one'},{command:'python two'},{command:'python three'}]);events[2].id=events[0].id;
  assert.throws(()=>build(events),/identity|duplicate/i);
});
test('signals stop at twenty and expose omitted count',()=>{
  const events=[];for(let i=0;i<22;i++) {const next=eventsFor([{x:1},{x:2},{x:3}],`custom${i}`);for(const event of next){event.id=`${i}-${event.id}`;event.payload.toolCallId=`${i}-${event.payload.toolCallId}`;}events.push(...next);}
  const p=build(events);assert.equal(p.signals.length,20);assert.equal(p.limits.omittedSignals,2);
});
test('explicit control names exclude verification and gap tools without excluding business repair names',()=>{
  for(const name of ['get_goal','report_tool_gap','get_verification_bundle','read_verification_message','read_verification_artifact','list_verification_evidence','read_verification_attempt','check_verification_artifact','search_verification_sources','fetch_verification_source','create_tool_build_session','propose_exploration_tool']) assert.equal(build(eventsFor([{}],name)).summary.excludedCalls,1,name);
  for(const name of ['goal_verifier_tools_get_verification_bundle','goal_verifier_tools_read_verification_message','goal_verifier_tools_read_verification_artifact','goal_verifier_tools_list_verification_evidence','goal_verifier_tools_read_verification_attempt','goal_verifier_tools_check_verification_artifact','goal_verifier_tools_search_verification_sources','goal_verifier_tools_fetch_verification_source']) assert.equal(build(eventsFor([{}],name)).summary.excludedCalls,1,name);
  assert.equal(build(eventsFor([{}],'summarize_numeric_range_repair_feedback')).calls.length,1);
});

test('curation sanitization redacts verifier tokens and evidence identities',()=>{
  const p=build(eventsFor([{verificationId:'verification-1',verificationToken:'verification-secret',accessToken:'access-secret',retrievalId:'retrieval-1',retrievalToken:'retrieval-secret',evidenceId:'evidence-1',evidenceToken:'evidence-secret'}],'summarize'));
  const text=JSON.stringify(p);
  for(const secret of ['verification-1','verification-secret','access-secret','retrieval-1','retrieval-secret','evidence-1','evidence-secret']) assert.equal(text.includes(secret),false,secret);
  assert.match(text,/\[REDACTED\]/);
});
test('MCP start identity is authoritative; prefixed names normalize and conflicting result stays unknown',()=>{
  const events=eventsFor([{tool:'sirna_tools_fetch',args:'{}'}],'mcp',{});
  assert.equal(build(events).calls[0].actualToolName,'fetch');
  events[1].payload.result={details:{mode:'call',tool:'different',mcpResult:{content:[]}}};
  assert.equal(build(events).calls[0].actualToolName,'fetch');assert.equal(build(events).calls[0].outcome,'unknown');
});
test('source hash binds complete saved inputs including objective and canonical catalog',()=>{
  const events=eventsFor([{}]);assert.notEqual(build(events).sourceSha256,build(events,{objective:'different'}).sourceSha256);
  assert.notEqual(build(events).sourceSha256,build(events,{existingTools:['another']}).sourceSha256);
  assert.equal(build(events,{existingTools:['z','a']}).sourceSha256,build(events,{existingTools:['a','z']}).sourceSha256);
});
test('truncated saved MCP results and malformed inner error flags stay unknown',()=>{
  for(const result of [{truncated:true,preview:'partial'}, {details:{mode:'call',tool:'fetch',mcpResult:{isError:'false',content:[]}}}]) {
    assert.equal(build(eventsFor([{tool:'sirna_tools_fetch',args:'{}'}],'mcp',result)).calls[0].outcome,'unknown');
  }
});
test('sanitizer collection omission is marked as display truncation',()=>{
  const p=build(eventsFor([{values:Array.from({length:501},()=>0)}]));assert.equal(p.limits.displayTruncated,true);
});
test('excluded call teaching summaries expose bounded safe identities and reasons only',()=>{
  const events=eventsFor(Array.from({length:23},()=>({content:'PRIVATE SOURCE'})),'write');
  const p=build(events);assert.equal(p.summary.excludedCalls,23);assert.equal(p.excludedCalls.length,20);
  assert.deepEqual(p.excludedCalls[0],{startEventId:'s3',actualToolName:'write',reason:'file_operation'});
  assert.equal(p.limits.omittedExcludedCalls,3);assert.ok(!JSON.stringify(p).includes('PRIVATE SOURCE'));
  const q=build(eventsFor([{tool:'sirna_tools_create_tool_build_session',args:'{"source":"PRIVATE CODE"}'}],'mcp'));
  assert.deepEqual(q.excludedCalls,[{startEventId:'s0',actualToolName:'create_tool_build_session',reason:'governance_operation'}]);
  assert.ok(!JSON.stringify(q).includes('PRIVATE CODE'));
});
