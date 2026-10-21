import { consumeSse } from "./sse.mjs";
import { lifecycleControls, mergeTaskState, pendingDisposition } from "./lifecycle.mjs";
import { createTaskFiles, taskFileUrl, canPreviewFile, canDownloadFile } from "./files.mjs";
import { createCurationPreviewPanel, curationNavigation } from "./curation.mjs";

const elements = Object.fromEntries([
  "new-session", "refresh-tasks", "task-list", "chat-panel", "chat-title", "task-status",
  "messages", "composer", "message-input", "send-button", "example-button", "recover-message",
  "tool-activity", "run-log", "task-id", "task-workspace", "task-event-log", "composer-help",
  "stop-run", "end-task", "lifecycle-help",
  "files-panel", "refresh-files", "input-files", "output-files", "files-status", "file-list",
  "file-preview", "file-preview-title", "file-preview-meta", "file-preview-status", "file-preview-text",
  "file-preview-download", "close-file-preview",
  "file-input", "upload-file", "upload-status", "files-warning",
].map((id) => [id, document.getElementById(id)]));
const exampleMessages = {
  "local-pi": "请使用 read 工具读取当前目录的 numbers.csv，计算其中数值的数量 count、总和 sum 和平均值 mean。使用 write 工具将结果保存为当前目录的 result.json，内容只包含 count、sum、mean 三个字段。最后再次使用 read 工具读取 result.json，核对保存的结果，并用中文简要说明。",
  "agent-compose": "请使用 read 工具读取 /workspace/input/numbers.csv，计算其中数值的数量 count、总和 sum 和平均值 mean。使用 write 工具将结果保存为 /workspace/output/result.json，内容只包含 count、sum、mean 三个字段。最后再次使用 read 工具读取 /workspace/output/result.json，核对保存的结果，并用中文简要说明。",
};
const state = { tasks: [], task: null, execution: null, busy: false, uploadBusy: false, lifecycleBusy: null, stopRequested: false, messages: new Map(), tools: new Map(), assistant: null, pendingUser: null };
const pendingKey = "sirna-pi.pending-message";
const selectedKey = "sirna-pi.selected-task";
const creationKey = "sirna-pi.pending-creation";
let fileGroup = "output";
let previousFilesView = null;
let taskSelectionVersion = 0;
const taskFiles = createTaskFiles({ onChange: renderTaskFiles });
const curationPreview = createCurationPreviewPanel({ root: document.getElementById("curation-panel"),
  ...curationNavigation({document,openTask:id=>withBusy(()=>selectTask(id))}) });

