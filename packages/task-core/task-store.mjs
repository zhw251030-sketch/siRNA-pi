import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Learning implementation of the reference task/message/event boundaries.
// Reference: sirna-pi-agent-service-refactor, 965c53f, packages/task-core/task-store.ts.
const taskSelect = `SELECT t.*,
  (SELECT COUNT(*) FROM chat_messages m WHERE m.task_id = t.id) AS message_count
  FROM design_tasks t`;
const timestamp = () => new Date().toISOString();
const optional = (name, value) => value == null ? {} : { [name]: value };

function taskRecord(row) {
  if (!row) return undefined;
  return {
    id: row.id, title: row.title, status: row.status,
    executionSessionId: row.execution_session_id,
    ...optional("creationRequestId", row.creation_request_id),
    ...optional("piSessionId", row.pi_session_id),
    ...optional("currentRunId", row.current_run_id),
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...optional("lastMessageAt", row.last_message_at),
    messageCount: Number(row.message_count),
  };
}

function messageRecord(row) {
  if (!row) return undefined;
  return {
    id: row.id, taskId: row.task_id, role: row.role, content: row.content,
    status: row.status, sequence: Number(row.sequence), createdAt: row.created_at,
    ...optional("clientRequestId", row.client_request_id),
  };
}

export class TaskStore {
  #db;

