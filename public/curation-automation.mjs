const endpoint='/v1/tool-curation-automation';
const reasons={disabled:'已关闭',enabled:'已开启',budget_exhausted:'次数已耗尽',capacity_exhausted:'观察容量已耗尽',unavailable:'暂不可用',stopped:'服务已停止'};
const states={queued:'等待检查',ignored:'未送审',deduplicated:'已有审查',admitted:'已送审',error:'送审未确认'};

export function createCurationAutomationPanel({root,fetcher=fetch}) {
  if (!root) return {refresh:async()=>{}};
  const document=root.ownerDocument;
  const node=(tag,text)=>{const value=document.createElement(tag);if(text)value.textContent=text;return value;};
  const heading=node('h2','全局自动工具审查'),help=node('p','开启后会消耗模型额度：每次服务启动最多 3 次自动送审尝试，关闭再开启不补次数，重启默认关闭。仅观察开启期间新结束的轮次，不回扫历史。七天候选冷却发生在模型回答之后，不节省该次模型调用。Builder 交接、验证和批准仍需人工操作；手动审查使用独立入口，不计自动次数。');
  const status=node('p','尚未读取自动审查状态。'),error=node('p'),recent=node('div');
  status.setAttribute('role','status');status.setAttribute('aria-live','polite');error.setAttribute('role','status');
  const refreshButton=node('button','刷新自动审查状态'),enable=node('button','开启自动审查'),disable=node('button','关闭自动审查');
  for(const button of [refreshButton,enable,disable]){button.type='button';button.className='button secondary';}
  root.replaceChildren(heading,help,status,refreshButton,enable,disable,error,recent);
  let current=null,revision=0,reading=false,changing=false,known=false;
  function render(){
    root.setAttribute('aria-busy',String(reading||changing));refreshButton.disabled=reading||changing;
    enable.disabled=!known||changing||!current?.started||current.enabled||current.remaining===0;
    disable.disabled=!known||changing||!current?.started||!current.enabled;
    if(!current)return;
    status.textContent=`全局自动审查：${reasons[current.reason]??'状态待确认'}；开关${current.enabled?'已开启':'已关闭'}；已尝试 ${current.attempts}/${current.maxReviews}，剩余 ${current.remaining} 次；待处理 ${current.pending} 项。`;
    recent.replaceChildren(node('p','最近送审记录（已送审仅表示准入，实际审查结果请在任务审查记录查看）：'));
    for(const record of current.recent){recent.append(node('p',`${states[record.state]??'记录'} · 任务 ${record.taskId} · 轮次 ${record.runId} · 用户消息 ${record.userMessageId} · ${record.reason}${record.curationId?` · 审查 ${record.curationId}`:''}`));}
  }
  async function request(options){
    const response=await fetcher(endpoint,options),body=await response.json();
    const value=body?.automation;
    if(!response.ok||value?.protocolVersion!=='sirna-tool-curation-automation/v1'||typeof value.enabled!=='boolean'||typeof value.started!=='boolean'||!Number.isInteger(value.remaining)||!Array.isArray(value.recent))throw Error('unavailable');
    return value;
  }
  async function read(reconcile=false){
    if(changing&&!reconcile)return;
    if(reading&&!reconcile)return;
    const version=++revision;reading=true;render();
    try{const value=await request({});if(version===revision){current=value;known=true;error.textContent='';}}
    catch{if(version===revision){known=false;error.textContent='自动审查状态未能确认，请显式刷新后再操作。';}}
    finally{if(version===revision){reading=false;render();}}
  }
  async function configure(enabled){
    if(changing||!known||!current?.started||(enabled?current.enabled||current.remaining===0:!current.enabled))return;
    changing=true;const version=++revision;reading=false;error.textContent='';render();
    try{const value=await request({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});if(version===revision){current=value;known=true;}}
    catch{known=false;error.textContent='开关操作未能确认，正在重新读取服务状态。';await read(true);}
    finally{changing=false;render();}
  }
  refreshButton.addEventListener('click',()=>read());enable.addEventListener('click',()=>configure(true));disable.addEventListener('click',()=>configure(false));
  render();return {refresh:()=>read()};
}
