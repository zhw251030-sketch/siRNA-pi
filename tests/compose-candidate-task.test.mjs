import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { verifyComposeCandidateTask } from '../scripts/lib/verify-compose-candidate-task.mjs';

// Synthetic messages only. Expected candidate values are the separately hand-checked fixture.
const inputFasta = fs.readFileSync(new URL('../examples/03-candidate-tool/target.fasta', import.meta.url), 'utf8');
const expectedJson = fs.readFileSync(new URL('../examples/03-candidate-tool/expected.json', import.meta.url), 'utf8');
const resultJson = JSON.stringify(JSON.parse(expectedJson));
const text = value => [{ type: 'text', text: value }];
const assistant = (content, stopReason = 'toolUse') => ({
  role: 'assistant', content, provider: 'agent-compose', model: 'MiniMax-M3', stopReason,
});
const call = (id, name, args) => assistant([{ type: 'toolCall', id, name, arguments: args }]);
const result = (id, name, value, details) => ({
  role: 'toolResult', toolCallId: id, toolName: name, isError: false, content: text(value),
  ...(details ? { details } : {}),
});
function fixture() {
  return [
    { type: 'session', id: 'synthetic-candidate-session', version: 3, cwd: '/workspace' },
    ...[
      call('input', 'read', { path: 'input/target.fasta' }),
      result('input', 'read', inputFasta),
      call('connect', 'mcp', { connect: 'sirna-tools' }),
      result('connect', 'mcp', 'one tool', { mode: 'list', server: 'sirna-tools', count: 1, tools: ['sirna_tools_enumerate_sirna_candidates'] }),
      call('describe', 'mcp', { describe: 'sirna_tools_enumerate_sirna_candidates' }),
      result('describe', 'mcp', 'tool schema', { mode: 'describe', server: 'sirna-tools', tool: { name: 'sirna_tools_enumerate_sirna_candidates', originalName: 'enumerate_sirna_candidates' } }),
      call('enumerate', 'mcp', { tool: 'sirna_tools_enumerate_sirna_candidates', args: JSON.stringify({
        targetSequence: 'ACGUACGUACGUACGUACGUACGU', guideLength: 21, maxCandidates: 4,
      }) }),
      result('enumerate', 'mcp', resultJson, { mode: 'call', server: 'sirna-tools', tool: 'enumerate_sirna_candidates', mcpResult: { content: text(resultJson) } }),
      call('write', 'write', { path: '/workspace/output/candidates.json', content: resultJson }),
      result('write', 'write', 'Successfully wrote output'),
      call('reread', 'read', { path: './output/candidates.json' }),
      result('reread', 'read', resultJson),
      assistant(text('Done.'), 'stop'),
    ].map(message => ({ type: 'message', message })),
  ];
}
function verify(entries = fixture(), overrides = {}) {
  return verifyComposeCandidateTask({ sessionJsonl: entries.map(e => JSON.stringify(e)).join('\n'),
    inputFasta, resultJson, expectedJson, ...overrides });
}

test('native read, gateway discovery/call, write and reread prove the independent expected result', () => {
  const report = verify();
  assert.equal(report.sessionId, 'synthetic-candidate-session');
  assert.equal(report.assistantResponses, 7);
  assert.equal(report.toolCalls, 6);
  assert.equal(report.toolResults, 6);
  assert.equal(report.mcpCalls, 3);
  assert.equal(report.candidateCalls, 1);
  assert.equal(report.candidateToolCallIds[0], 'enumerate');
  assert.deepEqual(report.result.candidates.map(c => c.start), [1, 4, 2, 3]);
});

const mutations = [
  ['wrong candidate score despite a correct saved file', e => { e[8].message.content = text(resultJson.replace('0.8686', '0.9')); }],
  ['inner MCP result differs from gateway text', e => { e[8].message.details.mcpResult.content = text('{}'); }],
  ['inner MCP error hidden by successful gateway', e => { e[8].message.details.mcpResult.isError = true; }],
  ['missing MCP transport evidence', e => { delete e[8].message.details; }],
  ['result attributed to wrong MCP server', e => { e[8].message.details.server = 'other'; }],
  ['different input sequence passed to tool', e => { e[7].message.content[0].arguments.args = '{"targetSequence":"AAAAAAAAAAAAAAAAAAAAAAAA","guideLength":21,"maxCandidates":4}'; }],
  ['tool arguments are not a JSON string', e => { e[7].message.content[0].arguments.args = {}; }],
  ['unknown tool arguments', e => { const args = JSON.parse(e[7].message.content[0].arguments.args); args.extra = 1; e[7].message.content[0].arguments.args = JSON.stringify(args); }],
  ['missing input read result', e => { e.splice(2, 1); }],
  ['wrong input read contents', e => { e[2].message.content = text('other sequence'); }],
  ['tool invoked before completed input read', e => { [e[1], e[7]] = [e[7], e[1]]; }],
  ['write requested before completed candidate result', e => { e[7].message.content.push(e[9].message.content[0]); e.splice(9, 1); }],
  ['missing business call with plausible final artifact', e => { e.splice(7, 2); }],
  ['failed tool result', e => { e[8].message.isError = true; }],
  ['tool result without explicit success', e => { delete e[8].message.isError; }],
  ['unmatched tool result', e => { e[8].message.toolCallId = 'unknown'; }],
  ['wrong gateway name on result', e => { e[8].message.toolName = 'enumerate_sirna_candidates'; }],
  ['duplicate result', e => { e.splice(9, 0, structuredClone(e[8])); }],
  ['wrong model', e => { e[7].message.model = 'other'; }],
  ['wrong provider', e => { e[7].message.provider = 'other'; }],
  ['model failure hidden in intermediate response', e => { e[7].message.errorMessage = 'failure'; }],
  ['write changes original JSON text', e => { e[9].message.content[0].arguments.content += '\n'; }],
  ['reread text differs from file', e => { e[12].message.content = text('{}'); }],
  ['missing output reread', e => { e.splice(11, 2); }],
  ['read expected fixture in guest', e => { e[1].message.content[0].arguments.path = 'input/expected.json'; }],
  ['path traversal', e => { e[1].message.content[0].arguments.path = 'input/../input/target.fasta'; }],
  ['unapproved shell tool', e => { e[1].message.content[0].name = 'bash'; }],
  ['unapproved MCP action', e => { e[3].message.content[0].arguments = { action: 'auth-start', server: 'sirna-tools' }; }],
  ['unfinished final response', e => { e.at(-1).message.stopReason = 'length'; }],
];
for (const [name, mutate] of mutations) {
  test(`rejects ${name}`, () => {
    const entries = fixture();
    mutate(entries);
    assert.throws(() => verify(entries));
  });
}
test('a correct native trace cannot conceal an incorrect actual output file', () => {
  assert.throws(() => verify(undefined, { resultJson: resultJson.replace('0.8686', '0.9') }));
});
test('verification uses supplied independent expectations', () => {
  assert.throws(() => verify(undefined, { expectedJson: expectedJson.replace('0.8686', '0.9') }));
});
