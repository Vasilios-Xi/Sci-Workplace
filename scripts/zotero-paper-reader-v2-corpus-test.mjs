#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { SqliteEventStore } from '../packages/runtime/dist/events/event-store.js';
import { ModelGenerationService } from '../packages/runtime/dist/models/model-generation-service.js';
import { CodexAppServerProvider } from '../packages/runtime/dist/providers/codex-app-server-provider.js';
import { JobService } from '../packages/runtime/dist/workbench/job-service.js';
import {
  runPaperReaderClaimEvidence,
  runPaperReaderDocumentProfile,
  runPaperReaderFigureAnalysis,
  runPaperReaderFormulaAnalysis,
  runPaperReaderQuestion,
  runPaperReaderReproduction,
  runPaperReaderSectionDigest,
  runPaperReaderSynthesis,
  runPaperReaderTerminology,
  runPaperReaderTranslation,
} from '../packages/runtime/dist/workbench/paper-reader-model-adapter.js';
import {
  estimatePaperReaderV2Usage,
  PAPER_READER_V2_DEFAULT_MODULES,
  paperReaderVisualInputIssue,
  PaperReaderService,
} from '../packages/runtime/dist/workbench/paper-reader-service.js';
import { ScientificKernelStore } from '../packages/runtime/dist/workbench/scientific-kernel-store.js';
import { WorkbenchService } from '../packages/runtime/dist/workbench/workbench-service.js';
import { WorktableStore } from '../packages/runtime/dist/worktable/worktable-store.js';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(workspace, 'artifacts', 'zotero-paper-reader-v2-corpus');
const temporaryRoot = join(outputRoot, `.tmp-${process.pid}-${randomUUID()}`);
const diagnosticRoot = join(outputRoot, 'diagnostics');
const inventoryCheckpointPath = join(outputRoot, 'inventory-checkpoint.json');
const inventoryPath = join(outputRoot, 'inventory-latest.json');
const runCheckpointPath = join(outputRoot, 'run-checkpoint.json');
const finalPath = join(outputRoot, 'latest.json');
const zoteroRoot = resolve(process.env.ZOTERO_DATA_DIR || 'D:\\Study\\zotero');
const worker = resolve(process.env.READER_WORKER || join(workspace, 'packages', 'reader-runtime', 'dist', 'reader-worker', 'reader-worker.exe'));
const textModel = process.env.PAPER_READER_TEXT_MODEL || 'chatgpt-oauth::gpt-5.6-luna';
const visionModel = process.env.PAPER_READER_VISION_MODEL || 'chatgpt-oauth::gpt-5.6-luna';
const minimumFreeBytes = 8 * 1024 * 1024 * 1024;
const actor = { id: 'zotero-corpus-owner', kind: 'user', label: 'Zotero corpus owner' };
const runMode = process.argv.includes('--run');
const authorizationIndex = process.argv.indexOf('--authorization');
const suppliedAuthorization = authorizationIndex >= 0 ? process.argv[authorizationIndex + 1] : undefined;
let provider;
let cleaning = false;
let activePaperCleanup;
let zoteroEnumerationMode = 'uninitialized';

function within(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep);
}

function safeRemove(target) {
  if (!within(temporaryRoot, target)) throw new Error(`Refusing to clean outside the V2 corpus sandbox: ${target}`);
  rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

function safeRemoveStale(target) {
  if (!within(outputRoot, target) || !basename(target).startsWith('.tmp-')) {
    throw new Error(`Refusing to clean a non-temporary corpus path: ${target}`);
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

function cleanTemporaryRoot() {
  if (cleaning) return;
  cleaning = true;
  try {
    if (existsSync(temporaryRoot)) safeRemove(temporaryRoot);
  } finally {
    cleaning = false;
  }
}

function cleanStaleTemporaryRoots() {
  if (!existsSync(outputRoot)) return;
  for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.tmp-')) continue;
    const target = join(outputRoot, entry.name);
    if (resolve(target) !== resolve(temporaryRoot)) safeRemoveStale(target);
  }
}

function diskFreeBytes(path) {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

function requireDiskHeadroom() {
  const free = diskFreeBytes(workspace);
  if (free < minimumFreeBytes) {
    throw Object.assign(new Error(`Zotero corpus test stopped safely below 8 GiB: ${(free / 1024 ** 3).toFixed(2)} GiB free`), { code: 'LOW_DISK_HEADROOM' });
  }
  return free;
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function pngDimensions(path) {
  const value = readFileSync(path);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (value.length < 24 || !value.subarray(0, 8).equals(signature) || value.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(`Visual input is not a valid PNG header: ${path}`);
  }
  const width = value.readUInt32BE(16);
  const height = value.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error(`Visual input has invalid PNG dimensions: ${path}`);
  return { width, height };
}

function auditParsedVisualInputs(parsed, parsedRoot, attachmentKey) {
  const profilePath = parsed.paper?.profileImagePath;
  if (typeof profilePath !== 'string' || !profilePath) throw new Error(`Full-page profile image missing for ${attachmentKey}`);
  const resolvedProfile = resolve(profilePath);
  if (!within(parsedRoot, resolvedProfile) || !existsSync(resolvedProfile)) throw new Error(`Full-page profile image escaped or is missing for ${attachmentKey}`);
  const profileDimensions = pngDimensions(resolvedProfile);
  const profilePage = parsed.pages.find((page) => page.page === Number(parsed.paper?.profilePage || 1));
  if (!profilePage?.width || !profilePage.height
    || profileDimensions.width < profilePage.width * 1.9
    || profileDimensions.height < profilePage.height * 1.9) {
    throw new Error(`Profile image is not a full-page 2x visual input for ${attachmentKey}`);
  }

  const visualFigures = parsed.figures.filter((figure) => figure.contentVisual !== false);
  for (const figure of visualFigures) {
    const issue = paperReaderVisualInputIssue(parsed, figure);
    if (issue) throw new Error(`Visual input quality gate failed for ${attachmentKey}/${figure.id}: ${issue}`);
    if (typeof figure.imagePath !== 'string' || !figure.imagePath) throw new Error(`Visual asset path missing for ${attachmentKey}/${figure.id}`);
    const imagePath = resolve(figure.imagePath);
    if (!within(parsedRoot, imagePath) || !existsSync(imagePath)) throw new Error(`Visual asset escaped or is missing for ${attachmentKey}/${figure.id}`);
    const dimensions = pngDimensions(imagePath);
    if (Number(figure.pixelWidth) !== dimensions.width || Number(figure.pixelHeight) !== dimensions.height) {
      throw new Error(`Visual asset dimension metadata mismatch for ${attachmentKey}/${figure.id}`);
    }
  }

  const formulaFigures = new Map(visualFigures.filter((figure) => figure.kind === 'formula').map((figure) => [String(figure.id), figure]));
  const formulaBlocks = parsed.blocks.filter((block) => block.type === 'formula');
  const missingFormulaVisuals = formulaBlocks.filter((block) => !Array.isArray(block.refs) || !block.refs.some((ref) => formulaFigures.has(String(ref))));
  if (missingFormulaVisuals.length > 0) {
    throw new Error(`Formula visual inputs missing for ${attachmentKey}: ${missingFormulaVisuals.map((block) => block.id).slice(0, 12).join(', ')}`);
  }
  return {
    profilePixelWidth: profileDimensions.width,
    profilePixelHeight: profileDimensions.height,
    visualInputCount: visualFigures.filter((figure) => figure.kind !== 'formula').length,
    formulaVisualInputCount: formulaFigures.size,
  };
}

async function sha256(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolvePromise);
  });
  return hash.digest('hex');
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function writeDiagnostic(id, value) {
  mkdirSync(diagnosticRoot, { recursive: true });
  const path = join(diagnosticRoot, `${id}.json.gz`);
  writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(value), 'utf8'), { level: 9 }));
  return path;
}

