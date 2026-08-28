import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type {
  BibliographicCreatorV1,
  BibliographicRecordV1,
  BibliographyCandidateV1,
  BibliographyQueryV1,
  BibliographyResolveRequestV1,
  BibliographyResolutionV1,
  BibliographyVerificationV1,
  OaAttachmentReceiptV1,
} from '@openlab/protocol';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const METADATA_HOSTS = new Set([
  'api.crossref.org',
  'api.datacite.org',
  'eutils.ncbi.nlm.nih.gov',
  'export.arxiv.org',
  'api.openalex.org',
]);
const OA_PDF_HOSTS = new Set([
  'arxiv.org',
  'export.arxiv.org',
  'pmc.ncbi.nlm.nih.gov',
  'europepmc.org',
  'www.ebi.ac.uk',
  'zenodo.org',
  'figshare.com',
  'osf.io',
]);
const MAX_QUERIES = 1_000;
const MAX_CANDIDATES = 5;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const DOI_IN_TEXT = /\b(10\.\d{4,9}\/[\w.()/:+-]+[\w()/])/iu;
const PMID_IN_TEXT = /\bPMID\s*:\s*(\d{5,9})\b/iu;
const ARXIV_IN_TEXT = /\b(?:arXiv\s*:\s*)?(\d{4}\.\d{4,5})(?:v\d+)?\b/iu;

interface StoredAttachment {
  id: string;
  path: string;
  sha256: string;
  sourceUrl: string;
  mediaType: string;
  license?: string;
  size: number;
}

function decodeXml(value: string): string {
  return value
    .replace(/<[^>]+>/gu, ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizedTitle(value: string): string {
  return decodeXml(value).normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
}

function cleanDoi(value: string): string {
  return decodeURIComponent(value).trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '').replace(/^doi\s*:\s*/iu, '').replace(/[.,;:]+$/u, '').toLocaleLowerCase();
}

function creator(value: unknown): BibliographicCreatorV1 | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  const family = typeof item.family === 'string' ? item.family : typeof item.name === 'string' ? item.name : '';
  if (!family.trim()) return undefined;
  const given = typeof item.given === 'string' ? item.given : undefined;
  return { family: family.trim(), ...(given?.trim() ? { given: given.trim() } : {}) };
}

function yearFrom(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    const nested = value[0];
    if (Array.isArray(nested) && Number.isInteger(Number(nested[0]))) return Number(nested[0]);
  }
  const match = String(value ?? '').match(/\b(?:19|20)\d{2}\b/u)?.[0];
  return match ? Number(match) : undefined;
}

function itemType(value: unknown): BibliographicRecordV1['itemType'] {
  const type = String(value ?? '').toLocaleLowerCase();
  if (type.includes('journal') || type === 'article') return 'journalArticle';
  if (type.includes('proceeding') || type.includes('conference')) return 'conferencePaper';
  if (type === 'book') return 'book';
  if (type.includes('chapter')) return 'bookSection';
  if (type.includes('posted') || type.includes('preprint')) return 'preprint';
  if (type.includes('dissertation') || type.includes('thesis')) return 'thesis';
  if (type.includes('report')) return 'report';
  return 'other';
}

function retractionFrom(value: unknown): BibliographicRecordV1['retractionStatus'] {
  const serialized = JSON.stringify(value).toLocaleLowerCase();
  if (/expression[_\s-]of[_\s-]concern|concerned article/u.test(serialized)) return 'expression_of_concern';
  if (/retract(?:ed|ion)|withdrawn/u.test(serialized)) return 'retracted';
  if (/correct(?:ed|ion)|erratum/u.test(serialized)) return 'corrected';
  return 'clear';
}

