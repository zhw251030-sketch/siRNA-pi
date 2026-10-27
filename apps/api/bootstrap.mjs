import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
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
import { createGoalVerifierInternalHandler } from "./goal-verifier-internal-listener.mjs";
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
import { ToolAutomationStore } from "../../packages/capability-platform/tool-automation-store.mjs";
import { createToolRepair } from "../../packages/capability-platform/tool-repair-service.mjs";
import { createToolCurationPreview } from "../../packages/extensions/tool-curation/tool-curation-preview.mjs";
import { getRegisteredToolCatalog, approveRegisteredToolProposal } from "../../packages/capability-platform/tool-approval-service.mjs";
import { getRegisteredToolProposal } from "../../packages/capability-platform/tool-lifecycle.mjs";
import { ToolApprovalStore } from "../../packages/capability-platform/tool-approval-store.mjs";
import { createToolApproval } from "../../packages/capability-platform/tool-approval-worker.mjs";
import { ToolCurationStore } from "../../packages/extensions/tool-curation/tool-curation-store.mjs";
import { createToolCurationService } from "../../packages/extensions/tool-curation/tool-curation-service.mjs";
import { createToolCurationCoordinator } from "../../packages/extensions/tool-curation/tool-curation-coordinator.mjs";
import { createAgentToolCurator } from "../../packages/extensions/tool-curation/agent-tool-curator.mjs";
import { ToolCurationBuildStore } from "../../packages/extensions/tool-curation/tool-curation-build-store.mjs";
import { createToolCurationBuildService } from "../../packages/extensions/tool-curation/tool-curation-build-service.mjs";
import { ToolGapStore } from "../../packages/extensions/tool-curation/tool-gap-store.mjs";
import { createToolGapService } from "../../packages/extensions/tool-curation/tool-gap-service.mjs";
import { GoalStore } from "../../packages/extensions/goal/goal-store.mjs";
import { createGoalVerificationRuntime } from "../../packages/extensions/goal/goal-verification-runtime.mjs";
import { createDeterministicGoalVerifier } from "../../packages/extensions/goal/goal-verification-fake.mjs";
import { createRuntimeGoalVerifier } from "../../packages/extensions/goal/goal-verification-agent-compose.mjs";
import { createApiShutdown, startApiServices, createCurationBuildRegistrationPolicy, createCurationAutomationReadiness } from "./service-lifecycle.mjs";

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
let toolRepair, toolCurationBuild, toolGaps, toolCurationCoordinator, toolApproval;
const builders = createTaskToolBuilders({root: projectRoot,docker,registrationPolicy:(input,context)=>{
  if(!toolRepair)throw new Error('Tool repair admission is unavailable');
  return toolRepair.registration(input,context);
},curationRegistrationPolicy:createCurationBuildRegistrationPolicy(()=>toolCurationBuild)});
const toolsServer = createAgentToolsServer({ leases: toolCallLeases, builders,
  toolGaps:{report:(input,context)=>{if(!toolGaps)throw Object.assign(new Error('Report service unavailable'),{statusCode:503});return toolGaps.report(input,context);}},
  discover: ({taskContext}) => discoverApprovedTools({ root: projectRoot, runner, taskContext }) });
await listenToolSocket(toolsServer, {root: projectRoot});
const compose = new AgentComposeRuntime({ root: projectRoot, executor: createComposeExecutor(projectRoot), rpc, toolCallLeases, toolBuildersAvailable:true });
const agentRuntime = new RuntimeRouter({ compose, legacy: new LocalPiRuntime() });
const taskStore = new TaskStore(database);
const goalStore = new GoalStore({root: projectRoot});
const recovered = taskStore.recoverInterruptedTasks();
const workspaceFiles = new TaskFiles({ root: projectRoot, agentRuntime });
const taskMessages=new TaskMessageService({taskStore,agentRuntime,workspaceFiles,onSettled:run=>toolCurationCoordinator?.observeRun(run)});
const goalVerificationMode = process.env.SIRNA_GOAL_VERIFICATION ?? 'off';
const goalVerifierRuntime = goalVerificationMode === 'agent-compose'
  ? new AgentComposeRuntime({root: projectRoot, agentName: 'goal-verifier', executor: createComposeExecutor(projectRoot, {agentName: 'goal-verifier'}), rpc})
  : undefined;
