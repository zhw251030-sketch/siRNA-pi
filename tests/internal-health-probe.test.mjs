import test from 'node:test';
import assert from 'node:assert/strict';
import {createInternalHealthProbeTool} from '../packages/capability-platform/internal-health-probe.mjs';

test('internal health probe exposes only the fixed target and bounded response', async () => {
  const calls = [];
  const tool = createInternalHealthProbeTool({
    url: 'http://192.168.1.169:3001/health',
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return new Response('{"ready":true}', {status: 200, headers: {'content-type': 'application/json'}});
    },
  });
  const result = await tool.execute('call-1', {input: {}}, new AbortController().signal);
  assert.equal(calls[0].url, 'http://192.168.1.169:3001/health');
  assert.equal(calls[0].options.method, 'GET');
  assert.deepEqual(JSON.parse(result.content[0].text), {target: 'http://192.168.1.169:3001/health', status: 200, ok: true, body: '{"ready":true}'});
  await assert.rejects(() => tool.execute('call-2', {input: {url: 'http://example.com/health'}}, new AbortController().signal), /only \{input:\{\}\}/);
});

test('internal health probe rejects arbitrary targets and oversized responses', async () => {
  assert.throws(() => createInternalHealthProbeTool({url: 'http://example.com/anything', fetchImpl: async () => new Response('x')}), /invalid/i);
  const tool = createInternalHealthProbeTool({url: 'https://internal.example:3001/health', fetchImpl: async () => new Response('x'.repeat(16_001), {status: 200})});
  await assert.rejects(() => tool.execute('call-1', {input: {}}, new AbortController().signal), /exceeds bound/i);
});

