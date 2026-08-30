import { describe, expect, it, vi } from 'vitest';
import type { ModelGenerationService } from '../src/models/model-generation-service.js';
import {
  isWellFormedFormulaLatex,
  runPaperReaderDocumentProfile,
  runPaperReaderFormulaAnalysis,
  runPaperReaderTranslation,
} from '../src/workbench/paper-reader-model-adapter.js';

const actor = { id: 'owner', kind: 'user', label: 'Local owner' } as const;

describe('paper reader model adapter', () => {
  const authorization = { id: 'authorization-1', authorizedAt: '2026-08-29T00:00:00.000Z', model: 'fixture-vision', maximumTotalTokens: 100_000, completedModelCalls: 0 };
  const document = { ref: { rootId: 'project', path: 'paper.pdf' }, sha256: 'a'.repeat(64), mediaType: 'application/pdf' } as const;
  const image = { ref: { rootId: 'project', path: 'assets/source.png' }, sha256: 'b'.repeat(64), mediaType: 'image/png' };

  it('changes the structured-generation cache key after a failed call is consumed', async () => {
    const cacheKeys: string[] = [];
    const runStructured = vi.fn(async (_pluginId: string, spec: { cacheKey?: string }) => {
      cacheKeys.push(spec.cacheKey ?? '');
      return {
        id: `generation-${cacheKeys.length}`,
        status: 'completed',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cacheHitTokens: 0, cacheMissTokens: 10, reasoningTokens: 0 },
        attemptCount: 1,
        cacheHit: false,
        json: { translations: { b1: '译文' } },
      };
    });
    const generations = { runStructured } as unknown as ModelGenerationService;
    const base = {
      instanceId: 'reader-1',
      document: { ref: { rootId: 'project', path: 'paper.pdf' }, sha256: 'a'.repeat(64), mediaType: 'application/pdf' },
      blocks: [{ id: 'b1', page: 1, text: 'Source text.' }],
      frozenTerms: [],
    };

    await runPaperReaderTranslation(generations, {
      ...base,
      authorization: { id: 'authorization-1', authorizedAt: '2026-08-29T00:00:00.000Z', model: 'fixture', maximumTotalTokens: 1_000, completedModelCalls: 2 },
    }, actor);
    await runPaperReaderTranslation(generations, {
      ...base,
      authorization: { id: 'authorization-1', authorizedAt: '2026-08-29T00:00:00.000Z', model: 'fixture', maximumTotalTokens: 1_000, completedModelCalls: 3 },
    }, actor);

    expect(cacheKeys).toHaveLength(2);
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
  });

  it('extracts one consolidated title-page profile from the complete page image and filters glyph fragments', async () => {
    let captured: unknown;
    const generations = { runStructured: vi.fn(async (_pluginId: string, spec: unknown) => {
      captured = spec;
      return {
        id: 'profile-generation', status: 'completed', usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, cacheHitTokens: 0, cacheMissTokens: 20, reasoningTokens: 0 }, attemptCount: 1, cacheHit: false,
        json: { title: 'Imaging the evolution of a scientific interface', authors: ['A. Researcher', '1', ';'], affiliations: ['Institute of Reliable Science', 'Lab'], journal: 'Nature Communications', articleType: 'Article', doi: 'https://doi.org/10.1000/example', publicationDate: '2026', abstract: 'A complete abstract.', confidence: 'high', status: 'verified', warnings: [] },
      };
    }) } as unknown as ModelGenerationService;

    const result = await runPaperReaderDocumentProfile(generations, { document, image, authorization, inputHash: 'profile-input' }, actor);

    expect(result.value).toMatchObject({ title: 'Imaging the evolution of a scientific interface', authors: ['A. Researcher'], affiliations: ['Institute of Reliable Science'], doi: '10.1000/example', status: 'verified' });
    expect(JSON.stringify(captured)).toContain('title-page-image');
    expect(JSON.stringify(captured)).toContain('"type":"image"');
  });

  it('requires visually checked, balanced LaTeX and explicit chemical stoichiometric subscripts', async () => {
    expect(isWellFormedFormulaLatex(String.raw`j=\frac{I}{A}`)).toBe(true);
    expect(isWellFormedFormulaLatex(String.raw`\mathrm{Li}_{2}\mathrm{S}+\mathrm{CO}_{2}`)).toBe(true);
    expect(isWellFormedFormulaLatex(String.raw`\mathrm{Li2S}`)).toBe(false);
    expect(isWellFormedFormulaLatex('CO2 + x')).toBe(false);
    expect(isWellFormedFormulaLatex(String.raw`j=\frac{I}{A`)).toBe(false);

    let captured: unknown;
    const generations = { runStructured: vi.fn(async (_pluginId: string, spec: unknown) => {
      captured = spec;
      return {
        id: 'formula-generation', status: 'completed', usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, cacheHitTokens: 0, cacheMissTokens: 20, reasoningTokens: 0 }, attemptCount: 1, cacheHit: false,
        json: { status: 'verified', expression: String.raw`j=\frac{I}{A}`, ambiguousSymbols: [], sourceTextAgreement: 'consistent', variables: [{ symbol: 'j', meaning: 'current density' }], assumptions: [], purpose: 'calculate current density', applicability: ['reported geometry'], blockIds: ['main:b1'] },
      };
    }) } as unknown as ModelGenerationService;

    const result = await runPaperReaderFormulaAnalysis(generations, {
      document, formulaId: 'E001', expression: 'j = I / A', blocks: [{ id: 'main:b1', page: 2, type: 'paragraph', text: 'The current density j was calculated from current I and area A.' }], image, authorization, inputHash: 'formula-input',
    }, actor);

    expect(result.value).toMatchObject({ status: 'verified', expression: String.raw`j=\frac{I}{A}`, sourceTextAgreement: 'consistent', ambiguousSymbols: [] });
    expect(JSON.stringify(captured)).toContain('公式原图是转写权威');
    expect(JSON.stringify(captured)).toContain('"type":"image"');
  });

  it('downgrades a formula with any visual ambiguity or text-layer conflict', async () => {
    const generations = { runStructured: vi.fn(async () => ({
      id: 'formula-ambiguous', status: 'completed', usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, cacheHitTokens: 0, cacheMissTokens: 20, reasoningTokens: 0 }, attemptCount: 1, cacheHit: false,
      json: { status: 'verified', expression: String.raw`x_{1}=1`, ambiguousSymbols: ['x or χ'], sourceTextAgreement: 'conflict', variables: [{ symbol: 'x', meaning: 'state' }], assumptions: [], purpose: 'state relation', applicability: [], blockIds: ['main:b1'] },
    })) } as unknown as ModelGenerationService;

    const result = await runPaperReaderFormulaAnalysis(generations, {
      document, formulaId: 'E002', expression: 'x1=1', blocks: [{ id: 'main:b1', page: 2, type: 'paragraph', text: 'The state relation is defined here.' }], image, authorization, inputHash: 'formula-ambiguous-input',
    }, actor);
    expect(result.value.status).toBe('needs_review');
  });
});
