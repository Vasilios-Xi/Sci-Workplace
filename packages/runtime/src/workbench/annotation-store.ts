import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type {
  Annotation,
  AnnotationComment,
  AnnotationSelector,
  AnnotationSet,
  DocumentRevisionRef,
  EventActor,
  NormalizedRect,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { PathGuard } from '../security/path-guard.js';
import { isRecord, toJson } from '../util/json.js';
import { sha256FileSync } from './file-hash.js';

const SYSTEM_ACTOR: EventActor = { id: 'openlab', kind: 'system', label: 'Sci Workplace Runtime' };

function validUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateRect(rect: NormalizedRect): void {
  if (![rect.x, rect.y, rect.width, rect.height].every(validUnit)) throw new Error('批注矩形坐标必须位于 0–1');
  if (rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001) {
    throw new Error('批注矩形必须具有有效面积且不能越过文档边界');
  }
}

export function validateAnnotationSelector(selector: AnnotationSelector): void {
  if (selector.kind === 'image-point') {
    if (!validUnit(selector.x) || !validUnit(selector.y)) throw new Error('图片批注点必须位于 0–1');
    return;
  }
  if (selector.kind === 'image-rect') {
    validateRect(selector);
    return;
  }
  if (selector.kind === 'document-anchor') {
    if (!/^[a-z][a-z0-9+.-]{0,63}(?::[a-z0-9][a-z0-9._-]{0,63})?$/u.test(selector.scheme)) throw new Error('文档锚点 scheme 无效');
    if (!selector.anchor.trim() || selector.anchor.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(selector.anchor)) throw new Error('文档锚点标识无效');
    const hasStart = selector.start !== undefined;
    const hasEnd = selector.end !== undefined;
    if (hasStart !== hasEnd) throw new Error('文档锚点范围无效：必须同时提供 start 与 end');
    if (hasStart && (!Number.isSafeInteger(selector.start) || !Number.isSafeInteger(selector.end) || selector.start! < 0 || selector.end! < selector.start!)) throw new Error('文档锚点范围无效');
    if (selector.exact !== undefined && (!selector.exact.trim() || selector.exact.length > 20_000)) throw new Error('文档锚点文本无效');
    return;
  }
  if (!Number.isInteger(selector.page) || selector.page < 1 || selector.page > 100_000) throw new Error('PDF 批注页码无效');
  if (!Array.isArray(selector.rects) || selector.rects.length === 0 || selector.rects.length > 256) throw new Error('PDF 批注必须包含 1–256 个矩形');
  selector.rects.forEach(validateRect);
  if (selector.kind === 'pdf-text' && (!selector.exact.trim() || selector.exact.length > 20_000)) throw new Error('PDF 文本批注内容无效');
}

function sameTarget(left: DocumentRevisionRef, right: DocumentRevisionRef): boolean {
  return left.ref.rootId === right.ref.rootId && left.ref.path === right.ref.path && left.sha256 === right.sha256
    && left.artifactRevisionId === right.artifactRevisionId;
}

export class AnnotationStore {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
  readonly #annotations = new Map<string, Annotation>();
  readonly #sets = new Map<string, AnnotationSet>();

  constructor(options: { projectId: string; events: SqliteEventStore; resolveRoot: (rootId: string, intent: 'read' | 'write') => string }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.#resolveRoot = options.resolveRoot;
    this.replay();
    this.refreshStale();
  }

  list(target?: DocumentRevisionRef): Annotation[] {
    this.refreshStale();
    return [...this.#annotations.values()].filter((annotation) => !target || sameTarget(annotation.target, target)).map((annotation) => structuredClone(annotation));
  }

  sets(): AnnotationSet[] {
    return [...this.#sets.values()].map((set) => structuredClone(set));
  }

  requireSubmittedSets(ids: string[]): AnnotationSet[] {
    const unique = [...new Set(ids)];
    if (unique.length > 200) throw new Error('Artifact 最多关联 200 个批注集合');
    return unique.map((id) => {
      const set = this.#sets.get(id);
      if (!set || set.status !== 'submitted' || !set.submittedAt || !set.submittedTurnId) {
        throw new Error(`批注集合未由用户提交给 Agent：${id}`);
      }
      return structuredClone(set);
    });
  }

  create(input: { target: DocumentRevisionRef; selector: AnnotationSelector; comment: string }, actor: EventActor): Annotation {
    this.verifyTarget(input.target);
    validateAnnotationSelector(input.selector);
    const content = input.comment.normalize('NFC').trim();
    if (!content || content.length > 20_000) throw new Error('批注内容必须为 1–20,000 个字符');
    const now = new Date().toISOString();
    const comment: AnnotationComment = { id: randomUUID(), actor, content, createdAt: now };
    const annotation: Annotation = {
      id: randomUUID(), projectId: this.#projectId, target: structuredClone(input.target), selector: structuredClone(input.selector),
      comments: [comment], status: 'open', sourceEventIds: [], createdAt: now, updatedAt: now,
    };
    const event = this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'annotation.created',
      actor,
      provenanceRefs: [input.target.sha256],
      payload: toJson(annotation),
    });
    annotation.sourceEventIds = [event.id];
    this.#annotations.set(annotation.id, annotation);
    return structuredClone(annotation);
  }

  update(id: string, patch: { comment?: string; status?: Annotation['status'] }, actor: EventActor): Annotation {
    const current = this.require(id);
    let comments = current.comments;
    if (patch.comment !== undefined) {
      const content = patch.comment.normalize('NFC').trim();
      if (!content || content.length > 20_000) throw new Error('批注回复必须为 1–20,000 个字符');
      comments = [...comments, { id: randomUUID(), actor, content, createdAt: new Date().toISOString() }];
    }
    const status = patch.status ?? current.status;
    if (!['open', 'submitted', 'resolved', 'dismissed', 'stale'].includes(status)) throw new Error('批注状态无效');
    if (current.status === 'stale' && status === 'submitted') throw new Error('目标已变化的批注不能直接提交');
    const updated: Annotation = { ...current, comments, status, updatedAt: new Date().toISOString() };
    const event = this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: status === 'stale' ? 'annotation.stale' : status === 'resolved' ? 'annotation.resolved' : 'annotation.updated',
      actor,
      provenanceRefs: [current.id, current.target.sha256],
      payload: toJson(updated),
    });
    updated.sourceEventIds = [...new Set([...updated.sourceEventIds, event.id])];
    this.#annotations.set(id, updated);
    return structuredClone(updated);
  }

  submit(ids: string[], actor: EventActor): AnnotationSet {
    const unique = [...new Set(ids)];
    if (unique.length === 0 || unique.length > 200) throw new Error('一次必须提交 1–200 条批注');
    const annotations = unique.map((id) => this.require(id));
    if (annotations.some((annotation) => annotation.status !== 'open')) throw new Error('只能提交仍处于打开状态的批注');
    const now = new Date().toISOString();
    for (const annotation of annotations) {
      const updated = { ...annotation, status: 'submitted' as const, updatedAt: now };
      const event = this.#events.append({
        streamId: `project:${this.#projectId}`, kind: 'annotation.submitted', actor,
        provenanceRefs: [annotation.id, annotation.target.sha256], payload: toJson(updated),
      });
      updated.sourceEventIds = [...new Set([...updated.sourceEventIds, event.id])];
      this.#annotations.set(annotation.id, updated);
    }
    const set: AnnotationSet = { id: randomUUID(), projectId: this.#projectId, annotationIds: unique, status: 'submitted', createdAt: now, submittedAt: now };
    this.#events.append({
      streamId: `project:${this.#projectId}`, kind: 'annotation_set.submitted', actor,
      provenanceRefs: unique, payload: toJson(set),
    });
    this.#sets.set(set.id, set);
    return structuredClone(set);
  }

  bindTurn(setId: string, turnId: string, actor: EventActor): AnnotationSet {
    const set = this.#sets.get(setId);
    if (!set) throw new Error('批注集合不存在');
    const updated = { ...set, submittedTurnId: turnId };
    this.#sets.set(setId, updated);
    this.#events.append({ streamId: `project:${this.#projectId}`, kind: 'annotation_set.bound_to_turn', actor, provenanceRefs: [setId, turnId], payload: toJson(updated) });
    return structuredClone(updated);
  }

  private verifyTarget(target: DocumentRevisionRef): void {
    const root = this.#resolveRoot(target.ref.rootId, 'read');
    const absolute = new PathGuard(root).resolveExisting(target.ref.path);
    if (!statSync(absolute).isFile()) throw new Error('批注目标不是普通文件');
    const actual = sha256FileSync(absolute);
    if (actual !== target.sha256) throw new Error('批注目标已变化，请重新打开最新 revision');
  }

  private refreshStale(): void {
    for (const [id, annotation] of this.#annotations) {
      if (['stale', 'resolved', 'dismissed'].includes(annotation.status)) continue;
      try { this.verifyTarget(annotation.target); }
      catch {
        const updated = { ...annotation, status: 'stale' as const, updatedAt: new Date().toISOString() };
        const event = this.#events.append({
          streamId: `project:${this.#projectId}`, kind: 'annotation.stale', actor: SYSTEM_ACTOR,
          provenanceRefs: [annotation.id, annotation.target.sha256], payload: toJson(updated),
        });
        updated.sourceEventIds = [...new Set([...updated.sourceEventIds, event.id])];
        this.#annotations.set(id, updated);
      }
    }
  }

  private require(id: string): Annotation {
    const annotation = this.#annotations.get(id);
    if (!annotation) throw new Error('批注不存在');
    return annotation;
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (event.kind.startsWith('annotation.') && isRecord(event.payload) && typeof event.payload.id === 'string') {
        const annotation = structuredClone(event.payload as unknown as Annotation);
        annotation.sourceEventIds = [...new Set([...(annotation.sourceEventIds ?? []), event.id])];
        this.#annotations.set(annotation.id, annotation);
      } else if (event.kind.startsWith('annotation_set.') && isRecord(event.payload) && typeof event.payload.id === 'string') {
        this.#sets.set(event.payload.id, structuredClone(event.payload as unknown as AnnotationSet));
      }
    }
  }
}
