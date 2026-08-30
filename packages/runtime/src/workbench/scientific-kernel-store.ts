import { randomUUID } from 'node:crypto';
import type {
  AnnotationSelector,
  DocumentRevisionRef,
  EventActor,
  EvidenceAnchorV1,
  EvidenceAnchorV2,
  ReviewRequestV1,
  RunRecordV1,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { toJson } from '../util/json.js';
import { validateAnnotationSelector } from './annotation-store.js';

interface ScientificKernelPayload {
  anchor?: EvidenceAnchorV1 | EvidenceAnchorV2;
  run?: RunRecordV1;
  review?: ReviewRequestV1;
}

export class ScientificKernelStore {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #anchors = new Map<string, EvidenceAnchorV1 | EvidenceAnchorV2>();
  readonly #anchorKeys = new Map<string, string>();
  readonly #runs = new Map<string, RunRecordV1>();
  readonly #reviews = new Map<string, ReviewRequestV1>();

  constructor(options: { projectId: string; events: SqliteEventStore }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.replay();
  }

  anchors(target?: DocumentRevisionRef): Array<EvidenceAnchorV1 | EvidenceAnchorV2> {
    return [...this.#anchors.values()]
      .filter((anchor) => !target || (anchor.target.sha256 === target.sha256 && anchor.target.ref.rootId === target.ref.rootId && anchor.target.ref.path === target.ref.path))
      .map((anchor) => structuredClone(anchor));
  }

  anchor(id: string): EvidenceAnchorV1 | EvidenceAnchorV2 {
    const anchor = this.#anchors.get(id);
    if (!anchor) throw new Error('EvidenceAnchor 不存在');
    return structuredClone(anchor);
  }

  createAnchor(input: {
    target: DocumentRevisionRef;
    selector: AnnotationSelector;
    page?: number;
    blockId?: string;
    asset?: EvidenceAnchorV1['asset'];
    exact?: string;
  }, actor: EventActor, idempotencyKey?: string): EvidenceAnchorV1 {
    const key = idempotencyKey?.trim();
    if (key) {
      const existingId = this.#anchorKeys.get(key);
      if (existingId) return this.anchor(existingId);
    }
    validateAnnotationSelector(input.selector);
    const page = input.page ?? (input.selector.kind === 'pdf-rect' || input.selector.kind === 'pdf-text' ? input.selector.page : undefined);
    if (page !== undefined && (!Number.isInteger(page) || page < 1)) throw new Error('EvidenceAnchor 页码必须从 1 开始');
    if (input.blockId !== undefined && !input.blockId.trim()) throw new Error('EvidenceAnchor blockId 不能为空');
    const id = randomUUID();
    const anchor: EvidenceAnchorV1 = {
      id,
      projectId: this.#projectId,
      target: structuredClone(input.target),
      ...(page !== undefined ? { page } : {}),
      ...(input.blockId ? { blockId: input.blockId.trim() } : {}),
      selector: structuredClone(input.selector),
      ...(input.asset ? { asset: structuredClone(input.asset) } : {}),
      ...(input.exact ? { exact: input.exact } : {}),
      createdAt: new Date().toISOString(),
    };
    this.#anchors.set(anchor.id, anchor);
    const eventKey = key ?? `evidence:create:${anchor.id}`;
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'evidence.anchor_created',
      actor,
      idempotencyKey: eventKey,
      provenanceRefs: [anchor.id, anchor.target.sha256],
      payload: toJson({ anchor }),
    });
    this.#anchorKeys.set(eventKey, anchor.id);
    return structuredClone(anchor);
  }

  createPaperAnchor(input: {
    paperId: string;
    documentId: string;
    revisionHash: string;
    canonicalUri: string;
    sourceKind: EvidenceAnchorV2['sourceKind'];
    target: DocumentRevisionRef;
    selector: AnnotationSelector;
    page?: number;
    blockId?: string;
    asset?: EvidenceAnchorV1['asset'];
    exact?: string;
  }, actor: EventActor, idempotencyKey: string): EvidenceAnchorV2 {
    const key = idempotencyKey.trim();
    if (!key) throw new Error('V2 EvidenceAnchor 必须提供幂等键');
    const existingId = this.#anchorKeys.get(key);
    if (existingId) {
      const existing = this.anchor(existingId);
      if ('schemaVersion' in existing && existing.schemaVersion === 2) return existing;
      throw new Error('V2 EvidenceAnchor 幂等键与旧锚点冲突');
    }
    if (!/^[a-f0-9]{64}$/u.test(input.revisionHash) || input.target.sha256 !== input.revisionHash) throw new Error('V2 EvidenceAnchor 修订哈希无效');
    if (!input.canonicalUri.startsWith(`paper:${input.paperId}/document:${input.documentId}/revision:${input.revisionHash}/page:`)) {
      throw new Error('V2 EvidenceAnchor canonicalUri 与论文修订不一致');
    }
    validateAnnotationSelector(input.selector);
    const page = input.page ?? (input.selector.kind === 'pdf-rect' || input.selector.kind === 'pdf-text' ? input.selector.page : undefined);
    if (page === undefined || !Number.isInteger(page) || page < 1) throw new Error('V2 EvidenceAnchor 必须包含有效页码');
    const anchor: EvidenceAnchorV2 = {
      id: randomUUID(), projectId: this.#projectId, schemaVersion: 2,
      paperId: input.paperId, documentId: input.documentId, revisionHash: input.revisionHash,
      canonicalUri: input.canonicalUri, sourceKind: input.sourceKind,
      target: structuredClone(input.target), page,
      ...(input.blockId?.trim() ? { blockId: input.blockId.trim() } : {}),
      selector: structuredClone(input.selector),
      ...(input.asset ? { asset: structuredClone(input.asset) } : {}),
      ...(input.exact ? { exact: input.exact } : {}),
      createdAt: new Date().toISOString(),
    };
    this.#anchors.set(anchor.id, anchor);
    this.#anchorKeys.set(key, anchor.id);
    this.#events.append({
      streamId: `project:${this.#projectId}`, kind: 'evidence.paper_anchor_created', actor,
      idempotencyKey: key, provenanceRefs: [anchor.id, anchor.target.sha256, anchor.paperId, anchor.documentId], payload: toJson({ anchor }),
    });
    return structuredClone(anchor);
  }

  runs(instanceId?: string): RunRecordV1[] {
    return [...this.#runs.values()]
      .filter((run) => !instanceId || run.instanceId === instanceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((run) => structuredClone(run));
  }

  startRun(input: Omit<RunRecordV1, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>, actor: EventActor, idempotencyKey?: string): RunRecordV1 {
    const now = new Date().toISOString();
    const run: RunRecordV1 = { ...structuredClone(input), id: randomUUID(), projectId: this.#projectId, createdAt: now, updatedAt: now };
    this.#runs.set(run.id, run);
    this.record('run.started', { run }, actor, idempotencyKey ?? `run:start:${run.id}`, [run.instanceId, run.id]);
    return structuredClone(run);
  }

  updateRun(id: string, patch: Partial<Pick<RunRecordV1, 'status' | 'progress' | 'stage' | 'inputRefs' | 'outputRefs'>>, actor: EventActor): RunRecordV1 {
    const current = this.#runs.get(id);
    if (!current) throw new Error('RunRecord 不存在');
    const run: RunRecordV1 = { ...current, ...structuredClone(patch), updatedAt: new Date().toISOString() };
    if (run.progress !== undefined && (!Number.isFinite(run.progress) || run.progress < 0 || run.progress > 1)) throw new Error('RunRecord progress 必须在 0–1 之间');
    this.#runs.set(run.id, run);
    this.record('run.updated', { run }, actor, `run:update:${run.id}:${run.updatedAt}`, [run.instanceId, run.id]);
    return structuredClone(run);
  }

  reviews(instanceId?: string): ReviewRequestV1[] {
    return [...this.#reviews.values()]
      .filter((review) => !instanceId || review.instanceId === instanceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((review) => structuredClone(review));
  }

  requestReview(input: Omit<ReviewRequestV1, 'id' | 'projectId' | 'status' | 'requestedBy' | 'createdAt'>, actor: EventActor): ReviewRequestV1 {
    for (const anchorId of input.evidenceAnchorIds) this.anchor(anchorId);
    const review: ReviewRequestV1 = {
      ...structuredClone(input),
      id: randomUUID(),
      projectId: this.#projectId,
      status: 'pending',
      requestedBy: structuredClone(actor),
      createdAt: new Date().toISOString(),
    };
    this.#reviews.set(review.id, review);
    this.record('review.requested', { review }, actor, `review:request:${review.id}`, [review.instanceId, review.id, ...review.evidenceAnchorIds]);
    return structuredClone(review);
  }

  decideReview(id: string, decision: 'approved' | 'rejected' | 'cancelled', actor: EventActor): ReviewRequestV1 {
    const current = this.#reviews.get(id);
    if (!current || current.status !== 'pending') throw new Error('ReviewRequest 不存在或已处理');
    const review: ReviewRequestV1 = {
      ...current,
      status: decision,
      decidedBy: structuredClone(actor),
      decidedAt: new Date().toISOString(),
    };
    this.#reviews.set(review.id, review);
    this.record('review.decided', { review }, actor, `review:decide:${review.id}`, [review.instanceId, review.id]);
    return structuredClone(review);
  }

  private record(kind: string, payload: ScientificKernelPayload, actor: EventActor, idempotencyKey: string, provenanceRefs: string[]): void {
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind,
      actor,
      idempotencyKey,
      provenanceRefs,
      payload: toJson(payload),
    });
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (!event.kind.startsWith('evidence.') && !event.kind.startsWith('run.') && !event.kind.startsWith('review.')) continue;
      const payload = event.payload as unknown as ScientificKernelPayload;
      if (payload.anchor?.id) {
        this.#anchors.set(payload.anchor.id, structuredClone(payload.anchor));
        this.#anchorKeys.set(event.idempotencyKey, payload.anchor.id);
      }
      if (payload.run?.id) this.#runs.set(payload.run.id, structuredClone(payload.run));
      if (payload.review?.id) this.#reviews.set(payload.review.id, structuredClone(payload.review));
    }
  }
}
