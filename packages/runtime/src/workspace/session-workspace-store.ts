import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  ConversationFile,
  ConversationFileOrigin,
  ChatAttachmentRef,
  EventActor,
  SessionWorkspace,
  WorkspaceEntry,
  WorkspacePathRef,
  WorkspacePreview,
  WorkspaceRootSummary,
  WorkspaceSearchResult,
  WorkspaceAccessMode,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { PathGuard } from '../security/path-guard.js';
import { isRecord, toJson } from '../util/json.js';

const PROJECT_ROOT_ID = 'project';
const MAX_DIRECTORY_RESULTS = 500;
const MAX_SEARCH_RESULTS = 500;
const MAX_OPERATION_ENTRIES = 10_000;
const MAX_OPERATION_BYTES = 1024 * 1024 * 1024;
const MAX_PREVIEW_FILE_BYTES = 5 * 1024 * 1024;
const MAX_RICH_PREVIEW_FILE_BYTES = 25 * 1024 * 1024;
const MAX_NOTE_CHARACTERS = 20_000;
const HIDDEN_NAMES = new Set(['.openlab', '.git', 'node_modules', 'dist', 'coverage', '.next', 'release']);

interface InternalRoot extends WorkspaceRootSummary {
  absolutePath: string;
}

interface TreeState {
  ref: WorkspacePathRef;
  existed: boolean;
  kind?: 'file' | 'directory';
  fingerprint?: string;
  snapshotName?: string;
}

export interface WorkspaceFileChange {
  id: string;
  operation: WorkspaceFileOperation['type'];
  before: TreeState[];
  after: TreeState[];
  createdAt: string;
  revertedAt?: string;
}

export type WorkspaceFileOperation =
  | { type: 'create_file'; target: WorkspacePathRef; content?: string }
  | { type: 'create_directory'; target: WorkspacePathRef }
  | { type: 'import'; sourcePath: string; target: WorkspacePathRef }
  | { type: 'rename' | 'move' | 'copy'; source: WorkspacePathRef; target: WorkspacePathRef }
  | { type: 'delete'; target: WorkspacePathRef };

interface SessionWorkspaceStoreOptions {
  projectId: string;
  projectRoot: string;
  projectRoots?: string[];
  projectName: string;
  sessionId: string;
  model: string;
  snapshotRoot: string;
  events: SqliteEventStore;
}

function mediaType(path: string): string | undefined {
  return ({
    '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
    '.json': 'application/json', '.jsonl': 'application/jsonl', '.yaml': 'application/yaml', '.yml': 'application/yaml',
    '.xml': 'application/xml', '.tex': 'application/x-tex', '.log': 'text/plain', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.cjs': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/tsx', '.jsx': 'text/jsx', '.css': 'text/css', '.html': 'text/html',
    '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword', '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  } as Record<string, string>)[extname(path).toLocaleLowerCase()];
}

function normalizeRelativePath(input: string, allowRoot = true): string {
  if (typeof input !== 'string' || input.length > 2_000 || input.includes('\0') || isAbsolute(input)) throw new Error('工作区相对路径无效');
  const value = input.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!value || value === '.') {
    if (allowRoot) return '.';
    throw new Error('不能对工作区根目录执行此操作');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[:\0]/u.test(segment))) throw new Error('工作区相对路径包含不安全片段');
  return segments.join('/');
}

function within(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function assertNoLink(path: string, root: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`拒绝访问符号链接或目录联接：${basename(path)}`);
  const real = realpathSync.native(path);
  if (!within(realpathSync.native(root), real)) throw new Error('路径通过符号链接或目录联接逃逸了授权根目录');
}

