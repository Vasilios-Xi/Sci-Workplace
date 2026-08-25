import { createHash, randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import type { DocumentBuffer, DocumentDescriptor, EventActor, WorkspacePathRef } from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { PathGuard } from '../security/path-guard.js';
import { atomicWriteJson, readJsonFile } from '../util/files.js';
import { toJson } from '../util/json.js';
import type { WorkspaceEditService } from './workspace-edit-service.js';
import { sha256FileSync } from './file-hash.js';

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.bib': 'bibtex', '.css': 'css', '.csv': 'plaintext', '.html': 'html', '.js': 'javascript', '.json': 'json',
  '.md': 'markdown', '.mjs': 'javascript', '.py': 'python', '.r': 'r', '.rmd': 'r', '.tex': 'latex', '.ts': 'typescript',
  '.tsx': 'typescript', '.txt': 'plaintext', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
};

const MEDIA_BY_EXTENSION: Record<string, string> = {
  '.bib': 'application/x-bibtex', '.css': 'text/css', '.csv': 'text/csv', '.html': 'text/html', '.js': 'text/javascript',
  '.json': 'application/json', '.md': 'text/markdown', '.mjs': 'text/javascript', '.py': 'text/x-python', '.r': 'text/x-r',
  '.rmd': 'text/markdown', '.tex': 'application/x-tex', '.ts': 'text/typescript', '.tsx': 'text/typescript', '.txt': 'text/plain',
  '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml',
};

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function bufferKey(ref: WorkspacePathRef): string {
  return `${ref.rootId}:${ref.path.replaceAll('\\', '/').toLocaleLowerCase()}`;
}

function isDocumentBuffer(value: unknown): value is DocumentBuffer {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<DocumentBuffer>;
  return typeof record.id === 'string' && typeof record.baseSha256 === 'string' && typeof record.content === 'string'
    && typeof record.document === 'object' && record.document !== null;
}

