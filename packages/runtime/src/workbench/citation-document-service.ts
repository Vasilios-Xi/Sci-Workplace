import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import AdmZip from 'adm-zip';
import type {
  CitationDocumentEditV1,
  CitationDocumentInspectionV1,
  CitationDocumentPlanV1,
  CitationDocumentUnitV1,
  CitationIdentifierV1,
  CitationMaterializationReceiptV1,
  CitationSourceFormatV1,
  CitationUnitKindV1,
  DocumentRevisionRef,
} from '@openlab/protocol';
import { PathGuard } from '../security/path-guard.js';

const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOI_PATTERN = /(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)?(10\.\d{4,9}\/[A-Z0-9._;()/:+-]+)/giu;
const PMID_PATTERN = /\bPMID\s*:\s*(\d{5,9})\b/giu;
const ARXIV_PATTERN = /\b(?:arXiv\s*:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?)\b/giu;
const PLACEHOLDER_PATTERN = /\[\s*XX\s*\]|找参考文献/giu;
const NUMERIC_CLUSTER_PATTERN = /\[(\s*\d+(?:\s*[-–—,;]\s*\d+)*\s*)\]/gu;
const AUTHOR_DATE_PATTERN = /\((?:[A-ZÀ-ÖØ-Þ\u4e00-\u9fff][^();]{1,50}?\s+(?:et\s+al\.?\s*,?\s*)?\d{4}[a-z]?(?:\s*;\s*)?)+\)/gu;
const REFERENCE_HEADING_PATTERN = /^(?:references?|bibliography|参考文献)$/iu;
const MAX_DOCUMENT_BYTES = 96 * 1024 * 1024;

interface Paragraph {
  xml: string;
  text: string;
  index: number;
  start: number;
  end: number;
}

interface Candidate {
  start: number;
  end: number;
  raw: string;
  kind: CitationUnitKindV1;
  identifiers?: CitationIdentifierV1[];
  numericLabels?: number[];
  xmlStart?: number;
  xmlEnd?: number;
  priority: number;
}

interface DocxPart {
  name: string;
  xml: string;
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function normalizeTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableUnitId(sourceSha: string, part: string, paragraphIndex: number, start: number, end: number, raw: string): string {
  return `cite_${sha256(`${sourceSha}\0${part}\0${paragraphIndex}\0${start}\0${end}\0${raw}`).slice(0, 24)}`;
}

function paragraphs(xml: string): Paragraph[] {
  const output: Paragraph[] = [];
  const pattern = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/gu;
  for (const match of xml.matchAll(pattern)) {
    const paragraphXml = match[0];
    const text = [...paragraphXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)].map((item) => decodeXml(item[1] ?? '')).join('');
    output.push({ xml: paragraphXml, text, index: output.length, start: match.index, end: match.index + paragraphXml.length });
  }
  return output;
}

function numericLabels(value: string): number[] {
  const labels: number[] = [];
  for (const token of value.split(/\s*[,;]\s*/u)) {
    const range = token.match(/^(\d+)\s*[-–—]\s*(\d+)$/u);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end >= start && end - start <= 100) for (let label = start; label <= end; label += 1) labels.push(label);
      continue;
    }
    if (/^\d+$/u.test(token)) labels.push(Number(token));
  }
  return [...new Set(labels)];
}

function referenceLabel(value: string): number | undefined {
  const match = value.match(/^\s*(?:\[\s*(\d+)\s*\]|\(\s*(\d+)\s*\)|（\s*(\d+)\s*）|(\d+)[.)](?!\d))\s*/u);
  const label = Number(match?.slice(1).find(Boolean));
  return Number.isSafeInteger(label) && label > 0 ? label : undefined;
}

function stripReferenceLabel(value: string): string {
  const wrappedTitle = value.match(/^\s*\d+\s*[（(]\s*/u);
  if (wrappedTitle?.index === 0) return value.slice(wrappedTitle[0].length).replace(/\s*[）)]\s*$/u, '').trim();
  return value.replace(/^\s*(?:\[\s*\d+\s*\]|\(\s*\d+\s*\)|（\s*\d+\s*）|\d+[.)](?!\d))\s*/u, '').trim();
}

