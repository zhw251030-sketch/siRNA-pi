import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolPanel,mountToolPanel} from '../public/tools.mjs';
const id='26883ce8-5c2e-4a0e-90fb-d96e53270b9c';
function storage(){const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};}
class MountedElement{
  constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.listeners={};this._text='';this.open=false;this.scrollTop=0;}
  set textContent(value){this._text=String(value);}get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  set innerHTML(value){throw new Error('HTML rendering forbidden');}
  append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[...nodes];}addEventListener(type,callback){this.listeners[type]=callback;}
}
function mountHarness(t,fetcher,savedStorage=storage()){
  const elements=new Map(['tools-list','tools-status','tools-summary','refresh-tools'].map(name=>[name,new MountedElement('div')]));
  const document={getElementById:id=>elements.get(id),createElement:tag=>new MountedElement(tag),visibilityState:'hidden'};
  const saved=new Map(['fetch','setTimeout','addEventListener','sessionStorage'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const overrides={fetch:fetcher,setTimeout:()=>0,addEventListener:()=>{},sessionStorage:savedStorage};for(const [key,value] of Object.entries(overrides))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  t.after(()=>{for(const [key,descriptor] of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
  const find=(node,tag)=>node.tagName===tag?node:node.children.map(child=>find(child,tag)).find(Boolean);
  return {panel:mountToolPanel(document),document,summary:elements.get('tools-summary'),list:elements.get('tools-list'),details:()=>find(elements.get('tools-summary'),'details')};
}
function mountedFeedback(proposalId=id,validationId='v1',reportSha256='r1'){
  return {proposalId,validationId,reportSha256,gates:{domain:'failed',repeatability:'not_run'},domainCases:{total:0,shown:0,omitted:0,entries:[]},benchmarkCases:{total:0,shown:0,omitted:0,entries:[]},benchmarkGate:{candidateScore:0,baselineScore:0,netGain:0,minNetGain:1,passed:false},prompt:'read this fixed repair preview'};
}
const otherId='11111111-1111-4111-8111-111111111111';
function repairStatus(overrides={}){return {sourceTaskId:'trusted-task',rootProposalId:id,attempt:0,maxRepairAttempts:3,canRepair:true,reason:null,repair:null,...overrides};}
function repairTicket(feedback=mountedFeedback(),overrides={}){return {proposalId:feedback.proposalId,validationId:feedback.validationId,reportSha256:feedback.reportSha256,phase:'running',message:'正在执行一轮修订。',replacementProposalId:null,...overrides};}
function repairFetcher({feedback=()=>mountedFeedback(),status=()=>repairStatus(),post=()=>Response.json({repair:repairTicket(),deduplicated:false},{status:202}),calls=[]}={}){
  return async(url,options)=>{calls.push({url,options});if(options?.method==='POST')return post(url,options);if(url.endsWith('repair-feedback'))return Response.json({feedback:feedback()});if(url.endsWith('repair-status'))return Response.json(status());return Response.json({proposals:[{id,state:'verification_failed',latestJob:{status:'succeeded'}},{id:otherId,state:'verification_failed'}]});};
}
function findMounted(node,predicate){return predicate(node)?node:node.children.map(c=>findMounted(c,predicate)).find(Boolean);}
test('mounted explicit repair explains trusted source, cost, one round and independent replacement validation',async t=>{
  const calls=[],h=mountHarness(t,repairFetcher({calls}));await h.panel.inspectFeedback(id);
  assert.match(h.summary.textContent,/trusted-task/);assert.match(h.summary.textContent,/0\/3/);assert.match(h.summary.textContent,/消耗模型额度/);assert.match(h.summary.textContent,/一轮/);assert.match(h.summary.textContent,/独立验证和人工批准/);
  const button=findMounted(h.summary,n=>n.dataset.repairProposal===id);assert.equal(button.disabled,false);assert.equal(calls.some(c=>c.options?.method==='POST'),false);
});
for(const reason of ['no_source','future_internal_secret'])test(`mounted ${reason} is blocked and raw reasons stay internal`,async t=>{
  const h=mountHarness(t,repairFetcher({status:()=>repairStatus({sourceTaskId:null,canRepair:false,reason})}));await h.panel.inspectFeedback(id);
  assert.equal(findMounted(h.summary,n=>n.dataset.repairProposal===id).disabled,true);assert.match(h.summary.textContent,/没有可信来源任务/);assert.doesNotMatch(h.summary.textContent,new RegExp(reason));
});
test('repair binds exact current report, synchronously excludes double clicks and validation, and sends no source or prompt',async()=>{
  const calls=[];let release;const panel=createToolPanel({storage:storage(),fetcher:repairFetcher({calls,post:()=>new Promise(r=>release=r)})});await panel.inspectFeedback(id);
  assert.equal(typeof panel.repair,'function');const pending=panel.repair(id);await panel.repair(id);await panel.validate(id);
  const posts=calls.filter(c=>c.options?.method==='POST');assert.equal(posts.length,1);assert.match(posts[0].url,/\/repair$/);assert.deepEqual(JSON.parse(posts[0].options.body),{validationId:'v1',reportSha256:'r1'});assert.equal(panel.state.feedback,null);
  release(Response.json({repair:repairTicket(),deduplicated:false},{status:202}));await pending;
});
test('candidate or missing feedback/status identity cannot authorize repair',async()=>{
  const calls=[];let feedback=mountedFeedback(otherId);const panel=createToolPanel({storage:storage(),fetcher:repairFetcher({calls,feedback:()=>feedback})});await panel.inspectFeedback(id);assert.equal(typeof panel.repair,'function');await panel.repair(id);assert.equal(calls.some(c=>c.options?.method==='POST'),false);
  feedback=null;await panel.refresh();await panel.repair(id);assert.equal(calls.some(c=>c.options?.method==='POST'),false);assert.equal(panel.state.repairStatus.sourceTaskId,'trusted-task');
});
test('unknown repair outcome survives failed reads and reload, never auto POSTs, then exact authoritative ticket clears warning',async()=>{
  const saved=storage(),calls=[];let fails=false,ticket=null;const fetcher=repairFetcher({calls,status:()=>{if(fails)throw new Error('private');return repairStatus({repair:ticket});},post:()=>{throw new Error('private');}});
  const panel=createToolPanel({storage:saved,fetcher});await panel.inspectFeedback(id);assert.equal(typeof panel.repair,'function');await panel.repair(id);assert.match(panel.state.error,/修订请求未确认/);
  fails=true;await panel.refresh();assert.match(panel.state.error,/修订请求未确认/);fails=false;
  const reload=createToolPanel({storage:saved,fetcher});await reload.inspectFeedback(id);assert.match(reload.state.error,/修订请求未确认/);
  ticket=repairTicket(mountedFeedback(id,'different','r1'));await reload.refresh();assert.match(reload.state.error,/修订请求未确认/);
  ticket=repairTicket();await reload.refresh();assert.equal(reload.state.error,'');assert.equal(calls.filter(c=>c.options?.method==='POST').length,1);
});
test('late POST cannot replace new selection or erase another candidate unresolved warning',async()=>{
  let release;const panel=createToolPanel({storage:storage(),fetcher:repairFetcher({feedback:()=>mountedFeedback(panel.state.selectedId),post:()=>new Promise(r=>release=r)})});await panel.inspectFeedback(id);assert.equal(typeof panel.repair,'function');const pending=panel.repair(id);await panel.inspectFeedback(otherId);
  release(Response.json({repair:repairTicket(),deduplicated:false},{status:202}));await pending;assert.equal(panel.state.selectedId,otherId);assert.equal(panel.state.feedback.proposalId,otherId);
});
test('late status response cannot authorize the old candidate or report',async()=>{
  let hold=false,release;const base=repairFetcher({feedback:()=>mountedFeedback(panel.state.selectedId)});const panel=createToolPanel({storage:storage(),fetcher:(url,options)=>url.endsWith('repair-status')&&hold?new Promise(r=>release=r):base(url,options)});
  await panel.inspectFeedback(id);assert.ok(panel.state.repairStatus);hold=true;const old=panel.refresh();while(!release)await Promise.resolve();hold=false;await panel.inspectFeedback(otherId);release(Response.json(repairStatus({sourceTaskId:'stale-task'})));await old;
  assert.equal(panel.state.selectedId,otherId);assert.equal(panel.state.repairStatus.sourceTaskId,'trusted-task');assert.equal(panel.state.feedback.proposalId,otherId);
});
test('mounted accepted replacement is distinct from passed validation and offers explicit view',async t=>{
  const ticket=repairTicket(mountedFeedback(),{phase:'superseded',replacementProposalId:otherId,message:'已登记新候选，仍须独立验证和人工批准。'});
  const h=mountHarness(t,repairFetcher({status:()=>repairStatus({canRepair:false,reason:'already_requested',repair:ticket})}));await h.panel.inspectFeedback(id);
  assert.match(h.summary.textContent,new RegExp(otherId));assert.match(h.summary.textContent,/独立验证和人工批准/);assert.doesNotMatch(findMounted(h.summary,n=>n.tagName==='h3').textContent,/未派发/);
  const view=findMounted(h.summary,n=>n.dataset.viewReplacement===otherId);assert.ok(view);await view.listeners.click();assert.equal(h.panel.state.selectedId,otherId);
});
test('mounted repair status remains readable without failed feedback and validation stays disabled during active repair',async t=>{
  const ticket=repairTicket();const calls=[],h=mountHarness(t,repairFetcher({calls,feedback:()=>null,status:()=>repairStatus({canRepair:false,reason:'already_requested',repair:ticket})}));await h.panel.inspectFeedback(id);
  assert.match(h.summary.textContent,/trusted-task/);assert.match(h.summary.textContent,/一轮修订运行中/);assert.equal(findMounted(h.summary,n=>n.dataset.repairProposal===id).disabled,true);
  await h.panel.select(id);await h.panel.validate(id);assert.equal(calls.some(c=>c.options?.method==='POST'),false,'changing to summary cannot bypass known active repair');
});
test('mounted explicit click sends one request and terminal polling releases validation after selection changes',async t=>{
  const calls=[];let release,ticket=null;
  const h=mountHarness(t,repairFetcher({calls,status:()=>repairStatus({canRepair:!ticket,repair:ticket}),post:()=>new Promise(r=>release=r)}));await h.panel.inspectFeedback(id);
  const request=findMounted(h.summary,n=>n.dataset.repairProposal===id);const pending=request.listeners.click();await request.listeners.click();
  assert.equal(findMounted(h.summary,n=>n.dataset.repairProposal===id).disabled,true);assert.equal(calls.filter(c=>c.options?.method==='POST').length,1);
  ticket=repairTicket();release(Response.json({repair:ticket,deduplicated:false},{status:202}));await pending;await h.panel.select(otherId);
  ticket={...ticket,phase:'awaiting_replacement'};await h.panel.refresh();assert.deepEqual(h.panel.state.activeRepairIds,[]);assert.equal(calls.filter(c=>c.options?.method==='POST').length,1);
});
test('unknown outcome bound to an old report never activates a newer report repair',async()=>{
  let feedback=mountedFeedback();const calls=[],panel=createToolPanel({storage:storage(),fetcher:repairFetcher({calls,feedback:()=>feedback,post:()=>{throw new Error('private');}})});await panel.inspectFeedback(id);await panel.repair(id);
  feedback=mountedFeedback(id,'new-report','new-hash');await panel.refresh();await panel.repair(id);assert.equal(calls.filter(c=>c.options?.method==='POST').length,1);assert.equal(panel.canRepair(id),false);assert.match(panel.state.error,/修订请求未确认/);
});
test('mounted unknown repair outcome visibly blocks conflicting validation',async t=>{
  const h=mountHarness(t,repairFetcher({post:()=>{throw new Error('private');}}));await h.panel.inspectFeedback(id);await h.panel.repair(id);
  assert.equal(findMounted(h.list,n=>n.dataset.validateProposal===id).disabled,true);
});
test('mounted lost validation acknowledgement blocks repair through reload until explicit same UUID confirmation',async t=>{
  const saved=storage(),calls=[],validationKeys=[];let selected=id;
  const h=mountHarness(t,repairFetcher({calls,feedback:()=>mountedFeedback(selected),post:(url,options)=>{
    assert.match(url,/\/validate$/,'repair must stay blocked during validation uncertainty');validationKeys.push(JSON.parse(options.body).requestId);
    if(validationKeys.length===1)throw new Error('lost validation ack');return Response.json({job:{status:'pending'}},{status:202});
  }}),saved);
  await h.panel.inspectFeedback(id);assert.equal(findMounted(h.summary,n=>n.dataset.repairProposal===id).disabled,false);
  await findMounted(h.list,n=>n.dataset.validateProposal===id).listeners.click();const requestId=saved.getItem(`sirna-pi.validation-request.${id}`);assert.ok(requestId);
  await h.panel.inspectFeedback(id);assert.match(h.panel.state.error,/验证请求未确认/);assert.equal(findMounted(h.summary,n=>n.dataset.repairProposal===id).disabled,true);await h.panel.repair(id);
  const reload=mountToolPanel(h.document);await reload.inspectFeedback(id);assert.equal(findMounted(h.summary,n=>n.dataset.repairProposal===id).disabled,true);await reload.repair(id);
  await reload.refresh();assert.equal(saved.getItem(`sirna-pi.validation-request.${id}`),requestId);assert.equal(findMounted(h.summary,n=>n.dataset.repairProposal===id).disabled,true);
  selected=otherId;await reload.inspectFeedback(otherId);assert.equal(findMounted(h.summary,n=>n.dataset.repairProposal===otherId).disabled,false,'another candidate has no unresolved validation');
  selected=id;await reload.inspectFeedback(id);await findMounted(h.list,n=>n.dataset.validateProposal===id).listeners.click();assert.deepEqual(validationKeys,[requestId,requestId]);assert.equal(saved.getItem(`sirna-pi.validation-request.${id}`),null);
  await reload.inspectFeedback(id);assert.equal(findMounted(h.summary,n=>n.dataset.repairProposal===id).disabled,false);assert.equal(calls.filter(c=>c.options?.method==='POST').length,2);
});
test('mounted repair eligibility fails closed when validation request storage cannot be read',async t=>{
  const calls=[],saved=storage(),read=saved.getItem;saved.getItem=key=>{if(key.startsWith('sirna-pi.validation-request.'))throw new Error('private storage failure');return read(key);};
  const h=mountHarness(t,repairFetcher({calls}),saved);await h.panel.inspectFeedback(id);assert.equal(findMounted(h.summary,n=>n.dataset.repairProposal===id).disabled,true);await h.panel.repair(id);assert.equal(calls.some(c=>c.options?.method==='POST'),false);
});

test('mounted prompt stays expanded with its scroll position through loading and unchanged read refresh',async t=>{
  let hold=false,release;const feedback=mountedFeedback();
  const harness=mountHarness(t,async url=>url.endsWith('repair-feedback')?hold?new Promise(resolve=>release=resolve):Response.json({feedback}):Response.json({proposals:[{id,latestJob:{status:'succeeded'}}]}));
  const {panel}=harness;await panel.inspectFeedback(id);harness.details().open=true;harness.details().children[1].scrollTop=87;
  hold=true;const refresh=panel.refresh();assert.equal(harness.details(),undefined,'stale evidence is cleared while loading');while(!release)await Promise.resolve();release(Response.json({feedback}));await refresh;
  assert.equal(harness.details().open,true);assert.equal(harness.details().children[1].scrollTop,87);
  harness.details().open=false;hold=false;await panel.refresh();assert.equal(harness.details().open,false,'a user closing the prompt is preserved too');
});
for(const reset of ['candidate','validationId','reportSha256','pending','running','validate'])test(`mounted prompt expansion resets after ${reset}`,async t=>{
  let feedback=mountedFeedback(),jobStatus='succeeded';const other='11111111-1111-4111-8111-111111111111';
  const harness=mountHarness(t,async(url,options)=>options?.method==='POST'?Response.json({job:{status:'pending'}},{status:202}):url.endsWith('repair-feedback')?Response.json({feedback}):Response.json({proposals:[{id,latestJob:{status:jobStatus}},{id:other,latestJob:{status:'succeeded'}}]}));
  const {panel}=harness;await panel.inspectFeedback(id);harness.details().open=true;
  if(reset==='candidate'){feedback=mountedFeedback(other);await panel.inspectFeedback(other);}
  else if(reset==='validationId'||reset==='reportSha256'){feedback={...feedback,[reset]:'new-identity'};await panel.refresh();}
  else if(reset==='validate'){await panel.validate(id);}
  else{jobStatus=reset;await panel.refresh();assert.equal(harness.details(),undefined);jobStatus='succeeded';await panel.refresh();}
  assert.equal(harness.details().open,false);
});

test('mounted fixed gates and run statuses use Chinese labels while protocol values stay internal',async t=>{
  const feedback=mountedFeedback();feedback.domainCases={total:1,shown:1,omitted:0,entries:[{name:'example',input:{json:'{}'},expected:{json:'{}'},actual:null,status:'failed',run:{status:'invalid_protocol'}}]};
  const harness=mountHarness(t,async url=>Response.json(url.endsWith('repair-feedback')?{feedback}:{proposals:[{id}]}));await harness.panel.inspectFeedback(id);
  const rendered=harness.summary.textContent;assert.match(rendered,/领域案例：未通过/);assert.match(rendered,/领域案例：展示 1\/1，省略 0/);assert.match(rendered,/基线比较：展示 0\/0，省略 0/);assert.match(rendered,/重复性：未执行/);assert.match(rendered,/输出协议不符/);assert.doesNotMatch(rendered,/domain|repeatability|invalid_protocol|not_run/);assert.equal(harness.panel.state.feedback.domainCases.entries[0].run.status,'invalid_protocol');
});
test('a late mounted response cannot restore the expanded old report over newer evidence',async t=>{
  let held=false,release,feedback=mountedFeedback();const harness=mountHarness(t,async url=>url.endsWith('repair-feedback')?held?new Promise(resolve=>release=resolve):Response.json({feedback}):Response.json({proposals:[{id,latestJob:{status:'succeeded'}}]}));
  await harness.panel.inspectFeedback(id);harness.details().open=true;held=true;const old=harness.panel.refresh();while(!release)await Promise.resolve();
  held=false;feedback=mountedFeedback(id,'v2','r2');await harness.panel.refresh();assert.equal(harness.details().open,false);
  release(Response.json({feedback:mountedFeedback()}));await old;assert.equal(harness.panel.state.feedback.validationId,'v2');assert.equal(harness.details().open,false);assert.match(harness.summary.textContent,/v2/);
});
test('every fixed execution status and gate has a readable Chinese display label',async t=>{
  const feedback=mountedFeedback();feedback.gates={artifactIntegrity:'passed',runtimeArtifact:'passed',static:'passed',syntax:'failed',repeatability:'not_run',domain:'failed',benchmark:'failed'};
  const values=['completed','timed_out','cancelled','output_limit','execution_failed','invalid_protocol','not_run'];
  feedback.domainCases={total:7,shown:7,omitted:0,entries:values.map((status,index)=>({name:`例 ${index}`,input:{json:'{}'},expected:{json:'{}'},actual:null,status:status==='not_run'?'not_run':'failed',run:{status}}))};
  const harness=mountHarness(t,async url=>Response.json(url.endsWith('repair-feedback')?{feedback}:{proposals:[{id}]}));await harness.panel.inspectFeedback(id);const rendered=harness.summary.textContent;
  for(const label of ['材料完整性','镜像与源码','静态检查','语法','重复性','领域案例','基线净收益','运行完成','运行超时','已取消','输出超限','执行失败','输出协议不符','未执行'])assert.ok(rendered.includes(label),label);
  for(const status of values)assert.equal(rendered.includes(status),false,status);
});
test('an ambiguous network failure preserves the UUID across page reload retry, then a later explicit attempt gets a new key',async()=>{
  const saved=storage(),keys=[];let number=0;
  const fetcher=async(url,options)=>{if(options?.method==='POST'){keys.push(JSON.parse(options.body).requestId);if(keys.length===1)throw new Error('secret');return Response.json({job:{status:'pending'}},{status:202});}return Response.json(url.endsWith('validation-summary')?{summary:null}:{proposals:[]});};
  const options={storage:saved,fetcher,uuid:()=>`00000000-0000-4000-8000-${String(++number).padStart(12,'0')}`};
  const first=createToolPanel(options);await first.validate(id);assert.match(first.state.error,/未确认/);assert.doesNotMatch(first.state.error,/secret/);
  const reloaded=createToolPanel(options);await reloaded.validate(id);assert.equal(keys[0],keys[1]);await reloaded.validate(id);assert.notEqual(keys[1],keys[2]);
});

test('successful reads clear a read error but preserve an unresolved POST warning',async()=>{
  let readsFail=true,postFails=false;const calls=[];
  const panel=createToolPanel({storage:storage(),uuid:()=>id,fetcher:async(url,options)=>{calls.push({url,options});if(readsFail||postFails&&options?.method==='POST')throw new Error('private');return Response.json({proposals:[]});}});
  await panel.refresh();assert.match(panel.state.error,/读取失败/);readsFail=false;await panel.refresh();assert.equal(panel.state.error,'');
  postFails=true;await panel.validate(id);assert.match(panel.state.error,/未确认/);await panel.refresh();assert.match(panel.state.error,/未确认/);
  assert.equal(calls.filter(c=>c.options?.method==='POST').length,1);
});
test('feedback is an explicit view and read refresh never sends validation work',async()=>{
  const calls=[];const feedback={proposalId:id,validationId:'evidence'};
  const panel=createToolPanel({storage:storage(),fetcher:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('repair-feedback')?{feedback}:url.endsWith('validation-summary')?{summary:{passed:false}}:{proposals:[{id,latestJob:{status:'succeeded'}}]});}});
  assert.equal(typeof panel.inspectFeedback,'function');await panel.inspectFeedback(id);assert.equal(panel.state.view,'feedback');assert.deepEqual(panel.state.feedback,feedback);assert.equal(panel.state.summary,null);
  await panel.refresh();assert.deepEqual(panel.state.feedback,feedback);await panel.select(id);assert.equal(panel.state.view,'summary');assert.equal(panel.state.feedback,null);assert.equal(panel.state.summary.passed,false);
  assert.equal(calls.some(c=>c.options?.method==='POST'),false);
});
for(const action of ['select','submit','refresh'])test(`late feedback after ${action} cannot resurrect old evidence`,async()=>{
  const queue=[];const panel=createToolPanel({storage:storage(),uuid:()=>id,fetcher:(url,options)=>new Promise(resolve=>queue.push({url,options,resolve}))});
  assert.equal(typeof panel.inspectFeedback,'function');const reading=panel.inspectFeedback(id);queue[0].resolve(Response.json({proposals:[{id,latestJob:{status:'succeeded'}}]}));while(queue.length<2)await Promise.resolve();assert.match(queue[1].url,/repair-feedback$/);
  const next=action==='select'?panel.select('11111111-1111-4111-8111-111111111111'):action==='submit'?panel.validate(id):panel.refresh();
  queue[1].resolve(Response.json({feedback:{validationId:'STALE'}}));await reading;assert.equal(panel.state.feedback,null);
  if(action==='submit'){queue[2].resolve(Response.json({job:{status:'pending'}},{status:202}));while(queue.length<4)await Promise.resolve();queue[3].resolve(Response.json({proposals:[{id,latestJob:{status:'pending'}}]}));}
  else queue[2].resolve(Response.json({proposals:action==='select'?[]:[{id,latestJob:{status:'running'}}]}));
  if(action==='select'){while(queue.length<4)await Promise.resolve();queue[3].resolve(Response.json({summary:null}));}
  await next;assert.equal(panel.state.feedback,null);
});
for(const actual of [{json:'{"y":1}'},null])test(`mounted feedback renders ${actual?'business JSON':'invalid protocol without calling it not_run'} and prompt through textContent`,async()=>{
  class Element{constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.listeners={};this._text='';}set textContent(value){this._text=String(value);}get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}set innerHTML(value){throw new Error('HTML rendering forbidden');}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[...nodes];}addEventListener(type,callback){this.listeners[type]=callback;}}
  const elements=new Map(['tools-list','tools-status','tools-summary','refresh-tools'].map(name=>[name,new Element('div')]));const document={getElementById:id=>elements.get(id),createElement:tag=>new Element(tag),visibilityState:'hidden'};
  const oldFetch=globalThis.fetch,oldTimeout=globalThis.setTimeout,oldListener=globalThis.addEventListener;
  globalThis.fetch=async url=>Response.json(url.endsWith('repair-feedback')?{feedback:{proposalId:id,validationId:'v1',reportSha256:'r1',gates:{domain:'failed'},domainCases:{total:1,shown:1,omitted:0,entries:[{name:'<script>case</script>',status:'failed',input:{json:'{"x":"<img>"}'},expected:{json:'{"y":2}'},actual,run:{status:actual?'completed':'invalid_protocol'}}]},benchmarkCases:{total:0,shown:0,omitted:0,entries:[]},benchmarkGate:{candidateScore:0,baselineScore:0,netGain:0,minNetGain:1,passed:false},prompt:'<script>preview not sent</script>'}}:{proposals:[{id,toolName:'example',state:'verification_failed'}]});globalThis.setTimeout=()=>0;globalThis.addEventListener=()=>{};
  try{const panel=mountToolPanel(document);await panel.inspectFeedback(id);const rendered=elements.get('tools-summary').textContent;assert.match(rendered,/<script>case<\/script>/);assert.match(rendered,/<img>/);assert.match(rendered,/preview not sent/);assert.match(rendered,/只读预览|不会发送/);if(!actual){assert.match(rendered,/输出协议不符/);assert.doesNotMatch(rendered,/not_run|未执行/);}}finally{globalThis.fetch=oldFetch;globalThis.setTimeout=oldTimeout;globalThis.addEventListener=oldListener;}
});
test('polling a failed report keeps job completion distinct and stale refresh never replaces newer evidence',async()=>{
  const queue=[];const panel=createToolPanel({storage:storage(),fetcher:(url)=>new Promise(resolve=>queue.push({url,resolve}))});
  const old=panel.refresh(),fresh=panel.refresh();queue[1].resolve(Response.json({proposals:[{id,state:'verification_failed',latestJob:{status:'succeeded',passed:false}}]}));await fresh;
  queue[0].resolve(Response.json({proposals:[]}));await old;assert.equal(panel.state.proposals[0].latestJob.status,'succeeded');assert.equal(panel.state.proposals[0].latestJob.passed,false);
});
test('concurrent validation clicks cannot submit duplicate HTTP work or clear an unresolved key',async()=>{
  let resolve,calls=0;const panel=createToolPanel({storage:storage(),uuid:()=>id,fetcher:async(url,options)=>{if(options?.method==='POST'){calls++;return new Promise(r=>resolve=r);}return Response.json(url.endsWith('validation-summary')?{summary:null}:{proposals:[]});}});
  const one=panel.validate(id);await panel.validate(id);assert.equal(calls,1);resolve(Response.json({job:{status:'pending'}},{status:202}));await one;
});
test('polling during submission cannot resurrect an older report while the new job is unconfirmed',async()=>{
  let release;const urls=[];
  const panel=createToolPanel({storage:storage(),uuid:()=>id,fetcher:async(url,options)=>{urls.push(url);if(options?.method==='POST')return new Promise(r=>release=r);return Response.json(url.endsWith('validation-summary')?{summary:{passed:false}}:{proposals:[{id,latestJob:{status:'succeeded'}}]});}});
  const submit=panel.validate(id);await panel.refresh();assert.equal(panel.state.summary,null);assert.equal(urls.some(u=>u.endsWith('validation-summary')),false);
  release(Response.json({job:{status:'pending'}},{status:202}));await submit;
});
for(const target of [id,'11111111-1111-4111-8111-111111111111'])test(`an old in-flight summary cannot appear after validating ${target===id?'the same candidate':'a different candidate'}`,async()=>{
  const queue=[],frames=[];
  const panel=createToolPanel({storage:storage(),uuid:()=>id,onChange:state=>frames.push({selectedId:state.selectedId,submitting:state.submitting,summary:state.summary}),fetcher:(url,options)=>new Promise(resolve=>queue.push({url,options,resolve}))});
  const selecting=panel.select(id);
  queue[0].resolve(Response.json({proposals:[{id,latestJob:{status:'succeeded'}}]}));
  // Let the existing refresh advance beyond its submitting check and await
  // evidence. Only then begin the validation that invalidates this response.
  while(queue.length<2)await Promise.resolve();assert.match(queue[1].url,/validation-summary$/);
  const submitting=panel.validate(target);assert.equal(queue[2].options.method,'POST');
  queue[1].resolve(Response.json({summary:{proposalId:id,validationId:'OLD-REPORT',passed:true}}));await selecting;
  assert.equal(panel.state.selectedId,target);assert.equal(panel.state.submitting,target);assert.equal(panel.state.summary,null);
  assert.equal(frames.some(f=>f.selectedId===target&&f.submitting===target&&f.summary!==null),false);
  queue[2].resolve(Response.json({job:{status:'pending'}},{status:202}));while(queue.length<4)await Promise.resolve();
  queue[3].resolve(Response.json({proposals:[{id:target,latestJob:{status:'pending'}}]}));await submitting;assert.equal(panel.state.summary,null);
});
