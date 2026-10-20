// Same fixed-tool / stdio boundary as reference src/mcp-server.ts (67d2754).
// Independently implemented; dynamic catalogs and tool governance come later.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createSirnaTools, validateCandidateArguments } from '../../packages/domain/sirna-tools/sirna-tools.mjs';

export function createSirnaMcpServer() {
  const tools = new Map(createSirnaTools().map(tool => [tool.name, tool]));
  const server = new Server({ name: 'sirna-design-tools', version: '0.1.0' }, {
    capabilities: { tools: {} },
    instructions: 'Enumerate candidate guides using deterministic rules. The prefilter score is not an activity prediction or evidence of biological efficacy. This server only provides candidate enumeration.',
  });
  const failure = message => ({ isError: true, content: [{ type: 'text', text: message }] });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools.values()].map(tool => ({
    name: tool.name, description: tool.description, inputSchema: tool.parameters,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = tools.get(request.params.name);
    if (!tool) return failure(`Unknown siRNA tool: ${request.params.name}`);
    const args = request.params.arguments ?? {};
    try { validateCandidateArguments(args); }
    catch (error) { return failure(`Invalid arguments for ${tool.name}: ${error.message}`); }
    try {
      const result = await tool.execute(randomUUID(), args);
      return { content: result.content };
    } catch (error) { return failure(`${tool.name} failed: ${error.message}`); }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // stdout is reserved for MCP JSON-RPC frames; diagnostics must go to stderr.
  await createSirnaMcpServer().connect(new StdioServerTransport());
}
