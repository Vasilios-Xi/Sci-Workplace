import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, ModelUsage, PaperReaderInstanceV2 } from '@openlab/protocol';
import { SqliteEventStore } from '../src/events/event-store.js';
import { JobService } from '../src/workbench/job-service.js';
import { PaperReaderService } from '../src/workbench/paper-reader-service.js';
import { ScientificKernelStore } from '../src/workbench/scientific-kernel-store.js';
import { WorkbenchService } from '../src/workbench/workbench-service.js';
import { WorktableStore } from '../src/worktable/worktable-store.js';

const actor = { id: 'owner', kind: 'user', label: 'Local owner' } as const;
const usage: ModelUsage = { promptTokens: 50, completionTokens: 25, totalTokens: 75, cacheHitTokens: 0, cacheMissTokens: 50, reasoningTokens: 0 };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function createHarness(options: { failStage?: string; cancelTranslation?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sci-paper-v2-recovery-'));
  roots.push(root);
  const pdf = Buffer.from('%PDF-1.4\ncheckpoint fixture\n%%EOF', 'utf8');
  const revision = createHash('sha256').update(pdf).digest('hex');
  writeFileSync(join(root, 'paper.pdf'), pdf);
  const parsedRef = { rootId: 'project', path: 'parsed/reader_document.json' };
  mkdirSync(dirname(join(root, parsedRef.path)), { recursive: true });
  writeFileSync(join(root, parsedRef.path), JSON.stringify({
    parser: 'fixture-reader', parserVersion: '0.2.23', revisionHash: revision, warnings: [],
    paper: { title: 'Catalyst checkpoint study', pageCount: 1, language: 'en', textCharacters: 120, hasTextLayer: true, profileImagePath: 'assets/title-page.png', profilePage: 1 },
    blocks: [
      { id: 'h1', stableId: 'h1', page: 1, type: 'heading', order: 1, originalText: 'Results', bbox: [0.1, 0.1, 0.8, 0.15], confidence: 'high' },
      { id: 'b1', stableId: 'b1', page: 1, type: 'paragraph', order: 2, originalText: 'Catalyst activity remained stable under the reported condition.', bbox: [0.1, 0.2, 0.8, 0.3], confidence: 'high' },
    ],
    figures: [], pages: [{ page: 1, width: 612, height: 792, blockIds: ['h1', 'b1'] }],
  }), 'utf8');
  mkdirSync(join(root, 'parsed', 'assets'), { recursive: true });
  writeFileSync(join(root, 'parsed', 'assets', 'title-page.png'), Buffer.from('fixture-title-page'));
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
    blueprintId: 'sci.paper-reader:deep-read', title: 'Recovery fixture', primaryConversationId: 'conversation',
    inputs: { mainPdf: { rootId: 'project', path: 'paper.pdf', sha256: revision, mediaType: 'application/pdf' }, supplements: [] },
  }, actor);
  const counts: Record<string, number> = {};
  let generation = 0;
  let stageFailed = false;
  let translationBlocked = false;
  const translationEntered = deferred();
  const next = <T,>(value: T) => ({ generationId: `generation-${++generation}`, usage, modelCallCount: 1, value });
  const draft = (blockId: string, text: string) => ({ text, type: 'source-fact' as const, confidence: 'high' as const, blockIds: [blockId], quantities: [] });
  const invoke = async <T,>(stage: string, value: T) => {
    counts[stage] = (counts[stage] ?? 0) + 1;
    if (options.failStage === stage && !stageFailed) {
      stageFailed = true;
      throw Object.assign(new Error(`simulated ${stage} process crash`), { usage, modelCallCount: 1 });
    }
    return next(value);
  };
  const common = {
    projectId: 'project', events, jobs, kernel,
    resolveRoot: (rootId: string) => jobs.rootFor(rootId) ?? root,
    toolchainAvailable: () => true,
    createReportArtifact: () => ({ artifactId: 'report', revisionId: `report-${generation}` }),
    mountReport: () => undefined,
    textModel: () => 'fixture-text', visionModel: () => 'fixture-vision',
    documentProfile: async () => next({ title: 'Catalyst checkpoint study', authors: ['A. Researcher'], affiliations: ['Institute of Checkpoint Science'], confidence: 'high' as const, status: 'verified' as const, warnings: [] }),
    terminology: async (input: { candidates: string[] }) => await invoke('terminology', [{ source: input.candidates.includes('Catalyst') ? 'Catalyst' : input.candidates[0]!, translation: '催化剂', note: '冻结前术语' }]),
    translate: async (input: { blocks: Array<{ id: string; text: string }> }, _runActor: unknown, signal?: AbortSignal) => {
      counts.translation = (counts.translation ?? 0) + 1;
      if (options.failStage === 'translation' && !stageFailed) {
        stageFailed = true;
        throw Object.assign(new Error('simulated translation process crash'), { usage, modelCallCount: 1 });
      }
      if (options.cancelTranslation && !translationBlocked) {
        translationBlocked = true;
        translationEntered.resolve();
        await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return { generationId: `generation-${++generation}`, usage, modelCallCount: 1, translations: input.blocks.map((block) => ({ blockId: block.id, text: `译文：${block.text}` })) };
    },
    sectionDigest: async (input: { heading: string; blocks: Array<{ id: string }> }) => await invoke('section', {
      heading: input.heading, argumentativeFunction: '给出来源约束的章节结果', statements: [draft(input.blocks[0]!.id, '章节结论有来源支持。')],
    }),
    figureAnalysis: async () => { throw new Error('fixture contains no figures'); },
    formulaAnalysis: async () => { throw new Error('fixture contains no formulas'); },
    claimEvidence: async (input: { sourceBlocks: Array<{ id: string }> }) => {
      const statement = draft(input.sourceBlocks[0]!.id, '主张由来源块支持。');
      return await invoke('claim', { evidenceChain: [statement], mechanism: [statement], keyResults: [statement], contributions: [statement], limitations: [statement], unproven: [statement] });
    },
    reproduction: async (input: { sourceBlocks: Array<{ id: string }> }) => {
      const statement = draft(input.sourceBlocks[0]!.id, '复现条件来自来源块。');
      return await invoke('reproduction', { materials: [statement], preparation: [statement], instruments: [statement], parameters: [statement], controls: [statement], statistics: [statement], conditions: [statement], missingInformation: [statement] });
    },
    synthesis: async (input: { sourceBlocks: Array<{ id: string }> }) => {
      const statement = draft(input.sourceBlocks[0]!.id, '综合结论来自分阶段产物。');
      return await invoke('synthesis', { thesis: [statement], researchQuestion: [statement], strategy: [statement], researchImplications: [statement], directionOutput: [statement], presentationBrief: ['问题—证据—局限'] });
    },
    question: async () => { throw new Error('not used'); },
  };
  const seedService = new PaperReaderService(common);
  const configured = seedService.configure(instance, actor);
  const document = configured.documents[0]!;
  const ready: PaperReaderInstanceV2 = {
    ...configured,
    documents: [{ ...document, parsedDocument: parsedRef, parseState: 'ready', pageCount: 1, textCharacters: 120, blockCount: 2, figureCount: 0, formulaCount: 0 }],
    status: 'ready', stage: '离线解析完成', progress: 0.08,
    pipeline: { stage: 'document-profile', totalUnits: 1, completedUnits: 1, failedUnits: 0, units: [] },
    parsedDocument: parsedRef, blockCount: 2, figureCount: 0, translationBlockCount: 2,
    inspectedTextCharacters: 120, inspectedPageCount: 1, updatedAt: '2026-08-30T00:00:00.000Z',
  };
  events.append({
    streamId: 'project:project', kind: 'paper-reader.v2_updated', actor, revision: 0,
    idempotencyKey: `ready:${instance.id}`, provenanceRefs: [instance.id, revision],
    payload: { reader: ready, analysis: { schemaVersion: 2, documentProfiles: [], terms: [], translations: {}, translationRuns: {}, translationBatchLimits: {}, sectionDigests: [], figureAnalyses: [], formulaAnalyses: [], questions: [], legacyConclusions: [] } } as unknown as JsonValue,
  });
  return { common, events, jobs, instanceId: instance.id, counts, translationEntered };
}

