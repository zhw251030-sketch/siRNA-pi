import fs from 'node:fs';
import path from 'node:path';

export function readComposeControlToken(root) {
  try {
    const file = path.resolve(root, 'runtime/agent-compose/control.env');
    const stat = fs.lstatSync(file);
    if (fs.realpathSync(file) !== file || !stat.isFile() || stat.nlink !== 1 || stat.size > 256) throw new Error();
    if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600)) throw new Error();
    const match = /^AGENT_COMPOSE_AUTH_TOKEN=([a-f0-9]{64})\n?$/.exec(fs.readFileSync(file, 'utf8'));
    if (!match) throw new Error();
    return match[1];
  } catch { throw new Error('Agent Compose 管理令牌缺失或文件保护不符合要求。'); }
}
