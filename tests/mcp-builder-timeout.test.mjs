import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
// loadMcpConfig anchor from the actual guest's MIT pi-mcp-adapter 2.11.0.
// Native filesystem loading below makes the patched return value observable.
const anchor=`  return config;
}

function getConfigSources(overridePath?: string, cwd = process.cwd()): ConfigSourceSpec[] {`;
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sirna-builder-timeout-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'package.json'),'{"name":"pi-mcp-adapter","version":"2.11.0"}');
  await fs.writeFile(path.join(root,'config.ts'),`export function loadMcpConfig(overridePath?: string, cwd = process.cwd()) {
  const config = JSON.parse(readFileSync(overridePath, 'utf8'));
${anchor}
  return [];
}`);
  const api=await import('../containers/agent-compose-guest/patch-mcp-builder-timeout.mjs').catch(()=>({}));
  assert.equal(typeof api.patchMcpBuilderTimeout,'function','explicit builder adapter deadline patch exists');
  return {root,patch:()=>api.patchMcpBuilderTimeout(root)};
}
test('explicit builder server gets enough MCP time for bounded HTTP while approved-only servers keep their deadline',async t=>{
  const f=await fixture(t);await f.patch();const source=stripTypeScriptTypes(await fs.readFile(path.join(f.root,'config.ts'),'utf8'),{mode:'transform'}).replace(/^export /gm,'');
  const {readFileSync}=await import('node:fs');const load=new Function('readFileSync',source+';return loadMcpConfig;')(readFileSync);
  const filename=path.join(f.root,'invocation.json');
  for(const [env,want]of [[{SIRNA_APPROVED_TOOLS_URL:'http://agent-tools-relay:7420'},1234],[{SIRNA_TOOL_BUILDER_URL:'http://other:7420'},1234],[{SIRNA_TOOL_BUILDER_URL:'http://agent-tools-relay:7420'},320000]]){
    await fs.writeFile(filename,JSON.stringify({settings:{requestTimeoutMs:17},mcpServers:{'sirna-tools':{env,requestTimeoutMs:1234},other:{requestTimeoutMs:2345}}}));
    const loaded=load(filename);assert.equal(loaded.mcpServers['sirna-tools'].requestTimeoutMs,want);assert.equal(loaded.mcpServers.other.requestTimeoutMs,2345);assert.equal(loaded.settings.requestTimeoutMs,17);
  }
});
test('deadline patch refuses changed version or anchor before modifying package source',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'config.ts'),'different upstream');await assert.rejects(f.patch(),/anchor/);assert.equal(await fs.readFile(path.join(f.root,'config.ts'),'utf8'),'different upstream');
  await fs.writeFile(path.join(f.root,'package.json'),'{"name":"pi-mcp-adapter","version":"2.12.0"}');await assert.rejects(f.patch(),/2\.11\.0/);
});
