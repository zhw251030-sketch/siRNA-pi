import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createGoalVerifierMcpServer} from '../apps/mcp/goal-verifier.mjs';

test('Goal verifier MCP exposes only the eight read-only tools and forwards a token-scoped request', async () => {
  const calls = [];
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGoalVerifierMcpServer({baseUrl: 'http://registry.test', fetchImpl: async (url, options) => {
    calls.push({url, options});
    return new Response(JSON.stringify({evidenceUnits: [{evidenceId: 'evidence-1'}]}), {status: 200, headers: {'content-type': 'application/json'}});
  }});
  const client = new Client({name: 'goal-verifier-test', version: '0.1.0'});
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
      'check_verification_artifact', 'fetch_verification_source', 'get_verification_bundle', 'list_verification_evidence',
      'read_verification_artifact', 'read_verification_attempt', 'read_verification_message', 'search_verification_sources',
    ]);
    assert.ok(listed.tools.every(tool => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false));
    const byName = new Map(listed.tools.map(tool => [tool.name, tool]));
    assert.deepEqual(byName.get('read_verification_artifact').inputSchema.required.sort(), ['accessToken', 'artifactId', 'verificationId']);
    assert.deepEqual(byName.get('read_verification_attempt').inputSchema.required.sort(), ['accessToken', 'attemptNumber', 'field', 'verificationId']);
    assert.equal(byName.get('fetch_verification_source').inputSchema.additionalProperties, false);
    const result = await client.callTool({name: 'list_verification_evidence', arguments: {verificationId: '11111111-1111-4111-8111-111111111111', accessToken: 'short-lived-token-123456', offset: 0, limit: 5}});
    assert.equal(result.isError, undefined);
    assert.match(calls[0].url, /\/v1\/goal-verifications\/11111111-1111-4111-8111-111111111111\/evidence$/);
    assert.match(calls[0].options.body, /short-lived-token-123456/);
  } finally { await client.close(); await server.close(); }
});

test('Goal verifier MCP reports backend failures as tool errors', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGoalVerifierMcpServer({baseUrl: 'http://registry.test', fetchImpl: async () => new Response(JSON.stringify({error: 'invalid token'}), {status: 403})});
  const client = new Client({name: 'goal-verifier-test', version: '0.1.0'});
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const result = await client.callTool({name: 'get_verification_bundle', arguments: {verificationId: '11111111-1111-4111-8111-111111111111', accessToken: 'bad'}});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /invalid token/);
  } finally { await client.close(); await server.close(); }
});