export class DocumentService {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #edits: WorkspaceEditService;
  readonly #resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
  readonly #recoveryPath: string;
  readonly #buffers = new Map<string, DocumentBuffer>();
  readonly #recoveries = new Map<string, DocumentBuffer>();
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #watchTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: {
    projectId: string;
    events: SqliteEventStore;
    edits: WorkspaceEditService;
    resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
    recoveryPath: string;
  }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.#edits = options.edits;
    this.#resolveRoot = options.resolveRoot;
    this.#recoveryPath = options.recoveryPath;
    const projected = readJsonFile<unknown>(this.#recoveryPath, []);
    if (Array.isArray(projected)) {
      for (const value of projected.filter(isDocumentBuffer)) this.#recoveries.set(bufferKey(value.document.ref), structuredClone(value));
    }
  }

  buffers(): DocumentBuffer[] {
    return [...this.#buffers.values()].map((buffer) => structuredClone(buffer));
  }

  open(ref: WorkspacePathRef, actor: EventActor): DocumentBuffer {
    const normalized = { rootId: ref.rootId, path: ref.path.replaceAll('\\', '/') };
    const existing = [...this.#buffers.values()].find((buffer) => bufferKey(buffer.document.ref) === bufferKey(normalized));
    if (existing) return structuredClone(existing);
    const root = this.#resolveRoot(normalized.rootId, 'read');
    const absolute = new PathGuard(root).resolveExisting(normalized.path);
    const stats = statSync(absolute);
    if (!stats.isFile()) throw new Error('文档目标不是普通文件');
    if (stats.size > MAX_DOCUMENT_BYTES) throw new Error('内置编辑器仅支持 5 MB 以内的文本文件');
    const raw = readFileSync(absolute);
    if (raw.includes(0)) throw new Error('二进制文件不能在文本编辑器中打开');
    const content = raw.toString('utf8');
    const currentHash = sha256(raw);
    let readOnly = false;
    try { this.#resolveRoot(normalized.rootId, 'write'); } catch { readOnly = true; }
    const extension = extname(normalized.path).toLocaleLowerCase();
    const descriptor: DocumentDescriptor = {
      id: randomUUID(),
      ref: normalized,
      name: basename(normalized.path),
      size: stats.size,
      sha256: currentHash,
      mediaType: MEDIA_BY_EXTENSION[extension] ?? 'text/plain',
      languageId: LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext',
      readOnly,
      modifiedAt: stats.mtime.toISOString(),
    };
    const recovery = this.#recoveries.get(bufferKey(normalized));
    const recovered = Boolean(recovery?.dirty && recovery.baseSha256 === currentHash);
    const now = new Date().toISOString();
    const buffer: DocumentBuffer = recovered && recovery ? {
      ...structuredClone(recovery),
      id: randomUUID(),
      document: descriptor,
      recovered: true,
      updatedAt: now,
    } : {
      id: randomUUID(), document: descriptor, baseSha256: currentHash, content, dirty: false, recovered: false, openedAt: now, updatedAt: now,
    };
    this.#buffers.set(buffer.id, buffer);
    this.startWatcher(buffer.id, absolute);
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: recovered ? 'document.recovered' : 'document.opened',
      actor,
      provenanceRefs: [currentHash],
      payload: toJson({ bufferId: buffer.id, document: descriptor, recovered }),
    });
    this.persistRecoveries();
    return structuredClone(buffer);
  }

  update(bufferId: string, content: string, actor: EventActor): DocumentBuffer {
    const buffer = this.require(bufferId);
    if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('编辑缓冲超过 5 MB 上限');
    if (content === buffer.content) return structuredClone(buffer);
    const updated: DocumentBuffer = { ...buffer, content, dirty: true, updatedAt: new Date().toISOString() };
    this.#buffers.set(bufferId, updated);
    this.#recoveries.set(bufferKey(buffer.document.ref), updated);
    this.persistRecoveries();
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'document.buffer_changed',
      actor,
      payload: toJson({ bufferId, ref: buffer.document.ref, baseSha256: buffer.baseSha256, contentSha256: sha256(content) }),
    });
    return structuredClone(updated);
  }

  save(bufferId: string, actor: EventActor): DocumentBuffer {
    const buffer = this.require(bufferId);
    if (buffer.document.readOnly) throw new Error('此工作区文档为只读');
    if (!buffer.dirty) return structuredClone(buffer);
    let preview;
    try {
      preview = this.#edits.preview({
        label: `保存 ${buffer.document.name}`,
        origin: 'user',
        edits: [{ ref: buffer.document.ref, baseSha256: buffer.baseSha256, content: buffer.content }],
      }, actor);
    } catch (error) {
      this.#events.append({
        streamId: `project:${this.#projectId}`,
        kind: 'document.conflicted',
        actor,
        provenanceRefs: [buffer.baseSha256],
        payload: toJson({ bufferId, ref: buffer.document.ref, error: error instanceof Error ? error.message : String(error) }),
      });
      throw error;
    }
    const group = this.#edits.apply(preview.id, actor, true);
    const root = this.#resolveRoot(buffer.document.ref.rootId, 'read');
    const absolute = new PathGuard(root).resolveExisting(buffer.document.ref.path);
    const stats = statSync(absolute);
    const nextHash = sha256(readFileSync(absolute));
    const updated: DocumentBuffer = {
      ...buffer,
      document: { ...buffer.document, sha256: nextHash, size: stats.size, modifiedAt: stats.mtime.toISOString() },
      baseSha256: nextHash,
      dirty: false,
      recovered: false,
      updatedAt: new Date().toISOString(),
    };
    this.#buffers.set(bufferId, updated);
    this.#recoveries.delete(bufferKey(buffer.document.ref));
    this.persistRecoveries();
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'document.buffer_saved',
      actor,
      traceId: group.id,
      provenanceRefs: [group.id, nextHash],
      payload: toJson({ bufferId, document: updated.document, editGroupId: group.id }),
    });
    return structuredClone(updated);
  }

  close(bufferId: string, actor: EventActor, discard = false): void {
    const buffer = this.require(bufferId);
    if (buffer.dirty && !discard) throw new Error('文档仍有未保存内容');
    this.#buffers.delete(bufferId);
    this.#watchers.get(bufferId)?.close();
    this.#watchers.delete(bufferId);
    const timer = this.#watchTimers.get(bufferId);
    if (timer) clearTimeout(timer);
    this.#watchTimers.delete(bufferId);
    if (discard || !buffer.dirty) this.#recoveries.delete(bufferKey(buffer.document.ref));
    this.persistRecoveries();
    this.#events.append({ streamId: `project:${this.#projectId}`, kind: 'document.closed', actor, payload: toJson({ bufferId, discarded: discard }) });
  }

  dispose(): void {
    for (const timer of this.#watchTimers.values()) clearTimeout(timer);
    this.#watchTimers.clear();
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    // Dirty buffers remain in the recovery projection so the next runtime can
    // reopen them without pretending that their contents were saved.
    this.persistRecoveries();
    this.#buffers.clear();
  }

  private require(id: string): DocumentBuffer {
    const buffer = this.#buffers.get(id);
    if (!buffer) throw new Error('文档缓冲不存在');
    return buffer;
  }

  private persistRecoveries(): void {
    const dirty = [...this.#recoveries.values()].filter((buffer) => buffer.dirty);
    atomicWriteJson(this.#recoveryPath, dirty);
  }

  private startWatcher(bufferId: string, absolute: string): void {
    try {
      const watcher = watch(absolute, { persistent: false }, () => {
        const previous = this.#watchTimers.get(bufferId);
        if (previous) clearTimeout(previous);
        const timer = setTimeout(() => this.handleExternalChange(bufferId, absolute), 120);
        timer.unref?.();
        this.#watchTimers.set(bufferId, timer);
      });
      watcher.on('error', () => undefined);
      this.#watchers.set(bufferId, watcher);
    } catch { /* network shares and transient files may not support native watching */ }
  }

  private handleExternalChange(bufferId: string, absolute: string): void {
    this.#watchTimers.delete(bufferId);
    const buffer = this.#buffers.get(bufferId);
    if (!buffer) return;
    try {
      if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error('文档已被外部删除或替换');
      const nextHash = sha256FileSync(absolute);
      if (nextHash === buffer.baseSha256) return;
      if (buffer.dirty) {
        this.#events.append({
          streamId: `project:${this.#projectId}`, kind: 'document.conflicted', actor: { id: 'openlab', kind: 'system' },
          provenanceRefs: [buffer.baseSha256, nextHash], payload: toJson({ bufferId, ref: buffer.document.ref, externalSha256: nextHash, reason: 'external_change_while_dirty' }),
        });
        return;
      }
      const stats = statSync(absolute);
      if (stats.size > MAX_DOCUMENT_BYTES) throw new Error('外部修改后的文档超过编辑器大小上限');
      const raw = readFileSync(absolute);
      if (raw.includes(0)) throw new Error('外部修改将文档变成了二进制文件');
      const updated: DocumentBuffer = {
        ...buffer,
        content: raw.toString('utf8'),
        baseSha256: nextHash,
        document: { ...buffer.document, sha256: nextHash, size: stats.size, modifiedAt: stats.mtime.toISOString() },
        updatedAt: new Date().toISOString(),
      };
      this.#buffers.set(bufferId, updated);
      this.#events.append({
        streamId: `project:${this.#projectId}`, kind: 'document.external_changed', actor: { id: 'openlab', kind: 'system' },
        provenanceRefs: [buffer.baseSha256, nextHash], payload: toJson({ bufferId, document: updated.document }),
      });
    } catch (error) {
      this.#events.append({
        streamId: `project:${this.#projectId}`, kind: 'document.conflicted', actor: { id: 'openlab', kind: 'system' },
        provenanceRefs: [buffer.baseSha256], payload: toJson({ bufferId, ref: buffer.document.ref, error: error instanceof Error ? error.message : String(error) }),
      });
    }
  }
}
