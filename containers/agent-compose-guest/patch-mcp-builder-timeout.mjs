// pi-mcp-adapter 2.11.0: per-server requestTimeoutMs is consumed by
// server-manager.ts buildRequestOptions, independently of HTTP deadlines.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export async function patchMcpBuilderTimeout(directory){
  const info=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));
  if(info.name!=='pi-mcp-adapter'||info.version!=='2.11.0')throw new Error('Requires pi-mcp-adapter 2.11.0');
  const filename=path.join(directory,'config.ts');const source=await fs.readFile(filename,'utf8');
  const anchor='  return config;\n}\n\nfunction getConfigSources(overridePath?: string, cwd = process.cwd()): ConfigSourceSpec[] {';
  const at=source.indexOf(anchor);if(at<0||source.indexOf(anchor,at+1)!==-1)throw new Error('Builder deadline config anchor changed');
  const insertion=`  // siRNA-pi: only the explicitly enabled builder server gets a long deadline.
  if (overridePath) {
    const builder = config.mcpServers["sirna-tools"] as { env?: Record<string, string>; requestTimeoutMs?: number } | undefined;
    if (builder?.env?.SIRNA_TOOL_BUILDER_URL === "http://agent-tools-relay:7420") builder.requestTimeoutMs = 320000;
  }
`;
  await fs.writeFile(filename,source.slice(0,at)+insertion+source.slice(at));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3)throw new Error('Pass the adapter package directory');
  await patchMcpBuilderTimeout(process.argv[2]);
}
