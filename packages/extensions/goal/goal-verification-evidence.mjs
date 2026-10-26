import {createHash} from 'node:crypto';

// This first Evidence access layer is deliberately offline. It accepts only
// a response that was already fetched by a trusted caller and turns it into
// a bounded, hash-linked receipt. Network search/fetch belongs to the later
// Agent Compose verifier integration.
const MAX_RETRIEVAL_BYTES = 1_500_000;
const MAX_EXCERPT_CHARS = 16_000;
const MAX_REDIRECTS = 3;
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
function contentType(response) { return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() || undefined; }
async function responseTextWithinLimit(response) {
  const declaredValue = response.headers.get('content-length');
  const declared = declaredValue === null ? Number.NaN : Number(declaredValue);
  if (Number.isFinite(declared) && declared > MAX_RETRIEVAL_BYTES) throw new Error(`controlled retrieval response exceeds ${MAX_RETRIEVAL_BYTES} bytes`);
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.length;
    if (length > MAX_RETRIEVAL_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new Error(`controlled retrieval response exceeds ${MAX_RETRIEVAL_BYTES} bytes`);
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
class GoalEvidenceAccessError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'GoalEvidenceAccessError';
    this.code = code;
    this.details = details;
  }
}
async function controlledFetch(url, fetchImpl, signal) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (current.protocol !== 'https:' || !allowedHosts.has(current.hostname.toLowerCase())) {
      throw new Error(`controlled retrieval does not allow host ${current.hostname || current.href}`);
    }
    current.username = '';
    current.password = '';
    let response;
    try {
      response = await fetchImpl(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: {
          accept: 'application/json, application/xml, text/xml, text/html, text/plain;q=0.8',
          'user-agent': 'sirna-goal-verifier/1.0 (evidence retrieval)',
        },
        signal,
      });
    } catch (error) {
      throw new GoalEvidenceAccessError('EVIDENCE_PROVIDER_UNAVAILABLE', {
        sourceUrl: current.toString(), retryable: true,
        detail: error instanceof Error ? error.message : String(error),
        nextAction: 'Retry this retrieval once, use another allowed provider, or mark the claim unverifiable.',
      });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects === MAX_REDIRECTS) throw new Error('controlled retrieval redirect limit exceeded');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      if (response.status === 404) throw new GoalEvidenceAccessError('EVIDENCE_NOT_FOUND', {
        sourceUrl: current.toString(), httpStatus: response.status, retryable: false,
        nextAction: 'Use a different exact source URL or mark the claim insufficient_evidence.',
      });
      throw new GoalEvidenceAccessError('EVIDENCE_PROVIDER_UNAVAILABLE', {
        sourceUrl: current.toString(), httpStatus: response.status,
        retryable: response.status === 429 || response.status >= 500,
        nextAction: 'Retry when indicated, use another controlled scholarly provider, or mark the claim unverifiable.',
      });
    }
    const responseText = await responseTextWithinLimit(response);
    return {
      url: current.toString(), fetchedAt: new Date().toISOString(),
      ...(contentType(response) ? {contentType: contentType(response)} : {}),
      responseText, contentSha256: sha256(Buffer.from(responseText, 'utf8')),
    };
  }
  throw new Error('controlled retrieval redirect limit exceeded');
}
function searchUrl(provider, query, limit) {
  if (provider === 'openalex') {
    const url = new URL('https://api.openalex.org/works'); url.searchParams.set('search', query); url.searchParams.set('per-page', String(limit)); return url;
  }
  if (provider === 'crossref') {
    const url = new URL('https://api.crossref.org/works'); url.searchParams.set('query', query); url.searchParams.set('rows', String(limit)); return url;
  }
  if (provider === 'europe_pmc') {
    const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search'); url.searchParams.set('query', query); url.searchParams.set('pageSize', String(limit)); url.searchParams.set('format', 'json'); return url;
  }
  throw new Error('search provider is invalid');
}
function resultItems(provider, parsed) {
  if (provider === 'openalex') return Array.isArray(parsed?.results) ? parsed.results : [];
  if (provider === 'crossref') return Array.isArray(parsed?.message?.items) ? parsed.message.items : [];
  return Array.isArray(parsed?.resultList?.result) ? parsed.resultList.result : [];
}
function itemUrl(item) {
  return typeof item?.doi === 'string' ? (item.doi.startsWith('http') ? item.doi : `https://doi.org/${item.doi}`)
    : typeof item?.id === 'string' && /^https?:\/\//i.test(item.id) ? item.id
      : typeof item?.url === 'string' && /^https?:\/\//i.test(item.url) ? item.url : undefined;
}
function retrievalUnits(receipt, items) {
  return items.slice(0, 20).map((item, index) => {
    const serialized = JSON.stringify(item);
    const excerpt = serialized.length > MAX_EXCERPT_CHARS ? `${serialized.slice(0, MAX_EXCERPT_CHARS - 1)}…` : serialized;
    return {
      evidenceId: `retrieval:${receipt.id}:${index}`,
      method: 'retrieval',
      ...(itemUrl(item) ? {sourceUrl: itemUrl(item)} : {}),
      ...(typeof item?.title === 'string' ? {title: item.title} : typeof item?.display_name === 'string' ? {title: item.display_name} : {}),
      excerpt,
      fetchedAt: receipt.fetchedAt,
      contentSha256: sha256(Buffer.from(excerpt, 'utf8')),
    };
  });
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

export function createGoalVerificationEvidenceAccess({store, bundles, fetchImpl = globalThis.fetch} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.recordRetrieval !== 'function' || !bundles || typeof bundles.readArtifact !== 'function') throw new TypeError('Goal verification evidence access requires store and bundle builder');
  if (typeof fetchImpl !== 'function') throw new TypeError('Goal verification evidence access requires fetch');
  const running = verificationId => {
    const run = store.get(verificationId);
    if (!run) throw new Error('verification request not found');
    if (run.status !== 'running') throw new Error(`verification request is ${run.status}`);
    if (!run.bundle?.bundleSha256) throw new Error('verification bundle is missing or incomplete');
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
    async search({verificationId, provider, query, limit} = {}, signal) {
      running(verificationId);
      const normalizedQuery = typeof query === 'string' ? query.replace(/\s+/g, ' ').trim() : '';
      if (!normalizedQuery || normalizedQuery.length > 1000) throw new Error('search query must contain 1 to 1000 characters');
      if (!['openalex', 'crossref', 'europe_pmc'].includes(provider)) throw new Error('search provider is invalid');
      const count = integer(limit, 5, 1, 20);
      const retrieved = await controlledFetch(searchUrl(provider, normalizedQuery, count), fetchImpl, signal);
      const receipt = store.recordRetrieval({verificationId, kind: 'search', provider, query: normalizedQuery,
        sourceUrl: retrieved.url, fetchedAt: retrieved.fetchedAt,
        ...(retrieved.contentType ? {contentType: retrieved.contentType} : {}), responseText: retrieved.responseText});
      let parsed;
      try { parsed = JSON.parse(retrieved.responseText); }
      catch (error) {
        throw new GoalEvidenceAccessError('EVIDENCE_PROVIDER_UNAVAILABLE', {provider, retrievalId: receipt.id, retryable: true,
          detail: `Provider returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          nextAction: 'Retry this provider or use another controlled scholarly provider.'});
      }
      const evidenceUnits = retrievalUnits(receipt, resultItems(provider, parsed));
      const {responseText: _storedResponse, ...metadata} = receipt;
      return {...metadata, evidenceUnits, resultCount: evidenceUnits.length, evidenceStatus: evidenceUnits.length ? 'available' : 'not_found'};
    },
    async fetchSource({verificationId, url: sourceUrl} = {}, signal) {
      running(verificationId);
      let url;
      try { url = new URL(sourceUrl); } catch { throw new Error('source URL is invalid'); }
      const retrieved = await controlledFetch(url, fetchImpl, signal);
      const receipt = store.recordRetrieval({verificationId, kind: 'fetch', provider: new URL(retrieved.url).hostname,
        sourceUrl: retrieved.url, fetchedAt: retrieved.fetchedAt,
        ...(retrieved.contentType ? {contentType: retrieved.contentType} : {}), responseText: retrieved.responseText});
      const excerpt = retrieved.responseText.length > MAX_EXCERPT_CHARS ? `${retrieved.responseText.slice(0, MAX_EXCERPT_CHARS - 1)}…` : retrieved.responseText;
      const evidenceUnits = excerpt ? [{evidenceId: `retrieval:${receipt.id}:0`, method: 'retrieval', sourceUrl: receipt.sourceUrl,
        excerpt, fetchedAt: receipt.fetchedAt, contentSha256: sha256(Buffer.from(excerpt, 'utf8'))}] : [];
      const {responseText: _storedResponse, ...metadata} = receipt;
      return {...metadata, evidenceUnits, evidenceStatus: evidenceUnits.length ? 'available' : 'not_found'};
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
    limits: {maxRetrievalBytes: MAX_RETRIEVAL_BYTES, maxExcerptChars: MAX_EXCERPT_CHARS, maxRedirects: MAX_REDIRECTS, allowedHosts: [...allowedHosts]},
  };
}

export {GoalEvidenceAccessError};
