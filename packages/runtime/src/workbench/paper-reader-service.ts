import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  ArtifactRevisionRef,
  DocumentRevisionRef,
  EventActor,
  EvidenceAnchorV1,
  JobRecord,
  JsonValue,
  ModelUsage,
  PaperReaderBatchAuthorizationV1,
  PaperReaderInstanceV1,
  WorktableInstance,
  WorkspacePathRef,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { PathGuard } from '../security/path-guard.js';
import { isRecord, toJson } from '../util/json.js';
import { sha256FileSync } from './file-hash.js';
import type { JobService } from './job-service.js';
import type { ScientificKernelStore } from './scientific-kernel-store.js';

const PLUGIN_ID = 'sci.paper-reader';
const TOOLCHAIN_ID = 'openlab.reader-runtime';
const MAX_CONTEXT_BYTES = 12 * 1024 * 1024;
const TRANSLATION_CHUNK_BLOCKS = 24;
const TRANSLATION_CHUNK_CHARACTERS = 16_000;

interface ParsedBlock {
  id: string;
  stableId?: string;
  page: number;
  type: string;
  order: number;
  originalText: string;
  bbox?: number[];
  confidence?: string;
  refs?: string[];
}

interface ParsedFigure {
  id: string;
  page: number;
  captionId?: string;
  captionBlockIds?: string[];
  bbox?: number[];
  placedAfter?: string;
  altText?: string;
  originalCaption?: string;
  approximate?: boolean;
}

interface ParsedReaderDocument {
  parser: string;
  parserVersion: string;
  paper: {
    title: string;
    pageCount: number;
    language?: string;
    textCharacters?: number;
    hasTextLayer?: boolean;
  };
  blocks: ParsedBlock[];
  figures: ParsedFigure[];
  pages: Array<{ page: number; blockIds: string[] }>;
  warnings: string[];
  revisionHash: string;
}

interface PaperTerm {
  id: string;
  source: string;
  translation: string;
  frozen: boolean;
}

interface PaperConclusion {
  id: string;
  category: 'research-question' | 'method' | 'claim-evidence' | 'key-result' | 'figure-formula' | 'reproduction' | 'contribution' | 'limitation' | 'unproven';
  title: string;
  content: string;
  evidenceAnchorIds: string[];
  blockIds: string[];
  confidence: 'high' | 'medium' | 'low';
  generationVersion: number;
  generationId?: string;
}

interface PaperQuestion {
  id: string;
  question: string;
  answer: string;
  evidenceAnchorIds: string[];
  blockIds: string[];
  createdAt: string;
}

interface PaperReaderAnalysis {
  terms: PaperTerm[];
  translations: Record<string, string>;
  translationRuns: Record<string, { generationId: string; createdAt: string }>;
  conclusions: PaperConclusion[];
  questions: PaperQuestion[];
}

interface PaperReaderEventPayload {
  reader?: PaperReaderInstanceV1;
  analysis?: PaperReaderAnalysis;
}

interface ReaderInputFile {
  rootId: string;
  path: string;
  sha256: string;
  mediaType?: string;
}

export interface PaperReaderPanelContext {
  reader: PaperReaderInstanceV1;
  document: DocumentRevisionRef | null;
  supportingDocument: DocumentRevisionRef | null;
  parsed: ParsedReaderDocument | null;
  supportingParsed: ParsedReaderDocument | null;
  analysis: PaperReaderAnalysis;
  anchors: EvidenceAnchorV1[];
  jobs: JobRecord[];
  reveal: JsonValue;
  toolchainAvailable: boolean;
  callPreview: PaperReaderCallPreview;
  allowedTools: string[];
}

export interface PaperReaderCallPreview {
  ready: boolean;
  parseCalls: number;
  modelCalls: number;
  model: string;
  fullTextBlocks: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  maximumTotalTokens: number;
  note: string;
}

export interface PaperReaderModelAuthorization {
  id: string;
  authorizedAt: string;
  model: string;
  maximumTotalTokens: number;
}

export interface PaperReaderModelConclusion {
  category: PaperConclusion['category'];
  title: string;
  content: string;
  blockIds: string[];
  confidence: PaperConclusion['confidence'];
}

export interface PaperReaderModelAnalysis {
  generationId: string;
  usage: ModelUsage;
  modelCallCount?: number;
  conclusions: PaperReaderModelConclusion[];
  terms: Array<{ source: string; translation: string }>;
}

function documentFromInput(value: unknown, label: string): DocumentRevisionRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || typeof value.rootId !== 'string' || typeof value.path !== 'string' || typeof value.sha256 !== 'string') {
    throw new Error(`${label}不是有效的不可变文档修订`);
  }
  if (!/^[a-f0-9]{64}$/u.test(value.sha256)) throw new Error(`${label}缺少有效 SHA-256`);
  const mediaType = typeof value.mediaType === 'string' ? value.mediaType : 'application/pdf';
  if (mediaType !== 'application/pdf' && !value.path.toLocaleLowerCase().endsWith('.pdf')) throw new Error(`${label}必须是 PDF`);
  return { ref: { rootId: value.rootId, path: value.path }, sha256: value.sha256, mediaType: 'application/pdf' };
}

function firstSupportingDocument(value: unknown): DocumentRevisionRef | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return documentFromInput(value[0], '补充材料');
}

function cloneAnalysis(value?: PaperReaderAnalysis): PaperReaderAnalysis {
  if (!value) return { terms: [], translations: {}, translationRuns: {}, conclusions: [], questions: [] };
  return { ...structuredClone(value), translationRuns: structuredClone(value.translationRuns ?? {}) };
}

function searchableBlocks(parsed: ParsedReaderDocument): ParsedBlock[] {
  return parsed.blocks.filter((block) =>
    !['running_matter', 'reference', 'front_matter'].includes(block.type)
    && block.originalText.trim().length >= 16,
  );
}

function blockText(block: ParsedBlock): string {
  return block.originalText.replace(/\s+/gu, ' ').trim();
}

function pickBlock(blocks: ParsedBlock[], patterns: RegExp[], fallbackIndex = 0): ParsedBlock | undefined {
  return blocks.find((block) => patterns.some((pattern) => pattern.test(block.originalText))) ?? blocks[fallbackIndex];
}

function termCandidates(blocks: ParsedBlock[]): string[] {
  const counts = new Map<string, number>();
  const pattern = /\b(?:[A-Z][A-Za-z0-9+−-]{2,}|[A-Za-z]+\d+[A-Za-z0-9+−-]*|[A-Z]{2,8})\b/gu;
  for (const block of blocks.slice(0, 800)) {
    for (const match of block.originalText.matchAll(pattern)) {
      const value = match[0]!.trim();
      if (/^(?:The|This|That|Figure|Table|Methods?|Results?|Introduction|Discussion)$/u.test(value)) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 80).map(([term]) => term);
}

function excerpt(text: string, maximum = 420): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function zeroUsage(): ModelUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0 };
}

