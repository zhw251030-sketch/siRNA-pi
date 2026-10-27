const MAX_BODY_BYTES = 16_000;

function boundedUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/health$/.test(value)) {
    throw new Error('internal health probe URL is invalid');
  }
  return value;
}

export function createInternalHealthProbeTool({url, fetchImpl = globalThis.fetch} = {}) {
  const target = boundedUrl(url);
  if (typeof fetchImpl !== 'function') throw new TypeError('internal health probe requires fetch');
  return {
    name: 'probe_internal_health',
    label: 'Probe internal health endpoint',
    description: 'Read the configured internal health endpoint and return its bounded status. The target cannot be changed by the task.',
    parameters: {type: 'object', properties: {input: {type: 'object', properties: {}, additionalProperties: false}}, required: ['input'], additionalProperties: false},
    executionMode: 'sequential',
    async execute(_toolCallId, args, signal) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || !args.input || typeof args.input !== 'object' || Array.isArray(args.input) || Object.keys(args.input).length) {
        throw new Error('probe_internal_health accepts only {input:{}}');
      }
      const response = await fetchImpl(target, {method: 'GET', redirect: 'error', signal, headers: {accept: 'application/json'}});
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_BODY_BYTES) throw new Error('internal health response exceeds bound');
      const body = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      return {content: [{type: 'text', text: JSON.stringify({target, status: response.status, ok: response.ok, body})}]};
    },
  };
}

