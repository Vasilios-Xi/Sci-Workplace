import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';
import type { BibliographicRecordV1, DocumentRevisionRef, ZoteroSyncPlanRequestV1 } from '@openlab/protocol';
import { validatePluginManifest } from '../src/extensions/plugin-manifest.js';
import { PluginManager } from '../src/extensions/plugin-manager.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { BibliographyService } from '../src/workbench/bibliography-service.js';
import { CitationDocumentService } from '../src/workbench/citation-document-service.js';
import { ZoteroHostService } from '../src/workbench/zotero-host-service.js';
import { RestrictedDocxZoteroProcessor, ZoteroHttpCitingAdapter } from '../src/workbench/zotero-document-processor-adapter.js';

const roots: string[] = [];

function temporaryDirectory(prefix = 'citation-workbench-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function docx(root: string): DocumentRevisionRef {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  zip.addFile('word/document.xml', Buffer.from([
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
    '<w:p><w:r><w:t xml:space="preserve">A precise claim is supported by [1], while </w:t></w:r><w:r><w:t>[XX]</w:t></w:r><w:r><w:t> must remain.</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>Body sentinel</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>References</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>[1] Smith J. A complete scholarly article title. Journal of Tests. 2024. doi:10.1234/example.</w:t></w:r></w:p>',
    '<w:sectPr/>',
    '</w:body></w:document>',
  ].join('')));
  const bytes = zip.toBuffer();
  const path = join(root, 'draft.docx');
  writeFileSync(path, bytes);
  return { ref: { rootId: 'project', path: 'draft.docx' }, sha256: digest(bytes), size: bytes.length, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
}

const RECORD: BibliographicRecordV1 = {
  schemaVersion: 1,
  canonicalId: 'doi:10.1234/example',
  itemType: 'journalArticle',
  title: 'A complete scholarly article title',
  creators: [{ family: 'Smith', given: 'J' }],
  issuedYear: 2024,
  containerTitle: 'Journal of Tests',
  doi: '10.1234/example',
  abstract: 'The study directly supports the precise claim.',
  retractionStatus: 'clear',
  source: 'crossref',
  sourceUrl: 'https://api.crossref.org/works/10.1234%2Fexample',
  retrievedAt: '2026-01-01T00:00:00.000Z',
};

