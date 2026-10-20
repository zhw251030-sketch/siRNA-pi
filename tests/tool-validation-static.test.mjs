import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkValidationSource, assertValidationSupported } from '../packages/capability-platform/tool-validation-static.mjs';

const draft=JSON.parse(fs.readFileSync(new URL('../examples/04-tool-contract/proposal.draft.json',import.meta.url)));
const manifest={...draft,scriptFile:'tool.mjs',baselineScriptFile:'baseline.mjs',baselineRuntime:'node'};
test('teaching source needs no forbidden external capability',()=>{
  assert.equal(checkValidationSource(manifest,draft).passed,true);
  assert.doesNotThrow(()=>assertValidationSupported(draft));
});
test('permission evidence distinguishes profile-specific rules from always-prohibited rules',()=>{
  const result=checkValidationSource(manifest,{...draft,script:'fetch("x"); // child_process\nFunction("x")'});
  const http=result.violations.find(v=>v.ruleId==='STATIC_NODE_HTTP_API');
  assert.deepEqual(http.blockedUnderProfiles,['no_external_access','controlled_software']);
  assert.deepEqual(http.allowedUnderProfiles,['controlled_network']);
  const processRule=result.violations.find(v=>v.ruleId==='STATIC_NODE_PROCESS_API');
  assert.deepEqual(processRule.allowedUnderProfiles,['controlled_software']);
  assert.deepEqual(result.violations.find(v=>v.ruleId==='STATIC_DYNAMIC_CODE_EVALUATION').allowedUnderProfiles,[]);
});
for(const [source,rule] of [
  ['fetch("https://example.com")','STATIC_NODE_HTTP_API'],
  ['import fs from "node:child_process"','STATIC_NODE_PROCESS_API'],
  ['const x = Function("return 1")','STATIC_DYNAMIC_CODE_EVALUATION'],
  ['const x = "/home/hanwen/secret"','STATIC_HOST_ABSOLUTE_PATH'],
  ['import tls from "node:tls"','STATIC_NODE_RAW_NETWORK_API'],
  ['execSync("echo x")','STATIC_NODE_SHELL_EXECUTION'],
  ['// curl example.com','STATIC_HTTP_CLIENT_COMMAND'],
  ['// ssh user@server','STATIC_REMOTE_SHELL_OR_RAW_SOCKET_COMMAND'],
  ['// /var/run/docker.sock','STATIC_DOCKER_CONTROL_SOCKET'],
  ['// npm install pkg','STATIC_RUNTIME_PACKAGE_INSTALL'],
  ['// rm -rf path','STATIC_RECURSIVE_DELETION'],
]) test(`static gate locates ${rule} in baseline without executing source`,()=>{
  const result=checkValidationSource(manifest,{...draft,baseline:{runtime:'node',script:`\n${source}`}});
  assert.equal(result.passed,false);
  const violation=result.violations.find(v=>v.ruleId===rule);
  assert.equal(violation.target,'baseline');assert.equal(violation.file,'baseline.mjs');
  assert.equal(violation.line,2);assert.ok(violation.column>=1);
  assert.equal(result.permissionPolicy.validatorRoute,'restricted-offline');
});
for(const changed of [
  {runtime:'python'}, {baseline:{...draft.baseline,runtime:'bash'}},
  {dependencies:[{manager:'npm',name:'x',version:'1.0.0'}]},
  {permissions:{profile:'controlled_network',networkHosts:['example.com']}},
  {repeatabilityMode:'contract'}, {testCases:Array(11).fill(draft.testCases[0])},
  {smokeInput:{value:'a'.repeat(65536)}},
]) test(`unsupported validation scope rejected: ${Object.keys(changed)[0]}`,()=>{
  assert.throws(()=>assertValidationSupported({...draft,...changed}),/support|limit/i);
});
