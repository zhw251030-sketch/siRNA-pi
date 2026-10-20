import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ListToolsRequestSchema,CallToolRequestSchema,ToolListChangedNotificationSchema,ProgressNotificationSchema} from '@modelcontextprotocol/sdk/types.js';
// Minimal executable upstream-boundary fixture. Anchor snippets are from
// pi-mcp-adapter 2.11.0 (MIT, Copyright (c) 2026 Nico Bailon); added harness
// methods are local test utilities, not vendored reference-project code.
// Full upstream notice: ../containers/agent-compose-guest/pi-mcp-adapter-LICENSE.
/* MIT License — Copyright (c) 2026 Nico Bailon
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. */
const sources={
  'server-manager.ts':`import { ElicitationCompleteNotificationSchema,
  type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
export class McpServerManager {
  private connections = new Map();
  private defaultRequestTimeoutMs: number | undefined;

  /** Default cwd */
  constructor() {}
  setDefaultRequestTimeoutMs(timeoutMs: number | undefined): void {
    this.defaultRequestTimeoutMs = normalizeRequestTimeoutMs(timeoutMs);
  }

  getRequestOptions() { return {}; }
  buildRequestOptions(_definition, signal) { return { signal }; }
  async fetchAllTools(client, options) { return (await client.listTools(undefined, options)).tools; }
  private attachAdapterNotificationHandlers(serverName: string, client: Client): void {
    client.setNotificationHandler(serverStreamResultPatchNotificationSchema, (notification) => {
      const listener = this.uiStreamListeners.get(notification.params.streamToken);
      if (!listener) return;
      listener(serverName, notification.params);
    });
  }
  getConnection(name) { return this.connections.get(name); }
}
`,
  'init.ts':`export function initializeMcp(manager, config, state) {
  const serverEntries = Object.entries(config.mcpServers);
  return state;
}
export async function lazyConnect(state, name) { return state.manager.getConnection(name)?.status === 'connected'; }
function updateServerMetadata(state, name) { state.toolMetadata.set(name, state.manager.getConnection(name).tools.map(x=>({...x,originalName:x.name}))); }
function updateMetadataCache(state, name) { state.cache.set(name, state.toolMetadata.get(name)); }
function updateStatusBar() {}
function getEffectiveIdleTimeoutMinutes(state: McpExtensionState, serverName: string): number { return 0; }
`,
  'proxy-modes.ts':`import { lazyConnect, updateServerMetadata, updateMetadataCache, getFailureAgeSeconds, updateStatusBar } from "./init.ts";
export async function executeCall(state, toolName, args, serverOverride, _pi, signal) {
  let serverName = serverOverride;
  let toolMeta = serverName ? findToolByName(state.toolMetadata.get(serverName), toolName) : undefined;
  if (serverName && !toolMeta) {
    const connected = await lazyConnect(state, serverName, signal);
    if (connected) {
      toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
    }
  }
  if (!serverName || !toolMeta) {
    const nativeTool = !serverOverride ? undefined : undefined;
    return {isError:true};
  }
  return state.manager.getConnection(serverName).client.callTool({name:toolMeta.originalName,arguments:args});
}
`,
  'index.ts':`import { flushMetadataCache, initializeMcp, updateStatusBar } from "./init.ts";
export async function dispatch(state, params, signal) {
        if (params.search) {
          return executeSearch(state, params.search, params.regex, params.server, params.includeSchemas);
        }
        if (params.server) {
          return executeList(state, params.server);
        }
}
`,
};
function evaluate(source,exports,bindings={}){
  const javascript=stripTypeScriptTypes(source,{mode:'transform'}).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
  return new Function(...Object.keys(bindings),javascript+`;return {${exports.join(',')}};`)(...Object.values(bindings));
}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sirna-refresh-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'pi-mcp-adapter',version:'2.11.0'}));
  for(const [file,source] of Object.entries(sources))await fs.writeFile(path.join(root,file),source);
  const api=await import('../containers/agent-compose-guest/patch-mcp-refresh.mjs').catch(()=>({}));
  assert.equal(typeof api.patchMcpRefresh,'function','version-checked adapter refresh patch is implemented');
  return {root,patch:()=>api.patchMcpRefresh(root)};
}
async function connected(t){
  let enabled=false,fail=false;
  const server=new Server({name:'refresh-test',version:'1'},{capabilities:{tools:{listChanged:true}}});
  const tool={name:'new_summary',description:'New summary',inputSchema:{type:'object'}};
  server.setRequestHandler(ListToolsRequestSchema,()=>{if(fail)throw new Error('broken discovery');return {tools:enabled?[tool]:[]};});
  server.setRequestHandler(CallToolRequestSchema,()=>({content:[{type:'text',text:'new tool reached'}]}));
  const client=new Client({name:'adapter-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});await server.connect(b);await client.connect(a);
  return {server,client,enable(){enabled=true;},fail(){fail=true;}};
}
test('adapter patch rejects wrong versions and missing anchors without partial writes',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'package.json'),'{"name":"pi-mcp-adapter","version":"2.12.0"}');
  await assert.rejects(f.patch(),/2\.11\.0/);
  await fs.writeFile(path.join(f.root,'package.json'),'{"name":"pi-mcp-adapter","version":"2.11.0"}');
  await fs.writeFile(path.join(f.root,'index.ts'),'changed upstream source');
  await assert.rejects(f.patch(),/anchor/i);assert.equal(await fs.readFile(path.join(f.root,'server-manager.ts'),'utf8'),sources['server-manager.ts']);
});
test('connected adapter consumes listChanged, updates metadata/cache, and clears stale tools on discovery failure',async t=>{
  const f=await fixture(t);await f.patch();const remote=await connected(t);
  const {McpServerManager}=evaluate(await fs.readFile(path.join(f.root,'server-manager.ts'),'utf8'),['McpServerManager'],{
    ToolListChangedNotificationSchema,serverStreamResultPatchNotificationSchema:ProgressNotificationSchema,logger:{debug(){}},normalizeRequestTimeoutMs:x=>x,
  });
  const manager=new McpServerManager();manager.connections.set('sirna',{status:'connected',client:remote.client,tools:[],definition:{},inFlight:0});
  manager.attachAdapterNotificationHandlers('sirna',remote.client);
  const state={manager,toolMetadata:new Map(),cache:new Map(),failureTracker:new Map(),config:{mcpServers:{sirna:{}}}};
  const init=evaluate(await fs.readFile(path.join(f.root,'init.ts'),'utf8'),['initializeMcp','refreshServerTools'],{logger:{debug(){}},throwIfAborted:signal=>signal?.throwIfAborted()});
  init.initializeMcp(manager,state.config,state);
  remote.enable();await remote.server.sendToolListChanged();
  for(let i=0;i<100&&!state.cache.get('sirna')?.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(state.cache.get('sirna').map(x=>x.name),['new_summary']);
  remote.fail();assert.equal(await init.refreshServerTools(state,'sirna'),false);
  assert.deepEqual(manager.getConnection('sirna').tools,[]);assert.deepEqual(state.toolMetadata.get('sirna'),[]);assert.deepEqual(state.cache.get('sirna'),[]);
});
test('adapter search, explicit list, and unknown unprefixed calls rediscover on existing connections',async t=>{
  const f=await fixture(t);await f.patch();const remote=await connected(t);remote.enable();
  const connection={status:'connected',client:remote.client,tools:[]};
  const state={toolMetadata:new Map(),config:{mcpServers:{sirna:{}}},manager:{getConnection:()=>connection}};
  const refreshServerTools=async(state,name)=>{const {tools}=await remote.client.listTools();connection.tools=tools;state.toolMetadata.set(name,tools.map(x=>({...x,originalName:x.name})));return true;};
  const {dispatch}=evaluate(await fs.readFile(path.join(f.root,'index.ts'),'utf8'),['dispatch'],{refreshServerTools,
    executeSearch:state=>[...state.toolMetadata.values()].flat().map(x=>x.name),executeList:(state,name)=>state.toolMetadata.get(name).map(x=>x.name)});
  assert.deepEqual(await dispatch(state,{search:'new'}),['new_summary']);state.toolMetadata.clear();
  assert.deepEqual(await dispatch(state,{server:'sirna'}),['new_summary']);state.toolMetadata.clear();
  const {executeCall}=evaluate(await fs.readFile(path.join(f.root,'proxy-modes.ts'),'utf8'),['executeCall'],{refreshServerTools,findToolByName:(tools,name)=>tools?.find(x=>x.name===name)});
  assert.deepEqual(await executeCall(state,'new_summary',{}),{content:[{type:'text',text:'new tool reached'}]});
});
