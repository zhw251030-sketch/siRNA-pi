// Independently implemented for the published MIT-licensed pi-mcp-adapter
// 2.11.0, not copied from the reference project's refresh patch. The installed
// package and its original LICENSE remain in the guest image. Unlike the
// reference, failed refresh invalidates stale tools and concurrent refreshes
// cannot overwrite newer metadata or a replaced connection.
// Upstream anchor license: ./pi-mcp-adapter-LICENSE.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
function replace(source,anchor,replacement,filename){
  const index=source.indexOf(anchor);
  if(index<0||source.indexOf(anchor,index+anchor.length)>=0)throw new Error(`${filename}: pi-mcp-adapter 2.11.0 refresh anchor mismatch`);
  return source.slice(0,index)+replacement+source.slice(index+anchor.length);
}
export async function patchMcpRefresh(directory){
  const packageInfo=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));
  if(packageInfo.name!=='pi-mcp-adapter'||packageInfo.version!=='2.11.0')throw new Error('Refresh patch requires pi-mcp-adapter 2.11.0');
  const patches=new Map();
  for(const filename of ['server-manager.ts','init.ts','proxy-modes.ts','index.ts'])patches.set(filename,(await fs.readFile(path.join(directory,filename),'utf8')).replace(/\r\n/g,'\n'));
  function edit(file,anchor,replacement){patches.set(file,replace(patches.get(file),anchor,replacement,file));}
  edit('server-manager.ts','ElicitationCompleteNotificationSchema,\n','ElicitationCompleteNotificationSchema,\n  ToolListChangedNotificationSchema,\n');
  edit('server-manager.ts','  private defaultRequestTimeoutMs: number | undefined;',`  private defaultRequestTimeoutMs: number | undefined;
  private sirnaToolChangeListener?: (name: string) => void;
  private sirnaRefreshVersions = new Map<string, number>();`);
  const notificationAnchor='  private attachAdapterNotificationHandlers(serverName: string, client: Client): void {';
  edit('server-manager.ts',notificationAnchor,`  setToolListChangedListener(listener: (name: string) => void): void {
    this.sirnaToolChangeListener = listener;
  }

  async refreshTools(name: string, signal?: AbortSignal): Promise<McpTool[]> {
    const current = this.connections.get(name);
    if (!current || current.status !== "connected") throw new Error("MCP tool discovery unavailable");
    const revision = (this.sirnaRefreshVersions.get(name) ?? 0) + 1;
    this.sirnaRefreshVersions.set(name, revision);
    current.inFlight++;
    const stillCurrent = () => this.connections.get(name) === current
      && current.status === "connected" && this.sirnaRefreshVersions.get(name) === revision;
    try {
      const fresh = await this.fetchAllTools(current.client, this.buildRequestOptions(current.definition, signal));
      if (stillCurrent()) {
        current.tools = fresh;
        current.lastUsedAt = Date.now();
        this.sirnaToolChangeListener?.(name);
      }
      return current.tools;
    } catch {
      if (stillCurrent()) {
        current.tools = [];
        this.sirnaToolChangeListener?.(name);
      }
      throw new Error("MCP tool discovery unavailable");
    } finally {
      current.inFlight--;
    }
  }

${notificationAnchor}
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.refreshTools(serverName).catch(() => {});
    });`);
  edit('init.ts','  const serverEntries = Object.entries(config.mcpServers);',`  manager.setToolListChangedListener((name) => {
    updateServerMetadata(state, name);
    updateMetadataCache(state, name);
    state.failureTracker.delete(name);
    updateStatusBar(state);
  });

  const serverEntries = Object.entries(config.mcpServers);`);
  const initAnchor='function getEffectiveIdleTimeoutMinutes(state: McpExtensionState, serverName: string): number {';
  edit('init.ts',initAnchor,`export async function refreshServerTools(state: McpExtensionState, name: string, signal?: AbortSignal): Promise<boolean> {
  if (!(await lazyConnect(state, name, signal))) {
    state.toolMetadata.delete(name);
    return false;
  }
  try {
    await state.manager.refreshTools(name, signal);
    return true;
  } catch {
    if (signal?.aborted) throwIfAborted(signal);
    return false;
  }
}

${initAnchor}`);
  edit('proxy-modes.ts','import { lazyConnect, updateServerMetadata, updateMetadataCache, getFailureAgeSeconds, updateStatusBar } from "./init.ts";',
    'import { refreshServerTools, lazyConnect, updateServerMetadata, updateMetadataCache, getFailureAgeSeconds, updateStatusBar } from "./init.ts";');
  edit('proxy-modes.ts','    const connected = await lazyConnect(state, serverName, signal);\n    if (connected) {\n      toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);',
    '    const connected = await refreshServerTools(state, serverName, signal);\n    if (connected) {\n      toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);');
  const unknownAnchor='  if (!serverName || !toolMeta) {\n    const nativeTool = !serverOverride';
  edit('proxy-modes.ts',unknownAnchor,`  if (!serverName && !toolMeta) {
    for (const name of Object.keys(state.config.mcpServers)) {
      if (!(await refreshServerTools(state, name, signal))) continue;
      const discovered = findToolByName(state.toolMetadata.get(name), toolName);
      if (!discovered) continue;
      serverName = name;
      toolMeta = discovered;
      break;
    }
  }

${unknownAnchor}`);
  edit('index.ts','import { flushMetadataCache, initializeMcp, updateStatusBar } from "./init.ts";',
    'import { refreshServerTools, flushMetadataCache, initializeMcp, updateStatusBar } from "./init.ts";');
  edit('index.ts','        if (params.search) {\n          return executeSearch',`        if (params.search) {
          for (const name of params.server ? [params.server] : Object.keys(state.config.mcpServers)) {
            await refreshServerTools(state, name, signal);
          }
          return executeSearch`);
  edit('index.ts','        if (params.server) {\n          return executeList',`        if (params.server) {
          await refreshServerTools(state, params.server, signal);
          return executeList`);
  // Every version/anchor check completes before the first mutation.
  for(const [filename,source] of patches)await fs.writeFile(path.join(directory,filename),source);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3)throw new Error('Pass the installed pi-mcp-adapter directory');
  await patchMcpRefresh(process.argv[2]);
  process.stdout.write('pi-mcp-adapter 2.11.0: live tool metadata refresh enabled\n');
}