function crossrefRecord(message: Record<string, unknown>): BibliographicRecordV1 | undefined {
  const title = Array.isArray(message.title) ? String(message.title[0] ?? '') : String(message.title ?? '');
  const doi = cleanDoi(String(message.DOI ?? ''));
  if (!title.trim() || !doi) return undefined;
  const authors = Array.isArray(message.author) ? message.author.map(creator).filter((item): item is BibliographicCreatorV1 => Boolean(item)) : [];
  const issued = message.issued as { 'date-parts'?: unknown } | undefined;
  const published = message.published as { 'date-parts'?: unknown } | undefined;
  const container = Array.isArray(message['container-title']) ? String(message['container-title'][0] ?? '') : String(message['container-title'] ?? '');
  const abstract = typeof message.abstract === 'string' ? decodeXml(message.abstract) : undefined;
  const sourceUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const issuedYear = yearFrom(issued?.['date-parts'] ?? published?.['date-parts'] ?? message.published);
  return {
    schemaVersion: 1,
    canonicalId: `doi:${doi}`,
    itemType: itemType(message.type),
    title: decodeXml(title),
    creators: authors,
    ...(issuedYear ? { issuedYear } : {}),
    ...(container.trim() ? { containerTitle: decodeXml(container) } : {}),
    ...(typeof message.volume === 'string' ? { volume: message.volume } : {}),
    ...(typeof message.issue === 'string' ? { issue: message.issue } : {}),
    ...(typeof message.page === 'string' ? { pages: message.page } : {}),
    ...(typeof message.publisher === 'string' ? { publisher: message.publisher } : {}),
    doi,
    ...(typeof message.URL === 'string' ? { url: message.URL } : {}),
    ...(abstract ? { abstract } : {}),
    retractionStatus: retractionFrom(message),
    source: 'crossref',
    sourceUrl,
    retrievedAt: new Date().toISOString(),
  };
}

function dataciteRecord(data: Record<string, unknown>): BibliographicRecordV1 | undefined {
  const attributes = typeof data.attributes === 'object' && data.attributes !== null ? data.attributes as Record<string, unknown> : data;
  const doi = cleanDoi(String(attributes.doi ?? data.id ?? ''));
  const titleItems = Array.isArray(attributes.titles) ? attributes.titles as Array<Record<string, unknown>> : [];
  const title = String(titleItems[0]?.title ?? attributes.title ?? '');
  if (!doi || !title.trim()) return undefined;
  const creators = Array.isArray(attributes.creators) ? attributes.creators.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const candidate = item as Record<string, unknown>;
    const family = String(candidate.familyName ?? candidate.name ?? '');
    if (!family) return [];
    const given = typeof candidate.givenName === 'string' ? candidate.givenName : undefined;
    return [{ family, ...(given ? { given } : {}) }];
  }) : [];
  const container = typeof attributes.container === 'object' && attributes.container !== null ? String((attributes.container as Record<string, unknown>).title ?? '') : '';
  const issuedYear = yearFrom(attributes.publicationYear ?? attributes.published);
  return {
    schemaVersion: 1,
    canonicalId: `doi:${doi}`,
    itemType: itemType(typeof attributes.types === 'object' && attributes.types !== null ? (attributes.types as Record<string, unknown>).resourceTypeGeneral : undefined),
    title: decodeXml(title),
    creators,
    ...(issuedYear ? { issuedYear } : {}),
    ...(container ? { containerTitle: container } : {}),
    ...(typeof attributes.publisher === 'string' ? { publisher: attributes.publisher } : {}),
    doi,
    ...(typeof attributes.url === 'string' ? { url: attributes.url } : {}),
    retractionStatus: retractionFrom(attributes),
    source: 'datacite',
    sourceUrl: `https://api.datacite.org/dois/${encodeURIComponent(doi)}`,
    retrievedAt: new Date().toISOString(),
  };
}

