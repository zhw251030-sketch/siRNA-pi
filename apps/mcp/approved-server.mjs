// Host-side protocol adapter for the reference's dynamic approved AgentTool path.
// The guest HTTP bridge is separate; no host registry or Docker socket goes to Pi.
import {randomUUID} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createSirnaTools,validateCandidateArguments} from '../../packages/domain/sirna-tools/sirna-tools.mjs';

const failure=text=>({isError:true,content:[{type:'text',text}]});
function publicResult(result){
  if(!Array.isArray(result?.content)||result.content.length===0||result.content.some(x=>x?.type!=='text'||typeof x.text!=='string')||
    // Allow JSON transport escaping plus MCP framing around bounded 64KiB output.
    Buffer.byteLength(JSON.stringify(result.content))>262144)throw new Error('Invalid public tool result');
  return {content:result.content.map(({text})=>({type:'text',text}))};
}
export function createApprovedMcpServer({discover,pollIntervalMs,builderTools=[]}={}){
  if(typeof discover!=='function')throw new TypeError('An explicit approved-tool discovery callback is required');
  if(pollIntervalMs!==undefined&&(!Number.isInteger(pollIntervalMs)||pollIntervalMs<10||pollIntervalMs>30000))throw new TypeError('Invalid discovery poll interval');
  const fixed=new Map(createSirnaTools().map(tool=>[tool.name,tool]));const builders=new Map(builderTools.map(tool=>[tool.name,tool]));let busy=false;
  if(builders.size!==builderTools.length||[...builders.keys()].some(name=>fixed.has(name)))throw new TypeError('Invalid builder tools');
  const server=new Server({name:'sirna-approved-tools',version:'0.1.0'},{capabilities:{tools:pollIntervalMs?{listChanged:true}:{}},
    instructions:'Use registered tools for calculations. Approved means adopted after the recorded checks; outputs do not establish biological efficacy. Approved tools take {"input":{...business arguments...}}. File transfers are not supported by this learning step.'});
  async function load(signal){
    let result;try{result=await discover(signal?{signal}:undefined);}catch{throw new Error('Approved tool discovery unavailable');}
    if(!result||!Array.isArray(result.tools)||!Array.isArray(result.rejected)||result.rejected.length)throw new Error('Approved tool discovery unavailable');
    const tools=new Map([...fixed,...builders]);
    for(const tool of result.tools){
      if(!tool||typeof tool.name!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)||typeof tool.execute!=='function'||
        typeof tool.description!=='string'||!tool.parameters)throw new Error('Approved tool descriptor unavailable');
      if(tools.has(tool.name))throw new Error('Approved tool name collision');tools.set(tool.name,tool);
    }
    return tools;
  }
  const descriptors=tools=>[...tools.values()].map(tool=>({
    name:tool.name,title:tool.label,description:tool.description,inputSchema:tool.parameters,
    annotations:{readOnlyHint:fixed.has(tool.name),destructiveHint:false,idempotentHint:fixed.has(tool.name),openWorldHint:false},
  }));
  let fingerprint;let timer;let polling=false;
  server.setRequestHandler(ListToolsRequestSchema,async(_request,extra)=>{const tools=descriptors(await load(extra.signal));fingerprint=JSON.stringify(tools);return {tools};});
  if(pollIntervalMs){
    const controller=new AbortController();
    timer=setInterval(async()=>{
      if(polling||!server.transport)return;
      polling=true;
      try{const next=JSON.stringify(descriptors(await load(controller.signal)));if(controller.signal.aborted)return;if(fingerprint!==undefined&&fingerprint!==next)await server.sendToolListChanged();fingerprint=next;}
      catch{/* A fresh list/call fails closed; do not publish host diagnostics. */}
      finally{polling=false;}
    },pollIntervalMs);timer.unref();
    const stop=()=>{clearInterval(timer);controller.abort();};
    const close=server.close.bind(server);server.close=async()=>{stop();return close();};
    const onclose=server.onclose;server.onclose=()=>{stop();onclose?.();};
  }
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    let tool;try{tool=(await load(extra.signal)).get(request.params.name);}catch{return failure('Approved tool discovery unavailable. Inspect the host registry.');}
    if(!tool)return failure('Unknown siRNA tool');
    const args=request.params.arguments??{};
    if(fixed.has(tool.name)){
      try{validateCandidateArguments(args);return publicResult(await tool.execute(randomUUID(),args,extra.signal));}
      catch{return failure('Invalid arguments or fixed tool execution failed');}
    }
    if(busy)return failure('Approved tool executor is busy; wait for the accepted call to finish.');
    busy=true;
    try{return publicResult(await tool.execute(randomUUID(),args,extra.signal));}
    catch{return failure(builders.has(tool.name)
      ?'Tool builder call failed; an accepted operation may have completed. Inspect the host records before retrying.'
      :'Approved tool call failed. Check arguments and inspect the host audit records.');}
    finally{busy=false;}
  });
  return server;
}
