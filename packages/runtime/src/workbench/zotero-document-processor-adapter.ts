import { readFileSync, writeFileSync } from 'node:fs';
import AdmZip from 'adm-zip';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const ZOTERO_ORIGIN = 'http://127.0.0.1:23119';
const MAX_TRANSACTION_STEPS = 10_000;
const MAX_PROTOCOL_PAYLOAD_BYTES = 32 * 1024 * 1024;

interface ProtocolCommand {
  command: string;
  arguments: JsonValue[];
}

interface DocxField {
  id: string;
  part: string;
  start: number;
  end: number;
  code: string;
  text: string;
  noteIndex: number;
  deleted: boolean;
  removeCode: boolean;
}

export interface ZoteroCitingTransactionReceipt {
  command: 'refresh';
  documentId: string;
  steps: number;
  completed: boolean;
  errorCount: number;
  alerts?: Array<{ text: string; icon: number; buttons: number }>;
  outputPath: string;
}

function decodeXml(value: string): string {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function visibleText(xml: string): string {
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/gu)].map((match) => match[1] === undefined ? (match[0].startsWith('<w:tab') ? '\t' : '\n') : decodeXml(match[1])).join('');
}

function richTextRuns(value: string): string {
  const plain = decodeXml(value
    .replace(/<\/(?:div|p|li|tr)>/giu, '\n')
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ''))
    .replace(/\r\n?/gu, '\n');
  const segments = plain.split('\n');
  return segments.map((segment, index) => `${index > 0 ? '<w:r><w:br/></w:r>' : ''}<w:r><w:rPr><w:noProof/></w:rPr><w:t xml:space="preserve">${escapeXml(segment)}</w:t></w:r>`).join('');
}

function fieldXml(field: DocxField): string {
  const result = richTextRuns(field.text);
  if (field.removeCode) return result;
  return [
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    `<w:r><w:instrText xml:space="preserve">${escapeXml(field.code)}</w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    result,
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ].join('');
}

function noteIndexFor(part: string, xml: string, position: number): number {
  if (part === 'word/document.xml') return 0;
  const prefix = xml.slice(0, position);
  const pattern = part.endsWith('footnotes.xml') ? /<w:footnote\b[^>]*w:id="(-?\d+)"[^>]*>/gu : /<w:endnote\b[^>]*w:id="(-?\d+)"[^>]*>/gu;
  const matches = [...prefix.matchAll(pattern)];
  const value = Number(matches.at(-1)?.[1] ?? 0);
  return value > 0 ? value : 0;
}

function fieldsInPart(part: string, xml: string): DocxField[] {
  const markers = [...xml.matchAll(/<w:fldChar\b[^>]*w:fldCharType="(begin|separate|end)"[^>]*\/?\s*>/gu)];
  const stack: Array<{ begin: RegExpMatchArray; separate?: RegExpMatchArray }> = [];
  const fields: DocxField[] = [];
  for (const marker of markers) {
    if (marker[1] === 'begin') { stack.push({ begin: marker }); continue; }
    const current = stack.at(-1);
    if (!current) continue;
    if (marker[1] === 'separate') { current.separate = marker; continue; }
    stack.pop();
    if (!current.separate) continue;
    const beginIndex = current.begin.index;
    const separateIndex = current.separate.index;
    const endIndex = marker.index;
    if (beginIndex === undefined || separateIndex === undefined || endIndex === undefined) continue;
    const start = xml.lastIndexOf('<w:r', beginIndex);
    const endRun = xml.indexOf('</w:r>', endIndex);
    if (start < 0 || endRun < 0) continue;
    const codeRegion = xml.slice(beginIndex + current.begin[0].length, separateIndex);
    const resultRegion = xml.slice(separateIndex + current.separate[0].length, endIndex);
    const code = [...codeRegion.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/gu)].map((match) => decodeXml(match[1] ?? '')).join('');
    if (!/\bZOTERO_(?:ITEM|BIBL)\b/u.test(code)) continue;
    fields.push({
      id: `${part}#${fields.length + 1}`,
      part,
      start,
      end: endRun + '</w:r>'.length,
      code,
      text: visibleText(resultRegion),
      noteIndex: noteIndexFor(part, xml, start),
      deleted: false,
      removeCode: false,
    });
  }
  return fields;
}

