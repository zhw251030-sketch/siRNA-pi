import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';

const access = {
  verificationId: {type: 'string', description: 'UUID from the verification prompt'},
  accessToken: {type: 'string', description: 'Short-lived verifier access token'},
};
const bounded = {type: 'integer', minimum: 0, maximum: 16000};
const tools = [
  ['get_verification_bundle', 'Read bounded metadata for the immutable verification bundle', access],
  ['read_verification_message', 'Read one paged chunk of a frozen task message', {...access, messageId: {type: 'string'}, offset: bounded, maxChars: bounded}],
  ['read_verification_artifact', 'Read one paged chunk of an immutable artifact', {...access, artifactId: {type: 'string'}, offset: bounded, maxChars: bounded}],
  ['list_verification_evidence', 'List backend-created evidence units; cite only returned evidenceId values', {...access, offset: bounded, limit: {type: 'integer', minimum: 1, maximum: 5}}],
  ['read_verification_attempt', 'Read diagnostics or proposal from a previous verification attempt', {...access, attemptNumber: {type: 'integer', minimum: 1, maximum: 3}, field: {type: 'string', enum: ['diagnostics', 'proposal', 'prompt']}, offset: bounded, maxChars: bounded}],
  ['check_verification_artifact', 'Run a bounded deterministic read-only artifact check', {...access, artifactId: {type: 'string'}, operation: {type: 'string', enum: ['exists', 'text_stats', 'json_valid', 'json_array_length', 'csv_row_count']}, expected: {type: 'object'}}],
  ['search_verification_sources', 'Search the fixed controlled scholarly providers', {...access, provider: {type: 'string', enum: ['openalex', 'crossref', 'europe_pmc']}, query: {type: 'string', minLength: 1, maxLength: 1000}, limit: {type: 'integer', minimum: 1, maximum: 20}}],
  ['fetch_verification_source', 'Fetch an HTTPS source from the fixed scholarly allowlist', {...access, url: {type: 'string', minLength: 1, maxLength: 4000}}],
].map(([name, description, properties]) => ({
  name, description, inputSchema: {type: 'object', properties, required: ['verificationId', 'accessToken'], additionalProperties: false},
  annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: !['search_verification_sources', 'fetch_verification_source'].includes(name)},
}));

const operationFor = {
  get_verification_bundle: 'bundle', read_verification_message: 'message', read_verification_artifact: 'artifact',
  list_verification_evidence: 'evidence', read_verification_attempt: 'attempt', check_verification_artifact: 'check',
  search_verification_sources: 'search', fetch_verification_source: 'fetch',
};
const requiredFor = {
  get_verification_bundle: ['verificationId', 'accessToken'],
  read_verification_message: ['verificationId', 'accessToken', 'messageId'],
  read_verification_artifact: ['verificationId', 'accessToken', 'artifactId'],
  list_verification_evidence: ['verificationId', 'accessToken'],
  read_verification_attempt: ['verificationId', 'accessToken', 'attemptNumber', 'field'],
  check_verification_artifact: ['verificationId', 'accessToken', 'artifactId', 'operation'],
  search_verification_sources: ['verificationId', 'accessToken', 'provider', 'query'],
  fetch_verification_source: ['verificationId', 'accessToken', 'url'],
};
for (const tool of tools) tool.inputSchema.required = requiredFor[tool.name];

function textResult(value) { return {content: [{type: 'text', text: JSON.stringify(value, null, 2)}]}; }
function requiredString(args, key) {
  if (typeof args?.[key] !== 'string' || !args[key].trim()) throw new Error(`${key} is required`);
  return args[key].trim();
}

export function createGoalVerifierMcpServer({baseUrl = process.env.SIRNA_TOOL_REGISTRY_URL, fetchImpl = globalThis.fetch} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Goal verifier MCP requires fetch');
  const backendRequest = async (operation, args, signal) => {
    if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) throw new Error('SIRNA_TOOL_REGISTRY_URL is required');
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/goal-verifications/${encodeURIComponent(args.verificationId)}/${operation}`, {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(args), signal,
    });
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error(raw || `verification backend returned HTTP ${response.status}`); }
    if (!response.ok) throw new Error(payload && typeof payload.error === 'string' ? payload.error : `verification backend returned HTTP ${response.status}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('verification backend returned an invalid object');
    return payload;
  };
  const server = new Server({name: 'sirna-goal-verifier', version: '0.1.0'}, {
    capabilities: {tools: {}},
    instructions: '只读 Goal 验证工具。所有大内容分页；证据必须引用后端返回的 evidenceId。不能修改 Goal、文件、工具或运行任务。',
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({tools}));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {};
    try {
      const verificationId = requiredString(args, 'verificationId');
      const accessToken = requiredString(args, 'accessToken');
      const operation = operationFor[request.params.name];
      if (!operation) return {isError: true, content: [{type: 'text', text: `Unknown Goal verifier tool: ${request.params.name}`}]};
      return textResult(await backendRequest(operation, {...args, verificationId, accessToken}, extra.signal));
    } catch (error) {
      return {isError: true, content: [{type: 'text', text: error instanceof Error ? error.message : String(error)}]};
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createGoalVerifierMcpServer().connect(new StdioServerTransport());
}
