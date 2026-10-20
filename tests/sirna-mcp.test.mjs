import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = fileURLToPath(new URL('../apps/mcp/server.mjs', import.meta.url));
const toolName = 'enumerate_sirna_candidates';

async function connect(t) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], stderr: 'pipe' });
  const client = new Client({ name: 'sirna-learning-contract-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

test('stdio exposes just the fixed candidate tool with bounded input and read-only hints', async t => {
  const client = await connect(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), [toolName]);
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  assert.deepEqual(tools[0].inputSchema.required, ['targetSequence']);
  assert.equal(tools[0].inputSchema.properties.maxCandidates.maximum, 100);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[0].annotations.destructiveHint, false);
});

test('real MCP call computes RNA reverse complement, coordinates and stable ties', async t => {
  const client = await connect(t);
  const response = await client.callTool({ name: toolName,
    arguments: { targetSequence: 'AAAAAAAAAAAAAAAAAAAAAAA', maxCandidates: 2 } });
  assert.notEqual(response.isError, true);
  assert.equal(response.content.length, 1);
  const result = JSON.parse(response.content[0].text);
  assert.deepEqual(result, {
    sequenceLength: 23, guideLength: 21, totalWindows: 3, returnedCandidates: 2,
    scoringMethod: 'transparent_prefilter_v1',
    candidates: [1, 2].map(start => ({
      id: `SIRNA-0000${start}`, start, end: start + 20,
      targetWindow: 'AAAAAAAAAAAAAAAAAAAAA', guide: 'UUUUUUUUUUUUUUUUUUUUU',
      gcFraction: 0, prefilterScore: 0,
      warnings: ['gc_below_range', 'homopolymer_4_or_more', 'low_base_diversity'],
    })),
  });
});

test('unknown names and invalid arguments are tool errors and do not kill the server', async t => {
  const client = await connect(t);
  for (const request of [
    { name: 'not_an_installed_tool', arguments: {} },
    { name: toolName, arguments: { targetSequence: 'ACGT' } },
    { name: toolName, arguments: { targetSequence: 'A'.repeat(21), maxCandidates: 101 } },
    { name: toolName, arguments: { targetSequence: 'A'.repeat(21), guideLength: '21' } },
    { name: toolName, arguments: { targetSequence: 'A'.repeat(21), command: 'unexpected' } },
    { name: toolName, arguments: { targetSequence: 'N'.repeat(21) } },
    { name: toolName, arguments: { targetSequence: 'A'.repeat(19), guideLength: 21 } },
  ]) {
    const result = await client.callTool(request);
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.length > 0);
  }
  const good = await client.callTool({ name: toolName, arguments: { targetSequence: 'A'.repeat(21) } });
  assert.notEqual(good.isError, true);
  assert.equal(JSON.parse(good.content[0].text).returnedCandidates, 1);
});
