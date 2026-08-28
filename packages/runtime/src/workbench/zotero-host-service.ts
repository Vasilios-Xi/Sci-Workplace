import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type {
  BibliographicCreatorV1,
  BibliographicRecordV1,
  CitationDocumentPlanV1,
  CitationMaterializationReceiptV1,
  ZoteroItemV1,
  ZoteroSearchRequestV1,
  ZoteroStatusV1,
  ZoteroSyncItemReceiptV1,
  ZoteroSyncOperationV1,
  ZoteroSyncPlanRequestV1,
  ZoteroSyncPlanV1,
  ZoteroSyncReceiptV1,
} from '@openlab/protocol';
import type { CitationDocumentService } from './citation-document-service.js';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const ZOTERO_ORIGIN = 'http://127.0.0.1:23119';
const PLAN_TTL_MS = 15 * 60_000;
const MAX_SYNC_ITEMS = 2_000;
const MAX_ATTACHMENTS = 2_000;

interface RawZoteroItem extends ZoteroItemV1 {
  version?: number;
  collections: string[];
  data: Record<string, unknown>;
}

interface PendingPlan {
  public: ZoteroSyncPlanV1;
  request: ZoteroSyncPlanRequestV1;
  fingerprint: string;
  status: ZoteroStatusV1;
}

interface AttachmentDescriptor {
  id: string;
  path: string;
  sha256: string;
  sourceUrl: string;
  mediaType: string;
  license?: string;
  size: number;
}

interface NativeAuthorization {
  serverId: string;
  key: string;
  remember: boolean;
}

function normalizeTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
}

function cleanDoi(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '').replace(/^doi\s*:\s*/iu, '').replace(/[.,;:]+$/u, '').toLocaleLowerCase();
  return normalized || undefined;
}

function yearFromDate(value: unknown): number | undefined {
  const match = String(value ?? '').match(/\b(?:19|20)\d{2}\b/u)?.[0];
  return match ? Number(match) : undefined;
}

function creatorFromZotero(value: unknown): BibliographicCreatorV1 | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  const family = String(item.lastName ?? item.name ?? '').trim();
  if (!family) return undefined;
  const given = String(item.firstName ?? '').trim();
  return { family, ...(given ? { given } : {}) };
}

function parseItem(value: unknown): RawZoteroItem | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const envelope = value as Record<string, unknown>;
  const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data as Record<string, unknown> : envelope;
  const key = String(envelope.key ?? data.key ?? '').trim();
  const title = String(data.title ?? '').trim();
  if (!key || !title) return undefined;
  const library = typeof envelope.library === 'object' && envelope.library !== null ? envelope.library as Record<string, unknown> : {};
  const libraryId = Number(library.id ?? envelope.libraryID ?? 0);
  const extra = String(data.extra ?? '');
  const pmid = extra.match(/(?:^|\n)PMID\s*:\s*(\d{5,9})(?:\n|$)/iu)?.[1];
  const arxivId = extra.match(/(?:^|\n)arXiv\s*:\s*([^\s\n]+)/iu)?.[1];
  const collections = Array.isArray(data.collections) ? data.collections.filter((item): item is string => typeof item === 'string') : [];
  const issuedYear = yearFromDate(data.date);
  const doi = cleanDoi(typeof data.DOI === 'string' ? data.DOI : undefined);
  const explicitUri = typeof data.uri === 'string' && /^https?:\/\/(?:www\.)?zotero\.org\/(?:users|groups)\//u.test(data.uri)
    ? data.uri.replace(/^https:\/\/(?:www\.)?zotero\.org/u, 'http://zotero.org')
    : undefined;
  return {
    key,
    uri: explicitUri ?? `http://zotero.org/users/local/sci-workplace/items/${key}`,
    libraryId: Number.isFinite(libraryId) ? libraryId : 0,
    title,
    creators: Array.isArray(data.creators) ? data.creators.map(creatorFromZotero).filter((item): item is BibliographicCreatorV1 => Boolean(item)) : [],
    ...(issuedYear ? { issuedYear } : {}),
    ...(doi ? { doi } : {}),
    ...(pmid ? { pmid } : {}),
    ...(arxivId ? { arxivId } : {}),
    ...(typeof data.url === 'string' && data.url ? { url: data.url } : {}),
    ...(Number.isInteger(Number(envelope.version ?? data.version)) ? { version: Number(envelope.version ?? data.version) } : {}),
    collections,
    data,
  };
}

