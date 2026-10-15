import fs from "node:fs";
import path from "node:path";
import { projectRoot, ensureProjectDirectory } from "../../packages/agent-runtime/pi-sdk.mjs";
import { LocalPiRuntime } from "../../packages/agent-runtime/local-pi-runtime.mjs";
import { TaskStore } from "../../packages/task-core/task-store.mjs";
import { createAppServer } from "./router.mjs";

process.umask(0o077);
const directory = path.join(projectRoot, "runtime", "tasks");
ensureProjectDirectory(directory);
const database = path.join(directory, "tasks.sqlite");
for (const file of [database, `${database}-wal`, `${database}-shm`]) {
  if (fs.existsSync(file) && fs.realpathSync(file) !== file) throw new Error("任务数据库路径无效。");
}
const taskStore = new TaskStore(database);
const recovered = taskStore.recoverInterruptedTasks();
const server = createAppServer({ taskStore, agentRuntime: new LocalPiRuntime() });
server.listen(3000, "127.0.0.1", () => {
  console.log(`siRNA-pi: http://127.0.0.1:3000/ ; runtime=local-pi ; recovered=${recovered.length}`);
});
server.on("error", () => { console.error("网页服务启动失败，请检查端口与项目配置。"); process.exitCode = 1; taskStore.close(); });
// Deployment stops an idle server. Let any accepted HTTP turn finish on normal shutdown.
process.once("SIGTERM", () => server.close(async () => {
  await server.waitForTaskCompletion();
  taskStore.close();
  process.exit(0);
}));