  constructor(dbPath) {
    this.databasePath = resolve(dbPath);
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(this.databasePath);
    this.#db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS design_tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed', 'stopped')),
        execution_session_id TEXT NOT NULL, creation_request_id TEXT UNIQUE,
        pi_session_id TEXT, current_run_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_message_at TEXT
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES design_tasks(id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('complete', 'failed')),
        sequence INTEGER NOT NULL, created_at TEXT NOT NULL, client_request_id TEXT,
        UNIQUE(task_id, sequence), UNIQUE(task_id, client_request_id), UNIQUE(task_id, id)
      );
      CREATE TABLE IF NOT EXISTS chat_run_events (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES design_tasks(id),
        user_message_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('progress_message', 'tool_start', 'tool_end', 'run_status', 'done', 'error')),
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(task_id, user_message_id) REFERENCES chat_messages(task_id, id),
        UNIQUE(task_id, run_id, sequence)
      );`);
  }

  close() { this.#db.close(); }

  listTasks() {
    return this.#db.prepare(`${taskSelect} ORDER BY t.updated_at DESC, t.id DESC`).all().map(taskRecord);
  }

  getTask(id) { return taskRecord(this.#db.prepare(`${taskSelect} WHERE t.id = ?`).get(id)); }

  getTaskByCreationRequestId(id) {
    return taskRecord(this.#db.prepare(`${taskSelect} WHERE t.creation_request_id = ?`).get(id));
  }

  createTask(session, creationRequestId) {
    const id = randomUUID();
    const now = timestamp();
    this.#db.prepare(`INSERT INTO design_tasks
      (id, title, status, execution_session_id, creation_request_id, pi_session_id, created_at, updated_at)
      VALUES (?, '新的设计任务', 'idle', ?, ?, ?, ?, ?)`)
      .run(id, session.id, creationRequestId ?? null, session.piSessionId ?? null, now, now);
    return this.getTask(id);
  }

  listMessages(taskId) {
    return this.#db.prepare("SELECT * FROM chat_messages WHERE task_id = ? ORDER BY sequence")
      .all(taskId).map(messageRecord);
  }

  getMessageByClientRequestId(taskId, requestId) {
    return messageRecord(this.#db.prepare("SELECT * FROM chat_messages WHERE task_id = ? AND client_request_id = ?")
      .get(taskId, requestId));
  }

  listRunEvents(taskId) {
    return this.#db.prepare(`SELECT e.* FROM chat_run_events e
      JOIN chat_messages m ON m.task_id = e.task_id AND m.id = e.user_message_id
      WHERE e.task_id = ? ORDER BY m.sequence, e.sequence`).all(taskId).map((row) => ({
      id: row.id, taskId: row.task_id, userMessageId: row.user_message_id, runId: row.run_id,
      sequence: Number(row.sequence), type: row.type, payload: JSON.parse(row.payload_json), createdAt: row.created_at,
    }));
  }

  #transaction(operation) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #insertMessage(taskId, role, content, status, clientRequestId) {
    const id = randomUUID();
    const now = timestamp();
    const sequence = Number(this.#db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM chat_messages WHERE task_id = ?").get(taskId).n);
    this.#db.prepare(`INSERT INTO chat_messages (id, task_id, role, content, status, sequence, created_at, client_request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, role, content, status, sequence, now, clientRequestId ?? null);
    this.#db.prepare("UPDATE design_tasks SET updated_at = ?, last_message_at = ? WHERE id = ?").run(now, now, taskId);
    return { id, taskId, role, content, status, sequence, createdAt: now, ...optional("clientRequestId", clientRequestId) };
  }

  beginTurn(taskId, content, requestId) {
    return this.#transaction(() => {
      const task = this.getTask(taskId);
      if (!task || task.status === "running" || task.status === "stopped") throw new Error("Task cannot begin a turn");
      const message = this.#insertMessage(taskId, "user", content.trim(), "complete", requestId);
      const title = task.messageCount === 0 ? content.replace(/\s+/g, " ").trim() : task.title;
      this.#db.prepare("UPDATE design_tasks SET title = ?, status = 'running', current_run_id = NULL WHERE id = ?")
        .run(title.length > 48 ? `${title.slice(0, 48)}...` : title, taskId);
      return { task: this.getTask(taskId), message };
    });
  }

  updateExecution(taskId, changes) {
    const columns = { executionSessionId: "execution_session_id", piSessionId: "pi_session_id", currentRunId: "current_run_id", status: "status" };
    const entries = Object.entries(columns).filter(([key]) => changes[key] !== undefined);
    if (entries.length) {
      this.#db.prepare(`UPDATE design_tasks SET ${entries.map(([, column]) => `${column} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .run(...entries.map(([key]) => changes[key]), timestamp(), taskId);
    }
    return this.getTask(taskId);
  }

  appendAssistantMessage(taskId, content, status) {
    return this.#transaction(() => {
      const message = this.#insertMessage(taskId, "assistant", content.trim(), status);
      this.#db.prepare("UPDATE design_tasks SET status = ? WHERE id = ?").run(status === "failed" ? "failed" : "idle", taskId);
      return message;
    });
  }

  #insertRunEvent(taskId, userMessageId, runId, type, payload) {
    const id = randomUUID();
    const now = timestamp();
    const sequence = Number(this.#db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM chat_run_events WHERE task_id = ? AND run_id = ?").get(taskId, runId).n);
    this.#db.prepare(`INSERT INTO chat_run_events (id, task_id, user_message_id, run_id, sequence, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, userMessageId, runId, sequence, type, JSON.stringify(payload), now);
    return { id, taskId, userMessageId, runId, sequence, type, payload, createdAt: now };
  }

  appendRunEvent(taskId, userMessageId, runId, type, payload) {
    return this.#transaction(() => this.#insertRunEvent(taskId, userMessageId, runId, type, payload));
  }

  recoverInterruptedTasks() {
    const interrupted = this.listTasks().filter((task) => task.status === "running");
    for (const task of interrupted) {
      this.#transaction(() => {
        const userMessage = this.listMessages(task.id).findLast((message) => message.role === "user");
        const error = "服务重启，上一轮运行已中断；可以重新发送要求。";
        const runId = task.currentRunId ?? randomUUID();
        if (userMessage) {
          this.#insertRunEvent(task.id, userMessage.id, runId, "error", { type: "error", error, runId });
          this.#insertRunEvent(task.id, userMessage.id, runId, "done", { type: "done", status: "failed", runId });
        }
        this.#insertMessage(task.id, "assistant", error, "failed");
        this.#db.prepare("UPDATE design_tasks SET status = 'failed', current_run_id = ? WHERE id = ?").run(runId, task.id);
      });
    }
    return interrupted.map((task) => this.getTask(task.id));
  }
}
