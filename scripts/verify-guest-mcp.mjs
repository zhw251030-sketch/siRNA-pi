// Run only inside a disposable guest, without model credentials or session.prompt.
// Uses the real Pi extension loader and the real stdio server, not a fake tool.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = '/opt/sirna-pi';
assert.ok(fs.existsSync('/.dockerenv'), 'Run this check only in a disposable Docker guest');
assert.equal(JSON.parse(fs.readFileSync(`${root}/package.json`, 'utf8')).name, 'sirna-pi');
const cwd = '/workspace/mcp-check';
const agentDir = '/workspace/mcp-check/agent';
fs.mkdirSync(agentDir, { recursive: true });
Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' });
const configPath = path.join(cwd, 'compose-mcp.json');
fs.writeFileSync(configPath, JSON.stringify({ settings: { sampling: false, elicitation: false, outputGuard: true },
  mcpServers: { 'sirna-tools': { command: '/usr/bin/node', args: [`${root}/apps/mcp/server.mjs`], lifecycle: 'lazy' } } }));
// These must neither replace the explicit server nor add another capability.
fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
const unwanted = { mcpServers: {
  'sirna-tools': { command: '/does-not-exist' }, 'unexpected-server': { command: '/does-not-exist' },
} };
fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify(unwanted));
fs.writeFileSync(path.join(cwd, '.pi/mcp.json'), JSON.stringify(unwanted));
fs.mkdirSync('/root/.config/mcp', { recursive: true });
fs.writeFileSync('/root/.config/mcp/mcp.json', JSON.stringify(unwanted));
process.argv.push('--mcp-config', configPath);
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } =
  await import('@earendil-works/pi-coding-agent');
const settingsManager = SettingsManager.inMemory({ cacheWarming: 'off', retry: { enabled: false },
  compaction: { enabled: false }, enableInstallTelemetry: false, enableAnalytics: false });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
  disabledBuiltinExtensions: ['mcp'], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  additionalExtensionPaths: ['/usr/local/share/agent-compose/pi-mcp-adapter/index.ts'] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, [], 'Explicit adapter failed to load');
loader.getExtensions().runtime.flagValues.set('mcp-config', configPath);
const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'),
  modelsPath: path.join(agentDir, 'models.json'), modelsStorePath: path.join(agentDir, 'models-store.json'),
  allowModelNetwork: false, refreshOnCreate: false });
const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, resourceLoader: loader,
  settingsManager, tools: ['read', 'write', 'mcp'], sessionManager: SessionManager.inMemory(cwd) });
try {
  await session.bindExtensions({});
  assert.deepEqual(session.getActiveToolNames().sort(), ['mcp', 'read', 'write']);
  const mcp = session.agent.state.tools.find(tool => tool.name === 'mcp');
  assert.ok(mcp);
  const call = params => mcp.execute('no-model-check', params, new AbortController().signal);
  const connected = await call({ connect: 'sirna-tools' });
  assert.ok(JSON.stringify(connected).includes('enumerate_sirna_candidates'), 'Server did not expose the candidate tool');
  const badServer = await call({ connect: 'unexpected-server' });
  assert.ok(!JSON.stringify(badServer).includes('ENOENT'), 'Unapproved config started an extra server');
  assert.match(JSON.stringify(badServer), /not found|unknown|not configured/i);
  const args = { targetSequence: 'AAAAAAAAAAAAAAAAAAAAAAA', maxCandidates: 2 };
  const result = await call({ server: 'sirna-tools', tool: 'sirna_tools_enumerate_sirna_candidates', args: JSON.stringify(args) });
  assert.ok(JSON.stringify(result).includes('transparent_prefilter_v1'), `MCP computation did not return a result: ${JSON.stringify(result)}`);
  const texts = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  assert.match(texts, /"returnedCandidates"\s*:\s*2/);
  assert.match(texts, /UUUUUUUUUUUUUUUUUUUUU/);
  const invalid = await call({ server: 'sirna-tools', tool: 'sirna_tools_enumerate_sirna_candidates', args: '{"targetSequence":"bad"}' });
  assert.match(JSON.stringify(invalid), /Invalid arguments/);
  console.log(JSON.stringify({ piVersion: '1.2.0', adapter: '2.11.0', modelCalls: 0,
    activeTools: session.getActiveToolNames(), explicitConfigOnly: true, realMcpResult: true }));
} finally {
  await session.extensionRunner?.emit({ type: 'session_shutdown' });
  session.dispose();
}
