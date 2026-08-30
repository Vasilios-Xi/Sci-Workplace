#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(workspace, 'artifacts', 'zotero-paper-reader-test');
const temporaryRoot = join(outputRoot, `.tmp-${process.pid}-${randomUUID()}`);
const zoteroRoot = resolve(process.env.ZOTERO_DATA_DIR || 'D:\\Study\\zotero');
const worker = resolve(process.env.READER_WORKER || join(workspace, 'packages', 'reader-runtime', 'dist', 'reader-worker', 'reader-worker.exe'));
const minimumFreeBytes = 8 * 1024 * 1024 * 1024;
const checkpointPath = join(outputRoot, 'checkpoint.json');
let cleaning = false;

function within(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep);
}

function safeRemove(target) {
  if (!within(temporaryRoot, target)) throw new Error(`Refusing to clean outside corpus-test sandbox: ${target}`);
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function safeRemoveFromOutput(target) {
  if (!within(outputRoot, target)) throw new Error(`Refusing to clean outside corpus-test output root: ${target}`);
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    if (resolve(target) === resolve(temporaryRoot)) continue;
    safeRemoveFromOutput(target);
  }
}

function loadCheckpoint() {
  if (!existsSync(checkpointPath) || process.env.CORPUS_FRESH === '1') return new Map();
  try {
    const value = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    if (value?.schemaVersion !== 1 || !value.results || typeof value.results !== 'object') return new Map();
    return new Map(Object.entries(value.results).filter(([, result]) => result && typeof result === 'object'));
  } catch {
    return new Map();
  }
}

function saveCheckpoint(processed) {
  const temporary = `${checkpointPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({
    schemaVersion: 1,
    worker: { path: worker, size: statSync(worker).size, modifiedAt: statSync(worker).mtime.toISOString() },
    updatedAt: new Date().toISOString(),
    results: Object.fromEntries(processed),
  }, null, 2)}\n`, 'utf8');
  renameSync(temporary, checkpointPath);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanTemporaryRoot();
    process.exit(130);
  });
}

function diskFreeBytes(path) {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

function requireDiskHeadroom() {
  const free = diskFreeBytes(workspace);
  if (free < minimumFreeBytes) throw new Error(`Corpus test requires 8 GiB free; only ${(free / 1024 ** 3).toFixed(2)} GiB remains`);
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
      linkMode: Number(row.linkMode),
      title: String(row.title || basename(String(row.path))).replace(/<[^>]+>/gu, ''),
      path: resolveAttachmentPath(row),
    }));
  } finally {
    database.close();
    rmSync(snapshot, { force: true });
    rmSync(`${snapshot}-journal`, { force: true });
  }
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

