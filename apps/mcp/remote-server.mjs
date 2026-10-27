import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createApprovedMcpServer} from './approved-server.mjs';
import {createRemoteToolDiscovery} from './remote-client.mjs';
import {createToolBuilderClient} from './tool-builder-client.mjs';
import {createToolBuilderTools} from '../../packages/domain/sirna-tools/tool-builder-tools.mjs';
import {createToolGapClient} from './tool-gap-client.mjs';
import {createToolGapTools} from '../../packages/domain/sirna-tools/tool-gap-tools.mjs';
import {createGoalTools} from '../../packages/extensions/goal/goal-tools.mjs';
export function createRemoteMcpServer({baseUrl,builderUrl,gapUrl,goalUrl,contextPath,pollIntervalMs=2000}={}){
  const taskContextPath=contextPath??'/workspace/.sirna-task-context.json';
  const goalTools=goalUrl?createGoalTools({registryUrl:goalUrl,taskContextPath}):[];
  return createApprovedMcpServer({discover:createRemoteToolDiscovery({baseUrl,contextPath:taskContextPath}),pollIntervalMs:pollIntervalMs||undefined,
    reportTools:gapUrl?createToolGapTools({service:createToolGapClient({baseUrl:gapUrl,contextPath:taskContextPath})}):[],
    builderTools:builderUrl?createToolBuilderTools({service:createToolBuilderClient({baseUrl:builderUrl,contextPath:taskContextPath})}):[],goalTools});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await createRemoteMcpServer({baseUrl:process.env.SIRNA_APPROVED_TOOLS_URL,builderUrl:process.env.SIRNA_TOOL_BUILDER_URL,gapUrl:process.env.SIRNA_TOOL_GAP_URL,goalUrl:process.env.SIRNA_TOOL_REGISTRY_URL}).connect(new StdioServerTransport());
}