function pubmedRecord(pmid: string, item: Record<string, unknown>): BibliographicRecordV1 | undefined {
  const title = decodeXml(String(item.title ?? ''));
  if (!title) return undefined;
  const articleIds = Array.isArray(item.articleids) ? item.articleids as Array<Record<string, unknown>> : [];
  const doi = articleIds.find((identifier) => identifier.idtype === 'doi')?.value;
  const authors = Array.isArray(item.authors) ? item.authors.flatMap((author) => {
    if (typeof author !== 'object' || author === null) return [];
    const name = String((author as Record<string, unknown>).name ?? '').trim();
    if (!name) return [];
    const tokens = name.split(/\s+/u);
    return [{ family: tokens[0] ?? name, ...(tokens.length > 1 ? { given: tokens.slice(1).join(' ') } : {}) }];
  }) : [];
  const issuedYear = yearFrom(item.pubdate ?? item.sortpubdate);
  return {
    schemaVersion: 1,
    canonicalId: `pmid:${pmid}`,
    itemType: 'journalArticle',
    title,
    creators: authors,
    ...(issuedYear ? { issuedYear } : {}),
    ...(typeof item.fulljournalname === 'string' ? { containerTitle: item.fulljournalname } : {}),
    ...(typeof item.volume === 'string' ? { volume: item.volume } : {}),
    ...(typeof item.issue === 'string' ? { issue: item.issue } : {}),
    ...(typeof item.pages === 'string' ? { pages: item.pages } : {}),
    ...(typeof doi === 'string' ? { doi: cleanDoi(doi) } : {}),
    pmid,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    retractionStatus: retractionFrom(item),
    source: 'pubmed',
    sourceUrl: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`,
    retrievedAt: new Date().toISOString(),
  };
}

function arxivRecord(identifier: string, xml: string): BibliographicRecordV1 | undefined {
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/u)?.[1];
  if (!entry) return undefined;
  const title = decodeXml(entry.match(/<title>([\s\S]*?)<\/title>/u)?.[1] ?? '');
  if (!title) return undefined;
  const creators = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gu)].map((match) => {
    const name = decodeXml(match[1] ?? '');
    const tokens = name.split(/\s+/u);
    return { family: tokens.at(-1) ?? name, ...(tokens.length > 1 ? { given: tokens.slice(0, -1).join(' ') } : {}) };
  });
  const abstract = decodeXml(entry.match(/<summary>([\s\S]*?)<\/summary>/u)?.[1] ?? '');
  const published = decodeXml(entry.match(/<published>([\s\S]*?)<\/published>/u)?.[1] ?? '');
  const doi = decodeXml(entry.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/u)?.[1] ?? '');
  const arxivId = identifier.replace(/v\d+$/iu, '');
  const issuedYear = yearFrom(published);
  return {
    schemaVersion: 1,
    canonicalId: `arxiv:${arxivId.toLocaleLowerCase()}`,
    itemType: 'preprint',
    title,
    creators,
    ...(issuedYear ? { issuedYear } : {}),
    ...(doi ? { doi: cleanDoi(doi) } : {}),
    arxivId,
    url: `https://arxiv.org/abs/${arxivId}`,
    ...(abstract ? { abstract } : {}),
    retractionStatus: retractionFrom(entry),
    source: 'arxiv',
    sourceUrl: `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`,
    retrievedAt: new Date().toISOString(),
  };
}

function responseSize(response: Response, fallback: number): number {
  const declared = Number(response.headers.get('content-length'));
  return Number.isFinite(declared) && declared >= 0 ? declared : fallback;
}