function translationChunks(blocks: ParsedBlock[]): ParsedBlock[][] {
  const chunks: ParsedBlock[][] = [];
  let current: ParsedBlock[] = [];
  let characters = 0;
  for (const block of blocks) {
    const length = blockText(block).length;
    if (current.length > 0 && (current.length >= TRANSLATION_CHUNK_BLOCKS || characters + length > TRANSLATION_CHUNK_CHARACTERS)) {
      chunks.push(current);
      current = [];
      characters = 0;
    }
    current.push(block);
    characters += length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function markdownReport(parsed: ParsedReaderDocument, analysis: PaperReaderAnalysis): string {
  const categoryLabels: Record<PaperConclusion['category'], string> = {
    'research-question': '研究问题', method: '方法', 'claim-evidence': '主张—证据', 'key-result': '关键结果',
    'figure-formula': '图表与公式', reproduction: '复现', contribution: '贡献', limitation: '局限', unproven: '未证明事项',
  };
  return [
    `# ${parsed.paper.title}`,
    '',
    `- 文档修订：\`${parsed.revisionHash}\``,
    `- 解析器：${parsed.parser} ${parsed.parserVersion}`,
    `- 页数：${parsed.paper.pageCount}`,
    '',
    ...analysis.conclusions.flatMap((item) => [
      `## ${categoryLabels[item.category]}：${item.title}`,
      '',
      item.content,
      '',
      `证据块：${item.blockIds.map((id) => `\`${id}\``).join('、')}；置信度：${item.confidence}`,
      '',
    ]),
    '## 冻结术语',
    '',
    ...analysis.terms.map((term) => `- ${term.source} → ${term.translation || '（待确认）'}${term.frozen ? '（已冻结）' : ''}`),
    '',
  ].join('\n');
}

export class PaperReaderService {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #jobs: JobService;
  readonly #kernel: ScientificKernelStore;
  readonly #resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
  readonly #toolchainAvailable: () => boolean;
  readonly #createReportArtifact: (input: { instanceId: string; title: string; markdown: string; json: string; parsedRef: WorkspacePathRef }, actor: EventActor) => ArtifactRevisionRef;
  readonly #mountReport: (instanceId: string, artifact: ArtifactRevisionRef, title: string, actor: EventActor) => void;
  readonly #model: () => string;
  readonly #translate: (input: {
    instanceId: string;
    document: DocumentRevisionRef;
    blocks: Array<{ id: string; page: number; text: string }>;
    frozenTerms: Array<{ source: string; translation: string }>;
    authorization: PaperReaderModelAuthorization;
  }, actor: EventActor, signal?: AbortSignal) => Promise<{ generationId: string; usage: ModelUsage; modelCallCount?: number; translations: Array<{ blockId: string; text: string }> }>;
  readonly #analyze: (input: {
    instanceId: string;
    document: DocumentRevisionRef;
    blocks: Array<{ id: string; page: number; type: string; text: string }>;
    termCandidates: string[];
    authorization: PaperReaderModelAuthorization;
  }, actor: EventActor, signal?: AbortSignal) => Promise<PaperReaderModelAnalysis>;
  readonly #onChanged: () => void;
  readonly #readers = new Map<string, PaperReaderInstanceV1>();
  readonly #analysis = new Map<string, PaperReaderAnalysis>();
  readonly #pipelines = new Map<string, Promise<void>>();
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: {
    projectId: string;
    events: SqliteEventStore;
    jobs: JobService;
    kernel: ScientificKernelStore;
    resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
    toolchainAvailable: () => boolean;
    createReportArtifact: (input: { instanceId: string; title: string; markdown: string; json: string; parsedRef: WorkspacePathRef }, actor: EventActor) => ArtifactRevisionRef;
    mountReport: (instanceId: string, artifact: ArtifactRevisionRef, title: string, actor: EventActor) => void;
    model: () => string;
    translate: (input: {
      instanceId: string;
      document: DocumentRevisionRef;
      blocks: Array<{ id: string; page: number; text: string }>;
      frozenTerms: Array<{ source: string; translation: string }>;
      authorization: PaperReaderModelAuthorization;
      correction?: { attempt: number; reason: string };
    }, actor: EventActor, signal?: AbortSignal) => Promise<{ generationId: string; usage: ModelUsage; modelCallCount?: number; translations: Array<{ blockId: string; text: string }> }>;
    analyze: (input: {
      instanceId: string;
      document: DocumentRevisionRef;
      blocks: Array<{ id: string; page: number; type: string; text: string }>;
      termCandidates: string[];
      authorization: PaperReaderModelAuthorization;
    }, actor: EventActor, signal?: AbortSignal) => Promise<PaperReaderModelAnalysis>;
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
    this.#model = options.model;
    this.#translate = options.translate;
    this.#analyze = options.analyze;
    this.#onChanged = options.onChanged ?? (() => undefined);
    this.replay();
    this.markInterruptedRuns();
  }

  list(): PaperReaderInstanceV1[] {
    return [...this.#readers.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((reader) => structuredClone(reader));
  }

  get(instanceId: string): PaperReaderInstanceV1 {
    const reader = this.#readers.get(instanceId);
    if (!reader) throw new Error('论文精读实例尚未配置');
    return structuredClone(reader);
  }

  configure(instance: WorktableInstance, actor: EventActor): PaperReaderInstanceV1 {
    if (instance.templateId !== 'sci.paper-reader:deep-read') throw new Error('当前 Workbench 不是论文精读实例');
    const existing = this.#readers.get(instance.id);
    if (existing) return structuredClone(existing);
    const mainDocument = documentFromInput(instance.inputs.mainPdf, '主论文');
    if (!mainDocument) throw new Error('创建论文精读 Workbench 时必须选择主论文 PDF');
    const supportingDocument = firstSupportingDocument(instance.inputs.supplements);
    this.verifyRevision(mainDocument);
    if (supportingDocument) this.verifyRevision(supportingDocument);
    const now = new Date().toISOString();
    const reader: PaperReaderInstanceV1 = {
      schemaVersion: 1,
      instanceId: instance.id,
      projectId: this.#projectId,
      mainDocument,
      ...(supportingDocument ? { supportingDocument } : {}),
      status: 'ready',
      stage: this.#toolchainAvailable() ? '等待开始解析' : 'Reader Runtime 未安装',
      progress: 0,
      blockCount: 0,
      figureCount: 0,
      evidenceAnchorIds: [],
      conclusionCount: 0,
      termCount: 0,
      generationVersion: 0,
      autoFollow: true,
      createdAt: now,
      updatedAt: now,
    };
    this.#readers.set(instance.id, reader);
    this.#analysis.set(instance.id, cloneAnalysis());
    this.record('paper-reader.configured', reader, actor, cloneAnalysis());
    return structuredClone(reader);
  }

  prepare(instanceId: string, actor: EventActor): PaperReaderInstanceV1 {
    const current = this.requireReader(instanceId);
    if (this.#pipelines.has(instanceId)) return structuredClone(current);
    if (!current.mainDocument) throw new Error('精读实例缺少主论文修订');
    if (!this.#toolchainAvailable()) throw new Error('Reader Runtime 未安装。请安装内置离线 Reader Runtime 后重试。');
    this.verifyRevision(current.mainDocument);
    const inspection = this.#jobs.run({
      title: '检查主论文 PDF 文本层',
      executable: 'reader-worker',
      args: ['inspect', '--input', 'input/main.pdf', '--output', 'inspection.json'],
      inputs: [{ ref: current.mainDocument.ref, destination: 'input/main.pdf', role: 'source' }],
      outputs: [{ path: 'inspection.json', role: 'mapping', mediaType: 'application/json', required: true }],
      toolchainId: TOOLCHAIN_ID,
      timeoutMs: 5 * 60_000,
      network: false,
      origin: 'plugin',
      pluginId: PLUGIN_ID,
      traceId: `paper-reader-preflight:${randomUUID()}`,
      worktableInstanceId: instanceId,
    }, actor);
    const reader = this.update(instanceId, {
      status: 'inspecting', stage: '离线检查 PDF 文本层并计算调用量', progress: 0.04, inspectionJobId: inspection.id,
    }, actor);
    const pipeline = this.executeInspection(instanceId, actor)
      .catch((error) => this.failPipeline(instanceId, error, actor))
      .finally(() => this.#pipelines.delete(instanceId));
    this.#pipelines.set(instanceId, pipeline);
    return reader;
  }

  start(instanceId: string, actor: EventActor, confirmed = false): PaperReaderInstanceV1 {
    const current = this.requireReader(instanceId);
    if (this.#pipelines.has(instanceId)) return structuredClone(current);
    if (!current.mainDocument) throw new Error('精读实例缺少主论文修订');
    if (!this.#toolchainAvailable()) throw new Error('Reader Runtime 未安装。请安装内置离线 Reader Runtime 后重试。');
    this.verifyRevision(current.mainDocument);
    const preview = this.callPreview(instanceId);
    if (!preview.ready) throw new Error('请先完成离线预检，再确认全文模型处理');
    const reusable = this.activeAuthorization(current);
    if (!reusable && !confirmed) throw new Error('全文模型处理需要用户在调用量预览后一次性明确确认');
    if (!reusable && (!preview.model || preview.model === 'openlab-demo')) throw new Error('尚未配置可用的真实模型；请先在模型提供商设置中完成连接');
    const now = new Date().toISOString();
    const authorization: PaperReaderBatchAuthorizationV1 = reusable ?? {
      schemaVersion: 1,
      id: randomUUID(),
      instanceId,
      documentSha256: current.mainDocument.sha256,
      model: preview.model,
      scope: 'full_text_translation_and_analysis',
      estimatedInputTokens: preview.estimatedInputTokens,
      estimatedOutputTokens: preview.estimatedOutputTokens,
      estimatedTotalTokens: preview.estimatedTotalTokens,
      maximumTotalTokens: preview.maximumTotalTokens,
      modelCallLimit: Math.max(preview.modelCalls * 2, preview.modelCalls + 4),
      completedModelCalls: 0,
      consumedTokens: 0,
      status: 'active',
      actorId: actor.id,
      authorizedAt: now,
      updatedAt: now,
    };
    if (!reusable) this.recordAuthorization('paper-reader.batch_authorized', current, authorization, actor);
    const stage = current.parsedDocument ? '执行全文模型精读' : '解析主论文版面';
    const run = this.#kernel.startRun({
      instanceId,
      kind: 'workflow',
      status: 'queued',
      progress: current.parsedDocument ? 0.7 : 0.1,
      stage,
      inputRefs: [current.mainDocument.sha256, ...(current.supportingDocument ? [current.supportingDocument.sha256] : [])],
      outputRefs: [],
    }, actor);
    const controller = new AbortController();
    this.#controllers.set(instanceId, controller);
    const reader = this.update(instanceId, {
      status: current.parsedDocument ? 'analyzing' : 'parsing',
      stage,
      progress: current.parsedDocument ? Math.max(current.progress, 0.7) : Math.max(current.progress, 0.1),
      runId: run.id,
      batchAuthorization: authorization,
      clearError: true,
    }, actor);
    const pipeline = this.executePipeline(instanceId, actor, controller.signal)
      .catch((error) => this.failPipeline(instanceId, error, actor))
      .finally(() => {
        this.#pipelines.delete(instanceId);
        this.#controllers.delete(instanceId);
      });
    this.#pipelines.set(instanceId, pipeline);
    return reader;
  }

  resume(instanceId: string, actor: EventActor, confirmed = false): PaperReaderInstanceV1 {
    const current = this.requireReader(instanceId);
    if (!['interrupted', 'failed', 'unsupported_scanned', 'ready'].includes(current.status)) throw new Error('当前精读任务不需要恢复');
    if (current.status === 'unsupported_scanned') throw new Error('扫描型 PDF 暂不支持；请先在外部完成 OCR，再作为新修订导入');
    return this.start(instanceId, actor, confirmed);
  }

  async wait(instanceId: string): Promise<PaperReaderInstanceV1> {
    await this.#pipelines.get(instanceId);
    return this.get(instanceId);
  }

  cancel(instanceId: string, actor: EventActor): PaperReaderInstanceV1 {
    const current = this.requireReader(instanceId);
    this.#controllers.get(instanceId)?.abort(new DOMException('用户取消全文精读', 'AbortError'));
    for (const id of [current.inspectionJobId, current.parseJobId, current.supportingParseJobId]) {
      if (id) this.#jobs.cancel(id, actor);
    }
    if (current.runId) this.#kernel.updateRun(current.runId, { status: 'cancelled', stage: '用户取消' }, actor);
    return this.update(instanceId, { status: 'interrupted', stage: '已取消，可从检查点重试', error: 'cancelled_by_user' }, actor);
  }

  setAutoFollow(instanceId: string, enabled: boolean, actor: EventActor): PaperReaderInstanceV1 {
    return this.update(instanceId, { autoFollow: enabled }, actor);
  }

  selectBlock(instanceId: string, blockId: string, actor: EventActor): PaperReaderInstanceV1 {
    const parsed = this.readParsed(this.requireReader(instanceId).parsedDocument);
    if (!parsed?.blocks.some((block) => block.id === blockId)) throw new Error('原文块不存在');
    return this.update(instanceId, { activeBlockId: blockId }, actor);
  }

  freezeTerm(instanceId: string, source: string, translation: string, actor: EventActor): PaperReaderPanelContext {
    const analysis = cloneAnalysis(this.#analysis.get(instanceId));
    const normalized = source.trim().slice(0, 200);
    if (!normalized) throw new Error('术语不能为空');
    const current = analysis.terms.find((term) => term.source === normalized);
    if (current) {
      current.translation = translation.trim().slice(0, 400);
      current.frozen = true;
    } else {
      analysis.terms.push({ id: randomUUID(), source: normalized, translation: translation.trim().slice(0, 400), frozen: true });
    }
    this.#analysis.set(instanceId, analysis);
    this.update(instanceId, { termCount: analysis.terms.length }, actor, analysis);
    return this.context(instanceId, null);
  }

  async translateBlocks(instanceId: string, blockIds: string[], actor: EventActor): Promise<PaperReaderPanelContext> {
    const parsed = this.requireParsed(instanceId);
    const requested = new Set(blockIds);
    const selected: ParsedBlock[] = [];
    let characters = 0;
    for (const block of parsed.blocks) {
      if (!requested.has(block.id)) continue;
      const length = blockText(block).length;
      if (selected.length >= 100 || characters + length > 120_000) break;
      selected.push(block);
      characters += length;
    }
    if (selected.length === 0) throw new Error('请选择需要翻译的原文段落');
    const analysis = cloneAnalysis(this.#analysis.get(instanceId));
    const frozen = analysis.terms.filter((term) => term.frozen && term.translation).sort((a, b) => b.source.length - a.source.length);
    const reader = this.requireReader(instanceId);
    const authorization = this.requireAuthorization(reader);
    let result;
    try {
      result = await this.#translate({
        instanceId,
        document: reader.mainDocument!,
        blocks: selected.map((block) => ({ id: block.id, page: block.page, text: blockText(block) })),
        frozenTerms: frozen.map((term) => ({ source: term.source, translation: term.translation })),
        authorization: this.modelAuthorization(authorization),
      }, actor);
    } catch (error) {
      this.consumeFailedModelCall(instanceId, error, actor);
      throw error;
    }
    const returned = new Map<string, string>();
    for (const translation of result.translations) {
      if (!requested.has(translation.blockId) || returned.has(translation.blockId) || !translation.text.trim()) {
        throw new Error('模型翻译输出包含未知、重复或空的来源块');
      }
      returned.set(translation.blockId, translation.text.trim());
    }
    for (const block of selected) {
      const value = returned.get(block.id);
      if (!value) throw new Error(`模型翻译缺少来源块：${block.id}`);
      for (const term of frozen) {
        if (block.originalText.includes(term.source) && !value.includes(term.translation)) {
          throw new Error(`模型翻译未遵守冻结术语：${term.source} → ${term.translation}`);
        }
      }
      analysis.translations[block.id] = value;
      analysis.translationRuns[block.id] = { generationId: result.generationId, createdAt: new Date().toISOString() };
    }
    this.consumeAuthorization(instanceId, result.usage, result.generationId, actor, result.modelCallCount ?? 1);
    this.#analysis.set(instanceId, analysis);
    this.update(instanceId, { stage: `已生成 ${selected.length} 段双语修订（模型记录 ${result.generationId}）` }, actor, analysis);
    return this.context(instanceId, null);
  }

  ask(instanceId: string, question: string, actor: EventActor): PaperReaderPanelContext {
    const parsed = this.requireParsed(instanceId);
    const query = question.trim().slice(0, 2_000);
    if (!query) throw new Error('问题不能为空');
    const tokens = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
    const candidates = searchableBlocks(parsed).map((block) => ({
      block,
      score: tokens.reduce((score, token) => score + (block.originalText.toLocaleLowerCase().includes(token) ? 1 : 0), 0),
    })).sort((left, right) => right.score - left.score || left.block.order - right.block.order).slice(0, 4);
    const selected = candidates.filter((candidate) => candidate.score > 0).map((candidate) => candidate.block);
    const evidence = selected.length > 0 ? selected : searchableBlocks(parsed).slice(0, 2);
    if (evidence.length === 0) throw new Error('文档中没有可用于回答的来源块');
    const anchors = evidence.map((block) => this.anchorForBlock(instanceId, this.requireReader(instanceId).mainDocument!, block, actor));
    const item: PaperQuestion = {
      id: randomUUID(), question: query,
      answer: `仅依据当前论文可确认：${evidence.map((block) => excerpt(blockText(block), 260)).join('；')}`,
      evidenceAnchorIds: anchors.map((anchor) => anchor.id),
      blockIds: evidence.map((block) => block.id),
      createdAt: new Date().toISOString(),
    };
    const analysis = cloneAnalysis(this.#analysis.get(instanceId));
    analysis.questions.unshift(item);
    analysis.questions = analysis.questions.slice(0, 100);
    this.#analysis.set(instanceId, analysis);
    this.update(instanceId, {}, actor, analysis);
    return this.context(instanceId, null);
  }

  regenerate(instanceId: string, blockIds: string[], actor: EventActor): PaperReaderPanelContext {
    const parsed = this.requireParsed(instanceId);
    const selected = searchableBlocks(parsed).filter((block) => blockIds.includes(block.id)).slice(0, 12);
    if (selected.length === 0) throw new Error('局部重新生成必须选择至少一个来源块');
    const reader = this.requireReader(instanceId);
    const version = reader.generationVersion + 1;
    const anchors = selected.map((block) => this.anchorForBlock(instanceId, reader.mainDocument!, block, actor));
    const conclusion: PaperConclusion = {
      id: randomUUID(), category: 'claim-evidence', title: '局部来源约束解读',
      content: selected.map((block) => excerpt(blockText(block), 320)).join(' '),
      evidenceAnchorIds: anchors.map((anchor) => anchor.id), blockIds: selected.map((block) => block.id),
      confidence: 'medium', generationVersion: version,
    };
    this.qualityGate([conclusion]);
    const analysis = cloneAnalysis(this.#analysis.get(instanceId));
    analysis.conclusions.unshift(conclusion);
    this.#analysis.set(instanceId, analysis);
    this.update(instanceId, { generationVersion: version, conclusionCount: analysis.conclusions.length }, actor, analysis);
    return this.context(instanceId, null);
  }

  export(instanceId: string, actor: EventActor): ArtifactRevisionRef {
    const reader = this.requireReader(instanceId);
    const parsed = this.requireParsed(instanceId);
    const analysis = cloneAnalysis(this.#analysis.get(instanceId));
    this.qualityGate(analysis.conclusions);
    const parsedRef = reader.parsedDocument!;
    const artifact = this.#createReportArtifact({
      instanceId,
      title: `${parsed.paper.title} · 精读报告`,
      markdown: markdownReport(parsed, analysis),
      json: JSON.stringify({ schemaVersion: 1, reader, paper: parsed.paper, analysis }, null, 2),
      parsedRef,
    }, actor);
    this.#mountReport(instanceId, artifact, '精读报告（Markdown / JSON）', actor);
    this.update(instanceId, { reportArtifact: artifact, stage: '已导出可复现报告' }, actor, analysis);
    return structuredClone(artifact);
  }

  callPreview(instanceId: string): PaperReaderCallPreview {
    const reader = this.requireReader(instanceId);
    const parsed = this.readParsed(reader.parsedDocument);
    const supportingParsed = this.readParsed(reader.supportingParsedDocument);
    const blocks = [...(parsed ? searchableBlocks(parsed) : []), ...(supportingParsed ? searchableBlocks(supportingParsed) : [])];
    const parsedCharacters = blocks.reduce((total, block) => total + blockText(block).length, 0);
    const textCharacters = parsedCharacters || reader.inspectedTextCharacters || 0;
    const translationCallCount = blocks.length > 0
      ? translationChunks(blocks).length
      : Math.max(1, Math.ceil(textCharacters / TRANSLATION_CHUNK_CHARACTERS));
    const modelCalls = textCharacters > 0 ? translationCallCount + 1 : 0;
    const model = this.activeAuthorization(reader)?.model ?? this.#model();
    // Codex App Server includes the structured-output bridge and host policy in
    // every fresh ephemeral turn. The measured fixed input cost is ~13k tokens,
    // so preview it conservatively instead of surprising the user or exhausting
    // a revision-scoped authorization midway through a long paper.
    const perCallInputOverhead = model.startsWith('chatgpt-oauth::') ? 15_000 : 800;
    const estimatedInputTokens = textCharacters > 0
      ? Math.ceil(textCharacters / 4) * 2 + modelCalls * perCallInputOverhead
      : 0;
    const estimatedOutputTokens = textCharacters > 0 ? Math.ceil(textCharacters * 0.82) + 6_000 : 0;
    const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;
    const maximumTotalTokens = estimatedTotalTokens > 0 ? Math.ceil(estimatedTotalTokens * 1.5) + 4_096 : 0;
    const ready = textCharacters > 0 && reader.status !== 'unsupported_scanned';
    return {
      ready,
      parseCalls: reader.supportingDocument ? 3 : 2,
      modelCalls,
      model,
      fullTextBlocks: blocks.length,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedTotalTokens,
      maximumTotalTokens,
      note: ready
        ? '离线解析不消耗 token；确认一次后，宿主会在本 PDF 修订与上限内自动完成全文术语、深度解读和逐段翻译，不再逐次确认。'
        : '先执行离线预检以读取文本量；预检不调用模型，也不消耗 token。',
    };
  }

  context(instanceId: string, reveal: JsonValue): PaperReaderPanelContext {
    const reader = this.requireReader(instanceId);
    const parsed = this.readParsed(reader.parsedDocument);
    const supportingParsed = this.readParsed(reader.supportingParsedDocument);
    const analysis = cloneAnalysis(this.#analysis.get(instanceId));
    const context: PaperReaderPanelContext = {
      reader: structuredClone(reader),
      document: reader.mainDocument ? structuredClone(reader.mainDocument) : null,
      supportingDocument: reader.supportingDocument ? structuredClone(reader.supportingDocument) : null,
      parsed,
      supportingParsed,
      analysis,
      anchors: this.#kernel.anchors(reader.mainDocument),
      jobs: this.#jobs.list().filter((job) => job.spec.worktableInstanceId === instanceId),
      reveal,
      toolchainAvailable: this.#toolchainAvailable(),
      callPreview: this.callPreview(instanceId),
      allowedTools: ['paper.prepare', 'paper.start', 'paper.resume', 'paper.cancel', 'paper.auto-follow', 'paper.select-block', 'paper.freeze-term', 'paper.translate', 'paper.ask', 'paper.regenerate', 'paper.export'],
    };
    const bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
    if (bytes > MAX_CONTEXT_BYTES && context.parsed) {
      context.parsed = { ...context.parsed, blocks: context.parsed.blocks.slice(0, 1_500), warnings: [...context.parsed.warnings, '面板上下文超过安全上限，当前仅显示前 1,500 个来源块。'] };
    }
    return context;
  }

  private async executeInspection(instanceId: string, actor: EventActor): Promise<void> {
    const reader = this.requireReader(instanceId);
    const inspection = await this.#jobs.wait(reader.inspectionJobId!);
    if (inspection.status !== 'completed') throw new Error(inspection.error ?? `PDF 检查${inspection.status}`);
    const inspectionValue = this.readJobJson(inspection, 'inspection.json');
    if (inspectionValue.has_text_layer !== true) throw new Error('UNSUPPORTED_SCANNED_PDF: PDF 没有足够的可选中文本层');
    const textCharacters = Number(inspectionValue.text_characters);
    const pageCount = Number(inspectionValue.page_count);
    if (!Number.isFinite(textCharacters) || textCharacters <= 0) throw new Error('UNSUPPORTED_SCANNED_PDF: PDF 文本层为空');
    this.update(instanceId, {
      status: 'ready',
      stage: '调用量预览已就绪，确认一次即可自动处理全文',
      progress: 0.08,
      inspectedTextCharacters: Math.trunc(textCharacters),
      ...(Number.isFinite(pageCount) && pageCount > 0 ? { inspectedPageCount: Math.trunc(pageCount) } : {}),
      clearError: true,
    }, actor);
  }

  private async executePipeline(instanceId: string, actor: EventActor, signal: AbortSignal): Promise<void> {
    let reader = this.requireReader(instanceId);
    this.requireAuthorization(reader);
    if (signal.aborted) throw signal.reason;
    if (!reader.parsedDocument) {
      this.#kernel.updateRun(reader.runId!, { status: 'running', progress: 0.12, stage: '解析主论文版面' }, actor);
      const parse = this.runParse(instanceId, reader.mainDocument!, '主论文', reader.runId!, actor);
      reader = this.update(instanceId, { status: 'parsing', stage: '解析主论文页、段落、图表与公式', progress: 0.12, parseJobId: parse.id }, actor);
      const parsedJob = await this.#jobs.wait(parse.id);
      if (parsedJob.status !== 'completed') throw new Error(parsedJob.error ?? `主论文解析${parsedJob.status}`);
      const parsedOutput = parsedJob.outputs.find((output) => output.path === 'parsed/reader_document.json');
      if (!parsedOutput) throw new Error('Reader Runtime 没有返回 reader_document.json');
      reader = this.update(instanceId, { parsedDocument: parsedOutput.ref, progress: 0.68, stage: '准备全文模型精读', status: 'analyzing' }, actor);
    }
    if (reader.supportingDocument) {
      if (!reader.supportingParsedDocument) {
        const supporting = this.runParse(instanceId, reader.supportingDocument, '补充材料', reader.runId!, actor, 'supporting');
        reader = this.update(instanceId, { supportingParseJobId: supporting.id, stage: '解析补充材料（SI）', progress: 0.7 }, actor);
        const supportingJob = await this.#jobs.wait(supporting.id);
        if (supportingJob.status !== 'completed') throw new Error(supportingJob.error ?? `补充材料解析${supportingJob.status}`);
        const output = supportingJob.outputs.find((candidate) => candidate.path === 'parsed/reader_document.json');
        if (!output) throw new Error('Reader Runtime 没有返回 SI reader_document.json');
        reader = this.update(instanceId, { supportingParsedDocument: output.ref, progress: 0.72 }, actor);
      }
    }
    if (signal.aborted) throw signal.reason;
    const parsed = this.requireParsed(instanceId);
    const generationVersion = reader.generationVersion + 1;
    const baseAnalysis = this.buildAnalysis(instanceId, parsed, generationVersion, actor);
    this.update(instanceId, {
      status: 'analyzing', stage: '基于全文生成术语表与来源约束深度解读', progress: 0.74,
      blockCount: parsed.blocks.length, figureCount: parsed.figures.length,
    }, actor, baseAnalysis);
    const analyzed = await this.analyzeFullText(instanceId, parsed, baseAnalysis, generationVersion, actor, signal);
    const analysis = await this.translateFullText(instanceId, parsed, analyzed, actor, signal);
    this.qualityGate(analysis.conclusions);
    const artifact = this.#createReportArtifact({
      instanceId,
      title: `${parsed.paper.title} · 精读报告`,
      markdown: markdownReport(parsed, analysis),
      json: JSON.stringify({ schemaVersion: 1, paper: parsed.paper, analysis }, null, 2),
      parsedRef: reader.parsedDocument!,
    }, actor);
    this.#mountReport(instanceId, artifact, '精读报告', actor);
    const completedAuthorization = this.completeAuthorization(this.requireReader(instanceId), actor);
    reader = this.update(instanceId, {
      status: 'completed', stage: '精读闭环完成', progress: 1,
      reportArtifact: artifact,
      blockCount: parsed.blocks.length,
      figureCount: parsed.figures.length,
      evidenceAnchorIds: [...new Set(analysis.conclusions.flatMap((item) => item.evidenceAnchorIds))],
      conclusionCount: analysis.conclusions.length,
      termCount: analysis.terms.length,
      generationVersion,
      translatedBlockCount: Object.keys(analysis.translations).length,
      batchAuthorization: completedAuthorization,
      clearError: true,
    }, actor, analysis);
    this.#kernel.updateRun(reader.runId!, { status: 'completed', progress: 1, stage: '精读闭环完成', outputRefs: [artifact.revisionId, ...reader.evidenceAnchorIds] }, actor);
  }

  private runParse(instanceId: string, document: DocumentRevisionRef, label: string, traceId: string, actor: EventActor, folder = 'main'): JobRecord {
    this.verifyRevision(document);
    return this.#jobs.run({
      title: `解析${label} PDF`,
      executable: 'reader-worker',
      args: ['parse', '--input', `input/${folder}.pdf`, '--revision', document.sha256, '--output-dir', 'parsed'],
      inputs: [{ ref: document.ref, destination: `input/${folder}.pdf`, role: 'source' }],
      outputs: [{ glob: 'parsed/**', base: 'parsed', role: 'mapping', required: true }],
      toolchainId: TOOLCHAIN_ID,
      timeoutMs: 30 * 60_000,
      network: false,
      origin: 'plugin',
      pluginId: PLUGIN_ID,
      traceId,
      worktableInstanceId: instanceId,
    }, actor);
  }

  private async analyzeFullText(
    instanceId: string,
    parsed: ParsedReaderDocument,
    base: PaperReaderAnalysis,
    generationVersion: number,
    actor: EventActor,
    signal: AbortSignal,
  ): Promise<PaperReaderAnalysis> {
    const reader = this.requireReader(instanceId);
    const authorization = this.requireAuthorization(reader);
    const blocks = searchableBlocks(parsed);
    let result: PaperReaderModelAnalysis;
    try {
      result = await this.#analyze({
        instanceId,
        document: reader.mainDocument!,
        blocks: blocks.map((block) => ({ id: block.id, page: block.page, type: block.type, text: blockText(block) })),
        termCandidates: base.terms.map((term) => term.source),
        authorization: this.modelAuthorization(authorization),
      }, actor, signal);
    } catch (error) {
      this.consumeFailedModelCall(instanceId, error, actor);
      throw error;
    }
    this.consumeAuthorization(instanceId, result.usage ?? zeroUsage(), result.generationId, actor, result.modelCallCount ?? 1);
    const byId = new Map(blocks.map((block) => [block.id, block]));
    const requiredCategories = new Set<PaperConclusion['category']>([
      'research-question', 'method', 'claim-evidence', 'key-result', 'figure-formula',
      'reproduction', 'contribution', 'limitation', 'unproven',
    ]);
    const seenCategories = new Set<PaperConclusion['category']>();
    const conclusions = result.conclusions.map((item) => {
      if (!requiredCategories.has(item.category) || seenCategories.has(item.category)) throw new Error(`模型精读类别无效或重复：${item.category}`);
      seenCategories.add(item.category);
      const blockIds = [...new Set(item.blockIds)].slice(0, 8);
      if (blockIds.length === 0 || blockIds.some((id) => !byId.has(id))) throw new Error(`模型精读引用未知来源块：${item.category}`);
      const title = item.title.trim().slice(0, 500);
      const content = item.content.trim().slice(0, 8_000);
      if (!title || !content) throw new Error(`模型精读结论为空：${item.category}`);
      const anchors = blockIds.map((id) => this.anchorForBlock(instanceId, reader.mainDocument!, byId.get(id)!, actor));
      return {
        id: randomUUID(), category: item.category, title, content,
        evidenceAnchorIds: anchors.map((anchor) => anchor.id), blockIds,
        confidence: item.confidence, generationVersion, generationId: result.generationId,
      } satisfies PaperConclusion;
    });
    for (const category of requiredCategories) if (!seenCategories.has(category)) throw new Error(`模型精读缺少必需类别：${category}`);
    this.qualityGate(conclusions);

    const modeledTerms = new Map<string, string>();
    const fullText = blocks.map((block) => block.originalText).join('\n');
    for (const term of result.terms) {
      const source = term.source.trim().slice(0, 200);
      const translation = term.translation.trim().slice(0, 400);
      if (!source || !translation || !fullText.includes(source) || modeledTerms.has(source)) continue;
      modeledTerms.set(source, translation);
      if (modeledTerms.size >= 80) break;
    }
    const terms: PaperTerm[] = [];
    const existing = new Map(base.terms.map((term) => [term.source, term]));
    for (const [source, translation] of modeledTerms) {
      const previous = existing.get(source);
      // A model-generated glossary is a suggestion, not user authority. Only an
      // explicitly frozen existing term becomes a hard cross-block constraint.
      terms.push({ id: previous?.id ?? randomUUID(), source, translation, frozen: previous?.frozen === true });
    }
    for (const term of base.terms) {
      if (terms.some((candidate) => candidate.source === term.source)) continue;
      terms.push(term);
      if (terms.length >= 80) break;
    }
    const analysis: PaperReaderAnalysis = {
      ...cloneAnalysis(base), terms, conclusions,
    };
    this.#analysis.set(instanceId, analysis);
    this.update(instanceId, {
      stage: `深度解读完成（模型记录 ${result.generationId}），开始全文翻译`,
      progress: 0.82,
      conclusionCount: conclusions.length,
      termCount: terms.length,
    }, actor, analysis);
    return analysis;
  }

  private async translateFullText(
    instanceId: string,
    parsed: ParsedReaderDocument,
    starting: PaperReaderAnalysis,
    actor: EventActor,
    signal: AbortSignal,
  ): Promise<PaperReaderAnalysis> {
    const blocks = searchableBlocks(parsed);
    let analysis = cloneAnalysis(starting);
    const pending = blocks.filter((block) => !analysis.translations[block.id]);
    const chunks = translationChunks(pending);
    this.update(instanceId, {
      translationBlockCount: blocks.length,
      translatedBlockCount: blocks.length - pending.length,
      stage: pending.length > 0 ? `自动翻译全文：0 / ${chunks.length} 批` : '全文译文已从检查点恢复',
      progress: 0.83,
    }, actor, analysis);
    for (const [index, chunk] of chunks.entries()) {
      if (signal.aborted) throw signal.reason;
      const reader = this.requireReader(instanceId);
      const authorization = this.requireAuthorization(reader);
      const frozen = analysis.terms.filter((term) => term.frozen && term.translation).sort((a, b) => b.source.length - a.source.length);
      const request = {
        instanceId,
        document: reader.mainDocument!,
        blocks: chunk.map((block) => ({ id: block.id, page: block.page, text: blockText(block) })),
        frozenTerms: frozen.map((term) => ({ source: term.source, translation: term.translation })),
        authorization: this.modelAuthorization(authorization),
      };
      let accepted: { generationId: string; values: Map<string, string> } | undefined;
      let correctionReason = '';
      for (let attempt = 0; attempt < 2 && !accepted; attempt += 1) {
        let result;
        try {
          result = await this.#translate({
            ...request,
            ...(attempt > 0 ? { correction: { attempt, reason: correctionReason.slice(0, 2_000) } } : {}),
          }, actor, signal);
        } catch (error) {
          this.consumeFailedModelCall(instanceId, error, actor);
          throw error;
        }
        this.consumeAuthorization(instanceId, result.usage ?? zeroUsage(), result.generationId, actor, result.modelCallCount ?? 1);
        try {
          accepted = { generationId: result.generationId, values: this.validateTranslations(chunk, frozen, result.translations) };
        } catch (error) {
          correctionReason = error instanceof Error ? error.message : String(error);
          if (attempt > 0) throw error;
          this.update(instanceId, { stage: `自动修正第 ${index + 1} 批译文质量问题` }, actor, analysis);
        }
      }
      if (!accepted) throw new Error('模型全文翻译自动纠错未返回可接受结果');
      for (const block of chunk) {
        analysis.translations[block.id] = accepted.values.get(block.id)!;
        analysis.translationRuns[block.id] = { generationId: accepted.generationId, createdAt: new Date().toISOString() };
      }
      this.#analysis.set(instanceId, analysis);
      this.update(instanceId, {
        stage: `自动翻译全文：${index + 1} / ${chunks.length} 批`,
        progress: 0.83 + 0.14 * ((index + 1) / Math.max(1, chunks.length)),
        translatedBlockCount: Object.keys(analysis.translations).length,
      }, actor, analysis);
      analysis = cloneAnalysis(this.#analysis.get(instanceId));
    }
    const missing = blocks.filter((block) => !analysis.translations[block.id]);
    if (missing.length > 0) throw new Error(`全文翻译质量门未通过，缺少 ${missing.length} 个来源块`);
    return analysis;
  }

  private validateTranslations(
    chunk: ParsedBlock[],
    frozen: PaperTerm[],
    translations: Array<{ blockId: string; text: string }>,
  ): Map<string, string> {
    const expected = new Set(chunk.map((block) => block.id));
    const returned = new Map<string, string>();
    for (const translation of translations) {
      if (!expected.has(translation.blockId) || returned.has(translation.blockId) || !translation.text.trim()) {
        throw new Error('模型全文翻译输出包含未知、重复或空的来源块');
      }
      returned.set(translation.blockId, translation.text.trim());
    }
    for (const block of chunk) {
      const value = returned.get(block.id);
      if (!value) throw new Error(`模型全文翻译缺少来源块：${block.id}`);
      for (const term of frozen) {
        if (!block.originalText.includes(term.source)) continue;
        const compactScientificToken = !/\s/u.test(term.source)
          && term.source.length <= 32
          && /[A-Z0-9]/u.test(term.source)
          && /^[\p{L}\p{N}+./()\[\]−–—-]+$/u.test(term.source);
        if (!value.includes(term.translation) && !(compactScientificToken && value.includes(term.source))) {
          throw new Error(`模型全文翻译未遵守冻结术语：${term.source} → ${term.translation}`);
        }
      }
    }
    return returned;
  }

  private buildAnalysis(instanceId: string, parsed: ParsedReaderDocument, generationVersion: number, actor: EventActor): PaperReaderAnalysis {
    const blocks = searchableBlocks(parsed);
    if (blocks.length === 0) throw new Error('解析结果没有可用于精读的正文块');
    const reader = this.requireReader(instanceId);
    const document = reader.mainDocument!;
    const abstract = pickBlock(blocks, [/\babstract\b/iu], 0)!;
    const method = pickBlock(blocks, [/\b(?:method|experimental|procedure|materials and methods)\b/iu], Math.min(3, blocks.length - 1))!;
    const result = pickBlock(blocks, [/\b(?:we (?:show|find|demonstrate|report)|results?|significant|increased|decreased)\b/iu], Math.min(5, blocks.length - 1))!;
    const conclusionBlock = pickBlock(blocks, [/\b(?:conclusion|in summary|taken together|our study)\b/iu], blocks.length - 1)!;
    const limitation = pickBlock(blocks, [/\b(?:limitation|however|remains? unclear|future work)\b/iu], Math.max(0, blocks.length - 2))!;
    const figureBlock = parsed.blocks.find((block) => block.type === 'caption' || block.type === 'formula') ?? result;
    const definitions: Array<[PaperConclusion['category'], string, ParsedBlock, PaperConclusion['confidence']]> = [
      ['research-question', '论文试图回答的问题', abstract, 'medium'],
      ['method', '核心方法与实验路径', method, 'medium'],
      ['claim-evidence', '主要主张及其直接来源', result, 'high'],
      ['key-result', '关键结果', result, 'high'],
      ['figure-formula', '关键图表或公式', figureBlock, 'medium'],
      ['reproduction', '复现所需来源信息', method, 'medium'],
      ['contribution', '论文声明的贡献', conclusionBlock, 'medium'],
      ['limitation', '作者文本中可见的边界', limitation, 'low'],
      ['unproven', '当前来源尚不能单独证明的事项', limitation, 'low'],
    ];
    const conclusions = definitions.map(([category, title, block, confidence]) => {
      const anchor = this.anchorForBlock(instanceId, document, block, actor);
      const prefix = category === 'unproven' ? '仅凭当前锚定段落不能外推到论文未直接检验的条件。来源提示：' : '';
      return {
        id: randomUUID(), category, title, content: `${prefix}${excerpt(blockText(block))}`,
        evidenceAnchorIds: [anchor.id], blockIds: [block.id], confidence, generationVersion,
      } satisfies PaperConclusion;
    });
    this.qualityGate(conclusions);
    const existing = cloneAnalysis(this.#analysis.get(instanceId));
    const frozen = new Map(existing.terms.filter((term) => term.frozen).map((term) => [term.source, term]));
    const terms = termCandidates(blocks).map((source) => frozen.get(source) ?? { id: randomUUID(), source, translation: '', frozen: false });
    for (const term of frozen.values()) {
      if (!terms.some((candidate) => candidate.source === term.source)) terms.push(term);
    }
    const analysis: PaperReaderAnalysis = { terms, translations: existing.translations, translationRuns: existing.translationRuns, conclusions, questions: existing.questions };
    this.#analysis.set(instanceId, analysis);
    return analysis;
  }

  private anchorForBlock(instanceId: string, document: DocumentRevisionRef, block: ParsedBlock, actor: EventActor): EvidenceAnchorV1 {
    const key = `paper-reader:${instanceId}:${document.sha256}:${block.id}`;
    return this.#kernel.createAnchor({
      target: document,
      page: block.page,
      blockId: block.id,
      selector: { kind: 'document-anchor', scheme: 'sci.paper-reader.block.v1', anchor: block.id, exact: blockText(block) },
      exact: blockText(block),
      ...(block.type === 'formula' ? { asset: { kind: 'formula' as const, id: block.refs?.[0] ?? block.id } } : {}),
    }, actor, key);
  }

  private qualityGate(conclusions: PaperConclusion[]): void {
    if (conclusions.some((item) => item.evidenceAnchorIds.length === 0 || item.blockIds.length === 0)) {
      throw new Error('PAPER_READER_QUALITY_GATE: 模型或自动结论缺少 EvidenceAnchor');
    }
    for (const item of conclusions) for (const anchorId of item.evidenceAnchorIds) this.#kernel.anchor(anchorId);
  }

  private activeAuthorization(reader: PaperReaderInstanceV1): PaperReaderBatchAuthorizationV1 | undefined {
    const authorization = reader.batchAuthorization;
    if (!authorization || authorization.status !== 'active' || !reader.mainDocument) return undefined;
    if (authorization.instanceId !== reader.instanceId || authorization.documentSha256 !== reader.mainDocument.sha256) return undefined;
    if (authorization.completedModelCalls >= authorization.modelCallLimit || authorization.consumedTokens >= authorization.maximumTotalTokens) return undefined;
    return structuredClone(authorization);
  }

  private requireAuthorization(reader: PaperReaderInstanceV1): PaperReaderBatchAuthorizationV1 {
    const authorization = reader.batchAuthorization;
    if (!authorization || !reader.mainDocument
      || authorization.instanceId !== reader.instanceId
      || authorization.documentSha256 !== reader.mainDocument.sha256
      || !['active', 'completed'].includes(authorization.status)) {
      throw new Error('全文模型调用缺少本 PDF 修订的一次性批量授权');
    }
    return structuredClone(authorization);
  }

  private modelAuthorization(authorization: PaperReaderBatchAuthorizationV1): PaperReaderModelAuthorization {
    return {
      id: authorization.id,
      authorizedAt: authorization.authorizedAt,
      model: authorization.model,
      maximumTotalTokens: authorization.maximumTotalTokens,
    };
  }

  private consumeAuthorization(instanceId: string, usage: ModelUsage, generationId: string, actor: EventActor, modelCallCount = 1): PaperReaderBatchAuthorizationV1 {
    const reader = this.requireReader(instanceId);
    const authorization = this.requireAuthorization(reader);
    const used = Math.max(0, Math.trunc(usage.totalTokens || usage.promptTokens + usage.completionTokens));
    const completedModelCalls = authorization.completedModelCalls + Math.max(0, Math.trunc(modelCallCount));
    const consumedTokens = authorization.consumedTokens + used;
    const exhausted = completedModelCalls > authorization.modelCallLimit || consumedTokens > authorization.maximumTotalTokens;
    const updated: PaperReaderBatchAuthorizationV1 = {
      ...authorization,
      completedModelCalls,
      consumedTokens,
      status: exhausted ? 'exhausted' : authorization.status,
      updatedAt: new Date().toISOString(),
    };
    this.update(instanceId, {
      batchAuthorization: updated,
      modelGenerationIds: [...new Set([...(reader.modelGenerationIds ?? []), generationId])],
    }, actor);
    if (exhausted) {
      this.recordAuthorization('paper-reader.batch_exhausted', this.requireReader(instanceId), updated, actor);
      throw new Error(`全文任务达到用户确认的 token / 调用上限（${completedModelCalls} / ${updated.modelCallLimit} 次调用；${consumedTokens} / ${updated.maximumTotalTokens} token）`);
    }
    return updated;
  }

  private consumeFailedModelCall(instanceId: string, error: unknown, actor: EventActor): void {
    if (!error || typeof error !== 'object') return;
    const value = error as { generationId?: unknown; usage?: unknown; modelCallCount?: unknown };
    if (typeof value.generationId !== 'string' || !value.usage || typeof value.usage !== 'object') return;
    this.consumeAuthorization(
      instanceId,
      value.usage as ModelUsage,
      value.generationId,
      actor,
      typeof value.modelCallCount === 'number' ? value.modelCallCount : 1,
    );
  }

  private completeAuthorization(reader: PaperReaderInstanceV1, actor: EventActor): PaperReaderBatchAuthorizationV1 {
    const authorization = this.requireAuthorization(reader);
    const completed: PaperReaderBatchAuthorizationV1 = {
      ...authorization,
      status: 'completed',
      updatedAt: new Date().toISOString(),
    };
    this.recordAuthorization('paper-reader.batch_completed', reader, completed, actor);
    return completed;
  }

  private recordAuthorization(kind: string, reader: PaperReaderInstanceV1, authorization: PaperReaderBatchAuthorizationV1, actor: EventActor): void {
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind,
      actor,
      revision: reader.generationVersion,
      idempotencyKey: `${kind}:${authorization.id}:${authorization.updatedAt}`,
      provenanceRefs: [reader.instanceId, authorization.documentSha256, authorization.id],
      payload: toJson({ instanceId: reader.instanceId, authorization }),
    });
  }

  private readParsed(ref: WorkspacePathRef | undefined): ParsedReaderDocument | null {
    if (!ref) return null;
    const absolute = new PathGuard(this.#resolveRoot(ref.rootId, 'read')).resolveExisting(ref.path);
    const value = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
    if (!isRecord(value) || !isRecord(value.paper) || !Array.isArray(value.blocks) || !Array.isArray(value.figures) || !Array.isArray(value.pages)) throw new Error('Reader Runtime 解析文档结构无效');
    return value as unknown as ParsedReaderDocument;
  }

  private requireParsed(instanceId: string): ParsedReaderDocument {
    const parsed = this.readParsed(this.requireReader(instanceId).parsedDocument);
    if (!parsed) throw new Error('论文尚未完成解析');
    return parsed;
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

  private failPipeline(instanceId: string, error: unknown, actor: EventActor): void {
    const message = error instanceof Error ? error.message : String(error);
    const current = this.#readers.get(instanceId);
    if (!current) return;
    const status = /UNSUPPORTED_SCANNED_PDF|text layer/iu.test(message) ? 'unsupported_scanned'
      : /cancel|AbortError|interrupted|shutdown|restart|取消/iu.test(message) ? 'interrupted' : 'failed';
    const stage = status === 'unsupported_scanned' ? '扫描型 PDF 暂不支持，请先 OCR 后重新导入' : status === 'interrupted' ? '任务已中断，可从检查点重试' : '精读任务失败';
    this.update(instanceId, { status, stage, error: message.slice(0, 4_000) }, actor);
    if (current.runId) this.#kernel.updateRun(current.runId, { status: status === 'interrupted' ? 'interrupted' : 'failed', stage }, actor);
  }

  private update(instanceId: string, patch: Partial<PaperReaderInstanceV1> & { clearError?: boolean }, actor: EventActor, analysis?: PaperReaderAnalysis): PaperReaderInstanceV1 {
    const current = this.requireReader(instanceId);
    const { clearError, ...readerPatch } = structuredClone(patch);
    const reader = { ...current, ...readerPatch, updatedAt: new Date().toISOString() };
    if (reader.progress < 0 || reader.progress > 1) throw new Error('论文精读进度必须在 0–1 之间');
    if (clearError) delete reader.error;
    this.#readers.set(instanceId, reader);
    if (analysis) this.#analysis.set(instanceId, cloneAnalysis(analysis));
    this.record('paper-reader.updated', reader, actor, analysis);
    return structuredClone(reader);
  }

  private record(kind: string, reader: PaperReaderInstanceV1, actor: EventActor, analysis?: PaperReaderAnalysis): void {
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind,
      actor,
      revision: reader.generationVersion,
      idempotencyKey: `${kind}:${reader.instanceId}:${reader.updatedAt}:${randomUUID()}`,
      provenanceRefs: [reader.instanceId, ...(reader.mainDocument ? [reader.mainDocument.sha256] : []), ...(reader.reportArtifact ? [reader.reportArtifact.revisionId] : [])],
      payload: toJson({ reader, ...(analysis ? { analysis } : {}) }),
    });
    this.#onChanged();
  }

  private requireReader(instanceId: string): PaperReaderInstanceV1 {
    const reader = this.#readers.get(instanceId);
    if (!reader) throw new Error('论文精读实例不存在');
    return reader;
  }

  private markInterruptedRuns(): void {
    for (const [id, current] of this.#readers) {
      if (!['inspecting', 'parsing', 'analyzing'].includes(current.status)) continue;
      this.#readers.set(id, { ...current, status: 'interrupted', stage: 'Runtime 重启，任务可恢复', error: 'runtime_restart', updatedAt: new Date().toISOString() });
    }
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (!event.kind.startsWith('paper-reader.')) continue;
      const payload = event.payload as unknown as PaperReaderEventPayload;
      if (payload.reader?.instanceId) this.#readers.set(payload.reader.instanceId, structuredClone(payload.reader));
      if (payload.reader?.instanceId && payload.analysis) this.#analysis.set(payload.reader.instanceId, cloneAnalysis(payload.analysis));
    }
  }
}