function implementationFingerprint() {
  const hash = createHash('sha256');
  const paths = [
    fileURLToPath(import.meta.url),
    worker,
    join(workspace, 'packages', 'reader-runtime', 'python', 'reader_worker', 'main.py'),
    join(workspace, 'packages', 'runtime', 'src', 'workbench', 'paper-reader-v2-engine.ts'),
    join(workspace, 'packages', 'runtime', 'src', 'workbench', 'paper-reader-model-adapter.ts'),
    join(workspace, 'packages', 'runtime', 'src', 'workbench', 'paper-reader-panel.ts'),
    join(workspace, 'packages', 'runtime', 'dist', 'workbench', 'paper-reader-service.js'),
    join(workspace, 'packages', 'runtime', 'dist', 'workbench', 'paper-reader-model-adapter.js'),
    join(workspace, 'packages', 'runtime', 'dist', 'workbench', 'paper-reader-panel.js'),
    join(workspace, 'packages', 'runtime', 'dist', 'models', 'model-generation-service.js'),
    join(workspace, 'packages', 'runtime', 'dist', 'providers', 'codex-app-server-provider.js'),
    join(workspace, 'packages', 'protocol', 'dist', 'index.js'),
  ];
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`Fingerprint input is missing; run pnpm build first: ${path}`);
    hash.update(path);
    hash.update(readFileSync(path));
  }
  hash.update(JSON.stringify({ schema: 2, textModel, visionModel, modules: PAPER_READER_V2_DEFAULT_MODULES }));
  return hash.digest('hex');
}

function resolveAttachmentPath(row) {
  const stored = String(row.path || '');
  if (stored.startsWith('storage:')) return join(zoteroRoot, 'storage', String(row.key), stored.slice('storage:'.length));
  if (isAbsolute(stored)) return stored;
  if (stored.startsWith('attachments:')) {
    const base = process.env.ZOTERO_LINKED_ATTACHMENT_BASE;
    return base ? resolve(base, stored.slice('attachments:'.length)) : '';
  }
  return '';
}

async function loadAttachmentsFromReadOnlySnapshot() {
  const source = join(zoteroRoot, 'zotero.sqlite');
  if (!existsSync(source)) throw new Error(`Zotero database not found: ${source}`);
  const snapshot = join(temporaryRoot, 'zotero-snapshot.sqlite');
  const sourceDatabase = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(sourceDatabase, snapshot, { rate: 256 });
  } finally {
    sourceDatabase.close();
  }
  const database = new DatabaseSync(snapshot, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT i.key, p.key AS parentKey, ia.linkMode, ia.contentType, ia.path,
        COALESCE(pv.value, '') AS parentTitle,
        COALESCE(av.value, '') AS attachmentTitle
      FROM itemAttachments ia
      JOIN items i ON i.itemID=ia.itemID
      LEFT JOIN items p ON p.itemID=ia.parentItemID
      LEFT JOIN fieldsCombined pf ON pf.fieldName='title'
      LEFT JOIN itemData pd ON pd.itemID=p.itemID AND pd.fieldID=pf.fieldID
      LEFT JOIN itemDataValues pv ON pv.valueID=pd.valueID
      LEFT JOIN fieldsCombined af ON af.fieldName='title'
      LEFT JOIN itemData ad ON ad.itemID=i.itemID AND ad.fieldID=af.fieldID
      LEFT JOIN itemDataValues av ON av.valueID=ad.valueID
      LEFT JOIN deletedItems di ON di.itemID=i.itemID
      WHERE di.itemID IS NULL
        AND (lower(COALESCE(ia.contentType, ''))='application/pdf' OR lower(COALESCE(ia.path, '')) LIKE '%.pdf')
      ORDER BY COALESCE(p.key, i.key), i.key
    `).all();
    return rows.map((row) => {
      const path = resolveAttachmentPath(row);
      const parentTitle = String(row.parentTitle || '').replace(/<[^>]+>/gu, '').trim();
      const attachmentTitle = String(row.attachmentTitle || '').replace(/<[^>]+>/gu, '').trim();
      return {
        key: String(row.key), parentKey: row.parentKey ? String(row.parentKey) : undefined,
        parentTitle, attachmentTitle,
        title: parentTitle || attachmentTitle || basename(path || String(row.path || '')),
        storedPath: String(row.path || ''), path,
      };
    });
  } finally {
    database.close();
    rmSync(snapshot, { force: true });
  }
}

async function fetchZoteroApiItems(endpoint, query = {}) {
  const rows = [];
  let start = 0;
  while (true) {
    const url = new URL(`http://127.0.0.1:23119/api/users/0/${endpoint}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    url.searchParams.set('limit', '100');
    url.searchParams.set('start', String(start));
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'Zotero-API-Version': '3' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Zotero local API ${url.pathname} returned HTTP ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`Zotero local API ${url.pathname} returned a non-array response`);
    rows.push(...page);
    const total = Number(response.headers.get('total-results'));
    start += page.length;
    if (page.length === 0 || (Number.isFinite(total) && start >= total) || page.length < 100) break;
  }
  return rows;
}