describe('Citation document scanning and safe materialization', () => {
  it('treats a numeric cluster atomically, preserves placeholders, writes refreshable fields, and never mutates the source', () => {
    const root = temporaryDirectory();
    const source = docx(root);
    const service = new CitationDocumentService({ resolveRoot: () => root });
    const inspection = service.scan(source);
    const numeric = inspection.units.find((unit) => unit.kind === 'numeric-cluster');
    const placeholder = inspection.units.find((unit) => unit.kind === 'placeholder');
    const reference = inspection.units.find((unit) => unit.kind === 'reference-entry');
    expect(numeric).toMatchObject({ raw: '[1]', numericLabels: [1], identifiers: [{ doi: '10.1234/example' }], referenceOnly: false });
    expect(placeholder).toMatchObject({ raw: '[XX]', referenceOnly: false });
    expect(reference).toMatchObject({ referenceOnly: true, identifiers: [{ doi: '10.1234/example' }] });

    const plan = {
      schemaVersion: 1 as const,
      operationKey: 'acceptance-one',
      source,
      format: 'docx' as const,
      styleId: 'vancouver',
      styleFamily: 'numeric' as const,
      edits: inspection.units.map((unit) => unit.id === numeric?.id || unit.id === reference?.id ? {
        unitId: unit.id, originalText: unit.raw, displayText: '[1]', status: 'applied' as const, reason: 'verified', record: RECORD, records: [RECORD], zoteroItemKey: 'ITEMKEY1', zoteroItemUri: 'http://zotero.org/users/123/items/ITEMKEY1', zoteroItems: [{ key: 'ITEMKEY1', uri: 'http://zotero.org/users/123/items/ITEMKEY1' }],
      } : {
        unitId: unit.id, originalText: unit.raw, displayText: unit.raw, status: 'unrecognized' as const, reason: 'placeholder preserved',
      }),
      bibliographyPolicy: 'dynamic-resolved-with-unresolved-review' as const,
    };
    const first = service.materialize(plan);
    const second = service.materialize(plan);
    expect(first).toMatchObject({ readiness: 'partial_review_required', appliedCount: 2, skippedCount: 1, dynamicFieldCount: 1, bibliographyGenerated: true });
    expect(second.outputSha256).toBe(first.outputSha256);
    expect(digest(readFileSync(join(root, 'draft.docx')))).toBe(source.sha256);
    const output = new AdmZip(readFileSync(join(root, first.output.path))).readAsText('word/document.xml');
    expect(output).toContain('ADDIN ZOTERO_ITEM CSL_CITATION');
    expect(output).toContain('ADDIN ZOTERO_BIBL');
    expect(output).toContain('CSL_BIBLIOGRAPHY');
    expect(output).toContain('&quot;uncited&quot;:[[&quot;http://zotero.org/users/123/items/ITEMKEY1&quot;]]');
    expect(output).toContain('[XX]');
    expect(output).toContain('Body sentinel');
    expect(output).not.toContain('doi:10.1234/example');
    expect(output.match(/>References<\/w:t>/gu)).toHaveLength(1);
    expect(output).not.toContain('References requiring verification');
    const outputZip = new AdmZip(readFileSync(join(root, first.output.path)));
    expect(outputZip.readAsText('docProps/custom.xml')).toContain('ZOTERO_PREF_1');
    expect(outputZip.readAsText('docProps/custom.xml')).toContain('http://www.zotero.org/styles/vancouver');
    expect(outputZip.readAsText('[Content_Types].xml')).toContain('/docProps/custom.xml');
  });

  it('separates verified dynamic bibliography from preserved references requiring verification', () => {
    const root = temporaryDirectory();
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
    zip.addFile('word/document.xml', Buffer.from([
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
      '<w:p><w:r><w:t>References</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>[1] Smith J. A complete scholarly article title. Journal of Tests. 2024. doi:10.1234/example.</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>[2] Disputed A. A disputed article. 2024. doi:10.1234/disputed.</w:t></w:r></w:p>',
      '<w:sectPr/>',
      '</w:body></w:document>',
    ].join('')));
    const bytes = zip.toBuffer();
    writeFileSync(join(root, 'mixed.docx'), bytes);
    const source: DocumentRevisionRef = { ref: { rootId: 'project', path: 'mixed.docx' }, sha256: digest(bytes), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    const service = new CitationDocumentService({ resolveRoot: () => root });
    const inspection = service.scan(source);
    const first = inspection.units.find((unit) => unit.referenceOnly && unit.identifiers?.some((identifier) => identifier.doi === '10.1234/example'))!;
    const receipt = service.materialize({
      schemaVersion: 1, operationKey: 'mixed-bibliography', source, format: 'docx', styleId: 'vancouver', styleFamily: 'numeric', bibliographyPolicy: 'dynamic-resolved-with-unresolved-review',
      edits: inspection.units.map((unit) => unit.id === first.id
        ? { unitId: unit.id, originalText: unit.raw, displayText: '[1]', status: 'applied', reason: 'verified', record: RECORD, zoteroItemKey: 'ITEMKEY1', zoteroItemUri: 'http://zotero.org/users/123/items/ITEMKEY1' }
        : { unitId: unit.id, originalText: unit.raw, displayText: unit.raw, status: 'ambiguous', reason: 'multiple candidates' }),
    });
    const revised = new AdmZip(readFileSync(join(root, receipt.output.path))).readAsText('word/document.xml');
    expect(receipt.readiness).toBe('partial_review_required');
    expect(revised).toContain('References requiring verification');
    expect(revised).toContain('Verified references (Zotero)');
    expect(revised).toContain('[2] Disputed A. A disputed article. 2024. doi:10.1234/disputed.');
    expect(revised.match(/ADDIN ZOTERO_BIBL/gu)).toHaveLength(1);
    expect(revised.match(/ADDIN ZOTERO_ITEM CSL_CITATION/gu)).toHaveLength(1);
    expect(revised).toContain('&quot;dontUpdate&quot;:true');
    expect(revised).toContain('&quot;uncited&quot;:[[&quot;http://zotero.org/users/123/items/ITEMKEY1&quot;]]');
  });

  it('reuses an existing Zotero bibliography instead of inserting a duplicate', () => {
    const root = temporaryDirectory();
    const existingBibliography = '&quot;uncited&quot;:[],&quot;omitted&quot;:[],&quot;custom&quot;:[]';
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
    zip.addFile('word/document.xml', Buffer.from([
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
      '<w:p><w:r><w:t>References</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>[1] Smith J. A complete scholarly article title. Journal of Tests. 2024. doi:10.1234/example.</w:t></w:r></w:p>',
      `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_BIBL {${existingBibliography}} CSL_BIBLIOGRAPHY </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Existing bibliography</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
      '<w:sectPr/>',
      '</w:body></w:document>',
    ].join('')));
    const bytes = zip.toBuffer();
    writeFileSync(join(root, 'existing-bibliography.docx'), bytes);
    const source: DocumentRevisionRef = { ref: { rootId: 'project', path: 'existing-bibliography.docx' }, sha256: digest(bytes), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    const service = new CitationDocumentService({ resolveRoot: () => root });
    const inspection = service.scan(source);
    const reference = inspection.units.find((unit) => unit.referenceOnly && unit.identifiers?.some((identifier) => identifier.doi === '10.1234/example'))!;
    const receipt = service.materialize({
      schemaVersion: 1, operationKey: 'existing-bibliography', source, format: 'docx', styleId: 'vancouver', styleFamily: 'numeric', bibliographyPolicy: 'dynamic-resolved-with-unresolved-review',
      edits: inspection.units.map((unit) => unit.id === reference.id
        ? { unitId: unit.id, originalText: unit.raw, displayText: '[1]', status: 'applied', reason: 'verified', record: RECORD, zoteroItemKey: 'ITEMKEY1', zoteroItemUri: 'http://zotero.org/users/123/items/ITEMKEY1' }
        : { unitId: unit.id, originalText: unit.raw, displayText: unit.raw, status: 'unrecognized', reason: 'preserved' }),
    });
    const revised = new AdmZip(readFileSync(join(root, receipt.output.path))).readAsText('word/document.xml');
    expect(revised.match(/ADDIN ZOTERO_BIBL/gu)).toHaveLength(1);
    expect(revised.match(/ADDIN ZOTERO_ITEM CSL_CITATION/gu)).toHaveLength(1);
    expect(revised).toContain('&quot;dontUpdate&quot;:true');
    expect(revised.indexOf('<w:pPr>')).toBeLessThan(revised.indexOf('ADDIN ZOTERO_ITEM CSL_CITATION'));
    expect(receipt.dynamicFieldCount).toBe(1);
  });

  it('treats a standalone full title as identity data without inventing an author', () => {
    const root = temporaryDirectory();
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
    zip.addFile('word/document.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>34（A statistical understanding of oxygen vacancies in distorted high-entropy perovskite oxides ）</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'));
    const bytes = zip.toBuffer();
    writeFileSync(join(root, 'title.docx'), bytes);
    const source: DocumentRevisionRef = { ref: { rootId: 'project', path: 'title.docx' }, sha256: digest(bytes), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    const unit = new CitationDocumentService({ resolveRoot: () => root }).scan(source).units[0];
    expect(unit).toMatchObject({
      kind: 'title',
      raw: '34（A statistical understanding of oxygen vacancies in distorted high-entropy perovskite oxides ）',
      identifiers: [{ title: 'A statistical understanding of oxygen vacancies in distorted high-entropy perovskite oxides' }],
    });
    expect(unit?.identifiers?.[0]).not.toHaveProperty('firstAuthor');
    expect(unit?.identifiers?.[0]).not.toHaveProperty('year');
  });

  it('converts the complete nested EndNote field instead of nesting a Zotero field inside it', () => {
    const root = temporaryDirectory();
    const endNote = '&lt;EndNote&gt;&lt;Cite&gt;&lt;Author&gt;Smith&lt;/Author&gt;&lt;Year&gt;2024&lt;/Year&gt;&lt;RecNum&gt;42&lt;/RecNum&gt;&lt;record&gt;&lt;titles&gt;&lt;title&gt;A complete scholarly article title&lt;/title&gt;&lt;/titles&gt;&lt;electronic-resource-num&gt;10.1234/example&lt;/electronic-resource-num&gt;&lt;/record&gt;&lt;/Cite&gt;&lt;/EndNote&gt;';
    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
    zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">Claim </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN EN.CITE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN EN.CITE.DATA ${endNote}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`));
    const bytes = zip.toBuffer();
    writeFileSync(join(root, 'endnote.docx'), bytes);
    const source: DocumentRevisionRef = { ref: { rootId: 'project', path: 'endnote.docx' }, sha256: digest(bytes), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    const service = new CitationDocumentService({ resolveRoot: () => root });
    const inspection = service.scan(source);
    const unit = inspection.units.find((candidate) => candidate.kind === 'endnote-field')!;
    expect(unit).toMatchObject({ raw: '1', identifiers: [{ manager: 'endnote', managerKey: '42', doi: '10.1234/example', title: RECORD.title }] });
    const receipt = service.materialize({
      schemaVersion: 1, operationKey: 'endnote-complete-field', source, format: 'docx', styleId: 'vancouver', styleFamily: 'numeric', bibliographyPolicy: 'dynamic-resolved-with-unresolved-review',
      edits: [{ unitId: unit.id, originalText: unit.raw, displayText: '[1]', status: 'applied', reason: 'verified', record: RECORD, zoteroItemKey: 'ITEMKEY1', zoteroItemUri: 'http://zotero.org/users/123/items/ITEMKEY1' }],
    });
    const revised = new AdmZip(readFileSync(join(root, receipt.output.path))).readAsText('word/document.xml');
    expect(revised).toContain('Claim ');
    expect(revised).toContain('ADDIN ZOTERO_ITEM CSL_CITATION');
    expect(revised).not.toContain('ADDIN EN.CITE');
  });

  it('keeps Markdown and TeX placeholders unchanged while emitting their native citation syntax', () => {
    const root = temporaryDirectory();
    const service = new CitationDocumentService({ resolveRoot: () => root });
    for (const [name, text, expected] of [
      ['draft.md', 'Claim [1] and [XX].\n\nReferences\n\n[1] A complete scholarly article title. doi:10.1234/example.', '[@ITEMKEY1]'],
      ['draft.tex', 'Claim [1] and [XX].\n\nReferences\n\n[1] A complete scholarly article title. doi:10.1234/example.', '\\cite{ITEMKEY1}'],
    ] as const) {
      const bytes = Buffer.from(text);
      writeFileSync(join(root, name), bytes);
      const source: DocumentRevisionRef = { ref: { rootId: 'project', path: name }, sha256: digest(bytes) };
      const inspection = service.scan(source);
      const numeric = inspection.units.find((unit) => unit.kind === 'numeric-cluster');
      const receipt = service.materialize({
        schemaVersion: 1, operationKey: name, source, format: name.endsWith('.tex') ? 'tex' : 'markdown', styleId: 'vancouver', styleFamily: 'numeric', bibliographyPolicy: 'dynamic-resolved-with-unresolved-review',
        edits: inspection.units.map((unit) => unit.id === numeric?.id ? { unitId: unit.id, originalText: unit.raw, displayText: '[1]', status: 'applied', reason: 'verified', record: RECORD, zoteroItemKey: 'ITEMKEY1' } : { unitId: unit.id, originalText: unit.raw, displayText: unit.raw, status: 'unrecognized', reason: 'preserved' }),
      });
      const revised = readFileSync(join(root, receipt.output.path), 'utf8');
      expect(revised).toContain(expected);
      expect(revised).toContain('[XX]');
      expect(readFileSync(join(root, name), 'utf8')).toBe(text);
    }
  });

  it('runs a bounded Zotero HTTP refresh transaction against a new DOCX output', async () => {
    const root = temporaryDirectory();
    const source = docx(root);
    const documents = new CitationDocumentService({ resolveRoot: () => root });
    const inspection = documents.scan(source);
    const numeric = inspection.units.find((unit) => unit.kind === 'numeric-cluster')!;
    const reference = inspection.units.find((unit) => unit.kind === 'reference-entry')!;
    const materialized = documents.materialize({
      schemaVersion: 1, operationKey: 'http-refresh', source, format: 'docx', styleId: 'vancouver', styleFamily: 'numeric', bibliographyPolicy: 'dynamic-resolved-with-unresolved-review',
      edits: inspection.units.map((unit) => unit.id === numeric.id || unit.id === reference.id
        ? { unitId: unit.id, originalText: unit.raw, displayText: '[1]', status: 'applied', reason: 'verified', record: RECORD, zoteroItemKey: 'ITEMKEY1', zoteroItemUri: 'http://zotero.org/users/123/items/ITEMKEY1' }
        : { unitId: unit.id, originalText: unit.raw, displayText: unit.raw, status: 'unrecognized', reason: 'preserved' }),
    });
    const materializedPath = join(root, materialized.output.path);
    const refreshedPath = join(root, 'http-refreshed.docx');
    let phase = 0;
    let busyOnce = true;
    let protocolPreferences = '';
    let originalSessionId = '';
    let protocolCodes: string[] = [];
    let firstFieldId = '';
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path === '/connector/document/execCommand') {
        if (busyOnce) { busyOnce = false; return new Response('', { status: 503 }); }
        return Response.json({ command: 'Application.getActiveDocument', arguments: [] });
      }
      if (path !== '/connector/document/respond') throw new Error(`unexpected citing path ${path}`);
       const response = JSON.parse(String(init?.body)) as unknown;
       phase += 1;
       if (phase === 1) return Response.json({ command: 'Document.getDocumentData', arguments: [] });
       if (phase === 2) {
         protocolPreferences = String(response);
         originalSessionId = protocolPreferences.match(/<session\b[^>]*\bid="([^"]+)"/u)?.[1] ?? '';
         return Response.json({ command: 'Document.setDocumentData', arguments: ['citation-http-fixture', protocolPreferences.replace(/(<session\b[^>]*\bid=")[^"]*(")/u, '$1RANDOM_SESSION$2')] });
       }
       if (phase === 3) {
         return Response.json({ command: 'Document.getFields', arguments: ['Http'] });
       }
       if (phase === 4) {
         const fields = response as Array<{ id: string; code: string }>;
         protocolCodes = fields.map((field) => field.code);
         firstFieldId = fields[0]?.id ?? '';
         return Response.json({ command: 'Field.setCode', arguments: [firstFieldId, 'ITEM CSL_CITATION {"citationItems":[]}'] });
       }
       if (phase === 5) {
         return Response.json({ command: 'Field.setText', arguments: [firstFieldId, 'REFRESHED [1]', true] });
       }
      return Response.json({ command: 'Document.complete', arguments: [] });
    };
    const processor = new RestrictedDocxZoteroProcessor({ sourcePath: materializedPath, outputPath: refreshedPath, documentId: 'citation-http-fixture' });
    const receipt = await new ZoteroHttpCitingAdapter(fetch).refresh(processor);
    expect(receipt).toMatchObject({ completed: true, errorCount: 0, steps: 7 });
    expect(protocolPreferences).toContain('name="fieldType" value="Http"');
    expect(protocolCodes).toEqual(expect.arrayContaining([expect.stringMatching(/^ITEM CSL_CITATION/u), expect.stringMatching(/^BIBL /u)]));
    expect(protocolCodes.find((code) => code.startsWith('BIBL '))).toContain('http://zotero.org/users/123/items/ITEMKEY1');
    expect(new AdmZip(readFileSync(refreshedPath)).readAsText('word/document.xml')).toContain('REFRESHED [1]');
    expect(new AdmZip(readFileSync(refreshedPath)).readAsText('word/document.xml')).toContain('ADDIN ZOTERO_ITEM CSL_CITATION');
    expect(new AdmZip(readFileSync(materializedPath)).readAsText('word/document.xml')).not.toContain('REFRESHED [1]');
    const refreshedPreferences = new AdmZip(readFileSync(refreshedPath)).readAsText('docProps/custom.xml');
    expect(refreshedPreferences).toContain('name=&quot;fieldType&quot; value=&quot;Field&quot;');
    expect(refreshedPreferences).toContain(`id=&quot;${originalSessionId}&quot;`);
    expect(refreshedPreferences).not.toContain('RANDOM_SESSION');
  });

  it('does not report a completed refresh when Zotero sends a fatal integration alert', async () => {
    const root = temporaryDirectory();
    const source = docx(root);
    const documents = new CitationDocumentService({ resolveRoot: () => root });
    const inspection = documents.scan(source);
    const numeric = inspection.units.find((unit) => unit.kind === 'numeric-cluster')!;
    const materialized = documents.materialize({
      schemaVersion: 1, operationKey: 'http-fatal-alert', source, format: 'docx', styleId: 'vancouver', styleFamily: 'numeric', bibliographyPolicy: 'dynamic-resolved-with-unresolved-review',
      edits: inspection.units.map((unit) => unit.id === numeric.id
        ? { unitId: unit.id, originalText: unit.raw, displayText: '[1]', status: 'applied', reason: 'verified', record: RECORD, zoteroItemKey: 'ITEMKEY1' }
        : { unitId: unit.id, originalText: unit.raw, displayText: unit.raw, status: 'unrecognized', reason: 'preserved' }),
    });
    let phase = 0;
    const fetch = async (_input: string | URL | Request): Promise<Response> => {
      phase += 1;
      if (phase === 1) return Response.json({ command: 'Application.getActiveDocument', arguments: [] });
      if (phase === 2) return Response.json({ command: 'Document.displayAlert', arguments: ['fatal field mismatch', 0, 0] });
      return Response.json({ command: 'Document.complete', arguments: [] });
    };
    const receipt = await new ZoteroHttpCitingAdapter(fetch).refresh(new RestrictedDocxZoteroProcessor({ sourcePath: join(root, materialized.output.path), outputPath: join(root, 'fatal-refreshed.docx'), documentId: 'fatal-alert' }));
    expect(receipt).toMatchObject({ completed: false, errorCount: 1, alerts: [{ text: 'fatal field mismatch', icon: 0, buttons: 0 }] });
  });
});

describe('Deterministic bibliography and OA gates', () => {
  it('accepts only exact DOI/title metadata, surfaces retraction state, and downloads PDFs only from allowed OA repositories', async () => {
    const root = temporaryDirectory();
    const calls: string[] = [];
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('https://api.crossref.org/works/10.1234%2Fexample')) return Response.json({ message: { DOI: '10.1234/example', title: [RECORD.title], author: [{ family: 'Smith', given: 'J' }], issued: { 'date-parts': [[2024]] }, type: 'journal-article', abstract: '<jats:p>The study directly supports the precise claim.</jats:p>' } });
      if (url.includes('query.title=')) return Response.json({ message: { items: [{ DOI: '10.1234/example', title: [RECORD.title], author: [{ family: 'Smith', given: 'J' }], issued: { 'date-parts': [[2024]] }, type: 'journal-article' }] } });
      if (url.startsWith('https://api.openalex.org/')) return Response.json({ open_access: { is_oa: true }, best_oa_location: { pdf_url: 'https://arxiv.org/pdf/2401.00001.pdf', license: 'cc-by' } });
      if (url === 'https://arxiv.org/pdf/2401.00001.pdf') return new Response(Buffer.from('%PDF-1.7\nfixture'), { headers: { 'Content-Type': 'application/pdf', 'Content-Length': '16' } });
      throw new Error(`unexpected URL ${url}`);
    };
    const cacheRoot = join(root, 'cache');
    const service = new BibliographyService({ cacheRoot, fetch });
    const resolutions = await service.resolve({ queries: [
      { id: 'doi', raw: 'https://doi.org/10.1234/example.', doi: 'https://doi.org/10.1234/example.' },
      { id: 'title', raw: RECORD.title, title: RECORD.title },
      { id: 'fuzzy', raw: 'complete scholarly title', title: 'complete scholarly title' },
    ] });
    expect(resolutions[0]).toMatchObject({ status: 'resolved', match: 'exact_identifier', record: { doi: '10.1234/example' } });
    expect(resolutions[1]).toMatchObject({ status: 'resolved', match: 'exact_title' });
    expect(resolutions[2]?.status).not.toBe('resolved');
    expect(await service.verifyMetadata(RECORD)).toMatchObject({ status: 'verified', record: { retractionStatus: 'clear' } });
    const attachment = await service.fetchOpenAccess(RECORD);
    expect(attachment).toMatchObject({ status: 'downloaded', mediaType: 'application/pdf', license: 'cc-by' });
    expect(service.attachment(attachment.attachmentId!)).toMatchObject({ sha256: attachment.sha256, sourceUrl: 'https://arxiv.org/pdf/2401.00001.pdf' });
    expect(calls).toContain('https://arxiv.org/pdf/2401.00001.pdf');
    const afterRestart = await new BibliographyService({ cacheRoot, fetch }).fetchOpenAccess(RECORD);
    expect(afterRestart).toMatchObject({ status: 'available', attachmentId: attachment.attachmentId, sha256: attachment.sha256 });
  });

  it('rejects an OA URL outside the bounded repository allowlist', async () => {
    const root = temporaryDirectory();
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.startsWith('https://api.openalex.org/')) return Response.json({ open_access: { is_oa: true }, best_oa_location: { pdf_url: 'https://untrusted.example/paper.pdf', license: 'cc-by' } });
      throw new Error('must not fetch untrusted OA URL');
    };
    const receipt = await new BibliographyService({ cacheRoot: join(root, 'cache'), fetch }).fetchOpenAccess(RECORD);
    expect(receipt).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/允许/u) });
  });

  it('enforces the metadata response limit while a body is streaming without Content-Length', async () => {
    const root = temporaryDirectory();
    let cancellations = 0;
    const fetch = async (): Promise<Response> => {
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(5 * 1024 * 1024));
        },
        cancel() { cancellations += 1; },
      }), { headers: { 'Content-Type': 'application/json' } });
    };
    const [resolution] = await new BibliographyService({ cacheRoot: join(root, 'cache'), fetch }).resolve({
      queries: [{ id: 'oversized', raw: 'doi:10.1234/example', doi: '10.1234/example' }],
    });
    expect(resolution).toMatchObject({ status: 'unrecognized', issues: [expect.stringMatching(/8 MB/u)] });
    expect(cancellations).toBeGreaterThan(0);
  });
});

