// Dedicated report admission on the private task-capability socket only.
const fields=['capability','blocking','reason','desiredInput','desiredOutput','evidenceEventIds'];
export function createToolGapApi({toolGaps,authorize,readBody,respond,track}){
  return async(req,res)=>{
    if(req.url!=='/v1/tool-gaps'||!toolGaps)return false;
    if(req.method!=='POST')throw Object.assign(new Error('Unsupported report method'),{status:405});
    authorize(req,true);
    const input=await readBody(req,32768);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.includes(key)))throw Object.assign(new Error('Invalid report'),{status:400});
    const handle=authorize(req,true);
    const operation=handle.run(async()=>{
      if(handle.signal.aborted)throw Object.assign(new Error('Capability unavailable'),{status:401});
      // No await between this cancellation check and synchronous durable admission.
      try{return await toolGaps.report(input,handle.taskContext);}
      catch(error){throw Object.assign(new Error('Tool gap report unavailable'),{status:[400,404,409,413,503].includes(error?.statusCode)?error.statusCode:503});}
    });
    await track(operation,async()=>{const result=await operation;respond(res,result.deduplicated?200:202,result);});return true;
  };
}
