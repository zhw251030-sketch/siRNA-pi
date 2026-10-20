import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createApprovedMcpServer} from './approved-server.mjs';
import {createRemoteToolDiscovery} from './remote-client.mjs';
export function createRemoteMcpServer({baseUrl,contextPath,pollIntervalMs=2000}={}){
  return createApprovedMcpServer({discover:createRemoteToolDiscovery({baseUrl,contextPath}),pollIntervalMs});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await createRemoteMcpServer({baseUrl:process.env.SIRNA_APPROVED_TOOLS_URL}).connect(new StdioServerTransport());
}