function syncRequest(operationKey: string): ZoteroSyncPlanRequestV1 {
  return { schemaVersion: 1, operationKey, sourceSha256: 'a'.repeat(64), target: { rootName: 'Sci Workplace', childName: 'Draft · References' }, items: [{ record: RECORD }] };
}

describe.each(['companion', 'native'] as const)('Zotero %s provider contract', (provider) => {
  it('uses preview/commit and makes repeated commits idempotent', async () => {
    const root = temporaryDirectory(`zotero-${provider}-`);
    const documents = new CitationDocumentService({ resolveRoot: () => root });
    let syncWrites = 0;
    let itemWrites = 0;
    let collectionWrites = 0;
    let collectionIndex = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      if (path === '/sci-workplace/v1/status') return provider === 'companion' ? Response.json({ version: '9.0.6' }) : new Response('', { status: 404 });
      if (provider === 'companion') {
        if (path === '/sci-workplace/v1/pair') {
          const body = JSON.parse(String(init?.body)) as { nonce: string };
          return Response.json({ sessionKey: 's'.repeat(48), nonce: body.nonce });
        }
        if (path === '/sci-workplace/v1/search') return Response.json({ items: [] });
        if (path === '/sci-workplace/v1/sync') {
          syncWrites += 1;
          const body = JSON.parse(String(init?.body)) as { request: ZoteroSyncPlanRequestV1 };
          return Response.json({ schemaVersion: 1, operationKey: body.request.operationKey, collectionKey: 'COLLKEY1', collectionName: body.request.target.childName, items: [{ canonicalId: RECORD.canonicalId, status: 'created', itemKey: 'ITEMKEY1', itemUri: 'http://zotero.org/users/local/items/ITEMKEY1' }], committedAt: '2026-01-01T00:00:00.000Z', mode: 'companion' });
        }
      } else {
        if (path === '/api/') return new Response('{}', { headers: { 'Zotero-Server-ID': 'server-one', 'Zotero-Version': '10.0.1' } });
        if (path.startsWith('/api/users/0/items?')) return Response.json([]);
        if (path === '/api/local/authorize') return Response.json({ key: 'k'.repeat(32), remember: true });
        if (path === '/api/users/0/collections?format=json') return Response.json([]);
        if (path === '/api/users/0/collections' && init?.method === 'POST') {
          collectionWrites += 1;
          collectionIndex += 1;
          const name = (JSON.parse(String(init.body)) as Array<{ name: string }>)[0]!.name;
          return Response.json({ successful: { '0': { key: `COLL${collectionIndex}`, data: { key: `COLL${collectionIndex}`, name } } } });
        }
        if (path === '/api/users/0/items' && init?.method === 'POST') {
          itemWrites += 1;
          return Response.json({ successful: { '0': { key: 'ITEMKEY1', data: { key: 'ITEMKEY1' } } } });
        }
        if (path === '/api/users/0/items/ITEMKEY1?format=csljson') return Response.json([{ id: 'http://zotero.org/users/123/items/ITEMKEY1' }]);
      }
      throw new Error(`unexpected Zotero request ${provider} ${path}`);
    };
    const service = new ZoteroHostService({ documents, attachment: () => undefined, fetch });
    const firstPlan = await service.planSync(syncRequest(`operation-${provider}`));
    expect(firstPlan.operations).toEqual([{ canonicalId: RECORD.canonicalId, action: 'create', attachmentCount: 0 }]);
    expect((await service.planSync(syncRequest(`operation-${provider}`))).id).toBe(firstPlan.id);
    const first = await service.commitSync(firstPlan.id, true);
    const second = await service.commitSync(firstPlan.id, true);
    expect(second).toEqual(first);
    expect(first.items).toEqual([expect.objectContaining({ status: 'created', itemKey: 'ITEMKEY1' })]);
    if (provider === 'companion') expect(syncWrites).toBe(1);
    else {
      expect(itemWrites).toBe(1);
      expect(collectionWrites).toBe(2);
    }
  });
});

