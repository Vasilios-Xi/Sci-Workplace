import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { EventActor } from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { PathGuard } from '../security/path-guard.js';
import { atomicWriteJson, readJsonProjection } from '../util/files.js';
import { isRecord, toJson } from '../util/json.js';

const MAX_EDITABLE_FILE_BYTES = 5 * 1024 * 1024;

function assertEditableSize(target: string): void {
  if (existsSync(target) && statSync(target).size > MAX_EDITABLE_FILE_BYTES) throw new Error('文件超过 5 MB，不能通过对话 diff 工具修改或删除');
}

export interface ChangeSet {
  id: string;
  projectId: string;
  relativePath: string;
  rootId?: string;
  beforeHash: string | null;
  afterHash: string | null;
  snapshotPath: string | null;
  diff: string;
  traceId: string;
  agentId: string;
  createdAt: string;
  revertedAt?: string;
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function replayChanges(events: ReturnType<SqliteEventStore['list']>): Map<string, ChangeSet> {
  const changes = new Map<string, ChangeSet>();
  for (const event of events) {
    if (!['tool.file_changed', 'tool.file_deleted', 'tool.file_change_imported', 'tool.file_change_recovered', 'tool.file_change_reverted'].includes(event.kind)) continue;
    if (typeof event.payload !== 'object' || event.payload === null) continue;
    const change = event.payload as unknown as ChangeSet;
    if (typeof change.id === 'string') changes.set(change.id, structuredClone(change));
  }
  return changes;
}

function isChangeSet(value: unknown): value is ChangeSet {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.projectId === 'string'
    && typeof value.relativePath === 'string'
    && (typeof value.afterHash === 'string' || value.afterHash === null)
    && typeof value.traceId === 'string'
    && typeof value.agentId === 'string'
    && typeof value.createdAt === 'string';
}

export class ChangeSetStore {
  readonly #projectId: string;
  readonly #projectRoot: string;
  readonly #snapshotRoot: string;
  readonly #indexPath: string;
  readonly #guard: PathGuard;
  readonly #resolveRoot: ((rootId: string, intent: 'read' | 'write') => string) | undefined;
  readonly #events: SqliteEventStore;
  #changes: ChangeSet[];