function localFileFromApiItem(item) {
  const href = item?.links?.enclosure?.href;
  if (typeof href === 'string' && href.startsWith('file:')) {
    try { return fileURLToPath(new URL(href)); } catch { /* fall through to Zotero metadata */ }
  }
  const data = item?.data ?? {};
  if (typeof data.path === 'string' && isAbsolute(data.path)) return data.path;
  const filename = typeof data.filename === 'string' ? data.filename : '';
  if (filename && /^(?:imported_file|imported_url)$/u.test(String(data.linkMode ?? ''))) {
    return join(zoteroRoot, 'storage', String(item.key ?? data.key ?? ''), filename);
  }
  return '';
}

async function loadAttachmentsFromLocalApi() {
  const [allAttachments, parentItems] = await Promise.all([
    fetchZoteroApiItems('items', { itemType: 'attachment' }),
    fetchZoteroApiItems('items/top'),
  ]);
  const parentTitles = new Map(parentItems.map((item) => [
    String(item.key ?? item.data?.key ?? ''),
    String(item.data?.title ?? '').replace(/<[^>]+>/gu, '').trim(),
  ]));
  return allAttachments.filter((item) => {
    const data = item?.data ?? {};
    const locator = `${data.filename ?? ''} ${data.path ?? ''} ${item?.links?.enclosure?.href ?? ''}`;
    return String(data.contentType ?? '').toLowerCase() === 'application/pdf' || /\.pdf(?:$|[?#])/iu.test(locator);
  }).map((item) => {
    const data = item?.data ?? {};
    const key = String(item.key ?? data.key ?? '');
    const parentKey = data.parentItem ? String(data.parentItem) : undefined;
    const parentTitle = parentKey ? (parentTitles.get(parentKey) ?? '') : '';
    const attachmentTitle = String(data.title ?? '').replace(/<[^>]+>/gu, '').trim();
    const filename = typeof data.filename === 'string' ? data.filename : '';
    const storedPath = typeof data.path === 'string' && data.path
      ? data.path
      : filename && /^(?:imported_file|imported_url)$/u.test(String(data.linkMode ?? ''))
        ? `storage:${filename}`
        : '';
    const path = localFileFromApiItem(item);
    return {
      key, parentKey, parentTitle, attachmentTitle,
      title: parentTitle || attachmentTitle || basename(path || storedPath),
      storedPath, path,
    };
  });
}

async function loadAttachments() {
  try {
    const attachments = await loadAttachmentsFromLocalApi();
    zoteroEnumerationMode = 'local-api-read-only';
    return attachments;
  } catch (error) {
    console.warn(JSON.stringify({
      type: 'zotero-local-api-fallback',
      reason: error instanceof Error ? error.message : String(error),
    }));
    const attachments = await loadAttachmentsFromReadOnlySnapshot();
    zoteroEnumerationMode = 'sqlite-online-backup-read-only';
    return attachments;
  }
}

function supplementaryHint(attachment) {
  const value = `${attachment.attachmentTitle} ${basename(attachment.path || attachment.storedPath)}`;
  return /(?:supplement(?:ary|al)|supporting[ _-]*(?:information|data|material)|\bESI\b|\bSI(?:[ _.-]|$)|appendix)/iu.test(value);
}

function chooseMain(revisions) {
  const ordinary = revisions.filter((item) => !supplementaryHint(item.representative));
  const candidates = ordinary.length > 0 ? ordinary : revisions;
  return [...candidates].sort((left, right) => {
    const score = (item) => {
      const label = `${item.representative.attachmentTitle} ${basename(item.representative.path)}`;
      const explicit = /(?:\bmain\b|full[ _-]*text|article|manuscript|paper)/iu.test(label) ? 1_000_000_000 : 0;
      return explicit + item.size;
    };
    return score(right) - score(left) || left.hash.localeCompare(right.hash);
  })[0];
}

async function buildCorpusInventory(attachments) {
  const missing = attachments.filter((item) => !item.path || !existsSync(item.path) || !statSync(item.path).isFile());
  const accessible = attachments.filter((item) => item.path && existsSync(item.path) && statSync(item.path).isFile());
  const hashGroups = new Map();
  for (const [index, attachment] of accessible.entries()) {
    requireDiskHeadroom();
    const hash = await sha256(attachment.path);
    const group = hashGroups.get(hash) ?? [];
    group.push({ ...attachment, hash, size: statSync(attachment.path).size, inventoryIndex: index });
    hashGroups.set(hash, group);
    if ((index + 1) % 10 === 0 || index + 1 === accessible.length) {
      console.log(JSON.stringify({ type: 'hash-progress', completed: index + 1, total: accessible.length }));
    }
  }
  const revisions = [...hashGroups.entries()].map(([hash, group]) => ({
    hash, group, representative: group[0], size: group[0].size,
  }));
  const byParent = new Map();
  for (const revision of revisions) {
    const parent = revision.representative.parentKey || `attachment:${revision.representative.key}`;
    const group = byParent.get(parent) ?? [];
    group.push(revision);
    byParent.set(parent, group);
  }
  const sets = [...byParent.entries()].map(([parentKey, group]) => {
    const main = chooseMain(group);
    const supplements = group.filter((item) => item !== main).sort((left, right) => left.hash.localeCompare(right.hash));
    const ordered = [main, ...supplements];
    const id = `set-${hashJson({ parentKey, hashes: ordered.map((item) => item.hash) }).slice(0, 24)}`;
    return { id, parentKey, title: main.representative.title, main, supplements, revisions: ordered };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const setByHash = new Map(sets.flatMap((set) => set.revisions.map((revision) => [revision.hash, set.id])));
  const corpusIdentity = hashJson({
    attachments: attachments.map((item) => ({ key: item.key, parentKey: item.parentKey, storedPath: item.storedPath })),
    accessible: [...hashGroups].map(([hash, group]) => ({ hash, keys: group.map((item) => item.key).sort() })).sort((a, b) => a.hash.localeCompare(b.hash)),
    missing: missing.map((item) => item.key).sort(),
    sets: sets.map((set) => ({ id: set.id, hashes: set.revisions.map((item) => item.hash) })),
  });
  return { attachments, missing, accessible, hashGroups, revisions, sets, setByHash, corpusIdentity };
}

async function runWorker(args, timeoutMs) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(worker, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-128_000);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Reader worker timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`Reader worker exited ${code ?? 'unknown'}\n${stderr.slice(-8_000)}\n${stdout.slice(-8_000)}`));
    });
  });
}

