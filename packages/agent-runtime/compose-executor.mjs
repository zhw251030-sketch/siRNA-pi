import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import fs from 'node:fs';
import { sandboxIdPattern, composeRole, ensureDirectory } from './compose-session-store.mjs';

const execFile = promisify(execFileCallback);
function stageCuratorProfile(root) {
  // The existing manager already mounts runtime/agent-compose/data at /data.
  // Stage only this fixed public profile; never recreate the shared manager or
  // copy credentials, task workspaces, or the designer configuration.
  try {
    if(fs.realpathSync(root)!==root)throw Error();
    const source=path.join(root,'agent-compose-curator.yml');
    const stat=fs.lstatSync(source);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536||fs.realpathSync(source)!==source)throw Error();
    const bytes=fs.readFileSync(source);
    const directory=ensureDirectory(root,'runtime/agent-compose/data/curator-config');
    const target=path.join(directory,'agent-compose.yml');
    try {fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});}
    catch(error){if(error.code!=='EEXIST')throw error;}
    const staged=fs.lstatSync(target);
    if(!staged.isFile()||staged.isSymbolicLink()||staged.size!==bytes.length||fs.realpathSync(target)!==target||!fs.readFileSync(target).equals(bytes))throw Error();
  } catch {throw Error('Curator compose profile staging could not be verified');}
}
export function createComposeExecutor(root, {agentName='designer', execute=execFile} = {}) {
  composeRole(agentName);
  root=path.resolve(root);
  async function command(...args) {
    // No shell interpolation: prompt text goes through RPC, not command strings.
    if(agentName==='tool-curator')stageCuratorProfile(root);
    const roleArgs = agentName === 'tool-curator' ? ['--file', '/data/curator-config/agent-compose.yml'] : [];
    const { stdout } = await execute('sh', [path.join(root, 'scripts/project-agent-compose.sh'), ...roleArgs, ...args], {
      cwd: root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  }
  async function wait(runId, onUpdate) {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const run = await command('inspect', 'run', runId);
      await onUpdate(run);
      if (!['pending', 'running'].includes(run.status)) {
        if (run.status !== 'succeeded' || run.exit_code !== 0) throw new Error('Workspace initialization failed');
        return run;
      }
      if (Date.now() >= deadline) throw new Error('Workspace initialization timed out; retained its run ID');
      await delay(1000);
    }
  }
  return {
    up: () => command('up'), wait,
    inspectSandbox: id => command('inspect', 'sandbox', id),
    async release(id) {
      if (!sandboxIdPattern.test(id)) throw new Error('Invalid sandbox release target');
      const stopped = await command('sandbox', 'stop', '--graceful', id);
      const deadline = Date.now() + 20_000;
      for (;;) {
        const sandbox = await command('inspect', 'sandbox', id);
        if (sandbox.vm_status === 'stopped' && sandbox.stopped_runtime_state === 'released') {
          return { ...sandbox, releaseOutcome: stopped.results?.find(item => item.sandbox_id === id)?.outcome };
        }
        if (Date.now() >= deadline) throw new Error('Container release was not confirmed');
        await delay(500);
      }
    },
    async bootstrap(onUpdate) {
      const run = await command('run', '--detach', '--keep-running', agentName, '--command',
        'mkdir -p /workspace/input /workspace/work /workspace/output /workspace/tool-drafts');
      await onUpdate(run);
      return wait(run.id, onUpdate);
    },
  };
}
