import assert from 'node:assert/strict';
import { posix } from 'node:path';

const candidateTool = 'sirna_tools_enumerate_sirna_candidates';
function parse(text, label) {
  assert.equal(typeof text, 'string', `${label} must be JSON text`);
  try { return JSON.parse(text); } catch { throw new Error(`${label} is invalid JSON`); }
}
function onlyText(content, label) {
  assert.ok(Array.isArray(content) && content.length === 1 && content[0].type === 'text'
    && typeof content[0].text === 'string', `${label} must contain exactly one text result`);
  return content[0].text;
}
function exercisePath(value) {
  assert.ok(typeof value === 'string' && value && !/[\\\0:]/.test(value)
    && !value.split('/').includes('..'), 'Invalid tool path');
  const absolute = posix.resolve('/workspace', value);
  assert.ok(['/workspace/input/target.fasta', '/workspace/output/candidates.json'].includes(absolute),
    'Tool path is outside the dedicated exercise');
  return absolute;
}

// Verify persisted Pi 1.2 gateway evidence against a separately supplied expected.json.
// This module never imports or executes the candidate generator or invokes any tools.
export function verifyComposeCandidateTask({ sessionJsonl, inputFasta, resultJson, expectedJson }) {
  const expected = parse(expectedJson, 'Independent expectation');
  const result = parse(resultJson, 'Actual output file');
  assert.deepEqual(result, expected, 'Actual output differs from the independent expectation');
  const fastaLines = inputFasta.trim().split(/\r?\n/);
  assert.ok(fastaLines.shift()?.startsWith('>'), 'Expected a single FASTA record');
  const sequence = fastaLines.join('');
  assert.match(sequence, /^[ACGU]+$/, 'Exercise FASTA must have a single RNA sequence');
  const expectedArguments = { targetSequence: sequence, guideLength: 21, maxCandidates: 4 };
  const entries = sessionJsonl.trim().split('\n').filter(Boolean).map(line => parse(line, 'Native JSONL'));
  const header = entries.shift();
  assert.ok(header?.type === 'session' && typeof header.id === 'string' && header.id, 'Missing native session header');
  assert.equal(header.cwd, '/workspace');

  const calls = new Map();
  const completed = new Set();
  const candidateToolCallIds = [];
  let assistantResponses = 0;
  let readCalls = 0;
  let writeCalls = 0;
  let mcpCalls = 0;
  let inputRead = false;
  let candidateText;
  let writesCompleted = 0;
  let rereadWrites = 0;
  let writtenCandidateCount = 0;
  let lastMessage;
  for (const entry of entries) {
    assert.notEqual(entry.type, 'session', 'Duplicate native session header');
    if (entry.type !== 'message') continue;
    const message = entry.message;
    lastMessage = message;
    if (message.role === 'assistant') {
      assistantResponses += 1;
      assert.equal(message.provider, 'agent-compose', 'Wrong model provider');
      assert.equal(message.model, 'MiniMax-M3', 'Wrong model');
      assert.ok(!message.errorMessage && ['toolUse', 'stop'].includes(message.stopReason), 'Assistant did not finish normally');
      assert.ok(Array.isArray(message.content), 'Invalid assistant content');
      assert.equal(calls.size, completed.size, 'Previous tool call has no completed result');
      for (const item of message.content.filter(part => part.type === 'toolCall')) {
        assert.ok(typeof item.id === 'string' && item.id && !calls.has(item.id), 'Duplicate or invalid tool call ID');
        assert.ok(['read', 'write', 'mcp'].includes(item.name), 'Unapproved tool');
        const args = item.arguments;
        assert.ok(args && typeof args === 'object' && !Array.isArray(args), 'Invalid tool arguments');
        const call = { name: item.name };
        if (item.name === 'mcp') {
          mcpCalls += 1;
          if (Object.hasOwn(args, 'tool')) {
            assert.deepEqual(Object.keys(args).sort(), ['args', 'tool'], 'Unexpected gateway call arguments');
            assert.equal(args.tool, candidateTool, 'Wrong MCP business tool');
            assert.deepEqual(parse(args.args, 'MCP arguments'), expectedArguments, 'MCP input differs from the exercise');
            assert.ok(inputRead, 'Candidate call must follow a completed input read');
            call.mode = 'call';
          } else if (Object.hasOwn(args, 'connect') || Object.hasOwn(args, 'server')) {
            const key = Object.hasOwn(args, 'connect') ? 'connect' : 'server';
            assert.deepEqual(args, { [key]: 'sirna-tools' }, 'Unapproved MCP discovery');
            call.mode = 'list';
          } else {
            assert.deepEqual(args, { describe: candidateTool }, 'Unapproved MCP action');
            call.mode = 'describe';
          }
        } else {
          call.path = exercisePath(args.path);
          if (item.name === 'write') {
            assert.equal(call.path, '/workspace/output/candidates.json', 'Wrong write destination');
            assert.ok(candidateToolCallIds.length > 0, 'Write must follow a completed candidate tool result');
            assert.equal(args.content, candidateText, 'Write changed the original candidate JSON text');
            writeCalls += 1;
          } else {
            if (call.path === '/workspace/output/candidates.json') assert.ok(writesCompleted > 0, 'Output read must follow a successful write');
            readCalls += 1;
          }
        }
        calls.set(item.id, call);
      }
    } else if (message.role === 'toolResult') {
      const call = calls.get(message.toolCallId);
      assert.ok(call && !completed.has(message.toolCallId), 'Unmatched or duplicate tool result');
      assert.equal(message.toolName, call.name, 'Tool result name differs from its call');
      assert.equal(message.isError, false, 'Tool result must be explicitly successful');
      completed.add(message.toolCallId);
      if (call.name === 'mcp') {
        assert.equal(message.details?.server, 'sirna-tools', 'Wrong MCP server evidence');
        assert.equal(message.details.mode, call.mode, 'Wrong MCP gateway result mode');
        if (call.mode === 'call') {
          assert.equal(message.details.tool, 'enumerate_sirna_candidates');
          const inner = message.details.mcpResult;
          assert.ok(inner && inner.isError !== true, 'Inner MCP call failed or is missing');
          const returned = onlyText(message.content, 'Gateway result');
          assert.equal(onlyText(inner.content, 'Inner MCP result'), returned, 'MCP and gateway result differ');
          assert.deepEqual(parse(returned, 'Candidate result'), expected, 'Tool result differs from independent expectation');
          candidateText = returned;
          candidateToolCallIds.push(message.toolCallId);
        } else if (call.mode === 'list') {
          assert.deepEqual(message.details.tools, [candidateTool]);
          assert.equal(message.details.count, 1);
        } else {
          assert.equal(message.details.tool?.name, candidateTool);
          assert.equal(message.details.tool.originalName, 'enumerate_sirna_candidates');
        }
      } else if (call.name === 'write') {
        writesCompleted += 1;
        writtenCandidateCount = candidateToolCallIds.length;
      } else if (call.path === '/workspace/input/target.fasta') {
        assert.equal(onlyText(message.content, 'Input read'), inputFasta, 'Input read contents differ from uploaded FASTA');
        inputRead = true;
      } else {
        assert.equal(onlyText(message.content, 'Output reread'), resultJson, 'Output reread differs from actual file');
        rereadWrites = writesCompleted;
      }
    }
  }
  assert.equal(calls.size, completed.size, 'Tool results are incomplete');
  assert.ok(inputRead && candidateToolCallIds.length > 0 && writesCompleted > 0
    && rereadWrites === writesCompleted && writtenCandidateCount === candidateToolCallIds.length,
  'Missing completed read → candidate call → write → reread sequence');
  assert.equal(resultJson, candidateText, 'Actual output did not preserve the tool JSON text');
  assert.ok(lastMessage?.role === 'assistant' && lastMessage.stopReason === 'stop', 'Final assistant response did not stop normally');
  return { result, sessionId: header.id, assistantResponses, toolCalls: calls.size, toolResults: completed.size,
    readCalls, writeCalls, mcpCalls, candidateCalls: candidateToolCallIds.length, candidateToolCallIds,
    toolEvidence: [...calls].map(([toolCallId, call]) => ({ toolCallId, toolName: call.name })) };
}