function paperDocument(revision, role, index, parsedRef) {
  const paperId = `paper-${revision.hash.slice(0, 24)}`;
  return {
    schemaVersion: 2,
    id: role === 'main' ? `main-${revision.hash.slice(0, 16)}` : `si-${revision.hash.slice(0, 16)}-${index}`,
    paperId, role, label: revision.representative.attachmentTitle || revision.representative.title,
    revision: { ref: { rootId: `zotero-${revision.hash.slice(0, 16)}`, path: basename(revision.representative.path) }, sha256: revision.hash, mediaType: 'application/pdf' },
    parsedDocument: parsedRef, parseState: 'ready', warnings: [],
  };
}

async function inspectAndParseSet(set, index, total) {
  requireDiskHeadroom();
  const root = join(temporaryRoot, `inventory-${set.id}`);
  mkdirSync(root, { recursive: true });
  const started = Date.now();
  const diagnostics = [];
  try {
    const contexts = [];
    for (const [documentIndex, revision] of set.revisions.entries()) {
      const role = documentIndex === 0 ? 'main' : 'supplementary';
      const before = await sha256(revision.representative.path);
      if (before !== revision.hash) throw new Error(`Source changed before parse: ${revision.representative.key}`);
      const documentRoot = join(root, `document-${documentIndex}`);
      mkdirSync(documentRoot, { recursive: true });
      const inspectionPath = join(documentRoot, 'inspection.json');
      await runWorker(['inspect', '--input', revision.representative.path, '--output', inspectionPath], 5 * 60_000);
      const inspection = JSON.parse(readFileSync(inspectionPath, 'utf8'));
      if (inspection.has_text_layer !== true || Number(inspection.text_characters || 0) <= 0) {
        diagnostics.push({ key: revision.representative.key, sha256: revision.hash, status: 'unsupported_scanned', inspection });
        continue;
      }
      const parsedRoot = join(documentRoot, 'parsed');
      await runWorker(['parse', '--input', revision.representative.path, '--revision', revision.hash, '--output-dir', parsedRoot], 30 * 60_000);
      const parsedPath = join(parsedRoot, 'reader_document.json');
      if (!existsSync(parsedPath)) throw new Error(`reader_document.json missing for ${revision.representative.key}`);
      const parsed = JSON.parse(readFileSync(parsedPath, 'utf8'));
      if (parsed.revisionHash !== revision.hash) throw new Error(`Parsed revision mismatch for ${revision.representative.key}`);
      if (!Array.isArray(parsed.blocks) || !Array.isArray(parsed.figures) || !Array.isArray(parsed.pages)) throw new Error('Parsed reader contract is incomplete');
      const visualAudit = auditParsedVisualInputs(parsed, parsedRoot, revision.representative.key);
      const after = await sha256(revision.representative.path);
      if (after !== revision.hash) throw new Error(`Zotero PDF changed during offline parse: ${revision.representative.key}`);
      const ref = { rootId: `inventory-${set.id}-${documentIndex}`, path: 'reader_document.json' };
      const document = paperDocument(revision, role, documentIndex, ref);
      document.pageCount = Number(parsed.paper?.pageCount || inspection.page_count || 0);
      document.textCharacters = Number(parsed.paper?.textCharacters || inspection.text_characters || 0);
      document.blockCount = parsed.blocks.length;
      document.figureCount = parsed.figures.filter((figure) => figure.kind !== 'formula').length;
      document.formulaCount = parsed.blocks.filter((block) => block.type === 'formula').length;
      document.warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [];
      contexts.push({ document, parsed });
      diagnostics.push({
        key: revision.representative.key, sha256: revision.hash, status: 'parsed', pageCount: document.pageCount,
        textCharacters: document.textCharacters, blockCount: document.blockCount, figureCount: document.figureCount,
        formulaCount: document.formulaCount, warningCount: document.warnings.length, ...visualAudit,
      });
    }
    if (contexts.length !== set.revisions.length) {
      return { status: 'unsupported_scanned', elapsedMs: Date.now() - started, documents: diagnostics };
    }
    const preview = estimatePaperReaderV2Usage({ documents: contexts, textModel, visionModel, modules: PAPER_READER_V2_DEFAULT_MODULES });
    if (!preview.ready) throw new Error('V2 usage preview is not ready after every document parsed');
    return { status: 'ready', elapsedMs: Date.now() - started, documents: diagnostics, preview };
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    const diagnosticPath = writeDiagnostic(`inventory-${set.id}`, { setId: set.id, error: message, documents: diagnostics });
    return { status: error?.code === 'LOW_DISK_HEADROOM' ? 'stopped_low_disk' : 'failed', error: message.slice(0, 16_000), diagnosticPath, elapsedMs: Date.now() - started, documents: diagnostics };
  } finally {
    if (existsSync(root)) safeRemove(root);
    console.log(JSON.stringify({ type: 'cleanup', phase: 'inventory', setId: set.id, index: index + 1, total, temporaryBytesRetained: 0 }));
  }
}

function loadInventoryCheckpoint(fingerprint, corpusIdentity) {
  if (!existsSync(inventoryCheckpointPath) || process.env.CORPUS_FRESH === '1') return new Map();
  try {
    const value = JSON.parse(readFileSync(inventoryCheckpointPath, 'utf8'));
    if (value.schemaVersion !== 2 || value.fingerprint !== fingerprint || value.corpusIdentity !== corpusIdentity
      || value.textModel !== textModel || value.visionModel !== visionModel) return new Map();
    return new Map(Object.entries(value.results || {}));
  } catch {
    return new Map();
  }
}

function saveInventoryCheckpoint(fingerprint, corpusIdentity, results) {
  atomicJson(inventoryCheckpointPath, {
    schemaVersion: 2, fingerprint, corpusIdentity, textModel, visionModel,
    updatedAt: new Date().toISOString(), results: Object.fromEntries(results),
  });
}

