import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const executionId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const sandboxIdPattern = /^[a-f0-9]{64}$/;

export function ensureDirectory(root, relative) {
  let current = root;
  if (fs.realpathSync(root) !== root) throw new Error('Project root must be a real directory');
  for (const part of relative.split(/[\\/]/).filter(Boolean)) {
    if (part === '..' || part.includes(':')) throw new Error('Invalid project directory');
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    if (fs.realpathSync(current) !== current || !fs.statSync(current).isDirectory()) throw new Error('Invalid project directory');
  }
  return current;
}

export class ComposeSessionStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.directory = ensureDirectory(this.root, 'runtime/compose-sessions');
    ensureDirectory(this.root, 'runtime/compose-web');
  }
  file(id) {
    if (!executionId.test(id)) throw new Error('Invalid execution session ID');
    return path.join(this.directory, `${id}.json`);
  }
  has(id) { return fs.existsSync(this.file(id)); }
  load(id) {
    const file = this.file(id);
    if (fs.realpathSync(file) !== file) throw new Error('Invalid session record path');
    const session = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (session.id !== id || session.backend !== 'agent-compose' || !Array.isArray(session.runs)) throw new Error('Invalid session record');
    return session;
  }
  save(session) {
    const file = this.file(session.id);
    if (fs.existsSync(file) && fs.realpathSync(file) !== file) throw new Error('Invalid session record path');
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(session, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  workspace(sandbox) {
    const id = sandbox.sandbox_id;
    if (!sandboxIdPattern.test(id) || sandbox.driver !== 'docker' ||
        !new RegExp(`^/data/sandboxes/\\d{4}/\\d{2}/\\d{2}/${id}/workspace$`).test(sandbox.workspace_path)) throw new Error('Invalid sandbox workspace');
    const relative = `runtime/agent-compose${sandbox.workspace_path}`;
    const absolute = path.join(this.root, relative);
    if (fs.realpathSync(absolute) !== absolute) throw new Error('Invalid sandbox workspace');
    return relative;
  }
  assertConversation(session) {
    if (!session.piSessionId) return;
    const provider = path.join(this.root, session.workspacePath, '../state/agents/providers');
    const stateFile = path.join(provider, 'pi.json');
    if (fs.realpathSync(stateFile) !== stateFile) throw new Error('Invalid Pi state path');
    if (JSON.parse(fs.readFileSync(stateFile, 'utf8')).threadId !== session.piSessionId) throw new Error('Pi context changed unexpectedly');
    const directory = path.join(provider, 'pi/sessions');
    if (fs.realpathSync(directory) !== directory) throw new Error('Invalid Pi session path');
    const matches = fs.readdirSync(directory).filter(name => {
      if (!name.endsWith('.jsonl')) return false;
      const file = path.join(directory, name);
      if (fs.realpathSync(file) !== file) throw new Error('Invalid Pi session file');
      return JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).id === session.piSessionId;
    });
    if (matches.length !== 1) throw new Error('Saved Pi conversation is missing or ambiguous');
  }
  recoverConversation(session) {
    if (session.piSessionId || !session.runs.some(run => run.accepted)) return;
    const file = path.join(this.root, session.workspacePath, '../state/agents/providers/pi.json');
    if (fs.realpathSync(file) !== file) throw new Error('Cannot confirm prior Pi conversation');
    const threadId = JSON.parse(fs.readFileSync(file, 'utf8')).threadId;
    if (typeof threadId !== 'string' || !threadId) throw new Error('Cannot confirm prior Pi conversation');
    this.assertConversation({ ...session, piSessionId: threadId });
    session.piSessionId = threadId;
    this.save(session);
  }
}
