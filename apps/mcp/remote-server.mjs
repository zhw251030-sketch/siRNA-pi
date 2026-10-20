import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createApprovedMcpServer} from './approved-server.mjs';
import {createRemoteToolDiscovery} from './remote-client.mjs';
import {createToolBuilderClient} from './tool-builder-client.mjs';
import {createToolBuilderTools} from '../../packages/domain/sirna-tools/tool-builder-tools.mjs';
export function createRemoteMcpServer({baseUrl,builderUrl,contextPath,pollIntervalMs=2000}={}){
  return createApprovedMcpServer({discover:createRemoteToolDiscovery({baseUrl,contextPath}),pollIntervalMs:pollIntervalMs||undefined,
    builderTools:builderUrl?createToolBuilderTools({service:createToolBuilderClient({baseUrl:builderUrl,contextPath})}):[]});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await createRemoteMcpServer({baseUrl:process.env.SIRNA_APPROVED_TOOLS_URL,builderUrl:process.env.SIRNA_TOOL_BUILDER_URL}).connect(new StdioServerTransport());
}