function readStored(storage, key) {
  try { return JSON.parse(storage.getItem(key) || "null"); } catch { return null; }
}
function store(storage, key, value) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch { /* The page still works when browser storage is unavailable. */ }
}
let pending = readStored(sessionStorage, pendingKey);

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function fileSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}
function fileMetadata(file) {
  const modified = new Date(file.modifiedAt);
  const date = Number.isNaN(modified.getTime()) ? "时间未知" : modified.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${fileSize(file.size)} · ${date}`;
}
function renderTaskFiles(view, forceList = false) {
  state.uploadBusy = view.uploadStatus === "loading";
  if (previousFilesView?.taskId !== view.taskId) elements["file-input"].value = "";
  elements["upload-status"].textContent = view.uploadMessage;
  elements["upload-status"].dataset.state = view.uploadStatus;
  const warning = view.synchronization === "cached" ? `当前显示已归档的文件，尚未确认与执行环境一致。${view.warning || ""}` : view.warning;
  elements["files-warning"].textContent = warning;
  elements["files-warning"].hidden = !warning;
  elements["files-panel"].setAttribute("aria-busy", String(view.listStatus === "loading" || state.uploadBusy));
  // A preview response must not replace its focused list button.
  if (forceList || !previousFilesView || view.files !== previousFilesView.files || view.listStatus !== previousFilesView.listStatus || view.taskId !== previousFilesView.taskId) {
    elements["refresh-files"].disabled = !view.taskId || view.listStatus === "loading";
    elements["refresh-files"].textContent = view.listStatus === "loading" ? "读取中…" : "刷新文件";
    for (const kind of ["input", "output"]) {
      const button = elements[`${kind}-files`];
      button.textContent = `${kind === "input" ? "输入资料" : "输出结果"}（${view.files.filter((file) => file.kind === kind).length}）`;
      button.setAttribute("aria-pressed", String(fileGroup === kind));
    }
    const files = view.files.filter((file) => file.kind === fileGroup);
    const label = fileGroup === "input" ? "输入资料" : "输出结果";
    let message = !view.taskId ? "选择任务后查看文件。" : "文件尚未载入，可点击“刷新文件”。";
    if (view.listStatus === "loading") message = "正在读取本任务文件…";
    else if (view.listStatus === "error") message = `读取失败：${view.error}`;
    else if (view.workspaceState === "unprepared") message = "尚无任务文件。可以先上传输入资料，再发送任务要求。";
    else if (view.workspaceState === "unsupported") message = "此旧版任务暂不支持网页文件查看，可在下方查看原工作目录。";
    else if (view.workspaceState === "ready") message = files.length ? `${files.length} 个${label}。点击文本文件名可预览。` : `暂无${label}。`;
    if (view.workspaceState === "ready" && view.synchronization === "unprepared") message += " 已保存的资料会在下次执行时同步到任务环境。";
    elements["files-status"].textContent = message;
    elements["files-status"].dataset.state = view.listStatus;
    elements["file-list"].setAttribute("aria-label", label);
    elements["file-list"].replaceChildren();
    for (const file of files) {
      const row = node("li", "file-item");
      const previewable = canPreviewFile(file);
      const name = node(previewable ? "button" : "strong", "file-name", file.name);
      if (previewable) {
        name.type = "button";
        name.setAttribute("aria-label", `预览 ${file.name}`);
        name.addEventListener("click", () => void taskFiles.previewFile(file));
      }
      row.append(name, node("p", "file-meta", fileMetadata(file)));
      const actions = node("div", "file-actions");
      actions.append(node("span", "file-hint", previewable ? "文本预览" : file.size > 256 * 1024 ? "请下载查看" : "此格式仅供下载"));
      if (canDownloadFile(file)) {
        const download = node("a", "file-download", "下载");
        download.href = taskFileUrl(view.taskId, file, true);
        download.download = file.name.split("/").at(-1);
        download.setAttribute("aria-label", `下载 ${file.name}`);
        actions.append(download);
      } else actions.append(node("span", "file-hint", "超过 50 MB 下载上限"));
      row.append(actions);
      elements["file-list"].append(row);
    }
  }
  const preview = view.preview;
  elements["file-preview"].hidden = !preview;
  elements["file-preview"].setAttribute("aria-busy", String(preview?.status === "loading"));
  elements["file-preview-text"].hidden = preview?.status !== "ready";
  elements["file-preview-text"].textContent = preview?.text || "";
  elements["file-preview-title"].textContent = preview?.file.name || "";
  elements["file-preview-meta"].textContent = preview ? fileMetadata(preview.file) : "";
  elements["file-preview-status"].textContent = !preview ? "" : preview.status === "loading" ? "正在读取文本…" : preview.status === "error" ? `预览失败：${preview.error}` : preview.text ? "原始文本" : "这是一个空文件。";
  elements["file-preview-status"].dataset.state = preview?.status || "idle";
  if (preview) {
    elements["file-preview-download"].href = taskFileUrl(view.taskId, preview.file, true);
    elements["file-preview-download"].download = preview.file.name.split("/").at(-1);
  } else elements["file-preview-download"].removeAttribute("href");
  previousFilesView = view;
  syncControls();
}
function setStatus(text, kind = "idle") {
  if (state.task?.status === "stopped") {
    text = "任务已结束，运行环境已释放。对话、记录和文件已保留，可在这里查看。";
    kind = "idle";
  }
  elements["task-status"].textContent = text;
  elements["task-status"].dataset.state = kind;
}
function statusLabel(status) {
  return { idle: "可继续", running: "运行中", failed: "运行失败", stopped: "已结束", pending: "等待中", succeeded: "已完成", canceled: "已中断", cancelled: "已中断" }[status] || "等待中";
}
function syncControls() {
  const navigating = state.busy || state.uploadBusy || Boolean(state.lifecycleBusy);
  const recovering = Boolean(pending && pending.taskId === state.task?.id);
  const blocked = navigating || state.stopRequested || state.task?.status === "running" || state.task?.status === "stopped" || Boolean(pending) || !state.task;
  elements["send-button"].disabled = blocked;
  elements["example-button"].disabled = blocked || !exampleMessages[state.execution?.backend];
  elements["message-input"].disabled = !state.task;
  elements["message-input"].readOnly = blocked;
  elements["new-session"].disabled = navigating;
  elements["refresh-tasks"].disabled = navigating;
  elements["recover-message"].hidden = !recovering || state.task?.status === "running";
  elements["recover-message"].disabled = navigating || state.task?.status === "stopped";
  elements["send-button"].textContent = state.busy && state.task ? "处理中…" : "发送 ↑";
  elements["chat-panel"].setAttribute("aria-busy", String(state.busy || state.task?.status === "running"));
  const controls = lifecycleControls(state);
  elements["stop-run"].disabled = !controls.canStop;
  elements["end-task"].disabled = !controls.canEnd || state.uploadBusy;
  elements["stop-run"].textContent = state.lifecycleBusy === "stop" || state.stopRequested ? "正在停止…" : "停止本轮";
  elements["end-task"].textContent = state.lifecycleBusy === "end" ? "正在结束…" : "结束任务";
  const uploadAllowed = canUploadToTask();
  elements["file-input"].disabled = !uploadAllowed;
  elements["upload-file"].disabled = !uploadAllowed || !elements["file-input"].files?.length;
  elements["upload-file"].textContent = state.uploadBusy ? "上传中…" : "上传所选文件";
  elements["refresh-files"].disabled = !state.task || state.uploadBusy || taskFiles.state.listStatus === "loading";
  for (const button of elements["task-list"].querySelectorAll("button")) button.disabled = navigating;
}
function canUploadToTask() {
  return Boolean(state.task && ["idle", "failed"].includes(state.task.status)
    && state.execution?.backend === "agent-compose" && !state.execution.unavailable && !state.execution.stopUnconfirmed
    && !state.busy && !state.uploadBusy && !state.lifecycleBusy && !state.stopRequested && !pending);
}
function upsertTask(task) {
  if (!task?.id) return;
  const index = state.tasks.findIndex((item) => item.id === task.id);
  task = mergeTaskState(state.tasks[index], task);
  if (state.task?.id === task.id) task = mergeTaskState(state.task, task);
  if (index < 0) state.tasks.unshift(task);
  else state.tasks[index] = task;
  if (state.task?.id === task.id) {
    state.task = task;
    renderIdentity();
  }
  renderTaskList();
}
function renderTaskList() {
  const tasks = [...state.tasks].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  elements["task-list"].replaceChildren();
  if (!tasks.length) elements["task-list"].append(node("p", "help", "还没有任务。点击上方按钮开始。"));
  for (const task of tasks) {
    const button = node("button", "task-item");
    button.type = "button";
    button.disabled = state.busy || state.uploadBusy || Boolean(state.lifecycleBusy);
    button.setAttribute("aria-current", String(task.id === state.task?.id));
    button.append(node("strong", "", task.title || "新的设计任务"));
    const date = new Date(task.updatedAt);
    const dateText = Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    button.append(node("span", "task-meta", `${statusLabel(task.status)} · ${dateText}`));
    button.addEventListener("click", () => void withBusy(() => selectTask(task.id)));
    elements["task-list"].append(button);
  }
}
function renderIdentity() {
  const task = state.task;
  curationPreview.setTask(task);
  const execution = state.execution;
  const known = Boolean(exampleMessages[execution?.backend]);
  const waiting = execution?.unavailable ? "暂时无法读取，请刷新记录" : "等待任务文件信息";
  elements["chat-title"].textContent = task?.title || "选择或创建一个任务";
  elements["task-id"].textContent = task?.id || "尚未创建";
  elements["task-workspace"].textContent = execution?.workspacePath || (known ? "任务开始后生成" : waiting);
  elements["task-event-log"].textContent = execution?.eventLogPath || (known ? "尚未运行" : waiting);
  elements["composer-help"].textContent = task?.status === "stopped" ? "此任务已结束，仅供查看。请新建任务以继续工作。" : known
    ? "当前练习可以读取、写入本任务目录中的文件。"
    : task ? "正在等待任务文件信息；请刷新记录后再填入统计示例。" : "选择或创建任务后，可以填入统计示例。";
  elements["lifecycle-help"].textContent = task?.status === "stopped"
    ? "运行环境已释放；历史和文件保留。"
    : execution?.backend === "agent-compose" && execution.supportsLifecycle !== false
      ? execution.stopUnconfirmed ? "上轮停止尚未确认，可再次停止或结束任务。"
        : "停止本轮后可继续聊；结束任务会释放运行环境，保留历史和文件。"
      : task ? "当前任务的运行环境不支持这些操作，或信息暂不可用。" : "选择任务后查看可用操作。";
}
function appendMessage(role, content, id) {
  if (id && state.messages.has(id)) {
    const existing = state.messages.get(id);
    existing.body.textContent = content;
    return existing;
  }
  elements.messages.querySelector(".welcome")?.remove();
  const article = node("article", `message ${role === "user" ? "user" : "assistant"}-message`);
  article.append(node("div", "message-role", role === "user" ? "你" : "Pi"));
  const body = node("div", "message-body", content);
  article.append(body);
  elements.messages.append(article);
  const result = { article, body };
  if (id) { article.dataset.messageId = id; state.messages.set(id, result); }
  scrollMessages();
  return result;
}
function saveMessage(message, existing) {
  if (!message?.id) return;
  const known = state.messages.get(message.id);
  const entry = known || existing || appendMessage(message.role, message.content || "", message.id);
  if (known && existing && known !== existing) existing.article.remove();
  entry.body.textContent = message.content || "";
  entry.article.dataset.messageId = message.id;
  entry.article.classList.toggle("failed", message.status === "failed");
  state.messages.set(message.id, entry);
  scrollMessages();
}
function scrollMessages() { elements.messages.scrollTop = elements.messages.scrollHeight; }
function renderMessages(messages) {
  elements.messages.replaceChildren();
  state.messages.clear();
  state.assistant = null;
  state.pendingUser = null;
  if (!messages.length) {
    const welcome = node("div", "welcome");
    welcome.append(node("span", "welcome-mark", "↗"), node("h2", "", state.task?.status === "stopped" ? "此任务已结束" : "先做一个能检查结果的小任务"), node("p", "help", state.task?.status === "stopped" ? "本任务尚无对话。已有记录和文件位置仍可查看。" : state.task ? "点击下方“填入统计示例”，观察 Pi 如何读取文件并保存结果。完成后可以在这里继续追问。" : "点击“新建设计任务”，建立一段独立的对话。"));
    elements.messages.append(welcome);
  }
  for (const message of messages) saveMessage(message);
}
function resetActivity() {
  state.tools.clear();
  elements["tool-activity"].replaceChildren(node("p", "help", "还没有工具操作"));
  elements["run-log"].replaceChildren(node("li", "help", "等待任务开始"));
}
function addRunEntry(title, text, kind = "") {
  elements["run-log"].querySelector(".help")?.remove();
  const entry = node("li", `run-entry ${kind}`);
  entry.append(node("strong", "", title));
  if (text) entry.append(node("p", "", text));
  elements["run-log"].prepend(entry);
  while (elements["run-log"].children.length > 60) elements["run-log"].lastElementChild.remove();
}
function showActivity(event) {
  if (event.type === "tool_start" || event.type === "tool_end") {
    const runId = event.runId || state.task?.currentRunId || "";
    const key = `${runId}:${event.toolCallId}`;
    let tool = state.tools.get(key);
    if (!tool) {
      elements["tool-activity"].querySelector(".help")?.remove();
      const article = node("div", "tool-item");
      const heading = node("div", "tool-name");
      const label = node("span", "tool-state");
      heading.append(node("strong", "", ({ read: "读取文件", write: "写入文件" })[event.toolName] || event.toolName || "工具操作"), label);
      const path = node("p", "");
      article.append(heading, path);
      elements["tool-activity"].append(article);
      tool = { article, label, path, runId };
      state.tools.set(key, tool);
    }
    tool.article.dataset.state = event.type === "tool_start" ? "running" : event.isError ? "error" : "success";
    tool.label.textContent = event.type === "tool_start" ? "执行中" : event.isError ? "失败" : "完成";
    if (typeof event.args?.path === "string") tool.path.textContent = event.args.path;
  } else if (event.type === "progress_message") addRunEntry("执行说明", event.text || "");
  else if (event.type === "approved_tool_call") addRunEntry(event.success ? "正式工具调用完成" : "正式工具调用失败",
    `${event.toolName} · 调用编号 ${event.toolCallId}`, event.success ? "" : "error");
  else if (event.type === "builder_tool_call") addRunEntry(event.success ? "构建操作完成" : "构建操作失败",
    `${event.toolName} · 调用编号 ${event.toolCallId}`, event.success ? "" : "error");
  else if (event.type === "workspace_synced") addRunEntry("任务文件已同步", "本轮文件同步已完成，可刷新文件查看。");
  else if (event.type === "workspace_warning") addRunEntry("文件同步尚未确认", event.warning || event.error || event.message || "请刷新文件核对已归档的内容。", "error");
  else if (event.type === "run_status") addRunEntry("运行状态", statusLabel(event.status), event.status === "failed" ? "error" : "");
  else if (event.type === "done") {
    const runId = event.runId || state.task?.currentRunId || "";
    for (const tool of state.tools.values()) {
      if (tool.runId !== runId || tool.article.dataset.state !== "running") continue;
      tool.article.dataset.state = "unconfirmed";
      tool.label.textContent = ["canceled", "cancelled"].includes(event.status) ? "已中断，结果未确认" : "结果未确认";
    }
    addRunEntry("本次执行结束", statusLabel(event.status), event.status === "failed" ? "error" : "");
  }
  else if (event.type === "error") addRunEntry("执行失败", event.error || "任务未能完成。", "error");
}
function handleStreamEvent(event) {
  if ((event.taskId && event.taskId !== state.task?.id) || (event.task?.id && event.task.id !== state.task?.id)) return;
  if (event.type === "task" || event.type === "task_saved") {
    upsertTask(event.task);
    if (event.type === "task_saved" && event.task?.status !== "running") state.stopRequested = false;
    if (event.type === "task_saved") void taskFiles.refresh();
    if (event.message) saveMessage(event.message, state.pendingUser);
  } else if (event.type === "session") {
    state.execution = exampleMessages[event.backend] ? {
      ...(state.execution?.backend === event.backend ? state.execution : {}),
      backend: event.backend,
      stopUnconfirmed: false,
      ...(typeof event.sandboxId === "string" ? { sandboxId: event.sandboxId } : {}),
      workspacePath: typeof event.workspacePath === "string" ? event.workspacePath : null,
      eventLogPath: typeof event.eventLogPath === "string" ? event.eventLogPath : null,
    } : null;
    upsertTask({ ...state.task, executionSessionId: event.sessionId, currentRunId: event.runId, piSessionId: event.piSessionId, status: "running" });
    setStatus("Pi 正在执行任务，可以在右侧查看进展。", "running");
  } else if (event.type === "text_delta" || event.type === "assistant_message") {
    state.assistant ||= appendMessage("assistant", "");
    if (event.type === "text_delta") state.assistant.body.textContent += event.delta || "";
    else state.assistant.body.textContent = event.text || "";
    scrollMessages();
  } else if (event.type === "message_saved") {
    saveMessage(event.message, event.message?.role === "user" ? state.pendingUser : state.assistant);
  } else if (event.type === "done") {
    setStatus("本次执行已结束，正在保存任务记录…", "running");
  } else if (event.type === "error") {
    setStatus(event.error || "执行失败，可以查看运行动态。", "error");
  } else if (event.type === "request_deduplicated") {
    setStatus("这条消息已被接收，正在恢复已有记录…", "running");
  }
  if (event.type === "workspace_synced" || event.type === "workspace_warning") void taskFiles.refresh();
  showActivity(event);
  syncControls();
}
async function readJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `请求失败（HTTP ${response.status}），请刷新记录后重试。`);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("服务器返回的信息不完整，请刷新记录。");
  return body;
}
async function refreshTaskList() {
  const data = await readJson("/v1/tasks");
  state.tasks = (data.tasks || []).map((task) => mergeTaskState(state.tasks.find((item) => item.id === task.id), task));
  renderTaskList();
}
async function selectTask(id) {
  const selection = ++taskSelectionVersion;
  const sameTask = state.task?.id === id;
  // Select and clear immediately so a failed or delayed request cannot leave
  // the previous task's files actionable under the new selection.
  state.task = sameTask ? state.task : state.tasks.find((task) => task.id === id) || { id, title: "正在读取任务…", status: "pending" };
  if (!sameTask) state.execution = null;
  taskFiles.setTask(id);
  if (!sameTask) { state.stopRequested = false; renderMessages([]); resetActivity(); }
  renderIdentity();
  renderTaskList();
  const data = await readJson(`/v1/tasks/${encodeURIComponent(id)}/messages`);
  if (selection !== taskSelectionVersion) return;
  if (data.task?.id !== id) throw new Error("服务器返回了不同的任务，请刷新记录。");
  state.task = mergeTaskState(state.task, data.task);
  state.execution = data.execution ?? null;
  if (!sameTask || state.task.status !== "running" && !state.execution?.stopUnconfirmed) state.stopRequested = false;
  store(localStorage, selectedKey, id);
  upsertTask(data.task);
  renderMessages(data.messages || []);
  resetActivity();
  for (const record of (data.runEvents || []).slice(-120)) showActivity({ ...(record.payload || record), runId: record.runId || record.payload?.runId });
  // Ended tasks cannot retry a never-accepted send. Keep that text as a visible
  // local draft while releasing the pending reservation for other tasks.
  const disposition = pendingDisposition(pending, state.task, data.messages);
  if (disposition === "archive") store(sessionStorage, `sirna-pi.unsent:${id}`, pending);
  if (disposition !== "keep") {
    pending = null;
    store(sessionStorage, pendingKey, null);
  }
  const unsent = readStored(sessionStorage, `sirna-pi.unsent:${id}`);
  if (unsent) addRunEntry("未发送的本地草稿", unsent.message);
  if (state.task.status === "stopped") setStatus("");
  else if (data.task.status === "running") setStatus("任务仍在运行。可停止本轮，或点击“刷新记录”查看新的执行进展。", "running");
  else if (pending?.taskId === id) setStatus("上次连接中断。可恢复本次发送，系统会核对已有记录，避免重复执行。", "error");
  else if (pending) setStatus("另一个任务的发送还待确认。请回到该任务，刷新记录或恢复发送。", "error");
  else if (data.task.status === "failed") setStatus("上次运行未完成，已保留记录。可以查看原因后继续提问。", "error");
  else setStatus(data.messages?.length ? "对话与执行记录已恢复，可以继续追问。" : "任务已创建，写下第一条要求。", data.messages?.length ? "success" : "idle");
  void taskFiles.refresh();
}
async function withBusy(action) {
  if (state.busy || state.uploadBusy || state.lifecycleBusy) return;
  state.busy = true;
  syncControls();
  try { await action(); }
  catch (error) { setStatus(error instanceof Error ? error.message : "连接失败，请刷新任务记录。", "error"); }
  finally { state.busy = false; syncControls(); }
}

async function changeLifecycle(action) {
  if (action === "end" && state.uploadBusy) return;
  const controls = lifecycleControls(state);
  if (action === "stop" ? !controls.canStop : !controls.canEnd) return;
  const id = state.task.id;
  state.lifecycleBusy = action;
  syncControls();
  setStatus(action === "stop" ? "正在请求停止本轮，等待执行和记录保存。" : "正在结束任务，等待本轮保存并释放运行环境。", "running");
  try {
    const data = await readJson(`/v1/tasks/${encodeURIComponent(id)}/${action === "stop" ? "cancel" : "runtime"}`, { method: action === "stop" ? "POST" : "DELETE" });
    if (data.task?.id !== id) throw new Error("服务器尚未确认任务状态，请刷新记录。");
    upsertTask(data.task);
    state.stopRequested = action === "stop" && data.stopRequested === true && state.task.status === "running";
    if (action === "end" && data.task.status !== "stopped") throw new Error("任务结束尚未确认，请刷新记录。");
    // Keep the send stream and pending request intact until its task_saved.
    // Without a stream (e.g. after reload), read the newly settled history now.
    if (state.task.status !== "running" || !state.busy) {
      await selectTask(id);
      await refreshTaskList();
    }
    const requested = action === "stop" && data.stopRequested === true;
    const text = action === "end" ? "运行环境已释放，历史和文件已保留。"
      : requested ? "停止请求已接收。请等待状态确认；本轮记录会继续保存，任务环境保留。"
        : "本轮已不在运行，记录和任务环境保留，可以继续提问。";
    addRunEntry(action === "end" ? "任务已结束" : requested ? "停止请求已接收" : "本轮已结束", text);
    setStatus(text, requested && state.task.status === "running" ? "running" : "idle");
  } catch (error) {
    const text = error instanceof Error ? error.message : "操作未能确认，请刷新记录。";
    addRunEntry(action === "stop" ? "停止未能确认" : "结束未能确认", text, "error");
    setStatus(text, "error");
  } finally {
    state.lifecycleBusy = null;
    syncControls();
  }
}
async function sendPending() {
  if (state.uploadBusy || !pending || pending.taskId !== state.task?.id) return;
  const request = pending;
  state.assistant = null;
  if (!state.pendingUser?.article.isConnected) state.pendingUser = appendMessage("user", request.message);
  setStatus("正在提交消息，执行进展将实时显示。", "running");
  try {
    const response = await fetch(`/v1/tasks/${encodeURIComponent(request.taskId)}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: request.message, requestId: request.requestId }),
    });
    await consumeSse(response, handleStreamEvent);
    pending = null;
    store(sessionStorage, pendingKey, null);
    elements["message-input"].value = "";
    await selectTask(request.taskId);
    await refreshTaskList();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "连接中断。";
    setStatus(`${detail} 服务器可能仍在执行。请先刷新记录；恢复发送会沿用同一请求编号。`, "error");
    // Keep pending across reloads: a missed response must not start a new run.
  }
}

