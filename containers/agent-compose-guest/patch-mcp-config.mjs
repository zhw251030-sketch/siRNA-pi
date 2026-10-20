// Narrow behavior change to the MIT-licensed pi-mcp-adapter 2.11.0 bundled in
// the pinned official guest. Keep its package and original LICENSE in the image.
// Agent Compose's explicit invocation config must not merge workspace configs.
import fs from 'node:fs';
import path from 'node:path';
const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw new Error('Pass the adapter package directory');
const packageInfo = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
if (packageInfo.name !== 'pi-mcp-adapter' || packageInfo.version !== '2.11.0') {
  throw new Error('This patch requires pi-mcp-adapter 2.11.0');
}
const filename = path.join(directory, 'config.ts');
const source = fs.readFileSync(filename, 'utf8');
const anchor = 'function getConfigSources(overridePath?: string, cwd = process.cwd()): ConfigSourceSpec[] {\n  const userPath = getPiGlobalConfigPath(overridePath);';
const at = source.indexOf(anchor);
if (at === -1 || source.indexOf(anchor, at + 1) !== -1) throw new Error('Adapter config patch anchor changed');
const replacement = `${anchor}
  // siRNA-pi: an explicit controller-generated config is the only source.
  if (overridePath) {
    const explicit = JSON.parse(readFileSync(userPath, "utf8"));
    if (explicit.imports !== undefined) throw new Error("Explicit MCP imports are disabled");
    return [{ id: "pi-global", label: "Agent Compose invocation", readPath: userPath,
      writePath: userPath, kind: "user", shared: false, scope: "global" }];
  }`;
fs.writeFileSync(filename, source.slice(0, at) + replacement + source.slice(at + anchor.length));
console.log('pi-mcp-adapter 2.11.0: explicit configuration is exclusive');
