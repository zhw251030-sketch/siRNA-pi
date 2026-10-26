import { createServer } from "node:http";
import fs from "node:fs/promises";
import { TaskMessageService, TaskMessageSubmissionError } from "../../packages/task-core/task-message-service.mjs";
import { WorkspaceFileError } from "../../packages/task-core/workspace.mjs";
import { ToolMaintenanceError } from "../../packages/capability-platform/tool-maintenance-store.mjs";
import { ToolRepairError } from "../../packages/capability-platform/tool-repair-service.mjs";
import { ToolCurationPreviewError } from "../../packages/extensions/tool-curation/tool-curation-preview.mjs";
import { ToolCurationError } from "../../packages/extensions/tool-curation/tool-curation-service.mjs";
import { ToolCurationBuildError } from "../../packages/extensions/tool-curation/tool-curation-build-service.mjs";
import { buildId, buildDigest } from "../../packages/extensions/tool-curation/tool-curation-build-contract.mjs";
import { maintenanceText } from "../../packages/capability-platform/tool-version.mjs";
import { createGoalApi } from "./goal-api.mjs";

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/sse.mjs", ["sse.mjs", "text/javascript; charset=utf-8"]],
  ["/lifecycle.mjs", ["lifecycle.mjs", "text/javascript; charset=utf-8"]],
  ["/files.mjs", ["files.mjs", "text/javascript; charset=utf-8"]],
  ["/tools.mjs", ["tools.mjs", "text/javascript; charset=utf-8"]],
  ["/curation.mjs", ["curation.mjs", "text/javascript; charset=utf-8"]],
  ["/curation-automation.mjs", ["curation-automation.mjs", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
function reply(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}
function invalid(message) { throw new TaskMessageSubmissionError(400, message); }
const previewExtensions = new Set(['txt', 'md', 'csv', 'tsv', 'tab', 'aln', 'json', 'yaml', 'yml', 'fa', 'fasta', 'fna', 'fastq', 'fq']);

function fileDisposition(name, inline) {
  // A quoted ASCII fallback plus an encoded filename prevents header injection.
  const filename = name.split('/').at(-1);
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="workspace-file"; filename*=UTF-8''${encoded}`;
}

async function readBody(request, maxBytes=1048576) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json" &&
      !(Number(request.headers["content-length"] ?? 0) === 0 && !request.headers["transfer-encoding"])) {
    request.resume();
    throw new TaskMessageSubmissionError(415, "请使用 JSON 格式发送请求。");
  }
  // Drain an oversized request so we can still return an HTTP error reliably.
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes <= maxBytes) chunks.push(chunk);
  }
  if (bytes > maxBytes) throw new TaskMessageSubmissionError(413, "请求正文过长。");
  let body;
  try { body = bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
  catch { invalid("无法读取 JSON 请求。"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("请求必须是 JSON 对象。");
  return body;
}

// HTTP only coordinates transport. Task state and runtime execution stay in
// their own packages, matching the reference repository's responsibility split.
export function createAppServer({ taskStore, agentRuntime, workspaceFiles, toolMaintenance, toolApproval, toolRepair, toolCurationPreview, toolCuration, toolCurationBuild, toolCurationCoordinator, goalStore, goalVerification, taskMessages: sharedTaskMessages } = {}) {
  const taskMessages = sharedTaskMessages ?? new TaskMessageService({ taskStore, agentRuntime, workspaceFiles });
  const goalApi = goalStore ? createGoalApi({
    taskStore,
    goalStore,
    readJsonBody: request => readBody(request, 64 * 1024),
    sendJson: reply,
    appendObjective: (taskId, content, requestId) => taskStore.appendConversationUserMessage(taskId, content, requestId),
    verification: goalVerification?.port ?? goalVerification,
  }) : undefined;
  const activeTurns = new Set();
  const track = (operation) => {
    activeTurns.add(operation);
    operation.then(() => activeTurns.delete(operation), () => activeTurns.delete(operation));
    return operation;
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const host = request.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ||
        (request.headers.origin && request.headers.origin !== `http://${host}`)) {
      request.resume();
      return reply(response, 403, { error: "请从本机网页访问此服务。" });
    }
    let url, pathname;
    try { url = new URL(request.url, `http://${host}`); pathname = url.pathname; }
    catch { request.resume(); return reply(response, 400, { error: "请求地址格式不正确。" }); }
    try {
      if (request.method === "GET" && pathname === "/health") {
        return reply(response, 200, { ready: true, busy: taskStore.listTasks().some((task) => task.status === "running"), runtime: agentRuntime?.runtimeInfo() });
      }
      if (request.method === "GET" && staticFiles.has(pathname)) {
        const [name, type] = staticFiles.get(pathname);
        const content = await fs.readFile(new URL(`../../public/${name}`, import.meta.url));
        response.writeHead(200, { "Content-Type": type });
        return response.end(content);
      }
      if (pathname === "/v1/chat") {
        request.resume();
        return reply(response, 410, { error: "Unbound chat sessions are disabled; use the task-scoped /v1/tasks API" });
      }
      if (request.method === "GET" && pathname === "/v1/tasks") return reply(response, 200, { tasks: taskStore.listTasks() });
      if (pathname === '/v1/tool-curation-automation' && ['GET','POST'].includes(request.method)) {
        if (url.searchParams.size) invalid('自动审查不接受查询参数。');
        if (!toolCurationCoordinator) return reply(response,503,{error:'自动审查服务尚未配置。'});
        const body = request.method === 'POST' ? await readBody(request,1024) : undefined;
        if (body && (Object.keys(body).length !== 1 || !Object.hasOwn(body,'enabled') || typeof body.enabled !== 'boolean')) invalid('自动审查只接受 enabled 布尔开关。');
        try {
          if (body) await toolCurationCoordinator.configure(body);
          return reply(response,200,{automation:toolCurationCoordinator.status()});
        } catch (error) {
          return reply(response,[409,503].includes(error?.statusCode)?error.statusCode:503,{error:'自动审查状态未能确认，请刷新状态后重试。'});
        }
      }
      const buildRoute = /^\/v1\/tasks\/([^/]+)\/curations\/([^/]+)\/build$/.exec(pathname);
      if (buildRoute && ['GET','POST'].includes(request.method)) {
        if (url.searchParams.size || !buildId(buildRoute[1]) || !buildId(buildRoute[2])) invalid('构建请求地址或参数无效。');
        if (!toolCurationBuild) return reply(response,503,{error:'构建交接服务尚未配置。'});
        if (!taskStore.getTask(buildRoute[1])) return reply(response,404,{error:'没有找到这个任务。'});
        if (request.method === 'GET') return reply(response,200,await track(Promise.resolve(toolCurationBuild.view(buildRoute[1],buildRoute[2]))));
        const body=await readBody(request,4096),fields=['traceSha256','resultSha256','promptSha256'];
        if(Object.keys(body).length!==3 || fields.some(key=>!Object.hasOwn(body,key)||!buildDigest(body[key]))) invalid('构建交接只接受三个 SHA-256 绑定。');
        const result=await track(toolCurationBuild.start(buildRoute[1],buildRoute[2],body));
        return reply(response,result.deduplicated?200:202,result);
      }
      const reviewsRoute = /^\/v1\/tasks\/([^/]+)\/curations(?:\/([^/]+))?$/.exec(pathname);
      if (reviewsRoute && ['GET','POST'].includes(request.method)) {
        if (url.searchParams.size) invalid('独立审查不接受查询参数。');
        if (!toolCuration) return reply(response, 503, {error:'独立审查服务尚未配置。'});
        if (!taskStore.getTask(reviewsRoute[1])) return reply(response, 404, {error:'没有找到这个任务。'});
        if (request.method === 'GET') return reply(response, 200, reviewsRoute[2] ?
          {curation:toolCuration.get(reviewsRoute[1],reviewsRoute[2])} : {curations:toolCuration.list(reviewsRoute[1])});
        if (!reviewsRoute[2]) {
          const body=await readBody(request,4096);
          if (Object.keys(body).length!==3 || !['runId','sourceSha256','previewSha256'].every(key=>Object.hasOwn(body,key))) invalid('独立审查只接受 runId、sourceSha256 和 previewSha256。');
          const result=await track(toolCuration.request(reviewsRoute[1],body));
          return reply(response,result.deduplicated?200:202,result);
        }
      }
      const curationRoute = /^\/v1\/tasks\/([^/]+)\/curation-preview$/.exec(pathname);
      if (request.method === 'GET' && curationRoute) {
        if ([...url.searchParams.keys()].some(key => key !== 'runId') || url.searchParams.getAll('runId').length > 1) {
          invalid('轨迹预览只接受一个可选的 runId 参数。');
        }
        if (!toolCurationPreview) return reply(response, 503, {error: '轨迹预览服务尚未配置。'});
        return reply(response, 200, toolCurationPreview.read(curationRoute[1], url.searchParams.get('runId') ?? undefined));
      }
      const proposalRoute=/^\/v1\/tool-proposals(?:\/([^/]+)\/(approve|validate|validation-summary|repair-feedback|repair-status|repair))?$/.exec(pathname);
      if(proposalRoute){
        if(proposalRoute[2]==='approve'){
          if(request.method!=='POST') { request.resume(); return reply(response,404,{error:'没有这个页面或接口。'}); }
          if(url.searchParams.size) invalid('批准请求不接受查询参数。');
          if(!toolApproval)return reply(response,503,{error:'候选批准服务尚未配置。'});
          const body=await readBody(request,4096);
          if(Object.keys(body).length!==2||!Object.hasOwn(body,'requestId')||!Object.hasOwn(body,'approvedBy'))invalid('批准请求只接受 requestId 和 approvedBy。');
          if(typeof body.requestId!=='string'||!uuidV4.test(body.requestId))invalid('批准请求的 requestId 或 approvedBy 无效。');
          try { maintenanceText(body.approvedBy,'approvedBy'); } catch { invalid('批准请求的 requestId 或 approvedBy 无效。'); }
          try{
            const result=toolApproval.enqueue(proposalRoute[1],body.requestId,{approvedBy:body.approvedBy});
            return reply(response,result?.deduplicated?200:202,result);
          }catch(error){
            const status=/verified|proposal|request|actor|approvedBy|UUID/i.test(String(error?.message??''))?409:503;
            return reply(response,status,{error:status===409?'候选尚未满足批准条件或请求已冲突。':'候选批准服务暂不可用。'});
          }
        }
        if(['repair-status','repair'].includes(proposalRoute[2])){
          if(!toolRepair)return reply(response,503,{error:'候选修订服务尚未配置。'});
          if(request.method==='GET'&&proposalRoute[2]==='repair-status')return reply(response,200,toolRepair.status(proposalRoute[1]));
          if(request.method==='POST'&&proposalRoute[2]==='repair'){
            const body=await readBody(request,4096);
            if(Object.keys(body).length!==2||!Object.hasOwn(body,'validationId')||!Object.hasOwn(body,'reportSha256'))invalid('修订请求只接受 validationId 和 reportSha256。');
            const result=await toolRepair.start(proposalRoute[1],body);return reply(response,result.deduplicated?200:202,result);
          }
        }
        if(request.method==='GET'&&!proposalRoute[1]){
          if(!toolMaintenance&&!toolApproval)return reply(response,503,{error:'候选维护服务尚未配置。'});
          return reply(response,200,{proposals:toolMaintenance?.list?.()??[],...(toolMaintenance?.status?{maintenance:toolMaintenance.status()}:{}),...(toolApproval?.list?{approvals:toolApproval.list().map(job=>({id:job.id,proposalId:job.proposalId,status:job.status,requestedBy:job.requestedBy,createdAt:job.createdAt,updatedAt:job.updatedAt,...(job.approved===undefined?{}:{approved:job.approved}),...(job.activated===undefined?{}:{activated:job.activated})}))}: {})});
        }
        if(!toolMaintenance)return reply(response,503,{error:'候选验证服务尚未配置。'});
        if(request.method==='GET'&&proposalRoute[2]==='validation-summary')return reply(response,200,{summary:toolMaintenance.summary(proposalRoute[1])});
        if(request.method==='GET'&&proposalRoute[2]==='repair-feedback')return reply(response,200,{feedback:toolMaintenance.feedback(proposalRoute[1])});
        if(request.method==='POST'&&proposalRoute[2]==='validate'){
          const body=await readBody(request,4096);
          if(Object.keys(body).length!==1||!Object.hasOwn(body,'requestId'))invalid('验证请求只接受 requestId。');
          return reply(response,202,toolMaintenance.enqueue(proposalRoute[1],body.requestId));
        }
      }
      const goalRoute = /^\/v1\/tasks\/([^/]+)\/goal$/.exec(pathname);
      if (goalRoute && goalApi) {
        return goalApi.handle(request, response, goalRoute[1]);
      }
      const goalVerificationAccessRoute = /^\/v1\/goal-verifications\/([^/]+)\/(bundle|message|artifact|evidence|check)$/.exec(pathname);
      if (goalVerificationAccessRoute) {
        if (!goalVerification?.access) return reply(response, 503, {error: 'Goal 验证访问服务尚未配置。'});
        if (request.method !== 'POST') {
          request.resume();
          response.writeHead(405, {allow: 'POST'});
          return response.end();
        }
        if (url.searchParams.size) invalid('Goal 验证访问不接受查询参数。');
        try {
          const body = await readBody(request, 64 * 1024);
          const verificationId = goalVerificationAccessRoute[1];
          if (body.verificationId !== undefined && body.verificationId !== verificationId) throw new Error('verification id does not match the route');
          if (typeof body.accessToken !== 'string' || !body.accessToken) throw new Error('accessToken is required');
          const result = await goalVerification.access.handle(goalVerificationAccessRoute[2], {...body, verificationId});
          return reply(response, 200, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = Number.isInteger(error?.statusCode) ? error.statusCode
            : /token|expired/i.test(message) ? 403
              : /not found|does not belong|does not match/i.test(message) ? 404 : 400;
          return reply(response, status, {error: message});
        }
      }
      const goalVerificationsRoute = /^\/v1\/tasks\/([^/]+)\/goal-verifications(?:\/([^/]+))?$/.exec(pathname);
      if (goalVerificationsRoute && request.method === 'GET') {
        if (!goalVerification) return reply(response, 503, {error: 'Goal 验证服务尚未配置。'});
        if (!taskStore.getTask(goalVerificationsRoute[1])) return reply(response, 404, {error: '没有找到这个任务。'});
        if (goalVerificationsRoute[2]) {
          const run = (goalVerification.port ?? goalVerification).get?.(goalVerificationsRoute[1], goalVerificationsRoute[2]);
          return run ? reply(response, 200, {verification: run}) : reply(response, 404, {error: '没有找到这个验证请求。'});
        }
        return reply(response, 200, {verifications: (goalVerification.port ?? goalVerification).list?.(goalVerificationsRoute[1]) ?? []});
      }
      const filesRoute = /^\/v1\/tasks\/([^/]+)\/files(?:\/(input|output)\/([^/]+))?$/.exec(pathname);
      if (request.method === 'POST' && filesRoute && !filesRoute[2]) {
        const payload = await readBody(request);
        const result = await track(taskMessages.uploadInput(filesRoute[1], payload));
        if (!response.destroyed) reply(response, 201, result);
        return;
      }
      if (request.method === 'GET' && filesRoute) {
        const task = taskStore.getTask(filesRoute[1]);
        if (!task) return reply(response, 404, { error: '没有找到这个任务。' });
        if (!workspaceFiles) return reply(response, 503, { error: '任务文件服务尚未配置。' });
        if (!filesRoute[2]) return reply(response, 200, await track(workspaceFiles.list(task)));
        let name;
        try { name = decodeURIComponent(filesRoute[3]); }
        catch { invalid('文件名称编码不正确。'); }
        const inline = url.searchParams.get('download') !== 'true' && previewExtensions.has(name.split('.').at(-1).toLowerCase());
        const { data, synchronization } = await track(workspaceFiles.read(task, filesRoute[2], name, { maxBytes: inline ? 256 * 1024 : 50_000_000 }));
        if (inline) {
          try { new TextDecoder('utf-8', { fatal: true }).decode(data); }
          catch { return reply(response, 415, { error: '此文件不是有效的 UTF-8 文本，请下载后查看。' }); }
        }
        response.writeHead(200, {
          'Content-Type': inline ? 'text/plain; charset=utf-8' : 'application/octet-stream',
          'Content-Length': data.length,
          'Content-Disposition': fileDisposition(name, inline),
          'Content-Security-Policy': "default-src 'none'; sandbox",
          ...(['current', 'cached', 'unprepared'].includes(synchronization) ? { 'X-Task-Files-Sync': synchronization } : {}),
        });
        return response.end(data);
      }
      if (request.method === "POST" && pathname === "/v1/tasks") {
        const body = await readBody(request);
        if (Object.keys(body).some((key) => !["requestId", "memoryFileIds", "dataAssetIds"].includes(key))) invalid("创建任务与发送消息是两个接口，请先创建任务。");
        for (const key of ["memoryFileIds", "dataAssetIds"]) {
          if (body[key] !== undefined && (!Array.isArray(body[key]) || body[key].length)) invalid("本学习阶段尚未接入记忆与数据资产。");
        }
        const result = await taskMessages.createTask(body.requestId);
        return reply(response, result.deduplicated ? 200 : 201, {
          task: result.task, memory: { count: 0, attachments: [] }, dataPool: { count: 0, bindings: [] },
          ...(result.deduplicated ? { deduplicated: true } : {}),
        });
      }
      const lifecycle = /^\/v1\/tasks\/([^/]+)\/(cancel|runtime)$/.exec(pathname);
      if (lifecycle && (lifecycle[2] === "cancel" && request.method === "POST" || lifecycle[2] === "runtime" && request.method === "DELETE")) {
        const body = await readBody(request);
        if (Object.keys(body).length) invalid("此操作不接受其他请求参数。");
        const operation = lifecycle[2] === "cancel" ? taskMessages.cancelTask(lifecycle[1]) : taskMessages.endTask(lifecycle[1]);
        const result = await track(operation);
        if (!response.destroyed) reply(response, 200, result);
        return;
      }
      const match = /^\/v1\/tasks\/([^/]+)\/messages$/.exec(pathname);
      if (match && request.method === "GET") {
        const task = taskStore.getTask(match[1]);
        if (!task) return reply(response, 404, { error: "没有找到这个任务。" });
        let execution = null;
        if (typeof agentRuntime?.describe === "function") {
          try { execution = await agentRuntime.describe(task.executionSessionId) ?? null; }
          catch { execution = { unavailable: true }; }
        }
        return reply(response, 200, { task, messages: taskStore.listMessages(task.id), runEvents: taskStore.listRunEvents(task.id), execution, goal: goalApi?.get(task.id) ?? null });
      }
      if (match && request.method === "POST") {
        const body = await readBody(request);
        if (Object.keys(body).some((key) => !["message", "requestId"].includes(key))) invalid("本学习阶段尚不支持消息修订或其他消息参数。");
        if (typeof body.requestId === 'string' && body.requestId.startsWith('auto-tool-curation-build:')) invalid('此请求号仅用于已保存建议的显式构建交接。');
        // Validate/reserve before sending HTTP 200. Buffer immediate events,
        // then stream throughout execution and durable message persistence.
        let streaming = false;
        const buffered = [];
        const send = (event) => {
          if (!streaming) buffered.push(event);
          else if (!response.destroyed) response.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        const turn = await taskMessages.start({ taskId: match[1], ...body }, send);
        track(turn.completion);
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive", "X-Accel-Buffering": "no",
        });
        response.write(": connected\n\n");
        streaming = true;
        for (const event of buffered) send(event);
        await turn.completion;
        if (!response.destroyed) response.end();
        return;
      }
      request.resume();
      reply(response, 404, { error: "没有这个页面或接口。" });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const known = error instanceof TaskMessageSubmissionError || error instanceof WorkspaceFileError || error instanceof ToolMaintenanceError || error instanceof ToolRepairError || error instanceof ToolCurationPreviewError || error instanceof ToolCurationError || error instanceof ToolCurationBuildError;
        reply(response, known ? error.statusCode : 500,
          { error: known ? error.message : "服务处理失败，请检查项目内运行记录。" });
      } else if (!response.destroyed) response.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  // HTTP connections and accepted agent turns have different lifetimes.
  server.waitForTaskCompletion = () => Promise.allSettled([...activeTurns,...(toolRepair?[toolRepair.drain()]:[])]);
  return server;
}