elements["new-session"].addEventListener("click", () => void withBusy(async () => {
  const requestId = readStored(sessionStorage, creationKey) || `task:${crypto.randomUUID()}`;
  store(sessionStorage, creationKey, requestId);
  const data = await readJson("/v1/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }) });
  store(sessionStorage, creationKey, null);
  await selectTask(data.task.id);
  elements["message-input"].value = "";
}));
elements["refresh-tasks"].addEventListener("click", () => void withBusy(async () => {
  await refreshTaskList();
  if (state.task) await selectTask(state.task.id);
}));
elements["example-button"].addEventListener("click", () => {
  const message = exampleMessages[state.execution?.backend];
  if (!message) { setStatus("请先刷新记录，等待任务文件信息后再填入统计示例。", "error"); return; }
  elements["message-input"].value = message;
  elements["message-input"].focus();
});
elements["recover-message"].addEventListener("click", () => void withBusy(sendPending));
elements["stop-run"].addEventListener("click", () => void changeLifecycle("stop"));
elements["end-task"].addEventListener("click", () => void changeLifecycle("end"));
elements["refresh-files"].addEventListener("click", () => void taskFiles.refresh());
elements["file-input"].addEventListener("change", syncControls);
elements["upload-file"].addEventListener("click", async () => {
  if (!canUploadToTask()) return;
  const file = elements["file-input"].files?.[0];
  if (!file) return;
  const id = state.task.id;
  const selection = taskSelectionVersion;
  const uploaded = await taskFiles.uploadFile(file);
  if (!uploaded || state.task?.id !== id || selection !== taskSelectionVersion) return;
  elements["file-input"].value = "";
  fileGroup = "input";
  renderTaskFiles(taskFiles.state, true);
  await taskFiles.refresh();
});
for (const kind of ["input", "output"]) elements[`${kind}-files`].addEventListener("click", () => {
  fileGroup = kind;
  taskFiles.closePreview();
  renderTaskFiles(taskFiles.state, true);
});
elements["close-file-preview"].addEventListener("click", () => {
  const name = taskFiles.state.preview?.file.name;
  taskFiles.closePreview();
  const button = [...elements["file-list"].querySelectorAll("button")].find((item) => item.textContent === name);
  (button || elements[`${fileGroup}-files`]).focus();
});
elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.busy || state.uploadBusy || state.lifecycleBusy || state.stopRequested || !state.task || state.task.status === "running" || state.task.status === "stopped" || pending) return;
  const message = elements["message-input"].value.trim();
  if (!message || message.length > 120000) { setStatus("请输入 1 到 120000 个字符的任务要求。", "error"); return; }
  pending = { taskId: state.task.id, requestId: `message:${crypto.randomUUID()}`, message };
  store(sessionStorage, pendingKey, pending);
  void withBusy(sendPending);
});

renderMessages([]);
renderTaskFiles(taskFiles.state);
void withBusy(async () => {
  await refreshTaskList();
  const remembered = pending?.taskId || readStored(localStorage, selectedKey);
  const selected = state.tasks.find((task) => task.id === remembered) || state.tasks[0];
  if (selected) await selectTask(selected.id);
  else setStatus("点击“新建设计任务”，开始第一段对话。");
});
