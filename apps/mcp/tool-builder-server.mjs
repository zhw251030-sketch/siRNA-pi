import {randomUUID} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createToolBuilderTools} from '../../packages/domain/sirna-tools/tool-builder-tools.mjs';
import {copyToolBuilderArguments} from '../../packages/capability-platform/tool-build-sessions.mjs';
const failure=text=>({isError:true,content:[{type:'text',text}]});
export function createToolBuilderMcpServer({service}={}){
 if(!service||typeof service.close!=='function')throw new TypeError('Explicit builder service required');
 const tools=new Map(createToolBuilderTools({service}).map(t=>[t.name,t]));
 const server=new Server({name:'sirna-tool-builder',version:'0.1.0'},{capabilities:{tools:{}},instructions:'Fixed Node single-source builder only. Shell runs as nonroot in an isolated container. Finalization excludes shell filesystem changes. Submitted is not verified or approved. No web or Curator integration.'});
 let closing=false,closed,active=Promise.resolve(),busy=false;
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[...tools.values()].map(t=>({name:t.name,title:t.label,description:t.description,inputSchema:t.parameters,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}}))}));
 server.setRequestHandler(CallToolRequestSchema,async request=>{
  if(closing)return failure('Tool builder is closed.');if(busy)return failure('Tool builder is busy; wait for the accepted operation.');
  const tool=tools.get(request.params.name);if(!tool)return failure('Unknown tool builder operation.');let args;
  try{copyToolBuilderArguments(request);args=copyToolBuilderArguments(request.params.arguments??{});}catch{return failure('Invalid or oversized tool builder arguments.');}
  busy=true;const operation=(async()=>{try{return await tool.execute(randomUUID(),args);}catch(error){return failure(error?.cleanupConfirmed===false?'Tool builder operation failed; cleanup unknown. Inspect private build evidence.':'Tool builder operation failed. Check arguments and inspect private build evidence.');}finally{busy=false;}})();active=operation.then(()=>{});return operation;
 });
 const originalClose=server.close.bind(server);
 server.close=()=>{if(closed)return closed;closing=true;closed=(async()=>{await active;try{await service.close();}finally{await originalClose();}})();return closed;};
 const onclose=server.onclose;server.onclose=()=>{onclose?.();void server.close().catch(()=>{});};
 return server;
}

// Both EOF and signals drain accepted work before service cleanup/transport close.
export function installToolBuilderShutdown(server,{input=process.stdin,signals=process,onFailure=()=>{process.exitCode=1;}}={}){
 let shutdown;const stop=()=>{if(!shutdown)shutdown=server.close().catch(onFailure).finally(()=>{input.off('end',stop);signals.off('SIGTERM',stop);signals.off('SIGINT',stop);});return shutdown;};
 input.once('end',stop);signals.once('SIGTERM',stop);signals.once('SIGINT',stop);return stop;
}
