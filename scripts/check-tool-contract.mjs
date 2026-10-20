// Offline preflight only: input scripts are data, never evaluated or launched.
import fs from 'node:fs';
import { checkToolProposal } from '../packages/capability-platform/tool-contract.mjs';

const limit = 1_048_576;
const usage = 'node scripts/check-tool-contract.mjs <proposal.json> [--draft]';
function inputError(message) { throw new Error(message); }
function readProposal(filename) {
  const initial = fs.lstatSync(filename);
  if (!initial.isFile() || initial.isSymbolicLink()) inputError('输入必须是普通JSON文件。');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > limit) inputError('输入须为非空文件，最多1 MiB。');
    if (before.dev !== initial.dev || before.ino !== initial.ino) inputError('输入文件在读取前发生变化。');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fs.fstatSync(fd);
    if (size > limit || size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      inputError('输入过大或在读取期间发生变化。');
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)); }
    catch { inputError('输入必须是有效UTF-8文本。'); }
    try { return JSON.parse(text); }
    catch { inputError('输入不是合法JSON；检查器不会回显原文。'); }
  } finally { fs.closeSync(fd); }
}

let report;
try {
  const args = process.argv.slice(2);
  const draft = args.includes('--draft');
  const filenames = args.filter(arg => !arg.startsWith('--'));
  if (filenames.length !== 1 || args.length !== (draft ? 2 : 1) || args.some(arg => arg.startsWith('--') && arg !== '--draft')) {
    inputError(`用法：${usage}`);
  }
  const proposal = readProposal(filenames[0]);
  report = checkToolProposal(proposal, { requireRuntimeArtifact: !draft });
  process.exitCode = report.ok ? 0 : 2;
} catch (error) {
  // Filesystem errors can contain user-controlled paths; report only the code.
  report = { ok: false, code: 'PREFLIGHT_INPUT_ERROR',
    error: error.code ? `无法读取输入文件（${error.code}）。` : error.message,
    executed: false, registered: false, activated: false, runtimeArtifactVerified: false };
  process.exitCode = 1;
}
console.log(JSON.stringify(report, null, 2));
