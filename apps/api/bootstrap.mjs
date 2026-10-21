import fs from "node:fs";
import path from "node:path";
import { projectRoot, ensureProjectDirectory } from "../../packages/agent-runtime/pi-sdk.mjs";
import { LocalPiRuntime } from "../../packages/agent-runtime/local-pi-runtime.mjs";
import { AgentComposeRuntime } from "../../packages/agent-runtime/agent-compose-runtime.mjs";
import { AgentComposeRpcClient } from "../../packages/agent-runtime/agent-compose-rpc.mjs";
import { createComposeExecutor } from "../../packages/agent-runtime/compose-executor.mjs";
import { readComposeControlToken } from "../../packages/agent-runtime/compose-control-token.mjs";
import { RuntimeRouter } from "../../packages/agent-runtime/runtime-router.mjs";
import { TaskStore } from "../../packages/task-core/task-store.mjs";
import { TaskFiles } from "../../packages/task-core/task-files.mjs";
import { createAppServer } from "./router.mjs";
import { createToolCallLeases } from "../../packages/capability-platform/tool-call-leases.mjs";
import { discoverApprovedTools } from "../../packages/capability-platform/tool-approved-execution.mjs";
import { createDockerValidationRunner } from "../../packages/capability-platform/tool-validation-runner.mjs";
import { DockerEngineClient } from "../../packages/capability-platform/docker-engine-client.mjs";
import { createAgentToolsServer } from "./agent-tools.mjs";
import { listenToolSocket } from "./tool-api-socket.mjs";
import { createTaskToolBuilders } from "../../packages/capability-platform/task-tool-builders.mjs";
import { ToolMaintenanceStore } from "../../packages/capability-platform/tool-maintenance-store.mjs";
import { createToolMaintenance } from "../../packages/capability-platform/tool-maintenance-worker.mjs";
import { createMaintenanceValidator } from "../../packages/capability-platform/tool-maintenance-validation.mjs";
import { TaskMessageService } from "../../packages/task-core/task-message-service.mjs";
import { ToolRepairStore } from "../../packages/capability-platform/tool-repair-store.mjs";
import { createToolRepair } from "../../packages/capability-platform/tool-repair-service.mjs";
import { createToolCurationPreview } from "../../packages/extensions/tool-curation/tool-curation-preview.mjs";
import { getRegisteredToolCatalog } from "../../packages/capability-platform/tool-approval-service.mjs";
import { ToolCurationStore } from "../../packages/extensions/tool-curation/tool-curation-store.mjs";
import { createToolCurationService } from "../../packages/extensions/tool-curation/tool-curation-service.mjs";
import { createAgentToolCurator } from "../../packages/extensions/tool-curation/agent-tool-curator.mjs";
import { createApiShutdown } from "./service-lifecycle.mjs";

process.umask(0o077);
const directory = path.join(projectRoot, "runtime", "tasks");
ensureProjectDirectory(directory);
const database = path.join(directory, "tasks.sqlite");
for (const file of [database, `${database}-wal`, `${database}-shm`]) {
  if (fs.existsSync(file) && fs.realpathSync(file) !== file) throw new Error("任务数据库路径无效。");
}
const controlToken = readComposeControlToken(projectRoot);
const rpc = new AgentComposeRpcClient({ token: controlToken });
// Preserve Designer transport defaults; bound this independent model transport.
const curatorRpc = new AgentComposeRpcClient({token:controlToken,timeoutMs:180000});
const dockerSocket = path.join(projectRoot, 'runtime/docker/run/docker.sock');
if (fs.realpathSync(dockerSocket) !== dockerSocket || !fs.lstatSync(dockerSocket).isSocket()) throw new Error('Expected project Docker socket');
const docker = new DockerEngineClient(dockerSocket);
const runner = createDockerValidationRunner({ docker, purpose: 'approved-call' });
const toolCallLeases = createToolCallLeases();
let toolRepair;
const builders = createTaskToolBuilders({root: projectRoot,docker,registrationPolicy:(input,context)=>{
  if(!toolRepair)throw new Error('Tool repair admission is unavailable');
  return toolRepair.registration(input,context);
}});
const toolsServer = createAgentToolsServer({ leases: toolCallLeases, builders,
  discover: ({taskContext}) => discoverApprovedTools({ root: projectRoot, runner, taskContext }) });
await listenToolSocket(toolsServer, {root: projectRoot});
const compose = new AgentComposeRuntime({ root: projectRoot, executor: createComposeExecutor(projectRoot), rpc, toolCallLeases, toolBuildersAvailable:true });
const agentRuntime = new RuntimeRouter({ compose, legacy: new LocalPiRuntime() });
const taskStore = new TaskStore(database);
const recovered = taskStore.recoverInterruptedTasks();
const workspaceFiles = new TaskFiles({ root: projectRoot, agentRuntime });
const taskMessages=new TaskMessageService({taskStore,agentRuntime,workspaceFiles});
const maintenanceStore=new ToolMaintenanceStore({root:projectRoot});
const toolMaintenance=createToolMaintenance({root:projectRoot,store:maintenanceStore,validate:createMaintenanceValidator({root:projectRoot,docker}),
  canValidate:id=>!toolRepair?.active(id),
  onError:()=>console.error('候选验证执行失败，请检查项目内私有运行记录。')});
const repairStore=new ToolRepairStore({root:projectRoot});
toolRepair=createToolRepair({root:projectRoot,store:repairStore,taskStore,taskMessages,agentRuntime,maintenance:toolMaintenance});
const toolCurationPreview = createToolCurationPreview({taskStore, listExistingTools: () => [
  'enumerate_sirna_candidates', ...getRegisteredToolCatalog({root: projectRoot}).tools.map(tool => tool.toolName),
]});
const curatorRuntime = new AgentComposeRuntime({root:projectRoot,agentName:'tool-curator',executor:createComposeExecutor(projectRoot,{agentName:'tool-curator'}),rpc:curatorRpc});
const curationStore = new ToolCurationStore({root:projectRoot});
const toolCuration = createToolCurationService({store:curationStore,preview:toolCurationPreview,curator:createAgentToolCurator({runtime:curatorRuntime,timeoutMs:180000})});
const server = createAppServer({ taskStore, agentRuntime, workspaceFiles, taskMessages, toolMaintenance, toolRepair, toolCurationPreview, toolCuration });
const shutdown = createApiShutdown({server,toolMaintenance,toolRepair,toolCuration,toolsServer,
  stores:[taskStore,maintenanceStore,repairStore,curationStore],rpcs:[rpc,curatorRpc]});
const shutdownFailure = () => {console.error('服务停止未完全确认，请检查项目内私有运行记录。');process.exitCode=1;};
server.listen(3000, "127.0.0.1", () => {
  // Never recover or claim jobs until this instance owns the listening socket.
  try {toolRepair.recover();toolMaintenance.start();toolCuration.start();}
  catch {shutdownFailure();void shutdown().catch(shutdownFailure);return;}
  console.log(`siRNA-pi: http://127.0.0.1:3000/ ; runtime=agent-compose ; recovered=${recovered.length}`);
});
server.on("error", () => { console.error("网页服务启动失败，请检查端口与项目配置。");process.exitCode=1;void shutdown().catch(shutdownFailure);});
process.once("SIGTERM", () => {void shutdown().catch(shutdownFailure);});
process.once("SIGINT", () => {void shutdown().catch(shutdownFailure);});
