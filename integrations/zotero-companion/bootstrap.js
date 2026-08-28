/* global Zotero, Services, PathUtils, IOUtils, atob */

var SciWorkplaceCitationCompanion = (() => {
  const API_ROOT = '/sci-workplace/v1';
  const MAX_ITEMS = 2000;
  const MAX_ATTACHMENTS = 2000;
  const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
  let sessionKey = null;
  let pairAttempts = [];
  const receipts = new Map();

  function response(status, value) {
    return [status, 'application/json', JSON.stringify(value)];
  }

  function requestBody(requestData) {
    const value = requestData && requestData.data;
    if (!value) return {};
    if (typeof value === 'string') return JSON.parse(value);
    return value;
  }

  function header(requestData, name) {
    const headers = requestData && requestData.headers;
    if (!headers) return '';
    return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
  }

  function authorized(requestData) {
    const authorization = String(header(requestData, 'Authorization'));
    return sessionKey && authorization === `Bearer ${sessionKey}`;
  }

  function randomSecret() {
    return Zotero.Utilities.randomString(72);
  }

  function normalizeTitle(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
  }

  function cleanDoi(value) {
    return String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '').replace(/^doi\s*:\s*/iu, '').replace(/[.,;:]+$/u, '').toLowerCase();
  }

  function extraIdentifier(extra, label) {
    const match = String(extra || '').match(new RegExp(`(?:^|\\n)${label}\\s*:\\s*([^\\n]+)`, 'iu'));
    return match ? match[1].trim() : '';
  }

  function creators(item) {
    return item.getCreators().map((entry) => ({
      family: entry.lastName || entry.name || '',
      ...(entry.firstName ? { given: entry.firstName } : {}),
    })).filter((entry) => entry.family);
  }

  function serializeItem(item) {
    const extra = item.getField('extra') || '';
    return {
      key: item.key,
      libraryID: item.libraryID,
      library: { id: item.libraryID },
      version: item.version,
      data: {
        key: item.key,
        version: item.version,
        itemType: item.itemType,
        title: item.getField('title') || '',
        creators: item.getCreators(),
        date: item.getField('date') || '',
        DOI: item.getField('DOI') || '',
        url: item.getField('url') || '',
        extra,
        collections: item.getCollections().map((id) => Zotero.Collections.get(id)?.key).filter(Boolean),
      },
      title: item.getField('title') || '',
      creators: creators(item),
      doi: cleanDoi(item.getField('DOI')) || undefined,
      pmid: extraIdentifier(extra, 'PMID') || undefined,
      arxivId: extraIdentifier(extra, 'arXiv') || undefined,
      url: item.getField('url') || undefined,
    };
  }

  async function libraryItems(libraryID) {
    const ids = await Zotero.Items.getAll(libraryID, true, false, false);
    const values = Array.isArray(ids) && ids.length && typeof ids[0] === 'number' ? await Zotero.Items.getAsync(ids) : ids;
    return (values || []).filter((item) => item && item.isRegularItem && item.isRegularItem());
  }

  function matches(item, request) {
    const serialized = serializeItem(item);
    if (request.key) return serialized.key === request.key;
    if (request.doi) return cleanDoi(serialized.doi) === cleanDoi(request.doi);
    if (request.pmid) return serialized.pmid === request.pmid;
    if (request.arxivId) return String(serialized.arxivId || '').replace(/v\d+$/iu, '').toLowerCase() === String(request.arxivId).replace(/v\d+$/iu, '').toLowerCase();
    if (request.title) return normalizeTitle(serialized.title) === normalizeTitle(request.title);
    const query = String(request.query || '').toLowerCase();
    return !query || JSON.stringify(serialized).toLowerCase().includes(query);
  }

  async function search(request) {
    const libraryID = Zotero.Libraries.userLibraryID;
    const items = await libraryItems(libraryID);
    const limit = Math.max(1, Math.min(100, Number(request.limit) || 25));
    return items.filter((item) => matches(item, request)).slice(0, limit).map(serializeItem);
  }

  async function collectionByKey(libraryID, key) {
    if (!key) return null;
    return Zotero.Collections.getByLibraryAndKeyAsync
      ? await Zotero.Collections.getByLibraryAndKeyAsync(libraryID, key)
      : Zotero.Collections.getByLibraryAndKey(libraryID, key);
  }

  async function allCollections(libraryID) {
    const values = Zotero.Collections.getByLibrary(libraryID, true) || [];
    return values && typeof values.then === 'function' ? await values : values;
  }

  async function ensureCollection(target) {
    const libraryID = target.libraryId || Zotero.Libraries.userLibraryID;
    if (target.collectionKey) {
      const bound = await collectionByKey(libraryID, target.collectionKey);
      if (!bound) throw new Error('The collection bound during preview no longer exists');
      return bound;
    }
    const collections = await allCollections(libraryID);
    let root = collections.find((collection) => collection.name === target.rootName && !collection.parentID);
    if (!root) {
      root = new Zotero.Collection();
      root.libraryID = libraryID;
      root.name = target.rootName;
      await root.saveTx();
    }
    let child = collections.find((collection) => collection.name === target.childName && collection.parentID === root.id);
    if (!child) {
      child = new Zotero.Collection();
      child.libraryID = libraryID;
      child.name = target.childName;
      child.parentID = root.id;
      await child.saveTx();
    }
    return child;
  }

  function recordMatches(item, record) {
    const data = serializeItem(item);
    if (record.doi && data.doi) return cleanDoi(record.doi) === cleanDoi(data.doi);
    if (record.pmid && data.pmid) return record.pmid === data.pmid;
    if (record.arxivId && data.arxivId) return String(record.arxivId).replace(/v\d+$/iu, '').toLowerCase() === String(data.arxivId).replace(/v\d+$/iu, '').toLowerCase();
    const year = String(item.getField('date') || '').match(/\b(?:19|20)\d{2}\b/u)?.[0] || '';
    const first = creators(item)[0]?.family || '';
    return normalizeTitle(record.title) === normalizeTitle(data.title)
      && String(record.issuedYear || '') === year
      && normalizeTitle(record.creators?.[0]?.family || '') === normalizeTitle(first);
  }

  async function findExisting(record) {
    const items = await libraryItems(Zotero.Libraries.userLibraryID);
    return items.filter((item) => recordMatches(item, record));
  }

  function zoteroType(record) {
    return ['journalArticle', 'conferencePaper', 'book', 'bookSection', 'thesis', 'report', 'preprint'].includes(record.itemType) ? record.itemType : 'document';
  }

  async function createItem(record, collection) {
    const item = new Zotero.Item(zoteroType(record));
    item.libraryID = collection.libraryID;
    item.setField('title', record.title || '');
    item.setCreators((record.creators || []).map((creator) => ({ creatorType: 'author', lastName: creator.family || creator.literal || '', firstName: creator.given || '' })));
    if (record.issuedYear) item.setField('date', String(record.issuedYear));
    if (record.containerTitle) item.setField(item.itemType === 'conferencePaper' ? 'proceedingsTitle' : 'publicationTitle', record.containerTitle);
    if (record.volume) item.setField('volume', record.volume);
    if (record.issue) item.setField('issue', record.issue);
    if (record.pages) item.setField('pages', record.pages);
    if (record.publisher) item.setField('publisher', record.publisher);
    if (record.doi) item.setField('DOI', record.doi);
    if (record.url || record.sourceUrl) item.setField('url', record.url || record.sourceUrl);
    if (record.abstract) item.setField('abstractNote', record.abstract);
    const extra = [record.pmid ? `PMID: ${record.pmid}` : '', record.arxivId ? `arXiv: ${record.arxivId}` : ''].filter(Boolean).join('\n');
    if (extra) item.setField('extra', extra);
    item.setCollections([collection.id]);
    await item.saveTx();
    return item;
  }

  async function ensureInCollection(item, collection) {
    if (!item.getCollections().includes(collection.id)) {
      item.addToCollection(collection.id);
      await item.saveTx();
    }
  }

  function base64Bytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function existingAttachment(item, sha256) {
    const attachments = await Zotero.Items.getAsync(item.getAttachments());
    return (attachments || []).find((attachment) => attachment.getTags().some((tag) => tag.tag === `sci-workplace-sha256:${sha256}`));
  }

  async function importAttachment(item, descriptor) {
    const existing = await existingAttachment(item, descriptor.sha256);
    if (existing) return existing;
    const bytes = base64Bytes(descriptor.bytes || '');
    if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES || bytes.length !== descriptor.size) throw new Error('Invalid OA attachment payload');
    const fileName = `${descriptor.sha256}.pdf`;
    const tempPath = PathUtils.join(PathUtils.tempDir, `sci-workplace-${Date.now()}-${fileName}`);
    try {
      await IOUtils.write(tempPath, bytes);
      const attachment = await Zotero.Attachments.importFromFile({ file: tempPath, libraryID: item.libraryID, parentItemID: item.id, title: 'Open-access full text' });
      attachment.setField('url', descriptor.sourceUrl || '');
      attachment.addTag(`sci-workplace-sha256:${descriptor.sha256}`, 1);
      if (descriptor.license) attachment.addTag(`license:${String(descriptor.license).slice(0, 200)}`, 1);
      await attachment.saveTx();
      return attachment;
    } finally {
      await IOUtils.remove(tempPath, { ignoreAbsent: true });
    }
  }

  async function sync(body, operationKey) {
    if (receipts.has(operationKey)) return receipts.get(operationKey);
    const request = body.request || {};
    const plan = body.plan || {};
    const attachments = body.attachments || {};
    if (request.operationKey !== operationKey || plan.operationKey !== operationKey) throw new Error('Idempotency key mismatch');
    if (!Array.isArray(request.items) || request.items.length > MAX_ITEMS) throw new Error('Too many Zotero items');
    const attachmentCount = request.items.reduce((total, item) => total + ((item.attachmentIds || []).length), 0);
    if (attachmentCount > MAX_ATTACHMENTS) throw new Error('Too many Zotero attachments');
    const collection = await ensureCollection(request.target || {});
    const itemReceipts = [];
    for (const syncItem of request.items) {
      const record = syncItem.record;
      try {
        const matches = await findExisting(record);
        if (matches.length > 1) throw new Error('Multiple exact Zotero duplicates');
        const created = matches.length === 0;
        const item = created ? await createItem(record, collection) : matches[0];
        await ensureInCollection(item, collection);
        const attachmentKeys = [];
        for (const id of syncItem.attachmentIds || []) {
          if (!attachments[id]) throw new Error(`Missing attachment handle ${id}`);
          const attachment = await importAttachment(item, attachments[id]);
          attachmentKeys.push(attachment.key);
        }
        itemReceipts.push({ canonicalId: record.canonicalId, status: created ? 'created' : 'reused', itemKey: item.key, itemUri: Zotero.URI.getItemURI(item), ...(attachmentKeys.length ? { attachmentKeys } : {}) });
      } catch (error) {
        itemReceipts.push({ canonicalId: record.canonicalId, status: 'failed', error: error && error.message ? error.message : String(error) });
      }
    }
    const receipt = { schemaVersion: 1, operationKey, collectionKey: collection.key, collectionName: collection.name, items: itemReceipts, committedAt: new Date().toISOString(), mode: 'companion' };
    receipts.set(operationKey, receipt);
    return receipt;
  }

  class StatusEndpoint {
    supportedMethods = ['GET'];
    supportedDataTypes = ['application/json'];

    init(_requestData) {
      return response(200, { schemaVersion: 1, companionVersion: '1.0.0', zoteroVersion: Zotero.version, capabilities: ['read', 'write', 'collections', 'attachments'] });
    }
  }

  class PairEndpoint {
    supportedMethods = ['POST'];
    supportedDataTypes = ['application/json'];

    init(requestData) {
      const now = Date.now();
      pairAttempts = pairAttempts.filter((timestamp) => now - timestamp < 60_000);
      if (pairAttempts.length >= 5) return response(429, { error: 'pair_rate_limited' });
      pairAttempts.push(now);
      const body = requestBody(requestData);
      if (!body.nonce || String(body.nonce).length > 200) return response(400, { error: 'invalid_nonce' });
      const approved = Services.prompt.confirm(null, 'Sci Workplace Zotero Companion', 'Allow Sci Workplace to create/reuse a references collection and import verified open-access attachments for this Zotero session?');
      if (!approved) return response(403, { denied: true });
      sessionKey = randomSecret();
      return response(200, { sessionKey, nonce: body.nonce });
    }
  }

  class SearchEndpoint {
    supportedMethods = ['POST'];
    supportedDataTypes = ['application/json'];

    async init(requestData) {
      if (!authorized(requestData)) return response(401, { error: 'unauthorized' });
      try { return response(200, { items: await search(requestBody(requestData)) }); }
      catch (error) { return response(500, { error: error && error.message ? error.message : String(error) }); }
    }
  }

  class SyncEndpoint {
    supportedMethods = ['POST'];
    supportedDataTypes = ['application/json'];

    async init(requestData) {
      if (!authorized(requestData)) return response(401, { error: 'unauthorized' });
      const operationKey = String(header(requestData, 'Idempotency-Key') || '');
      if (!operationKey || operationKey.length > 200) return response(400, { error: 'invalid_idempotency_key' });
      try { return response(200, await sync(requestBody(requestData), operationKey)); }
      catch (error) { return response(500, { error: error && error.message ? error.message : String(error) }); }
    }
  }

  function register() {
    Zotero.Server.Endpoints[`${API_ROOT}/status`] = StatusEndpoint;
    Zotero.Server.Endpoints[`${API_ROOT}/pair`] = PairEndpoint;
    Zotero.Server.Endpoints[`${API_ROOT}/search`] = SearchEndpoint;
    Zotero.Server.Endpoints[`${API_ROOT}/sync`] = SyncEndpoint;
  }

  function unregister() {
    delete Zotero.Server.Endpoints[`${API_ROOT}/status`];
    delete Zotero.Server.Endpoints[`${API_ROOT}/pair`];
    delete Zotero.Server.Endpoints[`${API_ROOT}/search`];
    delete Zotero.Server.Endpoints[`${API_ROOT}/sync`];
    sessionKey = null;
    receipts.clear();
  }

  return { register, unregister };
})();

async function startup() {
  await Zotero.initializationPromise;
  SciWorkplaceCitationCompanion.register();
}

function shutdown() {
  SciWorkplaceCitationCompanion.unregister();
}

function install() {}
function uninstall() {}
