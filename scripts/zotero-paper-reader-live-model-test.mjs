#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
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
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { SqliteEventStore } from '../packages/runtime/dist/events/event-store.js';
import { ModelGenerationService } from '../packages/runtime/dist/models/model-generation-service.js';
import { CodexAppServerProvider } from '../packages/runtime/dist/providers/codex-app-server-provider.js';
import { JobService } from '../packages/runtime/dist/workbench/job-service.js';
import { runPaperReaderAnalysis, runPaperReaderTranslation } from '../packages/runtime/dist/workbench/paper-reader-model-adapter.js';
import { PaperReaderService } from '../packages/runtime/dist/workbench/paper-reader-service.js';
import { ScientificKernelStore } from '../packages/runtime/dist/workbench/scientific-kernel-store.js';
import { WorkbenchService } from '../packages/runtime/dist/workbench/workbench-service.js';
import { WorktableStore } from '../packages/runtime/dist/worktable/worktable-store.js';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(workspace, 'artifacts', 'zotero-paper-reader-live-model-test');
const temporaryRoot = join(outputRoot, `.tmp-${process.pid}-${randomUUID()}`);
const zoteroRoot = resolve(process.env.ZOTERO_DATA_DIR || 'D:\\Study\\zotero');
const worker = resolve(process.env.READER_WORKER || join(workspace, 'packages', 'reader-runtime', 'dist', 'reader-worker', 'reader-worker.exe'));
const model = process.env.PAPER_READER_MODEL || 'chatgpt-oauth::gpt-5.6-luna';
const minimumFreeBytes = 8 * 1024 * 1024 * 1024;
const checkpointPath = join(outputRoot, 'checkpoint.json');
const summaryPath = join(outputRoot, 'latest.json');
const actor = { id: 'zotero-corpus-owner', kind: 'user', label: 'Zotero corpus owner' };
let cleaning = false;
let provider;
let activePaperCleanup;

function within(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep);
}

