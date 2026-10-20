// Trusted host entry point. This command executes reviewed proposal source in
// dedicated containers; it is deliberately not registered as an Agent tool.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { readBuildProposal, createBuildEvidence } from './lib/tool-build-files.mjs';
import { checkToolProposal } from '../packages/capability-platform/tool-contract.mjs';

const root = '/home/hanwen/Project/project/siNRA-pi';
let evidence;
try {
  if (process.argv.length !== 3 || process.argv[2].startsWith('-')) {
    throw new Error('Usage: node scripts/build-tool-artifact.mjs <project-relative-proposal.json>');
  }
  if (process.platform !== 'linux' || os.userInfo().username !== 'hanwen' || process.cwd() !== root || fs.realpathSync(root) !== root) {
    throw new Error('Run as hanwen from the dedicated Linux project directory, without sudo');
  }
  const socket = `${root}/runtime/docker/run/docker.sock`;
  if (fs.realpathSync(socket) !== socket || !fs.lstatSync(socket).isSocket()) throw new Error('Expected this project Docker socket');
  const proposal = readBuildProposal(process.argv[2],{root});
  const check = checkToolProposal(proposal,{requireRuntimeArtifact:false});
  if (!check.ok) throw new Error(`${check.code}: ${check.error}`);
  const sessionId = randomUUID();
  evidence = createBuildEvidence(root,sessionId);
  evidence.write('source-proposal.json',proposal);
  evidence.write('request.json',{sessionId,requestedAt:new Date().toISOString(),
    sourceSha256:createHash('sha256').update(proposal.script).digest('hex'),
    registered:false,approved:false,activated:false});
  const { DockerEngineClient } = await import('../packages/capability-platform/docker-engine-client.mjs');
  const { buildToolArtifact } = await import('../packages/capability-platform/tool-build-service.mjs');
  const result = await buildToolArtifact(proposal,{
    docker:new DockerEngineClient(socket),sessionId,
    onEvent: async event => evidence.appendEvent({...event,recordedAt:new Date().toISOString()}),
  });
  const completedProposal = {...proposal,runtimeArtifact:result.artifact};
  const completedCheck = checkToolProposal(completedProposal);
  if (!completedCheck.ok) throw new Error('Built proposal failed its final contract check');
  evidence.write('result.json',result);
  evidence.write('preflight.json',completedCheck);
  evidence.write('proposal.json',completedProposal);
  console.log(JSON.stringify({ok:true,stage:'artifact-built-and-example-tested',sessionId,
    imageDigest:result.artifact.imageDigest,platform:result.artifact.platform,
    proposalFile:path.relative(root,path.join(evidence.directory,'proposal.json')),
    evidenceDirectory:path.relative(root,evidence.directory),
    registered:false,approved:false,activated:false},null,2));
} catch (error) {
  const message = error instanceof Error ? error.message : 'Tool build failed';
  if (evidence) {
    try { evidence.write('failure.json',{ok:false,error:message,containerId:error.containerId,
      cleanupError:error.cleanupError,registered:false,approved:false,activated:false}); }
    catch { /* Keep existing journal and report the original failure. */ }
  }
  console.error(JSON.stringify({ok:false,error:message,evidenceDirectory:evidence?.directory,
    registered:false,approved:false,activated:false}));
  process.exitCode=1;
}
