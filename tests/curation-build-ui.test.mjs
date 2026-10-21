import test from 'node:test';
import assert from 'node:assert/strict';
import {createCurationPreviewPanel} from '../public/curation.mjs';
import * as curationUi from '../public/curation.mjs';
import * as toolsUi from '../public/tools.mjs';

class Element {
  constructor(tag,document){this.tagName=tag;this.ownerDocument=document;this.children=[];this.listeners={};this.dataset={};this._text='';}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  set innerHTML(_){throw Error('unsafe HTML');}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this._text='';this.children=children;}
  setAttribute(key,value){this[key]=value;}
  addEventListener(type,callback){this.listeners[type]=callback;}
}
const task={id:'a538889f-0ea6-4b87-95ad-efed613a815f',status:'idle'},id='7693a5ab-08ae-4ec2-bd57-1cbe16e6c202';
const binding={traceSha256:'a'.repeat(64),resultSha256:'b'.repeat(64),promptSha256:'c'.repeat(64)};
const curation={id,status:'candidate',traceSha256:binding.traceSha256,result:{summary:'<img onerror=x>',candidate:{suggestedToolName:'shape_tool',permissions:{profile:'no_external_access'}}}};
const view={eligible:true,reason:null,binding,prompt:'<script>fixed prompt</script>',handoff:null};
const ticket={taskId:task.id,sourceTaskId:task.id,curationId:id,requestId:`auto-tool-curation-build:${id}`,phase:'submitted',proposalId:'proposal-one',userMessageId:'message-one',runId:'run-one'};
function all(root){return [root,...root.children.flatMap(all)];}
function button(h,label){const b=all(h.root).find(node=>node.tagName==='button'&&node.textContent===label);assert.ok(b,`button ${label}`);return b;}
function memory(){const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}
function harness(fetcher,options={}){
  const document={createElement:tag=>new Element(tag,document)},root=new Element('section',document);
  const panel=createCurationPreviewPanel({root,fetcher,storage:memory(),onOpenTask:()=>{},onOpenProposal:()=>{},...options});panel.setTask(task);return {root,panel};
}
async function details(h){await button(h,'刷新审查记录').listeners.click();await button(h,'读取审查详情').listeners.click();}

test('candidate build preview is a manual safe read, then explicit POST binds exactly the displayed prompt',async()=>{
  const calls=[],opened=[];const h=harness(async(url,options)=>{
    calls.push([url,options]);return Response.json(url.endsWith('/build')?(options.method==='POST'?{handoff:ticket,deduplicated:false}:view):url.endsWith('/curations')?{curations:[{...curation,result:undefined}]}:{curation});
  },{onOpenTask:value=>opened.push(['task',value]),onOpenProposal:value=>opened.push(['proposal',value])});
  await details(h);assert.equal(calls.length,2);await button(h,'读取构建说明与状态').listeners.click();assert.equal(calls.length,3);
  assert.ok(h.root.textContent.includes(view.prompt));const submit=button(h,'交给 Builder（调用模型）');assert.equal(submit.disabled,false);
  await submit.listeners.click();assert.equal(calls.length,4);assert.deepEqual(JSON.parse(calls[3][1].body),binding);assert.equal(calls[3][1].method,'POST');assert.equal(submit.disabled,true);
  assert.ok(h.root.textContent.includes('仍须独立验证和人工批准'));assert.equal(h.root.textContent.includes('尚未发送'),false);await button(h,'查看原任务聊天').listeners.click();await button(h,'查看已登记提案').listeners.click();assert.deepEqual(opened,[['task',task.id],['proposal','proposal-one']]);
});

test('noncandidate and unsupported runtime never expose an enabled build submit',async()=>{
  const h=harness(async url=>Response.json(url.endsWith('/curations')?{curations:[{...curation,status:'skipped',result:undefined}]}:{curation:{...curation,status:'skipped'}}));await details(h);
  assert.equal(all(h.root).some(n=>n.textContent==='交给 Builder（调用模型）'),false);
  const g=harness(async url=>Response.json(url.endsWith('/build')?{eligible:false,reason:'task_unavailable',handoff:null}:url.endsWith('/curations')?{curations:[curation]}:{curation}));await details(g);await button(g,'读取构建说明与状态').listeners.click();assert.equal(button(g,'交给 Builder（调用模型）').disabled,true);assert.match(g.root.textContent,/任务.*不可继续/);
});

test('uncertain POST remains disabled through manual GET, same-candidate rerender and reload; saved ticket restores navigation',async()=>{
  let posts=0,saved=false;const storage=memory();
  const fetcher=async(url,options)=>{
    if(url.endsWith('/build')){if(options.method==='POST'){posts++;throw Error('reply lost');}return Response.json(saved?{eligible:false,reason:'already_requested',binding,prompt:view.prompt,handoff:ticket}:view);}
    return Response.json(url.endsWith('/curations')?{curations:[curation]}:{curation});
  };
  const h=harness(fetcher,{storage});await details(h);await button(h,'读取构建说明与状态').listeners.click();await button(h,'交给 Builder（调用模型）').listeners.click();assert.match(h.root.textContent,/结果未确认/);
  await button(h,'读取构建说明与状态').listeners.click();assert.equal(button(h,'交给 Builder（调用模型）').disabled,true);
  await details(h);await button(h,'读取构建说明与状态').listeners.click();assert.equal(button(h,'交给 Builder（调用模型）').disabled,true);
  const reloaded=harness(fetcher,{storage});await details(reloaded);await button(reloaded,'读取构建说明与状态').listeners.click();assert.equal(button(reloaded,'交给 Builder（调用模型）').disabled,true);assert.equal(posts,1);
  saved=true;await button(reloaded,'读取构建说明与状态').listeners.click();assert.ok(button(reloaded,'查看原任务聊天'));assert.equal(button(reloaded,'交给 Builder（调用模型）').disabled,true);
});

