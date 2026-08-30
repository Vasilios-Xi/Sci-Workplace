import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactRevisionRef, JsonValue, ModelUsage, PaperReaderInstanceV2 } from '@openlab/protocol';
import { SqliteEventStore } from '../src/events/event-store.js';
import { JobService } from '../src/workbench/job-service.js';
import { paperReaderPanelHtml } from '../src/workbench/paper-reader-panel.js';
import { paperReaderVisualInputIssue, PaperReaderService } from '../src/workbench/paper-reader-service.js';
import { ScientificKernelStore } from '../src/workbench/scientific-kernel-store.js';
import { WorkbenchService } from '../src/workbench/workbench-service.js';
import { WorktableStore } from '../src/worktable/worktable-store.js';

const actor = { id: 'owner', kind: 'user', label: 'Local owner' } as const;
const roots: string[] = [];
const usage: ModelUsage = { promptTokens: 80, completionTokens: 40, totalTokens: 120, cacheHitTokens: 0, cacheMissTokens: 80, reasoningTokens: 0 };

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'sci-paper-reader-v2-'));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe('first-party paper deep-reader v2', () => {
  it('runs one-confirmation full-text, visual, formula, evidence and atomic-artifact closure with scoped reruns', async () => {
    const root = temporaryDirectory();
    const mainBytes = Buffer.from('%PDF-1.4\nselectable main paper\n%%EOF', 'utf8');
    const siBytes = Buffer.from('%PDF-1.4\nselectable supplementary information\n%%EOF', 'utf8');
    const mainHash = hash(mainBytes); const siHash = hash(siBytes);
    writeFileSync(join(root, 'main.pdf'), mainBytes); writeFileSync(join(root, 'si.pdf'), siBytes);
    const mainId = `main-${mainHash.slice(0, 16)}`; const siId = `si-${siHash.slice(0, 16)}-1`;
    const immutableJobRoot = join(root, 'immutable-parser-job');
    const parserJobRootId = 'job:fixture-parser-output';
    const mainRef = { rootId: parserJobRootId, path: 'parsed/main/reader_document.json' };
    const siRef = { rootId: parserJobRootId, path: 'parsed/si/reader_document.json' };
    const mainParsed = {
      parser: 'fixture-reader', parserVersion: '0.2.23', revisionHash: mainHash, warnings: [],
      paper: { title: 'Traceable current-density study', pageCount: 2, language: 'en', textCharacters: 420, hasTextLayer: true, profileImagePath: 'assets/title-page.png', profilePage: 1 },
      blocks: [
        { id: 'h1', stableId: 'h1', page: 1, type: 'heading', order: 1, originalText: 'Results and Methods', bbox: [0.1, 0.08, 0.8, 0.12], confidence: 'high' },
        { id: 'b1', stableId: 'b1', page: 1, type: 'paragraph', order: 2, continuationKey: 'cross-page-1', originalText: 'The current density reached 42.0 mA cm−2 at 25 °C in three independent experiments.', bbox: [0.1, 0.15, 0.8, 0.3], confidence: 'high' },
        { id: 'b2', stableId: 'b2', page: 2, type: 'paragraph', order: 3, continuationKey: 'cross-page-1', originalText: 'The experiment remained stable for 100 h, while Figure S1 reports the calibration control.', bbox: [0.1, 0.1, 0.8, 0.24], confidence: 'high' },
        { id: 'e1', stableId: 'e1', page: 2, type: 'formula', order: 4, originalText: 'j = I / A', bbox: [0.2, 0.3, 0.6, 0.36], refs: ['E001'], confidence: 'high' },
        { id: 'c1', stableId: 'c1', page: 2, type: 'caption', order: 5, originalText: 'Figure 1. Current density and stability under the reported condition.', bbox: [0.1, 0.7, 0.8, 0.76], refs: ['F1'], confidence: 'high' },
      ],
      figures: [
        { id: 'F1', kind: 'figure', contentVisual: true, page: 2, captionId: 'c1', captionBlockIds: ['c1'], imagePath: 'assets/fig1.png', bbox: [60, 300, 540, 650], placedAfter: 'b2', originalCaption: 'Figure 1. Current density and stability under the reported condition.', approximate: false },
        { id: 'E001', kind: 'formula', contentVisual: true, page: 2, captionBlockIds: [], imagePath: 'assets/equation-001.png', bbox: [120, 240, 400, 300], placedAfter: 'e1', originalCaption: 'j = I / A', approximate: false },
      ],
      pages: [{ page: 1, width: 612, height: 792, blockIds: ['h1', 'b1'] }, { page: 2, width: 612, height: 792, blockIds: ['b2', 'e1', 'c1'] }],
    };
    const siParsed = {
      parser: 'fixture-reader', parserVersion: '0.2.23', revisionHash: siHash, warnings: [],
      paper: { title: 'Traceable current-density study SI', pageCount: 1, language: 'en', textCharacters: 180, hasTextLayer: true },
      blocks: [
        { id: 's1', stableId: 's1', page: 1, type: 'paragraph', order: 1, originalText: 'Figure S1 provides the calibration control at 25 °C.', bbox: [0.1, 0.1, 0.8, 0.2], confidence: 'high' },
        { id: 'sc1', stableId: 'sc1', page: 1, type: 'caption', order: 2, originalText: 'Figure S1. Calibration control.', bbox: [0.1, 0.7, 0.8, 0.76], refs: ['S1'], confidence: 'high' },
      ],
      figures: [{ id: 'S1', kind: 'figure', contentVisual: true, page: 1, captionId: 'sc1', captionBlockIds: ['sc1'], imagePath: 'assets/fig-s1.png', bbox: [60, 220, 540, 650], placedAfter: 's1', originalCaption: 'Figure S1. Calibration control.', approximate: false }],
      pages: [{ page: 1, width: 612, height: 792, blockIds: ['s1', 'sc1'] }],
    };
    writeJson(join(immutableJobRoot, mainRef.path), mainParsed); writeJson(join(immutableJobRoot, siRef.path), siParsed);
    for (const path of ['parsed/main/assets/title-page.png', 'parsed/main/assets/fig1.png', 'parsed/main/assets/equation-001.png', 'parsed/si/assets/fig-s1.png']) {
      mkdirSync(dirname(join(immutableJobRoot, path)), { recursive: true }); writeFileSync(join(immutableJobRoot, path), Buffer.from(`fixture:${path}`));
    }

    const events = new SqliteEventStore(join(root, 'events.sqlite'));
    let jobs!: JobService;
    jobs = new JobService({
      projectId: 'project', events, root: join(root, 'jobs'),
      resolveRoot: (rootId) => jobs.rootFor(rootId) ?? root,
      resolveToolchainExecutable: (_toolchainId, executable) => executable,
    });
    const kernel = new ScientificKernelStore({ projectId: 'project', events });
    const worktables = new WorktableStore({ projectId: 'project', events });
    const workbenches = new WorkbenchService({ projectId: 'project', events, worktables });
    const instance = workbenches.create({
      blueprintId: 'sci.paper-reader:deep-read', title: 'V2 fixture', primaryConversationId: 'conversation-paper',
      inputs: {
        mainPdf: { rootId: 'project', path: 'main.pdf', sha256: mainHash, mediaType: 'application/pdf' },
        supplements: [{ rootId: 'project', path: 'si.pdf', sha256: siHash, mediaType: 'application/pdf' }],
      },
    }, actor);
    const artifacts: Array<{ files?: Array<{ name: string; content?: string }>; json: string; markdown: string }> = [];
    const mounts: ArtifactRevisionRef[] = [];
    let generation = 0; let translations = 0; let figures = 0; let questions = 0;
    const next = <T,>(value: T) => ({ generationId: `fixture-generation-${++generation}`, usage, modelCallCount: 1, value });
    const statement = (blockId: string, text = 'The evidence supports the scoped claim.', quantities: unknown[] = []) => ({
      text, type: 'source-fact' as const, confidence: 'high' as const, blockIds: [blockId], quantities,
    });
    const common = {
      projectId: 'project', events, jobs, kernel,
      resolveRoot: (rootId: string, intent: 'read' | 'write') => {
        if (rootId === parserJobRootId) {
          if (intent === 'write') throw new Error('fixture parser job output is immutable');
          return immutableJobRoot;
        }
        return jobs.rootFor(rootId) ?? root;
      },
      toolchainAvailable: () => true,
      createReportArtifact: (input: { files?: Array<{ name: string; content?: string }>; json: string; markdown: string }) => {
        artifacts.push(input); return { artifactId: 'paper-report', revisionId: `paper-report-v${artifacts.length}` };
      },
      mountReport: (_instanceId: string, artifact: ArtifactRevisionRef) => { mounts.push(artifact); },
      textModel: () => 'fixture-text-model', visionModel: () => 'fixture-vision-model',
      translate: async (input: { blocks: Array<{ id: string; text: string }> }) => {
        translations += 1;
        return { generationId: `translation-${translations}`, usage, modelCallCount: 1, translations: input.blocks.map((block) => ({ blockId: block.id, text: `中文译文：${block.text}` })) };
      },
      terminology: async () => next([]),
      documentProfile: async () => next({ title: 'Traceable current-density study', authors: ['Ada Researcher', 'Bo Scientist'], affiliations: ['Institute of Traceable Science'], journal: 'Fixture Journal', articleType: 'Article', doi: '10.1000/fixture', publicationDate: '2026', confidence: 'high' as const, status: 'verified' as const, warnings: [] }),
      sectionDigest: async (input: { heading: string; blocks: Array<{ id: string }> }) => {
        const id = input.blocks[0]!.id;
        const numeric = input.blocks.find((block) => block.id.endsWith(':b1'))?.id;
        return next({ heading: input.heading, argumentativeFunction: '提供该节的证据与限定条件', statements: [statement(id, '该章节陈述有原文证据。'), ...(numeric ? [statement(numeric, '电流密度在报告条件下达到 42.0 mA cm−2。', [{ value: '42.0', unit: 'mA cm−2', condition: '25 °C', blockIds: [numeric] }])] : [])] });
      },
      figureAnalysis: async (input: { figureId: string; blocks: Array<{ id: string }> }) => {
        figures += 1; const id = input.blocks[0]!.id;
        return next({ status: 'verified' as const, purpose: `核验 ${input.figureId} 的变量、对照和定量趋势`, panelObservations: ['全部分面清晰'], axesAndVariables: ['x 与 y 变量可读'], controls: ['校准对照'], quantities: [], authorInterpretation: [statement(id, '作者将图中趋势解释为稳定性证据。')], independentJudgment: [statement(id, '图像与图注在限定条件内一致。', [])], limitations: [] });
      },
      formulaAnalysis: async (input: { expression: string; blocks: Array<{ id: string }> }) => next({ status: 'verified' as const, expression: input.expression, ambiguousSymbols: [], sourceTextAgreement: 'consistent' as const, variables: [{ symbol: 'j', meaning: '电流密度' }, { symbol: 'I', meaning: '电流' }, { symbol: 'A', meaning: '面积' }], assumptions: ['面积定义与原文一致'], purpose: '计算电流密度', applicability: ['报告的实验面积'], blockIds: [input.blocks.find((block) => block.id.endsWith(':e1'))?.id ?? input.blocks[0]!.id] }),
      claimEvidence: async (input: { sourceBlocks: Array<{ id: string }> }) => {
        const id = input.sourceBlocks.find((block) => block.id.endsWith(':b1'))!.id;
        return next({ evidenceChain: [statement(id, '报告的电流密度由对应结果段支持。')], mechanism: [statement(id, '作者的机制解释受实验条件限定。', [])], keyResults: [statement(id, '关键结果为 42.0 mA cm−2。', [{ value: '42.0', unit: 'mA cm−2', condition: '25 °C', blockIds: [id] }])], contributions: [statement(id, '贡献在报告条件范围内成立。')], limitations: [statement(id, '结果尚未证明可外推到未测试条件。')], unproven: [statement(id, '更广泛温度区间仍未证明。', [])] });
      },
      reproduction: async (input: { sourceBlocks: Array<{ id: string }> }) => {
        const id = input.sourceBlocks.find((block) => block.id.endsWith(':b1'))!.id;
        const value = [statement(id, '复现信息来自方法与结果来源块。')];
        return next({ materials: value, preparation: value, instruments: value, parameters: value, controls: value, statistics: value, conditions: value, missingInformation: [statement(id, '原文未报告额外校准细节。')] });
      },
      synthesis: async (input: { sourceBlocks: Array<{ id: string }> }) => {
        const id = input.sourceBlocks.find((block) => block.id.endsWith(':b1'))!.id;
        return next({ thesis: [statement(id, '论文论点由报告的电流密度和稳定性支撑。')], researchQuestion: [statement(id, '研究问题聚焦于报告条件下的性能。')], strategy: [statement(id, '策略结合定量实验与校准对照。')], researchImplications: [statement(id, '结果提示后续应扩大条件范围。', [])], directionOutput: [statement(id, '可检验假设：扩大温度范围。', [])], presentationBrief: ['问题—方法—证据—局限'] });
      },
      question: async (input: { blocks: Array<{ id: string }> }) => { questions += 1; return next({ answer: '原文报告了限定条件下的电流密度。', blockIds: [input.blocks[0]!.id] }); },
    };

    const initialService = new PaperReaderService(common);
    const configured = initialService.configure(instance, actor);
    const readyDocuments = configured.documents.map((document) => document.role === 'main'
      ? { ...document, parsedDocument: mainRef, parseState: 'ready' as const, pageCount: 2, textCharacters: 420, blockCount: 5, figureCount: 1, formulaCount: 1 }
      : { ...document, parsedDocument: siRef, parseState: 'ready' as const, pageCount: 1, textCharacters: 180, blockCount: 2, figureCount: 1, formulaCount: 0 });
    const ready: PaperReaderInstanceV2 = {
      ...configured, documents: readyDocuments, status: 'ready', stage: '离线解析完成', progress: 0.08,
      pipeline: { stage: 'document-profile', totalUnits: 2, completedUnits: 2, failedUnits: 0, units: [] },
      parsedDocument: mainRef, supportingParsedDocument: siRef, blockCount: 7, figureCount: 2,
      translationBlockCount: 7, inspectedTextCharacters: 600, inspectedPageCount: 2, updatedAt: '2026-08-29T12:00:00.000Z',
    };
    events.append({
      streamId: 'project:project', kind: 'paper-reader.v2_updated', actor, revision: 0,
      idempotencyKey: `paper-reader-v2-ready:${instance.id}`, provenanceRefs: [instance.id, mainHash, siHash],
      payload: { reader: ready, analysis: { schemaVersion: 2, documentProfiles: [], terms: [], translations: {}, translationRuns: {}, translationBatchLimits: {}, sectionDigests: [], figureAnalyses: [], formulaAnalyses: [], questions: [], legacyConclusions: [] } } as unknown as JsonValue,
    });

    const service = new PaperReaderService(common);
    const preview = service.callPreview(instance.id);
    expect(preview).toMatchObject({ ready: true, profileUnits: 1, fullTextBlocks: 6, visualUnits: 2, formulaUnits: 1, textModel: 'fixture-text-model', visionModel: 'fixture-vision-model' });
    expect(() => service.start(instance.id, actor)).toThrow(/确认/u);
    service.start(instance.id, actor, true);
    const completed = await service.wait(instance.id);
    expect(completed).toMatchObject({ status: 'completed', quality: { status: 'complete', textCoverageComplete: true, translationCoverageComplete: true, visualCoverageComplete: true, formulaCoverageComplete: true } });
    expect(completed.batchAuthorization).toMatchObject({ status: 'completed', documentSetHash: completed.documentSetHash, textModel: 'fixture-text-model', visionModel: 'fixture-vision-model' });
    expect(completed.pipeline.units.filter((unit) => unit.status === 'completed').every((unit) => unit.outputRef?.rootId === 'project')).toBe(true);
    expect(existsSync(join(root, '.openlab', 'paper-reader-v2', 'instances', instance.id, 'checkpoints'))).toBe(true);
    expect(existsSync(join(root, '.openlab', 'paper-reader-v2', 'instances', instance.id, 'state'))).toBe(true);
    const context = service.context(instance.id, null);
    expect(context.analysis.documentProfiles).toEqual([expect.objectContaining({ title: 'Traceable current-density study', status: 'verified' })]);
    expect(Object.keys(context.analysis.translations)).toHaveLength(6);
    expect(context.analysis.sectionDigests.flatMap((digest) => digest.blockIds)).toHaveLength(6);
    expect(new Set(context.analysis.sectionDigests.flatMap((digest) => digest.blockIds)).size).toBe(6);
    const crossPageDigest = context.analysis.sectionDigests.find((digest) => digest.blockIds.includes(`${mainId}:b1`));
    expect(crossPageDigest?.blockIds).toContain(`${mainId}:b2`);
    expect(context.analysis.figureAnalyses).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: mainId, figureId: 'F1', status: 'verified' }),
      expect.objectContaining({ documentId: siId, figureId: 'S1', status: 'verified' }),
    ]));
    expect(context.analysis.report).toMatchObject({ schema: 'openscientific.fine-reading-report/2', coverage: { documentProfileCount: 1, verifiedDocumentProfileCount: 1, substantiveBlockCount: 6, digestedBlockCount: 6, translatedBlockCount: 6, mainVisualCount: 1, verifiedMainVisualCount: 1, referencedSupplementaryVisualCount: 1, analyzedSupplementaryVisualCount: 1, formulaCount: 1, analyzedFormulaCount: 1 } });
    expect(context.anchors.every((anchor) => anchor.schemaVersion === 2 && anchor.canonicalUri?.startsWith('paper:'))).toBe(true);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.files?.map((file) => file.name)).toEqual(expect.arrayContaining(['paper.md', 'source_map.json', 'translation_notes.md', 'deep_reading.json', 'figure_analyses.json', 'formula_analyses.json', 'deep_reading_quality.json', 'generation_manifest.json', `assets/${mainId}/title-page.png`, `assets/${mainId}/fig1.png`, `assets/${siId}/fig-s1.png`]));
    expect(JSON.parse(artifacts[0]!.json)).toMatchObject({ schema: 'openscientific.fine-reading-report/2', quality: { status: 'complete' } });
    const generationManifest = JSON.parse(artifacts[0]!.files!.find((file) => file.name === 'generation_manifest.json')!.content!);
    expect(generationManifest.fileHashes).toMatchObject({ 'paper.md': expect.stringMatching(/^[a-f0-9]{64}$/u), 'deep_reading.json': expect.stringMatching(/^[a-f0-9]{64}$/u), [`assets/${mainId}/fig1.png`]: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(mounts).toHaveLength(1);
    expect(readFileSync(join(root, 'main.pdf')).equals(mainBytes)).toBe(true);
    expect(readFileSync(join(root, 'si.pdf')).equals(siBytes)).toBe(true);

    await service.ask(instance.id, 'What current density was reported?', actor);
    expect(service.context(instance.id, null).analysis.questions[0]).toMatchObject({ answer: expect.stringContaining('电流密度'), evidenceAnchorIds: [expect.any(String)] });
    expect(questions).toBe(1);
    const translationsBeforeRerun = translations; const figuresBeforeRerun = figures;
    expect(() => service.regenerateFigure(instance.id, 'F1', actor)).toThrow(/确认/u);
    service.regenerateFigure(instance.id, 'F1', actor, true);
    const rerun = await service.wait(instance.id);
    expect(rerun.quality?.status).toBe('complete');
    expect(figures).toBe(figuresBeforeRerun + 1);
    expect(translations).toBe(translationsBeforeRerun);

    const restarted = new PaperReaderService(common);
    expect(restarted.get(instance.id)).toMatchObject({ status: 'completed', quality: { status: 'complete' } });
    expect(restarted.context(instance.id, null).analysis.report?.schema).toBe('openscientific.fine-reading-report/2');
    writeJson(join(immutableJobRoot, mainRef.path), { ...mainParsed, parserVersion: '0.2.19' });
    const parserUpgrade = new PaperReaderService(common).context(instance.id, null);
    expect(parserUpgrade.reader).toMatchObject({ status: 'stale', stage: expect.stringContaining('重新离线预检') });
    expect(parserUpgrade.callPreview.ready).toBe(false);
    jobs.shutdown(); events.close();
  }, 20_000);

  it('ships bridge-only V2 source and analysis panels with three modes and deterministic quality controls', () => {
    const source = paperReaderPanelHtml('source'); const analysis = paperReaderPanelHtml('analysis');
    expect(source).toContain('data-panel="source"');
    expect(source).toContain('深度精读'); expect(source).toContain('双语全文'); expect(source).toContain('PDF 原文');
    expect(source).toContain("hiddenSourceTypes = new Set(['running_matter','reference','front_matter','figure_text','formula'])");
    expect(source).toContain('已自动收纳非正文内容');
    expect(source).toContain('选择本段');
    expect(source).toContain('整页视觉核验');
    expect(source).toContain('chemical-formula');
    expect(source).not.toContain('规范锚点');
    expect(source).not.toContain('>p.');
    expect(source).toContain('证据抽屉'); expect(source).toContain("call('resource.open'");
    expect(analysis).toContain('主张—证据—限定'); expect(analysis).toContain('确定性质量门'); expect(analysis).toContain('一次授权预算');
    expect(source).not.toMatch(/\bfetch\s*\(/u); expect(source).not.toContain('WebSocket');
    const sourceScript = source.match(/<script>([\s\S]*)<\/script>/u)?.[1];
    const analysisScript = analysis.match(/<script>([\s\S]*)<\/script>/u)?.[1];
    expect(() => Function(sourceScript!)).not.toThrow(); expect(() => Function(analysisScript!)).not.toThrow();
    const scientificSource = sourceScript!.match(/  const escape[\s\S]+?(?=  const number)/u)?.[0];
    const scientific = Function(`${scientificSource}\nreturn scientific;`)() as (value: string) => string;
    expect(scientific('Li2S and CO2 were compared with Li6PS5Cl.')).toContain('Li<sub>2</sub>S');
    expect(scientific('Li2S and CO2 were compared with Li6PS5Cl.')).toContain('CO<sub>2</sub>');
    expect(scientific('Li2S and CO2 were compared with Li6PS5Cl.')).toContain('Li<sub>6</sub>PS<sub>5</sub>Cl');
    expect(scientific('(NH4)2SO4')).toContain('(NH<sub>4</sub>)<sub>2</sub>SO<sub>4</sub>');
    expect(scientific('Li6.25Al0.25La3Zr2O12')).toContain('Li<sub>6.25</sub>Al<sub>0.25</sub>La<sub>3</sub>Zr<sub>2</sub>O<sub>12</sub>');
    expect(scientific('CuSO4·5H2O')).toContain('CuSO<sub>4</sub>·5H<sub>2</sub>O');
    expect(scientific('SO4^2−')).toContain('SO<sub>4</sub><sup>2−</sup>');
    expect(scientific('NH4+')).toContain('NH<sub>4</sub><sup>+</sup>');
    expect(scientific('Fe3+')).toContain('Fe<sup>3+</sup>');
    expect(scientific('O2−')).toContain('O<sub>2</sub><sup>−</sup>');
    expect(scientific('[Fe(CN)6]3−')).toContain('[Fe(CN)<sub>6</sub>]<sup>3−</sup>');
    expect(scientific('Article2025')).not.toContain('chemical-formula');
    expect(scientific('<script>alert(1)</script>')).not.toContain('<script>');
    expect(() => paperReaderPanelHtml('unknown')).toThrow(/不存在/u);
  });

  it('rejects micro visual inputs while accepting full figures and expanded formula crops', () => {
    const parsed = {
      parser: 'fixture-reader', parserVersion: '0.2.23', revisionHash: 'a'.repeat(64), warnings: [],
      paper: { title: 'Visual quality fixture', pageCount: 1 }, blocks: [],
      pages: [{ page: 1, width: 600, height: 800, blockIds: [] }], figures: [],
    };
    expect(paperReaderVisualInputIssue(parsed, { id: 'F1', page: 1, kind: 'figure', bbox: [40, 80, 560, 420], pixelWidth: 1_040, pixelHeight: 680 })).toBeUndefined();
    expect(paperReaderVisualInputIssue(parsed, { id: 'F2', page: 1, kind: 'figure', bbox: [100, 100, 240, 120], pixelWidth: 280, pixelHeight: 40 })).toMatch(/过小|面积|分辨率/u);
    expect(paperReaderVisualInputIssue(parsed, { id: 'E1', page: 1, kind: 'formula', bbox: [100, 100, 196, 128], pixelWidth: 288, pixelHeight: 84 })).toBeUndefined();
    expect(paperReaderVisualInputIssue(parsed, { id: 'E1b', page: 1, kind: 'formula', bbox: [111.941, 63.13, 222.028, 91.13], pixelWidth: 331, pixelHeight: 84 })).toBeUndefined();
    expect(paperReaderVisualInputIssue(parsed, { id: 'E2', page: 1, kind: 'formula', bbox: [100, 100, 120, 110], pixelWidth: 60, pixelHeight: 30 })).toMatch(/过小|分辨率/u);
    expect(paperReaderVisualInputIssue(parsed, { id: 'E3', page: 1, kind: 'formula', bbox: [100, 100, 196, 128], pixelWidth: 0, pixelHeight: 84 })).toMatch(/生成失败/u);
  });
});
