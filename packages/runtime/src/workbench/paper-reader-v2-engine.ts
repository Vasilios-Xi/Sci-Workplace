import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type {
  Annotation,
  AnnotationSelector,
  ArtifactRevisionRef,
  CreateArtifactRevisionFileInput,
  DocumentRevisionRef,
  EventActor,
  EvidenceAnchorV1,
  EvidenceAnchorV2,
  FineReadingReportV2,
  JobRecord,
  JsonValue,
  ModelUsage,
  PaperDocumentV2,
  PaperReaderBatchAuthorizationV2,
  PaperReaderDocumentProfileV2,
  PaperReaderFigureAnalysisV2,
  PaperReaderFormulaAnalysisV2,
  PaperReaderInstanceV1,
  PaperReaderInstanceV2,
  PaperReaderModuleV2,
  PaperReaderPipelineStageV2,
  PaperReaderQualityV2,
  PaperReaderReproductionV2,
  PaperReaderSectionDigestV2,
  PaperReaderStatementV2,
  PaperReaderUnitV2,
  WorktableInstance,
  WorkspacePathRef,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { PathGuard } from '../security/path-guard.js';
import { atomicWriteJson } from '../util/files.js';
import { isRecord, toJson } from '../util/json.js';
import type {
  PaperReaderModelAnalysis,
  PaperReaderModelAuthorization,
  PaperReaderQuantityDraft,
  PaperReaderStatementDraft,
  PaperReaderTranslationInput,
  PaperReaderTranslationResult,
  runPaperReaderDocumentProfile,
  runPaperReaderClaimEvidence,
  runPaperReaderFigureAnalysis,
  runPaperReaderFormulaAnalysis,
  runPaperReaderQuestion,
  runPaperReaderReproduction,
  runPaperReaderSectionDigest,
  runPaperReaderSynthesis,
  runPaperReaderTerminology,
} from './paper-reader-model-adapter.js';
import { sha256FileSync } from './file-hash.js';
import type { JobService } from './job-service.js';
import type { ScientificKernelStore } from './scientific-kernel-store.js';

const PLUGIN_ID = 'sci.paper-reader';
const PLUGIN_VERSION = '2.0.0';
const TOOLCHAIN_ID = 'openlab.reader-runtime';
export const PAPER_READER_PARSER_VERSION = '0.2.23';
const MAX_CONTEXT_BYTES = 16 * 1024 * 1024;
const TRANSLATION_CHUNK_BLOCKS = 8;
const TRANSLATION_CHUNK_CHARACTERS = 6_000;
const SECTION_UNIT_CHARACTERS = 14_000;
export const PAPER_READER_V2_DEFAULT_MODULES: PaperReaderModuleV2[] = [
  'terminology', 'bilingual-translation', 'section-digest', 'figure-analysis',
  'formula-analysis', 'claim-evidence', 'reproduction', 'synthesis',
];
const DEFAULT_MODULES = PAPER_READER_V2_DEFAULT_MODULES;

export interface ParsedBlock {
  id: string;
  stableId?: string;
  continuationKey?: string | null;
  page: number;
  type: string;
  order: number;
  originalText: string;
  bbox?: number[];
  confidence?: string;
  refs?: string[];
  _doclingLabel?: string;
  _doclingItemId?: string | null;
  _doclingItemOrder?: number | null;
}

export interface ParsedFigure {
  id: string;
  page: number;
  kind?: 'figure' | 'table' | 'formula';
  contentVisual?: boolean;
  captionId?: string | null;
  captionBlockIds?: string[];
  imagePath?: string;
  bbox?: number[];
  placedAfter?: string | null;
  altText?: string;
  originalCaption?: string;
  approximate?: boolean;
  pixelWidth?: number;
  pixelHeight?: number;
}

export interface ParsedReaderDocument {
  parser: string;
  parserVersion: string;
  paper: {
    title: string;
    sourcePath?: string;
    pageCount: number;
    language?: string;
    textCharacters?: number;
    hasTextLayer?: boolean;
    profileImagePath?: string;
    profilePage?: number;
  };
  blocks: ParsedBlock[];
  figures: ParsedFigure[];
  pages: Array<{ page: number; blockIds: string[]; width?: number; height?: number }>;
  warnings: string[];
  revisionHash: string;
}

export interface PaperTermV2 {
  id: string;
  source: string;
  translation: string;
  note: string;
  frozen: boolean;
}

export interface PaperQuestionV2 {
  id: string;
  question: string;
  answer: string;
  evidenceAnchorIds: string[];
  blockIds: string[];
  generationId: string;
  createdAt: string;
}

export interface PaperReaderLegacyConclusion {
  id: string;
  category: string;
  title: string;
  content: string;
  evidenceAnchorIds: string[];
  blockIds: string[];
  confidence: 'high' | 'medium' | 'low';
  generationVersion: number;
  generationId?: string;
}

export interface PaperReaderAnalysisV2 {
  schemaVersion: 2;
  documentProfiles: PaperReaderDocumentProfileV2[];
  terms: PaperTermV2[];
  translations: Record<string, string>;
  translationRuns: Record<string, { generationId: string; createdAt: string }>;
  translationBatchLimits: Record<string, number>;
  sectionDigests: PaperReaderSectionDigestV2[];
  figureAnalyses: PaperReaderFigureAnalysisV2[];
  formulaAnalyses: PaperReaderFormulaAnalysisV2[];
  claimEvidence?: Pick<FineReadingReportV2, 'evidenceChain' | 'mechanism' | 'keyResults' | 'contributions' | 'limitations' | 'unproven'>;
  reproduction?: PaperReaderReproductionV2;
  synthesis?: Pick<FineReadingReportV2, 'thesis' | 'researchQuestion' | 'strategy' | 'researchImplications' | 'presentationBrief' | 'directionOutput'>;
  report?: FineReadingReportV2;
  questions: PaperQuestionV2[];
  legacyConclusions: PaperReaderLegacyConclusion[];
}

interface PaperReaderEventPayload {
  reader?: PaperReaderInstanceV1 | PaperReaderInstanceV2;
  analysis?: unknown;
  analysisRef?: WorkspacePathRef;
  analysisSha256?: string;
}

type PaperReaderPatch = {
  [Key in keyof PaperReaderInstanceV2]?: PaperReaderInstanceV2[Key] | undefined;
} & { clearError?: boolean };

export interface PaperReaderDocumentContext {
  document: PaperDocumentV2;
  parsed: ParsedReaderDocument | null;
}

export interface PaperReaderCallPreview {
  ready: boolean;
  parseCalls: number;
  modelCalls: number;
  textModelCalls: number;
  visionModelCalls: number;
  model: string;
  textModel: string;
  visionModel?: string;
  modules: PaperReaderModuleV2[];
  profileUnits: number;
  fullTextBlocks: number;
  sectionUnits: number;
  visualUnits: number;
  formulaUnits: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  maximumTotalTokens: number;
  maximumModelCalls: number;
  note: string;
}

export interface PaperReaderPanelContext {
  reader: PaperReaderInstanceV2;
  document: DocumentRevisionRef | null;
  supportingDocument: DocumentRevisionRef | null;
  parsed: ParsedReaderDocument | null;
  supportingParsed: ParsedReaderDocument | null;
  documents: PaperReaderDocumentContext[];
  analysis: PaperReaderAnalysisV2;
  anchors: Array<EvidenceAnchorV1 | EvidenceAnchorV2>;
  annotations: Annotation[];
  jobs: JobRecord[];
  reveal: JsonValue;
  toolchainAvailable: boolean;
  callPreview: PaperReaderCallPreview;
  allowedTools: string[];
}

export interface PaperReaderArtifactInput {
  instanceId: string;
  title: string;
  markdown: string;
  json: string;
  parsedRef: WorkspacePathRef;
  files?: CreateArtifactRevisionFileInput[];
  quality?: PaperReaderQualityV2;
}

type TerminologyRunner = (input: Parameters<typeof runPaperReaderTerminology>[1], actor: EventActor, signal?: AbortSignal) => ReturnType<typeof runPaperReaderTerminology>;
type DocumentProfileRunner = (input: Parameters<typeof runPaperReaderDocumentProfile>[1], actor: EventActor, signal?: AbortSignal) => ReturnType<typeof runPaperReaderDocumentProfile>;
type SectionRunner = (input: Parameters<typeof runPaperReaderSectionDigest>[1], actor: EventActor, signal?: AbortSignal) => ReturnType<typeof runPaperReaderSectionDigest>;
type FigureRunner = (input: Parameters<typeof runPaperReaderFigureAnalysis>[1], actor: EventActor, signal?: AbortSignal) => ReturnType<typeof runPaperReaderFigureAnalysis>;
type FormulaRunner = (input: Parameters<typeof runPaperReaderFormulaAnalysis>[1], actor: EventActor, signal?: AbortSignal) => ReturnType<typeof runPaperReaderFormulaAnalysis>;
type ClaimRunner = (input: Parameters<typeof runPaperReaderClaimEvidence>[1], actor: EventActor, signal?: AbortSignal) => ReturnType<typeof runPaperReaderClaimEvidence>;
type ReproductionRunner = (input: Parameters<typeof runPaperReaderReproduction>[1], actor: EventActor, signal?: AbortSignal) => ReturnType<typeof runPaperReaderReproduction>;
type SynthesisRunner = (input: Parameters<typeof runPaperReaderSynthesis>[1], actor: EventActor, signal?: AbortSignal) => ReturnType<typeof runPaperReaderSynthesis>;
type QuestionRunner = (input: Parameters<typeof runPaperReaderQuestion>[1], actor: EventActor, signal?: AbortSignal) => ReturnType<typeof runPaperReaderQuestion>;

interface SectionUnit {
  key: string;
  document: PaperDocumentV2;
  heading: string;
  blocks: ParsedBlock[];
}

function emptyAnalysis(): PaperReaderAnalysisV2 {
  return {
    schemaVersion: 2, documentProfiles: [], terms: [], translations: {}, translationRuns: {}, translationBatchLimits: {},
    sectionDigests: [], figureAnalyses: [], formulaAnalyses: [], questions: [], legacyConclusions: [],
  };
}

function cloneAnalysis(value?: PaperReaderAnalysisV2): PaperReaderAnalysisV2 {
  if (!value) return emptyAnalysis();
  const cloned = structuredClone(value);
  return { ...emptyAnalysis(), ...cloned, documentProfiles: cloned.documentProfiles ?? [] };
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function zeroUsage(): ModelUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0 };
}

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cacheHitTokens: left.cacheHitTokens + right.cacheHitTokens,
    cacheMissTokens: left.cacheMissTokens + right.cacheMissTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

function blockText(block: ParsedBlock): string {
  return block.originalText.replace(/\s+/gu, ' ').trim();
}

function substantiveBlocks(parsed: ParsedReaderDocument): ParsedBlock[] {
  return parsed.blocks.filter((block) =>
    !['running_matter', 'reference', 'front_matter', 'figure_text', 'formula'].includes(block.type)
    && blockText(block).length > 0,
  );
}

function searchableBlocks(parsed: ParsedReaderDocument): ParsedBlock[] {
  return substantiveBlocks(parsed).filter((block) => blockText(block).length >= 16);
}

function blockKey(documentId: string, blockId: string): string {
  return `${documentId}:${blockId}`;
}

function rawBlockId(composite: string): string {
  const separator = composite.indexOf(':');
  return separator >= 0 ? composite.slice(separator + 1) : composite;
}

function paperReaderStateBase(instanceId: string): string {
  const safeInstanceId = instanceId.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 200);
  if (!safeInstanceId) throw new Error('论文精读实例 ID 无法映射到状态目录');
  return `.openlab/paper-reader-v2/instances/${safeInstanceId}`;
}

function compositeBlocks(document: PaperDocumentV2, blocks: ParsedBlock[]) {
  return blocks.map((block) => ({ id: blockKey(document.id, block.id), page: block.page, type: block.type, text: blockText(block) }));
}

function documentRevisionFromInput(value: unknown, label: string): { revision: DocumentRevisionRef; label: string } {
  if (!isRecord(value) || typeof value.rootId !== 'string' || typeof value.path !== 'string' || typeof value.sha256 !== 'string') {
    throw new Error(`${label}不是有效的不可变文档修订`);
  }
  if (!/^[a-f0-9]{64}$/u.test(value.sha256)) throw new Error(`${label}缺少有效 SHA-256`);
  const mediaType = typeof value.mediaType === 'string' ? value.mediaType : 'application/pdf';
  if (mediaType !== 'application/pdf' && !value.path.toLocaleLowerCase().endsWith('.pdf')) throw new Error(`${label}必须是 PDF`);
  return {
    revision: { ref: { rootId: value.rootId, path: value.path }, sha256: value.sha256, mediaType: 'application/pdf' },
    label: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 300) : label,
  };
}

