// This panel is global: candidate jobs do not belong to the selected chat.
export function createToolPanel({fetcher=fetch,storage=globalThis.sessionStorage,uuid=()=>crypto.randomUUID(),onChange=()=>{}}={}){
  let state={proposals:[],maintenance:{accepting:true,halted:false},loading:false,submitting:null,selectedId:null,summary:null,error:''};
  let refreshVersion=0;
  const update=patch=>{state={...state,...patch};onChange(state);};
  async function json(url,options){const response=await fetcher(url,options);if(!response.ok)throw new Error('Request failed');return response.json();}
  const panel={
    get state(){return state;},
    async refresh(){const version=++refreshVersion;const selected=state.selectedId,submitting=state.submitting;update({loading:true});
      try{const data=await json('/v1/tool-proposals');let summary=null;
        const selectedJob=data.proposals.find(p=>p.id===selected)?.latestJob;
        if(selected&&!state.submitting&&!['pending','running'].includes(selectedJob?.status))summary=(await json(`/v1/tool-proposals/${encodeURIComponent(selected)}/validation-summary`)).summary;
        if(version===refreshVersion&&selected===state.selectedId&&submitting===state.submitting)update({proposals:data.proposals,maintenance:data.maintenance??{accepting:true,halted:false},summary,loading:false});
      }catch{if(version===refreshVersion&&selected===state.selectedId&&submitting===state.submitting)update({loading:false,error:'候选或证据读取失败，请刷新后重试。'});}
    },
    async select(id){update({selectedId:id,summary:null,error:''});await panel.refresh();},
    async validate(id){if(state.submitting)return;
      ++refreshVersion; // Invalidate evidence already awaiting its HTTP response.
      update({submitting:id,selectedId:id,summary:null,error:'',loading:false});
      const key=`sirna-pi.validation-request.${id}`;
      try{
        // Persist BEFORE POST. Reload or a lost acknowledgement retries exactly
        // this UUID; only a confirmed response permits a new explicit request.
        let requestId=storage.getItem(key);if(!requestId){requestId=uuid();storage.setItem(key,requestId);}
        await json(`/v1/tool-proposals/${encodeURIComponent(id)}/validate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId})});
        storage.removeItem(key);update({submitting:null});await panel.refresh();
      }catch{update({submitting:null,error:'验证请求未确认；重试会沿用同一请求编号。请刷新检查候选和作业状态。'});}
    },
  };return panel;
}

const states={submitted:'待验证',verification_failed:'验证未通过',verified:'验证通过，待人工批准',approved:'已人工批准'};
const jobStates={pending:'排队中',running:'验证运行中',succeeded:'验证流程完成',failed:'执行失败',interrupted:'执行中断，未自动重试'};
export function mountToolPanel(document){
  const list=document.getElementById('tools-list'),status=document.getElementById('tools-status'),summary=document.getElementById('tools-summary');
  if(!list||!status||!summary)return;
  const text=(tag,value,className)=>{const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node;};
  const panel=createToolPanel({onChange:view=>{
    status.textContent=view.error||(view.maintenance.halted?'验证队列已暂停，请先检查私有运行记录；重启不会自动解除。':view.loading?'正在刷新候选…':'候选与聊天任务分别管理；验证完成后仍需人工批准。');
    list.replaceChildren();
    if(!view.proposals.length)list.append(text('p','暂无已登记候选。','help'));
    for(const p of view.proposals){
      const row=text('div','','tool-proposal');row.dataset.proposalId=p.id;
      row.append(text('strong',p.toolName),text('p',`${p.id} · ${states[p.state]??p.state}`,'help'));
      const job=p.latestJob;
      if(job){row.append(text('p',`${jobStates[job.status]??job.status}${job.status==='succeeded'?` · 报告${job.passed?'通过':'未通过'}`:''}`));if(job.error)row.append(text('p',job.error,'help'));}
      const validate=text('button',view.submitting===p.id?'正在提交…':'验证候选','button secondary');validate.type='button';validate.dataset.validateProposal=p.id;
      validate.disabled=!!view.submitting||!view.maintenance.accepting||!['submitted','verification_failed'].includes(p.state)||['pending','running'].includes(job?.status);
      validate.addEventListener('click',()=>panel.validate(p.id));row.append(validate);
      const inspect=text('button','查看验证摘要','button secondary');inspect.type='button';inspect.addEventListener('click',()=>panel.select(p.id));row.append(inspect);list.append(row);
    }
    summary.replaceChildren();
    if(view.selectedId){summary.append(text('h3','验证摘要'),text('p',view.selectedId,'help'));
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
  const poll=async()=>{if(document.visibilityState!=='hidden')await panel.refresh();const active=panel.state.submitting||panel.state.proposals.some(p=>['pending','running'].includes(p.latestJob?.status));timer=setTimeout(poll,active?3000:15000);};
  poll();globalThis.addEventListener?.('pagehide',()=>clearTimeout(timer),{once:true});return panel;
}
if(typeof document!=='undefined')mountToolPanel(document);
