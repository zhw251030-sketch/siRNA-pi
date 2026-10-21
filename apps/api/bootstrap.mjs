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

process.umask(0o077);
const directory = path.join(projectRoot, "runtime", "tasks");
ensureProjectDirectory(directory);
const database = path.join(directory, "tasks.sqlite");
for (const file of [database, `${database}-wal`, `${database}-shm`]) {
  if (fs.existsSync(file) && fs.realpathSync(file) !== file) throw new Error("任务数据库路径无效。");
}
const rpc = new AgentComposeRpcClient({ token: readComposeControlToken(projectRoot) });
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
const server = createAppServer({ taskStore, agentRuntime, workspaceFiles, taskMessages, toolMaintenance, toolRepair, toolCurationPreview });
server.listen(3000, "127.0.0.1", () => {
  // Never recover or claim jobs until this instance owns the listening socket.
  toolRepair.recover();toolMaintenance.start();
  console.log(`siRNA-pi: http://127.0.0.1:3000/ ; runtime=agent-compose ; recovered=${recovered.length}`);
});
server.on("error", async () => { console.error("网页服务启动失败，请检查端口与项目配置。"); process.exitCode = 1; await toolRepair.stop();await toolMaintenance.stop();repairStore.close(); maintenanceStore.close(); toolsServer.close(); taskStore.close(); rpc.close(); });
// Deployment stops an idle server. Let any accepted HTTP turn finish on normal shutdown.
async function shutdown(){
  // stop() synchronously closes acceptance/claiming before HTTP drains; its
  // promise settles only after the current validator and durable job finish.
  const maintenanceDrain=toolMaintenance.stop();
  const repairDrain=toolRepair.stop();
  server.close(async () => {
  await maintenanceDrain;
  await repairDrain;
  await server.waitForTaskCompletion();
  await new Promise(resolve => toolsServer.close(resolve));
  await toolsServer.waitForCalls();
  taskStore.close();
  maintenanceStore.close();
  repairStore.close();
  rpc.close();
  process.exit(0);
  });
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