describe('Zotero companion pairing', () => {
  it('uses a user-confirmation timeout independent from ordinary local requests', async () => {
    const root = temporaryDirectory('zotero-pairing-timeout-');
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path === '/sci-workplace/v1/status') return Response.json({ version: '9.0.6' });
      if (path === '/sci-workplace/v1/pair') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 30);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          }, { once: true });
        });
        const body = JSON.parse(String(init?.body)) as { nonce: string };
        return Response.json({ sessionKey: 's'.repeat(48), nonce: body.nonce });
      }
      if (path === '/sci-workplace/v1/search') return Response.json({ items: [] });
      if (path === '/sci-workplace/v1/sync') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 30);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          }, { once: true });
        });
        const body = JSON.parse(String(init?.body)) as { request: ZoteroSyncPlanRequestV1 };
        return Response.json({ schemaVersion: 1, operationKey: body.request.operationKey, collectionKey: 'PAIRCOLL', collectionName: body.request.target.childName, items: [{ canonicalId: RECORD.canonicalId, status: 'created', itemKey: 'PAIRITEM', itemUri: 'http://zotero.org/users/local/items/PAIRITEM' }], committedAt: '2026-01-01T00:00:00.000Z', mode: 'companion' });
      }
      throw new Error(`unexpected companion request ${path}`);
    };
    const service = new ZoteroHostService({
      documents: new CitationDocumentService({ resolveRoot: () => root }),
      attachment: () => undefined,
      fetch,
      requestTimeoutMs: 5,
      pairingTimeoutMs: 100,
      syncTimeoutMs: 100,
    });
    await expect(service.search({ title: RECORD.title })).resolves.toEqual([]);
    const plan = await service.planSync(syncRequest('long-confirmation-and-sync'));
    await expect(service.commitSync(plan.id, true)).resolves.toMatchObject({ collectionKey: 'PAIRCOLL', items: [{ itemKey: 'PAIRITEM' }] });
  });
});

