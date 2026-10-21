import {createToolBuildSessionService} from './tool-build-sessions.mjs';
// One web owner globally, one private session map per authenticated turn.
export function createTaskToolBuilders({root,docker,registrationPolicy}={}){
  if(typeof root!=='string'||!docker)throw new TypeError('Explicit builder root and Docker required');
  const key=Symbol('turn builder');let owner;
  return {acquire(handle){
    if(typeof handle?.ownResource!=='function'||!handle.taskContext)throw new TypeError('Activated lease required');
    return handle.ownResource(key,()=>{
      if(owner)throw Object.assign(new Error('Web builder is owned by another turn'),{status:409});
      const service=createToolBuildSessionService({root,docker,taskContext:handle.taskContext,registrationPolicy});
      const close=service.close.bind(service);service.close=async()=>{await close();if(owner===service)owner=undefined;};
      owner=service;return service;
    });
  }};
}
