import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import plugin from '../packages/citation-plugin/dist/index.js';
import { BibliographyService } from '../packages/runtime/dist/workbench/bibliography-service.js';
import { CitationDocumentService } from '../packages/runtime/dist/workbench/citation-document-service.js';
import {
  RestrictedDocxZoteroProcessor,
  ZoteroHttpCitingAdapter,
} from '../packages/runtime/dist/workbench/zotero-document-processor-adapter.js';
import { ZoteroHostService } from '../packages/runtime/dist/workbench/zotero-host-service.js';

const require = createRequire(new URL('../packages/runtime/package.json', import.meta.url));
const AdmZip = require('adm-zip');

const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DEFAULT_DESKTOP = 'C:/Users/14746/Desktop';
const DEFAULT_OUTPUT = resolve('acceptance/citation-workbench-v1');
const COMPANION_PATH = resolve('integrations/zotero-companion/dist/sci-workplace-zotero-companion.xpi');
const MODEL_ID = 'acceptance-conservative-evidence-gate-v1';
const EXPECTED = [
  { name: '22(2).docx', sha256: 'b7167c82b02cf34b8bd9c34bd98c9d60c5ae7ce88eab9633ce5deab2245774c3' },
  { name: '参考文献测试.docx', sha256: '0d0d5ed4c16a2962f727d7242bc108779c604a5dbe14184ec375f669ac2ff821' },
  { name: '测试11(1).docx', sha256: '6a69b4db2aa1aad0ef42710e46399ee94dc92a34fdc58d117461fef8c6229ead' },
];

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]) : fallback;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function zoteroRecord(item) {
  return {
    schemaVersion: 1,
    canonicalId: item.doi
      ? `doi:${item.doi.toLowerCase()}`
      : item.pmid
        ? `pmid:${item.pmid}`
        : item.arxivId
          ? `arxiv:${item.arxivId.toLowerCase()}`
          : `zotero:${item.libraryId}:${item.key}`,
    itemType: 'journalArticle',
    title: item.title,
    creators: item.creators,
    ...(item.issuedYear ? { issuedYear: item.issuedYear } : {}),
    ...(item.doi ? { doi: item.doi } : {}),
    ...(item.pmid ? { pmid: item.pmid } : {}),
    ...(item.arxivId ? { arxivId: item.arxivId } : {}),
    ...(item.url ? { url: item.url } : {}),
    retractionStatus: 'unknown',
    source: 'zotero',
    retrievedAt: new Date().toISOString(),
  };
}

function dynamicFieldCount(path) {
  const zip = new AdmZip(readFileSync(path));
  return ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'].reduce((total, part) => {
    const xml = zip.getEntry(part)?.getData().toString('utf8') ?? '';
    return total + (xml.match(/ADDIN ZOTERO_(?:ITEM|BIBL)/gu)?.length ?? 0);
  }, 0);
}

function decodeXmlText(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function visibleXml(path) {
  const zip = new AdmZip(readFileSync(path));
  return ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']
    .map((part) => {
      const xml = zip.getEntry(part)?.getData().toString('utf8') ?? '';
      return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/gu)]
        .map((match) => match[1] === undefined ? (match[0].startsWith('<w:tab') ? '\t' : '\n') : decodeXmlText(match[1]))
        .join('');
    })
    .join('\n');
}

function dynamicBibliographyText(path) {
  const xml = new AdmZip(readFileSync(path)).readAsText('word/document.xml');
  const codeIndex = xml.indexOf('ADDIN ZOTERO_BIBL');
  if (codeIndex < 0) return undefined;
  const paragraphStart = xml.lastIndexOf('<w:p', codeIndex);
  const paragraphEnd = xml.indexOf('</w:p>', codeIndex);
  if (paragraphStart < 0 || paragraphEnd < 0) throw new Error('Zotero bibliography field is not enclosed by a DOCX paragraph');
  const paragraph = xml.slice(paragraphStart, paragraphEnd + '</w:p>'.length);
  return [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)].map((match) => decodeXmlText(match[1] ?? '')).join('');
}

const desktop = argument('--desktop', DEFAULT_DESKTOP);
const outputRoot = argument('--output', DEFAULT_OUTPUT);
const scanOnly = process.argv.includes('--scan-only');
mkdirSync(outputRoot, { recursive: true });
mkdirSync(join(outputRoot, '.cache'), { recursive: true });

