// A real, billable MiniMax task followed by one context-resume check.
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { verifyComposeFileTask } from './lib/verify-compose-file-task.mjs';

const root = '/home/hanwen/Project/project/siNRA-pi';
const state = `${root}/runtime/agent-compose`;
const execFile = promisify(execFileCallback);
assert.equal(process.argv.length, 2, 'This check takes no arguments.');
await execFile(process.execPath, [`${root}/scripts/prepare-agent-compose.mjs`]);
const evidence = await mkdtemp(`${state}/model-verify-`);
const save = (name, value) => writeFile(`${evidence}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
async function command(script, args) {
  const { stdout } = await execFile('sh', [`${root}/scripts/${script}`, ...args], {
    cwd: root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}
const compose = async (...args) => JSON.parse(await command('project-agent-compose.sh', args));
const docker = (...args) => command('project-docker.sh', args);
async function finish(run, name) {
  await save(`${name}-accepted`, run);
  const deadline = Date.now() + 480_000;
  let previous;
  while (true) {
    run = await compose('inspect', 'run', run.id);
    // Remember the new sandbox even if bootstrap later fails or times out.
    if (name === 'bootstrap' && /^[a-f0-9]{64}$/.test(run.sandbox_id ?? '')) {
      if (sandboxId) assert.equal(run.sandbox_id, sandboxId);
      sandboxId = run.sandbox_id;
    }
    if (run.status !== previous) console.log(`${name}: ${run.status} (${run.id})`);
    previous = run.status;
    if (!['pending', 'running'].includes(run.status)) break;
    assert.ok(Date.now() < deadline, `${name} exceeded eight minutes.`);
    await delay(3000);
  }
  await save(name, run);
  assert.equal(run.status, 'succeeded', `${name} did not succeed; inspect its private evidence.`);
  assert.equal(run.exit_code, 0);
  assert.ok(!run.error && !run.cleanup_error, 'Run reported an execution/cleanup error.');
  return run;
}
function modelResult(run, sandboxId) {
  const result = JSON.parse(run.result_json);
  assert.equal(result.sandboxId, sandboxId);
  assert.equal(result.agent, 'pi');
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  // PiRunner reports "completed"; the underlying assistant message uses "stop".
  assert.equal(result.stopReason, 'completed');
  assert.equal(typeof result.agentThreadId, 'string');
  assert.ok(result.agentThreadId.length > 0);
  return result;
}

console.log(`Private evidence: ${evidence}`);
const expectedImage = await docker('image', 'inspect', '--format', '{{.Id}}', 'sirna-pi-guest:pi1.2.0');
const project = await compose('up');
await save('project', project);
let sandboxId;
let outputPath;
let originalResult;
let guestId;
let summary;
try {
  const boot = await finish(await compose('run', '--detach', '--keep-running', 'designer', '--command',
    'mkdir -p /workspace/input /workspace/work /workspace/output /workspace/tool-drafts && pi --version && pwd'), 'bootstrap');
  assert.match(boot.sandbox_id, /^[a-f0-9]{64}$/);
  sandboxId = boot.sandbox_id;
  assert.equal(boot.project_id, project.project.id);
  assert.match(boot.output, /(?:^|\n)1\.2\.0(?:\r?\n|$)/);
  assert.ok(boot.output.includes('/workspace'));
  const sandbox = await compose('inspect', 'sandbox', sandboxId);
  await save('sandbox-running', sandbox);
  assert.match(sandbox.workspace_path, new RegExp(`^/data/sandboxes/\\d{4}/\\d{2}/\\d{2}/${sandboxId}/workspace$`));
  const workspace = `${state}${sandbox.workspace_path}`;
  const sandboxRoot = workspace.slice(0, -'/workspace'.length);
  assert.equal(await realpath(workspace), workspace);
  const ids = (await docker('container', 'ls', '--quiet', '--filter', `label=agent-compose.sandbox_id=${sandboxId}`)).split('\n').filter(Boolean);
  assert.equal(ids.length, 1);
  const [guest] = JSON.parse(await docker('container', 'inspect', ids[0]));
  guestId = guest.Id;
  assert.equal(guest.Image, expectedImage);
  assert.ok(!guest.Config.Env.some(e => /^(MINIMAX_CN_API_KEY|AGENT_COMPOSE_AUTH_TOKEN)=/.test(e)));
  for (const mount of guest.Mounts) assert.ok(mount.Source.startsWith(`${sandboxRoot}/`) && !mount.Source.endsWith('.sock'));
  const piMount = guest.Mounts.find(m => m.Destination === '/root/.pi');
  assert.ok(piMount, 'Expected the official persistent Pi directory mount.');
  const facade = JSON.parse(await readFile(`${piMount.Source}/agent/models.json`, 'utf8'));
  const provider = facade.providers['agent-compose'];
  assert.ok(provider.apiKey === '$AGENT_COMPOSE_SANDBOX_TOKEN', 'Pi must use the scoped facade token reference.');
  assert.equal(provider.api, 'anthropic-messages');
  assert.equal(provider.baseUrl, `http://agent-compose:7410/api/runtime/sandboxes/${sandboxId}/llm/anthropic`);
  await save('environment', { imageId: expectedImage, piVersion: '1.2.0', guestContainer: guestId,
    mounts: guest.Mounts, facadeBaseUrl: provider.baseUrl, facadeApi: provider.api, originalKeyMounted: false });

  const csv = 'value\n10\n20\n30\n40\n';
  await writeFile(`${workspace}/input/numbers.csv`, csv, { flag: 'wx', mode: 0o600 });
  outputPath = `${workspace}/output/result.json`;
  const marker = `remember-${randomUUID()}`;
  const prompt = `请完成文件练习：用 read 读取 /workspace/input/numbers.csv，计算 value 列的 count、sum、mean，用 write 将只含这三个数字字段的 JSON 写入 /workspace/output/result.json，再用 read 重新读取该输出核对。只操作 /workspace/input 和 /workspace/output，不调用其他工具。最后简短说明结果。另外请在本轮对话中记住口令 ${marker}，不要将口令写入文件。`;
  const run = await finish(await compose('run', '--detach', '--keep-running', '--sandbox', sandboxId, 'designer', '--prompt', prompt), 'model');
  assert.equal(run.project_id, project.project.id);
  assert.equal(run.sandbox_id, sandboxId);
  const first = modelResult(run, sandboxId);
  const providerRoot = `${sandboxRoot}/state/agents/providers`;
  const providerState = JSON.parse(await readFile(`${providerRoot}/pi.json`, 'utf8'));
  assert.equal(providerState.threadId, first.agentThreadId);
  const sessions = `${providerRoot}/pi/sessions`;
  const matches = [];
  for (const name of await readdir(sessions)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = `${sessions}/${name}`;
    const text = await readFile(path, 'utf8');
    if (JSON.parse(text.split('\n')[0]).id === first.agentThreadId) matches.push({ path, text });
  }
  assert.equal(matches.length, 1, 'Exactly one Pi JSONL must match the returned thread ID.');
  const session = matches[0];
  originalResult = await readFile(outputPath, 'utf8');
  assert.equal(await readFile(`${workspace}/input/numbers.csv`, 'utf8'), csv);
  const verified = verifyComposeFileTask({ sessionJsonl: session.text, csv, resultJson: originalResult });
  await save('file-verification', verified);
  console.log(`File task independently verified: ${JSON.stringify(verified)}`);

  const follow = await finish(await compose('run', '--detach', '--keep-running', '--sandbox', sandboxId, 'designer', '--prompt',
    '上一轮对话中我让你记住的口令是什么？只输出该口令，不要读取文件或调用工具。'), 'resume');
  assert.equal(follow.project_id, project.project.id);
  assert.equal(follow.sandbox_id, sandboxId);
  const second = modelResult(follow, sandboxId);
  assert.equal(second.agentThreadId, first.agentThreadId);
  assert.ok(second.finalText.includes(marker), 'Resumed response must recall the first-turn marker.');
  const resumed = await readFile(session.path, 'utf8');
  assert.ok(resumed.startsWith(session.text), 'Resume must append to the original session, not replace it.');
  const appended = resumed.slice(session.text.length).trim().split('\n').map(line => JSON.parse(line));
  const replies = appended.filter(e => e.type === 'message' && e.message.role === 'assistant');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].message.stopReason, 'stop');
  assert.ok(!appended.some(e => e.type === 'message' && (e.message.role === 'toolResult' || e.message.content?.some?.(c => c.type === 'toolCall'))));
  assert.equal(await readFile(outputPath, 'utf8'), originalResult);
  summary = { passed: true, evidence, projectId: project.project.id, sandboxId, modelRunId: run.id,
    resumeRunId: follow.id, sessionId: first.agentThreadId, sessionPath: session.path, outputPath,
    imageId: expectedImage, fileTask: verified, resumeAssistantResponses: replies.length, resumeToolCalls: 0 };
} finally {
  if (sandboxId) {
    await compose('sandbox', 'stop', '--graceful', sandboxId);
    const stopped = await compose('inspect', 'sandbox', sandboxId);
    await save('sandbox-stopped', stopped);
    assert.equal(stopped.vm_status, 'stopped');
    assert.equal(stopped.stopped_runtime_state, 'released');
    if (guestId) assert.equal(await docker('container', 'ls', '--all', '--quiet', '--filter', `id=${guestId}`), '');
    if (originalResult !== undefined) assert.equal(await readFile(outputPath, 'utf8'), originalResult);
  }
}
await save('result', summary);
console.log(JSON.stringify(summary, null, 2));