const goalVerifier = goalVerificationMode === 'agent-compose'
  ? createRuntimeGoalVerifier(goalVerifierRuntime)
  : createDeterministicGoalVerifier();
// Verification is opt-in. deterministic is the offline learning adapter;
// agent-compose uses the isolated goal-verifier profile and read-only MCP.
// The default off mode creates no verifier sandbox and sends no model request.
const goalVerification = createGoalVerificationRuntime({
  root: projectRoot,
  taskStore,
  workspaceFiles,
  goalStore,
  enabled: ['deterministic', 'agent-compose'].includes(goalVerificationMode),
  verifier: goalVerifier,
});
const maintenanceStore=new ToolMaintenanceStore({root:projectRoot});
const toolAutomation=new ToolAutomationStore({root:projectRoot});
const isVerified = proposalId => {
  try {
    const detail = getRegisteredToolProposal(proposalId, {root: projectRoot});
    return ['verified','approved'].includes(detail.registry.state) && detail.validation?.passed === true;
  } catch { return false; }
};
const toolApprovalStore = new ToolApprovalStore({root: projectRoot, isVerified, verifyProposal: isVerified});
const toolMaintenance=createToolMaintenance({root:projectRoot,store:maintenanceStore,validate:createMaintenanceValidator({root:projectRoot,docker}),
  canValidate:id=>!toolRepair?.active(id),
  onError:()=>console.error('候选验证执行失败，请检查项目内私有运行记录。'),
  onSettled:notification=>toolCurationCoordinator?.observeMaintenance(notification)});
const repairStore=new ToolRepairStore({root:projectRoot});
toolRepair=createToolRepair({root:projectRoot,store:repairStore,taskStore,taskMessages,agentRuntime,maintenance:toolMaintenance,
  onSettled:notification=>toolCurationCoordinator?.observeRepair(notification)});
const listExistingTools = () => [
  'enumerate_sirna_candidates', ...getRegisteredToolCatalog({root: projectRoot}).tools.map(tool => tool.toolName),
];
const toolCurationPreview = createToolCurationPreview({taskStore, listExistingTools,listGapReports:(taskId,runId)=>toolGaps.list(taskId,runId)});
const curatorRuntime = new AgentComposeRuntime({root:projectRoot,agentName:'tool-curator',executor:createComposeExecutor(projectRoot,{agentName:'tool-curator'}),rpc:curatorRpc});
const curationStore = new ToolCurationStore({root:projectRoot});
const gapStore = new ToolGapStore({root:projectRoot});
toolGaps = createToolGapService({store:gapStore,taskStore,curationStore});
const toolCuration = createToolCurationService({store:curationStore,preview:toolCurationPreview,cooldownMs:604800000,
  onSettled:(run,metadata)=>toolCurationCoordinator?.observeCuration(run,metadata),
  curator:createAgentToolCurator({runtime:curatorRuntime,timeoutMs:180000})});
const curationBuildStore = new ToolCurationBuildStore({root:projectRoot});
toolCurationBuild = createToolCurationBuildService({root:projectRoot,store:curationBuildStore,curationStore,taskStore,taskMessages,agentRuntime,listExistingTools,
  onSettled:ticket=>toolCurationCoordinator?.observeBuilder(ticket)});
toolApproval=createToolApproval({root:projectRoot,store:toolApprovalStore,
  approve:(proposalId,actor)=>approveRegisteredToolProposal(proposalId,actor,{root:projectRoot}),
  onError:()=>console.error('候选批准执行失败，请检查项目内私有运行记录。'),
  onSettled:notification=>toolCurationCoordinator?.observeApproval(notification)});
