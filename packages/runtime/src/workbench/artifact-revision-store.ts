import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import type {
  AnnotationSelector,
  ArtifactFileRole,
  ArtifactProvenance,
  ArtifactRevision,
  ArtifactRevisionFile,
  EventActor,
  SourceMapDescriptor,
  WorkspacePathRef,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { PathGuard } from '../security/path-guard.js';
import { atomicWriteJson, atomicWriteText, copyFilePortableSync } from '../util/files.js';
import { isRecord, toJson } from '../util/json.js';
import { sha256FileSync } from './file-hash.js';
import { validateAnnotationSelector } from './annotation-store.js';

const LARGE_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 1024 * 1024 * 1024;

function validUnit(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= 1; }

function validateMapSelector(selector: AnnotationSelector): void {
  const validateRect = (rect: { x: number; y: number; width: number; height: number }) => {
    if (![rect.x, rect.y, rect.width, rect.height].every(validUnit) || rect.width <= 0 || rect.height <= 0
      || rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001) throw new Error('Source map 区域坐标无效');
  };
  if (selector.kind === 'image-point') {
    if (!validUnit(selector.x) || !validUnit(selector.y)) throw new Error('Source map 图片坐标无效');
  } else if (selector.kind === 'image-rect') validateRect(selector);
  else if (selector.kind === 'document-anchor') validateAnnotationSelector(selector);
  else {
    if (!Number.isInteger(selector.page) || selector.page < 1 || !Array.isArray(selector.rects) || selector.rects.length === 0 || selector.rects.length > 256) throw new Error('Source map PDF 选择器无效');
    selector.rects.forEach(validateRect);
    if (selector.kind === 'pdf-text' && (!selector.exact.trim() || selector.exact.length > 20_000)) throw new Error('Source map PDF 文本选择器无效');
  }
}

export interface CreateArtifactRevisionInput {
  artifactId: string;
  parentRevisionId?: string;
  files: Array<{ role: ArtifactFileRole; ref?: WorkspacePathRef; content?: string; name?: string; mediaType?: string }>;
  jobId?: string;
  annotationSetIds?: string[];
  provenance: Omit<ArtifactProvenance, 'artifactId' | 'createdAt'>;
  verifiedInputFileHashes?: Record<string, string>;
  /** Plugin workflows may create an Artifact ledger without adding a generic
   * artifact object to the research-object library. */
  allowUnregistered?: boolean;
}

export class ArtifactRevisionStore {
  readonly #projectId: string;
  readonly #projectRoot: string;
  readonly #events: SqliteEventStore;
  readonly #resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
  readonly #artifactExists: (id: string) => boolean;
  readonly #archiveRoot: string;
  readonly #revisions = new Map<string, ArtifactRevision>();
  readonly #sourceMaps = new Map<string, SourceMapDescriptor>();

  constructor(options: {
    projectId: string;
    projectRoot: string;
    events: SqliteEventStore;
    resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
    artifactExists: (id: string) => boolean;
  }) {
    this.#projectId = options.projectId;
    this.#projectRoot = options.projectRoot;
    this.#events = options.events;
    this.#resolveRoot = options.resolveRoot;
    this.#artifactExists = options.artifactExists;
    this.#archiveRoot = join(options.projectRoot, '.openlab', 'archive');
    mkdirSync(join(this.#archiveRoot, 'objects'), { recursive: true });
    mkdirSync(join(this.#archiveRoot, 'manifests'), { recursive: true });
    this.replay();
  }

  list(artifactId?: string): ArtifactRevision[] {
    return [...this.#revisions.values()].filter((revision) => !artifactId || revision.artifactId === artifactId).map((revision) => structuredClone(revision));
  }

  sourceMaps(targetSha256?: string): SourceMapDescriptor[] {
    return [...this.#sourceMaps.values()].filter((map) => !targetSha256 || map.target.sha256 === targetSha256).map((map) => structuredClone(map));
  }

  rootFor(rootId: string): string | undefined {
    if (!rootId.startsWith('artifact:')) return undefined;
    const id = rootId.slice('artifact:'.length);
    if (!this.#revisions.has(id)) return undefined;
    return join(this.#archiveRoot, 'revisions', id);
  }

  create(input: CreateArtifactRevisionInput, actor: EventActor): ArtifactRevision {
    if (!input.allowUnregistered && !this.#artifactExists(input.artifactId)) throw new Error('Artifact 不存在，不能创建 revision');
    if (input.parentRevisionId) {
      const parent = this.#revisions.get(input.parentRevisionId);
      if (!parent || parent.artifactId !== input.artifactId) throw new Error('父 revision 不属于同一个 Artifact');
    }
    if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 512) throw new Error('Artifact revision 必须包含 1–512 个文件');
    const revisionId = randomUUID();
    const inlineRoot = join(this.#archiveRoot, 'revisions', revisionId);
    const stagingRoot = join(this.#archiveRoot, 'revisions', `.staging-${revisionId}`);
    const seen = new Set<string>();
    let inlineBytes = 0;
    let hasInlineFiles = false;
    let files: ArtifactRevisionFile[];
    try {
      files = input.files.map((file) => {
        if (Boolean(file.ref) === (file.content !== undefined)) throw new Error(`Revision 文件必须且只能提供 ref 或 content：${file.name}`);
        const name = (file.name?.trim() || (file.ref ? basename(file.ref.path) : '')).replaceAll('\\', '/');
        const finalTarget = resolve(inlineRoot, name);
        const nameRelative = relative(inlineRoot, finalTarget);
        if (!name || name.length > 400 || isAbsolute(name) || nameRelative.startsWith('..') || isAbsolute(nameRelative) || name.split('/').includes('..')) throw new Error(`Revision 文件名无效：${file.name}`);
        const key = `${file.role}:${name.toLocaleLowerCase()}`;
        if (seen.has(key)) throw new Error(`Revision 包含重复文件：${name}`);
        seen.add(key);
        if (file.ref) {
          const root = this.#resolveRoot(file.ref.rootId, 'read');
          const absolute = new PathGuard(root).resolveExisting(file.ref.path);
          const stats = statSync(absolute);
          if (!stats.isFile()) throw new Error(`Revision 文件不是普通文件：${file.ref.path}`);
          return {
            role: file.role,
            ref: { rootId: file.ref.rootId, path: file.ref.path.replaceAll('\\', '/') },
            name,
            ...(file.mediaType ? { mediaType: file.mediaType } : {}),
            sha256: sha256FileSync(absolute),
            size: stats.size,
          };
        }
        const content = file.content!;
        inlineBytes += Buffer.byteLength(content, 'utf8');
        if (inlineBytes > 100 * 1024 * 1024) throw new Error('Revision 内联内容总计超过 100 MB');
        hasInlineFiles = true;
        const stagedTarget = resolve(stagingRoot, name);
        atomicWriteText(stagedTarget, content);
        return {
          role: file.role,
          ref: { rootId: `artifact:${revisionId}`, path: name },
          name,
          ...(file.mediaType ? { mediaType: file.mediaType } : {}),
          sha256: sha256FileSync(stagedTarget),
          size: Buffer.byteLength(content, 'utf8'),
          archivedPath: relative(this.#projectRoot, finalTarget).replaceAll('\\', '/'),
          external: false,
        };
      });
      if (hasInlineFiles) {
        mkdirSync(dirname(inlineRoot), { recursive: true });
        renameSync(stagingRoot, inlineRoot);
      }
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    }
    const now = new Date().toISOString();
    const provenance: ArtifactProvenance = {
      ...input.provenance,
      // The host derives this ledger from the exact revision inputs so a
      // renderer or plugin cannot forge file provenance.
      inputFileHashes: {
        ...(input.verifiedInputFileHashes ?? {}),
        ...Object.fromEntries(files.flatMap((file) => file.ref ? [[`${file.ref.rootId}:${file.ref.path}`, file.sha256]] : [])),
      },
      artifactId: input.artifactId,
      createdAt: now,
    };
    const revision: ArtifactRevision = {
      id: revisionId, artifactId: input.artifactId,
      ...(input.parentRevisionId ? { parentRevisionId: input.parentRevisionId } : {}),
      files,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      annotationSetIds: [...new Set(input.annotationSetIds ?? [])],
      provenance,
      status: 'active',
      createdAt: now,
    };
    try {
      this.#revisions.set(revision.id, revision);
      this.#events.append({
        streamId: `project:${this.#projectId}`, kind: 'artifact.revision_created', actor,
        agentId: provenance.agentId, traceId: provenance.traceId,
        provenanceRefs: [revision.artifactId, ...revision.annotationSetIds, ...files.map((file) => file.sha256)],
        payload: toJson(revision),
      });
    } catch (error) {
      this.#revisions.delete(revision.id);
      if (hasInlineFiles) rmSync(inlineRoot, { recursive: true, force: true });
      throw error;
    }
    return structuredClone(revision);
  }

  archive(id: string, actor: EventActor, includeLargeFiles = false): ArtifactRevision {
    const revision = this.require(id);
    if (revision.status === 'archived') return structuredClone(revision);
    let copiedBytes = 0;
    const files = revision.files.map((file) => {
      if (!file.ref) return file;
      const root = this.#resolveRoot(file.ref.rootId, 'read');
      const absolute = new PathGuard(root).resolveExisting(file.ref.path);
      if (sha256FileSync(absolute) !== file.sha256) throw new Error(`归档输入已经变化：${file.name}`);
      if (file.size > LARGE_FILE_BYTES && !includeLargeFiles) return { ...file, external: true };
      copiedBytes += file.size;
      if (copiedBytes > MAX_ARCHIVE_TOTAL_BYTES) throw new Error('单个 revision 归档复制总量超过 1 GB 上限');
      const relativeObject = join('objects', file.sha256.slice(0, 2), file.sha256).replaceAll('\\', '/');
      const destination = join(this.#archiveRoot, relativeObject);
      if (!existsSync(destination)) {
        mkdirSync(dirname(destination), { recursive: true });
        copyFilePortableSync(absolute, destination);
      }
      return { ...file, archivedPath: `.openlab/archive/${relativeObject}`, external: false };
    });
    const archived: ArtifactRevision = { ...revision, files, status: 'archived', archivedAt: new Date().toISOString() };
    this.#revisions.set(id, archived);
    atomicWriteJson(join(this.#archiveRoot, 'manifests', `${id}.json`), archived);
    this.#events.append({
      streamId: `project:${this.#projectId}`, kind: 'artifact.revision_archived', actor,
      agentId: archived.provenance.agentId, traceId: archived.provenance.traceId,
      provenanceRefs: [id, ...files.map((file) => file.sha256)], payload: toJson(archived),
    });
    return structuredClone(archived);
  }

  restore(id: string, target: WorkspacePathRef, actor: EventActor): { revision: ArtifactRevision; restored: WorkspacePathRef[]; missing: string[] } {
    const revision = this.require(id);
    if (revision.status !== 'archived') throw new Error('只有已归档 revision 可以恢复');
    const root = this.#resolveRoot(target.rootId, 'write');
    const destinationRoot = new PathGuard(root).resolveForWrite(target.path);
    if (existsSync(destinationRoot)) throw new Error('恢复目标必须是尚不存在的新目录');
    mkdirSync(destinationRoot, { recursive: false });
    const restored: WorkspacePathRef[] = [];
    const missing: string[] = [];
    for (const [index, file] of revision.files.entries()) {
      if (!file.archivedPath) { missing.push(file.name); continue; }
      const object = new PathGuard(this.#projectRoot).resolveExisting(file.archivedPath);
      if (sha256FileSync(object) !== file.sha256) throw new Error(`归档对象完整性校验失败：${file.name}`);
      const safeName = file.name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_');
      const relativeTarget = join(file.role, `${String(index + 1).padStart(3, '0')}-${safeName}`).replaceAll('\\', '/');
      const destination = join(destinationRoot, relativeTarget);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(object, destination);
      restored.push({ rootId: target.rootId, path: relative(root, destination).replaceAll('\\', '/') });
    }
    this.#events.append({
      streamId: `project:${this.#projectId}`, kind: 'artifact.revision_restored', actor,
      provenanceRefs: [id], payload: toJson({ revisionId: id, target, restored, missing }),
    });
    return { revision: structuredClone(revision), restored, missing };
  }

  registerSourceMap(input: Omit<SourceMapDescriptor, 'id' | 'projectId' | 'createdAt'>, actor: EventActor): SourceMapDescriptor {
    if (!Array.isArray(input.regions) || input.regions.length === 0 || input.regions.length > 10_000) throw new Error('Source map 必须包含 1–10,000 个区域');
    const targetRoot = this.#resolveRoot(input.target.ref.rootId, 'read');
    const targetPath = new PathGuard(targetRoot).resolveExisting(input.target.ref.path);
    if (!statSync(targetPath).isFile() || sha256FileSync(targetPath) !== input.target.sha256) throw new Error('Source map 目标已经变化');
    let sourceCount = 0;
    for (const region of input.regions) {
      validateMapSelector(region.selector);
      if (!Array.isArray(region.sources) || region.sources.length === 0 || region.sources.length > 64) throw new Error('Source map 每个区域必须关联 1–64 个源码范围');
      sourceCount += region.sources.length;
      if (sourceCount > 100_000) throw new Error('Source map 源码范围总数超过上限');
      for (const source of region.sources) {
        if (!Number.isInteger(source.startLine) || !Number.isInteger(source.endLine) || source.startLine < 1 || source.endLine < source.startLine
          || (source.startColumn !== undefined && (!Number.isInteger(source.startColumn) || source.startColumn < 1))
          || (source.endColumn !== undefined && (!Number.isInteger(source.endColumn) || source.endColumn < 1))) throw new Error('Source map 源码范围无效');
        const sourceRoot = this.#resolveRoot(source.ref.rootId, 'read');
        const sourcePath = new PathGuard(sourceRoot).resolveExisting(source.ref.path);
        if (!statSync(sourcePath).isFile()) throw new Error(`Source map 源码不是普通文件：${source.ref.path}`);
      }
    }
    const map: SourceMapDescriptor = { ...structuredClone(input), id: randomUUID(), projectId: this.#projectId, createdAt: new Date().toISOString() };
    this.#sourceMaps.set(map.id, map);
    this.#events.append({
      streamId: `project:${this.#projectId}`, kind: 'source_map.registered', actor,
      provenanceRefs: [map.target.sha256, ...map.regions.flatMap((region) => region.sources.map((source) => `${source.ref.rootId}:${source.ref.path}:${source.startLine}`))],
      payload: toJson(map),
    });
    return structuredClone(map);
  }

  private require(id: string): ArtifactRevision {
    const revision = this.#revisions.get(id);
    if (!revision) throw new Error('Artifact revision 不存在');
    return revision;
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (event.kind.startsWith('artifact.revision_') && isRecord(event.payload) && typeof event.payload.id === 'string') {
        this.#revisions.set(event.payload.id, structuredClone(event.payload as unknown as ArtifactRevision));
      } else if (event.kind === 'source_map.registered' && isRecord(event.payload) && typeof event.payload.id === 'string') {
        this.#sourceMaps.set(event.payload.id, structuredClone(event.payload as unknown as SourceMapDescriptor));
      }
    }
  }
}
