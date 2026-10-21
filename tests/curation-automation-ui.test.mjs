import test from 'node:test';
import assert from 'node:assert/strict';

class Element {
  constructor(tag,document){this.tagName=tag;this.ownerDocument=document;this.children=[];this.listeners={};this._text='';}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  set innerHTML(_){throw Error('Unsafe HTML');}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this._text='';this.children=children;}
  setAttribute(key,value){this[key]=value;}
  addEventListener(type,callback){this.listeners[type]=callback;}
}
const status=overrides=>({protocolVersion:'sirna-tool-curation-automation/v1',started:true,enabled:false,maxReviews:3,attempts:0,remaining:3,pending:0,reason:'disabled',recent:[],...overrides});
const response=value=>Response.json({automation:value});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function harness(fetcher){
  const module=await import('../public/curation-automation.mjs').catch(()=>({}));assert.equal(typeof module.createCurationAutomationPanel,'function','automation panel factory must exist');
  const document={createElement:tag=>new Element(tag,document)},root=new Element('section',document),panel=module.createCurationAutomationPanel({root,fetcher});
  return {root,panel,buttons:()=>root.children.filter(child=>child.tagName==='button')};
}
test('panel reads global off status and boundaries without automatic POST, then sends only exact explicit switches',async()=>{
  const calls=[];const h=await harness(async(url,options)=>{calls.push([url,options]);return response(status({enabled:options.method==='POST'}));});
  assert.equal(calls.length,0);await h.panel.refresh();assert.equal(calls.length,1);assert.equal(calls[0][1].method??'GET','GET');
  for(const text of ['关闭','剩余 3','最多 3','模型','七天','回答之后','不补','重启','新结束','人工','送审'])assert.ok(h.root.textContent.includes(text),text);
  await h.buttons().find(b=>b.textContent==='开启自动审查').listeners.click();assert.equal(calls.length,2);assert.deepEqual(JSON.parse(calls[1][1].body),{enabled:true});
  assert.equal(calls[1][0],'/v1/tool-curation-automation');assert.ok(h.root.textContent.includes('已开启'));assert.equal(h.buttons().find(b=>b.textContent==='关闭自动审查').disabled,false);
});
test('stale GET cannot overwrite a newer POST, and pending switches exclude repeated submissions',async()=>{
  const read=deferred(),post=deferred();let gets=0,posts=0;
  const h=await harness(async(_,options)=>options.method==='POST'?(posts++,post.promise):++gets===1?response(status()):read.promise);
  await h.panel.refresh();const stale=h.panel.refresh(),enable=h.buttons().find(b=>b.textContent==='开启自动审查');const changing=enable.listeners.click();
  assert.equal(enable.disabled,true);await enable.listeners.click();assert.equal(posts,1);
  post.resolve(response(status({enabled:true,reason:'enabled'})));await changing;read.resolve(response(status()));await stale;
  assert.ok(h.root.textContent.includes('已开启'));assert.equal(h.buttons().find(b=>b.textContent==='关闭自动审查').disabled,false);
});
test('unknown POST outcome forces a fresh GET and keeps controls locked until status is known',async()=>{
  const gate=deferred();let gets=0,posts=0;const h=await harness(async(_,options)=>{if(options.method==='POST'){posts++;throw Error('PRIVATE_HOST_KEY');}return ++gets===1?response(status()):gate.promise;});
  await h.panel.refresh();const changing=h.buttons().find(b=>b.textContent==='开启自动审查').listeners.click();
  await new Promise(r=>setImmediate(r));assert.equal(gets,2);assert.equal(posts,1);assert.equal(h.buttons().find(b=>b.textContent==='开启自动审查').disabled,true);
  gate.resolve(response(status({enabled:true})));await changing;assert.ok(h.root.textContent.includes('已开启'));assert.equal(h.root.textContent.includes('PRIVATE_HOST_KEY'),false);
});
test('exhausted and unavailable states stay disabled, recent results render as text, and failed reconciliation permits only refresh',async()=>{
  const h=await harness(async()=>response(status({attempts:3,remaining:0,reason:'budget_exhausted',recent:[{taskId:'<img>',runId:'run',userMessageId:'user',state:'admitted',reason:'accepted',curationId:'review-1'}]})));
  await h.panel.refresh();assert.ok(h.root.textContent.includes('耗尽'));assert.ok(h.root.textContent.includes('<img>'));assert.ok(h.root.textContent.includes('review-1'));assert.equal(h.buttons().find(b=>b.textContent==='开启自动审查').disabled,true);
  let calls=0;const broken=await harness(async()=>++calls===1?response(status()):Response.json({error:'PRIVATE_HOST_KEY'},{status:503}));
  await broken.panel.refresh();await broken.buttons().find(b=>b.textContent==='开启自动审查').listeners.click();assert.equal(calls,3);
  assert.equal(broken.buttons().find(b=>b.textContent==='开启自动审查').disabled,true);assert.equal(broken.buttons().find(b=>b.textContent==='刷新自动审查状态').disabled,false);assert.equal(broken.root.textContent.includes('PRIVATE_HOST_KEY'),false);
});
