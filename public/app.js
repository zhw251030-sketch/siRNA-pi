const form = document.querySelector("#task-form");
const messageInput = document.querySelector("#message");
const exampleButton = document.querySelector("#example-button");
const submitButton = document.querySelector("#submit-button");
const status = document.querySelector("#task-status");
const resultPanel = document.querySelector("#result-panel");
const emptyState = document.querySelector("#empty-state");
const taskResult = document.querySelector("#task-result");
let running = false;

const exampleMessage = "请使用 read 工具读取当前目录的 numbers.csv，计算其中数值的数量 count、总和 sum 和平均值 mean。使用 write 工具将结果保存为当前目录的 result.json，内容只包含 count、sum、mean 三个字段。最后再次使用 read 工具读取 result.json，核对保存的结果，并用中文简要说明。";

function setStatus(message, state) {
  status.textContent = message;
  status.dataset.state = state;
}

function setRunning(value) {
  running = value;
  submitButton.disabled = value;
  exampleButton.disabled = value;
  messageInput.readOnly = value;
  submitButton.textContent = value ? "正在运行…" : "发送任务 →";
  resultPanel.setAttribute("aria-busy", String(value));
}

exampleButton.addEventListener("click", () => {
  messageInput.value = exampleMessage;
  messageInput.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (running) return;

  const message = messageInput.value.trim();
  if (!message || message.length > 4000) {
    setStatus("请输入 1 到 4000 个字符的任务要求。", "error");
    messageInput.focus();
    return;
  }

  setRunning(true);
  taskResult.hidden = true;
  emptyState.hidden = true;
  setStatus("Pi 正在处理任务，完成后会显示结果。请保留此页面并等待。", "running");

  try {
    const response = await fetch("/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await response.json();

    if (!response.ok) {
      const explanation = typeof data.error === "string" ? data.error : "服务器暂时无法完成任务，请稍后重试。";
      setStatus(explanation, "error");
      return;
    }
    if (typeof data.answer !== "string" || typeof data.taskId !== "string") {
      throw new Error("Incomplete task response");
    }

    // Treat model output and paths as text, so they cannot become page markup.
    document.querySelector("#answer").textContent = data.answer || "任务已结束，没有返回文字回答。";
    document.querySelector("#task-id").textContent = data.taskId;
    document.querySelector("#task-workspace").textContent = data.workspace;
    document.querySelector("#task-event-log").textContent = data.eventLog;
    document.querySelector("#task-counts").textContent = `${data.modelResponses} 次模型响应，${data.toolCalls} 次工具调用`;
    taskResult.hidden = false;
    setStatus("任务已完成。可以查看回答，并核对服务器上的结果文件。", "success");
  } catch {
    setStatus("没有收到完整结果，请检查连接后再试。如果任务已经提交，服务器可能仍在运行。", "error");
  } finally {
    setRunning(false);
  }
});