function recordKey(record: BibliographicRecordV1): string {
  if (record.doi) return `doi:${cleanDoi(record.doi)}`;
  if (record.pmid) return `pmid:${record.pmid}`;
  if (record.arxivId) return `arxiv:${record.arxivId.replace(/v\d+$/iu, '').toLocaleLowerCase()}`;
  const author = record.creators[0]?.family ?? '';
  return `title:${normalizeTitle(record.title)}:${record.issuedYear ?? ''}:${normalizeTitle(author)}`;
}

function itemMatchesRecord(item: ZoteroItemV1, record: BibliographicRecordV1): boolean {
  if (record.doi && item.doi) return cleanDoi(record.doi) === cleanDoi(item.doi);
  if (record.pmid && item.pmid) return record.pmid === item.pmid;
  if (record.arxivId && item.arxivId) return record.arxivId.replace(/v\d+$/iu, '').toLocaleLowerCase() === item.arxivId.replace(/v\d+$/iu, '').toLocaleLowerCase();
  return normalizeTitle(record.title) === normalizeTitle(item.title)
    && (record.issuedYear ?? 0) === (item.issuedYear ?? 0)
    && normalizeTitle(record.creators[0]?.family ?? '') === normalizeTitle(item.creators[0]?.family ?? '');
}

function zoteroType(record: BibliographicRecordV1): string {
  switch (record.itemType) {
    case 'journalArticle': return 'journalArticle';
    case 'conferencePaper': return 'conferencePaper';
    case 'book': return 'book';
    case 'bookSection': return 'bookSection';
    case 'thesis': return 'thesis';
    case 'report': return 'report';
    case 'preprint': return 'preprint';
    default: return 'document';
  }
}

function zoteroData(record: BibliographicRecordV1, collectionKey: string): Record<string, unknown> {
  const extra = [record.pmid ? `PMID: ${record.pmid}` : '', record.arxivId ? `arXiv: ${record.arxivId}` : ''].filter(Boolean).join('\n');
  return {
    itemType: zoteroType(record),
    title: record.title,
    creators: record.creators.map((author) => ({ creatorType: 'author', lastName: author.family, firstName: author.given ?? '' })),
    date: record.issuedYear ? String(record.issuedYear) : '',
    publicationTitle: record.containerTitle ?? '',
    volume: record.volume ?? '',
    issue: record.issue ?? '',
    pages: record.pages ?? '',
    publisher: record.publisher ?? '',
    DOI: record.doi ?? '',
    url: record.url ?? record.sourceUrl ?? '',
    abstractNote: record.abstract ?? '',
    extra,
    collections: [collectionKey],
    tags: [],
  };
}

function publicItem(item: RawZoteroItem): ZoteroItemV1 {
  const { version: _version, collections: _collections, data: _data, ...publicValue } = item;
  return publicValue;
}

function fingerprint(request: ZoteroSyncPlanRequestV1): string {
  const stable = JSON.stringify({
    operationKey: request.operationKey,
    sourceSha256: request.sourceSha256,
    target: request.target,
    items: request.items.map((item) => ({ key: recordKey(item.record), attachments: [...(item.attachmentIds ?? [])].sort() })),
  });
  return createHash('sha256').update(stable).digest('hex');
}

export class ZoteroHostService {
  readonly #fetch: FetchLike;
  readonly #documents: CitationDocumentService;
  readonly #attachment: (id: string) => AttachmentDescriptor | undefined;
  readonly #companionPath: string | undefined;
  readonly #requestTimeoutMs: number;
  readonly #pairingTimeoutMs: number;
  readonly #syncTimeoutMs: number;
  readonly #plans = new Map<string, PendingPlan>();
  readonly #plansByOperation = new Map<string, string>();
  readonly #receipts = new Map<string, ZoteroSyncReceiptV1>();
  #nativeAuthorization: NativeAuthorization | undefined;
  #companionToken: string | undefined;