  constructor(options: { projectId: string; projectRoot: string; snapshotRoot: string; events: SqliteEventStore; resolveRoot?: (rootId: string, intent: 'read' | 'write') => string }) {
    if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(options.projectId)) throw new Error('项目 ID 不能用于快照路径');
    this.#projectId = options.projectId;
    this.#projectRoot = options.projectRoot;
    this.#snapshotRoot = join(options.snapshotRoot, options.projectId);
    this.#indexPath = join(this.#snapshotRoot, 'changes.json');
    this.#guard = new PathGuard(options.projectRoot);
    this.#resolveRoot = options.resolveRoot;
    this.#events = options.events;
    mkdirSync(this.#snapshotRoot, { recursive: true });
    const projectedValue = readJsonProjection<unknown>(this.#indexPath, []);
    const projected = Array.isArray(projectedValue) ? projectedValue.filter(isChangeSet) : [];
    const replayed = replayChanges(this.#events.list(`project:${this.#projectId}`));
    for (const change of projected) {
      const eventVersion = replayed.get(change.id);
      if (!eventVersion) {
        replayed.set(change.id, change);
        this.#events.append({
          streamId: `project:${this.#projectId}`, kind: 'tool.file_change_imported', actor: { id: change.agentId, kind: 'agent' },
          agentId: change.agentId, traceId: change.traceId, timestamp: change.createdAt, payload: toJson(change),
        });
      } else if (change.revertedAt && !eventVersion.revertedAt) {
        replayed.set(change.id, change);
        this.#events.append({
          streamId: `project:${this.#projectId}`, kind: 'tool.file_change_recovered', actor: { id: change.agentId, kind: 'agent' },
          agentId: change.agentId, traceId: change.traceId, timestamp: change.revertedAt, payload: toJson(change),
        });
      }
    }
    this.#changes = [...replayed.values()];
    if (replayed.size > 0) this.persist();
  }

  list(): ChangeSet[] {
    return structuredClone(this.#changes);
  }

  preview(relativePathInput: string, content: string, rootId = 'project'): string {
    const root = this.rootPath(rootId, 'write');
    const target = this.guard(rootId, 'write').resolveForWrite(relativePathInput);
    assertEditableSize(target);
    if (Buffer.byteLength(content, 'utf8') > MAX_EDITABLE_FILE_BYTES) throw new Error('写入内容超过 5 MB 上限');
    const relativePath = relative(root, target).replaceAll('\\', '/');
    const before = existsSync(target) ? readFileSync(target, 'utf8') : '';
    return createTwoFilesPatch(`a/${relativePath}`, `b/${relativePath}`, before, content, '', '', { context: 3 });
  }

  previewDelete(relativePathInput: string, rootId = 'project'): string {
    const root = this.rootPath(rootId, 'write');
    const target = this.guard(rootId, 'write').resolveExisting(relativePathInput);
    if (!statSync(target).isFile()) throw new Error('只能删除项目内的普通文件');
    assertEditableSize(target);
    const relativePath = relative(root, target).replaceAll('\\', '/');
    const before = readFileSync(target, 'utf8');
    return createTwoFilesPatch(`a/${relativePath}`, '/dev/null', before, '', '', '', { context: 3 });
  }

  write(relativePathInput: string, content: string, actor: EventActor, agentId: string, traceId: string, rootId = 'project'): ChangeSet {
    const root = this.rootPath(rootId, 'write');
    const target = this.guard(rootId, 'write').resolveForWrite(relativePathInput);
    assertEditableSize(target);
    if (Buffer.byteLength(content, 'utf8') > MAX_EDITABLE_FILE_BYTES) throw new Error('写入内容超过 5 MB 上限');
    const relativePath = relative(root, target).replaceAll('\\', '/');
    const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (before === content) throw new Error('文件内容没有变化');
    const id = randomUUID();
    let snapshotPath: string | null = null;
    if (before !== null) {
      const snapshotDirectory = join(this.#snapshotRoot, id);
      mkdirSync(snapshotDirectory, { recursive: true });
      snapshotPath = join(snapshotDirectory, basename(target));
      writeFileSync(snapshotPath, before, 'utf8');
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    const change: ChangeSet = {
      id,
      projectId: this.#projectId,
      rootId,
      relativePath,
      beforeHash: before === null ? null : hash(before),
      afterHash: hash(content),
      snapshotPath,
      diff: createTwoFilesPatch(`a/${relativePath}`, `b/${relativePath}`, before ?? '', content, '', '', { context: 3 }),
      traceId,
      agentId,
      createdAt: new Date().toISOString(),
    };
    this.#changes.push(change);
    this.persist();
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'tool.file_changed',
      actor,
      agentId,
      traceId,
      payload: toJson(change),
    });
    return structuredClone(change);
  }

  delete(relativePathInput: string, actor: EventActor, agentId: string, traceId: string, rootId = 'project'): ChangeSet {
    const root = this.rootPath(rootId, 'write');
    const target = this.guard(rootId, 'write').resolveExisting(relativePathInput);
    if (!statSync(target).isFile()) throw new Error('只能删除项目内的普通文件');
    assertEditableSize(target);
    const relativePath = relative(root, target).replaceAll('\\', '/');
    const before = readFileSync(target, 'utf8');
    const id = randomUUID();
    const snapshotDirectory = join(this.#snapshotRoot, id);
    mkdirSync(snapshotDirectory, { recursive: true });
    const snapshotPath = join(snapshotDirectory, basename(target));
    writeFileSync(snapshotPath, before, 'utf8');
    rmSync(target);
    const change: ChangeSet = {
      id,
      projectId: this.#projectId,
      rootId,
      relativePath,
      beforeHash: hash(before),
      afterHash: null,
      snapshotPath,
      diff: createTwoFilesPatch(`a/${relativePath}`, '/dev/null', before, '', '', '', { context: 3 }),
      traceId,
      agentId,
      createdAt: new Date().toISOString(),
    };
    this.#changes.push(change);
    this.persist();
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'tool.file_deleted',
      actor,
      agentId,
      traceId,
      payload: toJson(change),
    });
    return structuredClone(change);
  }

  undo(id: string, actor: EventActor, agentId: string, traceId: string): ChangeSet {
    const index = this.#changes.findIndex((item) => item.id === id);
    const change = this.#changes[index];
    if (index < 0 || !change) throw new Error(`变更集不存在：${id}`);
    if (change.revertedAt) throw new Error('此变更已经撤销');
    const target = this.guard(change.rootId ?? 'project', 'write').resolveForWrite(change.relativePath);
    const exists = existsSync(target);
    if (change.afterHash === null) {
      if (exists) throw new Error('被删除的路径后来已重新创建，拒绝直接撤销以免覆盖新内容');
    } else {
      const current = exists ? readFileSync(target, 'utf8') : '';
      if (hash(current) !== change.afterHash) throw new Error('文件在此变更后又被修改，拒绝直接撤销以免覆盖新内容');
    }
    if (change.snapshotPath) {
      writeFileSync(target, readFileSync(change.snapshotPath, 'utf8'), 'utf8');
    } else {
      rmSync(target, { force: true });
    }
    const updated: ChangeSet = { ...change, revertedAt: new Date().toISOString() };
    this.#changes[index] = updated;
    this.persist();
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'tool.file_change_reverted',
      actor,
      agentId,
      traceId,
      payload: toJson(updated),
    });
    return structuredClone(updated);
  }

  private persist(): void {
    atomicWriteJson(this.#indexPath, this.#changes);
  }

  private rootPath(rootId: string, intent: 'read' | 'write'): string {
    return this.#resolveRoot ? this.#resolveRoot(rootId, intent) : this.#projectRoot;
  }

  private guard(rootId: string, intent: 'read' | 'write'): PathGuard {
    if (!this.#resolveRoot && rootId === 'project') return this.#guard;
    return new PathGuard(this.rootPath(rootId, intent));
  }
}