function sumPreviews(results) {
  const previews = [...results.values()].filter((result) => result.status === 'ready').map((result) => result.preview);
  const fields = ['parseCalls', 'modelCalls', 'textModelCalls', 'visionModelCalls', 'profileUnits', 'fullTextBlocks', 'sectionUnits', 'visualUnits', 'formulaUnits', 'estimatedInputTokens', 'estimatedOutputTokens', 'estimatedTotalTokens', 'maximumTotalTokens', 'maximumModelCalls'];
  return Object.fromEntries(fields.map((field) => [field, previews.reduce((total, preview) => total + Number(preview[field] || 0), 0)]));
}

function attachmentResults(corpus, setResults, runResults) {
  return corpus.attachments.map((attachment) => {
    if (!attachment.path || !existsSync(attachment.path)) {
      return { key: attachment.key, parentKey: attachment.parentKey, title: attachment.title, storedPath: attachment.storedPath, status: 'missing_attachment' };
    }
    const revision = corpus.revisions.find((item) => item.group.some((candidate) => candidate.key === attachment.key));
    const setId = revision ? corpus.setByHash.get(revision.hash) : undefined;
    const result = setId ? (runResults?.get(setId) ?? setResults.get(setId)) : undefined;
    const representative = revision?.representative.key;
    return {
      key: attachment.key, parentKey: attachment.parentKey, title: attachment.title, sha256: revision?.hash,
      validationSetId: setId, ...(representative && representative !== attachment.key ? { duplicateOf: representative } : {}),
      status: result?.status ?? 'not_run',
    };
  });
}

async function runInventory() {
  const startedAt = new Date().toISOString();
  const initialFreeBytes = requireDiskHeadroom();
  const fingerprint = implementationFingerprint();
  const attachments = await loadAttachments();
  const corpus = await buildCorpusInventory(attachments);
  console.log(JSON.stringify({
    type: 'inventory', pdfAttachments: attachments.length, accessible: corpus.accessible.length,
    missing: corpus.missing.length, uniqueAccessibleRevisions: corpus.revisions.length,
    documentSets: corpus.sets.length, enumerationMode: zoteroEnumerationMode,
    textModel, visionModel, fingerprint, initialFreeBytes,
  }));
  const results = loadInventoryCheckpoint(fingerprint, corpus.corpusIdentity);
  for (const [index, set] of corpus.sets.entries()) {
    const checkpoint = results.get(set.id);
    if (checkpoint?.status === 'ready') {
      console.log(JSON.stringify({ type: 'inventory-checkpoint', index: index + 1, total: corpus.sets.length, setId: set.id, status: checkpoint.status }));
      continue;
    }
    console.log(JSON.stringify({ type: 'inventory-set-start', index: index + 1, total: corpus.sets.length, setId: set.id, title: set.title, documents: set.revisions.length }));
    const result = await inspectAndParseSet(set, index, corpus.sets.length);
    results.set(set.id, result);
    saveInventoryCheckpoint(fingerprint, corpus.corpusIdentity, results);
    console.log(JSON.stringify({ type: 'inventory-set-result', index: index + 1, total: corpus.sets.length, setId: set.id, status: result.status, preview: result.preview }));
    if (result.status === 'stopped_low_disk') break;
  }
  const totals = sumPreviews(results);
  const inventoryComplete = corpus.sets.length > 0 && corpus.sets.every((set) => results.get(set.id)?.status === 'ready');
  const authorizationId = `paper-reader-v2-corpus-${hashJson({ fingerprint, corpusIdentity: corpus.corpusIdentity, textModel, visionModel, totals }).slice(0, 32)}`;
  const summary = {
    schemaVersion: 2,
    kind: 'zotero-paper-reader-v2-offline-inventory',
    startedAt, completedAt: new Date().toISOString(), fingerprint, corpusIdentity: corpus.corpusIdentity,
    textModel, visionModel, modules: PAPER_READER_V2_DEFAULT_MODULES,
    inventoryComplete, authorizationId, realModelRunAuthorized: false, fullCorpusComplete: false,
    zotero: {
      dataDirectory: zoteroRoot, enumerationMode: zoteroEnumerationMode,
      pdfAttachments: attachments.length, accessible: corpus.accessible.length,
      missing: corpus.missing.length, uniqueAccessibleRevisions: corpus.revisions.length, documentSets: corpus.sets.length,
    },
    totals,
    sets: corpus.sets.map((set) => ({
      id: set.id, parentKey: set.parentKey, title: set.title,
      main: { key: set.main.representative.key, sha256: set.main.hash },
      supplements: set.supplements.map((item) => ({ key: item.representative.key, sha256: item.hash })),
      ...(results.get(set.id) ?? { status: 'not_run' }),
    })),
    attachments: attachmentResults(corpus, results),
    initialFreeBytes, finalFreeBytes: diskFreeBytes(workspace),
    nextStep: inventoryComplete
      ? `Show this exact global budget to the user. Only after one explicit confirmation run with --run --authorization ${authorizationId} and PAPER_READER_CORPUS_USER_CONFIRMED=1.`
      : 'Fix every offline parser failure or unsupported accessible PDF and rerun inventory before requesting model authorization.',
  };
  atomicJson(inventoryPath, summary);
  console.log(JSON.stringify({ type: 'inventory-summary', inventoryComplete, authorizationId, ...totals, inventoryPath }));
  if (!inventoryComplete) process.exitCode = 1;
}

function loadRunCheckpoint(fingerprint, corpusIdentity, authorizationId) {
  if (!existsSync(runCheckpointPath) || process.env.CORPUS_FRESH === '1') return new Map();
  try {
    const value = JSON.parse(readFileSync(runCheckpointPath, 'utf8'));
    if (value.schemaVersion !== 2 || value.fingerprint !== fingerprint || value.corpusIdentity !== corpusIdentity || value.authorizationId !== authorizationId) return new Map();
    return new Map(Object.entries(value.results || {}));
  } catch {
    return new Map();
  }
}

function saveRunCheckpoint(fingerprint, corpusIdentity, authorizationId, results) {
  atomicJson(runCheckpointPath, {
    schemaVersion: 2, fingerprint, corpusIdentity, authorizationId, textModel, visionModel,
    updatedAt: new Date().toISOString(), results: Object.fromEntries(results),
  });
}

function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0 };
}