  constructor(options: {
    documents: CitationDocumentService;
    attachment: (id: string) => AttachmentDescriptor | undefined;
    fetch?: FetchLike;
    companionPath?: string;
    requestTimeoutMs?: number;
    pairingTimeoutMs?: number;
    syncTimeoutMs?: number;
  }) {
    this.#documents = options.documents;
    this.#attachment = options.attachment;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#companionPath = options.companionPath;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#pairingTimeoutMs = options.pairingTimeoutMs ?? 120_000;
    this.#syncTimeoutMs = options.syncTimeoutMs ?? 120_000;
  }

  async #request(path: string, init: RequestInit = {}, retries = 1, timeoutMs = this.#requestTimeoutMs): Promise<Response> {
    if (!path.startsWith('/')) throw new Error('Zotero 本地请求路径无效');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException('Zotero request timed out', 'TimeoutError')), timeoutMs);
    try {
      const response = await this.#fetch(`${ZOTERO_ORIGIN}${path}`, { ...init, redirect: 'error', signal: controller.signal });
      if (response.status === 503 && retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return await this.#request(path, init, retries - 1, timeoutMs);
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  async status(): Promise<ZoteroStatusV1> {
    try {
      const companion = await this.#request('/sci-workplace/v1/status', { headers: { Accept: 'application/json' } }, 0);
      if (companion.ok) {
        const data = await companion.json() as Record<string, unknown>;
        const version = typeof data.zoteroVersion === 'string' ? data.zoteroVersion : typeof data.version === 'string' ? data.version : undefined;
        return { schemaVersion: 1, available: true, ...(version ? { version } : {}), mode: 'companion', capabilities: ['read', 'write', 'collections', 'attachments', 'document-fields'] };
      }
    } catch { /* companion is optional */ }
    try {
      const response = await this.#request('/api/', { headers: { Accept: 'application/json', 'Zotero-API-Version': '3' } }, 0);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const serverId = response.headers.get('zotero-server-id') ?? undefined;
      const version = response.headers.get('zotero-version') ?? undefined;
      if (serverId) return { schemaVersion: 1, available: true, ...(version ? { version } : {}), serverId, mode: 'native-local-api', capabilities: ['read', 'write', 'collections', 'attachments', 'document-fields'] };
      return {
        schemaVersion: 1,
        available: true,
        ...(version ? { version } : {}),
        mode: 'read-only',
        capabilities: ['read'],
        setup: { required: true, message: '当前 Zotero 不支持 Local API 写入；请安装 Sci Workplace Zotero 9 companion 或升级到 Zotero 10+', ...(this.#companionPath ? { companionPath: this.#companionPath } : {}) },
      };
    } catch {
      return {
        schemaVersion: 1,
        available: false,
        mode: 'unavailable',
        capabilities: [],
        setup: { required: true, message: '未检测到 Zotero。请启动 Zotero 并允许本机应用通信。', ...(this.#companionPath ? { companionPath: this.#companionPath } : {}) },
      };
    }
  }

  async #readItems(request: ZoteroSearchRequestV1): Promise<RawZoteroItem[]> {
    const status = await this.status();
    if (!status.available) return [];
    if (status.mode === 'companion') {
      await this.#ensureCompanionToken();
      const response = await this.#request('/sci-workplace/v1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#companionToken}` },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error(`Zotero companion 检索失败：HTTP ${response.status}`);
      const value = await response.json() as unknown;
      const items = Array.isArray(value) ? value : typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>).items) ? (value as Record<string, unknown>).items as unknown[] : [];
      return items.map(parseItem).filter((item): item is RawZoteroItem => Boolean(item));
    }
    if (request.key) {
      const item = await this.#nativeItem(request.key, status);
      return item ? [item] : [];
    }
    const query = request.doi ?? request.pmid ?? request.arxivId ?? request.title ?? request.query ?? '';
    const params = new URLSearchParams({ format: 'json', itemType: '-attachment', limit: String(Math.max(1, Math.min(100, Math.trunc(request.limit ?? 25)))) });
    if (query) params.set('q', query);
    const response = await this.#request(`/api/users/0/items?${params.toString()}`, { headers: { Accept: 'application/json', 'Zotero-API-Version': '3', ...(status.serverId ? { 'Zotero-Server-ID': status.serverId } : {}) } });
    if (!response.ok) throw new Error(`Zotero 检索失败：HTTP ${response.status}`);
    const value = await response.json() as unknown;
    return (Array.isArray(value) ? value : []).map(parseItem).filter((item): item is RawZoteroItem => Boolean(item));
  }

  async search(request: ZoteroSearchRequestV1): Promise<ZoteroItemV1[]> {
    const items = await this.#readItems(request);
    const exact = items.filter((item) => {
      if (request.key) return item.key === request.key;
      if (request.doi) return cleanDoi(item.doi) === cleanDoi(request.doi);
      if (request.pmid) return item.pmid === request.pmid;
      if (request.arxivId) return item.arxivId?.replace(/v\d+$/iu, '').toLocaleLowerCase() === request.arxivId.replace(/v\d+$/iu, '').toLocaleLowerCase();
      if (request.title) return normalizeTitle(item.title) === normalizeTitle(request.title);
      return true;
    });
    return (request.doi || request.pmid || request.arxivId || request.title ? exact : items).map(publicItem);
  }

  async planSync(request: ZoteroSyncPlanRequestV1): Promise<ZoteroSyncPlanV1> {
    if (request.schemaVersion !== 1 || !request.operationKey.trim() || !/^[a-f0-9]{64}$/u.test(request.sourceSha256)) throw new Error('Zotero 同步预览参数无效');
    if (!Array.isArray(request.items) || request.items.length > MAX_SYNC_ITEMS) throw new Error(`Zotero 同步一次最多 ${MAX_SYNC_ITEMS} 个条目`);
    const attachmentCount = request.items.reduce((total, item) => total + (item.attachmentIds?.length ?? 0), 0);
    if (attachmentCount > MAX_ATTACHMENTS) throw new Error(`Zotero 同步一次最多 ${MAX_ATTACHMENTS} 个附件`);
    const currentFingerprint = fingerprint(request);
    const existingId = this.#plansByOperation.get(request.operationKey);
    const existing = existingId ? this.#plans.get(existingId) : undefined;
    if (existing && existing.fingerprint === currentFingerprint && Date.parse(existing.public.expiresAt) > Date.now()) return structuredClone(existing.public);
    if (existing && existing.fingerprint !== currentFingerprint) throw new Error('同一 operationKey 已绑定不同的文件修订、集合或条目；必须重新生成运行键');
    const status = await this.status();
    const operations: ZoteroSyncOperationV1[] = [];
    for (const item of request.items) {
      const record = item.record;
      const matches = (await this.#readItems({
        ...(record.doi ? { doi: record.doi } : {}),
        ...(record.pmid ? { pmid: record.pmid } : {}),
        ...(record.arxivId ? { arxivId: record.arxivId } : {}),
        ...(!record.doi && !record.pmid && !record.arxivId ? { title: record.title } : {}),
        limit: 25,
      })).filter((candidate) => itemMatchesRecord(candidate, record));
      if (matches.length === 0) operations.push({ canonicalId: record.canonicalId, action: 'create', attachmentCount: item.attachmentIds?.length ?? 0 });
      else if (matches.length === 1) operations.push({ canonicalId: record.canonicalId, action: 'reuse', existingItemKey: matches[0]!.key, attachmentCount: item.attachmentIds?.length ?? 0 });
      else operations.push({ canonicalId: record.canonicalId, action: 'conflict', attachmentCount: item.attachmentIds?.length ?? 0, reason: 'Zotero 库中存在多个精确重复候选' });
    }
    const id = `zplan_${createHash('sha256').update(`${currentFingerprint}\0${status.serverId ?? status.mode}`).digest('hex').slice(0, 28)}`;
    const publicPlan: ZoteroSyncPlanV1 = {
      schemaVersion: 1,
      id,
      operationKey: request.operationKey,
      sourceSha256: request.sourceSha256,
      target: structuredClone(request.target),
      operations,
      expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
    };
    this.#plans.set(id, { public: publicPlan, request: structuredClone(request), fingerprint: currentFingerprint, status });
    this.#plansByOperation.set(request.operationKey, id);
    return structuredClone(publicPlan);
  }

  async #ensureCompanionToken(): Promise<void> {
    if (this.#companionToken) return;
    const nonce = randomBytes(24).toString('base64url');
    const response = await this.#request('/sci-workplace/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appName: 'Sci Workplace', nonce }) }, 0, this.#pairingTimeoutMs);
    if (!response.ok) throw new Error(`Zotero companion 配对失败：HTTP ${response.status}`);
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.sessionKey !== 'string' || data.sessionKey.length < 24 || data.nonce !== nonce) throw new Error('Zotero companion 返回无效会话密钥');
    this.#companionToken = data.sessionKey;
  }

  async #authorizeNative(status: ZoteroStatusV1, force = false): Promise<NativeAuthorization> {
    if (!status.serverId) throw new Error('Zotero 10 Local API 缺少 Server ID');
    if (!force && this.#nativeAuthorization?.serverId === status.serverId) return this.#nativeAuthorization;
    const response = await this.#request('/api/local/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Zotero-Server-ID': status.serverId },
      body: JSON.stringify({ appName: 'Sci Workplace' }),
    });
    if (!response.ok) throw new Error(response.status === 403 ? '用户拒绝了 Zotero 写入授权' : `Zotero 写入授权失败：HTTP ${response.status}`);
    const value = await response.json() as Record<string, unknown>;
    if (typeof value.key !== 'string' || value.key.length < 16) throw new Error('Zotero 返回无效本地 API 密钥');
    this.#nativeAuthorization = { serverId: status.serverId, key: value.key, remember: value.remember === true };
    return this.#nativeAuthorization;
  }

  async #nativeWrite(path: string, status: ZoteroStatusV1, init: RequestInit, retryAuth = true): Promise<Response> {
    const authorization = await this.#authorizeNative(status);
    const headers = new Headers(init.headers);
    headers.set('Zotero-API-Version', '3');
    headers.set('Zotero-Server-ID', authorization.serverId);
    headers.set('Zotero-API-Key', authorization.key);
    headers.set('Zotero-Write-Token', randomUUID());
    const response = await this.#request(path, { ...init, headers });
    if (response.status === 401 && retryAuth) {
      this.#nativeAuthorization = undefined;
      await this.#authorizeNative(status, true);
      return await this.#nativeWrite(path, status, init, false);
    }
    return response;
  }

  async #nativeCollections(status: ZoteroStatusV1): Promise<Array<Record<string, unknown>>> {
    const response = await this.#request('/api/users/0/collections?format=json', { headers: { Accept: 'application/json', 'Zotero-API-Version': '3', ...(status.serverId ? { 'Zotero-Server-ID': status.serverId } : {}) } });
    if (!response.ok) throw new Error(`读取 Zotero 集合失败：HTTP ${response.status}`);
    const value = await response.json() as unknown;
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : [];
  }

  async #nativeItem(itemKey: string, status: ZoteroStatusV1): Promise<RawZoteroItem | undefined> {
    const response = await this.#request(`/api/users/0/items/${encodeURIComponent(itemKey)}`, { headers: { Accept: 'application/json', 'Zotero-API-Version': '3', ...(status.serverId ? { 'Zotero-Server-ID': status.serverId } : {}) } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`读取 Zotero 条目失败：HTTP ${response.status}`);
    return parseItem(await response.json());
  }

  async #nativeItemUri(itemKey: string, status: ZoteroStatusV1): Promise<string> {
    const response = await this.#request(`/api/users/0/items/${encodeURIComponent(itemKey)}?format=csljson`, { headers: { Accept: 'application/json', 'Zotero-API-Version': '3', ...(status.serverId ? { 'Zotero-Server-ID': status.serverId } : {}) } });
    if (!response.ok) throw new Error(`读取 Zotero CSL URI 失败：HTTP ${response.status}`);
    const value = await response.json() as unknown;
    const candidate = Array.isArray(value) ? value[0] : value;
    const uri = typeof candidate === 'object' && candidate !== null ? String((candidate as Record<string, unknown>).id ?? (candidate as Record<string, unknown>).uri ?? '') : '';
    if (!/^https?:\/\/(?:www\.)?zotero\.org\/(?:users|groups)\/[^/]+\/items\/[A-Z0-9]+$/iu.test(uri)) throw new Error('Zotero 未返回可用于动态引用的规范条目 URI');
    return uri.replace(/^https:\/\/(?:www\.)?zotero\.org/iu, 'http://zotero.org');
  }

  async #existingNativeAttachment(parentItemKey: string, descriptor: AttachmentDescriptor, status: ZoteroStatusV1): Promise<string | undefined> {
    const response = await this.#request(`/api/users/0/items/${encodeURIComponent(parentItemKey)}/children?format=json&itemType=attachment&limit=100`, { headers: { Accept: 'application/json', 'Zotero-API-Version': '3', ...(status.serverId ? { 'Zotero-Server-ID': status.serverId } : {}) } });
    if (!response.ok) throw new Error(`读取 Zotero 附件失败：HTTP ${response.status}`);
    const value = await response.json() as unknown;
    if (!Array.isArray(value)) return undefined;
    const marker = `Sci-Workplace-OA-SHA256: ${descriptor.sha256}`;
    const tag = `sci-workplace-oa:${descriptor.sha256}`;
    for (const candidate of value) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const envelope = candidate as Record<string, unknown>;
      const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data as Record<string, unknown> : envelope;
      const tags = Array.isArray(data.tags) ? data.tags : [];
      const matchesTag = tags.some((entry) => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).tag === tag);
      if (!String(data.note ?? '').includes(marker) && !matchesTag) continue;
      const key = String(envelope.key ?? data.key ?? '');
      if (key) return key;
    }
    return undefined;
  }

  async #ensureNativeCollection(plan: PendingPlan): Promise<{ key: string; name: string }> {
    const target = plan.request.target;
    const status = plan.status;
    const collections = await this.#nativeCollections(status);
    const byKey = (key: string) => collections.find((candidate) => candidate.key === key || (candidate.data as Record<string, unknown> | undefined)?.key === key);
    const dataOf = (candidate: Record<string, unknown>) => typeof candidate.data === 'object' && candidate.data !== null ? candidate.data as Record<string, unknown> : candidate;
    if (target.collectionKey) {
      const existing = byKey(target.collectionKey);
      if (!existing) throw new Error('预览绑定的 Zotero 集合已经变化或不存在，请重新预览');
      return { key: target.collectionKey, name: String(dataOf(existing).name ?? target.childName) };
    }
    let root = collections.find((candidate) => {
      const data = dataOf(candidate);
      return data.name === target.rootName && data.parentCollection === false;
    });
    if (!root) {
      const response = await this.#nativeWrite('/api/users/0/collections', status, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ name: target.rootName, parentCollection: false }]) });
      if (!response.ok) throw new Error(`创建 Zotero 顶层集合失败：HTTP ${response.status}`);
      const result = await response.json() as Record<string, unknown>;
      const successful = typeof result.successful === 'object' && result.successful !== null ? result.successful as Record<string, unknown> : {};
      root = successful['0'] as Record<string, unknown> | undefined;
      if (!root) throw new Error('Zotero 未返回新建顶层集合 key');
      collections.push(root);
    }
    const rootData = dataOf(root);
    const rootKey = String(root.key ?? rootData.key ?? '');
    let child = collections.find((candidate) => {
      const data = dataOf(candidate);
      return data.name === target.childName && data.parentCollection === rootKey;
    });
    if (!child) {
      const response = await this.#nativeWrite('/api/users/0/collections', status, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ name: target.childName, parentCollection: rootKey }]) });
      if (!response.ok) throw new Error(`创建 Zotero 子集合失败：HTTP ${response.status}`);
      const result = await response.json() as Record<string, unknown>;
      const successful = typeof result.successful === 'object' && result.successful !== null ? result.successful as Record<string, unknown> : {};
      child = successful['0'] as Record<string, unknown> | undefined;
    }
    const childData = child ? dataOf(child) : undefined;
    const key = String(child?.key ?? childData?.key ?? '');
    if (!key) throw new Error('Zotero 未返回目标子集合 key');
    return { key, name: target.childName };
  }

  async #attachNative(parentItemKey: string, descriptor: AttachmentDescriptor, status: ZoteroStatusV1): Promise<string> {
    const bytes = readFileSync(descriptor.path);
    if (bytes.length !== descriptor.size || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) throw new Error('OA 附件缓存校验失败');
    const existingKey = await this.#existingNativeAttachment(parentItemKey, descriptor, status);
    if (existingKey) return existingKey;
    const filename = `${descriptor.sha256}.pdf`;
    const marker = `Sci-Workplace-OA-SHA256: ${descriptor.sha256}`;
    const createResponse = await this.#nativeWrite('/api/users/0/items', status, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ itemType: 'attachment', parentItem: parentItemKey, linkMode: 'imported_url', title: 'Open-access full text', accessDate: 'CURRENT_TIMESTAMP', url: descriptor.sourceUrl, note: [descriptor.license ? `License: ${descriptor.license}` : '', marker].filter(Boolean).join('\n'), tags: [{ tag: `sci-workplace-oa:${descriptor.sha256}` }], relations: {}, contentType: descriptor.mediaType, charset: '', filename }]),
    });
    if (!createResponse.ok) throw new Error(`创建 Zotero 附件条目失败：HTTP ${createResponse.status}`);
    const created = await createResponse.json() as Record<string, unknown>;
    const successful = typeof created.successful === 'object' && created.successful !== null ? created.successful as Record<string, unknown> : {};
    const attachment = successful['0'] as Record<string, unknown> | undefined;
    const attachmentKey = String(attachment?.key ?? (attachment?.data as Record<string, unknown> | undefined)?.key ?? '');
    if (!attachmentKey) throw new Error('Zotero 未返回附件 key');
    const md5 = createHash('md5').update(bytes).digest('hex');
    const metadata = new URLSearchParams({ md5, filename, filesize: String(bytes.length), mtime: String(Math.trunc(statSync(descriptor.path).mtimeMs)) });
    const stage = await this.#nativeWrite(`/api/users/0/items/${attachmentKey}/file`, status, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'If-None-Match': '*' }, body: metadata.toString() });
    if (!stage.ok) throw new Error(`Zotero 附件上传预检失败：HTTP ${stage.status}`);
    const staged = await stage.json() as Record<string, unknown>;
    if (staged.exists === 1) return attachmentKey;
    if (typeof staged.url !== 'string' || typeof staged.uploadKey !== 'string') throw new Error('Zotero 附件上传预检响应无效');
    const uploadUrl = new URL(staged.url, ZOTERO_ORIGIN);
    if (uploadUrl.origin !== ZOTERO_ORIGIN || !uploadUrl.pathname.startsWith('/api/local/uploads/')) throw new Error('Zotero 返回了越界附件上传地址');
    const upload = await this.#fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': String(staged.contentType ?? 'application/octet-stream') }, body: bytes, redirect: 'error' });
    if (!upload.ok) throw new Error(`Zotero 附件字节上传失败：HTTP ${upload.status}`);
    const finalize = await this.#nativeWrite(`/api/users/0/items/${attachmentKey}/file`, status, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'If-None-Match': '*' }, body: new URLSearchParams({ upload: staged.uploadKey }).toString() });
    if (!finalize.ok) throw new Error(`Zotero 附件上传提交失败：HTTP ${finalize.status}`);
    return attachmentKey;
  }

  async #commitNative(plan: PendingPlan): Promise<ZoteroSyncReceiptV1> {
    const collection = await this.#ensureNativeCollection(plan);
    const items: ZoteroSyncItemReceiptV1[] = [];
    for (const [index, operation] of plan.public.operations.entries()) {
      const syncItem = plan.request.items[index];
      if (!syncItem) continue;
      if (operation.action === 'conflict') {
        items.push({ canonicalId: operation.canonicalId, status: 'failed', error: operation.reason ?? 'Zotero duplicate conflict' });
        continue;
      }
      try {
        let itemKey = operation.existingItemKey;
        let created = false;
        if (!itemKey) {
          const response = await this.#nativeWrite('/api/users/0/items', plan.status, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([zoteroData(syncItem.record, collection.key)]) });
          if (!response.ok) throw new Error(`写入条目失败：HTTP ${response.status}`);
          const result = await response.json() as Record<string, unknown>;
          const successful = typeof result.successful === 'object' && result.successful !== null ? result.successful as Record<string, unknown> : {};
          const createdItem = successful['0'] as Record<string, unknown> | undefined;
          itemKey = String(createdItem?.key ?? (createdItem?.data as Record<string, unknown> | undefined)?.key ?? '');
          if (!itemKey) throw new Error('Zotero 未返回新建条目 key');
          created = true;
        } else {
          const current = await this.#nativeItem(itemKey, plan.status);
          if (current && !current.collections.includes(collection.key)) {
            const patch = { version: current.version, collections: [...current.collections, collection.key] };
            const response = await this.#nativeWrite(`/api/users/0/items/${itemKey}`, plan.status, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
            if (!response.ok) throw new Error(`把复用条目加入集合失败：HTTP ${response.status}`);
          }
        }
        const attachmentKeys: string[] = [];
        for (const attachmentId of syncItem.attachmentIds ?? []) {
          const descriptor = this.#attachment(attachmentId);
          if (!descriptor) throw new Error(`OA 附件句柄不存在：${attachmentId}`);
          attachmentKeys.push(await this.#attachNative(itemKey, descriptor, plan.status));
        }
        const itemUri = await this.#nativeItemUri(itemKey, plan.status);
        items.push({ canonicalId: operation.canonicalId, status: created ? 'created' : 'reused', itemKey, itemUri, ...(attachmentKeys.length > 0 ? { attachmentKeys } : {}) });
      } catch (error) {
        items.push({ canonicalId: operation.canonicalId, status: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { schemaVersion: 1, operationKey: plan.request.operationKey, collectionKey: collection.key, collectionName: collection.name, items, committedAt: new Date().toISOString(), mode: 'native-local-api' };
  }

  async #commitCompanion(plan: PendingPlan): Promise<ZoteroSyncReceiptV1> {
    await this.#ensureCompanionToken();
    const attachmentMap: Record<string, Record<string, unknown>> = {};
    for (const item of plan.request.items) {
      for (const attachmentId of item.attachmentIds ?? []) {
        if (attachmentId in attachmentMap) continue;
        const descriptor = this.#attachment(attachmentId);
        if (!descriptor) throw new Error(`OA 附件句柄不存在：${attachmentId}`);
        const bytes = readFileSync(descriptor.path);
        if (bytes.length !== descriptor.size || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) throw new Error(`OA 附件校验失败：${attachmentId}`);
        attachmentMap[attachmentId] = { ...descriptor, bytes: bytes.toString('base64') };
      }
    }
    const response = await this.#request('/sci-workplace/v1/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#companionToken}`, 'Idempotency-Key': plan.request.operationKey },
      body: JSON.stringify({ plan: plan.public, request: plan.request, attachments: attachmentMap }),
    }, 2, this.#syncTimeoutMs);
    if (!response.ok) throw new Error(`Zotero companion 同步失败：HTTP ${response.status}`);
    const value = await response.json() as ZoteroSyncReceiptV1;
    if (value.schemaVersion !== 1 || value.operationKey !== plan.request.operationKey || value.mode !== 'companion') throw new Error('Zotero companion 同步回执无效');
    return value;
  }

  async commitSync(planId: string, confirmed: boolean): Promise<ZoteroSyncReceiptV1> {
    if (confirmed !== true) throw new Error('Zotero 同步提交必须绑定本次运行级确认');
    const plan = this.#plans.get(planId);
    if (!plan) throw new Error('Zotero 同步预览不存在或已经失效');
    if (Date.parse(plan.public.expiresAt) <= Date.now()) throw new Error('Zotero 同步预览已过期，请重新预览');
    const existing = this.#receipts.get(plan.request.operationKey);
    if (existing) return structuredClone(existing);
    const currentStatus = await this.status();
    if (currentStatus.mode !== plan.status.mode || currentStatus.serverId !== plan.status.serverId) throw new Error('Zotero 实例或 provider 已变化，请重新预览');
    if (currentStatus.mode !== 'native-local-api' && currentStatus.mode !== 'companion') throw new Error('当前 Zotero provider 不支持写入');
    const receipt = currentStatus.mode === 'native-local-api' ? await this.#commitNative(plan) : await this.#commitCompanion(plan);
    this.#receipts.set(plan.request.operationKey, receipt);
    return structuredClone(receipt);
  }

  materializeCitationDocument(plan: CitationDocumentPlanV1): CitationMaterializationReceiptV1 {
    return this.#documents.materialize(plan);
  }
}
