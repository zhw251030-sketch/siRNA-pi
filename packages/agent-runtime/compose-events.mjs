import { createHash } from "node:crypto";

// Independently implemented against Agent Compose v2609.3.0 PiRunner and
// interactive/stream frames. Event names follow the reference project's
// packages/agent-runtime/agent-compose-runtime.ts; no provider reasoning or
// raw RPC frame is forwarded to Task Core.
const failure = () => new Error("Agent Compose 本轮未完成，请检查项目内运行记录。");
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const secretField = /^(?:authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|private[-_]?key)$/i;

function redactText(text) {
  return text
    .replace(/("(?:authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|private[-_]?key)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret)\s*=\s*)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(--(?:api[-_]?key|token|password|passwd|secret)(?:=|\s+))[^\s"']+/gi, "$1[REDACTED]")
    .replace(/([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret)=)[^&\s"']+/gi, "$1[REDACTED]");
}

function redact(value, key = "", depth = 0) {
  if (secretField.test(key)) return "[REDACTED]";
  if (depth >= 12) return "[nested content omitted]";
  if (typeof value === "string") {
    // read results contain JSON in content[].text; parsing only the outer
    // output misses models.json credentials. Preserve each string's type.
    if (/^[\[{\"]/.test(value.trim())) {
      try { return JSON.stringify(redact(JSON.parse(value), "", depth + 1)); }
      catch { /* Prose and fenced JSON still receive recognizable-field redaction. */ }
    }
    return redactText(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => redact(item, "", depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 500)
    .map(([childKey, childValue]) => [childKey, redact(childValue, childKey, depth + 1)]));
}

function safeToolPayload(value, fallback) {
  let parsed = value ?? fallback;
  if (typeof parsed === "string" && /^[\[{]/.test(parsed.trim())) {
    try { parsed = JSON.parse(parsed); } catch { /* A non-JSON tool response remains text. */ }
  }
  try {
    const sanitized = redact(parsed);
    const encoded = JSON.stringify(sanitized);
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (bytes <= 64_000) return sanitized;
    return {
      preview: Buffer.from(encoded, "utf8").subarray(0, 24_000).toString("utf8"),
      truncated: true, bytes, sha256: createHash("sha256").update(encoded).digest("hex"),
    };
  } catch { return fallback; }
}

function parseFrame(raw, type, stopReason) {
  let frame;
  try { frame = JSON.parse(raw); } catch { throw failure(); }
  if (!record(frame) || frame.type !== type || frame.provider !== "pi" ||
      !nonempty(frame.threadId) || !nonempty(frame.finalText) ||
      frame.finalTextSource !== "provider_message" || frame.stopReason !== stopReason) throw failure();
  // Retain only evidence that is needed; transcript/stderr may contain raw data.
  return { threadId: frame.threadId, finalText: frame.finalText.trim() };
}

/** Maps one RPC run without network, filesystem, or model access. */
export function createComposeEventProjector(emit) {
  const steps = new Map();
  const tools = new Map();
  let currentStep;
  let turn;
  let invalid = false;

  function progress(step) {
    const entry = steps.get(step);
    if (!entry || entry.progressSent || entry.stopReason !== "tool_use") return;
    entry.progressSent = true;
    const text = redact(entry.text.trim());
    if (text) emit({ type: "progress_message", text });
  }

  function onAgentEvent(event) {
    if (!record(event)) { invalid = true; return; }
    const payload = record(event.payload) ? event.payload : {};
    const name = event.name ?? payload.kind;
    // Whitelist output events. In particular, never forward reasoning_delta,
    // unknown event fields, or an unverified final answer.
    if (name === "reasoning_delta" || name === "started" || name === "usage") return;
    if (name === "error") {
      if (payload.severity !== "warning") invalid = true;
      return;
    }
    if (!["step_start", "text_delta", "step_end", "tool_call", "tool_result"].includes(name)) return;
    if (turn) { invalid = true; return; }
    const step = Number.isInteger(payload.step) && payload.step >= 0 ? payload.step : currentStep;
    if (name === "step_start") {
      if (step === undefined || steps.has(step)) { invalid = true; return; }
      currentStep = step;
      steps.set(step, { text: "", closed: false, progressSent: false });
      return;
    }
    if (name === "step_end" && payload.scope === "run") return;
    const entry = steps.get(step);
    if (!entry) { invalid = true; return; }
    if (name === "text_delta") {
      const text = typeof payload.text === "string" ? payload.text : event.text;
      if (typeof text !== "string" || entry.closed || entry.text.length + text.length > 1_000_000) {
        invalid = true;
        return;
      }
      entry.text += text;
      return;
    }
    if (name === "step_end") {
      if (entry.closed) { invalid = true; return; }
      entry.closed = true;
      entry.stopReason = payload.stopReason;
      entry.rawStopReason = payload.rawStopReason;
      // PiRunner v2609.3.0 leaves stopReason unset for Pi 1.2's length/aborted.
      // rawStopReason keeps that evidence; never interpret unset as normal.
      if (!["tool_use", "stop"].includes(entry.stopReason)) invalid = true;
      const allowedRaw = entry.stopReason === "stop" ? ["stop", "end_turn"] : ["toolUse", "tool_use"];
      if (entry.rawStopReason !== undefined && !allowedRaw.includes(entry.rawStopReason)) invalid = true;
      return;
    }
    const id = payload.id;
    if (!nonempty(id)) { invalid = true; return; }
    if (name === "tool_call") {
      progress(step);
      if (tools.has(id)) return;
      if (!nonempty(payload.name) || !["pending", "in_progress"].includes(payload.status) ||
          entry.stopReason !== "tool_use") { invalid = true; return; }
      tools.set(id, { name: payload.name, step, completed: false, isError: false });
      emit({ type: "tool_start", toolCallId: id, toolName: payload.name,
        args: safeToolPayload(payload.input, {}) });
      return;
    }
    const tool = tools.get(id);
    if (!tool || tool.step !== step || typeof payload.ok !== "boolean") { invalid = true; return; }
    if (tool.completed) return;
    tool.completed = true;
    tool.isError = !payload.ok;
    emit({ type: "tool_end", toolCallId: id, toolName: tool.name,
      result: safeToolPayload(payload.output, { completed: true }), isError: tool.isError });
  }

  function onTurnCompleted(raw) {
    if (turn) { invalid = true; throw failure(); }
    turn = parseFrame(raw, "agent_turn_completed", "completed");
    for (const step of steps.keys()) progress(step);
  }

  function finish(snapshot) {
    if (!record(snapshot) || snapshot.status !== "succeeded" || snapshot.error || snapshot.cleanupError ||
        invalid || !turn || !steps.size) throw failure();
    const result = parseFrame(snapshot.resultJson, "result", "eof");
    const finalStep = steps.get(currentStep);
    if (result.threadId !== turn.threadId || result.finalText !== turn.finalText ||
        [...steps.values()].some((entry) => !entry.closed) ||
        finalStep?.stopReason !== "stop" || !nonempty(finalStep.text) ||
        finalStep.text.trim() !== turn.finalText ||
        [...tools.values()].some((tool) => !tool.completed)) throw failure();
    return {
      answer: redact(turn.finalText), piSessionId: turn.threadId,
      toolCalls: tools.size, toolResults: [...tools.values()].filter((tool) => tool.completed).length,
      failedTools: [...tools.values()].filter((tool) => tool.isError).length, modelResponses: steps.size,
    };
  }

  return { onAgentEvent, onTurnCompleted, finish };
}
