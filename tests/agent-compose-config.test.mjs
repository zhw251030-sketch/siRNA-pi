import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = fs.readFileSync(path.join(root, 'agent-compose.yml'), 'utf8');
const guestDockerfile = fs.readFileSync(path.join(root, 'containers', 'agent-compose-guest', 'Dockerfile'), 'utf8');
const designer = config.slice(config.indexOf('  designer:'), config.indexOf('  goal-verifier:'));

test('Agent Compose keeps scholarly retrieval in the independent verifier role', () => {
  assert.match(designer, /mcp_servers:\s+- sirna-tools/);
  const mcpSection = designer.slice(designer.indexOf('mcp_servers:'), designer.indexOf('driver:'));
  assert.doesNotMatch(mcpSection, /goal-verifier-tools|search_verification_sources|fetch_verification_source/);
  assert.match(config, /SIRNA_TOOL_REGISTRY_URL:\s+http:\/\/192\.168\.1\.169:3001/);
  assert.match(guestDockerfile, /COPY packages\/extensions\/goal\/goal-tools\.mjs \/opt\/sirna-pi\/packages\/extensions\/goal\/goal-tools\.mjs/);
  assert.match(designer, /independent verifier/);
  assert.match(designer, /do not invent\s+retrievalId or evidenceId/);
});
