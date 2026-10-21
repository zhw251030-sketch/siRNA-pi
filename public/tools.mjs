// This panel is global: candidate jobs do not belong to the selected chat.
export function createToolPanel({fetcher=fetch,storage=globalThis.sessionStorage,uuid=()=>crypto.randomUUID(),onChange=()=>{}}={}){
  let state={proposals:[],maintenance:{accepting:true,halted:false},loading:false,submitting:null,repairSubmitting:null,activeRepairIds:[],selectedId:null,view:'summary',summary:null,feedback:null,repairStatus:null,repairCandidateId:null,error:''};
  let refreshVersion=0;
  let repairBinding=null;
  const activeRepairs=new Set();
  const unconfirmed=new Set();
  const repairKey='sirna-pi.repair-unconfirmed';
  let repairUnknown=new Map();
  try{const entries=JSON.parse(storage.getItem(repairKey)??'[]');if(Array.isArray(entries))for(const [id,value] of entries)if(typeof id==='string'&&typeof value?.validationId==='string'&&typeof value?.reportSha256==='string')repairUnknown.set(id,value);}catch{/* A storage read failure cannot authorize work. */}
  const saveUnknown=()=>storage.setItem(repairKey,JSON.stringify([...repairUnknown]));
  const postWarning=()=>[unconfirmed.size?'验证请求未确认；重试会沿用同一请求编号。请刷新检查候选和作业状态。':'',...Array.from(repairUnknown.keys(),id=>`候选 ${id} 的修订请求未确认，可能已被接纳；请先刷新检查派发状态，不会自动重发。`)].filter(Boolean).join(' ');
  const update=patch=>{state={...state,...patch,unconfirmedRepairIds:[...repairUnknown.keys()]};onChange(state);};
  const matches=(ticket,id,binding)=>ticket?.proposalId===id&&ticket.validationId===binding?.validationId&&ticket.reportSha256===binding?.reportSha256&&['dispatching','running','awaiting_replacement','superseded','failed','interrupted'].includes(ticket.phase);
  const acknowledge=ticket=>{const binding=repairUnknown.get(ticket?.proposalId);if(binding&&matches(ticket,ticket.proposalId,binding)){repairUnknown.delete(ticket.proposalId);try{saveUnknown();}catch{/* Keep the current session usable if storage becomes unavailable. */}}};
  const remember=ticket=>{if(!ticket?.proposalId)return;acknowledge(ticket);if(['dispatching','running'].includes(ticket.phase))activeRepairs.add(ticket.proposalId);else if(['awaiting_replacement','superseded','failed','interrupted'].includes(ticket.phase))activeRepairs.delete(ticket.proposalId);};
  const activeRepair=id=>activeRepairs.has(id);
  const validationUnconfirmed=id=>{if(unconfirmed.has(id))return true;try{return storage.getItem(`sirna-pi.validation-request.${id}`)!==null;}catch{return true;}};
  const canRepair=id=>!!id&&id===state.selectedId&&id===state.feedback?.proposalId&&id===state.repairCandidateId&&state.view==='feedback'&&!state.loading&&!state.submitting&&!state.repairSubmitting&&!validationUnconfirmed(id)&&state.repairStatus?.canRepair===true&&!!state.repairStatus.sourceTaskId&&!state.repairStatus.repair&&repairBinding?.validationId===state.feedback.validationId&&repairBinding?.reportSha256===state.feedback.reportSha256&&(!repairUnknown.has(id)||matches({...repairUnknown.get(id),proposalId:id,phase:'running'},id,repairBinding));
  async function json(url,options){const response=await fetcher(url,options);if(!response.ok)throw new Error('Request failed');return response.json();}
  const panel={
    get state(){return state;},
    canRepair,
    async refresh(){const version=++refreshVersion;const selected=state.selectedId,submitting=state.submitting,repairSubmitting=state.repairSubmitting,view=state.view;repairBinding=null;update({loading:true,summary:null,feedback:null,repairStatus:null,repairCandidateId:null});
      const current=()=>version===refreshVersion&&selected===state.selectedId&&submitting===state.submitting&&repairSubmitting===state.repairSubmitting&&view===state.view;
      try{const data=await json('/v1/tool-proposals');let summary=null,feedback=null,repairStatus=null;
        if(!current())return;
        const selectedJob=data.proposals.find(p=>p.id===selected)?.latestJob;
        if(selected&&!state.submitting&&!state.repairSubmitting&&!['pending','running'].includes(selectedJob?.status)){
          if(view==='feedback'){
            feedback=(await json(`/v1/tool-proposals/${encodeURIComponent(selected)}/repair-feedback`)).feedback;
            if(!current())return;
            repairStatus=await json(`/v1/tool-proposals/${encodeURIComponent(selected)}/repair-status`);
          }
          else summary=(await json(`/v1/tool-proposals/${encodeURIComponent(selected)}/validation-summary`)).summary;
        }
        // Keep known in-flight repairs observable even after changing selection.
        // These reads never dispatch a model or retry an uncertain POST.
        for(const id of activeRepairs){
          if(!current())return;
          if(id===selected&&repairStatus)continue;
          const other=await json(`/v1/tool-proposals/${encodeURIComponent(id)}/repair-status`);
          if(!current())return;
          if(other?.repair?.proposalId===id)remember(other.repair);
        }
        if(current()){
          // A read may discover a saved validation request after reload, but
          // only its existing explicit same-UUID POST flow can confirm it.
          if(selected&&validationUnconfirmed(selected))unconfirmed.add(selected);
          if(repairStatus?.repair?.proposalId===selected)remember(repairStatus.repair);
          if(feedback?.proposalId===selected&&repairStatus)repairBinding={validationId:feedback.validationId,reportSha256:feedback.reportSha256};
          update({proposals:data.proposals,maintenance:data.maintenance??{accepting:true,halted:false},summary,feedback,repairStatus,repairCandidateId:repairStatus?selected:null,activeRepairIds:[...activeRepairs],loading:false,error:postWarning()});
        }
      }catch{if(current())update({loading:false,summary:null,feedback:null,repairStatus:null,repairCandidateId:null,error:postWarning()||'候选或证据读取失败，请刷新后重试。'});}
    },
    async select(id){update({selectedId:id,view:'summary',summary:null,feedback:null,error:postWarning()});await panel.refresh();},
    async inspectFeedback(id){update({selectedId:id,view:'feedback',summary:null,feedback:null,error:postWarning()});await panel.refresh();},
    async repair(id){if(!canRepair(id))return;
      const binding={validationId:state.feedback.validationId,reportSha256:state.feedback.reportSha256};
      ++refreshVersion;repairBinding=null;
      update({repairSubmitting:id,summary:null,feedback:null,repairStatus:null,repairCandidateId:null,loading:false});
      try{
        // Save the exact report before dispatch; refresh/reload never resends it.
        repairUnknown.set(id,binding);saveUnknown();
        const result=await json(`/v1/tool-proposals/${encodeURIComponent(id)}/repair`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(binding)});
        if(!matches(result?.repair,id,binding))throw new Error('Unconfirmed repair');
        remember(result.repair);
      }catch{/* An HTTP/network failure can follow acceptance. Preserve the binding. */}
      update({repairSubmitting:null,activeRepairIds:[...activeRepairs],error:postWarning()});await panel.refresh();
    },
    async validate(id){if(state.submitting||state.repairSubmitting||activeRepair(id)||repairUnknown.has(id))return;
      ++refreshVersion; // Invalidate evidence already awaiting its HTTP response.
      repairBinding=null;update({submitting:id,selectedId:id,summary:null,feedback:null,repairStatus:null,repairCandidateId:null,error:postWarning(),loading:false});
      const key=`sirna-pi.validation-request.${id}`;
      try{
        // Persist BEFORE POST. Reload or a lost acknowledgement retries exactly
        // this UUID; only a confirmed response permits a new explicit request.
        let requestId=storage.getItem(key);if(!requestId){requestId=uuid();storage.setItem(key,requestId);}
        await json(`/v1/tool-proposals/${encodeURIComponent(id)}/validate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId})});
        storage.removeItem(key);unconfirmed.delete(id);update({submitting:null,error:postWarning()});await panel.refresh();
      }catch{unconfirmed.add(id);update({submitting:null,error:postWarning()});}
    },
  };return panel;
}

const states={submitted:'待验证',verification_failed:'验证未通过',verified:'验证通过，待人工批准',approved:'已人工批准'};
const jobStates={pending:'排队中',running:'验证运行中',succeeded:'验证流程完成',failed:'执行失败',interrupted:'执行中断，未自动重试'};
const feedbackGates={artifactIntegrity:'材料完整性',runtimeArtifact:'镜像与源码',static:'静态检查',syntax:'语法',repeatability:'重复性',domain:'领域案例',benchmark:'基线净收益'};
const feedbackStatuses={passed:'通过',failed:'未通过',not_run:'未执行',completed:'运行完成',timed_out:'运行超时',cancelled:'已取消',output_limit:'输出超限',execution_failed:'执行失败',invalid_protocol:'输出协议不符'};
const feedbackStatus=value=>feedbackStatuses[value]??'未知状态';
const repairReasons={unavailable:'修订服务暂不可用。',stopped:'修订服务正在停止。',invalid_id:'候选编号不正确。',not_found:'没有找到候选。',invalid_request:'修订报告编号不完整。',no_source:'此候选没有可信来源任务。',invalid_evidence:'候选材料、来源或验证证据不完整。',not_failed:'此候选没有完整的失败验证报告。',max_attempts:'此修订链已达到三代上限。',task_unavailable:'来源任务不可继续或执行状态无法确认。',busy:'来源任务或候选正在执行。',maintenance_unavailable:'候选验证服务已停止或暂停。',validation_pending:'候选仍在排队或验证中。',report_conflict:'当前报告与已请求的报告不同。',already_requested:'此候选已请求过一轮修订。',context_too_large:'完整修订材料超过消息上限，未派发。',registration_refused:'新候选不符合修订合同。'};
const repairPhases={dispatching:'正在确认派发',running:'一轮修订运行中',awaiting_replacement:'本轮已结束，未收到新候选',superseded:'已登记替代候选',failed:'本轮执行或保存失败，未自动重发',interrupted:'上次派发结果未确认，未自动重发'};
export function mountToolPanel(document){
  const list=document.getElementById('tools-list'),status=document.getElementById('tools-status'),summary=document.getElementById('tools-summary');
  if(!list||!status||!summary)return;
  const text=(tag,value,className)=>{const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node;};
  // Evidence is still cleared during refresh. Retain only the user's display
  // preference until the same proposal AND exact report identity returns.
  let promptPreference=null,promptNode=null,promptBody=null,lastSelection=null;
  const panel=createToolPanel({onChange:view=>{
    if(promptNode&&promptPreference){promptPreference.open=promptNode.open;promptPreference.scrollTop=promptBody.scrollTop;}
    promptNode=null;promptBody=null;
    const selection=JSON.stringify([view.selectedId,view.view]);
    const activeJob=view.proposals.find(p=>p.id===view.selectedId)?.latestJob;
    if(selection!==lastSelection||view.submitting||['pending','running'].includes(activeJob?.status))promptPreference=null;
    lastSelection=selection;
    status.textContent=view.error||(view.maintenance.halted?'验证队列已暂停，请先检查私有运行记录；重启不会自动解除。':view.loading?'正在刷新候选…':'候选与聊天任务分别管理；验证完成后仍需人工批准。');
    list.replaceChildren();
    if(!view.proposals.length)list.append(text('p','暂无已登记候选。','help'));
    for(const p of view.proposals){
      const row=text('div','','tool-proposal');row.dataset.proposalId=p.id;
      row.append(text('strong',p.toolName),text('p',`${p.id} · ${states[p.state]??p.state}`,'help'));
      const job=p.latestJob;
      if(job){row.append(text('p',`${jobStates[job.status]??job.status}${job.status==='succeeded'?` · 报告${job.passed?'通过':'未通过'}`:''}`));if(job.error)row.append(text('p',job.error,'help'));}
      const validate=text('button',view.submitting===p.id?'正在提交…':'验证候选','button secondary');validate.type='button';validate.dataset.validateProposal=p.id;
      validate.disabled=!!view.submitting||!!view.repairSubmitting||view.activeRepairIds.includes(p.id)||view.unconfirmedRepairIds.includes(p.id)||!view.maintenance.accepting||!['submitted','verification_failed'].includes(p.state)||['pending','running'].includes(job?.status);
      validate.addEventListener('click',()=>panel.validate(p.id));row.append(validate);
      const inspect=text('button','查看验证摘要','button secondary');inspect.type='button';inspect.addEventListener('click',()=>panel.select(p.id));row.append(inspect);list.append(row);
      const feedback=text('button','查看修订反馈','button secondary');feedback.type='button';feedback.disabled=!!view.submitting||['pending','running'].includes(job?.status);feedback.addEventListener('click',()=>panel.inspectFeedback(p.id));row.append(feedback);
    }
    summary.replaceChildren();
    if(view.selectedId&&view.view==='feedback'){
      summary.append(text('h3','修订反馈与派发状态'),text('p',view.selectedId,'help'));
      const repair=view.repairStatus,ticket=repair?.repair;
      summary.append(text('p','反馈和修订说明为只读预览；刷新不会运行模型。','help'));
      if(repair){
        summary.append(text('p',repair.sourceTaskId?`可信来源任务：${repair.sourceTaskId}`:'此候选没有可信来源任务。'),text('p',`修订深度 ${repair.attempt}/${repair.maxRepairAttempts} · 根候选 ${repair.rootProposalId}`));
        if(ticket){summary.append(text('p',`派发状态：${repairPhases[ticket.phase]??'状态暂无法确认'}`));if(ticket.message)summary.append(text('p',ticket.message));
          if(ticket.replacementProposalId){summary.append(text('p',`新候选：${ticket.replacementProposalId}；仍须独立验证和人工批准。`));const inspect=text('button','查看新候选','button secondary');inspect.type='button';inspect.dataset.viewReplacement=ticket.replacementProposalId;inspect.addEventListener('click',()=>panel.select(ticket.replacementProposalId));summary.append(inspect);}
        }else if(!repair.canRepair)summary.append(text('p',repairReasons[repair.reason]??'当前无法确认修订资格，请刷新检查。'));
        else summary.append(text('p','当前符合本地修订条件；提交时仍会检查来源任务是否空闲、可继续。','help'));
      }
      summary.append(text('p','请求修订会运行 Agent 并消耗模型额度；每次只启动一轮。新候选仍须独立验证和人工批准。','help'));
      const request=text('button',view.repairSubmitting===view.selectedId?'正在请求一轮修订…':'请求一轮修订','button secondary');request.type='button';request.dataset.repairProposal=view.selectedId;request.disabled=!panel.canRepair(view.selectedId);request.addEventListener('click',()=>panel.repair(view.selectedId));summary.append(request);
      const r=view.feedback;
      if(!r){
        if(!view.loading&&!view.error)promptPreference=null;
        summary.append(text('p','当前无可读取的修订反馈；排队或运行中暂不展示旧证据。','help'));
      }
      else{
        summary.append(text('p',`报告 ${r.validationId} · SHA-256 ${r.reportSha256}`),text('p',Object.entries(r.gates).map(([key,value])=>`${feedbackGates[key]??'其他检查'}：${feedbackStatus(value)}`).join('；')),
          text('p',`候选 ${r.benchmarkGate.candidateScore}，基线 ${r.benchmarkGate.baselineScore}，净收益 ${r.benchmarkGate.netGain}（要求 ≥ ${r.benchmarkGate.minNetGain}）`));
        const showPreview=(label,p)=>{if(!p){summary.append(text('p',`${label}：无可解析业务输出`));return;}summary.append(text('p',label),text('pre',p.json));if(p.truncated)summary.append(text('p',`已省略部分内容；原JSON ${p.totalBytes} UTF-8字节。`,'help'));};
        for(const [title,group,benchmark] of [['领域案例',r.domainCases,false],['基线比较',r.benchmarkCases,true]]){
          summary.append(text('h4',`${title}：展示 ${group.shown}/${group.total}，省略 ${group.omitted}`));
          for(const c of group.entries){summary.append(text('p',c.name));showPreview('输入',c.input);showPreview('预期',c.expected);
            if(benchmark){for(const [label,run] of [['候选',c.candidate],['基线',c.baseline]]){summary.append(text('p',`${label}：${feedbackStatus(run.status)}；预期匹配：${run.expectationPassed===true?'匹配':run.expectationPassed===false?'未匹配':'未执行'}`));showPreview(`${label}实际输出`,run.actual);}}
            else{summary.append(text('p',`${feedbackStatus(c.status)} · ${feedbackStatus(c.run.status)}`));showPreview('实际输出',c.actual);}
          }
        }
        const identity=JSON.stringify([view.selectedId,r.validationId,r.reportSha256]);
        if(promptPreference?.identity!==identity)promptPreference={identity,open:false,scrollTop:0};
        promptNode=text('details','');promptBody=text('pre',r.prompt);promptNode.open=promptPreference.open;
        promptNode.append(text('summary','展开修订说明（仅预览，不会发送）'),promptBody);summary.append(promptNode);promptBody.scrollTop=promptPreference.scrollTop;
      }
    }else if(view.selectedId){summary.append(text('h3','验证摘要'),text('p',view.selectedId,'help'));
      const r=view.summary;
      if(!r)summary.append(text('p','尚无可读取的验证报告。','help'));
      else{summary.append(text('p',`报告 ${r.validationId} · ${r.passed?'通过':'未通过'}`));
        const checks=[['材料完整性',r.artifactIntegrityPassed],['镜像与源码',r.runtimeArtifactVerified],['静态检查',r.staticPassed],['语法',r.syntaxPassed],['重复性',r.repeatabilityPassed],['领域案例',r.domainGatePassed],['基线净收益',r.benchmarkGate.passed]];
        summary.append(text('p',checks.map(([name,passed])=>`${name}：${passed?'通过':'未通过'}`).join('；')),
          text('p',`领域案例 ${r.domainCases.passed}/${r.domainCases.total}；候选 ${r.benchmarkGate.candidateScore}，基线 ${r.benchmarkGate.baselineScore}，净收益 ${r.benchmarkGate.netGain}（要求 ≥ ${r.benchmarkGate.minNetGain}）；业务执行 ${r.executionCount} 次。`));
      }
    }
  }});
  document.getElementById('refresh-tools').addEventListener('click',()=>panel.refresh());
  // Poll only reads evidence. It never requests validation or model execution.
  let timer;
  const poll=async()=>{if(document.visibilityState!=='hidden')await panel.refresh();const active=panel.state.submitting||panel.state.repairSubmitting||panel.state.activeRepairIds.length||panel.state.proposals.some(p=>['pending','running'].includes(p.latestJob?.status));timer=setTimeout(poll,active?3000:15000);};
  poll();globalThis.addEventListener?.('pagehide',()=>clearTimeout(timer),{once:true});return panel;
}
if(typeof document!=='undefined')mountToolPanel(document);
