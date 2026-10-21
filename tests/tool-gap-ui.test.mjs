import test from 'node:test';
import assert from 'node:assert/strict';
import {createCurationPreviewPanel} from '../public/curation.mjs';
class Element{
  constructor(tag,document){this.tagName=tag;this.ownerDocument=document;this.children=[];this.listeners={};this._text='';}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  set innerHTML(_){throw Error('Unsafe HTML');}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this._text='';this.children=children;}
  setAttribute(key,value){this[key]=value;}
  addEventListener(type,callback){this.listeners[type]=callback;}
}
const task={id:'task-a',currentRunId:'run-a',status:'idle'};
const report={id:'gap-a',taskId:task.id,runId:task.currentRunId,userMessageId:'user-a',capability:'<img onerror=x>',capabilityKey:'shape',blocking:true,reason:'<script>missing comparison</script>',desiredInput:{structures:['input-a']},desiredOutput:{distance:'number'},evidenceEventIds:['event-a'],createdAt:'2026-10-22T00:00:00.000Z',source:{agentTurnId:'turn-a'},reportSha256:'gap-sha'};
const preview=()=>({protocolVersion:'sirna-tool-curation-preview/v1',taskId:task.id,runId:task.currentRunId,userMessageId:'user-a',objective:'Compare structures',sourceSha256:'source-sha',previewSha256:'preview-sha',eligibleForReview:true,summary:{toolStarts:0,consideredCalls:0,excludedCalls:0,incompleteCalls:0,omittedCalls:0},limits:{maxCalls:12,omittedSignals:0,displayTruncated:false},signals:[],calls:[],gapReports:[structuredClone(report)]});
function harness(fetcher){const document={createElement:tag=>new Element(tag,document)},root=new Element('section',document),panel=createCurationPreviewPanel({root,fetcher});panel.setTask(task);return {root,panel};}
function button(h,text){return h.root.children.find(child=>child.tagName==='button'&&child.textContent===text);}

test('gap-only preview enables explicit review and safely displays Agent claims plus complete report details',async()=>{
  const requests=[],h=harness(async(url,options)=>{requests.push([url,options]);return Response.json(options.method==='POST'?{curation:{id:'review-a',status:'waiting',traceSha256:'trace'}}:{preview:preview()});});
  const submit=button(h,'提交独立审查（调用模型）');assert.equal(submit.disabled,true);await h.panel.refresh();assert.equal(requests.length,1);assert.equal(submit.disabled,false);
  for(const text of [report.capability,report.reason,'input-a','distance','event-a','gap-a','Agent 判断','不证明'])assert.ok(h.root.textContent.includes(text),text);
  await submit.listeners.click();assert.equal(requests.length,2);assert.equal(requests[1][0],'/v1/tasks/task-a/curations');assert.deepEqual(JSON.parse(requests[1][1].body),{runId:'run-a',sourceSha256:'source-sha',previewSha256:'preview-sha'});assert.equal(requests.some(([url])=>url.includes('/tool-gaps')),false);
});

test('late gap response cannot appear after task switch even if fetch and JSON ignore abort',async()=>{
  let finish;const h=harness(async()=>({ok:true,json:()=>new Promise(resolve=>finish=resolve)}));const pending=h.panel.refresh();while(!finish)await Promise.resolve();h.panel.setTask({...task,id:'task-b'});finish({preview:preview()});await pending;assert.equal(h.root.textContent.includes('gap-a'),false);assert.equal(button(h,'提交独立审查（调用模型）').disabled,true);
});

test('reports with mismatched task/run/user binding cannot enable review',async()=>{
  for(const patch of [{taskId:'task-b'},{runId:'run-b'},{userMessageId:'user-b'}]){
    const p=preview();p.gapReports[0]={...p.gapReports[0],...patch};const h=harness(async()=>Response.json({preview:p}));await h.panel.refresh();assert.equal(button(h,'提交独立审查（调用模型）').disabled,true);assert.equal(h.root.textContent.includes('gap-a'),false);
  }
});