describe('Zotero native attachment idempotency across Harness restarts', () => {
  it('reuses the SHA-tagged attachment instead of creating another child item', async () => {
    const root = temporaryDirectory('zotero-attachment-');
    const attachmentPath = join(root, 'fixture.pdf');
    const attachmentBytes = Buffer.from('%PDF-1.7\nfixture');
    writeFileSync(attachmentPath, attachmentBytes);
    const attachmentSha = digest(attachmentBytes);
    let attachmentExists = false;
    let attachmentWrites = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      if (path === '/sci-workplace/v1/status') return new Response('', { status: 404 });
      if (path === '/api/') return new Response('{}', { headers: { 'Zotero-Server-ID': 'server-one', 'Zotero-Version': '10.0.1' } });
      if (path.startsWith('/api/users/0/items?')) return Response.json([{ key: 'ITEMKEY1', version: 1, data: { key: 'ITEMKEY1', itemType: 'journalArticle', title: RECORD.title, creators: [{ lastName: 'Smith', firstName: 'J' }], date: '2024', DOI: RECORD.doi, collections: ['COLL2'] } }]);
      if (path === '/api/users/0/items/ITEMKEY1') return Response.json({ key: 'ITEMKEY1', version: 1, data: { key: 'ITEMKEY1', itemType: 'journalArticle', title: RECORD.title, creators: [{ lastName: 'Smith', firstName: 'J' }], date: '2024', DOI: RECORD.doi, collections: ['COLL2'] } });
      if (path === '/api/users/0/collections?format=json') return Response.json([{ key: 'COLL2', data: { key: 'COLL2', name: 'Draft · References', parentCollection: 'COLL1' } }]);
      if (path === '/api/users/0/items/ITEMKEY1/children?format=json&itemType=attachment&limit=100') return Response.json(attachmentExists ? [{ key: 'ATTACH1', data: { key: 'ATTACH1', title: 'Open-access full text', note: `Sci-Workplace-OA-SHA256: ${attachmentSha}`, tags: [{ tag: `sci-workplace-oa:${attachmentSha}` }] } }] : []);
      if (path === '/api/local/authorize') return Response.json({ key: 'k'.repeat(32), remember: true });
      if (path === '/api/users/0/items' && init?.method === 'POST') {
        attachmentWrites += 1;
        attachmentExists = true;
        return Response.json({ successful: { '0': { key: 'ATTACH1', data: { key: 'ATTACH1' } } } });
      }
      if (path === '/api/users/0/items/ATTACH1/file') return Response.json({ exists: 1 });
      if (path === '/api/users/0/items/ITEMKEY1?format=csljson') return Response.json([{ id: 'http://zotero.org/users/123/items/ITEMKEY1' }]);
      throw new Error(`unexpected native attachment request ${path}`);
    };
    const request: ZoteroSyncPlanRequestV1 = {
      schemaVersion: 1, operationKey: 'restart-safe-attachment', sourceSha256: 'b'.repeat(64), target: { rootName: 'Sci Workplace', childName: 'Draft · References', collectionKey: 'COLL2' }, items: [{ record: RECORD, attachmentIds: ['oa-fixture'] }],
    };
    const createService = () => new ZoteroHostService({
      documents: new CitationDocumentService({ resolveRoot: () => root }),
      attachment: (id) => id === 'oa-fixture' ? { id, path: attachmentPath, sha256: attachmentSha, sourceUrl: 'https://arxiv.org/pdf/fixture.pdf', mediaType: 'application/pdf', license: 'cc-by', size: attachmentBytes.length } : undefined,
      fetch,
    });
    const firstService = createService();
    const first = await firstService.commitSync((await firstService.planSync(request)).id, true);
    const secondService = createService();
    const second = await secondService.commitSync((await secondService.planSync(request)).id, true);
    expect(first.items[0]).toMatchObject({ status: 'reused', attachmentKeys: ['ATTACH1'] });
    expect(second.items[0]).toMatchObject({ status: 'reused', attachmentKeys: ['ATTACH1'] });
    expect(attachmentWrites).toBe(1);
  });
});