test('late build GET and POST JSON cannot overwrite a different task or candidate generation',async()=>{
  for(const method of ['GET','POST']){
    let resolveJson;const h=harness(async(url,options)=>url.endsWith('/build')?(options.method===method?{ok:true,json:()=>new Promise(resolve=>resolveJson=resolve)}:Response.json(view)):Response.json(url.endsWith('/curations')?{curations:[curation]}:{curation}));
    await details(h);if(method==='POST')await button(h,'读取构建说明与状态').listeners.click();
    const pending=button(h,method==='GET'?'读取构建说明与状态':'交给 Builder（调用模型）').listeners.click();while(!resolveJson)await Promise.resolve();
    h.panel.setTask({...task,id:'other-task'});resolveJson(method==='GET'?view:{handoff:ticket,deduplicated:false});await pending;
    assert.equal(h.root.textContent.includes(view.prompt),false);assert.equal(h.root.textContent.includes('proposal-one'),false);assert.equal(h.root.textContent.includes('结果未确认'),false);
  }
});

test('a mismatched returned handoff never unlocks repeat POST or renders another proposal',async()=>{
  const h=harness(async(url,options)=>Response.json(url.endsWith('/build')?(options.method==='POST'?{handoff:{...ticket,curationId:'another-candidate'},deduplicated:false}:view):url.endsWith('/curations')?{curations:[curation]}:{curation}));
  await details(h);await button(h,'读取构建说明与状态').listeners.click();await button(h,'交给 Builder（调用模型）').listeners.click();assert.equal(button(h,'交给 Builder（调用模型）').disabled,true);assert.match(h.root.textContent,/结果未确认/);assert.equal(h.root.textContent.includes('proposal-one'),false);
});

test('navigation bridge selects the registered proposal in the existing tool panel without a new URL or POST',async()=>{
  assert.equal(typeof curationUi.curationNavigation,'function');assert.equal(typeof toolsUi.bindToolProposalNavigation,'function');
  const opened=[],reads=[],listeners={};
  const document={addEventListener:(type,callback)=>listeners[type]=callback,dispatchEvent:event=>{listeners[event.type]?.(event);return true;},defaultView:{CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}}}};
  const proposalId='f76826d3-ce14-4edf-a21a-1c81ede8c7cd';
  const panel=toolsUi.createToolPanel({storage:memory(),fetcher:async(url,options)=>{reads.push([url,options]);return Response.json(url.endsWith('validation-summary')?{summary:null}:{proposals:[{id:proposalId,state:'submitted'}]});}});
  toolsUi.bindToolProposalNavigation(document,panel);
  const nav=curationUi.curationNavigation({document,openTask:id=>opened.push(id)});nav.onOpenTask(task.id);nav.onOpenProposal(proposalId);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(opened,[task.id]);assert.equal(panel.state.selectedId,proposalId);assert.ok(reads.some(([url])=>url===`/v1/tool-proposals/${proposalId}/validation-summary`));assert.equal(reads.some(([,options])=>options?.method==='POST'),false);
  nav.onOpenTask('bad');await nav.onOpenProposal('bad');assert.deepEqual(opened,[task.id]);assert.equal(panel.state.selectedId,proposalId);
});

test('in-flight build blocks repeated clicks and unavailable request storage fails closed before POST',async()=>{
  let complete,posts=0;const h=harness(async(url,options)=>{
    if(url.endsWith('/build')){if(options.method==='POST'){posts++;return new Promise(resolve=>complete=resolve);}return Response.json(view);}
    return Response.json(url.endsWith('/curations')?{curations:[curation]}:{curation});
  });await details(h);await button(h,'读取构建说明与状态').listeners.click();const send=button(h,'交给 Builder（调用模型）'),pending=send.listeners.click();await send.listeners.click();assert.equal(send.disabled,true);assert.equal(posts,1);complete(Response.json({handoff:ticket}));await pending;
  const g=harness(async(url,options)=>{if(options.method==='POST')posts++;return Response.json(url.endsWith('/build')?view:url.endsWith('/curations')?{curations:[curation]}:{curation});},{storage:{getItem(){throw Error('storage inaccessible');},setItem(){throw Error('storage inaccessible');}}});
  await details(g);await button(g,'读取构建说明与状态').listeners.click();assert.equal(button(g,'交给 Builder（调用模型）').disabled,true);await button(g,'交给 Builder（调用模型）').listeners.click();assert.equal(posts,1);
});