function inspectTree(path: string, root: string): { entries: number; bytes: number; fingerprint: string } {
  let entries = 0;
  let bytes = 0;
  const hash = createHash('sha256');
  const visit = (target: string, label: string) => {
    assertNoLink(target, root);
    const stats = statSync(target);
    entries += 1;
    if (entries > MAX_OPERATION_ENTRIES) throw new Error(`文件事务超过 ${MAX_OPERATION_ENTRIES.toLocaleString()} 个条目上限，请使用外部工具`);
    if (stats.isFile()) {
      bytes += stats.size;
      if (bytes > MAX_OPERATION_BYTES) throw new Error('文件事务超过 1 GB 上限，请使用外部工具');
      hash.update(`f:${label}:${stats.size}:`);
      hash.update(readFileSync(target));
      return;
    }
    if (!stats.isDirectory()) throw new Error(`不支持的文件系统条目：${label}`);
    hash.update(`d:${label}:`);
    const children = readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) visit(join(target, child.name), `${label}/${child.name}`);
  };
  visit(path, '.');
  return { entries, bytes, fingerprint: hash.digest('hex') };
}

function cloneSummary(root: InternalRoot): WorkspaceRootSummary {
  const { absolutePath: _absolutePath, ...summary } = root;
  return structuredClone(summary);
}

function boundProjectRootId(path: string): string {
  return `project-${createHash('sha256').update(resolve(path).toLocaleLowerCase()).digest('hex').slice(0, 16)}`;
}

export class SessionWorkspaceStore {
  readonly #projectId: string;
  readonly #projectRoot: string;
  readonly #sessionId: string;
  readonly #events: SqliteEventStore;
  readonly #snapshotRoot: string;
  readonly #roots = new Map<string, InternalRoot>();
  readonly #files = new Map<string, ConversationFile>();
  readonly #changes = new Map<string, WorkspaceFileChange>();
  #activeRootId = PROJECT_ROOT_ID;
  #note = '';
  #model: string;

  constructor(options: SessionWorkspaceStoreOptions) {
    this.#projectId = options.projectId;
    this.#projectRoot = resolve(options.projectRoot);
    this.#sessionId = options.sessionId;
    this.#events = options.events;
    this.#model = options.model;
    this.#snapshotRoot = join(options.snapshotRoot, options.projectId, 'workspace', options.sessionId);
    mkdirSync(this.#snapshotRoot, { recursive: true });
    this.#roots.set(PROJECT_ROOT_ID, {
      id: PROJECT_ROOT_ID,
      name: basename(this.#projectRoot) || options.projectName,
      displayPath: this.#projectRoot,
      kind: 'project',
      access: 'ask',
      status: 'online',
      absolutePath: this.#projectRoot,
    });
    this.replaceProjectRoots(options.projectRoots ?? []);
    this.replay();
    this.refreshRootStatuses();
  }

  get streamId(): string { return `session:${this.#sessionId}`; }
  get journalStreamId(): string { return `project:${this.#projectId}`; }

