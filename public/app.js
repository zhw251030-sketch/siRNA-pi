import { consumeSse } from "./sse.mjs";

const elements = Object.fromEntries([
  "new-session", "refresh-tasks", "task-list", "chat-panel", "chat-title", "task-status",
  "messages", "composer", "message-input", "send-button", "example-button", "recover-message",
  "tool-activity", "run-log", "task-id", "task-workspace", "task-event-log", "composer-help",
].map((id) => [id, document.getElementById(id)]));
const exampleMessages = {
  "local-pi": "请使用 read 工具读取当前目录的 numbers.csv，计算其中数值的数量 count、总和 sum 和平均值 mean。使用 write 工具将结果保存为当前目录的 result.json，内容只包含 count、sum、mean 三个字段。最后再次使用 read 工具读取 result.json，核对保存的结果，并用中文简要说明。",
  "agent-compose": "请使用 read 工具读取 /workspace/input/numbers.csv，计算其中数值的数量 count、总和 sum 和平均值 mean。使用 write 工具将结果保存为 /workspace/output/result.json，内容只包含 count、sum、mean 三个字段。最后再次使用 read 工具读取 /workspace/output/result.json，核对保存的结果，并用中文简要说明。",
};
const state = { tasks: [], task: null, execution: null, busy: false, messages: new Map(), tools: new Map(), assistant: null, pendingUser: null };
const pendingKey = "sirna-pi.pending-message";
const selectedKey = "sirna-pi.selected-task";
const creationKey = "sirna-pi.pending-creation";

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
function setStatus(text, kind = "idle") {
  elements["task-status"].textContent = text;
  elements["task-status"].dataset.state = kind;
}
function statusLabel(status) {
  return { idle: "可继续", running: "运行中", failed: "运行失败", stopped: "已结束", pending: "等待中", succeeded: "已完成", canceled: "已中断", cancelled: "已中断" }[status] || "等待中";
}
function syncControls() {
  const recovering = Boolean(pending && pending.taskId === state.task?.id);
  const blocked = state.busy || state.task?.status === "running" || state.task?.status === "stopped" || Boolean(pending) || !state.task;
  elements["send-button"].disabled = blocked;
  elements["example-button"].disabled = blocked || !exampleMessages[state.execution?.backend];
  elements["message-input"].disabled = !state.task;
  elements["message-input"].readOnly = blocked;
  elements["new-session"].disabled = state.busy;
  elements["refresh-tasks"].disabled = state.busy;
  elements["recover-message"].hidden = !recovering || state.task?.status === "running";
  elements["recover-message"].disabled = state.busy;
  elements["send-button"].textContent = state.busy && state.task ? "处理中…" : "发送 ↑";
  elements["chat-panel"].setAttribute("aria-busy", String(state.busy || state.task?.status === "running"));
  for (const button of elements["task-list"].querySelectorAll("button")) button.disabled = state.busy;
}
function upsertTask(task) {
  if (!task?.id) return;
  const index = state.tasks.findIndex((item) => item.id === task.id);
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
    button.disabled = state.busy;
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
  const execution = state.execution;
  const known = Boolean(exampleMessages[execution?.backend]);
  const waiting = execution?.unavailable ? "暂时无法读取，请刷新记录" : "等待任务文件信息";
  elements["chat-title"].textContent = task?.title || "选择或创建一个任务";
  elements["task-id"].textContent = task?.id || "尚未创建";
  elements["task-workspace"].textContent = execution?.workspacePath || (known ? "任务开始后生成" : waiting);
  elements["task-event-log"].textContent = execution?.eventLogPath || (known ? "尚未运行" : waiting);
  elements["composer-help"].textContent = known
    ? "当前练习可以读取、写入本任务目录中的文件。"
    : task ? "正在等待任务文件信息；请刷新记录后再填入统计示例。" : "选择或创建任务后，可以填入统计示例。";
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
    welcome.append(node("span", "welcome-mark", "↗"), node("h2", "", "先做一个能检查结果的小任务"), node("p", "help", state.task ? "点击下方“填入统计示例”，观察 Pi 如何读取文件并保存结果。完成后可以在这里继续追问。" : "点击“新建设计任务”，建立一段独立的对话。"));
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
    const key = `${event.runId || state.task?.currentRunId || ""}:${event.toolCallId}`;
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
      tool = { article, label, path };
      state.tools.set(key, tool);
    }
    tool.article.dataset.state = event.type === "tool_start" ? "running" : event.isError ? "error" : "success";
    tool.label.textContent = event.type === "tool_start" ? "执行中" : event.isError ? "失败" : "完成";
    if (typeof event.args?.path === "string") tool.path.textContent = event.args.path;
  } else if (event.type === "progress_message") addRunEntry("执行说明", event.text || "");
  else if (event.type === "run_status") addRunEntry("运行状态", statusLabel(event.status), event.status === "failed" ? "error" : "");
  else if (event.type === "done") addRunEntry("本次执行结束", statusLabel(event.status), event.status === "failed" ? "error" : "");
  else if (event.type === "error") addRunEntry("执行失败", event.error || "任务未能完成。", "error");
}
function handleStreamEvent(event) {
  if (event.taskId && event.taskId !== state.task?.id) return;
  if (event.type === "task" || event.type === "task_saved") {
    upsertTask(event.task);
    if (event.message) saveMessage(event.message, state.pendingUser);
  } else if (event.type === "session") {
    state.execution = exampleMessages[event.backend] ? {
      backend: event.backend,
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
  showActivity(event);
}
async function readJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "暂时无法读取任务，请稍后刷新。");
  return body;
}
async function refreshTaskList() {
  const data = await readJson("/v1/tasks");
  state.tasks = data.tasks || [];
  renderTaskList();
}
async function selectTask(id) {
  const data = await readJson(`/v1/tasks/${encodeURIComponent(id)}/messages`);
  state.task = data.task;
  state.execution = data.execution ?? null;
  store(localStorage, selectedKey, id);
  upsertTask(data.task);
  renderMessages(data.messages || []);
  resetActivity();
  for (const record of (data.runEvents || []).slice(-120)) showActivity({ ...(record.payload || record), runId: record.runId || record.payload?.runId });
  // Recover accepted messages from server state; otherwise keep the same ID.
  if (pending?.taskId === id && data.task.status !== "running" && data.messages?.some((message) => message.clientRequestId === pending.requestId)) {
    pending = null;
    store(sessionStorage, pendingKey, null);
  }
  if (data.task.status === "running") setStatus("任务仍在运行。点击“刷新记录”查看新的执行进展。", "running");
  else if (pending?.taskId === id) setStatus("上次连接中断。可恢复本次发送，系统会核对已有记录，避免重复执行。", "error");
  else if (pending) setStatus("另一个任务的发送还待确认。请回到该任务，刷新记录或恢复发送。", "error");
  else if (data.task.status === "failed") setStatus("上次运行未完成，已保留记录。可以查看原因后继续提问。", "error");
  else setStatus(data.messages?.length ? "对话与执行记录已恢复，可以继续追问。" : "任务已创建，写下第一条要求。", data.messages?.length ? "success" : "idle");
}
async function withBusy(action) {
  if (state.busy) return;
  state.busy = true;
  syncControls();
  try { await action(); }
  catch (error) { setStatus(error instanceof Error ? error.message : "连接失败，请刷新任务记录。", "error"); }
  finally { state.busy = false; syncControls(); }
}
async function sendPending() {
  if (!pending || pending.taskId !== state.task?.id) return;
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
elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.busy || !state.task || state.task.status === "running" || state.task.status === "stopped" || pending) return;
  const message = elements["message-input"].value.trim();
  if (!message || message.length > 120000) { setStatus("请输入 1 到 120000 个字符的任务要求。", "error"); return; }
  pending = { taskId: state.task.id, requestId: `message:${crypto.randomUUID()}`, message };
  store(sessionStorage, pendingKey, pending);
  void withBusy(sendPending);
});

renderMessages([]);
void withBusy(async () => {
  await refreshTaskList();
  const remembered = pending?.taskId || readStored(localStorage, selectedKey);
  const selected = state.tasks.find((task) => task.id === remembered) || state.tasks[0];
  if (selected) await selectTask(selected.id);
  else setStatus("点击“新建设计任务”，开始第一段对话。");
});
