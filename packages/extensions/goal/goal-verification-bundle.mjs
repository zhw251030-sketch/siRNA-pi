import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const BUNDLE_PROTOCOL = 'sirna-goal-verification-bundle/v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sensitive = /^(?:authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret)$/i;
const binaryExtensions = new Set(['7z','avi','bmp','doc','docx','gif','gz','jpeg','jpg','mov','mp3','mp4','pdf','png','ppt','pptx','tar','tif','tiff','webp','xls','xlsx','zip']);

function canonical(value) {
  if (value === undefined) return 'null';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function valueHash(value) { return sha256(canonical(value ?? null)); }
function textHash(value) { return sha256(Buffer.from(value, 'utf8')); }
function safeText(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function safePath(root, relative) {
  const base = path.resolve(root), target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error('verification snapshot path escaped its root');
  return target;
}
function preview(value, key = '', depth = 0) {
  if (sensitive.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"']+/giu, '$1[REDACTED]');
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 10) return '[nested content omitted]';
  if (Array.isArray(value)) return value.slice(0, 200).map(item => preview(item, '', depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 200).map(([childKey, item]) => [childKey, preview(item, childKey, depth + 1)]));
}
function payloadString(payload, key) { return safeText(payload?.[key]); }
function resultHash(result) {
  if (result && typeof result === 'object' && !Array.isArray(result) && result.truncated === true && typeof result.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(result.sha256)) return result.sha256.toLowerCase();
  return valueHash(result ?? null);
}
function encoding(name, data) {
  const extension = name.toLowerCase().split('.').at(-1) ?? '';
  if (binaryExtensions.has(extension) || data.includes(0)) return 'binary';
  try { new TextDecoder('utf-8', {fatal: true}).decode(data); return 'utf8'; } catch { return 'binary'; }
}
function qualityFlags(data, kind, format) {
  if (kind !== 'output' || format !== 'utf8') return [];
  const text = data.toString('utf8');
  return /(?:verifier\s*(?:must|should|required|instruction|read)|给\s*verifier|verifier\s*(?:必读|指南)|强制指令[^\n]{0,80}verifier|_verifier_directive|verified_quote|fact-q(?:-?\d+)?|artifact_read\s*(?:引用|evidence)|json pointer[^\n]{0,80}(?:verifier|验收))/iu.test(text)
    ? ['embedded_verifier_instructions'] : [];
}
export function extractGoalAcceptanceCriteria(objective) {
  const normalized = String(objective ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const segments = normalized.replace(/(?:^|\n)\s*(?:[-*]|\d+[.)、])\s*/g, '\n')
    .split(/(?:\n+|[。！？!?；;]+|\s+(?:另外|此外|同时|最终|并且还要|然后还要)\s*)/u)
    .map(item => item.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const unique = [...new Set(segments.length ? segments : [normalized])];
  return unique.map((text, index) => {
    const requiredEvidence = [];
    if (/(?:论文|文献|来源|引用|doi|pmid|事实|实验|数据|研究(?:表明|显示|发现)|paper|literature|stud(?:y|ies)|source|citation|reference|experiment|data)/iu.test(text)) requiredEvidence.push('external');
    if (/(?:运行|执行|测试|计算|验证|基准|run|execute|test|calculate|compute|benchmark)/iu.test(text)) requiredEvidence.push('execution');
    if (/(?:报告|文件|表格|清单|产物|图像|图片|report|file|table|artifact|image)/iu.test(text)) requiredEvidence.push('artifact');
    if (!requiredEvidence.length) requiredEvidence.push('independent');
    const sourceCount = requiredEvidence.includes('external')
      ? text.match(/(?:至少\s*)?(\d{1,3})\s*(?:篇|个|条|papers?|stud(?:y|ies)|references?|sources?)/iu)?.[1]
      : undefined;
    const minimumExternalSources = sourceCount ? Math.min(200, Number(sourceCount)) : undefined;
    return {id: `criterion-${index + 1}`, text, requiredEvidence,
      ...(minimumExternalSources ? {minimumExternalSources} : {})};
  });
}

export class GoalVerificationBundleBuilder {
  constructor(tasks, {workspaceFiles, snapshotRoot, now = () => new Date()} = {}) {
    if (!tasks || typeof tasks.listMessages !== 'function' || typeof tasks.listRunEvents !== 'function') throw new TypeError('GoalVerificationBundleBuilder requires a TaskStore');
    if (!workspaceFiles || typeof workspaceFiles.list !== 'function' || typeof workspaceFiles.read !== 'function') throw new TypeError('GoalVerificationBundleBuilder requires workspaceFiles');
    this.tasks = tasks;
    this.workspaceFiles = workspaceFiles;
    this.snapshotRoot = path.resolve(snapshotRoot ?? path.join(process.cwd(), 'runtime', 'goal-verifications'));
    this.now = now;
  }

  async build(verificationId, goal, trigger = 'completion_request') {
    if (!uuid.test(verificationId)) throw new Error('verification id must be a UUID');
    if (trigger === 'completion_request' && goal?.status !== 'verifying') throw new Error('completion verification requires a Goal in verifying state');
    const messages = this.tasks.listMessages(goal.taskId).map(message => ({
      id: message.id, role: message.role, sequence: message.sequence, content: message.content,
      status: message.status, createdAt: message.createdAt, sha256: textHash(message.content),
    }));
    const events = this.tasks.listRunEvents(goal.taskId);
    const starts = new Map();
    for (const event of events) {
      if (event.type === 'tool_start') {
        const callId = payloadString(event.payload, 'toolCallId');
        if (callId) starts.set(callId, event.payload.args ?? null);
      }
    }
    const toolReceipts = events.filter(event => event.type === 'tool_end').map(event => {
      const payload = event.payload ?? {}, callId = payloadString(payload, 'toolCallId'), result = payload.result ?? null;
      return {
        eventId: event.id, runId: event.runId, userMessageId: event.userMessageId,
        ...(callId ? {toolCallId: callId} : {}), toolName: payloadString(payload, 'toolName') ?? 'unknown_tool',
        isError: payload.isError === true,
        ...(callId && starts.has(callId) ? {inputSha256: valueHash(starts.get(callId))} : {}),
        resultSha256: resultHash(result), resultPreview: preview(result), createdAt: event.createdAt,
      };
    });
    const task = typeof this.tasks.getTask === 'function' ? this.tasks.getTask(goal.taskId) : {id: goal.taskId, status: 'stopped'};
    if (!task) throw new Error('Goal verification task was not found');
    const listing = await this.workspaceFiles.list(task);
    if (listing.state === 'unsupported') throw new Error('Goal verification workspace is unsupported');
    const artifacts = [];
    const snapshotDirectory = safePath(this.snapshotRoot, verificationId);
    for (const file of listing.files ?? []) {
      const snapshot = await this.workspaceFiles.read(task, file.kind, file.name);
      if (!snapshot?.data || snapshot.file?.sha256 !== file.sha256 || snapshot.file?.size !== file.size) throw new Error(`workspace artifact changed while freezing verification bundle: ${file.id}`);
      const relative = `artifacts/${file.kind}/${file.name}`;
      const destination = safePath(snapshotDirectory, relative);
      await mkdir(path.dirname(destination), {recursive: true});
      await writeFile(destination, snapshot.data, {flag: 'wx', mode: 0o400});
      const format = encoding(file.name, snapshot.data);
      const flags = qualityFlags(snapshot.data, file.kind, format);
      artifacts.push({id: file.id, name: file.name, kind: file.kind, size: file.size, sha256: file.sha256, modifiedAt: file.modifiedAt,
        snapshotPath: relative, encoding: format, ...(flags.length ? {qualityFlags: flags} : {})});
    }
    const unsigned = {protocolVersion: BUNDLE_PROTOCOL, verificationId, trigger, taskId: goal.taskId, goalId: goal.goalId,
      goalRevision: goal.revision, objective: goal.objective, acceptanceCriteria: extractGoalAcceptanceCriteria(goal.objective),
      requestedAt: this.now().toISOString(), messages, artifacts, toolReceipts};
    const bundle = {...unsigned, bundleSha256: sha256(canonical(unsigned))};
    await mkdir(snapshotDirectory, {recursive: true});
    await writeFile(safePath(snapshotDirectory, 'bundle.json'), `${canonical(bundle)}\n`, {flag: 'wx', encoding: 'utf8', mode: 0o400});
    return bundle;
  }

  async readArtifact(bundle, artifactId) {
    const artifact = bundle?.artifacts?.find(item => item.id === artifactId);
    if (!artifact) throw new Error('verification artifact was not found in the immutable bundle');
    const data = await readFile(safePath(path.join(this.snapshotRoot, bundle.verificationId), artifact.snapshotPath));
    if (data.length !== artifact.size || sha256(data) !== artifact.sha256) throw new Error('verification artifact no longer matches its immutable bundle digest');
    return data;
  }
}

export {BUNDLE_PROTOCOL as GOAL_VERIFICATION_BUNDLE_PROTOCOL};