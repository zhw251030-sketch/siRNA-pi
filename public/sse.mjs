// Consume the reference project's JSON-over-SSE contract. `done` ends a
// model run, while subsequent message_saved/task_saved confirm persistence.
export async function consumeSse(response, onEvent) {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.error === "string" ? body.error : `请求失败（HTTP ${response.status}）。`);
  }
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    throw new Error("服务器没有返回预期的执行事件。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "";
  let previousWasCR = false;
  let data = [];
  let completed = false;

  function consumeLine() {
    if (line === "" && data.length) {
      let event;
      try { event = JSON.parse(data.join("\n")); }
      catch { throw new Error("执行事件不完整，请刷新任务记录。"); }
      if (!event || typeof event.type !== "string") throw new Error("执行事件格式不正确。");
      if (event.type === "task_saved") completed = true;
      onEvent(event);
      data = [];
    } else if (line === "data" || line.startsWith("data:")) {
      let value = line.slice(5);
      if (value.startsWith(" ")) value = value.slice(1);
      data.push(value);
    }
    // Comments and unrelated SSE fields are ignored.
    line = "";
  }

  function consumeText(text) {
    for (const character of text) {
      if (character === "\n" && previousWasCR) {
        previousWasCR = false;
        continue;
      }
      previousWasCR = character === "\r";
      if (character === "\n" || character === "\r") consumeLine();
      else line += character;
    }
  }

  try {
    for (;;) {
      const { value, done } = await reader.read();
      consumeText(decoder.decode(value, { stream: !done }));
      if (done) break;
    }
    if (data.length || line.startsWith("data:")) throw new Error("执行事件在传输中断开，请刷新任务记录。");
    if (!completed) throw new Error("尚未收到完整的保存确认，请刷新任务记录。");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