async function inspectAndParse(attachment, hash, index, total) {
  requireDiskHeadroom();
  const root = join(temporaryRoot, `paper-${String(index + 1).padStart(3, '0')}-${attachment.key}`);
  mkdirSync(root, { recursive: true });
  const started = Date.now();
  try {
    const inspectionPath = join(root, 'inspection.json');
    await runWorker(['inspect', '--input', attachment.path, '--output', inspectionPath], 5 * 60_000);
    const inspection = JSON.parse(readFileSync(inspectionPath, 'utf8'));
    if (inspection.has_text_layer !== true || Number(inspection.text_characters || 0) <= 0) {
      return {
        status: 'unsupported_scanned',
        pageCount: Number(inspection.page_count || 0),
        textCharacters: Number(inspection.text_characters || 0),
        elapsedMs: Date.now() - started,
      };
    }
    const parsedRoot = join(root, 'parsed');
    await runWorker(['parse', '--input', attachment.path, '--revision', hash, '--output-dir', parsedRoot], 30 * 60_000);
    const parsedPath = join(parsedRoot, 'reader_document.json');
    if (!existsSync(parsedPath)) throw new Error('reader_document.json was not produced');
    const parsed = JSON.parse(readFileSync(parsedPath, 'utf8'));
    if (parsed.revisionHash !== hash) throw new Error('Parsed revision hash does not match the Zotero PDF');
    if (!parsed.paper || !Array.isArray(parsed.blocks) || !Array.isArray(parsed.figures) || !Array.isArray(parsed.pages)) throw new Error('Parsed reader document contract is incomplete');
    const sourceBlocks = parsed.blocks.filter((block) => !['running_matter', 'reference', 'front_matter'].includes(block.type) && String(block.originalText || '').trim().length >= 16);
    if (sourceBlocks.length === 0) throw new Error('No evidence-bearing source blocks were produced');
    return {
      status: 'passed',
      pageCount: Number(parsed.paper.pageCount || inspection.page_count || 0),
      textCharacters: Number(parsed.paper.textCharacters || inspection.text_characters || 0),
      blockCount: parsed.blocks.length,
      sourceBlockCount: sourceBlocks.length,
      figureCount: parsed.figures.length,
      warningCount: Array.isArray(parsed.warnings) ? parsed.warnings.length : 0,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return { status: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 12_000), elapsedMs: Date.now() - started };
  } finally {
    safeRemove(root);
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
  const attachments = loadAttachmentsFromSnapshot();
  const missing = attachments.filter((item) => !item.path || !existsSync(item.path));
  const accessible = attachments.filter((item) => item.path && existsSync(item.path));
  console.log(JSON.stringify({ type: 'inventory', pdfAttachments: attachments.length, accessible: accessible.length, missing: missing.length, initialFreeBytes }));

  const hashGroups = new Map();
  for (const [index, attachment] of accessible.entries()) {
    const hash = await sha256(attachment.path);
    const group = hashGroups.get(hash) || [];
    group.push({ ...attachment, hash, inventoryIndex: index });
    hashGroups.set(hash, group);
  }
  const unique = [...hashGroups.entries()].map(([hash, group]) => ({ hash, group, representative: group[0] }));
  const processed = loadCheckpoint();
  for (const [index, item] of unique.entries()) {
    const checkpoint = processed.get(item.hash);
    if (checkpoint?.status === 'passed' || checkpoint?.status === 'unsupported_scanned') {
      console.log(JSON.stringify({ type: 'paper-checkpoint', index: index + 1, total: unique.length, key: item.representative.key, sha256: item.hash, ...checkpoint }));
      continue;
    }
    console.log(JSON.stringify({ type: 'paper-start', index: index + 1, total: unique.length, key: item.representative.key, title: item.representative.title, sha256: item.hash }));
    const result = await inspectAndParse(item.representative, item.hash, index, unique.length);
    processed.set(item.hash, result);
    saveCheckpoint(processed);
    console.log(JSON.stringify({ type: 'paper-result', index: index + 1, total: unique.length, key: item.representative.key, sha256: item.hash, ...result }));
  }

  const results = accessible.map((attachment) => {
    const hash = [...hashGroups].find(([, group]) => group.some((item) => item.key === attachment.key))?.[0];
    const result = hash ? processed.get(hash) : { status: 'failed', error: 'hash group missing' };
    const duplicateOf = hash ? hashGroups.get(hash)?.[0]?.key : undefined;
    return {
      key: attachment.key,
      parentKey: attachment.parentKey,
      title: attachment.title,
      sha256: hash,
      duplicateOf: duplicateOf !== attachment.key ? duplicateOf : undefined,
      ...result,
    };
  });
  for (const item of missing) results.push({ key: item.key, parentKey: item.parentKey, title: item.title, status: 'missing_attachment' });
  const summary = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    worker,
    zotero: {
      pdfAttachments: attachments.length,
      accessible: accessible.length,
      missing: missing.length,
      uniqueAccessibleRevisions: unique.length,
    },
    counts: Object.fromEntries([...new Set(results.map((item) => item.status))].sort().map((status) => [status, results.filter((item) => item.status === status).length])),
    initialFreeBytes,
    finalFreeBytes: diskFreeBytes(workspace),
    results,
  };
  writeFileSync(join(outputRoot, 'latest.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ type: 'summary', ...summary.counts, summaryPath: join(outputRoot, 'latest.json') }));
  if (results.some((item) => item.status === 'failed')) process.exitCode = 1;
}

try {
  await main();
} finally {
  cleanTemporaryRoot();
}