function addUsage(left, right) {
  return {
    inputTokens: left.inputTokens + Number(right.inputTokens ?? right.promptTokens ?? 0),
    outputTokens: left.outputTokens + Number(right.outputTokens ?? right.completionTokens ?? 0),
    totalTokens: left.totalTokens + Number(right.totalTokens ?? 0),
    modelCalls: left.modelCalls + Number(right.modelCalls ?? 0),
  };
}

function usageFromResult(result) {
  return {
    inputTokens: Number(result?.usage?.promptTokens ?? 0), outputTokens: Number(result?.usage?.completionTokens ?? 0),
    totalTokens: Number(result?.usage?.totalTokens ?? 0), modelCalls: Number(result?.modelCallCount ?? 0),
  };
}

function validateArtifact(input, resolveRoot) {
  const required = ['paper.md', 'source_map.json', 'translation_notes.md', 'deep_reading.json', 'figure_analyses.json', 'formula_analyses.json', 'deep_reading_quality.json', 'generation_manifest.json'];
  const files = new Map((input.files || []).map((file) => [file.name, file]));
  for (const name of required) assert.ok(files.has(name), `Atomic artifact is missing ${name}`);
  const report = JSON.parse(input.json);
  assert.equal(report.schema, 'openscientific.fine-reading-report/2');
  assert.equal(report.quality?.status, 'complete');
  assert.equal(report.coverage?.verifiedDocumentProfileCount, report.coverage?.documentProfileCount);
  assert.equal(report.coverage?.translatedBlockCount, report.coverage?.substantiveBlockCount);
  assert.equal(report.coverage?.digestedBlockCount, report.coverage?.substantiveBlockCount);
  assert.equal(report.coverage?.verifiedMainVisualCount, report.coverage?.mainVisualCount);
  assert.equal(report.coverage?.analyzedSupplementaryVisualCount, report.coverage?.referencedSupplementaryVisualCount);
  assert.equal(report.coverage?.analyzedFormulaCount, report.coverage?.formulaCount);
  const manifest = JSON.parse(files.get('generation_manifest.json').content);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.quality?.status, 'complete');
  for (const [name, expected] of Object.entries(manifest.fileHashes || {})) {
    const file = files.get(name);
    assert.ok(file, `Manifest references missing file ${name}`);
    const actual = file.content !== undefined
      ? createHash('sha256').update(file.content, 'utf8').digest('hex')
      : sha256Sync(join(resolveRoot(file.ref.rootId, 'read'), file.ref.path));
    assert.equal(actual, expected, `Artifact hash mismatch for ${name}`);
  }
  return { report, manifest, fileCount: files.size };
}

