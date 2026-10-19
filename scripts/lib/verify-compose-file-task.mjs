import assert from 'node:assert/strict';
import { posix } from 'node:path';

function json(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} 格式错误`); }
}

function toolPath(value) {
  assert.ok(typeof value === 'string' && value.length > 0 && !/[\\\0:]/.test(value)
    && !value.split('/').includes('..'), '工具路径不合法');
  const path = posix.resolve('/workspace', value);
  assert.ok(path.startsWith('/workspace/input/') || path.startsWith('/workspace/output/'), '工具路径超出允许范围');
  return path;
}

// Validate persisted native Pi messages, separately from the actual output file.
export function verifyComposeFileTask({ sessionJsonl, csv, resultJson }) {
  const lines = csv.trim().split(/\r?\n/);
  assert.equal(lines.shift(), 'value', 'CSV 必须只有 value 一列');
  assert.ok(lines.length > 0, 'CSV 没有数据');
  const numbers = lines.map(line => {
    assert.ok(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(line) && Number.isFinite(Number(line)), 'CSV 包含非法数值');
    return Number(line);
  });
  const sum = numbers.reduce((a, b) => a + b, 0);
  assert.ok(Number.isFinite(sum), 'CSV 数值总和溢出');
  const expected = { count: numbers.length, sum, mean: sum / numbers.length };
  const result = json(resultJson, '结果 JSON');
  assert.ok(result && typeof result === 'object' && !Array.isArray(result), '结果 JSON 必须是对象');
  assert.deepEqual(Object.keys(result).sort(), ['count', 'mean', 'sum'], '结果 JSON 只允许统计字段');
  for (const key of Object.keys(expected)) {
    assert.ok(typeof result[key] === 'number' && Number.isFinite(result[key]), '结果字段必须是有限数字');
    assert.ok(Math.abs(result[key] - expected[key]) <= 1e-12 * Math.max(1, Math.abs(expected[key])), '结果不符合独立计算');
  }

  const entries = sessionJsonl.trim().split('\n').filter(Boolean).map(line => json(line, '会话 JSONL'));
  const header = entries.shift();
  assert.ok(header?.type === 'session' && typeof header.id === 'string' && header.id.length > 0, '缺少会话 session 头');
  assert.equal(header.cwd, '/workspace', '会话工作目录 cwd 错误');
  const calls = new Map();
  const completed = new Set();
  let assistantResponses = 0;
  let readCalls = 0;
  let writeCalls = 0;
  let inputRead = false;
  let writesCompleted = 0;
  let verifiedWrite = 0;
  let lastMessage;
  for (const entry of entries) {
    assert.notEqual(entry.type, 'session', '重复的会话 session 头');
    if (entry.type !== 'message') continue;
    const message = entry.message;
    lastMessage = message;
    if (message.role === 'assistant') {
      assistantResponses += 1;
      assert.equal(message.provider, 'agent-compose', '模型提供方 provider 错误');
      assert.equal(message.model, 'MiniMax-M3', '模型 model 错误');
      assert.ok(!message.errorMessage, '模型响应含 errorMessage 错误');
      assert.ok(['toolUse', 'stop'].includes(message.stopReason), '模型未正常结束：stopReason');
      assert.ok(Array.isArray(message.content), '模型内容格式错误');
      assert.equal(calls.size, completed.size, '前序工具结果尚未完成');
      for (const call of message.content.filter(item => item.type === 'toolCall')) {
        assert.ok(typeof call.id === 'string' && call.id.length > 0 && !calls.has(call.id), '重复或无效的调用编号');
        assert.ok(['read', 'write'].includes(call.name), '调用了未允许的工具');
        const path = toolPath(call.arguments?.path);
        if (call.name === 'write') {
          assert.equal(path, '/workspace/output/result.json', '写入路径不允许');
          assert.ok(inputRead, '调用顺序错误：必须先成功读取输入');
          writeCalls += 1;
        } else {
          if (path === '/workspace/output/result.json') assert.ok(writesCompleted > 0, '调用顺序错误：必须先写入再重新读取');
          readCalls += 1;
        }
        calls.set(call.id, { name: call.name, path });
      }
    } else if (message.role === 'toolResult') {
      const call = calls.get(message.toolCallId);
      assert.ok(call, '工具结果没有匹配调用');
      assert.ok(!completed.has(message.toolCallId), '重复的工具结果');
      assert.equal(message.toolName, call.name, '工具名与调用不匹配');
      assert.equal(message.isError, false, '工具失败或缺少明确成功 isError 标记');
      completed.add(message.toolCallId);
      if (call.name === 'write') writesCompleted += 1;
      if (call.name === 'read' && call.path === '/workspace/input/numbers.csv') inputRead = true;
      if (call.name === 'read' && call.path === '/workspace/output/result.json') verifiedWrite = writesCompleted;
    }
  }
  assert.equal(calls.size, completed.size, '工具结果尚未完成');
  assert.ok(inputRead && writesCompleted > 0 && verifiedWrite === writesCompleted, '工具序列缺少输入读取、写入或最新输出的重新读取');
  assert.ok(lastMessage?.role === 'assistant' && lastMessage.stopReason === 'stop', '最终消息必须正常结束');
  return { result, sessionId: header.id, assistantResponses, toolCalls: calls.size, toolResults: completed.size, readCalls, writeCalls };
}