function safeRemove(target) {
  if (!within(temporaryRoot, target)) throw new Error(`Refusing to clean outside live-model sandbox: ${target}`);
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function safeRemoveFromOutput(target) {
  if (!within(outputRoot, target)) throw new Error(`Refusing to clean outside live-model output root: ${target}`);
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function cleanStaleTemporaryRoots() {
  if (!existsSync(outputRoot)) return;
  for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.tmp-')) continue;
    const target = join(outputRoot, entry.name);
    if (resolve(target) !== resolve(temporaryRoot)) safeRemoveFromOutput(target);
  }
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

function diskFreeBytes(path) {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

function requireDiskHeadroom() {
  const free = diskFreeBytes(workspace);
  if (free < minimumFreeBytes) throw new Error(`Live model corpus requires 8 GiB free; only ${(free / 1024 ** 3).toFixed(2)} GiB remains`);
  return free;
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

function implementationFingerprint() {
  const hash = createHash('sha256');
  const paths = [
    worker,
    join(workspace, 'packages', 'runtime', 'dist', 'workbench', 'paper-reader-service.js'),
    join(workspace, 'packages', 'runtime', 'dist', 'workbench', 'paper-reader-model-adapter.js'),
    join(workspace, 'packages', 'runtime', 'dist', 'models', 'model-generation-service.js'),
    join(workspace, 'packages', 'runtime', 'dist', 'providers', 'codex-app-server-provider.js'),
  ];
  for (const path of paths) {
    hash.update(path);
    hash.update(readFileSync(path));
  }
  hash.update(model);
  return hash.digest('hex');
}

function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function loadCheckpoint(fingerprint) {
  if (!existsSync(checkpointPath) || process.env.CORPUS_FRESH === '1') return new Map();
  try {
    const value = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    if (value?.schemaVersion !== 1 || value.model !== model || !value.results || typeof value.results !== 'object') return new Map();
    const entries = Object.entries(value.results).filter(([, result]) => result && typeof result === 'object');
    if (value.fingerprint === fingerprint) return new Map(entries);
    // A stricter input schema does not invalidate an already accepted output:
    // retain only records that prove the complete source/translation/evidence
    // invariants, and rerun every failed or incomplete revision.
    return new Map(entries.filter(([, result]) => result.status === 'passed'
      && Number(result.sourceBlockCount) > 0
      && result.translatedBlockCount === result.sourceBlockCount
      && result.conclusionCount === 9
      && Number(result.modelCalls) > 0
      && Number(result.consumedTokens) > 0));
  } catch {
    return new Map();
  }
}

function saveCheckpoint(fingerprint, processed) {
  atomicJson(checkpointPath, {
    schemaVersion: 1,
    fingerprint,
    model,
    updatedAt: new Date().toISOString(),
    results: Object.fromEntries(processed),
  });
}

function fieldValueSql(alias, itemAlias) {
  return `LEFT JOIN itemData ${alias}d ON ${alias}d.itemID=${itemAlias}.itemID AND ${alias}d.fieldID=tf.fieldID LEFT JOIN itemDataValues ${alias}v ON ${alias}v.valueID=${alias}d.valueID`;
}

function resolveAttachmentPath(row) {
  if (row.path.startsWith('storage:')) return join(zoteroRoot, 'storage', row.key, row.path.slice('storage:'.length));
  if (isAbsolute(row.path)) return row.path;
  if (row.path.startsWith('attachments:')) {
    const base = process.env.ZOTERO_LINKED_ATTACHMENT_BASE;
    return base ? resolve(base, row.path.slice('attachments:'.length)) : '';
  }
  return '';
}

function loadAttachmentsFromSnapshot() {
  const source = join(zoteroRoot, 'zotero.sqlite');
  if (!existsSync(source)) throw new Error(`Zotero database not found: ${source}`);
  const snapshot = join(temporaryRoot, 'zotero.sqlite');
  copyFileSync(source, snapshot);
  const sourceJournal = `${source}-journal`;
  if (existsSync(sourceJournal)) copyFileSync(sourceJournal, `${snapshot}-journal`);
  const database = new DatabaseSync(snapshot);
  try {
    const sql = `
      SELECT i.key, ia.parentItemID, p.key AS parentKey, ia.linkMode, ia.contentType, ia.path,
        COALESCE(pv.value, av.value, '') AS title
      FROM itemAttachments ia
      JOIN items i ON i.itemID=ia.itemID
      LEFT JOIN items p ON p.itemID=ia.parentItemID
      LEFT JOIN fieldsCombined tf ON tf.fieldName='title'
      ${fieldValueSql('p', 'p')}
      ${fieldValueSql('a', 'i')}
      LEFT JOIN deletedItems di ON di.itemID=i.itemID
      WHERE di.itemID IS NULL AND (lower(ia.contentType)='application/pdf' OR lower(ia.path) LIKE '%.pdf')
      ORDER BY i.key`;
    return database.prepare(sql).all().map((row) => ({
      key: String(row.key),
      parentKey: row.parentKey ? String(row.parentKey) : undefined,
      title: String(row.title || basename(String(row.path))).replace(/<[^>]+>/gu, ''),
      path: resolveAttachmentPath(row),
    }));
  } finally {
    database.close();
    rmSync(snapshot, { force: true });
    rmSync(`${snapshot}-journal`, { force: true });
  }
}

async function awaitReader(service, instanceId, timeoutMs = 90 * 60_000) {
  let lastStage = '';
  const timer = setInterval(() => {
    const reader = service.get(instanceId);
    if (reader.stage === lastStage) return;
    lastStage = reader.stage;
    console.log(JSON.stringify({
      type: 'paper-progress',
      instanceId,
      status: reader.status,
      stage: reader.stage,
      progress: reader.progress,
      translatedBlockCount: reader.translatedBlockCount ?? 0,
      translationBlockCount: reader.translationBlockCount ?? 0,
      modelCalls: reader.batchAuthorization?.completedModelCalls ?? 0,
      consumedTokens: reader.batchAuthorization?.consumedTokens ?? 0,
    }));
  }, 10_000);
  const timeout = setTimeout(() => service.cancel(instanceId, actor), timeoutMs);
  try {
    return await service.wait(instanceId);
  } finally {
    clearInterval(timer);
    clearTimeout(timeout);
  }
}

async function testPaper(attachment, hash, index, total, models) {
  requireDiskHeadroom();
  const root = join(temporaryRoot, `paper-${String(index + 1).padStart(3, '0')}-${attachment.key}`);
  mkdirSync(root, { recursive: true });
  const started = Date.now();
  let events;
  let jobs;
  let originalHash = hash;
  let paperCleaned = false;
  const cleanPaper = () => {
    if (paperCleaned) return;
    paperCleaned = true;
    jobs?.shutdown();
    events?.close();
    if (existsSync(root)) safeRemove(root);
  };
  activePaperCleanup = cleanPaper;
  try {
    const projectId = `zotero-paper-${attachment.key.toLocaleLowerCase()}`;
    events = new SqliteEventStore(join(root, 'events.sqlite'));
    const resolveRoot = (rootId) => {
      if (rootId === 'zotero-source') return dirname(attachment.path);
      const jobRoot = jobs?.rootFor(rootId);
      return jobRoot ?? root;
    };
    jobs = new JobService({
      projectId,
      events,
      root: join(root, 'jobs'),
      resolveRoot: (rootId) => resolveRoot(rootId),
      resolveToolchainExecutable: (toolchainId) => {
        assert.equal(toolchainId, 'openlab.reader-runtime');
        return worker;
      },
    });
    const kernel = new ScientificKernelStore({ projectId, events });
    const tables = new WorktableStore({ projectId, events });
    const workbenches = new WorkbenchService({ projectId, events, worktables: tables });
    const instance = workbenches.create({
      blueprintId: 'sci.paper-reader:deep-read',
      title: `${attachment.title} · Zotero 实测`,
      primaryConversationId: `zotero-corpus:${attachment.key}`,
      inputs: {
        mainPdf: {
          rootId: 'zotero-source', path: basename(attachment.path), name: basename(attachment.path),
          sha256: hash, size: statSync(attachment.path).size, mediaType: 'application/pdf',
        },
        supplements: [],
        language: 'zh-CN',
      },
    }, actor);
    const generations = new ModelGenerationService({
      projectId,
      events,
      provider: () => provider,
      models: () => models,
      resolveRoot: (rootId) => resolveRoot(rootId),
    });
    let reportSummary;
    let mountCount = 0;
    const service = new PaperReaderService({
      projectId,
      events,
      jobs,
      kernel,
      resolveRoot: (rootId) => resolveRoot(rootId),
      toolchainAvailable: () => true,
      createReportArtifact: (input) => {
        const report = JSON.parse(input.json);
        reportSummary = {
          title: input.title,
          markdownBytes: Buffer.byteLength(input.markdown),
          jsonBytes: Buffer.byteLength(input.json),
          translationCount: Object.keys(report.analysis?.translations ?? {}).length,
          conclusionCount: report.analysis?.conclusions?.length ?? 0,
          termCount: report.analysis?.terms?.length ?? 0,
        };
        return { artifactId: `corpus-report-${attachment.key}`, revisionId: `corpus-report-${hash}` };
      },
      mountReport: () => { mountCount += 1; },
      model: () => model,
      translate: async (input, runActor, signal) => await runPaperReaderTranslation(generations, input, runActor, signal),
      analyze: async (input, runActor, signal) => await runPaperReaderAnalysis(generations, input, runActor, signal),
    });
    service.configure(instance, actor);
    service.prepare(instance.id, actor);
    let reader = await awaitReader(service, instance.id, 10 * 60_000);
    if (reader.status !== 'ready') throw new Error(reader.error ?? `Preflight ended in ${reader.status}`);
    const preview = service.callPreview(instance.id);
    assert.equal(preview.ready, true);
    assert.equal(preview.model, model);
    assert.throws(() => service.start(instance.id, actor), /确认/u, 'The task started without the required one-time confirmation');
    service.start(instance.id, actor, true);
    reader = await awaitReader(service, instance.id);
    for (let attempt = 2; attempt <= 3 && ['failed', 'interrupted'].includes(reader.status); attempt += 1) {
      if (reader.batchAuthorization?.status !== 'active') break;
      console.log(JSON.stringify({ type: 'paper-retry', key: attachment.key, attempt, reason: reader.error ?? reader.stage }));
      service.resume(instance.id, actor);
      reader = await awaitReader(service, instance.id);
    }
    if (reader.status !== 'completed') throw new Error(reader.error ?? `Reader ended in ${reader.status}: ${reader.stage}`);
    const context = service.context(instance.id, null);
    const translationCount = Object.keys(context.analysis.translations).length;
    assert.equal(context.analysis.conclusions.length, 9);
    assert.ok(context.analysis.conclusions.every((item) => item.evidenceAnchorIds.length > 0 && item.blockIds.length > 0));
    assert.equal(translationCount, reader.translationBlockCount);
    assert.equal(reader.translatedBlockCount, reader.translationBlockCount);
    assert.equal(reader.batchAuthorization?.status, 'completed');
    assert.ok((reader.batchAuthorization?.completedModelCalls ?? 0) <= (reader.batchAuthorization?.modelCallLimit ?? 0));
    assert.ok((reader.batchAuthorization?.consumedTokens ?? 0) <= (reader.batchAuthorization?.maximumTotalTokens ?? 0));
    assert.equal(mountCount, 1);
    assert.equal(reportSummary?.translationCount, translationCount);
    assert.equal(reportSummary?.conclusionCount, 9);
    const finalHash = await sha256(attachment.path);
    assert.equal(finalHash, originalHash, 'The Zotero source PDF changed during the model task');
    return {
      status: 'passed',
      pageCount: reader.inspectedPageCount ?? 0,
      textCharacters: reader.inspectedTextCharacters ?? 0,
      sourceBlockCount: reader.translationBlockCount ?? 0,
      translatedBlockCount: reader.translatedBlockCount ?? 0,
      conclusionCount: reader.conclusionCount,
      termCount: reader.termCount,
      modelCalls: reader.batchAuthorization?.completedModelCalls ?? 0,
      consumedTokens: reader.batchAuthorization?.consumedTokens ?? 0,
      estimatedTotalTokens: reader.batchAuthorization?.estimatedTotalTokens ?? 0,
      maximumTotalTokens: reader.batchAuthorization?.maximumTotalTokens ?? 0,
      generationCount: reader.modelGenerationIds?.length ?? 0,
      reportMarkdownBytes: reportSummary?.markdownBytes ?? 0,
      reportJsonBytes: reportSummary?.jsonBytes ?? 0,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    const finalHash = await sha256(attachment.path).catch(() => 'unavailable');
    return {
      status: 'failed',
      sourceUnchanged: finalHash === originalHash,
      error: (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 16_000),
      elapsedMs: Date.now() - started,
    };
  } finally {
    cleanPaper();
    if (activePaperCleanup === cleanPaper) activePaperCleanup = undefined;
    console.log(JSON.stringify({ type: 'cleanup', key: attachment.key, index: index + 1, total, temporaryBytesRetained: 0 }));
  }
}

async function main() {
  if (!existsSync(worker) || !statSync(worker).isFile()) throw new Error(`Reader worker not found: ${worker}`);
  mkdirSync(outputRoot, { recursive: true });
  cleanStaleTemporaryRoots();
  mkdirSync(temporaryRoot, { recursive: true });
  const startedAt = new Date().toISOString();
  const initialFreeBytes = requireDiskHeadroom();
  const fingerprint = implementationFingerprint();
  const attachments = loadAttachmentsFromSnapshot();
  const missing = attachments.filter((item) => !item.path || !existsSync(item.path));
  const accessible = attachments.filter((item) => item.path && existsSync(item.path));
  const hashGroups = new Map();
  for (const attachment of accessible) {
    const hash = await sha256(attachment.path);
    const group = hashGroups.get(hash) ?? [];
    group.push({ ...attachment, hash });
    hashGroups.set(hash, group);
  }
  let unique = [...hashGroups.entries()].map(([hash, group]) => ({ hash, group, representative: group[0] }));
  const requestedKeys = new Set((process.env.PAPER_READER_KEYS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  if (requestedKeys.size > 0) unique = unique.filter((item) => requestedKeys.has(item.representative.key));
  const limit = Math.max(0, Math.trunc(Number(process.env.PAPER_READER_LIMIT ?? 0)));
  if (limit > 0) unique = unique.slice(0, limit);
  const partial = requestedKeys.size > 0 || limit > 0;
  console.log(JSON.stringify({
    type: 'inventory', model, pdfAttachments: attachments.length, accessible: accessible.length,
    missing: missing.length, selectedUniqueRevisions: unique.length, partial, initialFreeBytes, fingerprint,
  }));

  provider = new CodexAppServerProvider({ workingDirectory: join(temporaryRoot, 'oauth-bridge') });
  const account = await provider.account();
  const models = await provider.listModels();
  assert.ok(account, 'ChatGPT OAuth account is not connected');
  assert.ok(models.some((candidate) => candidate.id === model), `Requested model is unavailable: ${model}`);
  console.log(JSON.stringify({ type: 'provider', connected: true, plan: account.plan ?? null, model }));

  const processed = loadCheckpoint(fingerprint);
  for (const [index, item] of unique.entries()) {
    const checkpoint = processed.get(item.hash);
    if (checkpoint?.status === 'passed') {
      console.log(JSON.stringify({ type: 'paper-checkpoint', index: index + 1, total: unique.length, key: item.representative.key, sha256: item.hash, ...checkpoint }));
      continue;
    }
    console.log(JSON.stringify({ type: 'paper-start', index: index + 1, total: unique.length, key: item.representative.key, title: item.representative.title, sha256: item.hash }));
    const result = await testPaper(item.representative, item.hash, index, unique.length, models);
    processed.set(item.hash, result);
    saveCheckpoint(fingerprint, processed);
    console.log(JSON.stringify({ type: 'paper-result', index: index + 1, total: unique.length, key: item.representative.key, sha256: item.hash, ...result }));
    if (result.status === 'failed' && process.env.CONTINUE_AFTER_FAILURE !== '1') break;
  }

  const selectedHashes = new Set(unique.map((item) => item.hash));
  const selectedResults = unique.map((item) => ({
    key: item.representative.key,
    parentKey: item.representative.parentKey,
    title: item.representative.title,
    sha256: item.hash,
    ...(processed.get(item.hash) ?? { status: 'not_run' }),
  }));
  const completedSelection = selectedResults.every((item) => item.status === 'passed');
  const allUnique = [...hashGroups.keys()];
  const fullCorpusComplete = !partial && allUnique.every((hash) => processed.get(hash)?.status === 'passed');
  const results = partial ? selectedResults : [
    ...selectedResults,
    ...missing.map((item) => ({ key: item.key, parentKey: item.parentKey, title: item.title, status: 'missing_attachment' })),
  ];
  const summary = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    fingerprint,
    model,
    partial,
    completedSelection,
    fullCorpusComplete,
    zotero: {
      pdfAttachments: attachments.length,
      accessible: accessible.length,
      missing: missing.length,
      uniqueAccessibleRevisions: hashGroups.size,
      selectedUniqueRevisions: selectedHashes.size,
    },
    counts: Object.fromEntries([...new Set(results.map((item) => item.status))].sort().map((status) => [status, results.filter((item) => item.status === status).length])),
    totalConsumedTokens: selectedResults.reduce((total, item) => total + Number(item.consumedTokens ?? 0), 0),
    initialFreeBytes,
    finalFreeBytes: diskFreeBytes(workspace),
    results,
  };
  atomicJson(partial ? join(outputRoot, 'canary-latest.json') : summaryPath, summary);
  console.log(JSON.stringify({ type: 'summary', ...summary.counts, partial, completedSelection, fullCorpusComplete, totalConsumedTokens: summary.totalConsumedTokens }));
  if (!completedSelection || (!partial && !fullCorpusComplete)) process.exitCode = 1;
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
  await main();
} finally {
  await provider?.dispose().catch(() => undefined);
  cleanTemporaryRoot();
}
