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
const builders = createTaskToolBuilders({root: projectRoot,docker});
const toolsServer = createAgentToolsServer({ leases: toolCallLeases, builders,
  discover: ({taskContext}) => discoverApprovedTools({ root: projectRoot, runner, taskContext }) });
await listenToolSocket(toolsServer, {root: projectRoot});
const compose = new AgentComposeRuntime({ root: projectRoot, executor: createComposeExecutor(projectRoot), rpc, toolCallLeases, toolBuildersAvailable:true });
const agentRuntime = new RuntimeRouter({ compose, legacy: new LocalPiRuntime() });
const taskStore = new TaskStore(database);
const recovered = taskStore.recoverInterruptedTasks();
const workspaceFiles = new TaskFiles({ root: projectRoot, agentRuntime });
const server = createAppServer({ taskStore, agentRuntime, workspaceFiles });
server.listen(3000, "127.0.0.1", () => {
  console.log(`siRNA-pi: http://127.0.0.1:3000/ ; runtime=agent-compose ; recovered=${recovered.length}`);
});
server.on("error", () => { console.error("网页服务启动失败，请检查端口与项目配置。"); process.exitCode = 1; toolsServer.close(); taskStore.close(); rpc.close(); });
// Deployment stops an idle server. Let any accepted HTTP turn finish on normal shutdown.
process.once("SIGTERM", () => server.close(async () => {
  await server.waitForTaskCompletion();
  await new Promise(resolve => toolsServer.close(resolve));
  await toolsServer.waitForCalls();
  taskStore.close();
  rpc.close();
  process.exit(0);
}));
