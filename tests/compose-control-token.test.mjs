import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readComposeControlToken } from '../packages/agent-runtime/compose-control-token.mjs';

test('control token loader accepts only the private management-token file, without error disclosure', t => {
  const parent = fileURLToPath(new URL('../runtime/', import.meta.url));
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'token-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'runtime/agent-compose');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'control.env');
  const token = 'a'.repeat(64);
  fs.writeFileSync(file, `AGENT_COMPOSE_AUTH_TOKEN=${token}\n`, { mode: 0o600 });
  assert.equal(readComposeControlToken(root), token);
  fs.writeFileSync(file, `AGENT_COMPOSE_AUTH_TOKEN=${token}\nEXTRA=unsafe\n`);
  assert.throws(() => readComposeControlToken(root), error => !error.message.includes(token));
  if (process.platform !== 'win32') {
    fs.writeFileSync(file, `AGENT_COMPOSE_AUTH_TOKEN=${token}\n`);
    fs.chmodSync(file, 0o644);
    assert.throws(() => readComposeControlToken(root));
    fs.chmodSync(file, 0o600);
    fs.renameSync(file, `${file}.real`);
    fs.symlinkSync(`${file}.real`, file);
    assert.throws(() => readComposeControlToken(root));
  }
});
