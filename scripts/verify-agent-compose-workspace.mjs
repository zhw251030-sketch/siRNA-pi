// Real integration check: create a command-only guest, inspect it, then stop it.
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = '/home/hanwen/Project/project/siNRA-pi';
const state = `${root}/runtime/agent-compose`;
assert.equal(process.argv.length, 2, 'This check takes no arguments.');
await execFile(process.execPath, [`${root}/scripts/prepare-agent-compose.mjs`]);
const evidence = await mkdtemp(`${state}/verify-`);
const save = (name, value) => writeFile(`${evidence}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
async function command(script, args) {
  const { stdout } = await execFile('sh', [`${root}/scripts/${script}`, ...args], {
    cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}
const compose = async (...args) => JSON.parse(await command('project-agent-compose.sh', args));
const docker = (...args) => command('project-docker.sh', args);

console.log(`Evidence: ${evidence}`);
const unauthenticated = await fetch('http://127.0.0.1:7410/api/version', { signal: AbortSignal.timeout(5000) });
assert.equal(unauthenticated.status, 401, 'The management HTTP API must reject missing credentials.');
await unauthenticated.body?.cancel();
await compose('status');
// Fail before creating a run if the large guest image has not been downloaded.
const guestImage = 'sirna-pi-guest:pi1.2.0';
const expectedGuestId = await docker('image', 'inspect', '--format', '{{.Id}}', guestImage);
const project = await compose('up');
assert.equal(typeof project.project?.id, 'string');
await save('project', project);

const marker = `workspace-check-${randomUUID()}`;
const checkGuestAuth = `node -e 'fetch("http://agent-compose:7410/api/version",{signal:AbortSignal.timeout(5000)}).then(r=>{if(r.status!==401)process.exit(1);console.log("guest-management-http=401")}).catch(()=>process.exit(1))'`;
const shellCommand = `mkdir -p /workspace/input /workspace/work /workspace/output /workspace/tool-drafts && printf '%s\\n' '${marker}' > /workspace/output/workspace-check.txt && test ! -S /var/run/docker.sock && test ! -e /project/docs/auth.json && ${checkGuestAuth} && pwd && cat /workspace/output/workspace-check.txt`;
let run = await compose('run', '--detach', '--keep-running', 'designer', '--command', shellCommand);
assert.equal(typeof run.id, 'string');
await save('started', run);
console.log(`Run: ${run.id}`);
const deadline = Date.now() + 120_000;
let previousStatus;
while (true) {
  run = await compose('inspect', 'run', run.id);
  if (run.status !== previousStatus) console.log(`Run status: ${run.status}`);
  previousStatus = run.status;
  if (!['pending', 'running'].includes(run.status)) break;
  assert.ok(Date.now() < deadline, 'Run did not finish within 120 seconds; preserve its ID for inspection.');
  await delay(2000);
}
await save('run', run);
assert.equal(run.status, 'succeeded', run.error || 'Command run must succeed.');
console.log(`Sandbox: ${run.sandbox_id}; if a later check fails, preserve it for inspection.`);
assert.equal(run.exit_code, 0);
assert.equal(run.project_id, project.project.id);
assert.match(run.output, /\/workspace/);
assert.ok(run.output.includes('guest-management-http=401'));
assert.ok(run.output.includes(marker));

const sandbox = await compose('inspect', 'sandbox', run.sandbox_id);
await save('sandbox-running', sandbox);
assert.match(run.sandbox_id, /^[a-f0-9]{64}$/);
assert.equal(sandbox.sandbox_id, run.sandbox_id);
assert.equal(sandbox.driver, 'docker');
assert.match(sandbox.workspace_path, new RegExp(`^/data/sandboxes/\\d{4}/\\d{2}/\\d{2}/${run.sandbox_id}/workspace$`));
const hostWorkspace = `${state}${sandbox.workspace_path}`;
const hostSandbox = hostWorkspace.slice(0, -'/workspace'.length);
assert.equal(await realpath(hostWorkspace), hostWorkspace);
const outputPath = `${hostWorkspace}/output/workspace-check.txt`;
assert.equal(await readFile(outputPath, 'utf8'), `${marker}\n`);

const ids = (await docker('container', 'ls', '--quiet', '--filter', `label=agent-compose.sandbox_id=${run.sandbox_id}`)).split('\n').filter(Boolean);
assert.equal(ids.length, 1, 'Exactly one running guest must belong to this sandbox.');
const [guest] = JSON.parse(await docker('container', 'inspect', ids[0]));
assert.equal(guest.State.Running, true);
assert.equal(guest.Image, expectedGuestId);
assert.ok(guest.Mounts.some(m => m.Destination === '/workspace' && m.Source === hostWorkspace));
assert.ok(!guest.Config.Env.some(e => /^(AGENT_COMPOSE_AUTH_TOKEN|MINIMAX_CN_API_KEY)=/.test(e)), 'Guest must not inherit management/model credentials.');
for (const mount of guest.Mounts) {
  assert.ok(mount.Source.startsWith(`${hostSandbox}/`), `Unexpected guest mount: ${mount.Destination}`);
  assert.ok(!mount.Source.endsWith('.sock'));
}
// Select only needed manager fields: its full inspect output includes the private token.
const managerIds = (await docker('container', 'ls', '--quiet', '--filter', 'label=com.docker.compose.project=sirna-pi', '--filter', 'label=com.docker.compose.service=agent-compose')).split('\n').filter(Boolean);
assert.equal(managerIds.length, 1);
const manager = JSON.parse(await docker('container', 'inspect', '--format', '{"id":{{json .Id}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}},"ports":{{json .HostConfig.PortBindings}}}', managerIds[0]));
assert.ok(manager.mounts.some(m => m.Source === `${root}/runtime/docker/run/docker.sock` && m.Destination === '/var/run/docker.sock'));
const managerNetworks = Object.keys(manager.networks);
assert.deepEqual(Object.keys(guest.NetworkSettings.Networks), managerNetworks);
assert.equal(managerNetworks.length, 1);
assert.deepEqual(manager.ports['7410/tcp'], [{ HostIp: '127.0.0.1', HostPort: '7410' }]);
await save('mounts-and-network', {
  guestContainer: guest.Id, managerContainer: manager.id,
  guestMounts: guest.Mounts, networks: managerNetworks,
  memoryLimit: guest.HostConfig.Memory, pidsLimit: guest.HostConfig.PidsLimit ?? null,
  unauthenticatedHttpStatus: unauthenticated.status,
});

// Only stop the newly created, verified sandbox. Keep its workspace and records.
await compose('sandbox', 'stop', '--graceful', run.sandbox_id);
const stopped = await compose('inspect', 'sandbox', run.sandbox_id);
await save('sandbox-stopped', stopped);
assert.equal(stopped.vm_status, 'stopped');
assert.equal(stopped.stopped_runtime_state, 'released');
assert.equal((await docker('container', 'ls', '--all', '--quiet', '--filter', `id=${guest.Id}`)), '');
assert.equal(await readFile(outputPath, 'utf8'), `${marker}\n`);
const result = { passed: true, projectId: project.project.id, runId: run.id, sandboxId: run.sandbox_id, outputPath, evidence, executionMode: 'fixed-command (no model request)' };
await save('result', result);
console.log(JSON.stringify(result, null, 2));