describe('paper reader V2 checkpoint recovery', () => {
  it.each(['terminology', 'translation', 'section', 'claim', 'reproduction', 'synthesis'])(
    'restarts after a simulated %s-stage process crash without replaying completed calls',
    async (failStage) => {
      const harness = createHarness({ failStage });
      const initial = new PaperReaderService(harness.common);
      initial.start(harness.instanceId, actor, true);
      expect((await initial.wait(harness.instanceId)).status).toBe('failed');
      const beforeResume = { ...harness.counts };
      const restarted = new PaperReaderService(harness.common);
      restarted.resume(harness.instanceId, actor);
      const completed = await restarted.wait(harness.instanceId);
      expect(completed).toMatchObject({ status: 'completed', quality: { status: 'complete' }, batchAuthorization: { status: 'completed' } });
      const order = ['terminology', 'translation', 'section', 'claim', 'reproduction', 'synthesis'];
      const failedIndex = order.indexOf(failStage);
      for (const [index, stage] of order.entries()) {
        expect(harness.counts[stage]).toBe(index === failedIndex ? 2 : 1);
        if (index < failedIndex) expect(beforeResume[stage]).toBe(1);
      }
      harness.jobs.shutdown(); harness.events.close();
    },
    20_000,
  );

  it('cancels an in-flight model unit and resumes after service restart under the same authorization', async () => {
    const harness = createHarness({ cancelTranslation: true });
    const initial = new PaperReaderService(harness.common);
    initial.start(harness.instanceId, actor, true);
    await harness.translationEntered.promise;
    initial.cancel(harness.instanceId, actor);
    expect((await initial.wait(harness.instanceId)).status).toBe('interrupted');
    expect(harness.counts.terminology).toBe(1);
    const restarted = new PaperReaderService(harness.common);
    restarted.resume(harness.instanceId, actor);
    expect(await restarted.wait(harness.instanceId)).toMatchObject({ status: 'completed', quality: { status: 'complete' } });
    expect(harness.counts.terminology).toBe(1);
    expect(harness.counts.translation).toBe(2);
    harness.jobs.shutdown(); harness.events.close();
  }, 20_000);
});
