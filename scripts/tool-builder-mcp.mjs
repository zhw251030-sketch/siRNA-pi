// Trusted host stdio entry; never expose Docker or this process to the guest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createToolBuilderMcpServer,installToolBuilderShutdown} from '../apps/mcp/tool-builder-server.mjs';
import {createToolBuildSessionService} from '../packages/capability-platform/tool-build-sessions.mjs';
import {DockerEngineClient} from '../packages/capability-platform/docker-engine-client.mjs';
process.umask(0o077);
const root='/home/hanwen/Project/project/siNRA-pi';
try{
 if(process.argv.length!==2||process.platform!=='linux'||os.userInfo().username!=='hanwen'||process.cwd()!==root||fs.realpathSync(root)!==root)throw new Error('Host guard failed');
 const socket=path.join(root,'runtime/docker/run/docker.sock');if(fs.realpathSync(socket)!==socket||!fs.lstatSync(socket).isSocket())throw new Error('Project socket guard failed');
 const service=createToolBuildSessionService({root,docker:new DockerEngineClient(socket)});const server=createToolBuilderMcpServer({service});installToolBuilderShutdown(server);
 try{await server.connect(new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:1048576}));}catch(error){await server.close();throw error;}
}catch{
 console.error('Tool builder MCP host initialization failed; check Linux user, exact project root and project Docker socket.');process.exitCode=1;
}