function cleanDoiCandidate(value: string): string {
  let candidate = value.trim();
  const joinedDoi = candidate.search(/\.doi\s*:/iu);
  if (joinedDoi >= 0) candidate = candidate.slice(0, joinedDoi);
  candidate = candidate.replace(/(\d)\.[\p{Lu}][\p{Ll}'’-]{1,30}$/u, '$1');
  while (candidate.endsWith(')') && (candidate.match(/\)/gu)?.length ?? 0) > (candidate.match(/\(/gu)?.length ?? 0)) candidate = candidate.slice(0, -1);
  return candidate.replace(/[.,;:]+$/u, '').toLocaleLowerCase();
}

function doiMatches(text: string): Array<{ start: number; end: number; raw: string; doi: string }> {
  DOI_PATTERN.lastIndex = 0;
  const output: Array<{ start: number; end: number; raw: string; doi: string }> = [];
  for (const match of text.matchAll(DOI_PATTERN)) {
    const captured = match[1] ?? '';
    const doi = cleanDoiCandidate(captured);
    if (!/^10\.\d{4,9}\/.+/u.test(doi)) continue;
    const capturedOffset = match[0].indexOf(captured);
    const end = match.index + capturedOffset + doi.length;
    output.push({ start: match.index, end, raw: text.slice(match.index, end), doi });
  }
  return output;
}

function identifiersFromText(raw: string, titleFallback = false): CitationIdentifierV1[] {
  const dois = [...new Set(doiMatches(raw).map((match) => match.doi))];
  const pmids = [...new Set([...raw.matchAll(PMID_PATTERN)].map((match) => match[1]).filter((value): value is string => Boolean(value)))];
  const arxivIds = [...new Set([...raw.matchAll(ARXIV_PATTERN)].map((match) => match[1]?.replace(/v\d+$/iu, '')).filter((value): value is string => Boolean(value)))];
  const year = [...raw.matchAll(/\b(?:19|20)\d{2}\b/gu)].at(-1)?.[0];
  const firstAuthor = stripReferenceLabel(raw).match(/^([\p{L}'’-]{2,})/u)?.[1];
  const identifierCount = dois.length + pmids.length + arxivIds.length;
  if (identifierCount === 1) return [{ ...(dois[0] ? { doi: dois[0] } : {}), ...(pmids[0] ? { pmid: pmids[0] } : {}), ...(arxivIds[0] ? { arxivId: arxivIds[0] } : {}), ...(year ? { year: Number(year) } : {}), ...(firstAuthor ? { firstAuthor } : {}) }];
  if (identifierCount > 1) return [...dois.map((doi) => ({ doi })), ...pmids.map((pmid) => ({ pmid })), ...arxivIds.map((arxivId) => ({ arxivId }))];
  if (!titleFallback) return [];
  const withoutLabel = stripReferenceLabel(raw).replace(/https?:\/\/\S+/giu, '').trim();
  const sentenceCandidates = withoutLabel.split(/\.\s+/u).map((item) => item.trim()).filter((item) => {
    const words = item.split(/\s+/u).filter(Boolean);
    return item.length >= 18 && words.length >= 3 && !/^https?:/iu.test(item) && !/^(?:vol\.?|doi\b|pmid\b)/iu.test(item);
  });
  const likelyTitle = sentenceCandidates.length > 1
    ? sentenceCandidates.slice(1).sort((left, right) => right.length - left.length)[0]
    : sentenceCandidates[0];
  if (!likelyTitle) return [];
  return [{ title: likelyTitle.replace(/[.;,]+$/u, '').trim(), ...(year ? { year: Number(year) } : {}), ...(firstAuthor ? { firstAuthor } : {}) }];
}

function plainXml(value: string): string {
  return decodeXml(value.replace(/<[^>]+>/gu, '')).replace(/\s+/gu, ' ').trim();
}

function endNoteIdentifiers(code: string): CitationIdentifierV1[] {
  const decoded = decodeXml(code);
  const citeBlocks = [...decoded.matchAll(/<Cite\b[^>]*>([\s\S]*?)<\/Cite>/giu)].map((match) => match[0]);
  const output: CitationIdentifierV1[] = [];
  for (const block of citeBlocks) {
    const embedded = identifiersFromText(block, false);
    const recNum = block.match(/<(?:RecNum|rec-number)>(\d+)<\/(?:RecNum|rec-number)>/iu)?.[1];
    const titleXml = block.match(/<title>([\s\S]*?)<\/title>/iu)?.[1];
    const title = titleXml ? plainXml(titleXml) : undefined;
    const year = Number(block.match(/<(?:Year|year)>(\d{4})<\/(?:Year|year)>/iu)?.[1] ?? 0) || undefined;
    const firstAuthor = plainXml(block.match(/<(?:Author|author)>([\s\S]*?)<\/(?:Author|author)>/iu)?.[1] ?? '').split(',')[0]?.trim() || undefined;
    const base = embedded[0] ?? (title ? { title } : {});
    if (Object.keys(base).length > 0 || recNum) output.push({ manager: 'endnote', ...(recNum ? { managerKey: recNum } : {}), ...base, ...(title && !base.title ? { title } : {}), ...(year ? { year } : {}), ...(firstAuthor ? { firstAuthor } : {}) });
  }
  return [...new Map(output.map((identifier) => [JSON.stringify(identifier), identifier])).values()];
}

function zoteroIdentifiers(code: string): CitationIdentifierV1[] {
  const marker = code.indexOf('CSL_CITATION');
  const start = code.indexOf('{', marker);
  const end = code.lastIndexOf('}');
  if (marker < 0 || start < 0 || end <= start) return [];
  try {
    const citation = JSON.parse(code.slice(start, end + 1)) as Record<string, unknown>;
    const items = Array.isArray(citation.citationItems) ? citation.citationItems : [];
    return items.flatMap((value): CitationIdentifierV1[] => {
      if (typeof value !== 'object' || value === null) return [];
      const item = value as Record<string, unknown>;
      const data = typeof item.itemData === 'object' && item.itemData !== null ? item.itemData as Record<string, unknown> : {};
      const creators = Array.isArray(data.author) ? data.author : [];
      const first = typeof creators[0] === 'object' && creators[0] !== null ? creators[0] as Record<string, unknown> : {};
      const issued = typeof data.issued === 'object' && data.issued !== null ? data.issued as Record<string, unknown> : {};
      const dateParts = Array.isArray(issued['date-parts']) ? issued['date-parts'] as unknown[] : [];
      const firstDate = Array.isArray(dateParts[0]) ? dateParts[0] as unknown[] : [];
      const uri = Array.isArray(item.uris) ? item.uris.find((entry): entry is string => typeof entry === 'string') : undefined;
      const managerKey = String(item.id ?? uri?.match(/\/items\/([A-Z0-9]+)$/iu)?.[1] ?? '').trim();
      const doi = typeof data.DOI === 'string' ? cleanDoiCandidate(data.DOI) : undefined;
      const title = typeof data.title === 'string' ? data.title.trim() : undefined;
      if (!managerKey && !doi && !title) return [];
      return [{ manager: 'zotero', ...(managerKey ? { managerKey } : {}), ...(doi ? { doi } : {}), ...(title ? { title } : {}), ...(Number.isInteger(Number(firstDate[0])) ? { year: Number(firstDate[0]) } : {}), ...(typeof first.family === 'string' ? { firstAuthor: first.family } : {}) }];
    });
  } catch { return []; }
}

function addMatches(output: Candidate[], text: string, pattern: RegExp, kind: CitationUnitKindV1, priority: number, mapper?: (match: RegExpMatchArray) => Partial<Candidate>): void {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const start = match.index;
    output.push({ start, end: start + raw.length, raw, kind, priority, ...mapper?.(match) });
  }
}

function xmlVisibleText(value: string): string {
  return [...value.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)].map((match) => decodeXml(match[1] ?? '')).join('');
}

function fieldCandidates(paragraphXml: string, referenceIdentifiers: Map<number, CitationIdentifierV1[]>): Candidate[] {
  const markers = [...paragraphXml.matchAll(/<w:fldChar\b[^>]*w:fldCharType=["'](begin|separate|end)["'][^>]*\/?\s*>/gu)];
  const stack: Array<{ begin: RegExpMatchArray; separate?: RegExpMatchArray }> = [];
  const output: Candidate[] = [];
  for (const marker of markers) {
    if (marker[1] === 'begin') { stack.push({ begin: marker }); continue; }
    const current = stack.at(-1);
    if (!current) continue;
    if (marker[1] === 'separate') { current.separate = marker; continue; }
    stack.pop();
    if (!current.separate || current.begin.index === undefined || current.separate.index === undefined || marker.index === undefined) continue;
    const codeRegion = paragraphXml.slice(current.begin.index + current.begin[0].length, current.separate.index);
    const code = [...codeRegion.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/gu)].map((match) => decodeXml(match[1] ?? '')).join(' ');
    const isEndNote = /ADDIN\s+EN\.CITE\b/iu.test(code);
    const isZotero = /ADDIN\s+ZOTERO_ITEM\b/iu.test(code);
    if (!isEndNote && !isZotero) continue;
    const resultStart = current.separate.index + current.separate[0].length;
    const resultXml = paragraphXml.slice(resultStart, marker.index);
    const resultText = xmlVisibleText(resultXml);
    const raw = resultText.trim();
    if (!raw) continue;
    const start = xmlVisibleText(paragraphXml.slice(0, resultStart)).length + resultText.indexOf(raw);
    const xmlStart = paragraphXml.lastIndexOf('<w:r', current.begin.index);
    const endRun = paragraphXml.indexOf('</w:r>', marker.index);
    if (xmlStart < 0 || endRun < 0) continue;
    const labels = numericLabels(raw.replace(/^\[|\]$/gu, ''));
    const embedded = isEndNote ? endNoteIdentifiers(code) : zoteroIdentifiers(code);
    output.push({
      start,
      end: start + raw.length,
      raw,
      kind: isEndNote ? 'endnote-field' : 'zotero-field',
      ...(labels.length > 0 ? { numericLabels: labels } : {}),
      identifiers: embedded.length > 0 ? embedded : labels.flatMap((label) => referenceIdentifiers.get(label) ?? []),
      xmlStart,
      xmlEnd: endRun + '</w:r>'.length,
      priority: 120,
    });
  }
  return output;
}

function superscriptCandidates(paragraphXml: string, visibleText: string): Candidate[] {
  const output: Candidate[] = [];
  let searchFrom = 0;
  for (const match of paragraphXml.matchAll(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/gu)) {
    const run = match[0];
    const runText = [...run.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)].map((item) => decodeXml(item[1] ?? '')).join('');
    if (!runText) continue;
    const offset = visibleText.indexOf(runText, searchFrom);
    if (offset >= 0) searchFrom = offset + runText.length;
    const before = visibleText.slice(Math.max(0, offset - 12), offset);
    const after = visibleText.slice(offset + runText.length, offset + runText.length + 4);
    if (offset < 0 || !/<w:vertAlign\b[^>]*w:val=["']superscript["']/iu.test(run) || !/^\s*\d+(?:\s*[-–—,;]\s*\d+)*\s*$/u.test(runText)) continue;
    if (/[A-Za-zΑ-ω]\s*$/u.test(before) || /^\s*[A-Za-zΑ-ω\d]/u.test(after)) continue;
    output.push({ start: offset, end: offset + runText.length, raw: runText, kind: 'numeric-cluster', numericLabels: numericLabels(runText), priority: 70 });
  }
  return output;
}

function nonOverlapping(candidates: Candidate[]): Candidate[] {
  const accepted: Candidate[] = [];
  for (const candidate of [...candidates].sort((left, right) => right.priority - left.priority || left.start - right.start || right.end - left.end)) {
    if (accepted.some((item) => candidate.start < item.end && candidate.end > item.start)) continue;
    accepted.push(candidate);
  }
  return accepted.sort((left, right) => left.start - right.start);
}

function scanTextPart(part: string, xml: string, sourceSha: string): CitationDocumentUnitV1[] {
  const units: CitationDocumentUnitV1[] = [];
  const items = paragraphs(xml);
  let referenceSection = false;
  const referenceIdentifiers = new Map<number, CitationIdentifierV1[]>();
  let pendingReference: { label: number; text: string } | undefined;
  const flushReference = () => {
    if (!pendingReference) return;
    referenceIdentifiers.set(pendingReference.label, identifiersFromText(pendingReference.text, true));
    pendingReference = undefined;
  };
  for (const paragraph of items) {
    const trimmed = paragraph.text.trim();
    if (REFERENCE_HEADING_PATTERN.test(trimmed)) { flushReference(); referenceSection = true; continue; }
    if (!referenceSection || !trimmed) continue;
    const label = referenceLabel(trimmed);
    if (label) {
      flushReference();
      pendingReference = { label, text: trimmed };
    } else if (pendingReference) pendingReference.text += ` ${trimmed}`;
  }
  flushReference();

  referenceSection = false;
  for (const paragraph of items) {
    const trimmed = paragraph.text.trim();
    if (REFERENCE_HEADING_PATTERN.test(trimmed)) { referenceSection = true; continue; }
    if (!trimmed) continue;
    const candidates: Candidate[] = [...fieldCandidates(paragraph.xml, referenceIdentifiers), ...superscriptCandidates(paragraph.xml, paragraph.text)];
    addMatches(candidates, paragraph.text, PLACEHOLDER_PATTERN, 'placeholder', 130);
    for (const match of doiMatches(paragraph.text)) candidates.push({ ...match, kind: 'doi', identifiers: [{ doi: match.doi }], priority: 90 });
    addMatches(candidates, paragraph.text, PMID_PATTERN, 'pmid', 90, (match) => ({ identifiers: [{ pmid: match[1] ?? '' }] }));
    addMatches(candidates, paragraph.text, ARXIV_PATTERN, 'arxiv', 85, (match) => ({ identifiers: [{ arxivId: (match[1] ?? '').replace(/v\d+$/iu, '') }] }));
    addMatches(candidates, paragraph.text, NUMERIC_CLUSTER_PATTERN, 'numeric-cluster', 65, (match) => {
      const labels = numericLabels(match[1] ?? '');
      return { numericLabels: labels, identifiers: labels.flatMap((label) => referenceIdentifiers.get(label) ?? []) };
    });
    addMatches(candidates, paragraph.text, AUTHOR_DATE_PATTERN, 'author-date', 50, (match) => ({ identifiers: identifiersFromText(match[0], false) }));
    if (referenceSection) {
      const exactIdentifiers = identifiersFromText(trimmed, false);
      const doiOccurrences = doiMatches(trimmed);
      const residueAfterLastDoi = doiOccurrences.length > 0 ? trimmed.slice(doiOccurrences.at(-1)!.end).trim() : '';
      const canTreatAsOneEntry = exactIdentifiers.length === 0 || (exactIdentifiers.length === 1 && residueAfterLastDoi.length <= 16);
      if (canTreatAsOneEntry) {
        const start = paragraph.text.indexOf(trimmed);
        candidates.push({ start, end: start + trimmed.length, raw: trimmed, kind: 'reference-entry', identifiers: exactIdentifiers.length > 0 ? exactIdentifiers : identifiersFromText(trimmed, true), priority: 110 });
      }
    } else if (candidates.length === 0 && trimmed.length >= 30 && trimmed.length <= 300 && !/[\u3400-\u9fff]/u.test(trimmed) && (trimmed.match(/[A-Za-z]+/gu)?.length ?? 0) >= 6 && !/[.!?]\s+.+[.!?]/u.test(trimmed)) {
      const title = stripReferenceLabel(trimmed).replace(/[.;,]+$/u, '').trim();
      if (title.length >= 18) {
        const start = paragraph.text.indexOf(trimmed);
        candidates.push({ start, end: start + trimmed.length, raw: trimmed, kind: 'title', identifiers: [{ title }], priority: 10 });
      }
    }

    for (const candidate of nonOverlapping(candidates)) {
      const contextStart = Math.max(0, candidate.start - 280);
      const contextEnd = Math.min(paragraph.text.length, candidate.end + 280);
      units.push({
        id: stableUnitId(sourceSha, part, paragraph.index, candidate.start, candidate.end, candidate.raw),
        part,
        paragraphIndex: paragraph.index,
        start: candidate.start,
        end: candidate.end,
        raw: candidate.raw,
        context: paragraph.text.slice(contextStart, contextEnd),
        kind: candidate.kind,
        referenceOnly: referenceSection || candidate.kind === 'reference-entry',
        ...(candidate.identifiers && candidate.identifiers.length > 0 ? { identifiers: candidate.identifiers } : {}),
        ...(candidate.numericLabels && candidate.numericLabels.length > 0 ? { numericLabels: candidate.numericLabels } : {}),
      });
    }
  }
  return units;
}

function formatFor(path: string, mediaType?: string): CitationSourceFormatV1 {
  const extension = extname(path).toLocaleLowerCase();
  if (extension === '.docx' || mediaType === DOCX_MEDIA_TYPE) return 'docx';
  if (extension === '.md' || extension === '.markdown' || mediaType === 'text/markdown') return 'markdown';
  if (extension === '.tex' || mediaType === 'application/x-tex') return 'tex';
  throw new Error('Citation Workbench 首版仅支持 DOCX、Markdown 和 TeX');
}

function textUnits(text: string, sourceSha: string, format: 'markdown' | 'tex'): CitationDocumentUnitV1[] {
  const units: CitationDocumentUnitV1[] = [];
  const paragraphs: Array<{ text: string; start: number }> = [];
  let paragraphStart = 0;
  for (const separator of text.matchAll(/\r?\n\r?\n/gu)) {
    const separatorStart = separator.index;
    paragraphs.push({ text: text.slice(paragraphStart, separatorStart), start: paragraphStart });
    paragraphStart = separatorStart + separator[0].length;
  }
  paragraphs.push({ text: text.slice(paragraphStart), start: paragraphStart });
  let referenceSection = false;
  for (const [paragraphIndex, entry] of paragraphs.entries()) {
    const paragraph = entry.text;
    const trimmed = paragraph.trim();
    if (REFERENCE_HEADING_PATTERN.test(trimmed.replace(/^#+\s*/u, ''))) { referenceSection = true; continue; }
    const candidates: Candidate[] = [];
    addMatches(candidates, paragraph, PLACEHOLDER_PATTERN, 'placeholder', 130);
    for (const match of doiMatches(paragraph)) candidates.push({ ...match, kind: 'doi', identifiers: [{ doi: match.doi }], priority: 90 });
    addMatches(candidates, paragraph, NUMERIC_CLUSTER_PATTERN, 'numeric-cluster', 60, (match) => ({ numericLabels: numericLabels(match[1] ?? '') }));
    if (format === 'markdown') addMatches(candidates, paragraph, /\[@[^\]]+\]/gu, 'zotero-field', 95);
    else addMatches(candidates, paragraph, /\\(?:cite|citep|citet|autocite|parencite)\{[^}]+\}/gu, 'zotero-field', 95);
    if (referenceSection && trimmed) {
      const start = paragraph.indexOf(trimmed);
      candidates.push({ start, end: start + trimmed.length, raw: trimmed, kind: 'reference-entry', identifiers: identifiersFromText(trimmed, true), priority: 110 });
    }
    for (const candidate of nonOverlapping(candidates)) {
      const absoluteStart = entry.start + candidate.start;
      units.push({
        id: stableUnitId(sourceSha, 'body', paragraphIndex, absoluteStart, entry.start + candidate.end, candidate.raw),
        part: 'body', paragraphIndex, start: absoluteStart, end: entry.start + candidate.end, raw: candidate.raw,
        context: paragraph.slice(Math.max(0, candidate.start - 280), Math.min(paragraph.length, candidate.end + 280)),
        kind: candidate.kind, referenceOnly: referenceSection || candidate.kind === 'reference-entry',
        ...(candidate.identifiers && candidate.identifiers.length > 0 ? { identifiers: candidate.identifiers } : {}),
        ...(candidate.numericLabels && candidate.numericLabels.length > 0 ? { numericLabels: candidate.numericLabels } : {}),
      });
    }
  }
  return units;
}

function fieldRun(displayText: string, edit: CitationDocumentEditV1): string {
  const records = edit.records ?? (edit.record ? [edit.record] : []);
  const zoteroItems = edit.zoteroItems ?? (edit.zoteroItemKey ? [{ key: edit.zoteroItemKey, ...(edit.zoteroItemUri ? { uri: edit.zoteroItemUri } : {}) }] : []);
  const citationItems = records.map((record, index) => ({
    id: zoteroItems[index]?.key ?? record.canonicalId,
    uris: zoteroItems[index]?.uri ? [zoteroItems[index]!.uri] : [],
    itemData: {
      id: zoteroItems[index]?.key ?? record.canonicalId,
      type: record.itemType === 'journalArticle' ? 'article-journal' : record.itemType === 'conferencePaper' ? 'paper-conference' : record.itemType,
      title: record.title,
      author: record.creators.map((creator) => ({ family: creator.family, ...(creator.given ? { given: creator.given } : {}) })),
      ...(record.issuedYear ? { issued: { 'date-parts': [[record.issuedYear]] } } : {}),
      ...(record.doi ? { DOI: record.doi } : {}),
      ...(record.containerTitle ? { 'container-title': record.containerTitle } : {}),
    },
  }));
  const payload = JSON.stringify({ citationID: `sci-${edit.unitId}`, properties: { formattedCitation: displayText, plainCitation: displayText, noteIndex: 0 }, citationItems, schema: 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json' });
  return [
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    `<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ${escapeXml(payload)} </w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    `<w:r><w:t xml:space="preserve">${escapeXml(displayText)}</w:t></w:r>`,
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ].join('');
}

function cloneTextRun(run: string, text: string): string {
  if (!text) return '';
  const properties = run.match(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/u)?.[0] ?? '';
  return `<w:r>${properties}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function replaceVisibleRange(paragraphXml: string, start: number, end: number, replacement: string): string {
  const runs: Array<{ xml: string; xmlStart: number; xmlEnd: number; text: string; textStart: number; textEnd: number }> = [];
  let textOffset = 0;
  for (const match of paragraphXml.matchAll(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/gu)) {
    const run = match[0];
    const text = [...run.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)].map((item) => decodeXml(item[1] ?? '')).join('');
    const textStart = textOffset;
    textOffset += text.length;
    runs.push({ xml: run, xmlStart: match.index, xmlEnd: match.index + run.length, text, textStart, textEnd: textOffset });
  }
  const overlapping = runs.filter((run) => run.textEnd > start && run.textStart < end);
  const first = overlapping[0];
  const last = overlapping.at(-1);
  if (!first || !last) throw new Error('无法在 DOCX 段落中定位待替换引用');
  const prefix = first.text.slice(0, Math.max(0, start - first.textStart));
  const suffix = last.text.slice(Math.max(0, end - last.textStart));
  return paragraphXml.slice(0, first.xmlStart) + cloneTextRun(first.xml, prefix) + replacement + cloneTextRun(last.xml, suffix) + paragraphXml.slice(last.xmlEnd);
}

function clearReferenceParagraph(paragraphXml: string): string {
  const opening = paragraphXml.match(/^<w:p\b[^>]*>/u)?.[0] ?? '<w:p>';
  const properties = paragraphXml.match(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/u)?.[0] ?? '';
  return `${opening}${properties}</w:p>`;
}

function bibliographySeedField(itemUris: readonly string[], sourceSha256: string): string {
  const uris = [...new Set(itemUris)].filter((uri) => /^https?:\/\/zotero\.org\/(?:users\/(?:local\/)?[^/]+|groups\/\d+)\/items\/[A-Z0-9]{8}$/iu.test(uri));
  if (uris.length === 0) return '';
  const payload = JSON.stringify({
    citationID: `sci-nocite-${sourceSha256.slice(0, 20)}`,
    properties: { formattedCitation: '', plainCitation: '', noteIndex: 0, dontUpdate: true },
    citationItems: uris.map((uri) => ({ id: uri.split('/').at(-1), uris: [uri] })),
    schema: 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json',
  });
  return [
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    `<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ${escapeXml(payload)} </w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    '<w:r><w:t xml:space="preserve"></w:t></w:r>',
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ].join('');
}

function bibliographyParagraph(heading: string | undefined, itemUris: readonly string[], seedCitation: boolean, sourceSha256: string): string {
  const uncited = [...new Set(itemUris)]
    .filter((uri) => /^https?:\/\/zotero\.org\/(?:users\/(?:local\/)?[^/]+|groups\/\d+)\/items\/[A-Z0-9]{8}$/iu.test(uri))
    .map((uri) => [uri]);
  const bibliography = escapeXml(JSON.stringify({ uncited, omitted: [], custom: [] }));
  const seed = seedCitation ? bibliographySeedField(itemUris, sourceSha256) : '';
  return [
    heading ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${escapeXml(heading)}</w:t></w:r></w:p>` : '',
    `<w:p>${seed}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_BIBL ${bibliography} CSL_BIBLIOGRAPHY </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Refresh with Zotero to generate the bibliography.</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  ].join('');
}

function prependParagraphField(paragraphXml: string, fieldXml: string): string {
  const opening = paragraphXml.match(/^<w:p\b[^>]*>/u)?.[0];
  if (!opening || !fieldXml) return paragraphXml;
  const afterOpening = paragraphXml.slice(opening.length);
  const properties = afterOpening.match(/^\s*<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/u)?.[0] ?? '';
  const insertAt = opening.length + properties.length;
  return paragraphXml.slice(0, insertAt) + fieldXml + paragraphXml.slice(insertAt);
}

function replaceHeadingText(paragraphXml: string, text: string): string {
  const firstTextRun = [...paragraphXml.matchAll(/<w:r\b[^>]*>[\s\S]*?<w:t\b[^>]*>[\s\S]*?<\/w:t>[\s\S]*?<\/w:r>/gu)][0]?.[0];
  const visible = xmlVisibleText(paragraphXml);
  if (!firstTextRun || !visible) return paragraphXml;
  return replaceVisibleRange(paragraphXml, 0, visible.length, cloneTextRun(firstTextRun, text));
}

function canonicalStyleUri(styleId: string): string {
  const alias: Record<string, string> = { 'apa-7th-edition': 'apa', 'apa-7': 'apa' };
  const slug = alias[styleId.toLocaleLowerCase()] ?? styleId.toLocaleLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) throw new Error(`CSL 样式 ID 无效：${styleId}`);
  return `http://www.zotero.org/styles/${slug}`;
}

function updateZipText(zip: AdmZip, name: string, transform: (xml: string) => string): void {
  const entry = zip.getEntry(name);
  if (!entry) throw new Error(`DOCX 缺少 ${name}`);
  zip.updateFile(name, Buffer.from(transform(entry.getData().toString('utf8')), 'utf8'));
}

function ensureZoteroPreferences(zip: AdmZip, plan: CitationDocumentPlanV1): void {
  const styleUri = canonicalStyleUri(plan.styleId);
  const sessionId = createHash('sha256').update(`${plan.source.sha256}\0${styleUri}`).digest('base64url').slice(0, 12);
  const preferences = [
    '<data data-version="3" zotero-version="7.0.0">',
    `<session id="${sessionId}"/>`,
    `<style id="${styleUri}" locale="en-US" hasBibliography="1" bibliographyStyleHasBeenSet="1"/>`,
    '<prefs><pref name="fieldType" value="Field"/><pref name="automaticJournalAbbreviations" value="true"/><pref name="noteType" value="0"/></prefs>',
    '</data>',
  ].join('');

  const customName = 'docProps/custom.xml';
  const existing = zip.getEntry(customName)?.getData().toString('utf8') ?? [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>',
  ].join('');
  let custom = existing.replace(/<property\b(?=[^>]*\bname="ZOTERO_PREF_\d+")[\s\S]*?<\/property>/gu, '');
  const usedPids = [...custom.matchAll(/\bpid="(\d+)"/gu)].map((match) => Number(match[1])).filter(Number.isFinite);
  let pid = Math.max(1, ...usedPids) + 1;
  const chunks = preferences.match(/[\s\S]{1,240}/gu) ?? [''];
  const properties = chunks.map((chunk, index) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${pid++}" name="ZOTERO_PREF_${index + 1}"><vt:lpwstr>${escapeXml(chunk)}</vt:lpwstr></property>`).join('');
  custom = custom.replace(/<\/Properties>\s*$/u, `${properties}</Properties>`);
  if (zip.getEntry(customName)) zip.updateFile(customName, Buffer.from(custom, 'utf8'));
  else zip.addFile(customName, Buffer.from(custom, 'utf8'));

  updateZipText(zip, '[Content_Types].xml', (xml) => xml.includes('PartName="/docProps/custom.xml"')
    ? xml
    : xml.replace(/<\/Types>\s*$/u, '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>'));
  const relationshipsName = '_rels/.rels';
  const relationshipsEntry = zip.getEntry(relationshipsName);
  const relationships = relationshipsEntry?.getData().toString('utf8') ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  if (!relationships.includes('relationships/custom-properties')) {
    const ids = new Set([...relationships.matchAll(/\bId="([^"]+)"/gu)].map((match) => match[1]));
    let relationshipId = 'rIdSciCitationPreferences';
    for (let suffix = 2; ids.has(relationshipId); suffix += 1) relationshipId = `rIdSciCitationPreferences${suffix}`;
    const revised = relationships.replace(/<\/Relationships>\s*$/u, `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>`);
    if (relationshipsEntry) zip.updateFile(relationshipsName, Buffer.from(revised, 'utf8'));
    else zip.addFile(relationshipsName, Buffer.from(revised, 'utf8'));
  }
}

function materializeDocx(source: Buffer, plan: CitationDocumentPlanV1): { bytes: Buffer; dynamicFields: number; bibliography: boolean; warnings: string[] } {
  const zip = new AdmZip(source);
  const applied = new Map(plan.edits.filter((edit) => edit.status === 'applied').map((edit) => [edit.unitId, edit]));
  const appliedItemUris = [...applied.values()].flatMap((edit) => [
    ...(edit.zoteroItemUri ? [edit.zoteroItemUri] : []),
    ...(edit.zoteroItems ?? []).flatMap((item) => item.uri ? [item.uri] : []),
  ]);
  const planned = new Map(plan.edits.map((edit) => [edit.unitId, edit]));
  const scannedByPart = new Map<string, CitationDocumentUnitV1[]>();
  for (const partName of ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']) {
    const entry = zip.getEntry(partName);
    if (entry) scannedByPart.set(partName, scanTextPart(partName, entry.getData().toString('utf8'), plan.source.sha256));
  }
  const hasAppliedBodyCitation = [...scannedByPart.values()].flat().some((unit) => applied.has(unit.id) && !unit.referenceOnly);
  let dynamicFields = 0;
  const warnings: string[] = [];
  for (const partName of ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']) {
    const entry = zip.getEntry(partName);
    if (!entry) continue;
    let xml = entry.getData().toString('utf8');
    const scanned = scannedByPart.get(partName) ?? [];
    const unresolvedReferenceUnits = scanned.filter((unit) => unit.referenceOnly && planned.get(unit.id)?.status !== 'applied');
    let preservedAppliedReferenceParagraph = false;
    const byParagraph = new Map<number, Array<{ unit: CitationDocumentUnitV1; edit: CitationDocumentEditV1 }>>();
    for (const unit of scanned) {
      const edit = applied.get(unit.id);
      if (!edit) continue;
      const list = byParagraph.get(unit.paragraphIndex) ?? [];
      list.push({ unit, edit });
      byParagraph.set(unit.paragraphIndex, list);
    }
    const partParagraphs = paragraphs(xml);
    for (const [paragraphIndex, edits] of [...byParagraph].sort((left, right) => right[0] - left[0])) {
      const paragraph = partParagraphs[paragraphIndex];
      if (!paragraph) continue;
      let revised = paragraph.xml;
      const referenceEdits = edits.filter(({ unit }) => unit.referenceOnly);
      if (referenceEdits.length > 0 && referenceEdits.every(({ unit }) => unit.raw.trim() === paragraph.text.trim())) {
        revised = clearReferenceParagraph(revised);
      } else {
        for (const { unit, edit } of [...edits].sort((left, right) => right.unit.start - left.unit.start)) {
          if (unit.referenceOnly) {
            preservedAppliedReferenceParagraph = true;
            warnings.push(`参考文献条目 ${unit.id} 未覆盖整个段落，已保留原文并归入待核对区域`);
            continue;
          }
          const replacement = fieldRun(edit.displayText, edit);
          if (unit.kind === 'endnote-field' || unit.kind === 'zotero-field') {
            const managerField = fieldCandidates(revised, new Map()).find((candidate) => candidate.kind === unit.kind && candidate.start === unit.start && candidate.end === unit.end && candidate.raw === unit.raw);
            if (managerField?.xmlStart === undefined || managerField.xmlEnd === undefined) throw new Error(`无法定位待转换的管理器字段：${unit.id}`);
            revised = revised.slice(0, managerField.xmlStart) + replacement + revised.slice(managerField.xmlEnd);
          } else revised = replaceVisibleRange(revised, unit.start, unit.end, replacement);
          dynamicFields += 1;
        }
      }
      xml = xml.slice(0, paragraph.start) + revised + xml.slice(paragraph.end);
    }
    if (partName === 'word/document.xml' && applied.size > 0) {
      const currentParagraphs = paragraphs(xml);
      const referenceHeading = currentParagraphs.find((paragraph) => REFERENCE_HEADING_PATTERN.test(paragraph.text.trim()));
      const hasUnresolvedReferences = unresolvedReferenceUnits.length > 0 || preservedAppliedReferenceParagraph;
      if (referenceHeading && hasUnresolvedReferences) {
        const chinese = referenceHeading.text.includes('参考文献');
        const revisedHeading = replaceHeadingText(referenceHeading.xml, chinese ? '待核对参考文献' : 'References requiring verification');
        xml = xml.slice(0, referenceHeading.start) + revisedHeading + xml.slice(referenceHeading.end);
      }

      const existingBibliography = paragraphs(xml).find((paragraph) => paragraph.xml.includes('ADDIN ZOTERO_BIBL'));
      if (existingBibliography) {
        const seed = bibliographySeedField(appliedItemUris, plan.source.sha256);
        const seedId = `sci-nocite-${plan.source.sha256.slice(0, 20)}`;
        if (seed && !xml.includes(seedId)) {
          const revisedBibliography = prependParagraphField(existingBibliography.xml, seed);
          xml = xml.slice(0, existingBibliography.start) + revisedBibliography + xml.slice(existingBibliography.end);
          dynamicFields += 1;
        }
      } else {
        const needsSeed = !hasAppliedBodyCitation;
        const insertion = bibliographyParagraph(
          referenceHeading
            ? hasUnresolvedReferences ? (referenceHeading.text.includes('参考文献') ? '已核验参考文献（Zotero）' : 'Verified references (Zotero)') : undefined
            : 'References',
          appliedItemUris,
          needsSeed,
          plan.source.sha256,
        );
        if (needsSeed && bibliographySeedField(appliedItemUris, plan.source.sha256)) dynamicFields += 1;
        if (referenceHeading && !hasUnresolvedReferences) {
          const refreshedHeading = paragraphs(xml).find((paragraph) => REFERENCE_HEADING_PATTERN.test(paragraph.text.trim()));
          if (refreshedHeading) xml = xml.slice(0, refreshedHeading.end) + insertion + xml.slice(refreshedHeading.end);
          else warnings.push('DOCX 参考文献标题在物化时发生变化，动态书目已改为文末插入');
        } else {
          const sectionIndex = xml.lastIndexOf('<w:sectPr');
          const bodyEnd = xml.lastIndexOf('</w:body>');
          const insertAt = sectionIndex >= 0 ? sectionIndex : bodyEnd;
          if (insertAt >= 0) xml = xml.slice(0, insertAt) + insertion + xml.slice(insertAt);
          else warnings.push('DOCX 主文档缺少 w:body，未能插入动态参考文献表');
        }
      }
    }
    zip.updateFile(partName, Buffer.from(xml, 'utf8'));
  }
  if (applied.size > 0) ensureZoteroPreferences(zip, plan);
  return { bytes: zip.toBuffer(), dynamicFields, bibliography: applied.size > 0, warnings };
}

function citeKey(edit: CitationDocumentEditV1, index = 0): string {
  const record = edit.records?.[index] ?? edit.record;
  const item = edit.zoteroItems?.[index];
  if (item?.key) return item.key;
  if (edit.zoteroItemKey) return edit.zoteroItemKey;
  const author = record?.creators[0]?.family.replace(/[^\p{L}\p{N}]+/gu, '') || 'ref';
  return `${author}${record?.issuedYear ?? 'nd'}${record?.canonicalId.slice(-6) ?? edit.unitId.slice(-6)}`;
}

function materializeText(source: string, plan: CitationDocumentPlanV1): string {
  let output = source;
  const editsById = new Map(plan.edits.filter((edit) => edit.status === 'applied').map((edit) => [edit.unitId, edit]));
  const units = textUnits(source, plan.source.sha256, plan.format === 'tex' ? 'tex' : 'markdown');
  for (const unit of [...units].sort((left, right) => right.start - left.start)) {
    const edit = editsById.get(unit.id);
    if (!edit || unit.referenceOnly) continue;
    const recordCount = edit.records?.length ?? (edit.record ? 1 : 0);
    const keys = Array.from({ length: Math.max(1, recordCount) }, (_item, index) => citeKey(edit, index));
    const replacement = plan.format === 'tex' ? `\\cite{${keys.join(',')}}` : `[${keys.map((key) => `@${key}`).join('; ')}]`;
    output = output.slice(0, unit.start) + replacement + output.slice(unit.end);
  }
  return output;
}

export class CitationDocumentService {
  readonly #resolveRoot: (rootId: string, intent: 'read' | 'write') => string;

  constructor(options: { resolveRoot: (rootId: string, intent: 'read' | 'write') => string }) {
    this.#resolveRoot = options.resolveRoot;
  }

  scan(source: DocumentRevisionRef): CitationDocumentInspectionV1 {
    const root = this.#resolveRoot(source.ref.rootId, 'read');
    const absolute = new PathGuard(root).resolveExisting(source.ref.path);
    const bytes = readFileSync(absolute);
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('引用扫描文件不能超过 96 MB');
    const actualSha = sha256(bytes);
    if (actualSha !== source.sha256) throw new Error('源文件已经变化，请重新预览后再运行');
    const format = formatFor(source.ref.path, source.mediaType);
    const warnings: string[] = [];
    let units: CitationDocumentUnitV1[];
    if (format === 'docx') {
      const zip = new AdmZip(bytes);
      const parts: DocxPart[] = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'].flatMap((name) => {
        const entry = zip.getEntry(name);
        return entry ? [{ name, xml: entry.getData().toString('utf8') }] : [];
      });
      if (!parts.some((part) => part.name === 'word/document.xml')) throw new Error('DOCX 缺少 word/document.xml');
      units = parts.flatMap((part) => scanTextPart(part.name, part.xml, actualSha));
      if (parts.length === 1) warnings.push('文档没有脚注或尾注引用区域');
    } else {
      const text = bytes.toString('utf8');
      units = textUnits(text, actualSha, format);
    }
    const authorDateCount = units.filter((unit) => unit.kind === 'author-date').length;
    const numericCount = units.filter((unit) => unit.kind === 'numeric-cluster').length;
    return {
      schemaVersion: 1,
      source: structuredClone(source),
      format,
      detectedStyleFamily: authorDateCount > numericCount ? 'author-date' : 'numeric',
      units,
      warnings,
    };
  }

  materialize(plan: CitationDocumentPlanV1): CitationMaterializationReceiptV1 {
    if (plan.schemaVersion !== 1 || plan.bibliographyPolicy !== 'dynamic-resolved-with-unresolved-review') throw new Error('引用文档计划版本或书目策略不受支持');
    const sourceRoot = this.#resolveRoot(plan.source.ref.rootId, 'read');
    const sourceAbsolute = new PathGuard(sourceRoot).resolveExisting(plan.source.ref.path);
    const sourceBytes = readFileSync(sourceAbsolute);
    if (sha256(sourceBytes) !== plan.source.sha256) throw new Error('源文件已经变化，必须重新预览');
    const format = formatFor(plan.source.ref.path, plan.source.mediaType);
    if (format !== plan.format) throw new Error('引用文档计划格式与源文件不一致');
    const writeRoot = this.#resolveRoot(plan.source.ref.rootId, 'write');
    const safeOperation = plan.operationKey.replace(/[^a-zA-Z0-9._-]+/gu, '-').slice(0, 120) || sha256(plan.source.sha256).slice(0, 16);
    const directory = new PathGuard(writeRoot).resolveForWrite(join('.openlab', 'citation-runs', safeOperation));
    mkdirSync(directory, { recursive: true });
    const extension = extname(plan.source.ref.path);
    const stem = basename(plan.source.ref.path, extension);
    const outputName = `${stem}.citation-revised${extension}`;
    const destination = join(directory, outputName);
    let output: Buffer;
    let dynamicFields = 0;
    let bibliographyGenerated = false;
    let warnings: string[] = [];
    if (format === 'docx') {
      const result = materializeDocx(sourceBytes, plan);
      output = result.bytes;
      dynamicFields = result.dynamicFields;
      bibliographyGenerated = result.bibliography;
      warnings = result.warnings;
    } else {
      output = Buffer.from(materializeText(sourceBytes.toString('utf8'), plan), 'utf8');
      bibliographyGenerated = plan.edits.some((edit) => edit.status === 'applied');
    }
    writeFileSync(destination, output, { flag: 'w' });
    const appliedCount = plan.edits.filter((edit) => edit.status === 'applied').length;
    const skippedCount = plan.edits.length - appliedCount;
    return {
      schemaVersion: 1,
      operationKey: plan.operationKey,
      readiness: skippedCount === 0 ? 'submission_ready' : 'partial_review_required',
      output: { rootId: plan.source.ref.rootId, path: relative(writeRoot, destination).replaceAll('\\', '/') },
      outputSha256: sha256(output),
      mediaType: format === 'docx' ? DOCX_MEDIA_TYPE : format === 'markdown' ? 'text/markdown' : 'application/x-tex',
      appliedCount,
      skippedCount,
      dynamicFieldCount: dynamicFields,
      bibliographyGenerated,
      warnings,
    };
  }
}