function documentsFromInputs(inputs: Record<string, JsonValue>): { paperId: string; documents: PaperDocumentV2[]; documentSetHash: string } {
  const main = documentRevisionFromInput(inputs.mainPdf, '主论文');
  const paperId = `paper-${main.revision.sha256.slice(0, 24)}`;
  const documents: PaperDocumentV2[] = [{
    schemaVersion: 2, id: `main-${main.revision.sha256.slice(0, 16)}`, paperId, role: 'main', label: main.label,
    revision: main.revision, parseState: 'pending', warnings: [],
  }];
  const seen = new Set([`${main.revision.ref.rootId}:${main.revision.ref.path}:${main.revision.sha256}`]);
  for (const [index, value] of (Array.isArray(inputs.supplements) ? inputs.supplements : []).entries()) {
    const item = documentRevisionFromInput(value, `补充材料 ${index + 1}`);
    const key = `${item.revision.ref.rootId}:${item.revision.ref.path}:${item.revision.sha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    documents.push({
      schemaVersion: 2, id: `si-${item.revision.sha256.slice(0, 16)}-${documents.length}`, paperId, role: 'supplementary', label: item.label,
      revision: item.revision, parseState: 'pending', warnings: [],
    });
  }
  return { paperId, documents, documentSetHash: documentSetHash(documents) };
}

function documentSetHash(documents: PaperDocumentV2[]): string {
  return hashJson(documents.map((document) => ({ id: document.id, role: document.role, sha256: document.revision.sha256 })));
}

function selectorForBlock(parsed: ParsedReaderDocument, block: ParsedBlock): AnnotationSelector {
  const bbox = block.bbox;
  if (bbox?.length === 4 && bbox.every((value) => Number.isFinite(value))) {
    const page = parsed.pages.find((candidate) => candidate.page === block.page);
    const normalized = bbox.every((value) => value >= 0 && value <= 1)
      ? bbox
      : page?.width && page.height
        ? [bbox[0]! / page.width, bbox[1]! / page.height, bbox[2]! / page.width, bbox[3]! / page.height]
        : undefined;
    if (normalized) {
      const x = Math.max(0, Math.min(1, normalized[0]!));
      const y = Math.max(0, Math.min(1, normalized[1]!));
      const right = Math.max(x, Math.min(1, normalized[2]!));
      const bottom = Math.max(y, Math.min(1, normalized[3]!));
      if (right > x && bottom > y) return { kind: 'pdf-text', page: block.page, rects: [{ x, y, width: right - x, height: bottom - y }], exact: blockText(block) };
    }
  }
  return { kind: 'document-anchor', scheme: 'sci.paper-reader.block.v2', anchor: block.id, exact: blockText(block) };
}

function selectorForFigure(parsed: ParsedReaderDocument, figure: ParsedFigure): AnnotationSelector {
  const page = parsed.pages.find((candidate) => candidate.page === figure.page);
  const bbox = figure.bbox;
  if (bbox?.length === 4 && bbox.every((value) => Number.isFinite(value)) && page?.width && page.height) {
    const normalized = bbox.every((value) => value >= 0 && value <= 1)
      ? bbox : [bbox[0]! / page.width, bbox[1]! / page.height, bbox[2]! / page.width, bbox[3]! / page.height];
    const x = Math.max(0, Math.min(1, normalized[0]!));
    const y = Math.max(0, Math.min(1, normalized[1]!));
    const right = Math.max(x, Math.min(1, normalized[2]!));
    const bottom = Math.max(y, Math.min(1, normalized[3]!));
    if (right > x && bottom > y) return { kind: 'pdf-rect', page: figure.page, rects: [{ x, y, width: right - x, height: bottom - y }] };
  }
  return {
    kind: 'document-anchor',
    scheme: 'sci.paper-reader.visual.v2',
    anchor: figure.id,
    ...(figure.originalCaption ? { exact: figure.originalCaption } : {}),
  };
}

export function paperReaderVisualInputIssue(parsed: ParsedReaderDocument, figure: ParsedFigure): string | undefined {
  if (figure.contentVisual === false) return '解析器已将该区域标记为非内容视觉对象';
  const page = parsed.pages.find((candidate) => candidate.page === figure.page);
  const bbox = figure.bbox;
  if (!bbox || bbox.length !== 4 || !bbox.every((value) => Number.isFinite(value))) return '视觉区域缺少有效坐标';
  let [left, top, right, bottom] = bbox as [number, number, number, number];
  if (bbox.every((value) => value >= 0 && value <= 1)) {
    if (!page?.width || !page.height) return '归一化视觉区域缺少页面尺寸';
    [left, top, right, bottom] = [left * page.width, top * page.height, right * page.width, bottom * page.height];
  }
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const pixelWidth = figure.pixelWidth;
  const pixelHeight = figure.pixelHeight;
  if ((pixelWidth !== undefined && (!Number.isFinite(pixelWidth) || pixelWidth <= 0))
    || (pixelHeight !== undefined && (!Number.isFinite(pixelHeight) || pixelHeight <= 0))) return '视觉裁剪文件生成失败';
  if (figureKind(figure) === 'formula') {
    // Parser coordinates are serialized to three decimals. Decimal subtraction
    // can turn an exact 28 pt crop into 27.999999..., so compare with the same
    // small tolerance instead of rejecting a correctly rendered boundary crop.
    const coordinateTolerance = 0.02;
    if (width + coordinateTolerance < 96
      || height + coordinateTolerance < 28
      || (width + coordinateTolerance) * (height + coordinateTolerance) < 2_688) {
      return '公式裁剪区域过小或不完整';
    }
    if ((pixelWidth !== undefined && pixelWidth < 288) || (pixelHeight !== undefined && pixelHeight < 84)) return '公式裁剪分辨率不足';
    return undefined;
  }
  if (width < 96 || height < 42) return '图表区域过小，疑似坐标轴标签、图例色块或孤立文字';
  if (page?.width && page.height && width * height < page.width * page.height * 0.012) return '图表区域面积不足页面的 1.2%';
  if ((pixelWidth !== undefined && pixelWidth < 192) || (pixelHeight !== undefined && pixelHeight < 84)) return '图表裁剪分辨率不足';
  return undefined;
}

function termCandidates(blocks: ParsedBlock[]): string[] {
  const counts = new Map<string, number>();
  const pattern = /\b(?:[A-Z][A-Za-z0-9+−-]{2,}|[A-Za-z]+\d+[A-Za-z0-9+−-]*|[A-Z]{2,12})\b/gu;
  for (const block of blocks.slice(0, 1_500)) {
    for (const match of block.originalText.matchAll(pattern)) {
      const value = match[0]!.trim();
      if (/^(?:The|This|That|Figure|Table|Methods?|Results?|Introduction|Discussion)$/u.test(value)) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 120).map(([term]) => term);
}

function translationChunks(blocks: ParsedBlock[], limits: Record<string, number>, documentId: string): ParsedBlock[][] {
  const chunks: ParsedBlock[][] = [];
  let current: ParsedBlock[] = [];
  let characters = 0;
  let maximumBlocks = TRANSLATION_CHUNK_BLOCKS;
  for (const block of blocks) {
    const configured = limits[blockKey(documentId, block.id)];
    const limit = Number.isFinite(configured) ? Math.max(1, Math.min(TRANSLATION_CHUNK_BLOCKS, Math.trunc(configured!))) : TRANSLATION_CHUNK_BLOCKS;
    const length = blockText(block).length;
    if (current.length > 0 && (current.length >= Math.min(maximumBlocks, limit) || characters + length > TRANSLATION_CHUNK_CHARACTERS)) {
      chunks.push(current); current = []; characters = 0; maximumBlocks = TRANSLATION_CHUNK_BLOCKS;
    }
    current.push(block); characters += length; maximumBlocks = Math.min(maximumBlocks, limit);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function buildSectionUnits(document: PaperDocumentV2, parsed: ParsedReaderDocument): SectionUnit[] {
  const blocks = substantiveBlocks(parsed);
  const units: SectionUnit[] = [];
  let heading = parsed.paper.title || document.label;
  let groups: ParsedBlock[][] = [];
  let currentGroup: ParsedBlock[] = [];
  const flushGroup = () => { if (currentGroup.length > 0) groups.push(currentGroup); currentGroup = []; };
  const flushUnit = () => {
    flushGroup();
    if (groups.length === 0) return;
    let batch: ParsedBlock[] = [];
    let characters = 0;
    for (const group of groups) {
      const groupCharacters = group.reduce((total, block) => total + blockText(block).length, 0);
      if (batch.length > 0 && characters + groupCharacters > SECTION_UNIT_CHARACTERS) {
        const index = units.filter((unit) => unit.heading === heading && unit.document.id === document.id).length + 1;
        units.push({ key: `${document.id}:${heading}:${index}`, document, heading, blocks: batch });
        batch = []; characters = 0;
      }
      batch.push(...group); characters += groupCharacters;
    }
    if (batch.length > 0) {
      const index = units.filter((unit) => unit.heading === heading && unit.document.id === document.id).length + 1;
      units.push({ key: `${document.id}:${heading}:${index}`, document, heading, blocks: batch });
    }
    groups = [];
  };
  let continuation: string | undefined;
  for (const block of blocks) {
    if (block.type === 'heading') {
      flushUnit(); heading = blockText(block); groups = [[block]]; continuation = undefined; continue;
    }
    const key = block.continuationKey || undefined;
    if (currentGroup.length > 0 && continuation !== key) flushGroup();
    currentGroup.push(block); continuation = key;
    if (!key) flushGroup();
  }
  flushUnit();
  return units;
}

function figureKind(figure: ParsedFigure): 'figure' | 'table' | 'formula' {
  if (figure.kind) return figure.kind;
  if (/^(?:E|EQ)/iu.test(figure.id)) return 'formula';
  if (/^(?:T|TU)/iu.test(figure.id) || /^table/iu.test(figure.altText ?? '')) return 'table';
  return 'figure';
}

function supplementaryVisualReferenced(figure: ParsedFigure, main: ParsedReaderDocument): boolean {
  const escaped = figure.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const compact = figure.id.replace(/^[A-Za-z]+/u, '');
  const pattern = new RegExp(`(?:${escaped}|(?:fig(?:ure)?|table)\\s*(?:s|supp(?:lementary)?)?\\s*${compact})`, 'iu');
  return main.blocks.some((block) => pattern.test(block.originalText));
}

/**
 * Shared deterministic budget calculation used by the in-app confirmation and
 * the read-only Zotero corpus inventory. Keeping this calculation in the V2
 * engine prevents the unattended corpus runner from presenting a cheaper or
 * broader authorization than the application itself would create.
 */
export function estimatePaperReaderV2Usage(input: {
  documents: Array<{ document: PaperDocumentV2; parsed: ParsedReaderDocument }>;
  textModel: string;
  visionModel?: string;
  modules?: PaperReaderModuleV2[];
  expectedDocumentCount?: number;
  unsupportedScanned?: boolean;
}): PaperReaderCallPreview {
  const modules = input.modules ?? DEFAULT_MODULES;
  const blocks = input.documents.flatMap((context) => substantiveBlocks(context.parsed));
  const translationCalls = input.documents.reduce((total, context) =>
    total + translationChunks(substantiveBlocks(context.parsed), {}, context.document.id).length, 0);
  const sectionUnits = input.documents.reduce((total, context) =>
    total + buildSectionUnits(context.document, context.parsed).length, 0);
  const mainParsed = input.documents.find((context) => context.document.role === 'main')?.parsed;
  const profileUnits = input.visionModel && mainParsed?.paper.profileImagePath ? 1 : 0;
  const visualUnits = input.documents.reduce((total, context) => total + context.parsed.figures.filter((figure) => {
    if (figureKind(figure) === 'formula' || figure.contentVisual === false) return false;
    return context.document.role === 'main' || Boolean(mainParsed && supplementaryVisualReferenced(figure, mainParsed));
  }).length, 0);
  const formulaUnits = input.documents.reduce((total, context) =>
    total + context.parsed.blocks.filter((block) => block.type === 'formula').length, 0);
  const textModelCalls = (modules.includes('terminology') ? 1 : 0)
    + (modules.includes('bilingual-translation') ? translationCalls : 0)
    + (modules.includes('section-digest') ? sectionUnits : 0)
    + (modules.includes('claim-evidence') ? 1 : 0)
    + (modules.includes('reproduction') ? 1 : 0)
    + (modules.includes('synthesis') ? 1 : 0);
  const visionModelCalls = input.visionModel
    ? profileUnits
      + (modules.includes('figure-analysis') ? visualUnits : 0)
      + (modules.includes('formula-analysis') ? formulaUnits : 0)
    : 0;
  const modelCalls = textModelCalls + visionModelCalls;
  const characters = blocks.reduce((total, block) => total + blockText(block).length, 0);
  const overhead = input.textModel.startsWith('chatgpt-oauth::') ? 15_000 : 900;
  const imageUnits = profileUnits + visualUnits + formulaUnits;
  const estimatedInputTokens = modelCalls > 0 ? Math.ceil(characters / 4) * 2 + modelCalls * overhead + imageUnits * 2_000 : 0;
  const estimatedOutputTokens = modelCalls > 0 ? Math.ceil(characters * 0.9) + sectionUnits * 1_600 + visualUnits * 2_400 + formulaUnits * 800 + 12_000 : 0;
  const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;
  const maximumModelCalls = modelCalls > 0 ? Math.max(modelCalls * 3, modelCalls + 16) : 0;
  const maximumTotalTokens = estimatedTotalTokens > 0 ? Math.ceil(estimatedTotalTokens * 1.8) + 8_192 : 0;
  const ready = input.documents.length === (input.expectedDocumentCount ?? input.documents.length)
    && blocks.length > 0 && input.unsupportedScanned !== true;
  return {
    ready, parseCalls: input.documents.length * 2, modelCalls, textModelCalls, visionModelCalls,
    model: input.textModel, textModel: input.textModel, ...(input.visionModel ? { visionModel: input.visionModel } : {}),
    modules: [...modules], profileUnits, fullTextBlocks: blocks.length, sectionUnits, visualUnits, formulaUnits,
    estimatedInputTokens, estimatedOutputTokens, estimatedTotalTokens, maximumTotalTokens, maximumModelCalls,
    note: ready
      ? `离线解析不消耗 token；确认一次后自动执行 ${modelCalls} 次预计模型调用（文本 ${textModelCalls}，视觉 ${visionModelCalls}），自动纠错、拆批和断点恢复均受同一硬上限约束。${input.visionModel ? '' : ' 当前无视觉模型，首页、图表和公式将明确标记为不完整。'}`
      : '先完成全部主文与 SI 的离线预检；预检不调用模型。',
  };
}

function relevantFigureBlocks(parsed: ParsedReaderDocument, figure: ParsedFigure): ParsedBlock[] {
  const explicit = new Set([...(figure.captionBlockIds ?? []), ...(figure.captionId ? [figure.captionId] : []), ...(figure.placedAfter ? [figure.placedAfter] : [])]);
  const direct = parsed.blocks.filter((block) => explicit.has(block.id) || block.refs?.includes(figure.id));
  const center = direct[0]?.order ?? parsed.blocks.find((block) => block.page === figure.page)?.order ?? 0;
  const nearby = parsed.blocks.filter((block) => Math.abs(block.order - center) <= 2 && substantiveBlocks({ ...parsed, blocks: [block] }).length > 0);
  return [...new Map([...direct, ...nearby].map((block) => [block.id, block])).values()].slice(0, 12);
}

function relevantFormulaBlocks(parsed: ParsedReaderDocument, formula: ParsedBlock): ParsedBlock[] {
  return parsed.blocks.filter((block) => Math.abs(block.order - formula.order) <= 2 && substantiveBlocks({ ...parsed, blocks: [block] }).length > 0).slice(0, 12);
}

function transientModelFailure(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /(?:timeout|timed out|超时|rate[ _-]?limit|network|网络|ECONN|EPIPE|socket|temporar|resource)/iu.test(message);
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeLegacyAnalysis(value: unknown): PaperReaderAnalysisV2 {
  const analysis = emptyAnalysis();
  if (!isRecord(value)) return analysis;
  if (Array.isArray(value.terms)) analysis.terms = value.terms.filter(isRecord).map((term) => ({
    id: typeof term.id === 'string' ? term.id : randomUUID(), source: typeof term.source === 'string' ? term.source : '',
    translation: typeof term.translation === 'string' ? term.translation : '', note: '由 V1 术语表迁移', frozen: term.frozen === true,
  })).filter((term) => term.source);
  if (isRecord(value.translations)) for (const [key, translation] of Object.entries(value.translations)) if (typeof translation === 'string') analysis.translations[key] = translation;
  if (isRecord(value.translationRuns)) analysis.translationRuns = structuredClone(value.translationRuns) as PaperReaderAnalysisV2['translationRuns'];
  if (isRecord(value.translationBatchLimits)) analysis.translationBatchLimits = structuredClone(value.translationBatchLimits) as Record<string, number>;
  if (Array.isArray(value.conclusions)) analysis.legacyConclusions = value.conclusions.filter(isRecord).map((item) => ({
    id: typeof item.id === 'string' ? item.id : randomUUID(), category: typeof item.category === 'string' ? item.category : 'legacy',
    title: typeof item.title === 'string' ? item.title : '旧版结论', content: typeof item.content === 'string' ? item.content : '',
    evidenceAnchorIds: Array.isArray(item.evidenceAnchorIds) ? item.evidenceAnchorIds.filter((id): id is string => typeof id === 'string') : [],
    blockIds: Array.isArray(item.blockIds) ? item.blockIds.filter((id): id is string => typeof id === 'string') : [],
    confidence: ['high', 'medium', 'low'].includes(String(item.confidence)) ? item.confidence as 'high' | 'medium' | 'low' : 'low',
    generationVersion: Number(item.generationVersion) || 0,
    ...(typeof item.generationId === 'string' ? { generationId: item.generationId } : {}),
  }));
  if (Array.isArray(value.questions)) analysis.questions = value.questions.filter(isRecord).map((item) => ({
    id: typeof item.id === 'string' ? item.id : randomUUID(), question: typeof item.question === 'string' ? item.question : '', answer: typeof item.answer === 'string' ? item.answer : '',
    evidenceAnchorIds: Array.isArray(item.evidenceAnchorIds) ? item.evidenceAnchorIds.filter((id): id is string => typeof id === 'string') : [],
    blockIds: Array.isArray(item.blockIds) ? item.blockIds.filter((id): id is string => typeof id === 'string') : [], generationId: 'legacy-v1',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
  }));
  return analysis;
}

export class PaperReaderService {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #jobs: JobService;
  readonly #kernel: ScientificKernelStore;
  readonly #resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
  readonly #toolchainAvailable: () => boolean;
  readonly #createReportArtifact: (input: PaperReaderArtifactInput, actor: EventActor) => ArtifactRevisionRef;
  readonly #mountReport: (instanceId: string, artifact: ArtifactRevisionRef, title: string, actor: EventActor) => void;
  readonly #listAnnotations: () => Annotation[];
  readonly #createAnnotation: (input: { target: DocumentRevisionRef; selector: AnnotationSelector; comment: string }, actor: EventActor) => Annotation;
  readonly #textModel: () => string;
  readonly #visionModel: () => string | undefined;
  readonly #translate: (input: PaperReaderTranslationInput, actor: EventActor, signal?: AbortSignal) => Promise<PaperReaderTranslationResult>;
  readonly #legacyAnalyze: ((input: unknown, actor: EventActor, signal?: AbortSignal) => Promise<PaperReaderModelAnalysis>) | undefined;
  readonly #documentProfile: DocumentProfileRunner | undefined;
  readonly #terminology: TerminologyRunner | undefined;
  readonly #sectionDigest: SectionRunner | undefined;
  readonly #figureAnalysis: FigureRunner | undefined;
  readonly #formulaAnalysis: FormulaRunner | undefined;
  readonly #claimEvidence: ClaimRunner | undefined;
  readonly #reproduction: ReproductionRunner | undefined;
  readonly #synthesis: SynthesisRunner | undefined;
  readonly #question: QuestionRunner | undefined;
  readonly #onChanged: () => void;
  readonly #readers = new Map<string, PaperReaderInstanceV2>();
  readonly #analysis = new Map<string, PaperReaderAnalysisV2>();
  readonly #pipelines = new Map<string, Promise<void>>();
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: {
    projectId: string;
    events: SqliteEventStore;
    jobs: JobService;
    kernel: ScientificKernelStore;
    resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
    toolchainAvailable: () => boolean;
    createReportArtifact: (input: PaperReaderArtifactInput, actor: EventActor) => ArtifactRevisionRef;
    mountReport: (instanceId: string, artifact: ArtifactRevisionRef, title: string, actor: EventActor) => void;
    listAnnotations?: () => Annotation[];
    createAnnotation?: (input: { target: DocumentRevisionRef; selector: AnnotationSelector; comment: string }, actor: EventActor) => Annotation;
    model?: () => string;
    textModel?: () => string;
    visionModel?: () => string | undefined;
    translate: (input: PaperReaderTranslationInput, actor: EventActor, signal?: AbortSignal) => Promise<PaperReaderTranslationResult>;
    analyze?: (input: unknown, actor: EventActor, signal?: AbortSignal) => Promise<PaperReaderModelAnalysis>;
    documentProfile?: DocumentProfileRunner;
    terminology?: TerminologyRunner;
    sectionDigest?: SectionRunner;
    figureAnalysis?: FigureRunner;
    formulaAnalysis?: FormulaRunner;
    claimEvidence?: ClaimRunner;
    reproduction?: ReproductionRunner;
    synthesis?: SynthesisRunner;
    question?: QuestionRunner;
    onChanged?: () => void;
  }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.#jobs = options.jobs;
    this.#kernel = options.kernel;
    this.#resolveRoot = options.resolveRoot;
    this.#toolchainAvailable = options.toolchainAvailable;
    this.#createReportArtifact = options.createReportArtifact;
    this.#mountReport = options.mountReport;
    this.#listAnnotations = options.listAnnotations ?? (() => []);
    this.#createAnnotation = options.createAnnotation ?? (() => { throw new Error('论文精读批注服务不可用'); });
    this.#textModel = options.textModel ?? options.model ?? (() => '');
    this.#visionModel = options.visionModel ?? (() => undefined);
    this.#translate = options.translate;
    this.#legacyAnalyze = options.analyze;
    this.#documentProfile = options.documentProfile;
    this.#terminology = options.terminology;
    this.#sectionDigest = options.sectionDigest;
    this.#figureAnalysis = options.figureAnalysis;
    this.#formulaAnalysis = options.formulaAnalysis;
    this.#claimEvidence = options.claimEvidence;
    this.#reproduction = options.reproduction;
    this.#synthesis = options.synthesis;
    this.#question = options.question;
    this.#onChanged = options.onChanged ?? (() => undefined);
    this.replay();
    this.markInterruptedRuns();
  }

  list(): PaperReaderInstanceV2[] {
    return [...this.#readers.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((reader) => structuredClone(reader));
  }

  get(instanceId: string): PaperReaderInstanceV2 {
    return structuredClone(this.requireReader(instanceId));
  }

  configure(instance: WorktableInstance, actor: EventActor): PaperReaderInstanceV2 {
    if (instance.templateId !== 'sci.paper-reader:deep-read') throw new Error('当前 Workbench 不是论文精读实例');
    const existing = this.#readers.get(instance.id);
    if (existing) return structuredClone(existing);
    const seed = documentsFromInputs(instance.inputs);
    for (const document of seed.documents) this.verifyRevision(document.revision);
    const main = seed.documents[0]!;
    const firstSupplement = seed.documents.find((document) => document.role === 'supplementary');
    const now = new Date().toISOString();
    const reader: PaperReaderInstanceV2 = {
      schemaVersion: 2, instanceId: instance.id, projectId: this.#projectId, paperId: seed.paperId,
      documents: seed.documents, documentSetHash: seed.documentSetHash, status: 'ready',
      stage: this.#toolchainAvailable() ? '等待离线预检' : 'Reader Runtime 未安装', progress: 0,
      pipeline: { stage: 'document-profile', totalUnits: seed.documents.length, completedUnits: 0, failedUnits: 0, units: [] },
      modelGenerationIds: [], evidenceAnchorIds: [], generationVersion: 0, autoFollow: true,
      mainDocument: main.revision, ...(firstSupplement ? { supportingDocument: firstSupplement.revision } : {}),
      blockCount: 0, figureCount: 0, conclusionCount: 0, termCount: 0, translationBlockCount: 0, translatedBlockCount: 0,
      createdAt: now, updatedAt: now,
    };
    this.#readers.set(instance.id, reader);
    this.#analysis.set(instance.id, emptyAnalysis());
    this.record('paper-reader.v2_configured', reader, actor, emptyAnalysis());
    return structuredClone(reader);
  }

  prepare(instanceId: string, actor: EventActor): PaperReaderInstanceV2 {
    const current = this.requireReader(instanceId);
    if (this.#pipelines.has(instanceId)) return structuredClone(current);
    if (!this.#toolchainAvailable()) throw new Error('Reader Runtime 未安装。请安装内置离线 Reader Runtime 后重试。');
    const parserUpgrade = current.documents.some((document) => document.parsedDocument && !this.parsedDocumentIsCurrent(document));
    const documents = current.documents.map((document, index) => {
      this.verifyRevision(document.revision);
      if (document.parseState === 'ready' && this.parsedDocumentIsCurrent(document)) return document;
      const folder = `${document.role === 'main' ? 'main' : `si-${index}`}`;
      const inspection = this.#jobs.run({
        title: `检查${document.label} PDF 文本层`, executable: 'reader-worker',
        args: ['inspect', '--input', `input/${folder}.pdf`, '--output', 'inspection.json'],
        inputs: [{ ref: document.revision.ref, destination: `input/${folder}.pdf`, role: 'source' }],
        outputs: [{ path: 'inspection.json', role: 'mapping', mediaType: 'application/json', required: true }],
        toolchainId: TOOLCHAIN_ID, timeoutMs: 5 * 60_000, network: false, origin: 'plugin', pluginId: PLUGIN_ID,
        traceId: `paper-reader-v2-preflight:${instanceId}:${document.id}`, worktableInstanceId: instanceId,
      }, actor);
      return { ...document, inspectionJobId: inspection.id, parseState: 'inspecting' as const };
    });
    const reader = this.update(instanceId, {
      documents, status: 'inspecting', stage: '离线检查全部 PDF 文本层', progress: 0.01,
      pipeline: { stage: 'document-profile', totalUnits: documents.length, completedUnits: documents.filter((document) => document.parseState === 'ready' && this.parsedDocumentIsCurrent(document)).length, failedUnits: 0, units: [] },
      ...(parserUpgrade ? {
        batchAuthorization: undefined, quality: undefined, reportArtifact: undefined,
        modelGenerationIds: [], evidenceAnchorIds: [], generationVersion: current.generationVersion + 1,
        conclusionCount: 0, termCount: 0, translatedBlockCount: 0,
      } : {}),
      clearError: true,
    }, actor, parserUpgrade ? emptyAnalysis() : undefined);
    const pipeline = this.executePreflight(instanceId, actor)
      .catch((error) => this.failPipeline(instanceId, error, actor))
      .finally(() => this.#pipelines.delete(instanceId));
    this.#pipelines.set(instanceId, pipeline);
    return reader;
  }

  private async executePreflight(instanceId: string, actor: EventActor): Promise<void> {
    let reader = this.requireReader(instanceId);
    const inspected: PaperDocumentV2[] = [];
    for (const [index, document] of reader.documents.entries()) {
      if (document.parseState === 'ready' && this.parsedDocumentIsCurrent(document)) { inspected.push(document); continue; }
      if (!document.inspectionJobId) throw new Error(`缺少 ${document.label} 的检查任务`);
      const job = await this.#jobs.wait(document.inspectionJobId);
      if (job.status !== 'completed') throw new Error(job.error ?? `${document.label} PDF 检查${job.status}`);
      const value = this.readJobJson(job, 'inspection.json');
      if (value.has_text_layer !== true) {
        const documents = this.requireReader(instanceId).documents.map((candidate) => candidate.id === document.id ? { ...candidate, parseState: 'unsupported_scanned' as const } : candidate);
        this.update(instanceId, { documents }, actor);
        throw new Error(`UNSUPPORTED_SCANNED_PDF: ${document.label} 没有足够的可选中文本层`);
      }
      const textCharacters = Number(value.text_characters);
      const pageCount = Number(value.page_count);
      if (!Number.isFinite(textCharacters) || textCharacters <= 0) throw new Error(`UNSUPPORTED_SCANNED_PDF: ${document.label} 文本层为空`);
      const parse = this.runParse(instanceId, document, index, actor);
      inspected.push({
        ...document, textCharacters: Math.trunc(textCharacters), ...(Number.isFinite(pageCount) && pageCount > 0 ? { pageCount: Math.trunc(pageCount) } : {}),
        parseJobId: parse.id, parseState: 'parsing',
      });
      this.update(instanceId, { documents: [...inspected, ...reader.documents.slice(index + 1)], stage: `离线解析 ${document.label}`, progress: 0.02 + 0.04 * (index / Math.max(1, reader.documents.length)) }, actor);
    }
    reader = this.requireReader(instanceId);
    const parsedDocuments: PaperDocumentV2[] = [];
    for (const [index, document] of reader.documents.entries()) {
      if (document.parseState === 'ready' && this.parsedDocumentIsCurrent(document)) { parsedDocuments.push(document); continue; }
      if (!document.parseJobId) throw new Error(`缺少 ${document.label} 的解析任务`);
      const job = await this.#jobs.wait(document.parseJobId);
      if (job.status !== 'completed') throw new Error(job.error ?? `${document.label} PDF 解析${job.status}`);
      const output = job.outputs.find((candidate) => candidate.path === 'parsed/reader_document.json');
      if (!output) throw new Error(`Reader Runtime 没有返回 ${document.label} 的 reader_document.json`);
      const parsed = this.readParsed(output.ref);
      if (!parsed || parsed.revisionHash !== document.revision.sha256) throw new Error(`${document.label} 解析修订不匹配`);
      parsedDocuments.push({
        ...document, parsedDocument: output.ref, parseState: 'ready', warnings: [...parsed.warnings],
        pageCount: parsed.paper.pageCount,
        ...(parsed.paper.textCharacters === undefined ? {} : { textCharacters: parsed.paper.textCharacters }),
        blockCount: substantiveBlocks(parsed).length,
        figureCount: parsed.figures.filter((figure) => figureKind(figure) !== 'formula').length,
        formulaCount: parsed.blocks.filter((block) => block.type === 'formula').length,
      });
      this.update(instanceId, { documents: [...parsedDocuments, ...reader.documents.slice(index + 1)], stage: `已解析 ${document.label}`, progress: 0.04 + 0.04 * ((index + 1) / reader.documents.length) }, actor);
      reader = this.requireReader(instanceId);
    }
    const main = parsedDocuments.find((document) => document.role === 'main')!;
    const firstSupplement = parsedDocuments.find((document) => document.role === 'supplementary');
    const blockCount = parsedDocuments.reduce((total, document) => total + (document.blockCount ?? 0), 0);
    const figureCount = parsedDocuments.reduce((total, document) => total + (document.figureCount ?? 0), 0);
    const textCharacters = parsedDocuments.reduce((total, document) => total + (document.textCharacters ?? 0), 0);
    this.update(instanceId, {
      documents: parsedDocuments, documentSetHash: documentSetHash(parsedDocuments), status: 'ready',
      stage: '离线解析完成；确认一次即可自动完成全文翻译与精读', progress: 0.08,
      pipeline: { stage: 'document-profile', totalUnits: parsedDocuments.length, completedUnits: parsedDocuments.length, failedUnits: 0, units: [] },
      mainDocument: main.revision,
      ...(main.parsedDocument ? { parsedDocument: main.parsedDocument } : {}),
      ...(firstSupplement ? {
        supportingDocument: firstSupplement.revision,
        ...(firstSupplement.parsedDocument ? { supportingParsedDocument: firstSupplement.parsedDocument } : {}),
      } : {}),
      blockCount, figureCount, translationBlockCount: blockCount, inspectedTextCharacters: textCharacters,
      ...(main.pageCount === undefined ? {} : { inspectedPageCount: main.pageCount }),
      clearError: true,
    }, actor, this.analysisFor(instanceId));
  }

  private runParse(instanceId: string, document: PaperDocumentV2, index: number, actor: EventActor): JobRecord {
    this.verifyRevision(document.revision);
    const folder = document.role === 'main' ? 'main' : `si-${index}`;
    return this.#jobs.run({
      title: `解析${document.label} PDF`, executable: 'reader-worker',
      args: ['parse', '--input', `input/${folder}.pdf`, '--revision', document.revision.sha256, '--output-dir', 'parsed'],
      inputs: [{ ref: document.revision.ref, destination: `input/${folder}.pdf`, role: 'source' }],
      outputs: [{ glob: 'parsed/**', base: 'parsed', role: 'mapping', required: true }],
      toolchainId: TOOLCHAIN_ID, timeoutMs: 30 * 60_000, network: false, origin: 'plugin', pluginId: PLUGIN_ID,
      traceId: `paper-reader-v2-parse:${instanceId}:${document.id}`, worktableInstanceId: instanceId,
    }, actor);
  }

  callPreview(instanceId: string, modules: PaperReaderModuleV2[] = DEFAULT_MODULES): PaperReaderCallPreview {
    const reader = this.requireReader(instanceId);
    const contexts = this.documentContexts(reader);
    const parsedContexts = contexts.filter((context): context is { document: PaperDocumentV2; parsed: ParsedReaderDocument } =>
      context.parsed !== null && context.parsed.parserVersion === PAPER_READER_PARSER_VERSION,
    );
    const visionModel = this.#visionModel();
    return estimatePaperReaderV2Usage({
      documents: parsedContexts,
      textModel: this.#textModel(),
      ...(visionModel ? { visionModel } : {}),
      modules,
      expectedDocumentCount: reader.documents.length,
      unsupportedScanned: reader.status === 'unsupported_scanned',
    });
  }

  start(instanceId: string, actor: EventActor, confirmed = false, requestedModules: PaperReaderModuleV2[] = DEFAULT_MODULES): PaperReaderInstanceV2 {
    const current = this.requireReader(instanceId);
    if (this.#pipelines.has(instanceId)) return structuredClone(current);
    if (!this.#toolchainAvailable()) throw new Error('Reader Runtime 未安装。请安装内置离线 Reader Runtime 后重试。');
    if (current.documents.some((document) => document.parseState !== 'ready' || !document.parsedDocument)) throw new Error('请先完成全部 PDF 的离线预检');
    for (const document of current.documents) this.verifyRevision(document.revision);
    const modules = this.normalizeModules(requestedModules);
    const preview = this.callPreview(instanceId, modules);
    if (!preview.ready) throw new Error('全文精读调用量预览尚未就绪');
    const reusable = this.activeAuthorization(current, modules);
    if (!reusable && !confirmed) throw new Error('全文翻译与精读需要用户在总调用量预览后一次性明确确认');
    if (!reusable && (!preview.textModel || preview.textModel === 'openlab-demo')) throw new Error('尚未配置可用的真实精读文本模型');
    const now = new Date().toISOString();
    const authorization: PaperReaderBatchAuthorizationV2 = reusable ?? {
      schemaVersion: 2, id: randomUUID(), instanceId, documentSetHash: current.documentSetHash,
      textModel: preview.textModel, ...(preview.visionModel ? { visionModel: preview.visionModel } : {}), modules,
      estimated: { inputTokens: preview.estimatedInputTokens, outputTokens: preview.estimatedOutputTokens, totalTokens: preview.estimatedTotalTokens, modelCalls: preview.modelCalls },
      maximum: {
        inputTokens: Math.ceil(preview.estimatedInputTokens * 1.8) + 4_096,
        outputTokens: Math.ceil(preview.estimatedOutputTokens * 1.8) + 4_096,
        totalTokens: preview.maximumTotalTokens,
        modelCalls: preview.maximumModelCalls,
      },
      consumed: { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0 },
      status: 'active', actorId: actor.id, authorizedAt: now, updatedAt: now,
    };
    if (!reusable) this.recordAuthorization('paper-reader.v2_batch_authorized', current, authorization, actor);
    const run = this.#kernel.startRun({
      instanceId, kind: 'workflow', status: 'queued', progress: Math.max(0.08, current.progress), stage: '启动论文精读 V2',
      inputRefs: current.documents.map((document) => document.revision.sha256), outputRefs: [],
    }, actor);
    const controller = new AbortController();
    this.#controllers.set(instanceId, controller);
    const reader = this.update(instanceId, {
      status: 'analyzing', stage: '启动论文精读 V2', progress: Math.max(0.08, Math.min(current.progress, 0.94)), runId: run.id,
      batchAuthorization: authorization, clearError: true,
    }, actor);
    const pipeline = this.executePipeline(instanceId, actor, controller.signal)
      .catch((error) => this.failPipeline(instanceId, error, actor))
      .finally(() => { this.#pipelines.delete(instanceId); this.#controllers.delete(instanceId); });
    this.#pipelines.set(instanceId, pipeline);
    return reader;
  }

  resume(instanceId: string, actor: EventActor, confirmed = false): PaperReaderInstanceV2 {
    const current = this.requireReader(instanceId);
    if (current.status === 'unsupported_scanned') throw new Error('扫描型 PDF 暂不支持；请先在外部完成 OCR，再作为新修订导入');
    if (!['interrupted', 'failed', 'ready', 'stale', 'completed'].includes(current.status)) throw new Error('当前精读任务不需要恢复');
    return this.start(instanceId, actor, confirmed, current.batchAuthorization?.modules ?? DEFAULT_MODULES);
  }

  async wait(instanceId: string): Promise<PaperReaderInstanceV2> {
    await this.#pipelines.get(instanceId);
    return this.get(instanceId);
  }

  cancel(instanceId: string, actor: EventActor): PaperReaderInstanceV2 {
    const current = this.requireReader(instanceId);
    this.#controllers.get(instanceId)?.abort(new DOMException('用户取消全文精读', 'AbortError'));
    for (const document of current.documents) for (const id of [document.inspectionJobId, document.parseJobId]) if (id) this.#jobs.cancel(id, actor);
    if (current.runId) this.#kernel.updateRun(current.runId, { status: 'cancelled', stage: '用户取消' }, actor);
    return this.update(instanceId, { status: 'interrupted', stage: '已取消，可从检查点继续', error: 'cancelled_by_user' }, actor);
  }

  private normalizeModules(modules: PaperReaderModuleV2[]): PaperReaderModuleV2[] {
    const requested = new Set(modules.filter((module): module is PaperReaderModuleV2 => DEFAULT_MODULES.includes(module)));
    if (requested.size === 0) DEFAULT_MODULES.forEach((module) => requested.add(module));
    if ([...requested].some((module) => ['section-digest', 'figure-analysis', 'formula-analysis'].includes(module))) {
      requested.add('claim-evidence'); requested.add('synthesis');
    }
    if (requested.has('reproduction')) requested.add('synthesis');
    if (requested.has('claim-evidence')) requested.add('synthesis');
    return DEFAULT_MODULES.filter((module) => requested.has(module));
  }

  private async executePipeline(instanceId: string, actor: EventActor, signal: AbortSignal): Promise<void> {
    const authorization = this.requireAuthorization(this.requireReader(instanceId));
    const modules = new Set(authorization.modules);
    await this.runDocumentProfileStage(instanceId, actor, signal);
    if (modules.has('terminology')) await this.runTerminologyStage(instanceId, actor, signal);
    if (modules.has('bilingual-translation')) await this.runTranslationStage(instanceId, actor, signal);
    if (modules.has('section-digest')) await this.runSectionStage(instanceId, actor, signal);
    if (modules.has('figure-analysis')) await this.runFigureStage(instanceId, actor, signal);
    if (modules.has('formula-analysis')) await this.runFormulaStage(instanceId, actor, signal);
    if (modules.has('claim-evidence')) await this.runClaimStage(instanceId, actor, signal);
    if (modules.has('reproduction')) await this.runReproductionStage(instanceId, actor, signal);
    if (modules.has('synthesis')) await this.runSynthesisStage(instanceId, actor, signal);
    if (signal.aborted) throw signal.reason;
    await this.publishFinalReport(instanceId, actor);
  }

  private async runDocumentProfileStage(instanceId: string, actor: EventActor, signal: AbortSignal): Promise<void> {
    this.setStage(instanceId, 'document-profile', '整页识别论文首页信息', 0.09, actor);
    const reader = this.requireReader(instanceId);
    const context = this.documentContexts(reader).find((item): item is { document: PaperDocumentV2; parsed: ParsedReaderDocument } =>
      item.document.role === 'main' && item.parsed !== null,
    );
    if (!context) throw new Error('主论文离线解析结果不存在');
    const image = this.profileAssetRef(context.document, context.parsed);
    const inputHash = hashJson({
      revision: context.document.revision.sha256,
      parserVersion: context.parsed.parserVersion,
      imageHash: image?.sha256 ?? null,
      visionModel: this.#visionModel() ?? null,
    });
    const unit = this.makeUnit(instanceId, 'document-profile', context.document.id, inputHash, [], context.document.id);
    const current = this.analysisFor(instanceId);
    if (this.validCompletedUnit(reader, unit) && current.documentProfiles.some((item) => item.documentId === context.document.id)) return;
    this.startUnit(instanceId, unit, actor);
    let profile: PaperReaderDocumentProfileV2;
    let generationIds: string[] = [];
    let usage = zeroUsage();
    const vision = this.#visionModel();
    if (!vision || !image || !this.#documentProfile) {
      profile = {
        id: unit.id, documentId: context.document.id, title: context.parsed.paper.title || context.document.label,
        authors: [], affiliations: [], confidence: 'low', status: 'needs_review', warnings: [
          !vision ? '未配置视觉模型，标题暂用离线解析候选' : !image ? '论文首页整页图像缺失' : '首页视觉适配器不可用',
        ],
      };
    } else {
      try {
        const result = await this.#documentProfile({
          document: context.document.revision, image,
          authorization: this.modelAuthorization(this.requireAuthorization(this.requireReader(instanceId)), 'vision'), inputHash,
        }, actor, signal);
        this.consumeAuthorization(instanceId, result.usage, result.generationId, actor, result.modelCallCount);
        generationIds = [result.generationId]; usage = result.usage;
        profile = {
          id: unit.id, documentId: context.document.id, ...result.value,
          sourceImageSha256: image.sha256, generationId: result.generationId,
        };
      } catch (error) {
        this.consumeFailedModelCall(instanceId, error, actor);
        profile = {
          id: unit.id, documentId: context.document.id, title: context.parsed.paper.title || context.document.label,
          authors: [], affiliations: [], confidence: 'low', status: 'failed',
          sourceImageSha256: image.sha256,
          warnings: [(error instanceof Error ? error.message : String(error)).slice(0, 1_000)],
        };
      }
    }
    const latest = this.analysisFor(instanceId);
    latest.documentProfiles = [...latest.documentProfiles.filter((item) => item.documentId !== context.document.id), profile];
    this.completeUnit(instanceId, unit, profile, generationIds, usage, actor, latest);
  }

  private async runTerminologyStage(instanceId: string, actor: EventActor, signal: AbortSignal): Promise<void> {
    this.setStage(instanceId, 'terminology', '建立全文术语账本', 0.1, actor);
    const reader = this.requireReader(instanceId);
    const contexts = this.documentContexts(reader).filter((context): context is { document: PaperDocumentV2; parsed: ParsedReaderDocument } => context.parsed !== null);
    const allBlocks = contexts.flatMap((context) => substantiveBlocks(context.parsed));
    const candidates = termCandidates(allBlocks);
    const analysis = this.analysisFor(instanceId);
    const frozen = analysis.terms.filter((term) => term.frozen && term.translation);
    const selected: Array<{ context: typeof contexts[number]; block: ParsedBlock }> = [];
    let characters = 0;
    for (const context of contexts) {
      for (const block of substantiveBlocks(context.parsed)) {
        if (!candidates.some((term) => block.originalText.includes(term))) continue;
        if (characters + blockText(block).length > 28_000) break;
        selected.push({ context, block }); characters += blockText(block).length;
      }
    }
    if (selected.length === 0) for (const context of contexts) for (const block of substantiveBlocks(context.parsed).slice(0, 4)) selected.push({ context, block });
    const main = contexts.find((context) => context.document.role === 'main') ?? contexts[0]!;
    const inputHash = hashJson({ documentSetHash: reader.documentSetHash, candidates, frozen: frozen.map((term) => [term.source, term.translation]), blocks: selected.map(({ context, block }) => [context.document.id, block.stableId ?? block.id, blockText(block)]) });
    const unit = this.makeUnit(instanceId, 'terminology', 'full-document-ledger', inputHash, []);
    if (this.validCompletedUnit(reader, unit) && analysis.terms.length > 0) return;
    this.startUnit(instanceId, unit, actor);
    let terms: Array<{ source: string; translation: string; note: string }>;
    let generationId: string;
    let usage: ModelUsage;
    let modelCallCount = 1;
    if (this.#terminology) {
      const result = await this.#terminology({
        document: main.document.revision,
        blocks: selected.map(({ context, block }) => ({ id: blockKey(context.document.id, block.id), page: block.page, type: block.type, text: blockText(block) })),
        candidates, frozenTerms: frozen.map((term) => ({ source: term.source, translation: term.translation })),
        authorization: this.modelAuthorization(this.requireAuthorization(this.requireReader(instanceId)), 'text'), inputHash,
      }, actor, signal).catch((error) => { this.consumeFailedModelCall(instanceId, error, actor); throw error; });
      generationId = result.generationId; usage = result.usage; modelCallCount = result.modelCallCount; terms = result.value;
    } else if (this.#legacyAnalyze) {
      const result = await this.#legacyAnalyze({
        instanceId, document: main.document.revision, blocks: compositeBlocks(main.document, substantiveBlocks(main.parsed)), termCandidates: candidates,
        authorization: this.modelAuthorization(this.requireAuthorization(this.requireReader(instanceId)), 'text'),
      }, actor, signal).catch((error) => { this.consumeFailedModelCall(instanceId, error, actor); throw error; });
      generationId = result.generationId; usage = result.usage; modelCallCount = result.modelCallCount ?? 1;
      terms = result.terms.map((term) => ({ ...term, note: '由兼容模型适配器生成' }));
      analysis.legacyConclusions = result.conclusions.map((item) => ({ id: randomUUID(), ...item, evidenceAnchorIds: [], generationVersion: reader.generationVersion + 1, generationId }));
    } else throw new Error('论文精读术语模型适配器不可用');
    this.consumeAuthorization(instanceId, usage, generationId, actor, modelCallCount);
    const frozenMap = new Map(frozen.map((term) => [term.source, term]));
    analysis.terms = terms.map((term) => frozenMap.get(term.source) ?? { id: randomUUID(), source: term.source, translation: term.translation, note: term.note, frozen: false });
    for (const term of frozen) if (!analysis.terms.some((candidate) => candidate.source === term.source)) analysis.terms.push(term);
    this.completeUnit(instanceId, unit, { terms: analysis.terms }, [generationId], usage, actor, analysis);
  }

  private async runTranslationStage(instanceId: string, actor: EventActor, signal: AbortSignal): Promise<void> {
    this.setStage(instanceId, 'bilingual-translation', '自动生成主文与 SI 全文双语', 0.14, actor);
    const contexts = this.documentContexts(this.requireReader(instanceId)).filter((context): context is { document: PaperDocumentV2; parsed: ParsedReaderDocument } => context.parsed !== null);
    for (const context of contexts) {
      let analysis = this.analysisFor(instanceId);
      const missing = substantiveBlocks(context.parsed).filter((block) => !analysis.translations[blockKey(context.document.id, block.id)]);
      const batches = translationChunks(missing, analysis.translationBatchLimits, context.document.id);
      let index = 0;
      while (index < batches.length) {
        if (signal.aborted) throw signal.reason;
        const batch = batches[index]!;
        const ids = batch.map((block) => blockKey(context.document.id, block.id));
        const frozen = analysis.terms.filter((term) => term.frozen && term.translation).sort((a, b) => b.source.length - a.source.length);
        const inputHash = hashJson({ document: context.document.revision.sha256, ids, text: batch.map(blockText), terms: frozen.map((term) => [term.source, term.translation]) });
        const unit = this.makeUnit(instanceId, 'bilingual-translation', `${context.document.id}:${ids.join(',')}`, inputHash, [] , context.document.id, ids);
        if (this.validCompletedUnit(this.requireReader(instanceId), unit) && ids.every((id) => analysis.translations[id])) { index += 1; continue; }
        this.startUnit(instanceId, unit, actor);
        let accepted: { generationId: string; usage: ModelUsage; modelCallCount: number; values: Map<string, string> } | undefined;
        let splitReason = '';
        let correctionReason = '';
        for (let attempt = 0; attempt < 2 && !accepted; attempt += 1) {
          let result: PaperReaderTranslationResult;
          try {
            result = await this.#translate({
              instanceId, document: context.document.revision,
              blocks: batch.map((block) => ({ id: blockKey(context.document.id, block.id), page: block.page, text: blockText(block) })),
              frozenTerms: frozen.map((term) => ({ source: term.source, translation: term.translation })),
              authorization: this.modelAuthorization(this.requireAuthorization(this.requireReader(instanceId)), 'text'),
              ...(attempt > 0 ? { correction: { attempt, reason: correctionReason.slice(0, 2_000) } } : {}),
            }, actor, signal);
          } catch (error) {
            this.consumeFailedModelCall(instanceId, error, actor);
            if (signal.aborted) throw signal.reason ?? error;
            if (transientModelFailure(error)) { splitReason = error instanceof Error ? error.message : String(error); break; }
            throw error;
          }
          this.consumeAuthorization(instanceId, result.usage, result.generationId, actor, result.modelCallCount ?? 1);
          try {
            accepted = { generationId: result.generationId, usage: result.usage, modelCallCount: result.modelCallCount ?? 1, values: this.validateTranslations(ids, batch, frozen, result.translations, attempt > 0) };
          } catch (error) {
            correctionReason = error instanceof Error ? error.message : String(error);
            if (attempt > 0) { splitReason = correctionReason; break; }
            this.update(instanceId, { stage: `自动修正 ${context.document.label} 第 ${index + 1} 批译文` }, actor, analysis);
          }
        }
        if (!accepted && batch.length > 1 && splitReason) {
          const midpoint = Math.ceil(batch.length / 2);
          const left = batch.slice(0, midpoint); const right = batch.slice(midpoint);
          for (const block of left) {
            const id = blockKey(context.document.id, block.id);
            analysis.translationBatchLimits[id] = Math.min(analysis.translationBatchLimits[id] ?? TRANSLATION_CHUNK_BLOCKS, left.length);
          }
          for (const block of right) {
            const id = blockKey(context.document.id, block.id);
            analysis.translationBatchLimits[id] = Math.min(analysis.translationBatchLimits[id] ?? TRANSLATION_CHUNK_BLOCKS, right.length);
          }
          batches.splice(index, 1, left, right);
          this.invalidateUnit(instanceId, unit.id, splitReason, actor, analysis);
          continue;
        }
        if (!accepted) {
          for (const id of ids) analysis.translationBatchLimits[id] = 1;
          this.failUnit(instanceId, unit, splitReason || correctionReason || '翻译质量门失败', actor, analysis);
          throw new Error(splitReason || correctionReason || '模型全文翻译未返回可接受结果');
        }
        analysis = this.analysisFor(instanceId);
        for (const id of ids) {
          analysis.translations[id] = accepted.values.get(id)!;
          analysis.translationRuns[id] = { generationId: accepted.generationId, createdAt: new Date().toISOString() };
          delete analysis.translationBatchLimits[id];
        }
        this.completeUnit(instanceId, unit, { translations: Object.fromEntries(ids.map((id) => [id, analysis.translations[id]])) }, [accepted.generationId], accepted.usage, actor, analysis);
        index += 1;
      }
    }
    const analysis = this.analysisFor(instanceId);
    const total = contexts.reduce((sum, context) => sum + substantiveBlocks(context.parsed).length, 0);
    const missing = contexts.flatMap((context) => substantiveBlocks(context.parsed).map((block) => blockKey(context.document.id, block.id))).filter((id) => !analysis.translations[id]);
    if (missing.length > 0) throw new Error(`全文翻译质量门未通过，缺少 ${missing.length} / ${total} 个来源块`);
    this.update(instanceId, { translatedBlockCount: total, translationBlockCount: total, progress: 0.34 }, actor, analysis);
  }

  private validateTranslations(
    ids: string[], blocks: ParsedBlock[], frozen: PaperTermV2[], translations: Array<{ blockId: string; text: string }>, allowUnexpected: boolean,
  ): Map<string, string> {
    const expected = new Set(ids);
    const returned = new Map<string, string>();
    for (const translation of translations) {
      if (!expected.has(translation.blockId)) { if (allowUnexpected) continue; throw new Error(`模型翻译包含未知来源块：${translation.blockId}`); }
      if (returned.has(translation.blockId) || !translation.text.trim()) throw new Error(`模型翻译包含重复或空来源块：${translation.blockId}`);
      returned.set(translation.blockId, translation.text.trim());
    }
    for (const [index, id] of ids.entries()) {
      const value = returned.get(id); const block = blocks[index]!;
      if (!value) throw new Error(`模型翻译缺少来源块：${id}`);
      for (const term of frozen) {
        if (!block.originalText.includes(term.source)) continue;
        const compact = !/\s/u.test(term.source) && term.source.length <= 32 && /[A-Z0-9]/u.test(term.source);
        if (!value.includes(term.translation) && !(compact && value.includes(term.source))) throw new Error(`模型翻译未遵守冻结术语：${term.source} → ${term.translation}`);
      }
    }
    return returned;
  }

  private async runSectionStage(instanceId: string, actor: EventActor, signal: AbortSignal): Promise<void> {
    if (!this.#sectionDigest) throw new Error('论文逐节精读模型适配器不可用');
    this.setStage(instanceId, 'section-digest', '按章节与延续组精读全文', 0.36, actor);
    const contexts = this.documentContexts(this.requireReader(instanceId)).filter((context): context is { document: PaperDocumentV2; parsed: ParsedReaderDocument } => context.parsed !== null);
    const units = contexts.flatMap((context) => buildSectionUnits(context.document, context.parsed));
    await mapLimit(units, 2, async (section) => {
      if (signal.aborted) throw signal.reason;
      const inputHash = hashJson({ document: section.document.revision.sha256, heading: section.heading, blocks: section.blocks.map((block) => [block.stableId ?? block.id, blockText(block)]), terms: this.analysisFor(instanceId).terms.map((term) => [term.source, term.translation]) });
      const unit = this.makeUnit(instanceId, 'section-digest', section.key, inputHash, [hashJson(this.analysisFor(instanceId).terms)], section.document.id, section.blocks.map((block) => blockKey(section.document.id, block.id)));
      const analysis = this.analysisFor(instanceId);
      if (this.validCompletedUnit(this.requireReader(instanceId), unit) && analysis.sectionDigests.some((digest) => digest.id === unit.id)) return;
      this.startUnit(instanceId, unit, actor);
      const result = await this.#sectionDigest!({
        document: section.document.revision, heading: section.heading, blocks: compositeBlocks(section.document, section.blocks),
        terminology: analysis.terms.map((term) => ({ source: term.source, translation: term.translation })),
        authorization: this.modelAuthorization(this.requireAuthorization(this.requireReader(instanceId)), 'text'), inputHash,
      }, actor, signal).catch((error) => { this.consumeFailedModelCall(instanceId, error, actor); this.failUnit(instanceId, unit, error instanceof Error ? error.message : String(error), actor); throw error; });
      this.consumeAuthorization(instanceId, result.usage, result.generationId, actor, result.modelCallCount);
      const latest = this.analysisFor(instanceId);
      const digest: PaperReaderSectionDigestV2 = {
        id: unit.id, documentId: section.document.id, heading: result.value.heading,
        blockIds: section.blocks.map((block) => blockKey(section.document.id, block.id)),
        summary: result.value.statements.map((statement) => this.materializeStatement(instanceId, statement, actor)),
        argumentativeFunction: result.value.argumentativeFunction,
      };
      latest.sectionDigests = [...latest.sectionDigests.filter((item) => item.id !== unit.id), digest];
      this.completeUnit(instanceId, unit, digest, [result.generationId], result.usage, actor, latest);
    });
    this.update(instanceId, { progress: 0.56 }, actor, this.analysisFor(instanceId));
  }

  private selectedVisuals(instanceId: string): Array<{ document: PaperDocumentV2; parsed: ParsedReaderDocument; figure: ParsedFigure }> {
    const contexts = this.documentContexts(this.requireReader(instanceId)).filter((context): context is { document: PaperDocumentV2; parsed: ParsedReaderDocument } => context.parsed !== null);
    const main = contexts.find((context) => context.document.role === 'main')?.parsed;
    return contexts.flatMap((context) => context.parsed.figures
      .filter((figure) => figureKind(figure) !== 'formula' && figure.contentVisual !== false)
      .filter((figure) => context.document.role === 'main' || Boolean(main && supplementaryVisualReferenced(figure, main)))
      .map((figure) => ({ ...context, figure })));
  }

  private async runFigureStage(instanceId: string, actor: EventActor, signal: AbortSignal): Promise<void> {
    this.setStage(instanceId, 'figure-analysis', '逐图逐表视觉核验', 0.58, actor);
    const visuals = this.selectedVisuals(instanceId);
    await mapLimit(visuals, 2, async ({ document, parsed, figure }) => {
      if (signal.aborted) throw signal.reason;
      const blocks = relevantFigureBlocks(parsed, figure);
      const image = this.assetRef(document, figure);
      const inputIssue = paperReaderVisualInputIssue(parsed, figure);
      const inputHash = hashJson({ document: document.revision.sha256, figure: figure.id, caption: figure.originalCaption, bbox: figure.bbox, pixelWidth: figure.pixelWidth, pixelHeight: figure.pixelHeight, approximate: figure.approximate, inputIssue, imageHash: image?.sha256, blocks: blocks.map((block) => [block.stableId ?? block.id, blockText(block)]) });
      const unit = this.makeUnit(instanceId, 'figure-analysis', `${document.id}:${figure.id}`, inputHash, [], document.id, blocks.map((block) => blockKey(document.id, block.id)), figure.id);
      const current = this.analysisFor(instanceId);
      if (this.validCompletedUnit(this.requireReader(instanceId), unit) && current.figureAnalyses.some((item) => item.id === unit.id)) return;
      this.startUnit(instanceId, unit, actor);
      const figureAnchor = this.anchorForFigure(instanceId, document, parsed, figure, actor);
      let analysis: PaperReaderFigureAnalysisV2;
      let generationIds: string[] = [];
      let usage = zeroUsage();
      const vision = this.#visionModel();
      if (inputIssue || !vision || !this.#figureAnalysis || !image) {
        analysis = {
          id: unit.id, documentId: document.id, figureId: figure.id, kind: figureKind(figure) === 'table' ? 'table' : 'figure', status: 'needs_review',
          purpose: '未执行视觉核验', panelObservations: [], axesAndVariables: [], controls: [], quantitativeResults: [],
          authorInterpretation: [], independentJudgment: [], limitations: [], linkedClaimIds: [], evidenceAnchorIds: [figureAnchor.id],
          error: inputIssue ? `图表视觉输入被质量门拒绝：${inputIssue}` : !vision ? '未配置视觉模型' : !image ? '图表裁剪文件缺失或哈希无效' : '视觉模型适配器不可用',
        };
      } else {
        try {
          const result = await this.#figureAnalysis({
            document: document.revision, figureId: figure.id, kind: figureKind(figure) === 'table' ? 'table' : 'figure',
            caption: figure.originalCaption ?? '', approximate: figure.approximate === true, blocks: compositeBlocks(document, blocks), image,
            authorization: this.modelAuthorization(this.requireAuthorization(this.requireReader(instanceId)), 'vision'), inputHash,
          }, actor, signal);
          this.consumeAuthorization(instanceId, result.usage, result.generationId, actor, result.modelCallCount);
          generationIds = [result.generationId]; usage = result.usage;
          analysis = {
            id: unit.id, documentId: document.id, figureId: figure.id, kind: figureKind(figure) === 'table' ? 'table' : 'figure',
            status: figure.approximate ? 'needs_review' : result.value.status, purpose: result.value.purpose,
            panelObservations: result.value.panelObservations, axesAndVariables: result.value.axesAndVariables, controls: result.value.controls,
            quantitativeResults: result.value.quantities.map((quantity) => this.materializeQuantity(instanceId, quantity, actor)),
            authorInterpretation: result.value.authorInterpretation.map((statement) => this.materializeStatement(instanceId, statement, actor)),
            independentJudgment: result.value.independentJudgment.map((statement) => this.materializeStatement(instanceId, statement, actor)),
            limitations: result.value.limitations.map((statement) => this.materializeStatement(instanceId, statement, actor)),
            linkedClaimIds: [], evidenceAnchorIds: [...new Set([figureAnchor.id, ...result.value.authorInterpretation.flatMap((statement) => this.anchorIdsForDraft(instanceId, statement, actor))])],
            ...(figure.approximate ? { error: '裁剪边界近似，需要人工复核' } : {}),
          };
        } catch (error) {
          this.consumeFailedModelCall(instanceId, error, actor);
          analysis = {
            id: unit.id, documentId: document.id, figureId: figure.id, kind: figureKind(figure) === 'table' ? 'table' : 'figure', status: 'failed',
            purpose: '视觉分析失败', panelObservations: [], axesAndVariables: [], controls: [], quantitativeResults: [], authorInterpretation: [], independentJudgment: [], limitations: [],
            linkedClaimIds: [], evidenceAnchorIds: [figureAnchor.id], error: (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
          };
        }
      }
      const latest = this.analysisFor(instanceId);
      latest.figureAnalyses = [...latest.figureAnalyses.filter((item) => item.id !== unit.id), analysis];
      this.completeUnit(instanceId, unit, analysis, generationIds, usage, actor, latest);
    });
    this.update(instanceId, { progress: 0.72 }, actor, this.analysisFor(instanceId));
  }

  private async runFormulaStage(instanceId: string, actor: EventActor, signal: AbortSignal): Promise<void> {
    this.setStage(instanceId, 'formula-analysis', '逐公式视觉转写与语义核验', 0.73, actor);
    const contexts = this.documentContexts(this.requireReader(instanceId)).filter((context): context is { document: PaperDocumentV2; parsed: ParsedReaderDocument } => context.parsed !== null);
    const formulas = contexts.flatMap((context) => context.parsed.blocks.filter((block) => block.type === 'formula').map((formula) => ({ ...context, formula })));
    await mapLimit(formulas, 2, async ({ document, parsed, formula }) => {
      if (signal.aborted) throw signal.reason;
      const blocks = relevantFormulaBlocks(parsed, formula);
      const formulaId = formula.refs?.find((ref) => /^(?:E|EQ)/iu.test(ref)) ?? formula.id;
      const formulaFigure = parsed.figures.find((figure) => figureKind(figure) === 'formula' && (figure.id === formulaId || formula.refs?.includes(figure.id)));
      const image = formulaFigure ? this.assetRef(document, formulaFigure) : undefined;
      const inputIssue = formulaFigure ? paperReaderVisualInputIssue(parsed, formulaFigure) : '公式原始区域缺失';
      const inputHash = hashJson({ document: document.revision.sha256, formula: formula.stableId ?? formula.id, text: blockText(formula), imageHash: image?.sha256 ?? null, inputIssue, context: blocks.map(blockText) });
      const unit = this.makeUnit(instanceId, 'formula-analysis', `${document.id}:${formulaId}`, inputHash, [], document.id, blocks.map((block) => blockKey(document.id, block.id)), formulaId);
      const current = this.analysisFor(instanceId);
      if (this.validCompletedUnit(this.requireReader(instanceId), unit) && current.formulaAnalyses.some((item) => item.id === unit.id)) return;
      this.startUnit(instanceId, unit, actor);
      const sourceAnchor = this.anchorForCompositeBlock(instanceId, blockKey(document.id, formula.id), actor);
      const visualAnchor = formulaFigure ? this.anchorForFigure(instanceId, document, parsed, formulaFigure, actor) : undefined;
      let item: PaperReaderFormulaAnalysisV2;
      let generationIds: string[] = [];
      let usage = zeroUsage();
      const vision = this.#visionModel();
      if (inputIssue || !vision || !this.#formulaAnalysis || !image) {
        const error = inputIssue ? `公式视觉输入被质量门拒绝：${inputIssue}` : !vision ? '未配置公式视觉模型' : !image ? '公式原始区域缺失或哈希无效' : '公式视觉适配器不可用';
        item = {
          id: unit.id, documentId: document.id, formulaId, status: 'needs_review', expression: blockText(formula), sourceExpression: blockText(formula),
          ambiguousSymbols: [error], sourceTextAgreement: 'text_layer_incomplete', variables: [], assumptions: [], purpose: '等待公式原图视觉核验', applicability: [],
          evidenceAnchorIds: [...new Set([sourceAnchor.id, ...(visualAnchor ? [visualAnchor.id] : [])])], error,
        };
      } else {
        let accepted: Awaited<ReturnType<FormulaRunner>> | undefined;
        let correctionReason = '';
        for (let attempt = 0; attempt < 3 && !accepted; attempt += 1) {
          try {
            const result = await this.#formulaAnalysis({
              document: document.revision, formulaId, expression: blockText(formula), blocks: compositeBlocks(document, blocks), image,
              authorization: this.modelAuthorization(this.requireAuthorization(this.requireReader(instanceId)), 'vision'), inputHash,
              ...(attempt > 0 ? { correction: { attempt, reason: correctionReason.slice(0, 2_000) } } : {}),
            }, actor, signal);
            this.consumeAuthorization(instanceId, result.usage, result.generationId, actor, result.modelCallCount);
            generationIds.push(result.generationId); usage = addUsage(usage, result.usage);
            if (result.value.status === 'verified') accepted = result;
            else {
              correctionReason = `视觉结果仍需复核：${result.value.ambiguousSymbols.join('；') || result.value.sourceTextAgreement}`;
              if (attempt === 2) accepted = result;
              else this.update(instanceId, { stage: '自动重新核对公式原图' }, actor, this.analysisFor(instanceId));
            }
          } catch (error) {
            this.consumeFailedModelCall(instanceId, error, actor);
            if (signal.aborted) throw signal.reason ?? error;
            correctionReason = error instanceof Error ? error.message : String(error);
            if (attempt < 2) this.update(instanceId, { stage: '自动修正公式视觉转写' }, actor, this.analysisFor(instanceId));
          }
        }
        if (accepted) {
          const result = accepted;
          item = {
            id: unit.id, documentId: document.id, formulaId, status: result.value.status, expression: result.value.expression,
            sourceExpression: blockText(formula), ambiguousSymbols: result.value.ambiguousSymbols, sourceTextAgreement: result.value.sourceTextAgreement,
            variables: result.value.variables, assumptions: result.value.assumptions, purpose: result.value.purpose, applicability: result.value.applicability,
            evidenceAnchorIds: [...new Set([sourceAnchor.id, ...(visualAnchor ? [visualAnchor.id] : []), ...result.value.blockIds.map((id) => this.anchorForCompositeBlock(instanceId, id, actor).id)])],
            ...(result.value.status === 'needs_review' ? { error: '公式存在视觉歧义，不能作为已核验结果' } : {}),
          };
        } else {
          item = {
            id: unit.id, documentId: document.id, formulaId, status: 'failed', expression: blockText(formula), sourceExpression: blockText(formula),
            ambiguousSymbols: [], sourceTextAgreement: 'conflict', variables: [], assumptions: [], purpose: '公式视觉转写失败', applicability: [],
            evidenceAnchorIds: [...new Set([sourceAnchor.id, ...(visualAnchor ? [visualAnchor.id] : [])])],
            error: correctionReason.slice(0, 4_000) || '公式视觉转写在三次自动核验后仍失败',
          };
        }
      }
      const latest = this.analysisFor(instanceId);
      latest.formulaAnalyses = [...latest.formulaAnalyses.filter((candidate) => candidate.id !== unit.id), item];
      this.completeUnit(instanceId, unit, item, generationIds, usage, actor, latest);
    });
    this.update(instanceId, { progress: 0.78 }, actor, this.analysisFor(instanceId));
  }

  private async runClaimStage(instanceId: string, actor: EventActor, signal: AbortSignal): Promise<void> {
    if (!this.#claimEvidence) throw new Error('论文主张—证据模型适配器不可用');
    this.setStage(instanceId, 'claim-evidence', '构建主张—证据—限定关系', 0.8, actor);
    const analysis = this.analysisFor(instanceId);
    const staged = { sectionDigests: analysis.sectionDigests, figureAnalyses: analysis.figureAnalyses, formulaAnalyses: analysis.formulaAnalyses };
    const inputHash = hashJson(staged);
    const unit = this.makeUnit(instanceId, 'claim-evidence', 'global', inputHash, analysis.sectionDigests.map((digest) => digest.id));
    if (this.validCompletedUnit(this.requireReader(instanceId), unit) && analysis.claimEvidence) return;
    this.startUnit(instanceId, unit, actor);
    const main = this.requireReader(instanceId).documents.find((document) => document.role === 'main')!;
    const result = await this.#claimEvidence({
      document: main.revision, stagedJson: JSON.stringify(staged), sourceBlocks: this.allCompositeSourceBlocks(instanceId),
      authorization: this.modelAuthorization(this.requireAuthorization(this.requireReader(instanceId)), 'text'), inputHash,
    }, actor, signal).catch((error) => { this.consumeFailedModelCall(instanceId, error, actor); this.failUnit(instanceId, unit, error instanceof Error ? error.message : String(error), actor); throw error; });
    this.consumeAuthorization(instanceId, result.usage, result.generationId, actor, result.modelCallCount);
    const latest = this.analysisFor(instanceId);
    latest.claimEvidence = {
      evidenceChain: result.value.evidenceChain.map((item) => this.materializeStatement(instanceId, item, actor)),
      mechanism: result.value.mechanism.map((item) => this.materializeStatement(instanceId, item, actor)),
      keyResults: result.value.keyResults.map((item) => this.materializeStatement(instanceId, item, actor)),
      contributions: result.value.contributions.map((item) => this.materializeStatement(instanceId, item, actor)),
      limitations: result.value.limitations.map((item) => this.materializeStatement(instanceId, item, actor)),
      unproven: result.value.unproven.map((item) => this.materializeStatement(instanceId, item, actor)),
    };
    this.completeUnit(instanceId, unit, latest.claimEvidence, [result.generationId], result.usage, actor, latest);
  }

  private async runReproductionStage(instanceId: string, actor: EventActor, signal: AbortSignal): Promise<void> {
    if (!this.#reproduction) throw new Error('论文复现审计模型适配器不可用');
    this.setStage(instanceId, 'reproduction', '审计复现条件与缺失信息', 0.85, actor);
    const analysis = this.analysisFor(instanceId);
    const staged = { sectionDigests: analysis.sectionDigests.filter((digest) => /method|experiment|material|procedure|方法|实验/iu.test(`${digest.heading} ${digest.argumentativeFunction ?? ''}`)) };
    const inputHash = hashJson(staged);
    const unit = this.makeUnit(instanceId, 'reproduction', 'global', inputHash, staged.sectionDigests.map((digest) => digest.id));
    if (this.validCompletedUnit(this.requireReader(instanceId), unit) && analysis.reproduction) return;
    this.startUnit(instanceId, unit, actor);
    const main = this.requireReader(instanceId).documents.find((document) => document.role === 'main')!;
    const result = await this.#reproduction({
      document: main.revision, stagedJson: JSON.stringify(staged), sourceBlocks: this.allCompositeSourceBlocks(instanceId),
      authorization: this.modelAuthorization(this.requireAuthorization(this.requireReader(instanceId)), 'text'), inputHash,
    }, actor, signal).catch((error) => { this.consumeFailedModelCall(instanceId, error, actor); this.failUnit(instanceId, unit, error instanceof Error ? error.message : String(error), actor); throw error; });
    this.consumeAuthorization(instanceId, result.usage, result.generationId, actor, result.modelCallCount);
    const latest = this.analysisFor(instanceId);
    latest.reproduction = {
      materials: result.value.materials.map((item) => this.materializeStatement(instanceId, item, actor)),
      preparation: result.value.preparation.map((item) => this.materializeStatement(instanceId, item, actor)),
      instruments: result.value.instruments.map((item) => this.materializeStatement(instanceId, item, actor)),
      parameters: result.value.parameters.map((item) => this.materializeStatement(instanceId, item, actor)),
      controls: result.value.controls.map((item) => this.materializeStatement(instanceId, item, actor)),
      statistics: result.value.statistics.map((item) => this.materializeStatement(instanceId, item, actor)),
      conditions: result.value.conditions.map((item) => this.materializeStatement(instanceId, item, actor)),
      missingInformation: result.value.missingInformation.map((item) => this.materializeStatement(instanceId, item, actor)),
    };
    this.completeUnit(instanceId, unit, latest.reproduction, [result.generationId], result.usage, actor, latest);
  }

  private async runSynthesisStage(instanceId: string, actor: EventActor, signal: AbortSignal): Promise<void> {
    if (!this.#synthesis) throw new Error('论文综合模型适配器不可用');
    this.setStage(instanceId, 'synthesis', '从分阶段结果生成全局综合', 0.9, actor);
    const analysis = this.analysisFor(instanceId);
    if (!analysis.claimEvidence || !analysis.reproduction) throw new Error('综合阶段缺少主张—证据或复现阶段产物');
    const staged = {
      sectionDigests: analysis.sectionDigests, figureAnalyses: analysis.figureAnalyses, formulaAnalyses: analysis.formulaAnalyses,
      claimEvidence: analysis.claimEvidence, reproduction: analysis.reproduction,
    };
    const inputHash = hashJson(staged);
    const unit = this.makeUnit(instanceId, 'synthesis', 'global', inputHash, this.requireReader(instanceId).pipeline.units.filter((item) => ['claim-evidence', 'reproduction'].includes(item.stage)).map((item) => item.outputSha256 ?? item.inputHash));
    if (this.validCompletedUnit(this.requireReader(instanceId), unit) && analysis.synthesis) return;
    this.startUnit(instanceId, unit, actor);
    const main = this.requireReader(instanceId).documents.find((document) => document.role === 'main')!;
    const result = await this.#synthesis({
      document: main.revision, stagedJson: JSON.stringify(staged), sourceBlocks: this.allCompositeSourceBlocks(instanceId),
      authorization: this.modelAuthorization(this.requireAuthorization(this.requireReader(instanceId)), 'text'), inputHash,
    }, actor, signal).catch((error) => { this.consumeFailedModelCall(instanceId, error, actor); this.failUnit(instanceId, unit, error instanceof Error ? error.message : String(error), actor); throw error; });
    this.consumeAuthorization(instanceId, result.usage, result.generationId, actor, result.modelCallCount);
    const latest = this.analysisFor(instanceId);
    latest.synthesis = {
      thesis: result.value.thesis.map((item) => this.materializeStatement(instanceId, item, actor)),
      researchQuestion: result.value.researchQuestion.map((item) => this.materializeStatement(instanceId, item, actor)),
      strategy: result.value.strategy.map((item) => this.materializeStatement(instanceId, item, actor)),
      researchImplications: result.value.researchImplications.map((item) => this.materializeStatement(instanceId, item, actor)),
      directionOutput: result.value.directionOutput.map((item) => this.materializeStatement(instanceId, item, actor)),
      presentationBrief: result.value.presentationBrief,
    };
    this.completeUnit(instanceId, unit, latest.synthesis, [result.generationId], result.usage, actor, latest);
  }

  private async publishFinalReport(instanceId: string, actor: EventActor): Promise<void> {
    this.setStage(instanceId, 'quality-gate', '执行确定性质量门并原子发布', 0.97, actor);
    const reader = this.requireReader(instanceId);
    const analysis = this.analysisFor(instanceId);
    const report = this.buildReport(reader, analysis);
    analysis.report = report;
    if (report.quality.status === 'failed') {
      this.update(instanceId, { quality: report.quality }, actor, analysis);
      throw new Error(`PAPER_READER_QUALITY_GATE: ${report.quality.issues.join('；')}`);
    }
    const bundle = this.buildArtifactBundle(reader, analysis, report);
    const main = reader.documents.find((document) => document.role === 'main')!;
    const artifact = this.#createReportArtifact({
      instanceId, title: `${this.readParsed(main.parsedDocument)?.paper.title ?? main.label} · 精读报告 V2`,
      markdown: bundle.markdown, json: JSON.stringify(report, null, 2), parsedRef: main.parsedDocument!, files: bundle.files, quality: report.quality,
    }, actor);
    this.#mountReport(instanceId, artifact, `精读报告 V2（${report.quality.status === 'complete' ? '完整' : '需复核'}）`, actor);
    const completedAuthorization = this.completeAuthorization(this.requireReader(instanceId), actor);
    const evidenceAnchorIds = [...new Set(this.allReportStatements(report).flatMap((statement) => statement.evidenceAnchorIds))];
    const completed = this.update(instanceId, {
      status: 'completed', stage: report.quality.status === 'complete' ? '精读 V2 闭环完成' : '精读 V2 已完成，但存在需复核项目', progress: 1,
      reportArtifact: artifact, quality: report.quality, evidenceAnchorIds, conclusionCount: this.allReportStatements(report).length,
      termCount: analysis.terms.length, generationVersion: reader.generationVersion + 1, translatedBlockCount: Object.keys(analysis.translations).length,
      batchAuthorization: completedAuthorization, clearError: true,
    }, actor, analysis);
    if (completed.runId) this.#kernel.updateRun(completed.runId, { status: 'completed', progress: 1, stage: completed.stage, outputRefs: [artifact.revisionId, ...evidenceAnchorIds] }, actor);
  }

  setAutoFollow(instanceId: string, enabled: boolean, actor: EventActor): PaperReaderInstanceV2 {
    return this.update(instanceId, { autoFollow: enabled }, actor);
  }

  selectBlock(instanceId: string, blockId: string, actor: EventActor, documentKind: string = 'main'): PaperReaderInstanceV2 {
    const reader = this.requireReader(instanceId);
    const document = this.resolveDocument(reader, documentKind);
    const parsed = this.readParsed(document.parsedDocument);
    const raw = rawBlockId(blockId);
    if (!parsed?.blocks.some((block) => block.id === raw)) throw new Error('原文块不存在');
    return this.update(instanceId, { activeBlockId: blockKey(document.id, raw), activeDocumentId: document.id }, actor);
  }

  freezeTerm(instanceId: string, source: string, translation: string, actor: EventActor): PaperReaderPanelContext {
    const analysis = this.analysisFor(instanceId);
    const normalized = source.trim().slice(0, 200);
    const target = translation.trim().slice(0, 400);
    if (!normalized || !target) throw new Error('术语和译法不能为空');
    const current = analysis.terms.find((term) => term.source === normalized);
    if (current) { current.translation = target; current.frozen = true; current.note = '用户冻结'; }
    else analysis.terms.push({ id: randomUUID(), source: normalized, translation: target, note: '用户冻结', frozen: true });
    this.invalidateStages(instanceId, new Set<PaperReaderPipelineStageV2>(['bilingual-translation', 'section-digest', 'claim-evidence', 'reproduction', 'synthesis', 'quality-gate']), actor, analysis);
    this.update(instanceId, { termCount: analysis.terms.length, status: 'stale', stage: '术语已冻结；相关译文与分析需要范围化重跑' }, actor, analysis);
    return this.context(instanceId, null);
  }

  async translateBlocks(instanceId: string, blockIds: string[], actor: EventActor, documentKind: string = 'main'): Promise<PaperReaderPanelContext> {
    const reader = this.requireReader(instanceId);
    const authorization = this.requireAuthorization(reader);
    const document = this.resolveDocument(reader, documentKind);
    const parsed = this.readParsed(document.parsedDocument);
    if (!parsed) throw new Error('目标文档尚未完成解析');
    const requested = new Set(blockIds.map(rawBlockId));
    const blocks = substantiveBlocks(parsed).filter((block) => requested.has(block.id)).slice(0, 100);
    if (blocks.length === 0) throw new Error('请选择需要翻译的来源块');
    const analysis = this.analysisFor(instanceId);
    const frozen = analysis.terms.filter((term) => term.frozen && term.translation);
    const result = await this.#translate({
      instanceId, document: document.revision,
      blocks: blocks.map((block) => ({ id: blockKey(document.id, block.id), page: block.page, text: blockText(block) })),
      frozenTerms: frozen.map((term) => ({ source: term.source, translation: term.translation })),
      authorization: this.modelAuthorization(authorization, 'text'),
    }, actor).catch((error) => { this.consumeFailedModelCall(instanceId, error, actor); throw error; });
    this.consumeAuthorization(instanceId, result.usage, result.generationId, actor, result.modelCallCount ?? 1);
    const ids = blocks.map((block) => blockKey(document.id, block.id));
    const values = this.validateTranslations(ids, blocks, frozen, result.translations, false);
    for (const id of ids) {
      analysis.translations[id] = values.get(id)!;
      analysis.translationRuns[id] = { generationId: result.generationId, createdAt: new Date().toISOString() };
    }
    this.update(instanceId, { stage: `已重新翻译 ${ids.length} 个来源块` }, actor, analysis);
    return this.context(instanceId, null);
  }

  annotate(instanceId: string, documentKind: string, blockId: string, comment: string, actor: EventActor): PaperReaderPanelContext {
    const reader = this.requireReader(instanceId);
    const document = this.resolveDocument(reader, documentKind);
    const parsed = this.readParsed(document.parsedDocument);
    const block = parsed?.blocks.find((candidate) => candidate.id === rawBlockId(blockId));
    if (!parsed || !block) throw new Error('批注目标来源块不存在');
    this.#createAnnotation({ target: document.revision, selector: selectorForBlock(parsed, block), comment }, actor);
    this.#onChanged();
    return this.context(instanceId, null);
  }

  async ask(instanceId: string, question: string, actor: EventActor): Promise<PaperReaderPanelContext> {
    if (!this.#question) throw new Error('来源约束问答模型适配器不可用');
    const query = question.trim().slice(0, 2_000);
    if (!query) throw new Error('问题不能为空');
    const reader = this.requireReader(instanceId);
    const tokens = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
    const candidates = this.documentContexts(reader).flatMap((context) => context.parsed ? searchableBlocks(context.parsed).map((block) => ({
      document: context.document, block,
      score: tokens.reduce((score, token) => score + (block.originalText.toLocaleLowerCase().includes(token) ? 1 : 0), 0),
    })) : []).sort((left, right) => right.score - left.score || left.block.order - right.block.order);
    const evidence = (candidates.filter((candidate) => candidate.score > 0).slice(0, 8).length > 0
      ? candidates.filter((candidate) => candidate.score > 0).slice(0, 8) : candidates.slice(0, 4));
    if (evidence.length === 0) throw new Error('文档中没有可用于回答的来源块');
    const authorizedAt = new Date().toISOString();
    const authorization: PaperReaderModelAuthorization = {
      id: randomUUID(), authorizedAt, model: this.#textModel(), maximumTotalTokens: 24_000, completedModelCalls: 0,
    };
    this.#events.append({
      streamId: `project:${this.#projectId}`, kind: 'paper-reader.v2_question_authorized', actor,
      idempotencyKey: `paper-reader:question:${authorization.id}`, provenanceRefs: [instanceId, reader.documentSetHash],
      payload: toJson({ instanceId, authorizationId: authorization.id, questionHash: hashJson(query) }),
    });
    const main = reader.documents.find((document) => document.role === 'main')!;
    const inputHash = hashJson({ question: query, blocks: evidence.map(({ document, block }) => [document.id, block.stableId ?? block.id, blockText(block)]) });
    const result = await this.#question({
      document: main.revision, question: query,
      blocks: evidence.map(({ document, block }) => ({ id: blockKey(document.id, block.id), page: block.page, type: block.type, text: blockText(block) })),
      authorization, inputHash,
    }, actor).catch((error) => { throw error; });
    if (result.usage.totalTokens > authorization.maximumTotalTokens) throw new Error('来源问答超过提交按钮显示的调用上限');
    const analysis = this.analysisFor(instanceId);
    const anchors = result.value.blockIds.map((id) => this.anchorForCompositeBlock(instanceId, id, actor));
    analysis.questions.unshift({
      id: randomUUID(), question: query, answer: result.value.answer,
      evidenceAnchorIds: anchors.map((anchor) => anchor.id), blockIds: result.value.blockIds,
      generationId: result.generationId, createdAt: new Date().toISOString(),
    });
    analysis.questions = analysis.questions.slice(0, 100);
    this.update(instanceId, { modelGenerationIds: [...new Set([...reader.modelGenerationIds, result.generationId])] }, actor, analysis);
    return this.context(instanceId, null);
  }

  regenerate(instanceId: string, blockIds: string[], actor: EventActor, confirmed = false): PaperReaderPanelContext {
    if (blockIds.length === 0) throw new Error('局部重新生成必须选择至少一个来源块');
    return this.regenerateModule(instanceId, 'section-digest', blockIds, actor, confirmed);
  }

  regenerateFigure(instanceId: string, figureId: string, actor: EventActor, confirmed = false): PaperReaderPanelContext {
    if (!figureId.trim()) throw new Error('逐图重跑缺少图表 ID');
    return this.regenerateModule(instanceId, 'figure-analysis', [figureId], actor, confirmed);
  }

  regenerateModule(instanceId: string, module: PaperReaderModuleV2, targetIds: string[], actor: EventActor, confirmed = false): PaperReaderPanelContext {
    if (!confirmed) throw new Error('局部重跑会产生新的 token 使用；请在范围化调用预览后确认一次');
    const reader = this.requireReader(instanceId);
    const targets = new Set(targetIds);
    const stages = new Set<PaperReaderPipelineStageV2>([module]);
    if (['section-digest', 'figure-analysis', 'formula-analysis'].includes(module)) stages.add('claim-evidence');
    if (module === 'reproduction' || stages.has('claim-evidence')) stages.add('synthesis');
    stages.add('quality-gate');
    const analysis = this.analysisFor(instanceId);
    const units = reader.pipeline.units.map((unit) => {
      const targetMatch = unit.stage !== module || targets.size === 0 || targets.has(unit.assetId ?? '') || unit.blockIds.some((id) => targets.has(id) || targets.has(rawBlockId(id)));
      return stages.has(unit.stage) && targetMatch ? { ...unit, status: 'invalidated' as const, error: '用户请求局部重跑', updatedAt: new Date().toISOString() } : unit;
    });
    if (module === 'section-digest') analysis.sectionDigests = analysis.sectionDigests.filter((digest) => !digest.blockIds.some((id) => targets.has(id) || targets.has(rawBlockId(id))));
    if (module === 'figure-analysis') analysis.figureAnalyses = analysis.figureAnalyses.filter((item) => !targets.has(item.figureId) && !targets.has(item.id));
    if (module === 'formula-analysis') analysis.formulaAnalyses = analysis.formulaAnalyses.filter((item) => !targets.has(item.formulaId) && !targets.has(item.id));
    if (stages.has('claim-evidence')) delete analysis.claimEvidence;
    if (stages.has('reproduction')) delete analysis.reproduction;
    if (stages.has('synthesis')) delete analysis.synthesis;
    delete analysis.report;
    this.update(instanceId, {
      pipeline: { ...reader.pipeline, units, failedUnits: units.filter((unit) => unit.status === 'failed').length },
      status: 'stale', stage: '局部重跑已授权并排队', quality: undefined, batchAuthorization: undefined,
    }, actor, analysis);
    this.start(instanceId, actor, true, [module]);
    return this.context(instanceId, null);
  }

  attachSupplement(instanceId: string, value: JsonValue, actor: EventActor): PaperReaderInstanceV2 {
    const reader = this.requireReader(instanceId);
    const input = documentRevisionFromInput(value, `补充材料 ${reader.documents.length}`);
    this.verifyRevision(input.revision);
    if (reader.documents.some((document) => document.revision.sha256 === input.revision.sha256 && document.revision.ref.path === input.revision.ref.path)) return structuredClone(reader);
    const document: PaperDocumentV2 = {
      schemaVersion: 2, id: `si-${input.revision.sha256.slice(0, 16)}-${reader.documents.length}`, paperId: reader.paperId,
      role: 'supplementary', label: input.label, revision: input.revision, parseState: 'pending', warnings: [],
    };
    const documents = [...reader.documents, document];
    const analysis = this.analysisFor(instanceId);
    this.invalidateStages(instanceId, new Set(DEFAULT_MODULES), actor, analysis);
    return this.update(instanceId, {
      documents, documentSetHash: documentSetHash(documents), status: 'stale', stage: '已添加 SI；需要重新离线预检',
      batchAuthorization: undefined, quality: undefined,
    }, actor, analysis);
  }

  removeSupplement(instanceId: string, documentId: string, actor: EventActor): PaperReaderInstanceV2 {
    const reader = this.requireReader(instanceId);
    const target = reader.documents.find((document) => document.id === documentId);
    if (!target || target.role !== 'supplementary') throw new Error('只能移除补充材料');
    const documents = reader.documents.filter((document) => document.id !== documentId);
    const analysis = this.analysisFor(instanceId);
    for (const key of Object.keys(analysis.translations)) if (key.startsWith(`${documentId}:`)) delete analysis.translations[key];
    analysis.sectionDigests = analysis.sectionDigests.filter((item) => item.documentId !== documentId);
    analysis.figureAnalyses = analysis.figureAnalyses.filter((item) => item.documentId !== documentId);
    analysis.formulaAnalyses = analysis.formulaAnalyses.filter((item) => item.documentId !== documentId);
    this.invalidateStages(instanceId, new Set<PaperReaderPipelineStageV2>(['claim-evidence', 'reproduction', 'synthesis', 'quality-gate']), actor, analysis);
    return this.update(instanceId, {
      documents, documentSetHash: documentSetHash(documents), status: 'stale', stage: '已移除 SI；下游报告已标记陈旧',
      batchAuthorization: undefined, quality: undefined,
    }, actor, analysis);
  }

  export(instanceId: string, actor: EventActor): ArtifactRevisionRef {
    const reader = this.requireReader(instanceId);
    const analysis = this.analysisFor(instanceId);
    const report = analysis.report ?? this.buildReport(reader, analysis);
    if (report.quality.status === 'failed') throw new Error(`PAPER_READER_QUALITY_GATE: ${report.quality.issues.join('；')}`);
    const bundle = this.buildArtifactBundle(reader, analysis, report);
    const main = reader.documents.find((document) => document.role === 'main')!;
    const artifact = this.#createReportArtifact({
      instanceId, title: `${this.readParsed(main.parsedDocument)?.paper.title ?? main.label} · 精读报告 V2`, markdown: bundle.markdown,
      json: JSON.stringify(report, null, 2), parsedRef: main.parsedDocument!, files: bundle.files, quality: report.quality,
    }, actor);
    this.#mountReport(instanceId, artifact, '精读报告 V2（Markdown / JSON）', actor);
    this.update(instanceId, { reportArtifact: artifact, stage: '已导出可复现 V2 报告' }, actor, analysis);
    return structuredClone(artifact);
  }

  context(instanceId: string, reveal: JsonValue): PaperReaderPanelContext {
    const reader = this.requireReader(instanceId);
    const documents = this.documentContexts(reader);
    const main = documents.find((context) => context.document.role === 'main');
    const firstSupplement = documents.find((context) => context.document.role === 'supplementary');
    const hashes = new Set(reader.documents.map((document) => document.revision.sha256));
    const panelReader = structuredClone(reader);
    const parserStale = documents.some((item) => item.parsed && item.parsed.parserVersion !== PAPER_READER_PARSER_VERSION);
    if (parserStale && !['inspecting', 'parsing', 'analyzing'].includes(panelReader.status)) {
      panelReader.status = 'stale';
      panelReader.stage = `离线解析器已升级至 ${PAPER_READER_PARSER_VERSION}；请重新离线预检（不消耗 token）`;
    }
    const rawAnchors = this.#kernel.anchors().filter((anchor) => hashes.has(anchor.target.sha256));
    const anchorKeys = new Set<string>();
    const anchors = rawAnchors.reverse().filter((anchor) => {
      const key = 'schemaVersion' in anchor && anchor.schemaVersion === 2 ? anchor.canonicalUri : anchor.id;
      if (anchorKeys.has(key)) return false;
      anchorKeys.add(key);
      return true;
    });
    const context: PaperReaderPanelContext = {
      reader: panelReader, document: main?.document.revision ?? null, supportingDocument: firstSupplement?.document.revision ?? null,
      parsed: main?.parsed ?? null, supportingParsed: firstSupplement?.parsed ?? null, documents,
      analysis: this.analysisFor(instanceId), anchors,
      annotations: this.#listAnnotations().filter((annotation) => hashes.has(annotation.target.sha256)),
      jobs: this.#jobs.list().filter((job) => job.spec.worktableInstanceId === instanceId), reveal,
      toolchainAvailable: this.#toolchainAvailable(), callPreview: this.callPreview(instanceId),
      allowedTools: [
        'paper.prepare', 'paper.start', 'paper.resume', 'paper.cancel', 'paper.auto-follow', 'paper.select-block', 'paper.freeze-term',
        'paper.translate', 'paper.annotate', 'paper.ask', 'paper.regenerate', 'paper.regenerate-module', 'paper.regenerate-figure',
        'paper.document.attach', 'paper.document.remove', 'paper.document.get', 'paper.export',
      ],
    };
    let bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
    if (bytes > MAX_CONTEXT_BYTES) {
      for (const document of context.documents) {
        if (!document.parsed || bytes <= MAX_CONTEXT_BYTES) break;
        const original = document.parsed.blocks.length;
        document.parsed = { ...document.parsed, blocks: document.parsed.blocks.slice(0, 1_500), warnings: [...document.parsed.warnings, `面板上下文超过安全上限，仅显示前 ${Math.min(1_500, original)} 个来源块。`] };
        bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
      }
      context.parsed = context.documents.find((item) => item.document.role === 'main')?.parsed ?? null;
      context.supportingParsed = context.documents.find((item) => item.document.role === 'supplementary')?.parsed ?? null;
    }
    return context;
  }

  private resolveDocument(reader: PaperReaderInstanceV2, kind: string): PaperDocumentV2 {
    const document = reader.documents.find((candidate) => candidate.id === kind)
      ?? reader.documents.find((candidate) => kind === 'main' ? candidate.role === 'main' : kind === 'si' ? candidate.role === 'supplementary' : false);
    if (!document) throw new Error('论文文档不存在');
    return document;
  }

  private documentContexts(reader: PaperReaderInstanceV2): PaperReaderDocumentContext[] {
    return reader.documents.map((document) => ({ document: structuredClone(document), parsed: this.readParsed(document.parsedDocument) }));
  }

  private analysisFor(instanceId: string): PaperReaderAnalysisV2 {
    return cloneAnalysis(this.#analysis.get(instanceId));
  }

  private readParsed(ref: WorkspacePathRef | undefined): ParsedReaderDocument | null {
    if (!ref) return null;
    const absolute = new PathGuard(this.#resolveRoot(ref.rootId, 'read')).resolveExisting(ref.path);
    const value = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
    if (!isRecord(value) || !isRecord(value.paper) || !Array.isArray(value.blocks) || !Array.isArray(value.figures) || !Array.isArray(value.pages)) throw new Error('Reader Runtime 解析文档结构无效');
    return value as unknown as ParsedReaderDocument;
  }

  private parsedDocumentIsCurrent(document: PaperDocumentV2): boolean {
    const parsed = this.readParsed(document.parsedDocument);
    return parsed?.revisionHash === document.revision.sha256 && parsed.parserVersion === PAPER_READER_PARSER_VERSION;
  }

  private readJobJson(job: JobRecord, path: string): Record<string, unknown> {
    const output = job.outputs.find((candidate) => candidate.path === path);
    if (!output) throw new Error(`任务缺少输出：${path}`);
    const absolute = new PathGuard(this.#resolveRoot(output.ref.rootId, 'read')).resolveExisting(output.ref.path);
    const value = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
    if (!isRecord(value)) throw new Error(`任务 JSON 输出无效：${path}`);
    return value;
  }

  private verifyRevision(document: DocumentRevisionRef): void {
    const absolute = new PathGuard(this.#resolveRoot(document.ref.rootId, 'read')).resolveExisting(document.ref.path);
    if (sha256FileSync(absolute) !== document.sha256) throw new Error('PDF 已发生变化；精读必须创建新的不可变文档修订');
  }

  private setStage(instanceId: string, stage: PaperReaderPipelineStageV2, label: string, progress: number, actor: EventActor): void {
    const reader = this.requireReader(instanceId);
    const units = reader.pipeline.units;
    this.update(instanceId, {
      stage: label, progress,
      pipeline: {
        stage, units, totalUnits: units.length,
        completedUnits: units.filter((unit) => unit.status === 'completed' || unit.status === 'skipped').length,
        failedUnits: units.filter((unit) => unit.status === 'failed').length,
      },
    }, actor);
    if (reader.runId) this.#kernel.updateRun(reader.runId, { status: 'running', progress, stage: label }, actor);
  }

  private makeUnit(
    instanceId: string,
    stage: PaperReaderPipelineStageV2,
    key: string,
    inputHash: string,
    dependencyHashes: string[],
    documentId?: string,
    blockIds: string[] = [],
    assetId?: string,
  ): PaperReaderUnitV2 {
    const id = `unit-${createHash('sha256').update(`${instanceId}\0${stage}\0${key}`).digest('hex').slice(0, 32)}`;
    return {
      schemaVersion: 2, id, instanceId, stage, key, inputHash, dependencyHashes: [...dependencyHashes],
      ...(documentId ? { documentId } : {}), blockIds: [...blockIds], ...(assetId ? { assetId } : {}),
      status: 'pending', attempts: 0, generationIds: [], usage: zeroUsage(), updatedAt: new Date().toISOString(),
    };
  }

  private validCompletedUnit(reader: PaperReaderInstanceV2, candidate: PaperReaderUnitV2): boolean {
    const unit = reader.pipeline.units.find((item) => item.id === candidate.id);
    if (!unit || unit.status !== 'completed' || unit.inputHash !== candidate.inputHash
      || JSON.stringify(unit.dependencyHashes) !== JSON.stringify(candidate.dependencyHashes) || !unit.outputRef || !unit.outputSha256) return false;
    try {
      const absolute = new PathGuard(this.#resolveRoot(unit.outputRef.rootId, 'read')).resolveExisting(unit.outputRef.path);
      return sha256FileSync(absolute) === unit.outputSha256;
    } catch {
      return false;
    }
  }

  private replaceUnit(instanceId: string, unit: PaperReaderUnitV2, actor: EventActor, analysis?: PaperReaderAnalysisV2): PaperReaderUnitV2 {
    const reader = this.requireReader(instanceId);
    const units = [...reader.pipeline.units.filter((item) => item.id !== unit.id), unit]
      .sort((left, right) => left.stage.localeCompare(right.stage) || left.key.localeCompare(right.key));
    this.update(instanceId, {
      pipeline: {
        stage: unit.stage, units, totalUnits: units.length,
        completedUnits: units.filter((item) => item.status === 'completed' || item.status === 'skipped').length,
        failedUnits: units.filter((item) => item.status === 'failed').length,
      },
    }, actor, analysis);
    return unit;
  }

  private startUnit(instanceId: string, candidate: PaperReaderUnitV2, actor: EventActor): PaperReaderUnitV2 {
    const existing = this.requireReader(instanceId).pipeline.units.find((item) => item.id === candidate.id);
    const unit: PaperReaderUnitV2 = {
      ...candidate, status: 'running', attempts: (existing?.attempts ?? 0) + 1,
      generationIds: existing?.generationIds ?? [], usage: existing?.usage ?? zeroUsage(),
      updatedAt: new Date().toISOString(),
    };
    return this.replaceUnit(instanceId, unit, actor);
  }

  private completeUnit(
    instanceId: string,
    candidate: PaperReaderUnitV2,
    value: unknown,
    generationIds: string[],
    usage: ModelUsage,
    actor: EventActor,
    analysis?: PaperReaderAnalysisV2,
  ): PaperReaderUnitV2 {
    const current = this.requireReader(instanceId).pipeline.units.find((item) => item.id === candidate.id) ?? candidate;
    const output = this.writeUnitCheckpoint(instanceId, candidate, value, generationIds, usage);
    const { error: _previousError, ...completed } = current;
    const unit: PaperReaderUnitV2 = {
      ...completed, inputHash: candidate.inputHash, dependencyHashes: candidate.dependencyHashes,
      status: 'completed', generationIds: [...new Set([...current.generationIds, ...generationIds])], usage: addUsage(current.usage, usage),
      outputRef: output.ref, outputSha256: output.sha256, updatedAt: new Date().toISOString(),
    };
    return this.replaceUnit(instanceId, unit, actor, analysis);
  }

  private failUnit(instanceId: string, candidate: PaperReaderUnitV2, error: string, actor: EventActor, analysis?: PaperReaderAnalysisV2): PaperReaderUnitV2 {
    const current = this.requireReader(instanceId).pipeline.units.find((item) => item.id === candidate.id) ?? candidate;
    return this.replaceUnit(instanceId, { ...current, status: 'failed', error: error.slice(0, 4_000), updatedAt: new Date().toISOString() }, actor, analysis);
  }

  private invalidateUnit(instanceId: string, unitId: string, reason: string, actor: EventActor, analysis?: PaperReaderAnalysisV2): void {
    const reader = this.requireReader(instanceId);
    const unit = reader.pipeline.units.find((item) => item.id === unitId);
    if (unit) this.replaceUnit(instanceId, { ...unit, status: 'invalidated', error: reason.slice(0, 4_000), updatedAt: new Date().toISOString() }, actor, analysis);
  }

  private invalidateStages(instanceId: string, stages: Set<PaperReaderPipelineStageV2>, _actor: EventActor, analysis: PaperReaderAnalysisV2): void {
    const reader = this.requireReader(instanceId);
    const units = reader.pipeline.units.map((unit) => stages.has(unit.stage) ? { ...unit, status: 'invalidated' as const, error: '上游输入发生变化', updatedAt: new Date().toISOString() } : unit);
    if (stages.has('document-profile')) analysis.documentProfiles = [];
    if (stages.has('section-digest')) analysis.sectionDigests = [];
    if (stages.has('figure-analysis')) analysis.figureAnalyses = [];
    if (stages.has('formula-analysis')) analysis.formulaAnalyses = [];
    if (stages.has('claim-evidence')) delete analysis.claimEvidence;
    if (stages.has('reproduction')) delete analysis.reproduction;
    if (stages.has('synthesis')) delete analysis.synthesis;
    if (stages.has('quality-gate')) delete analysis.report;
    this.#readers.set(instanceId, {
      ...reader, pipeline: { ...reader.pipeline, units, completedUnits: units.filter((unit) => unit.status === 'completed').length, failedUnits: units.filter((unit) => unit.status === 'failed').length },
    });
  }

  private writeUnitCheckpoint(
    instanceId: string, unit: PaperReaderUnitV2, value: unknown, generationIds: string[], usage: ModelUsage,
  ): { ref: WorkspacePathRef; sha256: string } {
    const reader = this.requireReader(instanceId);
    const main = reader.documents.find((document) => document.role === 'main');
    if (!main?.parsedDocument) throw new Error('缺少主论文解析根，不能保存检查点');
    const payload = {
      schemaVersion: 2, id: `checkpoint-${unit.id}`, instanceId, unitId: unit.id, stage: unit.stage,
      inputHash: unit.inputHash, dependencyHashes: unit.dependencyHashes, generationIds, usage,
      createdAt: new Date().toISOString(), value,
    };
    const digest = hashJson(payload);
    const path = `${paperReaderStateBase(instanceId)}/checkpoints/${unit.stage}/${unit.id}-${digest}.json`;
    const rootId = 'project';
    const root = this.#resolveRoot(rootId, 'write');
    const absolute = new PathGuard(root).resolveForWrite(path);
    if (!existsSync(absolute)) atomicWriteJson(absolute, payload);
    const sha256 = sha256FileSync(absolute);
    if (sha256 !== createHash('sha256').update(readFileSync(absolute)).digest('hex')) throw new Error('检查点哈希校验失败');
    return { ref: { rootId, path }, sha256 };
  }

  private persistAnalysis(instanceId: string, analysis: PaperReaderAnalysisV2): { ref: WorkspacePathRef; sha256: string } | undefined {
    const reader = this.#readers.get(instanceId);
    const main = reader?.documents.find((document) => document.role === 'main');
    if (!main?.parsedDocument) return undefined;
    try {
      const digest = hashJson(analysis);
      const path = `${paperReaderStateBase(instanceId)}/state/${digest}.json`;
      const rootId = 'project';
      const root = this.#resolveRoot(rootId, 'write');
      const absolute = new PathGuard(root).resolveForWrite(path);
      if (!existsSync(absolute)) atomicWriteJson(absolute, analysis);
      const sha256 = sha256FileSync(absolute);
      return { ref: { rootId, path }, sha256 };
    } catch {
      // Event persistence remains the durable fallback. A state-file failure
      // must not recursively crash failure handling or the Runtime process.
      return undefined;
    }
  }

  private loadAnalysis(ref: WorkspacePathRef, expectedSha256?: string): PaperReaderAnalysisV2 | undefined {
    try {
      const absolute = new PathGuard(this.#resolveRoot(ref.rootId, 'read')).resolveExisting(ref.path);
      if (expectedSha256 && sha256FileSync(absolute) !== expectedSha256) return undefined;
      const value = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
      if (!isRecord(value) || value.schemaVersion !== 2) return undefined;
      return structuredClone(value) as unknown as PaperReaderAnalysisV2;
    } catch {
      return undefined;
    }
  }

  private activeAuthorization(reader: PaperReaderInstanceV2, modules: PaperReaderModuleV2[]): PaperReaderBatchAuthorizationV2 | undefined {
    const authorization = reader.batchAuthorization;
    if (!authorization || authorization.status !== 'active' || authorization.instanceId !== reader.instanceId
      || authorization.documentSetHash !== reader.documentSetHash || authorization.textModel !== this.#textModel()
      || (authorization.visionModel ?? '') !== (this.#visionModel() ?? '')
      || JSON.stringify(authorization.modules) !== JSON.stringify(modules)
      || authorization.consumed.modelCalls >= authorization.maximum.modelCalls
      || authorization.consumed.totalTokens >= authorization.maximum.totalTokens) return undefined;
    return structuredClone(authorization);
  }

  private requireAuthorization(reader: PaperReaderInstanceV2): PaperReaderBatchAuthorizationV2 {
    const authorization = reader.batchAuthorization;
    if (!authorization || authorization.instanceId !== reader.instanceId || authorization.documentSetHash !== reader.documentSetHash
      || !['active', 'completed'].includes(authorization.status)) throw new Error('全文模型调用缺少本论文文档集合的一次性批量授权');
    return structuredClone(authorization);
  }

  private modelAuthorization(authorization: PaperReaderBatchAuthorizationV2, kind: 'text' | 'vision'): PaperReaderModelAuthorization {
    const model = kind === 'vision' ? authorization.visionModel : authorization.textModel;
    if (!model) throw new Error('首页、图表或公式视觉任务缺少视觉模型授权');
    return {
      id: authorization.id, authorizedAt: authorization.authorizedAt, model,
      maximumTotalTokens: authorization.maximum.totalTokens, completedModelCalls: authorization.consumed.modelCalls,
    };
  }

  private consumeAuthorization(instanceId: string, usage: ModelUsage, generationId: string, actor: EventActor, modelCallCount = 1): PaperReaderBatchAuthorizationV2 {
    const reader = this.requireReader(instanceId);
    const authorization = this.requireAuthorization(reader);
    const calls = Math.max(0, Math.trunc(modelCallCount));
    const consumed = {
      inputTokens: authorization.consumed.inputTokens + Math.max(0, Math.trunc(usage.promptTokens)),
      outputTokens: authorization.consumed.outputTokens + Math.max(0, Math.trunc(usage.completionTokens)),
      totalTokens: authorization.consumed.totalTokens + Math.max(0, Math.trunc(usage.totalTokens || usage.promptTokens + usage.completionTokens)),
      modelCalls: authorization.consumed.modelCalls + calls,
    };
    const exhausted = consumed.modelCalls > authorization.maximum.modelCalls
      || consumed.inputTokens > authorization.maximum.inputTokens
      || consumed.outputTokens > authorization.maximum.outputTokens
      || consumed.totalTokens > authorization.maximum.totalTokens;
    const updated: PaperReaderBatchAuthorizationV2 = { ...authorization, consumed, status: exhausted ? 'exhausted' : authorization.status, updatedAt: new Date().toISOString() };
    this.update(instanceId, { batchAuthorization: updated, modelGenerationIds: [...new Set([...reader.modelGenerationIds, generationId])] }, actor);
    if (exhausted) {
      this.recordAuthorization('paper-reader.v2_batch_exhausted', this.requireReader(instanceId), updated, actor);
      throw new Error(`全文任务达到用户确认的硬上限（${consumed.modelCalls}/${updated.maximum.modelCalls} 次；${consumed.totalTokens}/${updated.maximum.totalTokens} token）`);
    }
    return updated;
  }

  private consumeFailedModelCall(instanceId: string, error: unknown, actor: EventActor): void {
    if (!error || typeof error !== 'object') return;
    const value = error as { generationId?: unknown; usage?: unknown; modelCallCount?: unknown };
    if (typeof value.generationId !== 'string' || !value.usage || typeof value.usage !== 'object') return;
    this.consumeAuthorization(instanceId, value.usage as ModelUsage, value.generationId, actor, typeof value.modelCallCount === 'number' ? value.modelCallCount : 1);
  }

  private completeAuthorization(reader: PaperReaderInstanceV2, actor: EventActor): PaperReaderBatchAuthorizationV2 {
    const authorization = this.requireAuthorization(reader);
    const completed: PaperReaderBatchAuthorizationV2 = { ...authorization, status: 'completed', updatedAt: new Date().toISOString() };
    this.recordAuthorization('paper-reader.v2_batch_completed', reader, completed, actor);
    return completed;
  }

  private recordAuthorization(kind: string, reader: PaperReaderInstanceV2, authorization: PaperReaderBatchAuthorizationV2, actor: EventActor): void {
    this.#events.append({
      streamId: `project:${this.#projectId}`, kind, actor, revision: reader.generationVersion,
      idempotencyKey: `${kind}:${authorization.id}:${authorization.updatedAt}`,
      provenanceRefs: [reader.instanceId, reader.documentSetHash, authorization.id], payload: toJson({ instanceId: reader.instanceId, authorization }),
    });
  }

  private assetRef(document: PaperDocumentV2, figure: ParsedFigure): { ref: WorkspacePathRef; sha256: string; mediaType: string } | undefined {
    return this.imageAssetRef(document, figure.imagePath);
  }

  private profileAssetRef(document: PaperDocumentV2, parsed: ParsedReaderDocument): { ref: WorkspacePathRef; sha256: string; mediaType: string } | undefined {
    return this.imageAssetRef(document, parsed.paper.profileImagePath);
  }

  private imageAssetRef(document: PaperDocumentV2, imagePath: string | undefined): { ref: WorkspacePathRef; sha256: string; mediaType: string } | undefined {
    if (!document.parsedDocument || !imagePath) return undefined;
    const fileName = basename(imagePath);
    const base = dirname(document.parsedDocument.path).replaceAll('\\', '/');
    const path = `${base === '.' ? '' : `${base}/`}assets/${fileName}`;
    try {
      const absolute = new PathGuard(this.#resolveRoot(document.parsedDocument.rootId, 'read')).resolveExisting(path);
      return { ref: { rootId: document.parsedDocument.rootId, path }, sha256: sha256FileSync(absolute), mediaType: 'image/png' };
    } catch {
      return undefined;
    }
  }

  private anchorForCompositeBlock(instanceId: string, compositeId: string, actor: EventActor): EvidenceAnchorV2 {
    const reader = this.requireReader(instanceId);
    const document = reader.documents.find((candidate) => compositeId.startsWith(`${candidate.id}:`));
    if (!document) throw new Error(`来源块所属文档不存在：${compositeId}`);
    const parsed = this.readParsed(document.parsedDocument);
    const block = parsed?.blocks.find((candidate) => candidate.id === rawBlockId(compositeId));
    if (!parsed || !block) throw new Error(`来源块不存在：${compositeId}`);
    const sourceKind = block.type === 'formula' ? 'formula' as const : 'block' as const;
    const canonicalUri = `paper:${reader.paperId}/document:${document.id}/revision:${document.revision.sha256}/page:${block.page}/${sourceKind}:${block.id}`;
    return this.#kernel.createPaperAnchor({
      paperId: reader.paperId, documentId: document.id, revisionHash: document.revision.sha256, canonicalUri, sourceKind,
      target: document.revision, page: block.page, blockId: block.id, selector: selectorForBlock(parsed, block), exact: blockText(block),
      ...(block.type === 'formula' ? { asset: { kind: 'formula' as const, id: block.refs?.[0] ?? block.id } } : {}),
    }, actor, `paper-reader:v2:${instanceId}:${document.id}:block:${block.id}:${parsed.parserVersion}:${block.stableId ?? hashJson([block.page, block.bbox, blockText(block)])}`);
  }

  private anchorForFigure(instanceId: string, document: PaperDocumentV2, parsed: ParsedReaderDocument, figure: ParsedFigure, actor: EventActor): EvidenceAnchorV2 {
    const reader = this.requireReader(instanceId);
    const kind = figureKind(figure);
    const sourceKind = kind === 'formula' ? 'formula' : kind;
    const canonicalUri = `paper:${reader.paperId}/document:${document.id}/revision:${document.revision.sha256}/page:${figure.page}/${sourceKind}:${figure.id}`;
    return this.#kernel.createPaperAnchor({
      paperId: reader.paperId, documentId: document.id, revisionHash: document.revision.sha256, canonicalUri, sourceKind,
      target: document.revision, page: figure.page, selector: selectorForFigure(parsed, figure),
      ...(figure.originalCaption ? { exact: figure.originalCaption } : {}),
      asset: { kind: sourceKind, id: figure.id },
    }, actor, `paper-reader:v2:${instanceId}:${document.id}:${sourceKind}:${figure.id}:${parsed.parserVersion}:${hashJson([figure.page, figure.bbox, figure.originalCaption])}`);
  }

  private anchorIdsForDraft(instanceId: string, draft: Pick<PaperReaderStatementDraft, 'blockIds'>, actor: EventActor): string[] {
    return [...new Set(draft.blockIds.map((id) => this.anchorForCompositeBlock(instanceId, id, actor).id))];
  }

  private materializeQuantity(instanceId: string, draft: PaperReaderQuantityDraft, actor: EventActor) {
    return {
      value: draft.value, ...(draft.unit ? { unit: draft.unit } : {}), ...(draft.condition ? { condition: draft.condition } : {}),
      ...(draft.comparator ? { comparator: draft.comparator } : {}), evidenceAnchorIds: this.anchorIdsForDraft(instanceId, draft, actor),
    };
  }

  private materializeStatement(instanceId: string, draft: PaperReaderStatementDraft, actor: EventActor): PaperReaderStatementV2 {
    return {
      id: randomUUID(), text: draft.text, type: draft.type, confidence: draft.confidence,
      evidenceAnchorIds: this.anchorIdsForDraft(instanceId, draft, actor),
      quantities: draft.quantities.map((quantity) => this.materializeQuantity(instanceId, quantity, actor)),
    };
  }

  private allCompositeSourceBlocks(instanceId: string) {
    return this.documentContexts(this.requireReader(instanceId)).flatMap((context) => context.parsed ? compositeBlocks(context.document, substantiveBlocks(context.parsed)) : []);
  }

  private buildReport(reader: PaperReaderInstanceV2, analysis: PaperReaderAnalysisV2): FineReadingReportV2 {
    const claim = analysis.claimEvidence ?? { evidenceChain: [], mechanism: [], keyResults: [], contributions: [], limitations: [], unproven: [] };
    const reproduction = analysis.reproduction ?? { materials: [], preparation: [], instruments: [], parameters: [], controls: [], statistics: [], conditions: [], missingInformation: [] };
    const synthesis = analysis.synthesis ?? { thesis: [], researchQuestion: [], strategy: [], researchImplications: [], presentationBrief: [], directionOutput: [] };
    const provisional: FineReadingReportV2 = {
      schema: 'openscientific.fine-reading-report/2', paperId: reader.paperId, documentSetHash: reader.documentSetHash,
      documentProfiles: analysis.documentProfiles,
      thesis: synthesis.thesis, researchQuestion: synthesis.researchQuestion, strategy: synthesis.strategy,
      evidenceChain: claim.evidenceChain, mechanism: claim.mechanism, keyResults: claim.keyResults,
      contributions: claim.contributions, limitations: claim.limitations, unproven: claim.unproven,
      reproduction, figures: analysis.figureAnalyses, formulas: analysis.formulaAnalyses,
      researchImplications: synthesis.researchImplications, presentationBrief: synthesis.presentationBrief,
      coverage: {
        documentProfileCount: 0, verifiedDocumentProfileCount: 0,
        substantiveBlockCount: 0, digestedBlockCount: 0, translatedBlockCount: 0,
        mainVisualCount: 0, verifiedMainVisualCount: 0, referencedSupplementaryVisualCount: 0, analyzedSupplementaryVisualCount: 0,
        formulaCount: 0, analyzedFormulaCount: 0,
      },
      quality: {
        status: 'failed', schemaValid: false, anchorsValid: false, quantitiesValid: false,
        documentProfileComplete: false,
        textCoverageComplete: false, translationCoverageComplete: false, visualCoverageComplete: false, formulaCoverageComplete: false, issues: [],
      },
      directionOutput: synthesis.directionOutput, sectionDigests: analysis.sectionDigests, generatedAt: new Date().toISOString(),
    };
    const contexts = this.documentContexts(reader).filter((context): context is { document: PaperDocumentV2; parsed: ParsedReaderDocument } => context.parsed !== null);
    const substantiveIds = contexts.flatMap((context) => substantiveBlocks(context.parsed).map((block) => blockKey(context.document.id, block.id)));
    const digestIds = analysis.sectionDigests.flatMap((digest) => digest.blockIds);
    const digestCounts = new Map<string, number>();
    for (const id of digestIds) digestCounts.set(id, (digestCounts.get(id) ?? 0) + 1);
    const mainVisuals = this.selectedVisuals(reader.instanceId).filter((item) => item.document.role === 'main');
    const supplementaryVisuals = this.selectedVisuals(reader.instanceId).filter((item) => item.document.role === 'supplementary');
    const formulaIds = contexts.flatMap((context) => context.parsed.blocks.filter((block) => block.type === 'formula').map((block) => `${context.document.id}:${block.refs?.find((ref) => /^(?:E|EQ)/iu.test(ref)) ?? block.id}`));
    provisional.coverage = {
      documentProfileCount: 1,
      verifiedDocumentProfileCount: analysis.documentProfiles.filter((item) => item.documentId === reader.documents.find((document) => document.role === 'main')?.id && item.status === 'verified').length,
      substantiveBlockCount: substantiveIds.length,
      digestedBlockCount: substantiveIds.filter((id) => digestCounts.get(id) === 1).length,
      translatedBlockCount: substantiveIds.filter((id) => Boolean(analysis.translations[id])).length,
      mainVisualCount: mainVisuals.length,
      verifiedMainVisualCount: mainVisuals.filter((visual) => analysis.figureAnalyses.some((item) => item.documentId === visual.document.id && item.figureId === visual.figure.id && item.status === 'verified')).length,
      referencedSupplementaryVisualCount: supplementaryVisuals.length,
      analyzedSupplementaryVisualCount: supplementaryVisuals.filter((visual) => analysis.figureAnalyses.some((item) => item.documentId === visual.document.id && item.figureId === visual.figure.id && item.status === 'verified')).length,
      formulaCount: formulaIds.length,
      analyzedFormulaCount: formulaIds.filter((id) => analysis.formulaAnalyses.some((item) => `${item.documentId}:${item.formulaId}` === id && item.status === 'verified')).length,
    };
    provisional.quality = this.evaluateQuality(provisional, substantiveIds, digestCounts);
    return provisional;
  }

  private evaluateQuality(report: FineReadingReportV2, substantiveIds: string[], digestCounts: Map<string, number>): PaperReaderQualityV2 {
    const issues: string[] = [];
    const schemaValid = Boolean(report.thesis.length || report.researchQuestion.length)
      && Boolean(report.evidenceChain.length || report.keyResults.length) && Boolean(report.reproduction);
    if (!schemaValid) issues.push('综合报告缺少研究问题、论点或证据链');
    const statements = this.allReportStatements(report);
    let anchorsValid = statements.length > 0 && statements.every((statement) => statement.evidenceAnchorIds.length > 0);
    if (anchorsValid) {
      try { for (const statement of statements) for (const id of statement.evidenceAnchorIds) this.#kernel.anchor(id); }
      catch { anchorsValid = false; }
    }
    if (!anchorsValid) issues.push('存在无有效 EvidenceAnchor 的模型陈述');
    let quantitiesValid = true;
    const quantities = [
      ...statements.flatMap((statement) => statement.quantities),
      ...report.figures.flatMap((figure) => figure.quantitativeResults),
    ];
    for (const quantity of quantities) {
      if (quantity.evidenceAnchorIds.length === 0 || !quantity.value.trim()) { quantitiesValid = false; continue; }
      const normalizedValue = quantity.value.replace(/\s+/gu, '').toLocaleLowerCase();
      const normalizedUnit = quantity.unit?.replace(/\s+/gu, '').toLocaleLowerCase();
      const supported = quantity.evidenceAnchorIds.some((id) => {
        const exact = (this.#kernel.anchor(id).exact ?? '').replace(/\s+/gu, '').toLocaleLowerCase();
        return exact.includes(normalizedValue) && (!normalizedUnit || exact.includes(normalizedUnit));
      });
      if (!supported) quantitiesValid = false;
    }
    if (!quantitiesValid) issues.push('存在无法在锚定原文中核对的数字或单位');
    const documentProfileComplete = report.coverage.verifiedDocumentProfileCount === report.coverage.documentProfileCount;
    if (!documentProfileComplete) issues.push('论文首页标题与书目信息尚未通过整页视觉核验');
    const textCoverageComplete = substantiveIds.length > 0 && substantiveIds.every((id) => digestCounts.get(id) === 1)
      && [...digestCounts].every(([id, count]) => substantiveIds.includes(id) && count === 1);
    if (!textCoverageComplete) issues.push('实质正文块未做到恰好一次逐节精读覆盖');
    const translationCoverageComplete = report.coverage.translatedBlockCount === report.coverage.substantiveBlockCount;
    if (!translationCoverageComplete) issues.push('全文双语翻译覆盖不完整');
    const visualCoverageComplete = report.coverage.verifiedMainVisualCount === report.coverage.mainVisualCount
      && report.coverage.analyzedSupplementaryVisualCount === report.coverage.referencedSupplementaryVisualCount;
    if (!visualCoverageComplete) issues.push('主文或被引用 SI 图表仍有 needs_review / failed');
    const formulaCoverageComplete = report.coverage.analyzedFormulaCount === report.coverage.formulaCount;
    if (!formulaCoverageComplete) issues.push('公式语义分析覆盖不完整');
    const fatal = !schemaValid || !anchorsValid || !quantitiesValid || !textCoverageComplete || !translationCoverageComplete;
    return {
      status: fatal ? 'failed' : documentProfileComplete && visualCoverageComplete && formulaCoverageComplete ? 'complete' : 'incomplete',
      schemaValid, anchorsValid, quantitiesValid, documentProfileComplete, textCoverageComplete, translationCoverageComplete, visualCoverageComplete, formulaCoverageComplete, issues,
    };
  }

  private allReportStatements(report: FineReadingReportV2): PaperReaderStatementV2[] {
    return [
      ...report.thesis, ...report.researchQuestion, ...report.strategy, ...report.evidenceChain, ...report.mechanism,
      ...report.keyResults, ...report.contributions, ...report.limitations, ...report.unproven, ...report.researchImplications, ...report.directionOutput,
      ...Object.values(report.reproduction).flat(), ...report.sectionDigests.flatMap((digest) => digest.summary),
      ...report.figures.flatMap((figure) => [...figure.authorInterpretation, ...figure.independentJudgment, ...figure.limitations]),
    ];
  }

  private buildArtifactBundle(reader: PaperReaderInstanceV2, analysis: PaperReaderAnalysisV2, report: FineReadingReportV2): { markdown: string; files: CreateArtifactRevisionFileInput[] } {
    const contexts = this.documentContexts(reader).filter((context): context is { document: PaperDocumentV2; parsed: ParsedReaderDocument } => context.parsed !== null);
    const assetNames = new Map<string, string>();
    const assetFiles: CreateArtifactRevisionFileInput[] = [];
    for (const context of contexts) for (const figure of context.parsed.figures) {
      const asset = this.assetRef(context.document, figure);
      if (!asset) continue;
      const name = `assets/${context.document.id}/${basename(asset.ref.path)}`;
      assetNames.set(`${context.document.id}:${figure.id}`, name);
      assetFiles.push({ role: 'output', name, ref: asset.ref, mediaType: asset.mediaType });
    }
    for (const context of contexts.filter((item) => item.document.role === 'main')) {
      const asset = this.profileAssetRef(context.document, context.parsed);
      if (asset) assetFiles.push({ role: 'output', name: `assets/${context.document.id}/title-page.png`, ref: asset.ref, mediaType: asset.mediaType });
    }
    const markdown = this.paperMarkdown(reader, analysis, report, assetNames);
    const visualProfile = analysis.documentProfiles.find((item) => item.documentId === contexts.find((context) => context.document.role === 'main')?.document.id);
    const sourceMap = {
      schemaVersion: 2,
      paper: { id: reader.paperId, title: visualProfile?.title ?? contexts.find((context) => context.document.role === 'main')?.parsed.paper.title ?? '', source_type: 'pdf', language: 'en', documentSetHash: reader.documentSetHash },
      documents: contexts.map((context) => ({ id: context.document.id, role: context.document.role, label: context.document.label, revision: context.document.revision.sha256, pages: context.parsed.pages })),
      blocks: contexts.flatMap((context) => context.parsed.blocks.map((block) => ({
        id: blockKey(context.document.id, block.id), documentId: context.document.id, page: block.page, type: block.type, order: block.order,
        original_text: block.originalText, translation: analysis.translations[blockKey(context.document.id, block.id)] ?? '', bbox: block.bbox ?? [], confidence: block.confidence ?? 'medium', refs: block.refs ?? [],
      }))),
      figures: contexts.flatMap((context) => context.parsed.figures.map((figure) => ({
        id: figure.id, documentId: context.document.id, page: figure.page, kind: figureKind(figure), caption_id: figure.captionId ?? null,
        image_path: assetNames.get(`${context.document.id}:${figure.id}`) ?? '', bbox: figure.bbox ?? [], placed_after: figure.placedAfter ?? null, approximate: figure.approximate === true,
      }))),
      glossary: analysis.terms.map((term) => ({ term: term.source, translation: term.translation, note: term.note, frozen: term.frozen })),
    };
    const missingTranslations = contexts.flatMap((context) => substantiveBlocks(context.parsed).map((block) => blockKey(context.document.id, block.id))).filter((id) => !analysis.translations[id]);
    const notes = [
      '# Translation notes', '', `- 文档集合：\`${reader.documentSetHash}\``, `- 质量状态：${report.quality.status}`,
      `- 未翻译来源块：${missingTranslations.length ? missingTranslations.join('、') : '无'}`,
      ...contexts.flatMap((context) => context.parsed.warnings.map((warning) => `- ${context.document.label}: ${warning}`)),
      ...report.quality.issues.map((issue) => `- 质量门：${issue}`), '', '## Terminology ledger', '',
      '| Canonical term | 中文 | Note | Frozen |', '|---|---|---|---|',
      ...analysis.terms.map((term) => `| ${term.source.replaceAll('|', '\\|')} | ${term.translation.replaceAll('|', '\\|')} | ${term.note.replaceAll('|', '\\|')} | ${term.frozen ? 'yes' : 'no'} |`), '',
    ].join('\n');
    const inline = (name: string, value: string, mediaType: string, role: CreateArtifactRevisionFileInput['role'] = 'output'): CreateArtifactRevisionFileInput => ({ role, name, content: value, mediaType });
    const payloadFiles: CreateArtifactRevisionFileInput[] = [
      inline('paper.md', markdown, 'text/markdown'), inline('source_map.json', JSON.stringify(sourceMap, null, 2), 'application/json', 'mapping'),
      inline('translation_notes.md', notes, 'text/markdown'), inline('deep_reading.json', JSON.stringify(report, null, 2), 'application/json'),
      inline('figure_analyses.json', JSON.stringify(report.figures, null, 2), 'application/json'), inline('formula_analyses.json', JSON.stringify(report.formulas, null, 2), 'application/json'),
      inline('deep_reading_quality.json', JSON.stringify({ coverage: report.coverage, quality: report.quality }, null, 2), 'application/json'),
      ...contexts.map((context) => ({ role: 'mapping' as const, name: `parsed/${context.document.id}/reader_document.json`, ref: context.document.parsedDocument!, mediaType: 'application/json' })),
      ...assetFiles,
    ];
    const fileHashes = Object.fromEntries(payloadFiles.map((file) => {
      if (file.content !== undefined) return [file.name, createHash('sha256').update(file.content, 'utf8').digest('hex')];
      if (!file.ref) throw new Error(`原子产物文件缺少内容或引用：${file.name}`);
      const absolute = new PathGuard(this.#resolveRoot(file.ref.rootId, 'read')).resolveExisting(file.ref.path);
      return [file.name, sha256FileSync(absolute)];
    }));
    const manifest = {
      schemaVersion: 2, plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION }, paperId: reader.paperId, documentSetHash: reader.documentSetHash,
      models: { text: reader.batchAuthorization?.textModel, vision: reader.batchAuthorization?.visionModel },
      generationIds: reader.modelGenerationIds, units: reader.pipeline.units.map((unit) => ({ id: unit.id, stage: unit.stage, inputHash: unit.inputHash, dependencyHashes: unit.dependencyHashes, outputSha256: unit.outputSha256, generationIds: unit.generationIds, usage: unit.usage })),
      fileHashes,
      manifestHashRecordedBy: 'ArtifactRevisionStore',
      quality: report.quality,
    };
    const files: CreateArtifactRevisionFileInput[] = [...payloadFiles, inline('generation_manifest.json', JSON.stringify(manifest, null, 2), 'application/json', 'mapping')];
    return { markdown, files };
  }

  private paperMarkdown(reader: PaperReaderInstanceV2, analysis: PaperReaderAnalysisV2, report: FineReadingReportV2, assetNames: Map<string, string>): string {
    const contexts = this.documentContexts(reader).filter((context): context is { document: PaperDocumentV2; parsed: ParsedReaderDocument } => context.parsed !== null);
    const mainDocumentId = contexts.find((context) => context.document.role === 'main')?.document.id;
    const profile = analysis.documentProfiles.find((item) => item.documentId === mainDocumentId);
    const lines: string[] = [
      `# ${profile?.title ?? contexts.find((context) => context.document.role === 'main')?.parsed.paper.title ?? '论文精读'}`, '',
      ...(profile?.authors.length ? [`**作者：** ${profile.authors.join('、')}`, ''] : []),
      `**质量状态：** ${report.quality.status}`, '',
      '## 文档索引', '',
      ...contexts.flatMap((context) => [`- ${context.document.role === 'main' ? '主文' : '补充信息'}：${context.document.label}（${context.parsed.paper.pageCount} 页）`]), '',
      '## 术语账本', '', '| Canonical term | 中文 | 说明 |', '|---|---|---|',
      ...analysis.terms.map((term) => `| ${term.source.replaceAll('|', '\\|')} | ${term.translation.replaceAll('|', '\\|')} | ${term.note.replaceAll('|', '\\|')} |`), '',
    ];
    for (const context of contexts) {
      lines.push(`# ${context.document.role === 'main' ? '主论文' : '补充材料'}：${context.document.label}`, '');
      const figuresByPlacement = new Map<string, ParsedFigure[]>();
      for (const figure of context.parsed.figures) {
        const key = figure.placedAfter ?? '__end__';
        figuresByPlacement.set(key, [...(figuresByPlacement.get(key) ?? []), figure]);
      }
      const renderFigure = (figure: ParsedFigure) => {
        const composite = `${context.document.id}:${figure.id}`;
        const asset = assetNames.get(composite);
        const result = report.figures.find((item) => item.documentId === context.document.id && item.figureId === figure.id);
        const captionTranslation = figure.captionId ? analysis.translations[blockKey(context.document.id, figure.captionId)] : undefined;
        const visualLabel = figureKind(figure) === 'table' ? '数据表' : figureKind(figure) === 'formula' ? '公式' : '科研图';
        lines.push(`<a id="${composite.replace(/[^a-zA-Z0-9_-]/gu, '-')}"></a>`, `### ${figure.altText ?? visualLabel}`, '',
          `**原文位置：** 第 ${figure.page} 页`, '');
        if (asset) lines.push(`![${figure.altText ?? figure.id}](${asset})`, '');
        else lines.push('> 图表裁剪文件缺失；请查看原始 PDF。', '');
        lines.push(`**Original caption:** ${figure.originalCaption ?? '（无可提取图注）'}`, '', `**中文图注:** ${captionTranslation ?? '（未提取图注译文）'}`, '',
          `**Reading note:** ${result?.purpose ?? (figureKind(figure) === 'formula' ? '公式原图，语义分析见报告。' : '视觉分析未完成。')}`, '');
      };
      for (const block of substantiveBlocks(context.parsed)) {
        const id = blockKey(context.document.id, block.id);
        if (block.type === 'heading') lines.push(`## ${blockText(block)}`, '');
        lines.push(`<a id="${id.replace(/[^a-zA-Z0-9_-]/gu, '-')}"></a>`, `**原文位置：** 第 ${block.page} 页`, '',
          `**Original:** ${block.originalText}`, '', `**中文:** ${analysis.translations[id] ?? '（待翻译）'}`, '');
        for (const figure of figuresByPlacement.get(block.id) ?? []) renderFigure(figure);
      }
      for (const figure of figuresByPlacement.get('__end__') ?? []) renderFigure(figure);
    }
    lines.push('## 阅读提示与批判性精读', '', ...report.thesis.map((item) => `- ${item.text}（${item.type}；${item.confidence}）`), '',
      '### 局限与未证明事项', '', ...[...report.limitations, ...report.unproven].map((item) => `- ${item.text}`), '',
      '### 质量说明', '', ...report.quality.issues.map((issue) => `- ${issue}`), '');
    return lines.join('\n');
  }

  private failPipeline(instanceId: string, error: unknown, actor: EventActor): void {
    const message = error instanceof Error ? error.message : String(error);
    const current = this.#readers.get(instanceId);
    if (!current) return;
    const status = /UNSUPPORTED_SCANNED_PDF|text layer/iu.test(message) ? 'unsupported_scanned'
      : /cancel|AbortError|interrupted|shutdown|restart|取消/iu.test(message) ? 'interrupted' : 'failed';
    const stage = status === 'unsupported_scanned' ? '扫描型 PDF 暂不支持，请先 OCR 后重新导入'
      : status === 'interrupted' ? '任务已中断，可从检查点继续' : '精读 V2 任务失败';
    this.update(instanceId, { status, stage, error: message.slice(0, 4_000) }, actor);
    if (current.runId) this.#kernel.updateRun(current.runId, { status: status === 'interrupted' ? 'interrupted' : 'failed', stage }, actor);
  }

  private update(
    instanceId: string,
    patch: PaperReaderPatch,
    actor: EventActor,
    analysis?: PaperReaderAnalysisV2,
  ): PaperReaderInstanceV2 {
    const current = this.requireReader(instanceId);
    const { clearError, ...readerPatch } = structuredClone(patch);
    const reader = structuredClone(current);
    for (const [key, value] of Object.entries(readerPatch)) {
      if (value === undefined) delete (reader as unknown as Record<string, unknown>)[key];
      else (reader as unknown as Record<string, unknown>)[key] = value;
    }
    reader.updatedAt = new Date().toISOString();
    if (!Number.isFinite(reader.progress) || reader.progress < 0 || reader.progress > 1) throw new Error('论文精读进度必须在 0–1 之间');
    if (clearError) delete reader.error;
    this.#readers.set(instanceId, reader);
    if (analysis) this.#analysis.set(instanceId, cloneAnalysis(analysis));
    this.record('paper-reader.v2_updated', reader, actor, analysis);
    return structuredClone(reader);
  }

  private record(kind: string, reader: PaperReaderInstanceV2, actor: EventActor, analysis?: PaperReaderAnalysisV2): void {
    const currentAnalysis = analysis ?? this.#analysis.get(reader.instanceId) ?? emptyAnalysis();
    const persisted = this.persistAnalysis(reader.instanceId, currentAnalysis);
    this.#events.append({
      streamId: `project:${this.#projectId}`, kind, actor, revision: reader.generationVersion,
      idempotencyKey: `${kind}:${reader.instanceId}:${reader.updatedAt}:${randomUUID()}`,
      provenanceRefs: [reader.instanceId, reader.documentSetHash, ...reader.documents.map((document) => document.revision.sha256), ...(reader.reportArtifact ? [reader.reportArtifact.revisionId] : [])],
      payload: toJson({ reader, ...(persisted ? { analysisRef: persisted.ref, analysisSha256: persisted.sha256 } : { analysis: currentAnalysis }) }),
    });
    this.#onChanged();
  }

  private requireReader(instanceId: string): PaperReaderInstanceV2 {
    const reader = this.#readers.get(instanceId);
    if (!reader) throw new Error('论文精读实例不存在');
    return reader;
  }

  private markInterruptedRuns(): void {
    for (const [id, current] of this.#readers) {
      if (!['inspecting', 'parsing', 'analyzing'].includes(current.status)) continue;
      this.#readers.set(id, { ...current, status: 'interrupted', stage: 'Runtime 重启，任务可从检查点继续', error: 'runtime_restart', updatedAt: new Date().toISOString() });
    }
  }

  private legacyReader(value: PaperReaderInstanceV1): PaperReaderInstanceV2 {
    if (!value.mainDocument) throw new Error('旧版论文精读实例缺少主论文');
    const paperId = `paper-${value.mainDocument.sha256.slice(0, 24)}`;
    const documents: PaperDocumentV2[] = [{
      schemaVersion: 2, id: `main-${value.mainDocument.sha256.slice(0, 16)}`, paperId, role: 'main', label: '主论文', revision: value.mainDocument,
      ...(value.parsedDocument ? { parsedDocument: value.parsedDocument } : {}),
      parseState: value.parsedDocument ? 'ready' : 'pending', warnings: [],
      ...(value.inspectedPageCount === undefined ? {} : { pageCount: value.inspectedPageCount }),
      ...(value.inspectedTextCharacters === undefined ? {} : { textCharacters: value.inspectedTextCharacters }),
      blockCount: value.blockCount, figureCount: value.figureCount,
    }];
    if (value.supportingDocument) documents.push({
      schemaVersion: 2, id: `si-${value.supportingDocument.sha256.slice(0, 16)}-1`, paperId, role: 'supplementary', label: '补充材料 1', revision: value.supportingDocument,
      ...(value.supportingParsedDocument ? { parsedDocument: value.supportingParsedDocument } : {}),
      parseState: value.supportingParsedDocument ? 'ready' : 'pending', warnings: [],
      ...(value.supportingInspectedPageCount === undefined ? {} : { pageCount: value.supportingInspectedPageCount }),
      ...(value.supportingInspectedTextCharacters === undefined ? {} : { textCharacters: value.supportingInspectedTextCharacters }),
    });
    const main = documents[0]!; const supplement = documents[1];
    return {
      schemaVersion: 2, instanceId: value.instanceId, projectId: value.projectId, paperId, documents, documentSetHash: documentSetHash(documents),
      status: ['inspecting', 'parsing', 'analyzing'].includes(value.status) ? 'interrupted' : value.status,
      stage: value.status === 'completed' ? '旧版 V1 报告（只读）；新运行将使用 V2' : value.stage, progress: value.progress,
      pipeline: { stage: 'document-profile', totalUnits: 0, completedUnits: 0, failedUnits: 0, units: [] },
      ...(value.runId ? { runId: value.runId } : {}),
      ...(value.reportArtifact ? { reportArtifact: value.reportArtifact } : {}),
      modelGenerationIds: value.modelGenerationIds ?? [], evidenceAnchorIds: value.evidenceAnchorIds,
      generationVersion: value.generationVersion, autoFollow: value.autoFollow,
      ...(value.activeBlockId ? { activeBlockId: value.activeBlockId } : {}),
      ...(value.error ? { error: value.error } : {}),
      createdAt: value.createdAt, updatedAt: value.updatedAt,
      mainDocument: main.revision,
      ...(main.parsedDocument ? { parsedDocument: main.parsedDocument } : {}),
      ...(supplement ? {
        supportingDocument: supplement.revision,
        ...(supplement.parsedDocument ? { supportingParsedDocument: supplement.parsedDocument } : {}),
      } : {}),
      blockCount: value.blockCount, figureCount: value.figureCount, conclusionCount: value.conclusionCount, termCount: value.termCount,
      translationBlockCount: value.translationBlockCount ?? value.blockCount, translatedBlockCount: value.translatedBlockCount ?? 0,
      ...(value.inspectedTextCharacters === undefined ? {} : { inspectedTextCharacters: value.inspectedTextCharacters }),
      ...(value.inspectedPageCount === undefined ? {} : { inspectedPageCount: value.inspectedPageCount }),
    };
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (!event.kind.startsWith('paper-reader.')) continue;
      const payload = event.payload as unknown as PaperReaderEventPayload;
      if (!payload.reader?.instanceId) continue;
      const reader = payload.reader.schemaVersion === 2 ? structuredClone(payload.reader) : this.legacyReader(payload.reader);
      this.#readers.set(reader.instanceId, reader);
      const analysis = payload.analysisRef ? this.loadAnalysis(payload.analysisRef, payload.analysisSha256) : undefined;
      if (analysis) this.#analysis.set(reader.instanceId, analysis);
      else if (payload.analysis !== undefined) this.#analysis.set(reader.instanceId, normalizeLegacyAnalysis(payload.analysis));
      else if (!this.#analysis.has(reader.instanceId)) this.#analysis.set(reader.instanceId, emptyAnalysis());
    }
  }
}
