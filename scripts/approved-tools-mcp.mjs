// Trusted host entry. Never use this script as the task guest MCP command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createApprovedMcpServer} from '../apps/mcp/approved-server.mjs';
import {DockerEngineClient} from '../packages/capability-platform/docker-engine-client.mjs';
import {createDockerValidationRunner} from '../packages/capability-platform/tool-validation-runner.mjs';
import {discoverApprovedTools} from '../packages/capability-platform/tool-approved-execution.mjs';

process.umask(0o077);
const root='/home/hanwen/Project/project/siNRA-pi';
try{
  if(process.argv.length!==2||process.platform!=='linux'||os.userInfo().username!=='hanwen'||process.cwd()!==root||fs.realpathSync(root)!==root){
    throw new Error('Run without arguments as hanwen from the dedicated Linux project directory, without sudo');
  }
  const socket=path.join(root,'runtime/docker/run/docker.sock');
  if(fs.realpathSync(socket)!==socket||!fs.lstatSync(socket).isSocket())throw new Error('Expected the explicit project Docker socket');
  const runner=createDockerValidationRunner({docker:new DockerEngineClient(socket),purpose:'approved-call'});
  await createApprovedMcpServer({discover:()=>discoverApprovedTools({root,runner})}).connect(new StdioServerTransport());
}catch{
  console.error('Approved MCP host initialization failed; check the project root, Linux user and project Docker socket.');process.exitCode=1;
}
