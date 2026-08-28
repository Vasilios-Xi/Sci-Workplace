import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactRevisionRef, JsonValue } from '@openlab/protocol';
import { SqliteEventStore } from '../src/events/event-store.js';
import { JobService } from '../src/workbench/job-service.js';
import { paperReaderPanelHtml } from '../src/workbench/paper-reader-panel.js';
import { PaperReaderService } from '../src/workbench/paper-reader-service.js';
import { ScientificKernelStore } from '../src/workbench/scientific-kernel-store.js';
import { WorkbenchService } from '../src/workbench/workbench-service.js';
import { WorktableStore } from '../src/worktable/worktable-store.js';

const roots: string[] = [];
const actor = { id: 'owner', kind: 'user', label: 'Local owner' } as const;

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'sci-paper-reader-v1-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('first-party paper deep-reader v1', () => {
  it('closes the evidence-linked bilingual reading loop without mutating the source PDF', async () => {
    const root = temporaryDirectory();
    const pdfBytes = Buffer.from('%PDF-1.4\nfixture text-layer PDF\n%%EOF', 'utf8');
    const pdfHash = createHash('sha256').update(pdfBytes).digest('hex');
    writeFileSync(join(root, 'paper.pdf'), pdfBytes);
    const parsed = {
      parser: 'fixture-reader', parserVersion: '1.0.0', revisionHash: pdfHash, warnings: [],
      paper: { title: 'ATP response study', pageCount: 2, language: 'en', textCharacters: 280, hasTextLayer: true },
      blocks: [
        { id: 'b1', stableId: 'b1', page: 1, type: 'paragraph', order: 1, originalText: 'We show that ATP increased significantly after treatment in all measured samples.', bbox: [0.1, 0.1, 0.8, 0.12], confidence: 'high' },
        { id: 'b2', stableId: 'b2', page: 2, type: 'paragraph', order: 2, originalText: 'Methods used three independent experiments and a blinded quantitative analysis.', bbox: [0.1, 0.2, 0.8, 0.12], confidence: 'high' },
        { id: 'f1', stableId: 'f1', page: 2, type: 'formula', order: 3, originalText: 'Delta ATP equals treated ATP minus control ATP.', refs: ['formula-1'], confidence: 'medium' },
      ],
      figures: [{ id: 'figure-1', page: 2, originalCaption: 'ATP response.' }],
      pages: [{ page: 1, blockIds: ['b1'] }, { page: 2, blockIds: ['b2', 'f1'] }],
    };
    writeFileSync(join(root, 'reader_document.json'), JSON.stringify(parsed), 'utf8');

    const events = new SqliteEventStore(join(root, 'events.sqlite'));
    let jobs!: JobService;
    jobs = new JobService({
      projectId: 'project', events, root: join(root, 'jobs'),
      resolveRoot: (rootId) => jobs.rootFor(rootId) ?? root,
      resolveToolchainExecutable: (_toolchainId, executable) => executable,
    });
    const kernel = new ScientificKernelStore({ projectId: 'project', events });
    const tables = new WorktableStore({ projectId: 'project', events });
    const workbenches = new WorkbenchService({ projectId: 'project', events, worktables: tables });
    const instance = workbenches.create({
      blueprintId: 'sci.paper-reader:deep-read', title: 'ATP 论文精读', primaryConversationId: 'conversation-paper',
      inputs: { mainPdf: { rootId: 'project', path: 'paper.pdf', sha256: pdfHash, size: pdfBytes.length, mediaType: 'application/pdf' }, language: 'zh-CN' },
    }, actor);
    const reports: Array<{ markdown: string; json: string }> = [];
    const mounts: ArtifactRevisionRef[] = [];
    let translationCalls = 0;
    const options = {
      projectId: 'project', events, jobs, kernel,
      resolveRoot: (rootId: string) => jobs.rootFor(rootId) ?? root,
      toolchainAvailable: () => true,
      createReportArtifact: (input: { markdown: string; json: string }) => {
        reports.push({ markdown: input.markdown, json: input.json });
        return { artifactId: 'paper-report', revisionId: `report-revision-${reports.length}` };
      },
      mountReport: (_instanceId: string, artifact: ArtifactRevisionRef) => { mounts.push(artifact); },
      model: () => 'fixture-model',
      translate: async (input: { blocks: Array<{ id: string }>; frozenTerms: Array<{ source: string; translation: string }> }) => {
        translationCalls += 1;
        expect(input.frozenTerms).toContainEqual({ source: 'ATP', translation: '三磷酸腺苷' });
        return {
          generationId: 'model-generation-1',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cacheHitTokens: 0, cacheMissTokens: 100, reasoningTokens: 0 },
          translations: input.blocks.map((block) => ({ blockId: block.id, text: '处理后所有样本中的三磷酸腺苷（ATP）均显著增加。' })),
        };
      },
      analyze: async () => ({
        generationId: 'analysis-generation-1',
        usage: { promptTokens: 200, completionTokens: 80, totalTokens: 280, cacheHitTokens: 0, cacheMissTokens: 200, reasoningTokens: 20 },
        conclusions: ([
          'research-question', 'method', 'claim-evidence', 'key-result', 'figure-formula',
          'reproduction', 'contribution', 'limitation', 'unproven',
        ] as const).map((category) => ({ category, title: `${category} title`, content: `${category} evidence-grounded content`, blockIds: ['b1'], confidence: 'medium' as const })),
        terms: [{ source: 'ATP', translation: '三磷酸腺苷' }],
      }),
    };
    const configuredService = new PaperReaderService(options);
    const configured = configuredService.configure(instance, actor);
    expect(configured).toMatchObject({ status: 'ready', mainDocument: { sha256: pdfHash }, autoFollow: true });
    expect(Buffer.compare(pdfBytes, readFileSync(join(root, 'paper.pdf')))).toBe(0);

    const seededReader = {
      ...configured, status: 'completed', stage: 'fixture parse completed', progress: 1,
      parsedDocument: { rootId: 'project', path: 'reader_document.json' }, blockCount: 3, figureCount: 1, generationVersion: 1,
      batchAuthorization: {
        schemaVersion: 1 as const, id: 'fixture-batch-authorization', instanceId: instance.id, documentSha256: pdfHash,
        model: 'fixture-model', scope: 'full_text_translation_and_analysis' as const,
        estimatedInputTokens: 1_000, estimatedOutputTokens: 1_000, estimatedTotalTokens: 2_000, maximumTotalTokens: 10_000,
        modelCallLimit: 20, completedModelCalls: 0, consumedTokens: 0, status: 'active' as const,
        actorId: actor.id, authorizedAt: '2026-08-28T01:59:00.000Z', updatedAt: '2026-08-28T01:59:00.000Z',
      },
      updatedAt: '2026-08-28T02:00:00.000Z',
    };
    events.append({
      streamId: 'project:project', kind: 'paper-reader.updated', actor, revision: 1, idempotencyKey: `fixture-reader:${instance.id}`,
      provenanceRefs: [instance.id, pdfHash],
      payload: {
        reader: seededReader,
        analysis: { terms: [], translations: {}, translationRuns: {}, conclusions: [], questions: [] },
      } as unknown as JsonValue,
    });
    const service = new PaperReaderService(options);
    expect(service.context(instance.id, null).parsed?.blocks).toHaveLength(3);
    service.freezeTerm(instance.id, 'ATP', '三磷酸腺苷', actor);
    const translated = await service.translateBlocks(instance.id, ['b1'], actor);
    expect(translated.analysis.translations.b1).toContain('三磷酸腺苷');
    expect(translated.analysis.translationRuns.b1).toMatchObject({ generationId: 'model-generation-1' });
    expect(translationCalls).toBe(1);

    service.selectBlock(instance.id, 'b1', actor);
    expect(service.ask(instance.id, 'What ATP result was reported?', actor).analysis.questions[0]).toMatchObject({ blockIds: expect.arrayContaining(['b1']), evidenceAnchorIds: expect.arrayContaining([expect.any(String)]) });
    const regenerated = service.regenerate(instance.id, ['b1'], actor);
    expect(regenerated.analysis.conclusions[0]).toMatchObject({ blockIds: ['b1'], evidenceAnchorIds: [expect.any(String)], generationVersion: 2 });
    expect(regenerated.anchors).toEqual(expect.arrayContaining([expect.objectContaining({ target: expect.objectContaining({ sha256: pdfHash }), page: 1, blockId: 'b1' })]));
    const artifact = service.export(instance.id, actor);
    expect(artifact).toEqual({ artifactId: 'paper-report', revisionId: 'report-revision-1' });
    expect(reports[0]?.markdown).toContain('# ATP response study');
    expect(reports[0]?.markdown).toContain('证据块：`b1`');
    expect(JSON.parse(reports[0]!.json)).toMatchObject({ schemaVersion: 1, analysis: { translations: { b1: expect.any(String) } } });
    expect(mounts).toEqual([artifact]);

    const unsupported = { ...service.get(instance.id), status: 'unsupported_scanned', stage: '扫描型 PDF 暂不支持', updatedAt: '2026-08-28T03:00:00.000Z' };
    events.append({
      streamId: 'project:project', kind: 'paper-reader.updated', actor, revision: unsupported.generationVersion,
      idempotencyKey: `fixture-scanned:${instance.id}`, provenanceRefs: [instance.id, pdfHash],
      payload: { reader: unsupported, analysis: service.context(instance.id, null).analysis } as unknown as JsonValue,
    });
    const scannedService = new PaperReaderService(options);
    expect(() => scannedService.resume(instance.id, actor)).toThrow(/OCR/u);

    writeFileSync(join(root, 'paper.pdf'), Buffer.from('%PDF changed', 'utf8'));
    const changedInstance = workbenches.create({
      blueprintId: 'sci.paper-reader:deep-read', title: 'Changed revision',
      inputs: { mainPdf: { rootId: 'project', path: 'paper.pdf', sha256: pdfHash, mediaType: 'application/pdf' } },
    }, actor);
    expect(() => scannedService.configure(changedInstance, actor)).toThrow(/新的不可变文档修订/u);
    jobs.shutdown();
    events.close();
  });

  it('uses one revision-scoped confirmation to finish analysis and every full-text translation batch', async () => {
    const root = temporaryDirectory();
    const pdfBytes = Buffer.from('%PDF-1.4\nfull-paper fixture\n%%EOF', 'utf8');
    const pdfHash = createHash('sha256').update(pdfBytes).digest('hex');
    writeFileSync(join(root, 'paper.pdf'), pdfBytes);
    const parsed = {
      parser: 'fixture-reader', parserVersion: '1.0.0', revisionHash: pdfHash, warnings: [],
      paper: { title: 'One-confirmation paper', pageCount: 2, language: 'en', textCharacters: 260, hasTextLayer: true },
      blocks: [
        { id: 'b1', page: 1, type: 'paragraph', order: 1, originalText: 'ASSLMBs improved significantly after treatment in all measured samples.' },
        { id: 'b2', page: 1, type: 'paragraph', order: 2, originalText: 'The method used blinded analysis across three independent experiments.' },
        { id: 'b3', page: 2, type: 'paragraph', order: 3, originalText: 'The study remains limited to the reported material and pressure window.' },
      ],
      figures: [], pages: [{ page: 1, blockIds: ['b1', 'b2'] }, { page: 2, blockIds: ['b3'] }],
    };
    writeFileSync(join(root, 'reader_document.json'), JSON.stringify(parsed), 'utf8');
    const events = new SqliteEventStore(join(root, 'events.sqlite'));
    let jobs!: JobService;
    jobs = new JobService({
      projectId: 'project', events, root: join(root, 'jobs'),
      resolveRoot: (rootId) => jobs.rootFor(rootId) ?? root,
      resolveToolchainExecutable: (_toolchainId, executable) => executable,
    });
    const kernel = new ScientificKernelStore({ projectId: 'project', events });
    const tables = new WorktableStore({ projectId: 'project', events });
    const workbenches = new WorkbenchService({ projectId: 'project', events, worktables: tables });
    const instance = workbenches.create({
      blueprintId: 'sci.paper-reader:deep-read', title: 'One confirmation', primaryConversationId: 'conversation-paper',
      inputs: { mainPdf: { rootId: 'project', path: 'paper.pdf', sha256: pdfHash, mediaType: 'application/pdf' } },
    }, actor);
    const reports: string[] = [];
    let analysisCalls = 0;
    let translationCalls = 0;
    const options = {
      projectId: 'project', events, jobs, kernel,
      resolveRoot: (rootId: string) => jobs.rootFor(rootId) ?? root,
      toolchainAvailable: () => true,
      createReportArtifact: (input: { json: string }) => {
        reports.push(input.json);
        return { artifactId: 'batch-report', revisionId: 'batch-report-v1' };
      },
      mountReport: () => undefined,
      model: () => 'fixture-model',
      analyze: async () => {
        analysisCalls += 1;
        return {
          generationId: 'analysis-generation',
          usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300, cacheHitTokens: 0, cacheMissTokens: 200, reasoningTokens: 20 },
          conclusions: ([
            'research-question', 'method', 'claim-evidence', 'key-result', 'figure-formula',
            'reproduction', 'contribution', 'limitation', 'unproven',
          ] as const).map((category) => ({ category, title: category, content: `Grounded ${category}`, blockIds: ['b1'], confidence: 'medium' as const })),
          terms: [
            { source: 'ASSLMBs', translation: '全固态锂金属电池' },
            { source: 'blinded analysis', translation: '盲法分析' },
          ],
        };
      },
      translate: async (input: { blocks: Array<{ id: string }>; correction?: { attempt: number; reason: string } }) => {
        translationCalls += 1;
        return {
          generationId: 'translation-generation',
          usage: { promptTokens: 120, completionTokens: 80, totalTokens: 200, cacheHitTokens: 0, cacheMissTokens: 120, reasoningTokens: 0 },
          translations: input.blocks.map((block) => ({
            blockId: block.id,
            text: `${block.id === 'b1' ? 'ASSLMBs' : '译文'} ${input.correction && block.id === 'b2' ? '盲法分析' : ''} ${block.id}`,
          })),
        };
      },
    };
    const configuredService = new PaperReaderService(options);
    const configured = configuredService.configure(instance, actor);
    events.append({
      streamId: 'project:project', kind: 'paper-reader.updated', actor, revision: 0,
      idempotencyKey: `batch-ready:${instance.id}`, provenanceRefs: [instance.id, pdfHash],
      payload: {
        reader: {
          ...configured, status: 'ready', stage: 'preview ready', progress: 0.08,
          inspectedTextCharacters: 260, parsedDocument: { rootId: 'project', path: 'reader_document.json' },
          updatedAt: '2026-08-28T04:00:00.000Z',
        },
        analysis: { terms: [], translations: {}, translationRuns: {}, conclusions: [], questions: [] },
      } as unknown as JsonValue,
    });
    const service = new PaperReaderService(options);
    service.freezeTerm(instance.id, 'ASSLMBs', '全固态锂金属电池', actor);
    service.freezeTerm(instance.id, 'blinded analysis', '盲法分析', actor);
    expect(() => service.start(instance.id, actor)).toThrow(/一次性|明确确认/u);
    service.start(instance.id, actor, true);
    const completed = await service.wait(instance.id);
    expect(completed).toMatchObject({
      status: 'completed', translatedBlockCount: 3, translationBlockCount: 3,
      batchAuthorization: { status: 'completed', completedModelCalls: 3, consumedTokens: 700 },
    });
    expect(analysisCalls).toBe(1);
    expect(translationCalls).toBe(2);
    const context = service.context(instance.id, null);
    expect(Object.keys(context.analysis.translations)).toHaveLength(3);
    expect(context.analysis.conclusions).toHaveLength(9);
    expect(reports).toHaveLength(1);
    jobs.shutdown();
    events.close();
  });

  it('ships source and analysis panels as bridge-only sandbox documents', () => {
    const source = paperReaderPanelHtml('source');
    const analysis = paperReaderPanelHtml('analysis');
    expect(source).toContain('data-panel="source"');
    expect(source).toContain("call('resource.open'");
    expect(source).toContain('PDF 原版');
    expect(analysis).toContain('主张—证据');
    expect(analysis).toContain('无锚点结论无法通过质量门');
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toContain('WebSocket');
    expect(() => paperReaderPanelHtml('unknown')).toThrow(/不存在/u);
  });
});