async function responseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maxBytes) throw new Error(`书目服务响应超过 ${Math.floor(maxBytes / (1024 * 1024))} MB`);
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export class BibliographyService {
  readonly #fetch: FetchLike;
  readonly #cacheRoot: string;
  readonly #searchLocal: (query: BibliographyQueryV1) => Promise<BibliographicRecordV1[]>;
  readonly #attachments = new Map<string, StoredAttachment>();

  constructor(options: {
    cacheRoot: string;
    fetch?: FetchLike;
    searchLocal?: (query: BibliographyQueryV1) => Promise<BibliographicRecordV1[]>;
  }) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#cacheRoot = options.cacheRoot;
    this.#searchLocal = options.searchLocal ?? (async () => []);
    mkdirSync(this.#cacheRoot, { recursive: true });
  }

  attachment(id: string): StoredAttachment | undefined {
    const value = this.#attachments.get(id);
    return value ? structuredClone(value) : undefined;
  }

  async #request(url: string, options: { signal?: AbortSignal; allowedHosts?: ReadonlySet<string>; maxBytes?: number } = {}): Promise<{ response: Response; bytes: Buffer }> {
    const parsed = new URL(url);
    const allowed = options.allowedHosts ?? METADATA_HOSTS;
    if (parsed.protocol !== 'https:' || !allowed.has(parsed.hostname.toLocaleLowerCase())) throw new Error(`书目宿主拒绝访问未授权域名：${parsed.hostname}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException('Bibliography request timed out', 'TimeoutError')), 15_000);
    const relayAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', relayAbort, { once: true });
    try {
      const response = await this.#fetch(parsed, {
        headers: { Accept: 'application/json, application/atom+xml;q=0.9, application/pdf;q=0.8', 'User-Agent': 'Sci-Workplace/0.1 (citation metadata resolver)' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`书目服务返回 HTTP ${response.status}`);
      const maxBytes = options.maxBytes ?? MAX_METADATA_BYTES;
      if (responseSize(response, 0) > maxBytes) throw new Error('书目服务响应超过大小限制');
      return { response, bytes: await responseBytes(response, maxBytes) };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', relayAbort);
    }
  }

  async #json(url: string): Promise<unknown> {
    const { bytes } = await this.#request(url);
    return JSON.parse(bytes.toString('utf8')) as unknown;
  }

  async #crossrefByDoi(doi: string): Promise<BibliographicRecordV1 | undefined> {
    const value = await this.#json(`https://api.crossref.org/works/${encodeURIComponent(cleanDoi(doi))}`) as Record<string, unknown>;
    return typeof value.message === 'object' && value.message !== null ? crossrefRecord(value.message as Record<string, unknown>) : undefined;
  }

  async #dataciteByDoi(doi: string): Promise<BibliographicRecordV1 | undefined> {
    const value = await this.#json(`https://api.datacite.org/dois/${encodeURIComponent(cleanDoi(doi))}`) as Record<string, unknown>;
    return typeof value.data === 'object' && value.data !== null ? dataciteRecord(value.data as Record<string, unknown>) : undefined;
  }

  async #pubmedById(pmid: string): Promise<BibliographicRecordV1 | undefined> {
    const value = await this.#json(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json`) as Record<string, unknown>;
    const result = typeof value.result === 'object' && value.result !== null ? value.result as Record<string, unknown> : {};
    const item = typeof result[pmid] === 'object' && result[pmid] !== null ? result[pmid] as Record<string, unknown> : undefined;
    return item ? pubmedRecord(pmid, item) : undefined;
  }

  async #arxivById(identifier: string): Promise<BibliographicRecordV1 | undefined> {
    const id = identifier.replace(/v\d+$/iu, '');
    const { bytes } = await this.#request(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
    return arxivRecord(id, bytes.toString('utf8'));
  }

  async #crossrefByTitle(title: string, limit: number): Promise<BibliographicRecordV1[]> {
    const value = await this.#json(`https://api.crossref.org/works?query.title=${encodeURIComponent(title)}&rows=${Math.min(limit, MAX_CANDIDATES)}&select=DOI,title,author,issued,published,container-title,volume,issue,page,publisher,URL,abstract,type,relation,update-to`) as Record<string, unknown>;
    const message = typeof value.message === 'object' && value.message !== null ? value.message as Record<string, unknown> : {};
    const items = Array.isArray(message.items) ? message.items : [];
    return items.flatMap((item) => typeof item === 'object' && item !== null ? [crossrefRecord(item as Record<string, unknown>)].filter((record): record is BibliographicRecordV1 => Boolean(record)) : []);
  }

  async #resolveQuery(query: BibliographyQueryV1, limit: number): Promise<BibliographyResolutionV1> {
    const doi = query.doi ? cleanDoi(query.doi) : cleanDoi(query.raw.match(DOI_IN_TEXT)?.[1] ?? '');
    const pmid = query.pmid ?? query.raw.match(PMID_IN_TEXT)?.[1];
    const arxivId = query.arxivId ?? query.raw.match(ARXIV_IN_TEXT)?.[1];
    const title = query.title?.trim();
    const issues: string[] = [];
    const candidates: BibliographyCandidateV1[] = [];
    const local = await this.#searchLocal({ ...query, ...(doi ? { doi } : {}), ...(pmid ? { pmid } : {}), ...(arxivId ? { arxivId } : {}) });
    for (const record of local) candidates.push({ record, match: doi || pmid || arxivId || (query.manager === 'zotero' && query.managerKey) ? 'exact_identifier' : normalizedTitle(record.title) === normalizedTitle(title ?? '') ? 'exact_title' : 'candidate', score: 1 });
    try {
      if (doi) {
        const record = await this.#crossrefByDoi(doi).catch(async () => await this.#dataciteByDoi(doi));
        if (record) candidates.push({ record, match: 'exact_identifier', score: 1 });
      } else if (pmid) {
        const record = await this.#pubmedById(pmid);
        if (record) candidates.push({ record, match: 'exact_identifier', score: 1 });
      } else if (arxivId) {
        const record = await this.#arxivById(arxivId);
        if (record) candidates.push({ record, match: 'exact_identifier', score: 1 });
      } else if (title) {
        for (const record of await this.#crossrefByTitle(title, limit)) {
          const exact = normalizedTitle(record.title) === normalizedTitle(title);
          candidates.push({ record, match: exact ? 'exact_title' : 'candidate', score: exact ? 1 : 0 });
        }
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
    const unique = [...new Map(candidates.map((candidate) => [candidate.record.canonicalId, candidate])).values()];
    const exact = unique.filter((candidate) => candidate.match === 'exact_identifier' || candidate.match === 'exact_title');
    if (exact.length === 1) return { queryId: query.id, status: 'resolved', match: exact[0]!.match === 'exact_identifier' ? 'exact_identifier' : 'exact_title', record: exact[0]!.record, candidates: unique.slice(0, limit), issues };
    if (exact.length > 1) return { queryId: query.id, status: 'ambiguous', match: 'none', candidates: unique.slice(0, limit), issues: [...issues, '多个权威来源返回不同的精确标识'] };
    if (unique.length > 0) return { queryId: query.id, status: 'ambiguous', match: 'none', candidates: unique.slice(0, limit), issues: [...issues, '仅有模糊候选，未达到自动应用阈值'] };
    return { queryId: query.id, status: 'unrecognized', match: 'none', candidates: [], issues: issues.length > 0 ? issues : ['没有唯一的 DOI、PMID、arXiv ID 或完整题名匹配'] };
  }

  async resolve(request: BibliographyResolveRequestV1): Promise<BibliographyResolutionV1[]> {
    if (!Array.isArray(request.queries) || request.queries.length === 0 || request.queries.length > MAX_QUERIES) throw new Error(`一次解析必须包含 1–${MAX_QUERIES} 个引用查询`);
    const ids = request.queries.map((query) => query.id);
    if (new Set(ids).size !== ids.length || ids.some((id) => !id.trim())) throw new Error('引用查询 ID 必须非空且唯一');
    const limit = Math.max(1, Math.min(MAX_CANDIDATES, Math.trunc(request.maxCandidates ?? MAX_CANDIDATES)));
    const output: BibliographyResolutionV1[] = [];
    for (const query of request.queries) output.push(await this.#resolveQuery(query, limit));
    return output;
  }

  async verifyMetadata(record: BibliographicRecordV1): Promise<BibliographyVerificationV1> {
    const query: BibliographyQueryV1 = {
      id: `verify:${record.canonicalId}`,
      raw: record.title,
      ...(record.doi ? { doi: record.doi } : {}),
      ...(record.pmid ? { pmid: record.pmid } : {}),
      ...(record.arxivId ? { arxivId: record.arxivId } : {}),
      ...(!record.doi && !record.pmid && !record.arxivId ? { title: record.title } : {}),
    };
    const resolved = await this.#resolveQuery(query, 3);
    if (resolved.status !== 'resolved' || !resolved.record) return { status: 'incomplete', record, issues: resolved.issues, verifiedAt: new Date().toISOString() };
    const authoritative = resolved.record;
    const issues: string[] = [];
    if (normalizedTitle(authoritative.title) !== normalizedTitle(record.title)) issues.push('题名与权威元数据不一致');
    if (record.issuedYear && authoritative.issuedYear && record.issuedYear !== authoritative.issuedYear) issues.push('出版年份不一致');
    if (authoritative.retractionStatus !== 'clear') issues.push(`权威来源状态为 ${authoritative.retractionStatus}`);
    return {
      status: issues.length > 0 ? 'conflict' : 'verified',
      record: authoritative,
      issues,
      verifiedAt: new Date().toISOString(),
    };
  }

  async fetchOpenAccess(record: BibliographicRecordV1): Promise<OaAttachmentReceiptV1> {
    if (!record.doi && !record.arxivId && !record.pmid) return { schemaVersion: 1, status: 'unavailable', reason: '没有可用于开放获取检索的 DOI、arXiv ID 或 PMID' };
    let pdfUrl: string | undefined;
    let license: string | undefined;
    if (record.arxivId) {
      pdfUrl = `https://arxiv.org/pdf/${encodeURIComponent(record.arxivId)}.pdf`;
      license = 'arXiv non-exclusive distribution license or item-declared license';
    } else if (record.doi) {
      try {
        const value = await this.#json(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(cleanDoi(record.doi))}`) as Record<string, unknown>;
        const openAccess = typeof value.open_access === 'object' && value.open_access !== null ? value.open_access as Record<string, unknown> : {};
        const location = typeof value.best_oa_location === 'object' && value.best_oa_location !== null ? value.best_oa_location as Record<string, unknown> : {};
        if (openAccess.is_oa === true && typeof location.pdf_url === 'string') {
          pdfUrl = location.pdf_url;
          license = typeof location.license === 'string' ? location.license : undefined;
        }
      } catch (error) {
        return { schemaVersion: 1, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!pdfUrl) return { schemaVersion: 1, status: 'unavailable', reason: '权威 OA 元数据没有提供合法 PDF 地址' };
    let parsed: URL;
    try { parsed = new URL(pdfUrl); } catch { return { schemaVersion: 1, status: 'rejected', reason: 'OA PDF 地址无效' }; }
    if (parsed.protocol !== 'https:' || !OA_PDF_HOSTS.has(parsed.hostname.toLocaleLowerCase())) return { schemaVersion: 1, status: 'rejected', sourceUrl: pdfUrl, ...(license ? { license } : {}), reason: 'OA 地址不在 Harness 允许的开放仓储域名列表中' };
    try {
      const { response, bytes } = await this.#request(parsed.href, { allowedHosts: OA_PDF_HOSTS, maxBytes: MAX_ATTACHMENT_BYTES });
      const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLocaleLowerCase() ?? '';
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) || (mediaType && mediaType !== 'application/pdf' && mediaType !== 'application/octet-stream')) throw new Error('OA 附件不是可验证的 PDF');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const id = `oa_${digest.slice(0, 24)}`;
      const path = join(this.#cacheRoot, `${digest}.pdf`);
      let cacheStatus: 'downloaded' | 'available' = 'downloaded';
      try {
        writeFileSync(path, bytes, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existingBytes = readFileSync(path);
        if (existingBytes.length !== bytes.length || createHash('sha256').update(existingBytes).digest('hex') !== digest) throw new Error('OA 缓存文件与内容寻址校验和不一致');
        cacheStatus = 'available';
      }
      const attachment: StoredAttachment = { id, path, sha256: digest, sourceUrl: parsed.href, mediaType: 'application/pdf', ...(license ? { license } : {}), size: bytes.length };
      this.#attachments.set(id, attachment);
      return { schemaVersion: 1, status: cacheStatus, attachmentId: id, sourceUrl: parsed.href, ...(license ? { license } : {}), mediaType: 'application/pdf', sha256: digest, size: bytes.length };
    } catch (error) {
      const candidatePath = [...this.#attachments.values()].find((attachment) => attachment.sourceUrl === parsed.href)?.path;
      if (candidatePath && extname(candidatePath) === '.pdf') {
        const bytes = readFileSync(candidatePath);
        const digest = createHash('sha256').update(bytes).digest('hex');
        const existing = [...this.#attachments.values()].find((attachment) => attachment.sha256 === digest);
        if (existing && statSync(existing.path).isFile()) return { schemaVersion: 1, status: 'available', attachmentId: existing.id, sourceUrl: existing.sourceUrl, ...(existing.license ? { license: existing.license } : {}), mediaType: existing.mediaType, sha256: existing.sha256, size: existing.size };
      }
      return { schemaVersion: 1, status: 'unavailable', sourceUrl: parsed.href, ...(license ? { license } : {}), reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
