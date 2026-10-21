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
function mountHarness(t,fetcher){
  const elements=new Map(['tools-list','tools-status','tools-summary','refresh-tools'].map(name=>[name,new MountedElement('div')]));
  const document={getElementById:id=>elements.get(id),createElement:tag=>new MountedElement(tag),visibilityState:'hidden'};
  const saved=new Map(['fetch','setTimeout','addEventListener','sessionStorage'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const overrides={fetch:fetcher,setTimeout:()=>0,addEventListener:()=>{},sessionStorage:storage()};for(const [key,value] of Object.entries(overrides))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  t.after(()=>{for(const [key,descriptor] of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
  const find=(node,tag)=>node.tagName===tag?node:node.children.map(child=>find(child,tag)).find(Boolean);
  return {panel:mountToolPanel(document),summary:elements.get('tools-summary'),details:()=>find(elements.get('tools-summary'),'details')};
}
function mountedFeedback(proposalId=id,validationId='v1',reportSha256='r1'){
  return {proposalId,validationId,reportSha256,gates:{domain:'failed',repeatability:'not_run'},domainCases:{total:0,shown:0,omitted:0,entries:[]},benchmarkCases:{total:0,shown:0,omitted:0,entries:[]},benchmarkGate:{candidateScore:0,baselineScore:0,netGain:0,minNetGain:1,passed:false},prompt:'read this fixed repair preview'};
}

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
  try{const panel=mountToolPanel(document);await panel.inspectFeedback(id);const rendered=elements.get('tools-summary').textContent;assert.match(rendered,/<script>case<\/script>/);assert.match(rendered,/<img>/);assert.match(rendered,/preview not sent/);assert.match(rendered,/未派发|未发送/);if(!actual){assert.match(rendered,/输出协议不符/);assert.doesNotMatch(rendered,/not_run|未执行/);}}finally{globalThis.fetch=oldFetch;globalThis.setTimeout=oldTimeout;globalThis.addEventListener=oldListener;}
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
