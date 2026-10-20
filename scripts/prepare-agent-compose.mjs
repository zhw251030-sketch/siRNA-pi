// Generate only project-local runtime state; never read the model credential.
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';

const root = '/home/hanwen/Project/project/siNRA-pi';
if (process.platform !== 'linux' || userInfo().username !== 'hanwen' || process.argv.length !== 2) {
  throw new Error('Run on the server as hanwen, without arguments or sudo.');
}
if (await realpath(root) !== root) throw new Error('Refusing a redirected project directory.');

for (const name of ['runtime', 'runtime/agent-compose', 'runtime/agent-compose/data', 'runtime/agent-tools']) {
  const path = `${root}/${name}`;
  await mkdir(path, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700 || await realpath(path) !== path) {
    throw new Error(`Expected an unredirected private directory owned by hanwen: ${path}`);
  }
}

const path = `${root}/runtime/agent-compose/control.env`;
try {
  await writeFile(path, `AGENT_COMPOSE_AUTH_TOKEN=${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
const stat = await lstat(path);
if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
  throw new Error('Expected a regular private control.env owned by hanwen.');
}
if (!/^AGENT_COMPOSE_AUTH_TOKEN=[a-f0-9]{64}\n$/.test(await readFile(path, 'utf8'))) {
  throw new Error('Unexpected control.env format; preserve it for inspection.');
}
console.log('Agent Compose private state ready; control token preserved and not displayed.');