function sha256Sync(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function awaitReader(service, instanceId, timeoutMs = 120 * 60_000) {
  const timeout = setTimeout(() => service.cancel(instanceId, actor), timeoutMs);
  try {
    return await service.wait(instanceId);
  } finally {
    clearTimeout(timeout);
  }
}

async function runDocumentSet(set, index, total, models, globalTracker, priorUsage) {
  requireDiskHeadroom();
  const root = join(temporaryRoot, `run-${set.id}`);
  mkdirSync(root, { recursive: true });
  const started = Date.now();
  const sourceHashes = new Map();
  for (const revision of set.revisions) sourceHashes.set(revision.hash, await sha256(revision.representative.path));
  let events;
  let jobs;
  let paperCleaned = false;
  const cleanPaper = () => {
    if (paperCleaned) return;
    paperCleaned = true;
    jobs?.shutdown();
    events?.close();
    if (existsSync(root)) safeRemove(root);
  };
  activePaperCleanup = cleanPaper;
  const delta = zeroUsage();
  const consume = (value) => {
    const next = addUsage(delta, value);
    Object.assign(delta, next);
    const cumulative = addUsage(globalTracker.consumed, value);
    Object.assign(globalTracker.consumed, cumulative);
    if (globalTracker.consumed.totalTokens > globalTracker.maximum.totalTokens || globalTracker.consumed.modelCalls > globalTracker.maximum.modelCalls) {
      throw new Error('GLOBAL_CORPUS_AUTHORIZATION_EXHAUSTED');
    }
  };
  const track = (runner) => async (...args) => {
    requireDiskHeadroom();
    try {
      const result = await runner(...args);
      consume(usageFromResult(result));
      return result;
    } catch (error) {
      if (error?.usage || error?.modelCallCount) consume(usageFromResult(error));
      throw error;
    }
  };
  try {
    const projectId = `zotero-v2-${set.id}`;
    events = new SqliteEventStore(join(root, 'events.sqlite'));
    const sourceRoots = new Map(set.revisions.map((revision) => [`zotero-${revision.hash.slice(0, 16)}`, dirname(revision.representative.path)]));
    const resolveRoot = (rootId, _intent = 'read') => sourceRoots.get(rootId) || jobs?.rootFor(rootId) || root;
    jobs = new JobService({
      projectId, events, root: join(root, 'jobs'), resolveRoot,
      resolveToolchainExecutable: (toolchainId) => {
        assert.equal(toolchainId, 'openlab.reader-runtime');
        return worker;
      },
    });
    const kernel = new ScientificKernelStore({ projectId, events });
    const tables = new WorktableStore({ projectId, events });
    const workbenches = new WorkbenchService({ projectId, events, worktables: tables });
    const main = set.main;
    const instance = workbenches.create({
      blueprintId: 'sci.paper-reader:deep-read', title: `${set.title} · Zotero V2 全库实测`,
      primaryConversationId: `zotero-corpus-v2:${set.id}`,
      inputs: {
        mainPdf: { rootId: `zotero-${main.hash.slice(0, 16)}`, path: basename(main.representative.path), name: basename(main.representative.path), sha256: main.hash, size: main.size, mediaType: 'application/pdf' },
        supplements: set.supplements.map((revision) => ({ rootId: `zotero-${revision.hash.slice(0, 16)}`, path: basename(revision.representative.path), name: basename(revision.representative.path), sha256: revision.hash, size: revision.size, mediaType: 'application/pdf' })),
        language: 'zh-CN',
      },
    }, actor);
    const generations = new ModelGenerationService({ projectId, events, provider: () => provider, models: () => models, resolveRoot });
    let artifactSummary;
    let mountCount = 0;
    const service = new PaperReaderService({
      projectId, events, jobs, kernel, resolveRoot, toolchainAvailable: () => true,
      createReportArtifact: (input) => {
        artifactSummary = validateArtifact(input, resolveRoot);
        return { artifactId: `zotero-v2-report-${set.id}`, revisionId: `zotero-v2-report-${set.id}-${randomUUID()}` };
      },
      mountReport: () => { mountCount += 1; },
      textModel: () => textModel, visionModel: () => visionModel,
      translate: track(async (...args) => await runPaperReaderTranslation(generations, ...args)),
      documentProfile: track(async (...args) => await runPaperReaderDocumentProfile(generations, ...args)),
      terminology: track(async (...args) => await runPaperReaderTerminology(generations, ...args)),
      sectionDigest: track(async (...args) => await runPaperReaderSectionDigest(generations, ...args)),
      figureAnalysis: track(async (...args) => await runPaperReaderFigureAnalysis(generations, ...args)),
      formulaAnalysis: track(async (...args) => await runPaperReaderFormulaAnalysis(generations, ...args)),
      claimEvidence: track(async (...args) => await runPaperReaderClaimEvidence(generations, ...args)),
      reproduction: track(async (...args) => await runPaperReaderReproduction(generations, ...args)),
      synthesis: track(async (...args) => await runPaperReaderSynthesis(generations, ...args)),
      question: track(async (...args) => await runPaperReaderQuestion(generations, ...args)),
    });
    service.configure(instance, actor);
    service.prepare(instance.id, actor);
    let reader = await awaitReader(service, instance.id, 45 * 60_000);
    if (reader.status !== 'ready') throw new Error(reader.error || `Offline preflight ended in ${reader.status}`);
    const preview = service.callPreview(instance.id);
    const inventoryPreview = globalTracker.inventorySets.get(set.id)?.preview;
    assert.deepEqual(
      Object.fromEntries(['modelCalls', 'textModelCalls', 'visionModelCalls', 'estimatedTotalTokens', 'maximumTotalTokens', 'maximumModelCalls'].map((key) => [key, preview[key]])),
      Object.fromEntries(['modelCalls', 'textModelCalls', 'visionModelCalls', 'estimatedTotalTokens', 'maximumTotalTokens', 'maximumModelCalls'].map((key) => [key, inventoryPreview[key]])),
      'Real preflight budget differs from the globally authorized offline inventory',
    );
    assert.throws(() => service.start(instance.id, actor), /确认/u);
    service.start(instance.id, actor, true);
    reader = await awaitReader(service, instance.id);
    let recovery = 1;
    while (recovery < 3 && reader.quality?.status !== 'complete') {
      recovery += 1;
      console.log(JSON.stringify({ type: 'paper-recovery', setId: set.id, attempt: recovery, status: reader.status, quality: reader.quality?.status, stage: reader.stage }));
      if (['failed', 'interrupted'].includes(reader.status)) {
        service.resume(instance.id, actor, false);
        reader = await awaitReader(service, instance.id);
        continue;
      }
      const context = service.context(instance.id, null);
      const visual = context.analysis.figureAnalyses.find((item) => item.status !== 'verified');
      if (visual) service.regenerateFigure(instance.id, visual.figureId, actor, true);
      else {
        const failedFormula = reader.pipeline.units.find((unit) => unit.stage === 'formula-analysis' && unit.status === 'failed');
        if (failedFormula?.assetId) service.regenerateModule(instance.id, 'formula-analysis', [failedFormula.assetId], actor, true);
        else service.resume(instance.id, actor, true);
      }
      reader = await awaitReader(service, instance.id);
    }
    if (reader.status !== 'completed' || reader.quality?.status !== 'complete') {
      throw new Error(reader.error || `V2 quality did not become complete after ${recovery} attempts: ${reader.quality?.issues?.join('; ')}`);
    }
    const context = service.context(instance.id, null);
    const report = context.analysis.report;
    assert.ok(report, 'Completed reader has no V2 report');
    assert.equal(report.quality.status, 'complete');
    assert.equal(report.coverage.translatedBlockCount, report.coverage.substantiveBlockCount);
    assert.equal(report.coverage.digestedBlockCount, report.coverage.substantiveBlockCount);
    assert.equal(report.coverage.verifiedMainVisualCount, report.coverage.mainVisualCount);
    assert.equal(report.coverage.analyzedSupplementaryVisualCount, report.coverage.referencedSupplementaryVisualCount);
    assert.equal(report.coverage.analyzedFormulaCount, report.coverage.formulaCount);
    assert.ok(context.anchors.every((anchor) => anchor.schemaVersion === 2 && /^paper:.+\/document:.+\/revision:[a-f0-9]{64}\/page:\d+\/(?:block|figure|table|formula):/u.test(anchor.canonicalUri || '')));
    assert.equal(mountCount >= 1, true);
    assert.equal(artifactSummary?.report?.quality?.status, 'complete');
    for (const revision of set.revisions) {
      assert.equal(await sha256(revision.representative.path), sourceHashes.get(revision.hash), 'A Zotero PDF changed during the real V2 task');
    }
    return {
      status: 'passed', quality: reader.quality, coverage: report.coverage,
      usage: addUsage(priorUsage, delta), currentRunUsage: delta,
      recoveryAttempts: recovery, generationCount: reader.modelGenerationIds.length,
      artifact: { fileCount: artifactSummary.fileCount, manifestGenerationCount: artifactSummary.manifest.generationIds?.length || 0 },
      sourceUnchanged: true, elapsedMs: Date.now() - started,
    };
  } catch (error) {
    const unchanged = await Promise.all(set.revisions.map(async (revision) => await sha256(revision.representative.path).catch(() => '') === sourceHashes.get(revision.hash)));
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    const diagnosticPath = writeDiagnostic(`run-${set.id}-${Date.now()}`, { setId: set.id, error: message, usage: addUsage(priorUsage, delta), sourceUnchanged: unchanged.every(Boolean) });
    return {
      status: error?.code === 'LOW_DISK_HEADROOM' ? 'stopped_low_disk' : 'failed',
      usage: addUsage(priorUsage, delta), currentRunUsage: delta,
      sourceUnchanged: unchanged.every(Boolean), error: message.slice(0, 16_000), diagnosticPath, elapsedMs: Date.now() - started,
    };
  } finally {
    cleanPaper();
    if (activePaperCleanup === cleanPaper) activePaperCleanup = undefined;
    console.log(JSON.stringify({ type: 'cleanup', phase: 'real-run', setId: set.id, index: index + 1, total, temporaryBytesRetained: 0 }));
  }
}

async function runRealCorpus() {
  if (process.env.PAPER_READER_CORPUS_USER_CONFIRMED !== '1') throw new Error('Real corpus model run is locked until PAPER_READER_CORPUS_USER_CONFIRMED=1 is set after the user confirms the displayed global budget');
  if (!suppliedAuthorization) throw new Error('Real corpus model run requires --authorization <inventory authorizationId>');
  if (!existsSync(inventoryPath)) throw new Error('Run the complete offline inventory before requesting real model authorization');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const fingerprint = implementationFingerprint();
  if (!inventory.inventoryComplete) throw new Error('Offline inventory is not complete; real model calls remain locked');
  if (inventory.authorizationId !== suppliedAuthorization) throw new Error('The supplied authorization does not match the displayed offline corpus budget');
  if (inventory.fingerprint !== fingerprint || inventory.textModel !== textModel || inventory.visionModel !== visionModel) throw new Error('Implementation or model selection changed after budget confirmation; regenerate the offline inventory');
  const startedAt = new Date().toISOString();
  const initialFreeBytes = requireDiskHeadroom();
  const attachments = await loadAttachments();
  const corpus = await buildCorpusInventory(attachments);
  if (corpus.corpusIdentity !== inventory.corpusIdentity) throw new Error('Zotero corpus changed after budget confirmation; regenerate and reconfirm the global budget');
  const inventorySets = new Map(inventory.sets.map((set) => [set.id, set]));
  const results = loadRunCheckpoint(fingerprint, corpus.corpusIdentity, suppliedAuthorization);
  const consumedBefore = [...results.values()].reduce((usage, result) => addUsage(usage, result.usage || zeroUsage()), zeroUsage());
  const tracker = {
    consumed: consumedBefore,
    maximum: { totalTokens: Number(inventory.totals.maximumTotalTokens), modelCalls: Number(inventory.totals.maximumModelCalls) },
    inventorySets,
  };
  provider = new CodexAppServerProvider({ workingDirectory: join(temporaryRoot, 'oauth-bridge') });
  const account = await provider.account();
  const models = await provider.listModels();
  assert.ok(account, 'ChatGPT OAuth account is not connected');
  const textDescriptor = models.find((candidate) => candidate.id === textModel);
  const visionDescriptor = models.find((candidate) => candidate.id === visionModel);
  assert.ok(textDescriptor, `Authorized text model is unavailable: ${textModel}`);
  assert.ok(visionDescriptor?.supportsVision, `Authorized vision model is unavailable or lacks image input: ${visionModel}`);
  console.log(JSON.stringify({ type: 'provider', connected: true, plan: account.plan || null, textModel, visionModel }));
  for (const [index, set] of corpus.sets.entries()) {
    const checkpoint = results.get(set.id);
    if (checkpoint?.status === 'passed') {
      console.log(JSON.stringify({ type: 'paper-checkpoint', index: index + 1, total: corpus.sets.length, setId: set.id, status: 'passed', usage: checkpoint.usage }));
      continue;
    }
    console.log(JSON.stringify({ type: 'paper-start', index: index + 1, total: corpus.sets.length, setId: set.id, title: set.title, documents: set.revisions.length }));
    const result = await runDocumentSet(set, index, corpus.sets.length, models, tracker, checkpoint?.usage || zeroUsage());
    results.set(set.id, result);
    saveRunCheckpoint(fingerprint, corpus.corpusIdentity, suppliedAuthorization, results);
    console.log(JSON.stringify({ type: 'paper-result', index: index + 1, total: corpus.sets.length, setId: set.id, status: result.status, usage: result.usage, quality: result.quality?.status }));
    if (result.status === 'stopped_low_disk') break;
  }
  const accessiblePassed = corpus.sets.length > 0 && corpus.sets.every((set) => results.get(set.id)?.status === 'passed');
  const fullCorpusComplete = accessiblePassed
    && corpus.revisions.every((revision) => results.get(corpus.setByHash.get(revision.hash))?.status === 'passed')
    && [...results.values()].every((result) => result.sourceUnchanged !== false)
    && inventory.fingerprint === fingerprint;
  const mapped = attachmentResults(corpus, new Map(inventory.sets.map((set) => [set.id, set])), results);
  const summary = {
    schemaVersion: 2, kind: 'zotero-paper-reader-v2-real-corpus-acceptance',
    startedAt, completedAt: new Date().toISOString(), fingerprint, corpusIdentity: corpus.corpusIdentity,
    authorizationId: suppliedAuthorization, textModel, visionModel, modules: PAPER_READER_V2_DEFAULT_MODULES,
    inventoryBudget: inventory.totals, consumed: tracker.consumed,
    fullCorpusComplete,
    zotero: {
      dataDirectory: zoteroRoot, enumerationMode: zoteroEnumerationMode,
      pdfAttachments: attachments.length, accessible: corpus.accessible.length,
      missing: corpus.missing.length, uniqueAccessibleRevisions: corpus.revisions.length, documentSets: corpus.sets.length,
    },
    counts: Object.fromEntries([...new Set(mapped.map((item) => item.status))].sort().map((status) => [status, mapped.filter((item) => item.status === status).length])),
    sets: corpus.sets.map((set) => ({ id: set.id, title: set.title, hashes: set.revisions.map((item) => item.hash), ...(results.get(set.id) || { status: 'not_run' }) })),
    attachments: mapped, initialFreeBytes, finalFreeBytes: diskFreeBytes(workspace),
  };
  atomicJson(finalPath, summary);
  console.log(JSON.stringify({ type: 'final-summary', fullCorpusComplete, ...summary.counts, consumed: summary.consumed, finalPath }));
  if (!fullCorpusComplete) process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    activePaperCleanup?.();
    void provider?.dispose().catch(() => undefined).finally(() => {
      cleanTemporaryRoot();
      process.exit(130);
    });
  });
}

process.once('exit', () => {
  activePaperCleanup?.();
  cleanTemporaryRoot();
});

try {
  if (!existsSync(worker) || !statSync(worker).isFile()) throw new Error(`Reader worker not found: ${worker}`);
  mkdirSync(outputRoot, { recursive: true });
  cleanStaleTemporaryRoots();
  mkdirSync(temporaryRoot, { recursive: true });
  if (runMode) await runRealCorpus();
  else await runInventory();
} finally {
  await provider?.dispose().catch(() => undefined);
  cleanTemporaryRoot();
}