describe('bundled Citation Workbench plugin boundary', () => {
  it('loads as trusted and default-enabled without raw network/process permissions', async () => {
    const repository = join(import.meta.dirname, '..', '..', '..');
    const pluginRoot = join(repository, 'packages', 'citation-plugin');
    const manifest = validatePluginManifest(JSON.parse(readFileSync(join(pluginRoot, 'manifest.json'), 'utf8')), pluginRoot);
    expect(manifest.id).toBe('sci.citation-workbench');
    expect(manifest.permissions).toEqual(expect.arrayContaining(['bibliography:resolve', 'zotero:write', 'zotero:documents']));
    expect(manifest.permissions).not.toEqual(expect.arrayContaining(['network', 'process:spawn', 'project:write']));
    const projectRoot = temporaryDirectory('citation-bundled-project-');
    mkdirSync(projectRoot, { recursive: true });
    const manager = new PluginManager({ userRoot: join(projectRoot, '.user-plugins'), projectRoot, projectId: 'citation-project', registry: new ToolRegistry(), bundledRoots: [pluginRoot], hostHandler: async () => [] });
    try {
      expect(manager.list()).toEqual([expect.objectContaining({ manifest: expect.objectContaining({ id: 'sci.citation-workbench' }), scope: 'bundled', trusted: true, enabled: true, integrity: 'verified' })]);
      await manager.activateEnabled();
      expect(manager.workbenchBlueprints()).toEqual([expect.objectContaining({ id: 'sci.citation-workbench:submission-citations' })]);
      await expect(manager.uninstall('sci.citation-workbench')).rejects.toThrow(/bundled/u);
    } finally {
      await manager.stop();
    }
  }, 20_000);
});
