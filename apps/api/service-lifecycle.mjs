// Stop admission synchronously, then drain accepted work before closing stores.
// Every resource is attempted even if one service cannot persist its shutdown.
export function createCurationBuildRegistrationPolicy(getService) {
  const service=()=>{
    const value=getService();
    if(!value)throw Error('Tool curation build admission is unavailable');
    return value;
  };
  const policy=(...args)=>service().registration(...args);
  policy.onSubmissionFailure=(...args)=>service().registration.onSubmissionFailure(...args);
  return policy;
}

export function startApiServices({server,toolMaintenance,toolRepair,toolCuration,toolCurationBuild}) {
  if (!server.listening) throw Error('Services require ownership of the listening socket.');
  toolRepair?.recover();
  toolCurationBuild?.recover();
  toolMaintenance?.start();
  toolCuration?.start();
}

export function createApiShutdown({server,toolMaintenance,toolRepair,toolCuration,toolCurationBuild,toolsServer,stores=[],rpc,rpcs=[]}) {
  let pending;
  return function shutdown() {
    if(pending)return pending;
    const drains=[toolMaintenance,toolRepair,toolCuration,toolCurationBuild].filter(Boolean).map(service=>{
      try{return Promise.resolve(service.stop());}catch(error){return Promise.reject(error);}
    });
    const drainResult=Promise.allSettled(drains);
    pending=(async()=>{
      let failed=false;
      const attempt=async action=>{try{await action();}catch{failed=true;}};
      try {
        await attempt(()=>new Promise((resolve,reject)=>server.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve())));
        await attempt(()=>server.waitForTaskCompletion());
        if((await drainResult).some(item=>item.status==='rejected'))failed=true;
      } finally {
        if(toolsServer) {
          await attempt(()=>new Promise((resolve,reject)=>toolsServer.close(error=>error?reject(error):resolve())));
          await attempt(()=>toolsServer.waitForCalls());
        }
        for(const store of stores)await attempt(()=>store.close());
        for(const transport of new Set([rpc,...rpcs].filter(Boolean)))await attempt(()=>transport.close());
      }
      if(failed)throw Error('Service shutdown requires operator inspection; resources have been closed.');
    })();
    return pending;
  };
}