toolCurationCoordinator=createToolCurationCoordinator({root:projectRoot,taskStore,preview:toolCurationPreview,curation:toolCuration,toolCurationBuild,toolMaintenance,toolAutomation,
  automaticValidation:process.env.SIRNA_AUTOMATIC_VALIDATION==='1',
  toolRepair,automaticRepair:process.env.SIRNA_AUTOMATIC_REPAIR==='1',
  toolApproval,
  approveTool:(proposalId,actor)=>approveRegisteredToolProposal(proposalId,actor,{root:projectRoot}),
  automaticApproval:process.env.SIRNA_AUTOMATIC_APPROVAL==='1',
  isReady:createCurationAutomationReadiness({taskMessages,agentRuntime}),isTaskBusy:taskId=>taskMessages.isTaskBusy(taskId),intervalMs:1000,maxReviews:3});
const internalApiHost = process.env.SIRNA_GOAL_VERIFIER_API_HOST;
const internalApiPort = Number(process.env.SIRNA_GOAL_VERIFIER_API_PORT ?? 3001);
if (internalApiHost !== undefined && (!/^[A-Za-z0-9.-]+$/.test(internalApiHost) || !Number.isInteger(internalApiPort) || internalApiPort < 1024 || internalApiPort > 65535)) {
  throw new Error('Invalid Goal verifier internal API listener configuration');
}
const server = createAppServer({ taskStore, agentRuntime, workspaceFiles, taskMessages, goalStore, goalVerification, toolMaintenance, toolApproval, toolRepair, toolCurationPreview, toolCuration, toolCurationBuild, toolCurationCoordinator,
  ...(internalApiHost ? {allowedHosts: [internalApiHost]} : {}) });
const internalApiServer = goalVerificationMode === 'agent-compose' && internalApiHost
  ? createServer(createGoalVerifierInternalHandler(server.requestHandler))
  : undefined;
if (internalApiServer) {
  internalApiServer.requestTimeout = 15000;
  internalApiServer.headersTimeout = 10000;
}
const shutdown = createApiShutdown({server,additionalServers: internalApiServer ? [internalApiServer] : [],toolMaintenance,toolApproval,toolRepair,toolCurationBuild,toolCurationCoordinator,toolsServer,
  goalVerification,
  stores:[taskStore,goalStore,maintenanceStore,toolAutomation,toolApprovalStore,repairStore,curationStore,curationBuildStore,gapStore,...(goalVerification ? [goalVerification.store] : [])],rpcs:[rpc,curatorRpc]});
const shutdownFailure = () => {console.error('服务停止未完全确认，请检查项目内私有运行记录。');process.exitCode=1;};
server.listen(3000, "127.0.0.1", async () => {
  // Never recover or claim jobs until this instance owns the listening socket.
  try {
    if (internalApiServer) {
      await new Promise((resolve, reject) => {
        internalApiServer.once('error', reject);
        internalApiServer.listen(internalApiPort, internalApiHost, resolve);
      });
    }
    startApiServices({server,toolRepair,toolCurationBuild,toolMaintenance,toolCuration,toolApproval,toolCurationCoordinator,goalVerification});
  }
  catch {shutdownFailure();void shutdown().catch(shutdownFailure);return;}
  console.log(`siRNA-pi: http://127.0.0.1:3000/ ; runtime=agent-compose ; internal=${internalApiServer ? `${internalApiHost}:${internalApiPort}` : 'off'} ; recovered=${recovered.length}`);
});
server.on("error", () => { console.error("网页服务启动失败，请检查端口与项目配置。");process.exitCode=1;void shutdown().catch(shutdownFailure);});
process.once("SIGTERM", () => {void shutdown().catch(shutdownFailure);});
process.once("SIGINT", () => {void shutdown().catch(shutdownFailure);});
