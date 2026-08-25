import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type {
  EventActor,
  WorkspaceEditGroup,
  WorkspaceEditPreview,
  WorkspaceEditRequest,
  WorkspacePathRef,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { PathGuard } from '../security/path-guard.js';
import type { ChangeSetStore } from '../tools/change-set-store.js';
import { isRecord, toJson } from '../util/json.js';

const MAX_EDIT_FILES = 128;
const MAX_EDIT_BYTES = 20 * 1024 * 1024;
const PREVIEW_TTL_MS = 15 * 60_000;

interface PendingPreview {
  preview: WorkspaceEditPreview;
  request: WorkspaceEditRequest;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeRef(ref: WorkspacePathRef): WorkspacePathRef {
  if (!ref || typeof ref.rootId !== 'string' || !ref.rootId) throw new Error('工作区编辑缺少 rootId');
  if (typeof ref.path !== 'string' || !ref.path.trim()) throw new Error('工作区编辑缺少相对路径');
  return { rootId: ref.rootId, path: ref.path.replaceAll('\\', '/') };
}

export class WorkspaceEditService {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #changes: ChangeSetStore;
  readonly #resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
  readonly #pending = new Map<string, PendingPreview>();
  readonly #groups = new Map<string, WorkspaceEditGroup>();
  readonly #onChanged: () => void;

  constructor(options: {
    projectId: string;
    events: SqliteEventStore;
    changes: ChangeSetStore;
    resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
    onChanged?: () => void;
  }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.#changes = options.changes;
    this.#resolveRoot = options.resolveRoot;
    this.#onChanged = options.onChanged ?? (() => undefined);
    this.replay();
  }

  pending(): WorkspaceEditPreview[] {
    this.cleanupExpired();
    return [...this.#pending.values()].map(({ preview }) => structuredClone(preview));
  }

  groups(): WorkspaceEditGroup[] {
    return [...this.#groups.values()].map((group) => structuredClone(group));
  }

  preview(request: WorkspaceEditRequest, actor: EventActor): WorkspaceEditPreview {
    if (!request.label.trim() || request.label.length > 500) throw new Error('编辑说明必须为 1–500 个字符');
    if (!['user', 'agent', 'plugin'].includes(request.origin)) throw new Error('编辑来源无效');
    if (!Array.isArray(request.edits) || request.edits.length === 0 || request.edits.length > MAX_EDIT_FILES) {
      throw new Error(`一次多文件编辑必须包含 1–${MAX_EDIT_FILES} 个文件`);
    }
    const seen = new Set<string>();
    let bytes = 0;
    const normalized = request.edits.map((edit) => {
      const ref = normalizeRef(edit.ref);
      const key = `${ref.rootId}:${ref.path.toLocaleLowerCase()}`;
      if (seen.has(key)) throw new Error(`一次编辑不能重复包含文件：${ref.path}`);
      seen.add(key);
      bytes += Buffer.byteLength(edit.content, 'utf8');
      if (bytes > MAX_EDIT_BYTES) throw new Error('多文件编辑内容超过 20 MB 上限');
      return { ...edit, ref };
    });
    const files = normalized.map((edit) => {
      const root = this.#resolveRoot(edit.ref.rootId, 'write');
      const target = new PathGuard(root).resolveForWrite(edit.ref.path);
      const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
      const beforeSha256 = before === null ? null : sha256(before);
      if (edit.baseSha256 !== beforeSha256) throw new Error(`文件已变化，请重新载入后再编辑：${edit.ref.path}`);
      if (before === edit.content) throw new Error(`文件内容没有变化：${edit.ref.path}`);
      return {
        ref: edit.ref,
        beforeSha256,
        afterSha256: sha256(edit.content),
        diff: this.#changes.preview(edit.ref.path, edit.content, edit.ref.rootId),
      };
    });
    const now = Date.now();
    const preview: WorkspaceEditPreview = {
      id: randomUUID(),
      label: request.label.trim(),
      origin: request.origin,
      files,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    };
    this.#pending.set(preview.id, { preview, request: { ...request, edits: normalized } });
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'workspace_edit.previewed',
      actor,
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...(request.traceId ? { traceId: request.traceId } : {}),
      payload: toJson(preview),
    });
    this.#onChanged();
    return structuredClone(preview);
  }

  apply(previewId: string, actor: EventActor, confirmed: boolean): WorkspaceEditGroup {
    const pending = this.#pending.get(previewId);
    if (!pending) throw new Error('编辑预览不存在或已经失效');
    if (Date.parse(pending.preview.expiresAt) <= Date.now()) {
      this.#pending.delete(previewId);
      throw new Error('编辑预览已经过期，请重新生成 diff');
    }
    if (pending.request.origin !== 'user' && !confirmed) throw new Error('Agent 或插件编辑必须在 diff 审批后执行');
    const actorId = pending.request.agentId ?? actor.id;
    const traceId = pending.request.traceId ?? randomUUID();
    const applied: string[] = [];
    try {
      for (const edit of pending.request.edits) {
        const root = this.#resolveRoot(edit.ref.rootId, 'write');
        const target = new PathGuard(root).resolveForWrite(edit.ref.path);
        const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
        if ((before === null ? null : sha256(before)) !== edit.baseSha256) throw new Error(`文件在审批期间发生变化：${edit.ref.path}`);
        const change = this.#changes.write(edit.ref.path, edit.content, actor, actorId, traceId, edit.ref.rootId);
        applied.push(change.id);
      }
    } catch (error) {
      for (const id of [...applied].reverse()) {
        try { this.#changes.undo(id, { id: 'openlab', kind: 'system' }, actorId, traceId); }
        catch { /* the original error remains primary; recovery is visible in the event stream */ }
      }
      throw error;
    }
    const group: WorkspaceEditGroup = {
      ...pending.preview,
      changeSetIds: applied,
      appliedAt: new Date().toISOString(),
    };
    this.#pending.delete(previewId);
    this.#groups.set(group.id, group);
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'workspace_edit.applied',
      actor,
      ...(pending.request.agentId ? { agentId: pending.request.agentId } : {}),
      traceId,
      provenanceRefs: applied,
      payload: toJson(group),
    });
    this.#onChanged();
    return structuredClone(group);
  }

  undo(groupId: string, actor: EventActor): WorkspaceEditGroup {
    const group = this.#groups.get(groupId);
    if (!group) throw new Error('多文件变更组不存在');
    if (group.revertedAt) throw new Error('多文件变更组已经撤销');
    const traceId = randomUUID();
    for (const id of [...group.changeSetIds].reverse()) this.#changes.undo(id, actor, actor.id, traceId);
    const updated = { ...group, revertedAt: new Date().toISOString() };
    this.#groups.set(groupId, updated);
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'workspace_edit.reverted',
      actor,
      traceId,
      provenanceRefs: group.changeSetIds,
      payload: toJson(updated),
    });
    this.#onChanged();
    return structuredClone(updated);
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, pending] of this.#pending) {
      if (Date.parse(pending.preview.expiresAt) <= now) this.#pending.delete(id);
    }
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (!['workspace_edit.applied', 'workspace_edit.reverted'].includes(event.kind) || !isRecord(event.payload) || typeof event.payload.id !== 'string') continue;
      this.#groups.set(event.payload.id, structuredClone(event.payload as unknown as WorkspaceEditGroup));
    }
  }
}