  snapshot(): SessionWorkspace {
    this.refreshRootStatuses();
    if (this.#roots.get(this.#activeRootId)?.status !== 'online') this.#activeRootId = PROJECT_ROOT_ID;
    return {
      sessionId: this.#sessionId,
      activeRootId: this.#activeRootId,
      roots: [...this.#roots.values()].map(cloneSummary),
      note: this.#note,
      model: this.#model,
      conversationFileCount: this.#files.size,
    };
  }

  conversationFiles(): ConversationFile[] {
    return [...this.#files.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((file) => structuredClone(file));
  }

  setModel(model: string): void { this.#model = model; }

  activeRoot(): WorkspaceRootSummary { return cloneSummary(this.requireRoot(this.#activeRootId, 'read')); }

  rootPath(rootId = this.#activeRootId, intent: 'read' | 'write' = 'read'): string {
    return this.requireRoot(rootId, intent).absolutePath;
  }

  rootForModel(rootId = this.#activeRootId): Pick<WorkspaceRootSummary, 'id' | 'name' | 'kind' | 'access' | 'status'> {
    const { id, name, kind, access, status } = this.requireRoot(rootId, 'read');
    return { id, name, kind, access, status };
  }

  rootsForModel(): Array<Pick<WorkspaceRootSummary, 'id' | 'name' | 'kind' | 'access' | 'status'>> {
    return this.snapshot().roots.map(({ id, name, kind, access, status }) => ({ id, name, kind, access, status }));
  }

  setProjectRoots(paths: string[]): SessionWorkspace {
    this.replaceProjectRoots(paths);
    return this.snapshot();
  }

  authorizeRoot(absolutePath: string, access: WorkspaceAccessMode, actor: EventActor): WorkspaceRootSummary {
    if (!['read_only', 'ask', 'trusted'].includes(access)) throw new Error('目录访问模式无效');
    const candidate = resolve(absolutePath);
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) throw new Error('授权目录不存在或不是目录');
    assertNoLink(candidate, candidate);
    const realCandidate = realpathSync.native(candidate);
    const realProject = realpathSync.native(this.#projectRoot);
    if (realCandidate.toLocaleLowerCase() === realProject.toLocaleLowerCase()) return cloneSummary(this.#roots.get(PROJECT_ROOT_ID)!);
    for (const root of this.#roots.values()) {
      try {
        if (realpathSync.native(root.absolutePath).toLocaleLowerCase() === realCandidate.toLocaleLowerCase()) {
          if (root.kind === 'authorized') {
            root.access = access;
            root.status = 'online';
            this.append('workspace.root_authorized', actor, { root, absolutePath: root.absolutePath });
          }
          return cloneSummary(root);
        }
      } catch { /* offline roots can coexist until explicitly revoked */ }
    }
    const id = `root-${randomUUID()}`;
    const root: InternalRoot = {
      id,
      name: basename(realCandidate) || '授权目录',
      displayPath: realCandidate,
      kind: 'authorized',
      access,
      status: 'online',
      absolutePath: realCandidate,
    };
    this.#roots.set(id, root);
    this.append('workspace.root_authorized', actor, { root, absolutePath: realCandidate });
    return cloneSummary(root);
  }

  confirmRoot(rootId: string, actor: EventActor): WorkspaceRootSummary {
    const root = this.#roots.get(rootId);
    if (!root || root.kind !== 'authorized') throw new Error('待确认授权目录不存在');
    if (!existsSync(root.absolutePath) || !statSync(root.absolutePath).isDirectory()) throw new Error('授权目录当前离线');
    assertNoLink(root.absolutePath, root.absolutePath);
    root.status = 'online';
    this.append('workspace.root_confirmed', actor, { rootId });
    return cloneSummary(root);
  }

  revokeRoot(rootId: string, actor: EventActor): void {
    if (this.#roots.get(rootId)?.kind === 'project') throw new Error('不能撤销项目文件夹；请在项目设置中解除绑定');
    if (!this.#roots.delete(rootId)) throw new Error('授权目录不存在');
    if (this.#activeRootId === rootId) this.#activeRootId = PROJECT_ROOT_ID;
    this.append('workspace.root_revoked', actor, { rootId, fallbackRootId: PROJECT_ROOT_ID });
  }

  setActiveRoot(rootId: string, actor: EventActor): SessionWorkspace {
    this.requireRoot(rootId, 'read');
    this.#activeRootId = rootId;
    this.append('workspace.active_root_changed', actor, { rootId });
    return this.snapshot();
  }

  setNote(note: string, actor: EventActor): SessionWorkspace {
    if (typeof note !== 'string' || note.length > MAX_NOTE_CHARACTERS) throw new Error(`手账内容不能超过 ${MAX_NOTE_CHARACTERS.toLocaleString()} 字`);
    if (note === this.#note) return this.snapshot();
    this.#note = note;
    this.#events.append({ streamId: this.journalStreamId, kind: 'project.journal_changed', actor, payload: toJson({ note }) });
    return this.snapshot();
  }

  listDirectory(ref: WorkspacePathRef, options: { showHidden?: boolean; sort?: 'name' | 'modified'; order?: 'asc' | 'desc' } = {}): WorkspaceEntry[] {
    const root = this.requireRoot(ref.rootId, 'read');
    const path = normalizeRelativePath(ref.path);
    const absolute = new PathGuard(root.absolutePath).resolveExisting(path);
    assertNoLink(absolute, root.absolutePath);
    if (!statSync(absolute).isDirectory()) throw new Error('目标不是目录');
    const output: WorkspaceEntry[] = [];
    const entries = readdirSync(absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (output.length >= MAX_DIRECTORY_RESULTS) break;
      if (!options.showHidden && (HIDDEN_NAMES.has(entry.name) || entry.name.startsWith('.'))) continue;
      const target = join(absolute, entry.name);
      try {
        assertNoLink(target, root.absolutePath);
        const stats = statSync(target);
        if (!stats.isFile() && !stats.isDirectory()) continue;
        const relativePath = relative(root.absolutePath, target).replaceAll('\\', '/');
        const type = stats.isFile() ? mediaType(entry.name) : undefined;
        output.push({
          rootId: root.id,
          path: relativePath,
          name: entry.name,
          kind: stats.isDirectory() ? 'directory' : 'file',
          size: stats.isFile() ? stats.size : 0,
          modifiedAt: stats.mtime.toISOString(),
          ...(type ? { mediaType: type } : {}),
        });
      } catch { /* links, races and unreadable entries are deliberately omitted */ }
    }
    const multiplier = options.order === 'desc' ? -1 : 1;
    output.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
      return multiplier * (options.sort === 'modified'
        ? left.modifiedAt.localeCompare(right.modifiedAt)
        : left.name.localeCompare(right.name, 'zh-CN', { numeric: true }));
    });
    return output;
  }

  search(rootId: string, query: string, options: { showHidden?: boolean; includeContent?: boolean } = {}): WorkspaceSearchResult[] {
    const root = this.requireRoot(rootId, 'read');
    const needle = query.trim().toLocaleLowerCase();
    if (!needle || needle.length > 500) return [];
    const output: WorkspaceSearchResult[] = [];
    let scanned = 0;
    const visit = (directory: string) => {
      if (output.length >= MAX_SEARCH_RESULTS || scanned >= MAX_OPERATION_ENTRIES) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (output.length >= MAX_SEARCH_RESULTS || scanned >= MAX_OPERATION_ENTRIES) break;
        if (!options.showHidden && (HIDDEN_NAMES.has(entry.name) || entry.name.startsWith('.'))) continue;
        const target = join(directory, entry.name);
        scanned += 1;
        try {
          assertNoLink(target, root.absolutePath);
          const stats = statSync(target);
          const relativePath = relative(root.absolutePath, target).replaceAll('\\', '/');
          const type = stats.isFile() ? mediaType(entry.name) : undefined;
          const candidate: WorkspaceEntry = {
            rootId: root.id, path: relativePath, name: entry.name, kind: stats.isDirectory() ? 'directory' : 'file',
            size: stats.isFile() ? stats.size : 0, modifiedAt: stats.mtime.toISOString(),
            ...(type ? { mediaType: type } : {}),
          };
          if (entry.name.toLocaleLowerCase().includes(needle)) output.push({ entry: candidate });
          if (stats.isFile() && options.includeContent && stats.size <= 1024 * 1024 && (mediaType(entry.name)?.startsWith('text/') ?? false)) {
            const content = readFileSync(target, 'utf8');
            if (!content.includes('\0')) {
              const matches: Array<{ line: number; preview: string }> = [];
              for (const [index, line] of content.split(/\r?\n/u).entries()) {
                if (line.toLocaleLowerCase().includes(needle)) matches.push({ line: index + 1, preview: line.slice(0, 240) });
                if (matches.length >= 5) break;
              }
              if (matches.length > 0) {
                const existing = output.find((result) => result.entry.path === candidate.path);
                if (existing) existing.matches = matches;
                else output.push({ entry: candidate, matches });
              }
            }
          }
          if (stats.isDirectory()) visit(target);
        } catch { /* omit escaping, unreadable and concurrently removed entries */ }
      }
    };
    visit(root.absolutePath);
    return output.slice(0, MAX_SEARCH_RESULTS);
  }

  preview(ref: WorkspacePathRef): WorkspacePreview {
    const root = this.requireRoot(ref.rootId, 'read');
    const path = normalizeRelativePath(ref.path, false);
    const absolute = new PathGuard(root.absolutePath).resolveExisting(path);
    assertNoLink(absolute, root.absolutePath);
    const stats = statSync(absolute);
    if (!stats.isFile()) throw new Error('只能预览普通文件');
    const type = mediaType(path);
    const base = { ref: { rootId: root.id, path }, name: basename(path), ...(type ? { mediaType: type } : {}), size: stats.size };
    if (type?.startsWith('image/') && type !== 'image/svg+xml' && stats.size <= 10 * 1024 * 1024) {
      return { ...base, kind: 'image', dataUrl: `data:${type};base64,${readFileSync(absolute).toString('base64')}` };
    }
    if (type === 'application/pdf' && stats.size <= MAX_RICH_PREVIEW_FILE_BYTES) {
      return { ...base, kind: 'pdf', dataUrl: `data:${type};base64,${readFileSync(absolute).toString('base64')}` };
    }
    if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' && stats.size <= MAX_RICH_PREVIEW_FILE_BYTES) {
      return { ...base, kind: 'word', dataUrl: `data:${type};base64,${readFileSync(absolute).toString('base64')}` };
    }
    const textual = type?.startsWith('text/') || ['application/json', 'application/jsonl', 'application/yaml', 'application/xml', 'application/x-tex'].includes(type ?? '');
    if (textual && stats.size <= MAX_PREVIEW_FILE_BYTES) {
      const content = readFileSync(absolute, 'utf8');
      const truncated = content.length > 200_000;
      return { ...base, kind: 'text', content: truncated ? content.slice(0, 200_000) : content, truncated };
    }
    return { ...base, kind: 'metadata' };
  }

  resolveForShell(ref: WorkspacePathRef): string {
    const root = this.requireRoot(ref.rootId, 'read');
    return new PathGuard(root.absolutePath).resolveExisting(normalizeRelativePath(ref.path));
  }

  chatAttachment(ref: WorkspacePathRef): ChatAttachmentRef {
    const root = this.requireRoot(ref.rootId, 'read');
    const path = normalizeRelativePath(ref.path, false);
    const absolute = new PathGuard(root.absolutePath).resolveExisting(path);
    assertNoLink(absolute, root.absolutePath);
    const stats = statSync(absolute);
    if (!stats.isFile()) throw new Error('只能引用普通文件');
    if (stats.size > 100 * 1024 * 1024) throw new Error('引用文件超过 100 MB 上限');
    const type = mediaType(path);
    return {
      id: randomUUID(), name: basename(path), rootId: root.id, relativePath: path,
      sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'), size: stats.size,
      ...(type ? { mediaType: type } : {}),
    };
  }

  registerConversationFile(ref: WorkspacePathRef, origin: ConversationFileOrigin, actor: EventActor, options: { artifactId?: string; sourceEventIds?: string[] } = {}): ConversationFile {
    const root = this.requireRoot(ref.rootId, 'read');
    const path = normalizeRelativePath(ref.path, false);
    const absolute = new PathGuard(root.absolutePath).resolveExisting(path);
    assertNoLink(absolute, root.absolutePath);
    const stats = statSync(absolute);
    if (!stats.isFile()) throw new Error('只能把普通文件加入对话文件');
    const existing = [...this.#files.values()].find((file) => file.ref.rootId === root.id && file.ref.path === path);
    if (existing) return structuredClone(existing);
    const type = mediaType(path);
    const file: ConversationFile = {
      id: randomUUID(), ref: { rootId: root.id, path }, name: basename(path), origin, size: stats.size,
      ...(type ? { mediaType: type } : {}), createdAt: new Date().toISOString(),
      ...(options.artifactId ? { artifactId: options.artifactId } : {}), sourceEventIds: [...new Set(options.sourceEventIds ?? [])],
    };
    this.#files.set(file.id, file);
    this.append('conversation.file_registered', actor, file, options.sourceEventIds ?? []);
    return structuredClone(file);
  }

  removeConversationFile(id: string, actor: EventActor): ConversationFile {
    const file = this.#files.get(id);
    if (!file) throw new Error('对话文件不存在');
    this.#files.delete(id);
    this.append('conversation.file_removed', actor, { id, file });
    return structuredClone(file);
  }

  operate(operation: WorkspaceFileOperation, actor: EventActor): WorkspaceFileChange {
    const references = operation.type === 'rename' || operation.type === 'move' || operation.type === 'copy'
      ? [operation.source, operation.target] : [operation.target];
    const normalizedRefs = references.map((ref) => ({ rootId: ref.rootId, path: normalizeRelativePath(ref.path, false) }));
    const id = randomUUID();
    const changeRoot = join(this.#snapshotRoot, id);
    mkdirSync(join(changeRoot, 'before'), { recursive: true });
    const before = normalizedRefs.map((ref, index) => this.captureState(ref, join(changeRoot, 'before'), index, true));
    try {
      this.applyOperation(operation, normalizedRefs);
      const after = normalizedRefs.map((ref, index) => this.captureState(ref, join(changeRoot, 'after'), index, false));
      const change: WorkspaceFileChange = { id, operation: operation.type, before, after, createdAt: new Date().toISOString() };
      this.#changes.set(id, change);
      this.append('workspace.file_operation_completed', actor, change);
      return structuredClone(change);
    } catch (error) {
      this.restoreStates(before, normalizedRefs, id);
      rmSync(changeRoot, { recursive: true, force: true });
      throw error;
    }
  }

  undo(changeId: string, actor: EventActor): WorkspaceFileChange {
    const change = this.#changes.get(changeId);
    if (!change) throw new Error('文件变更集不存在');
    if (change.revertedAt) throw new Error('此文件变更已经撤销');
    for (const state of change.after) {
      const current = this.captureState(state.ref, undefined, 0, false);
      if (current.existed !== state.existed || current.fingerprint !== state.fingerprint) throw new Error('文件在此变更后又发生变化，拒绝覆盖');
    }
    this.restoreStates(change.before, change.after.map((state) => state.ref), change.id);
    const updated = { ...change, revertedAt: new Date().toISOString() };
    this.#changes.set(changeId, updated);
    this.append('workspace.file_operation_reverted', actor, updated);
    return structuredClone(updated);
  }

  forkAuthorizationEvents(targetSessionId: string, actor: EventActor): void {
    const targetStream = `session:${targetSessionId}`;
    for (const root of this.#roots.values()) {
      if (root.kind !== 'authorized') continue;
      this.#events.append({
        streamId: targetStream, kind: 'workspace.root_authorized', actor,
        payload: toJson({ root: { ...root, status: 'pending_confirmation' }, absolutePath: root.absolutePath, forkedPendingConfirmation: true }),
      });
    }
    this.#events.append({ streamId: targetStream, kind: 'workspace.active_root_changed', actor, payload: toJson({ rootId: PROJECT_ROOT_ID }) });
  }

  private applyOperation(operation: WorkspaceFileOperation, refs: WorkspacePathRef[]): void {
    const targetRef = refs.at(-1)!;
    const targetRoot = this.requireRoot(targetRef.rootId, 'write');
    const target = new PathGuard(targetRoot.absolutePath).resolveForWrite(targetRef.path);
    if (operation.type === 'create_file') {
      if (existsSync(target)) throw new Error('目标文件已存在');
      mkdirSync(dirname(target), { recursive: true });
      const content = operation.content ?? '';
      if (Buffer.byteLength(content, 'utf8') > MAX_PREVIEW_FILE_BYTES) throw new Error('新建文件内容超过 5 MB 上限');
      writeFileSync(target, content, 'utf8');
      return;
    }
    if (operation.type === 'create_directory') {
      if (existsSync(target)) throw new Error('目标目录已存在');
      mkdirSync(target, { recursive: false });
      return;
    }
    if (operation.type === 'import') {
      const source = resolve(operation.sourcePath);
      if (!existsSync(source) || !statSync(source).isFile()) throw new Error('导入来源不是普通文件');
      if (lstatSync(source).isSymbolicLink()) throw new Error('不能导入符号链接');
      if (statSync(source).size > MAX_OPERATION_BYTES) throw new Error('导入文件超过 1 GB 上限');
      if (existsSync(target)) throw new Error('目标文件已存在');
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { force: false, errorOnExist: true });
      return;
    }
    if (operation.type === 'delete') {
      if (!existsSync(target)) throw new Error('待删除条目不存在');
      inspectTree(target, targetRoot.absolutePath);
      rmSync(target, { recursive: true, force: false });
      return;
    }
    const sourceRef = refs[0]!;
    const sourceRoot = this.requireRoot(sourceRef.rootId, operation.type === 'copy' ? 'read' : 'write');
    const source = new PathGuard(sourceRoot.absolutePath).resolveExisting(sourceRef.path);
    if (existsSync(target)) throw new Error('目标路径已存在');
    inspectTree(source, sourceRoot.absolutePath);
    mkdirSync(dirname(target), { recursive: true });
    if ((operation.type === 'rename' || operation.type === 'move') && sourceRoot.id === targetRoot.id) renameSync(source, target);
    else {
      cpSync(source, target, { recursive: statSync(source).isDirectory(), errorOnExist: true, force: false });
      if (operation.type === 'rename' || operation.type === 'move') rmSync(source, { recursive: true, force: false });
    }
  }

  private captureState(ref: WorkspacePathRef, snapshotDirectory: string | undefined, index: number, copy: boolean): TreeState {
    const root = this.requireRoot(ref.rootId, 'read');
    const absolute = new PathGuard(root.absolutePath).resolveForWrite(ref.path);
    if (!existsSync(absolute)) return { ref: structuredClone(ref), existed: false };
    const stats = statSync(absolute);
    const inspected = inspectTree(absolute, root.absolutePath);
    const snapshotName = `${index}-${basename(absolute).replace(/[^a-zA-Z0-9._-]/gu, '_')}`;
    if (copy && snapshotDirectory) {
      mkdirSync(snapshotDirectory, { recursive: true });
      cpSync(absolute, join(snapshotDirectory, snapshotName), { recursive: stats.isDirectory(), force: false, errorOnExist: true });
    }
    return { ref: structuredClone(ref), existed: true, kind: stats.isDirectory() ? 'directory' : 'file', fingerprint: inspected.fingerprint, ...(copy ? { snapshotName } : {}) };
  }

  private restoreStates(states: TreeState[], refs: WorkspacePathRef[], changeId: string): void {
    for (const ref of [...refs].reverse()) {
      const root = this.requireRoot(ref.rootId, 'write');
      const absolute = new PathGuard(root.absolutePath).resolveForWrite(ref.path);
      if (existsSync(absolute)) rmSync(absolute, { recursive: true, force: true });
    }
    for (const state of states) {
      if (!state.existed || !state.snapshotName) continue;
      const root = this.requireRoot(state.ref.rootId, 'write');
      const target = new PathGuard(root.absolutePath).resolveForWrite(state.ref.path);
      const source = join(this.#snapshotRoot, changeId, 'before', state.snapshotName);
      if (!existsSync(source)) continue;
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: state.kind === 'directory', force: false, errorOnExist: true });
    }
  }

  private requireRoot(rootId: string, intent: 'read' | 'write'): InternalRoot {
    this.refreshRootStatuses();
    const root = this.#roots.get(rootId);
    if (!root) throw new Error(`工作区根不存在：${rootId}`);
    if (root.status === 'pending_confirmation') throw new Error('分支会话中的外部目录需要重新确认');
    if (root.status !== 'online') throw new Error('工作区目录当前离线');
    if (intent === 'write' && root.kind === 'authorized' && root.access === 'read_only') throw new Error('此授权目录为只读');
    return root;
  }

  private refreshRootStatuses(): void {
    for (const root of this.#roots.values()) {
      if (root.id === PROJECT_ROOT_ID || root.status === 'pending_confirmation') continue;
      try {
        root.status = existsSync(root.absolutePath) && statSync(root.absolutePath).isDirectory() ? 'online' : 'offline';
        if (root.status === 'online') assertNoLink(root.absolutePath, root.absolutePath);
      } catch { root.status = 'offline'; }
    }
  }

  private replaceProjectRoots(paths: string[]): void {
    const desired = new Map<string, string>();
    const primaryKey = this.#projectRoot.toLocaleLowerCase();
    for (const raw of paths.slice(0, 11)) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const path = resolve(raw);
      if (path.toLocaleLowerCase() === primaryKey) continue;
      desired.set(boundProjectRootId(path), path);
    }
    for (const [id, root] of this.#roots) {
      if (id !== PROJECT_ROOT_ID && root.kind === 'project' && !desired.has(id)) this.#roots.delete(id);
    }
    for (const [id, path] of desired) {
      let status: WorkspaceRootSummary['status'] = 'offline';
      try {
        if (existsSync(path) && statSync(path).isDirectory()) {
          assertNoLink(path, path);
          status = 'online';
        }
      } catch { /* Missing, linked, or unreadable bound roots stay visible as offline. */ }
      this.#roots.set(id, {
        id,
        name: basename(path) || '项目文件夹',
        displayPath: path,
        kind: 'project',
        access: 'trusted',
        status,
        absolutePath: path,
      });
    }
    if (!this.#roots.has(this.#activeRootId)) this.#activeRootId = PROJECT_ROOT_ID;
  }

  private replay(): void {
    for (const event of this.#events.list(this.streamId)) {
      if (!isRecord(event.payload)) continue;
      if (event.kind === 'workspace.root_authorized' && isRecord(event.payload.root) && typeof event.payload.absolutePath === 'string') {
        const value = event.payload.root;
        if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.displayPath !== 'string'
          || value.kind !== 'authorized' || !['read_only', 'ask', 'trusted'].includes(String(value.access))) continue;
        this.#roots.set(value.id, {
          id: value.id, name: value.name, displayPath: value.displayPath, kind: 'authorized', access: value.access as WorkspaceAccessMode,
          status: value.status === 'pending_confirmation' ? 'pending_confirmation' : 'online', absolutePath: event.payload.absolutePath,
        });
      } else if (event.kind === 'workspace.root_confirmed' && typeof event.payload.rootId === 'string') {
        const root = this.#roots.get(event.payload.rootId); if (root) root.status = 'online';
      } else if (event.kind === 'workspace.root_revoked' && typeof event.payload.rootId === 'string') {
        this.#roots.delete(event.payload.rootId);
      } else if (event.kind === 'workspace.active_root_changed' && typeof event.payload.rootId === 'string') {
        this.#activeRootId = event.payload.rootId;
      } else if (event.kind === 'workspace.note_changed' && typeof event.payload.note === 'string') {
        this.#note = event.payload.note.slice(0, MAX_NOTE_CHARACTERS);
      } else if (event.kind === 'conversation.file_registered' && typeof event.payload.id === 'string') {
        this.#files.set(event.payload.id, structuredClone(event.payload as unknown as ConversationFile));
      } else if (event.kind === 'conversation.file_removed' && typeof event.payload.id === 'string') {
        this.#files.delete(event.payload.id);
      } else if (event.kind === 'workspace.file_operation_completed' && typeof event.payload.id === 'string') {
        this.#changes.set(event.payload.id, structuredClone(event.payload as unknown as WorkspaceFileChange));
      } else if (event.kind === 'workspace.file_operation_reverted' && typeof event.payload.id === 'string') {
        this.#changes.set(event.payload.id, structuredClone(event.payload as unknown as WorkspaceFileChange));
      }
    }
    for (const event of this.#events.list(this.journalStreamId)) {
      if (event.kind !== 'project.journal_changed' || !isRecord(event.payload) || typeof event.payload.note !== 'string') continue;
      this.#note = event.payload.note.slice(0, MAX_NOTE_CHARACTERS);
    }
  }

  private append(kind: string, actor: EventActor, payload: unknown, provenanceRefs: string[] = []): void {
    this.#events.append({ streamId: this.streamId, kind, actor, provenanceRefs, payload: toJson(payload) });
  }
}

export { PROJECT_ROOT_ID };
