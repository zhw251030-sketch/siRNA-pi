import {createHash} from 'node:crypto';

const MAX_UNIT_CHARACTERS = 16_000;
const sha256 = value => createHash('sha256').update(value).digest('hex');
function canonicalJson(value) {
  if (value === undefined || value === null) return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function objectValue(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; }
function stringValue(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function titleFrom(record) {
  const title = stringValue(record.title) ?? (Array.isArray(record.title) ? stringValue(record.title[0]) : undefined);
  return title ?? stringValue(record.display_name) ?? stringValue(record.name);
}
function normalizedDoi(value) {
  const text = stringValue(value)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  return text ? `DOI:${text.toLowerCase()}` : undefined;
}
function sourceIdFrom(record) {
  const doi = normalizedDoi(record.doi ?? record.DOI);
  if (doi) return doi;
  const pmid = stringValue(record.pmid ?? record.PMID);
  if (pmid) return `PMID:${pmid}`;
  const pmcid = stringValue(record.pmcid ?? record.PMCID);
  if (pmcid) return `PMCID:${pmcid}`;
  return stringValue(record.id ?? record.sourceId ?? record.source_id);
}
function compactRecord(record) {
  const keys = ['id', 'doi', 'DOI', 'pmid', 'pmcid', 'title', 'display_name', 'publication_year', 'publicationDate', 'published', 'authorString', 'type', 'journalTitle', 'publisher', 'is_retracted', 'cited_by_count', 'abstractText'];
  return Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
}
function recordExcerpt(record) {
  const complete = canonicalJson(record);
  if (complete.length <= MAX_UNIT_CHARACTERS) return complete;
  return canonicalJson(compactRecord(record)).slice(0, MAX_UNIT_CHARACTERS);
}
function retrievalRecords(retrieval) {
  let parsed;
  try { parsed = JSON.parse(retrieval.responseText); } catch { return []; }
  const root = objectValue(parsed);
  if (!root) return [];
  if (Array.isArray(root.results)) return root.results.flatMap((record, index) => objectValue(record) ? [{record, locator: `/results/${index}`}] : []);
  const message = objectValue(root.message);
  if (Array.isArray(message?.items)) return message.items.flatMap((record, index) => objectValue(record) ? [{record, locator: `/message/items/${index}`}] : []);
  const resultList = objectValue(root.resultList);
  if (Array.isArray(resultList?.result)) return resultList.result.flatMap((record, index) => objectValue(record) ? [{record, locator: `/resultList/result/${index}`}] : []);
  return [];
}
function textChunks(value) {
  if (!value) return [];
  const chunks = [];
  for (let offset = 0; offset < value.length; offset += MAX_UNIT_CHARACTERS) {
    const end = Math.min(value.length, offset + MAX_UNIT_CHARACTERS);
    chunks.push({locator: `chars:${offset}-${end}`, excerpt: value.slice(offset, end)});
  }
  return chunks;
}

export function modelEvidenceUnit(unit) {
  return {
    evidenceId: unit.id,
    method: unit.method,
    ...(unit.sourceId ? {sourceId: unit.sourceId} : {}),
    ...(unit.title ? {title: unit.title} : {}),
    excerpt: unit.excerpt,
  };
}

export class GoalVerificationEvidenceResolver {
  constructor(store, bundles) {
    if (!store || typeof store.recordEvidenceUnit !== 'function' || typeof store.listEvidenceUnits !== 'function') throw new TypeError('EvidenceResolver requires evidence-unit storage');
    if (!bundles || typeof bundles.readArtifact !== 'function') throw new TypeError('EvidenceResolver requires bundle access');
    this.store = store;
    this.bundles = bundles;
  }
  unit(input) { return this.store.recordEvidenceUnit(input); }
  prepareBundle(run) {
    const verificationId = run.id ?? run.verificationId;
    for (const receipt of run.bundle.toolReceipts ?? []) this.unit({
      verificationId, method: 'tool_receipt', sourceUrl: `tool-receipt://${receipt.eventId}`, title: receipt.toolName,
      excerpt: canonicalJson({toolName: receipt.toolName, isError: receipt.isError, resultPreview: receipt.resultPreview ?? null}).slice(0, MAX_UNIT_CHARACTERS),
      fetchedAt: receipt.createdAt, contentSha256: receipt.resultSha256, dedupeKey: `tool-receipt:${receipt.eventId}`,
    });
    for (const message of run.bundle.messages ?? []) for (const chunk of textChunks(message.content ?? '')) this.unit({
      verificationId, method: 'message_quote', sourceUrl: `message://${message.id}`, title: `${message.role} message ${message.sequence}`,
      excerpt: chunk.excerpt, fetchedAt: message.createdAt, contentSha256: message.sha256,
      locator: chunk.locator, dedupeKey: `message:${message.id}:${chunk.locator}`,
    });
    for (const artifact of run.bundle.artifacts ?? []) this.unit({
      verificationId, method: 'artifact_read', sourceUrl: `artifact://${artifact.id}`, title: artifact.name,
      excerpt: artifact.encoding === 'binary' ? `[binary artifact: ${artifact.name}]` : `[artifact: ${artifact.name}]`,
      fetchedAt: artifact.modifiedAt, contentSha256: artifact.sha256, locator: 'metadata', dedupeKey: `artifact:${artifact.id}:metadata`,
    });
    return this.store.listEvidenceUnits(verificationId);
  }
  materializeRetrieval(retrieval) {
    const records = retrievalRecords(retrieval);
    if (records.length) return records.map(({record, locator}) => this.unit({
      verificationId: retrieval.verificationId, method: 'retrieval', retrievalId: retrieval.id, sourceUrl: retrieval.sourceUrl,
      ...(sourceIdFrom(record) ? {sourceId: sourceIdFrom(record)} : {}), ...(titleFrom(record) ? {title: titleFrom(record)} : {}),
      excerpt: recordExcerpt(record), fetchedAt: retrieval.fetchedAt, contentSha256: retrieval.contentSha256,
      locator, dedupeKey: `retrieval:${retrieval.id}:${locator}`,
    }));
    if (retrieval.kind === 'search') return [];
    return textChunks(retrieval.responseText).map(chunk => this.unit({
      verificationId: retrieval.verificationId, method: 'retrieval', retrievalId: retrieval.id, sourceUrl: retrieval.sourceUrl,
      excerpt: chunk.excerpt, fetchedAt: retrieval.fetchedAt, contentSha256: retrieval.contentSha256,
      locator: chunk.locator, dedupeKey: `retrieval:${retrieval.id}:${chunk.locator}`,
    }));
  }
  materializeArtifact(run, artifactId, excerpt, locator) {
    const artifact = (run.bundle.artifacts ?? []).find(item => item.id === artifactId);
    if (!artifact) throw new Error(`artifact does not belong to verification bundle: ${artifactId}`);
    return this.unit({verificationId: run.id, method: 'artifact_read', sourceUrl: `artifact://${artifact.id}`, title: artifact.name,
      excerpt, fetchedAt: artifact.modifiedAt, contentSha256: artifact.sha256, locator, dedupeKey: `artifact:${artifact.id}:${locator}`});
  }
  materializeMessage(run, messageId, excerpt, locator) {
    const message = (run.bundle.messages ?? []).find(item => item.id === messageId);
    if (!message) throw new Error(`message does not belong to verification bundle: ${messageId}`);
    return this.unit({verificationId: run.id, method: 'message_quote', sourceUrl: `message://${message.id}`, title: `${message.role} message ${message.sequence}`,
      excerpt, fetchedAt: message.createdAt, contentSha256: message.sha256, locator, dedupeKey: `message:${message.id}:${locator}`});
  }
  materializeCheck(check) {
    return this.unit({verificationId: check.verificationId, method: 'deterministic_check', sourceUrl: `check://${check.id}`,
      title: `${check.operation} on ${check.artifactId}`, excerpt: canonicalJson(check.result), fetchedAt: check.executedAt,
      contentSha256: check.resultSha256, dedupeKey: `check:${check.id}`});
  }
  async materializeWholeArtifact(run, artifactId) {
    const content = await this.bundles.readArtifact(run.bundle, artifactId);
    return textChunks(content.toString('utf8')).map(chunk => this.materializeArtifact(run, artifactId, chunk.excerpt, chunk.locator));
  }
  list(verificationId) { return this.store.listEvidenceUnits(verificationId); }
}

export {MAX_UNIT_CHARACTERS as GOAL_VERIFICATION_MAX_EVIDENCE_EXCERPT_CHARS};
