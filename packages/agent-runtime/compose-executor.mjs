import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { sandboxIdPattern } from './compose-session-store.mjs';

const execFile = promisify(execFileCallback);
export function createComposeExecutor(root) {
  async function command(...args) {
    // No shell interpolation: prompt text goes through RPC, not command strings.
    const { stdout } = await execFile('sh', [path.join(root, 'scripts/project-agent-compose.sh'), ...args], {
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
      const run = await command('run', '--detach', '--keep-running', 'designer', '--command',
        'mkdir -p /workspace/input /workspace/work /workspace/output /workspace/tool-drafts');
      await onUpdate(run);
      return wait(run.id, onUpdate);
    },
  };
}