const documents = new CitationDocumentService({
  resolveRoot: (_rootId, intent) => intent === 'read' ? desktop : outputRoot,
});
let bibliography;
const zotero = new ZoteroHostService({
  documents,
  attachment: (id) => bibliography?.attachment(id),
  companionPath: COMPANION_PATH,
});
bibliography = new BibliographyService({
  cacheRoot: join(outputRoot, '.cache', 'bibliography'),
  searchLocal: async (query) => (await zotero.search({
    ...(query.manager === 'zotero' && query.managerKey ? { key: query.managerKey } : {}),
    ...(query.doi ? { doi: query.doi } : {}),
    ...(query.pmid ? { pmid: query.pmid } : {}),
    ...(query.arxivId ? { arxivId: query.arxivId } : {}),
    ...(query.title ? { title: query.title } : {}),
    limit: 25,
  })).map(zoteroRecord),
});

const workflow = plugin.workflows?.find((candidate) => candidate.definition.id === 'sci.citation-workbench:repair');
if (!workflow) throw new Error('Bundled Citation Workbench workflow is missing');

const bindingPath = join(outputRoot, 'collection-bindings.json');
const bindings = readJson(bindingPath, {});
const storage = new Map();
const revisions = new Map();
let activeSample;

const host = {
  bibliography: {
    scanDocument: async (source) => documents.scan(source),
    resolve: async (request) => await bibliography.resolve(request),
    verifyMetadata: async (record) => await bibliography.verifyMetadata(record),
    fetchOpenAccess: async (record) => await bibliography.fetchOpenAccess(record),
  },
  zotero: {
    status: async () => await zotero.status(),
    search: async (request) => await zotero.search(request),
    planSync: async (request) => await zotero.planSync(request),
    commitSync: async (planId, confirmed) => await zotero.commitSync(planId, confirmed),
    materializeCitationDocument: async (plan) => zotero.materializeCitationDocument(plan),
  },
  models: {
    runStructured: async () => ({
      status: 'completed',
      json: {
        status: 'insufficient',
        evidence: '',
        rationale: '验收运行没有提供可定位到摘要或全文的直接支持证据；按保守门禁跳过正文引用。',
      },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  },
  workflows: {
    report: async (_jobId, update) => {
      process.stdout.write(`${JSON.stringify({ event: 'progress', sample: activeSample?.name, progress: update.progress, stage: update.stage })}\n`);
    },
  },
  storage: {
    get: async (scope, key) => {
      const value = storage.get(`${scope}:${key}`);
      return value === undefined ? undefined : { value };
    },
    put: async (scope, key, value) => {
      storage.set(`${scope}:${key}`, value);
      return { value };
    },
  },
  artifacts: {
    revisions: async (artifactId) => revisions.get(artifactId) ?? [],
    createRevision: async (input) => {
      if (!activeSample) throw new Error('Artifact write has no active acceptance sample');
      const sampleDirectory = join(outputRoot, activeSample.stem);
      mkdirSync(sampleDirectory, { recursive: true });
      for (const file of input.files ?? []) {
        if (typeof file.content === 'string') writeFileSync(join(sampleDirectory, file.name), file.content, 'utf8');
      }
      const revision = {
        id: `acceptance-revision-${digest(`${input.artifactId}:${activeSample.source.sha256}`).slice(0, 20)}`,
        artifactId: input.artifactId,
        createdAt: new Date().toISOString(),
      };
      revisions.set(input.artifactId, [...(revisions.get(input.artifactId) ?? []), revision]);
      return revision;
    },
  },
  workbenches: { mount: async () => ({}) },
};

if (scanOnly) {
  const samples = [];
  for (const sample of EXPECTED) {
    const sourceBytes = readFileSync(join(desktop, sample.name));
    const sourceSha256 = digest(sourceBytes);
    if (sourceSha256 !== sample.sha256) throw new Error(`${sample.name} source hash changed: ${sourceSha256}`);
    const stem = basename(sample.name, '.docx');
    const source = { ref: { rootId: 'citation-acceptance-sources', path: sample.name }, sha256: sourceSha256, size: sourceBytes.length, mediaType: DOCX_MEDIA_TYPE };
    const inspection = documents.scan(source);
    const invalid = inspection.units.filter((unit) => !['recognized', 'needs_input'].includes(unit.recognitionStatus) || !unit.recognizedFormat);
    if (invalid.length > 0) throw new Error(`${sample.name} contains units without a whitelist decision`);
    const units = inspection.units.map((unit) => ({
      unitId: unit.id,
      kind: unit.kind,
      recognitionStatus: unit.recognitionStatus,
      recognizedFormat: unit.recognizedFormat,
      originalText: unit.raw,
      referenceOnly: unit.referenceOnly,
      locator: {
        part: unit.part,
        paragraphIndex: unit.paragraphIndex,
        paragraphNumber: unit.paragraphIndex + 1,
        start: unit.start,
        end: unit.end,
        label: `${unit.part === 'word/document.xml' ? '正文' : unit.part === 'word/footnotes.xml' ? '脚注' : unit.part === 'word/endnotes.xml' ? '尾注' : unit.part}第 ${unit.paragraphIndex + 1} 段 · 段内字符 ${unit.start}–${unit.end}`,
        context: unit.context,
      },
    }));
    const result = {
      sample: sample.name,
      sourceSha256,
      sourceHashUnchanged: digest(readFileSync(join(desktop, sample.name))) === sample.sha256,
      detectedUnits: units.length,
      recognized: units.filter((unit) => unit.recognitionStatus === 'recognized').length,
      needsInput: units.filter((unit) => unit.recognitionStatus === 'needs_input').length,
      formatCounts: Object.fromEntries([...new Set(units.map((unit) => unit.recognizedFormat))].sort().map((format) => [format, units.filter((unit) => unit.recognizedFormat === format).length])),
      supportedInputFormats: inspection.supportedInputFormats,
      units,
      unrecognizedItems: units.filter((unit) => unit.recognitionStatus === 'needs_input'),
    };
    const sampleDirectory = join(outputRoot, stem);
    mkdirSync(sampleDirectory, { recursive: true });
    writeJson(join(sampleDirectory, 'whitelist-scan-acceptance.json'), result);
    samples.push(result);
    process.stdout.write(`${JSON.stringify({ event: 'scan_sample_complete', sample: sample.name, detectedUnits: result.detectedUnits, recognized: result.recognized, needsInput: result.needsInput })}\n`);
  }
  writeJson(join(outputRoot, 'whitelist-scan-summary.json'), { schemaVersion: 1, plugin: 'sci.citation-workbench', mode: 'fixed-format-scan-only', samples });
  process.stdout.write(`${JSON.stringify({ event: 'scan_acceptance_complete', outputRoot, samples: samples.length })}\n`);
  process.exit(0);
}

const startingStatus = await zotero.status();
if (startingStatus.mode !== 'companion' && startingStatus.mode !== 'native-local-api') {
  throw new Error(`Zotero write provider unavailable: ${startingStatus.mode}`);
}
process.stdout.write(`${JSON.stringify({ event: 'zotero_ready', status: startingStatus, note: 'The first protected call may request one Zotero session approval.' })}\n`);

const results = [];
for (const sample of EXPECTED) {
  const sourceBytes = readFileSync(join(desktop, sample.name));
  const sourceSha256 = digest(sourceBytes);
  if (sourceSha256 !== sample.sha256) throw new Error(`${sample.name} source hash changed: ${sourceSha256}`);
  const stem = basename(sample.name, '.docx');
  const source = {
    ref: { rootId: 'citation-acceptance-sources', path: sample.name },
    sha256: sourceSha256,
    size: sourceBytes.length,
    mediaType: DOCX_MEDIA_TYPE,
  };
  activeSample = { ...sample, stem, source };
  const operationKey = `citation-acceptance-${sourceSha256.slice(0, 40)}`;
  const collectionKey = typeof bindings[sample.name]?.collectionKey === 'string' ? bindings[sample.name].collectionKey : undefined;
  const input = {
    instanceId: `citation-acceptance:${stem}`,
    source,
    operationKey,
    styleId: 'vancouver',
    styleFamily: 'numeric',
    model: MODEL_ID,
    maximumTotalTokens: 60_000,
    collectionRoot: 'Sci Workplace',
    collectionChild: `${stem} · References`,
    referenceOverrides: [],
    ...(collectionKey ? { collectionKey } : {}),
  };
  const result = await workflow.run(input, {
    host,
    jobId: `acceptance-job-${sourceSha256.slice(0, 16)}`,
    traceId: `acceptance-trace-${sourceSha256.slice(0, 16)}`,
    sessionId: 'citation-workbench-acceptance',
    agentId: 'citation-workbench-acceptance-runner',
    signal: new AbortController().signal,
    resume: false,
  });
  const internalRef = result.metadata?.output;
  if (!internalRef?.path) throw new Error(`${sample.name} workflow did not return a revised document`);
  const internalPath = join(outputRoot, internalRef.path);
  const sampleDirectory = join(outputRoot, stem);
  const finalPath = join(sampleDirectory, `${stem}.citation-revised.docx`);
  const fieldCountBeforeRefresh = dynamicFieldCount(internalPath);
  let refresh;
  if (fieldCountBeforeRefresh > 0) {
    const temporaryPath = join(sampleDirectory, `.zotero-refresh-${process.pid}-${randomUUID()}.docx`);
    try {
      const processor = new RestrictedDocxZoteroProcessor({
        sourcePath: internalPath,
        outputPath: temporaryPath,
        documentId: `sci-citation-${sourceSha256.slice(0, 20)}`,
      });
      refresh = await new ZoteroHttpCitingAdapter().refresh(processor);
      if (!refresh.completed || refresh.errorCount !== 0) throw new Error(`${sample.name} Zotero field refresh failed: ${JSON.stringify(refresh.alerts ?? [])}`);
      copyFileSync(temporaryPath, finalPath);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  } else {
    copyFileSync(internalPath, finalPath);
    refresh = { completed: true, skipped: true, reason: 'no_dynamic_zotero_fields' };
  }
  writeJson(join(sampleDirectory, 'zotero-field-refresh-receipt.json'), refresh);

  const auditPath = join(sampleDirectory, 'citation-audit.json');
  const audit = readJson(auditPath, undefined);
  if (!audit || !Array.isArray(audit.decisions) || audit.decisions.length !== audit.detectedUnits) {
    throw new Error(`${sample.name} audit does not account for every detected citation unit`);
  }
  const invalid = audit.decisions.filter((decision) => !['applied', 'unrecognized', 'ambiguous', 'insufficient_support', 'contradicted', 'retracted_or_corrected', 'sync_failed'].includes(decision.status));
  if (invalid.length) throw new Error(`${sample.name} has invalid decision statuses`);
  const finalXml = visibleXml(finalPath);
  for (const placeholder of audit.decisions.filter((decision) => decision.originalText === '[XX]' || decision.originalText === '找参考文献')) {
    if (!finalXml.includes(placeholder.originalText)) throw new Error(`${sample.name} changed placeholder ${placeholder.originalText}`);
  }
  const finalBytes = readFileSync(finalPath);
  const bibliographyText = dynamicBibliographyText(finalPath);
  if (bibliographyText !== undefined && (!bibliographyText.trim() || bibliographyText.includes('Refresh with Zotero'))) {
    throw new Error(`${sample.name} dynamic bibliography was not populated by Zotero`);
  }
  const receipt = audit.zotero ?? {};
  if (receipt.collectionKey) bindings[sample.name] = { collectionKey: receipt.collectionKey, collectionName: receipt.collectionName };
  const summary = {
    sample: sample.name,
    sourceSha256,
    sourceHashUnchanged: digest(readFileSync(join(desktop, sample.name))) === sample.sha256,
    readiness: audit.readiness,
    detectedUnits: audit.detectedUnits,
    applied: audit.decisions.filter((decision) => decision.status === 'applied').length,
    skipped: audit.decisions.filter((decision) => decision.status !== 'applied').length,
    decisionCounts: Object.fromEntries([...new Set(audit.decisions.map((decision) => decision.status))].sort().map((status) => [status, audit.decisions.filter((decision) => decision.status === status).length])),
    finalPath,
    finalSha256: digest(finalBytes),
    finalSize: finalBytes.length,
    dynamicFieldsBeforeRefresh: fieldCountBeforeRefresh,
    dynamicFieldsAfterRefresh: dynamicFieldCount(finalPath),
    dynamicBibliographyPopulated: bibliographyText === undefined ? undefined : true,
    zoteroMode: receipt.mode,
    zoteroCollectionKey: receipt.collectionKey,
    zoteroItems: Array.isArray(receipt.items) ? receipt.items : [],
    refresh,
  };
  writeJson(join(sampleDirectory, 'acceptance-summary.json'), summary);
  results.push(summary);
  process.stdout.write(`${JSON.stringify({ event: 'sample_complete', ...summary })}\n`);
}

writeJson(bindingPath, bindings);
writeJson(join(outputRoot, 'acceptance-summary.json'), {
  schemaVersion: 1,
  plugin: 'sci.citation-workbench',
  provider: startingStatus.mode,
  modelGate: MODEL_ID,
  note: 'The acceptance model gate always returns insufficient unless a unit is reference-only or a standalone exact title. This verifies the conservative skip path without fabricating semantic approval.',
  samples: results,
});
process.stdout.write(`${JSON.stringify({ event: 'acceptance_complete', outputRoot, samples: results.length })}\n`);
