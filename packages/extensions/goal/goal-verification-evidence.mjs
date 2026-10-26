import {createHash} from 'node:crypto';

// This first Evidence access layer is deliberately offline. It accepts only
// a response that was already fetched by a trusted caller and turns it into
// a bounded, hash-linked receipt. Network search/fetch belongs to the later
// Agent Compose verifier integration.
const MAX_RETRIEVAL_BYTES = 1_500_000;
const MAX_EXCERPT_CHARS = 16_000;
const allowedHosts = new Set(['api.openalex.org', 'api.crossref.org', 'www.ebi.ac.uk', 'europepmc.org', 'pubmed.ncbi.nlm.nih.gov', 'doi.org']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const integer = (value, fallback, minimum, maximum) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`value must be an integer from ${minimum} to ${maximum}`);
  return value;
};
function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 4000) throw new Error('retrieval sourceUrl must be a bounded URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase()) || url.username || url.password) throw new Error('retrieval sourceUrl is outside the controlled HTTPS allowlist');
  return url.toString();
}
function rows(text) {
  const result = [];
  let row = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n') { row.push(field.replace(/\r$/, '')); result.push(row); row = []; field = ''; }
    else field += character;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); result.push(row); }
  return result.filter(item => item.some(value => value.length > 0));
}
function countExpectation(observed, expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('count checks require expected.equals, expected.minimum, or expected.maximum');
  const entries = ['equals', 'minimum', 'maximum'].filter(key => expected[key] !== undefined);
  if (!entries.length || entries.some(key => !Number.isInteger(expected[key]) || expected[key] < 0)) throw new Error('count expectations must be non-negative integers');
  const passed = entries.every(key => key === 'equals' ? observed === expected[key] : key === 'minimum' ? observed >= expected[key] : observed <= expected[key]);
  return {observed, expected: Object.fromEntries(entries.map(key => [key, expected[key]])), passed};
}

export function createGoalVerificationEvidenceAccess({store, bundles} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.recordRetrieval !== 'function' || !bundles || typeof bundles.readArtifact !== 'function') throw new TypeError('Goal verification evidence access requires store and bundle builder');
  const running = verificationId => {
    const run = store.get(verificationId);
    if (!run) throw new Error('verification request not found');
    if (run.status !== 'running') throw new Error(`verification request is ${run.status}`);
    if (!run.bundle) throw new Error('verification bundle is missing');
    return run;
  };
  return {
    recordRetrieval({verificationId, kind, provider, query, sourceUrl, fetchedAt, contentType, responseText} = {}) {
      running(verificationId);
      const url = safeUrl(sourceUrl);
      if (typeof responseText !== 'string' || Buffer.byteLength(responseText, 'utf8') > MAX_RETRIEVAL_BYTES) throw new Error(`controlled retrieval response exceeds ${MAX_RETRIEVAL_BYTES} bytes`);
      return store.recordRetrieval({verificationId, kind, provider, query, sourceUrl: url, fetchedAt, contentType, responseText});
    },
    getRetrieval(verificationId, retrievalId) {
      running(verificationId);
      return store.getRetrieval(retrievalId, verificationId);
    },
    listRetrievals(verificationId) {
      running(verificationId);
      return store.listRetrievals(verificationId);
    },
    async checkArtifact({verificationId, artifactId, operation, expected} = {}) {
      const run = running(verificationId);
      const artifact = run.bundle.artifacts?.find(item => item.id === artifactId);
      if (!artifact) throw new Error('artifact does not belong to this verification bundle');
      if (!['exists', 'text_stats', 'json_valid', 'json_array_length', 'csv_row_count'].includes(operation)) throw new Error('check operation is invalid');
      const content = await bundles.readArtifact(run.bundle, artifactId);
      const text = content.toString('utf8');
      let result;
      if (operation === 'exists') result = {passed: true, size: content.length};
      else if (operation === 'text_stats') {
        const minimumCharacters = expected?.minimumCharacters;
        const minimumLines = expected?.minimumLines;
        if ((minimumCharacters === undefined && minimumLines === undefined)
          || (minimumCharacters !== undefined && (!Number.isInteger(minimumCharacters) || minimumCharacters < 0))
          || (minimumLines !== undefined && (!Number.isInteger(minimumLines) || minimumLines < 0))) throw new Error('text_stats requires a non-negative minimumCharacters or minimumLines expectation');
        const characters = [...text].length;
        const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
        result = {passed: (minimumCharacters === undefined || characters >= minimumCharacters) && (minimumLines === undefined || lines >= minimumLines), observed: {characters, lines}, expected: {...(minimumCharacters === undefined ? {} : {minimumCharacters}), ...(minimumLines === undefined ? {} : {minimumLines})}};
      } else if (operation === 'json_valid') {
        try { JSON.parse(text); result = {passed: true, valid: true}; }
        catch (error) { result = {passed: false, valid: false, error: error instanceof Error ? error.message : String(error)}; }
      } else if (operation === 'json_array_length') {
        try { const parsed = JSON.parse(text); result = Array.isArray(parsed) ? countExpectation(parsed.length, expected) : {passed: false, error: 'JSON root is not an array'}; }
        catch (error) { result = {passed: false, error: error instanceof Error ? error.message : String(error)}; }
      } else {
        try { result = {...countExpectation(Math.max(0, rows(text).length - 1), expected), headerColumns: rows(text)[0]?.length ?? 0}; }
        catch (error) { result = {passed: false, error: error instanceof Error ? error.message : String(error)}; }
      }
      const check = store.recordCheck({verificationId, artifactId, operation, executedAt: new Date().toISOString(), artifactSha256: artifact.sha256, result});
      const evidence = {evidenceId: `check:${check.id}`, method: 'deterministic_check', sourceUrl: `check://${check.id}`, title: `${operation} on ${artifact.name}`, excerpt: JSON.stringify(result), fetchedAt: check.executedAt, contentSha256: check.resultSha256};
      return {check, evidence};
    },
    limits: {maxRetrievalBytes: MAX_RETRIEVAL_BYTES, maxExcerptChars: MAX_EXCERPT_CHARS, allowedHosts: [...allowedHosts]},
  };
}
