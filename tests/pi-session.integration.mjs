// Requires the installed Pi SDK and project credentials; never calls a model.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createLearningSession, projectRoot } from "../packages/agent-runtime/pi-sdk.mjs";

const agentName = `session-check-${randomUUID()}`;
let first, second;
try {
  first = (await createLearningSession({ agentName, persistSession: true })).session;
  const id = first.sessionId;
  first.sessionManager.appendMessage({ role: "user", content: "offline persistence check", timestamp: Date.now() });
  const sessionFile = first.sessionManager.getSessionFile();
  assert.equal(fs.existsSync(sessionFile), true);
  first.dispose(); first = undefined;
  second = (await createLearningSession({ agentName, persistSession: true, sessionFile })).session;
  assert.equal(second.sessionId, id);
  assert.equal(second.messages.at(-1).role, "user");
  assert.equal(second.messages.at(-1).content, "offline persistence check");
  console.log(JSON.stringify({ verified: true, persistedAndReopened: true, modelCalls: 0 }));
} finally {
  first?.dispose(); second?.dispose();
  const directory = path.join(projectRoot, "runtime", agentName);
  if (fs.existsSync(directory)) {
    assert.equal(path.dirname(directory), path.join(projectRoot, "runtime"));
    assert.equal(fs.realpathSync(directory), directory);
    fs.rmSync(directory, { recursive: true });
  }
}