function documentPreferences(zip: AdmZip): string {
  const xml = zip.getEntry('docProps/custom.xml')?.getData().toString('utf8') ?? '';
  return [...xml.matchAll(/<property\b(?=[^>]*\bname="ZOTERO_PREF_(\d+)")[\s\S]*?<vt:lpwstr>([\s\S]*?)<\/vt:lpwstr>[\s\S]*?<\/property>/gu)]
    .map((match) => ({ index: Number(match[1]), value: decodeXml(match[2] ?? '') }))
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.value)
    .join('');
}

function documentDataWithFieldType(value: string, fieldType: string): string {
  if (value.trimStart().startsWith('{')) {
    const data = JSON.parse(value) as Record<string, unknown>;
    const prefs = typeof data.prefs === 'object' && data.prefs !== null ? data.prefs as Record<string, unknown> : {};
    return JSON.stringify({ ...data, prefs: { ...prefs, fieldType } });
  }
  if (/<pref\b[^>]*\bname="fieldType"/u.test(value)) {
    return value.replace(/(<pref\b[^>]*\bname="fieldType"[^>]*\bvalue=")[^"]*(")/u, `$1${fieldType}$2`);
  }
  return value.replace(/<\/prefs>/u, `<pref name="fieldType" value="${fieldType}"/></prefs>`);
}

function documentDataWithSessionId(value: string, sessionId: string): string {
  if (value.trimStart().startsWith('{')) {
    const data = JSON.parse(value) as Record<string, unknown>;
    return JSON.stringify({ ...data, sessionID: sessionId });
  }
  if (!/<session\b[^>]*\bid="[^"]*"[^>]*\/?\s*>/u.test(value)) throw new Error('Zotero 文档数据缺少 session id');
  return value.replace(/(<session\b[^>]*\bid=")[^"]*(")/u, `$1${escapeXml(sessionId)}$2`);
}

function httpFieldCode(value: string): string {
  const code = value.trim();
  if (/^ADDIN\s+ZOTERO_ITEM\b/iu.test(code)) return code.replace(/^ADDIN\s+ZOTERO_ITEM\b/iu, 'ITEM');
  if (/^ADDIN\s+ZOTERO_BIBL\b/iu.test(code)) return code.replace(/^ADDIN\s+ZOTERO_BIBL\b/iu, 'BIBL');
  throw new Error('DOCX contains a Zotero field code that cannot be exposed to the HTTP integration');
}

function docxFieldCode(value: string): string {
  const code = value.trim();
  if (/^ITEM\b/iu.test(code)) return ` ADDIN ZOTERO_${code} `;
  if (/^BIBL\b/iu.test(code)) return ` ADDIN ZOTERO_${code} `;
  throw new Error('Zotero returned a field code outside the restricted ITEM/BIBL surface');
}

function setDocumentPreferences(zip: AdmZip, value: string): void {
  const entry = zip.getEntry('docProps/custom.xml');
  if (!entry) throw new Error('DOCX 缺少 Citation Workbench 生成的 Zotero 文档偏好');
  let xml = entry.getData().toString('utf8').replace(/<property\b(?=[^>]*\bname="ZOTERO_PREF_\d+")[\s\S]*?<\/property>/gu, '');
  const usedPids = [...xml.matchAll(/\bpid="(\d+)"/gu)].map((match) => Number(match[1])).filter(Number.isFinite);
  let pid = Math.max(1, ...usedPids) + 1;
  const chunks = value.match(/[\s\S]{1,240}/gu) ?? [''];
  const properties = chunks.map((chunk, index) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${pid++}" name="ZOTERO_PREF_${index + 1}"><vt:lpwstr>${escapeXml(chunk)}</vt:lpwstr></property>`).join('');
  xml = xml.replace(/<\/Properties>\s*$/u, `${properties}</Properties>`);
  zip.updateFile('docProps/custom.xml', Buffer.from(xml, 'utf8'));
}

/** A refresh-only DOCX implementation of Zotero's document command surface. */
export class RestrictedDocxZoteroProcessor {
  readonly documentId: string;
  readonly outputPath: string;
  readonly #zip: AdmZip;
  readonly #parts = new Map<string, string>();
  readonly #fields: DocxField[];
  readonly #storedFieldType: string;
  readonly #storedSessionId: string;
  #preferences: string;

  constructor(options: { sourcePath: string; outputPath: string; documentId: string }) {
    if (options.sourcePath === options.outputPath) throw new Error('Zotero HTTP 刷新必须写入新的 DOCX，不能覆盖输入文件');
    this.documentId = options.documentId;
    this.outputPath = options.outputPath;
    this.#zip = new AdmZip(readFileSync(options.sourcePath));
    for (const part of ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']) {
      const entry = this.#zip.getEntry(part);
      if (entry) this.#parts.set(part, entry.getData().toString('utf8'));
    }
    if (!this.#parts.has('word/document.xml')) throw new Error('DOCX 缺少 word/document.xml');
    this.#fields = [...this.#parts].flatMap(([part, xml]) => fieldsInPart(part, xml));
    const preferences = documentPreferences(this.#zip);
    if (!preferences) throw new Error('DOCX 缺少 Zotero 文档偏好，拒绝启动刷新事务');
    this.#storedFieldType = preferences.match(/<pref\b[^>]*\bname="fieldType"[^>]*\bvalue="([^"]+)"/u)?.[1] ?? 'Field';
    this.#storedSessionId = preferences.match(/<session\b[^>]*\bid="([^"]+)"/u)?.[1] ?? '';
    if (!this.#storedSessionId) throw new Error('DOCX 缺少 Zotero session id，拒绝启动刷新事务');
    // Zotero's HTTP integration identifies its virtual field encoding as Http.
    // The adapter translates that surface back to the original DOCX Word field type on save.
    this.#preferences = documentDataWithFieldType(preferences, 'Http');
  }

  async execute(command: string, args: JsonValue[]): Promise<JsonValue> {
    const offset = args[0] === this.documentId ? 1 : 0;
    const field = (value: JsonValue | undefined) => {
      const id = String(value ?? '');
      const result = this.#fields.find((candidate) => candidate.id === id && !candidate.deleted);
      if (!result) throw new Error(`Zotero 请求了不存在的字段：${id}`);
      return result;
    };
    switch (command) {
      case 'Application.getActiveDocument': return { documentID: this.documentId, outputFormat: 'html', supportedNotes: ['footnotes', 'endnotes'], processorName: 'Sci Workplace DOCX adapter' };
      case 'Document.activate': return null;
      case 'Document.canInsertField': return false;
      case 'Document.cursorInField': return null;
      case 'Document.getDocumentData': return this.#preferences;
      case 'Document.setDocumentData': this.#preferences = String(args[offset] ?? ''); return null;
      case 'Document.getFields': {
        const active = this.#fields.filter((candidate) => !candidate.deleted);
        return active.map((candidate) => ({ id: candidate.id, code: httpFieldCode(candidate.code), text: candidate.text, noteIndex: candidate.noteIndex, adjacent: false }));
      }
      case 'Document.setBibliographyStyle': return null;
      case 'Document.displayAlert': return Number(args[offset + 2] ?? 0) === 0 ? 1 : 0;
      case 'Field.select': return null;
      case 'Field.getText': return field(args[offset]).text;
      case 'Field.setText': field(args[offset]).text = String(args[offset + 1] ?? ''); return null;
      case 'Field.setCode': field(args[offset]).code = docxFieldCode(String(args[offset + 1] ?? '')); return null;
      case 'Field.removeCode': field(args[offset]).removeCode = true; return null;
      case 'Field.delete': field(args[offset]).deleted = true; return null;
      case 'Document.complete': return null;
      default: throw new Error(`受限 DOCX adapter 不允许命令：${command}`);
    }
  }

  save(): void {
    for (const [part, original] of this.#parts) {
      let xml = original;
      for (const field of this.#fields.filter((candidate) => candidate.part === part).sort((left, right) => right.start - left.start)) {
        xml = xml.slice(0, field.start) + (field.deleted ? '' : fieldXml(field)) + xml.slice(field.end);
      }
      this.#zip.updateFile(part, Buffer.from(xml, 'utf8'));
    }
    const stablePreferences = documentDataWithSessionId(this.#preferences, this.#storedSessionId);
    setDocumentPreferences(this.#zip, documentDataWithFieldType(stablePreferences, this.#storedFieldType));
    writeFileSync(this.outputPath, this.#zip.toBuffer(), { flag: 'wx' });
  }
}

function protocolCommand(value: unknown): ProtocolCommand {
  let decoded = value;
  if (typeof decoded === 'string') decoded = JSON.parse(decoded) as unknown;
  if (typeof decoded !== 'object' || decoded === null) throw new Error('Zotero HTTP citing 返回了无效命令');
  const record = decoded as Record<string, unknown>;
  if (typeof record.command !== 'string' || !Array.isArray(record.arguments)) throw new Error('Zotero HTTP citing 命令结构无效');
  return { command: record.command, arguments: record.arguments as JsonValue[] };
}

/** Drives the fixed loopback execCommand/respond transaction; URLs are never caller-controlled. */
export class ZoteroHttpCitingAdapter {
  readonly #fetch: FetchLike;

  constructor(fetch: FetchLike = globalThis.fetch) {
    this.#fetch = fetch;
  }

  async #post(path: '/connector/document/execCommand' | '/connector/document/respond', payload: JsonValue, retries = 2): Promise<ProtocolCommand | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException('Zotero citing request timed out', 'TimeoutError')), 15_000);
    try {
      const response = await this.#fetch(`${ZOTERO_ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: controller.signal });
      if (response.status === 503 && retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (3 - retries)));
        return await this.#post(path, payload, retries - 1);
      }
      if (!response.ok) throw new Error(`Zotero HTTP citing 失败：HTTP ${response.status}`);
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (declaredLength > MAX_PROTOCOL_PAYLOAD_BYTES) throw new Error('Zotero HTTP citing 响应超过 32 MB');
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_PROTOCOL_PAYLOAD_BYTES) throw new Error('Zotero HTTP citing 响应超过 32 MB');
      if (!text.trim()) return undefined;
      return protocolCommand(JSON.parse(text) as unknown);
    } finally {
      clearTimeout(timeout);
    }
  }

  async refresh(processor: RestrictedDocxZoteroProcessor): Promise<ZoteroCitingTransactionReceipt> {
    let next = await this.#post('/connector/document/execCommand', { command: 'refresh', docId: processor.documentId });
    let steps = 0;
    let errorCount = 0;
    const alerts: Array<{ text: string; icon: number; buttons: number }> = [];
    while (next) {
      steps += 1;
      if (steps > MAX_TRANSACTION_STEPS) throw new Error('Zotero HTTP citing 事务步骤超过安全上限');
      if (next.command === 'Document.complete') {
        await processor.execute(next.command, next.arguments);
        processor.save();
        return { command: 'refresh', documentId: processor.documentId, steps, completed: errorCount === 0, errorCount, ...(alerts.length > 0 ? { alerts } : {}), outputPath: processor.outputPath };
      }
      if (next.command === 'Document.displayAlert') {
        const offset = next.arguments[0] === processor.documentId ? 1 : 0;
        const alert = { text: String(next.arguments[offset] ?? ''), icon: Number(next.arguments[offset + 1] ?? 0), buttons: Number(next.arguments[offset + 2] ?? 0) };
        alerts.push(alert);
        if (alert.icon === 0) errorCount += 1;
      }
      let result: JsonValue;
      try {
        result = await processor.execute(next.command, next.arguments);
      } catch (error) {
        errorCount += 1;
        result = { error: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) };
      }
      next = await this.#post('/connector/document/respond', result);
    }
    processor.save();
    return { command: 'refresh', documentId: processor.documentId, steps, completed: errorCount === 0, errorCount, ...(alerts.length > 0 ? { alerts } : {}), outputPath: processor.outputPath };
  }
}
