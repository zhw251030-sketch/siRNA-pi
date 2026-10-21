import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolPanel} from '../public/tools.mjs';
const id='26883ce8-5c2e-4a0e-90fb-d96e53270b9c';
function storage(){const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};}
test('an ambiguous network failure preserves the UUID across page reload retry, then a later explicit attempt gets a new key',async()=>{
  const saved=storage(),keys=[];let number=0;
  const fetcher=async(url,options)=>{if(options?.method==='POST'){keys.push(JSON.parse(options.body).requestId);if(keys.length===1)throw new Error('secret');return Response.json({job:{status:'pending'}},{status:202});}return Response.json(url.endsWith('validation-summary')?{summary:null}:{proposals:[]});};
  const options={storage:saved,fetcher,uuid:()=>`00000000-0000-4000-8000-${String(++number).padStart(12,'0')}`};
  const first=createToolPanel(options);await first.validate(id);assert.match(first.state.error,/未确认/);assert.doesNotMatch(first.state.error,/secret/);
  const reloaded=createToolPanel(options);await reloaded.validate(id);assert.equal(keys[0],keys[1]);await reloaded.validate(id);assert.notEqual(keys[1],keys[2]);
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
