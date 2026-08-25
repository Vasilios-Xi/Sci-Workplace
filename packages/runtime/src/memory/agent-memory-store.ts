import { randomUUID } from 'node:crypto';
import type {
  AgentDefinition,
  AgentMemoryItem,
  AgentMemoryKind,
  AgentMemoryScope,
  AgentMemorySummary,
  EventActor,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { isRecord, toJson } from '../util/json.js';

const USER_ACTOR: EventActor = { id: 'local-user', kind: 'user', label: '本地用户' };
const SECRET_PATTERN = /(?:sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._~+\/-]{12,}|api[_ -]?key\s*[:=]|password\s*[:=]|token\s*[:=]|-----BEGIN [A-Z ]+PRIVATE KEY-----)/iu;
const INSTRUCTION_PATTERN = /(?:忽略|覆盖|绕过|提升为|system prompt|系统指令|开发者指令).{0,24}(?:指令|规则|权限|审批)/iu;

export interface AutomaticMemoryCandidate {
  kind: Extract<AgentMemoryKind, 'current' | 'experience'>;
  content: string;
  confidence: number;
  sourceEventIds: string[];
}

export class AgentMemoryStore {
  readonly #events: SqliteEventStore;
  readonly #projectId: string;

  constructor(options: { events: SqliteEventStore; projectId: string }) {
    this.#events = options.events;
    this.#projectId = options.projectId;
    this.rebuildProjection();
  }

  list(input: { agentId: string; kind?: AgentMemoryKind; scope?: AgentMemoryScope; query?: string; includeDeleted?: boolean; limit?: number }): AgentMemoryItem[] {
    const status = input.includeDeleted ? undefined : 'active' as const;
    let items = input.query?.trim()
      ? this.#events.searchMemoryProjection({
        agentId: input.agentId,
        projectId: this.#projectId,
        query: input.query,
        ...(input.kind ? { kinds: [input.kind] } : {}),
        limit: input.limit ?? 200,
      })
      : this.#events.listMemoryProjection({
        agentId: input.agentId,
        projectId: this.#projectId,
        includeGlobal: true,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(status ? { status } : {}),
        limit: input.limit ?? 1_000,
      });
    if (input.scope) items = items.filter((item) => item.scope === input.scope);
    return structuredClone(items);
  }

  summaries(definitions: AgentDefinition[]): AgentMemorySummary[] {
    return definitions.map((definition) => {
      const items = this.list({ agentId: definition.id, limit: 5_000 });
      const updatedAt = items.map((item) => item.updatedAt).sort().at(-1);
      return {
        agentId: definition.id,
        projectId: this.#projectId,
        pinnedCount: items.filter((item) => item.kind === 'pinned').length,
        currentCount: items.filter((item) => item.kind === 'current' && item.projectId === this.#projectId).length,
        experienceCount: items.filter((item) => item.kind === 'experience' && item.projectId === this.#projectId).length,
        ...(updatedAt ? { updatedAt } : {}),
      };
    });
  }

  createPinned(input: { agentId: string; scope: AgentMemoryScope; content: string; sourceEventIds?: string[] }, actor: EventActor = USER_ACTOR): AgentMemoryItem {
    const content = normalizeMemoryContent(input.content);
    const now = new Date().toISOString();
    const item: AgentMemoryItem = {
      id: randomUUID(),
      agentId: input.agentId,
      ...(input.scope === 'project' ? { projectId: this.#projectId } : {}),
      scope: input.scope,
      kind: 'pinned',
      content,
      sourceEventIds: normalizeRefs(input.sourceEventIds ?? []),
      status: 'active',
      createdBy: 'user',
      createdAt: now,
      updatedAt: now,
    };
    this.persist('agent.memory_created', item, actor);
    return structuredClone(item);
  }

  recordAutomatic(agentId: string, candidate: AutomaticMemoryCandidate, actor: EventActor): AgentMemoryItem | undefined {
    if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0.75 || candidate.confidence > 1) return undefined;
    let content: string;
    try { content = normalizeMemoryContent(candidate.content); }
    catch { return undefined; }
    if (SECRET_PATTERN.test(content) || INSTRUCTION_PATTERN.test(content)) return undefined;
    const existing = this.list({ agentId, kind: candidate.kind, limit: 5_000 })
      .find((item) => item.projectId === this.#projectId && normalizeForDedup(item.content) === normalizeForDedup(content));
    if (existing) {
      return this.update(existing.id, {
        content,
        confidence: Math.max(existing.confidence ?? 0, candidate.confidence),
        sourceEventIds: [...new Set([...existing.sourceEventIds, ...normalizeRefs(candidate.sourceEventIds)])],
      }, actor);
    }
    const now = new Date().toISOString();
    const item: AgentMemoryItem = {
      id: randomUUID(),
      agentId,
      projectId: this.#projectId,
      scope: 'project',
      kind: candidate.kind,
      content,
      confidence: candidate.confidence,
      sourceEventIds: normalizeRefs(candidate.sourceEventIds),
      status: 'active',
      createdBy: 'agent',
      createdAt: now,
      updatedAt: now,
    };
    this.persist('agent.memory_created', item, actor);
    return structuredClone(item);
  }

  update(id: string, patch: { content?: string; confidence?: number; sourceEventIds?: string[] }, actor: EventActor = USER_ACTOR): AgentMemoryItem {
    const current = this.require(id);
    const next: AgentMemoryItem = {
      ...current,
      ...(patch.content !== undefined ? { content: normalizeMemoryContent(patch.content) } : {}),
      ...(patch.confidence !== undefined ? { confidence: normalizeConfidence(patch.confidence) } : {}),
      ...(patch.sourceEventIds !== undefined ? { sourceEventIds: normalizeRefs(patch.sourceEventIds) } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.persist('agent.memory_updated', next, actor);
    return structuredClone(next);
  }

  delete(id: string, actor: EventActor = USER_ACTOR): AgentMemoryItem {
    const current = this.require(id);
    if (current.status === 'deleted') return current;
    const next: AgentMemoryItem = { ...current, status: 'deleted', updatedAt: new Date().toISOString() };
    this.persist('agent.memory_deleted', next, actor);
    return structuredClone(next);
  }

  clear(agentId: string, input: { kind?: AgentMemoryKind; scope?: AgentMemoryScope }, actor: EventActor = USER_ACTOR): number {
    const items = this.list({ agentId, ...(input.kind ? { kind: input.kind } : {}), ...(input.scope ? { scope: input.scope } : {}), limit: 5_000 });
    for (const item of items) this.delete(item.id, actor);
    this.#events.append({
      streamId: `memory:${agentId}:${input.scope === 'global' ? 'global' : this.#projectId}`,
      kind: 'agent.memory_cleared',
      actor,
      agentId,
      provenanceRefs: items.map((item) => item.id),
      payload: toJson({ agentId, projectId: this.#projectId, kind: input.kind ?? null, scope: input.scope ?? null, count: items.length }),
    });
    return items.length;
  }

  selectForContext(input: { agentId: string; query: string; includeExperience: boolean }): AgentMemoryItem[] {
    const allPinned = this.list({ agentId: input.agentId, kind: 'pinned', limit: 50 });
    const searched = this.#events.searchMemoryProjection({
      agentId: input.agentId,
      projectId: this.#projectId,
      query: input.query || '研究 项目 用户 任务',
      kinds: input.includeExperience ? ['current', 'experience'] : ['current'],
      limit: 18,
    });
    const current = searched.filter((item) => item.kind === 'current').slice(0, 12);
    const experience = input.includeExperience ? searched.filter((item) => item.kind === 'experience').slice(0, 6) : [];
    return structuredClone([...allPinned, ...current, ...experience]);
  }

  recordUsed(agentId: string, memoryIds: string[], traceId: string): void {
    if (memoryIds.length === 0) return;
    this.#events.append({
      streamId: `memory:${agentId}:${this.#projectId}`,
      kind: 'agent.memory_used',
      actor: { id: agentId, kind: 'agent' },
      agentId,
      traceId,
      provenanceRefs: memoryIds,
      payload: toJson({ agentId, projectId: this.#projectId, memoryIds }),
    });
  }

  private require(id: string): AgentMemoryItem {
    for (const stream of this.#events.listStreams().filter((item) => item.streamId.startsWith('memory:'))) {
      let found: AgentMemoryItem | undefined;
      for (const event of this.#events.list(stream.streamId)) {
        if (!event.kind.startsWith('agent.memory_') || !isRecord(event.payload) || event.payload.id !== id) continue;
        found = event.payload as unknown as AgentMemoryItem;
      }
      if (found) return structuredClone(found);
    }
    throw new Error(`记忆不存在：${id}`);
  }

  private persist(kind: 'agent.memory_created' | 'agent.memory_updated' | 'agent.memory_deleted', item: AgentMemoryItem, actor: EventActor): void {
    const streamId = `memory:${item.agentId}:${item.scope === 'global' ? 'global' : this.#projectId}`;
    const event = this.#events.append({
      streamId,
      kind,
      actor,
      agentId: item.agentId,
      provenanceRefs: item.sourceEventIds,
      payload: toJson(item),
    });
    this.#events.upsertMemoryProjection(item);
    if (kind === 'agent.memory_created' && item.createdBy === 'agent') {
      this.#events.append({
        streamId,
        kind: 'memory.extraction_completed',
        actor,
        agentId: item.agentId,
        traceId: event.traceId,
        provenanceRefs: [event.id, ...item.sourceEventIds],
        payload: toJson({ memoryId: item.id, confidence: item.confidence ?? null }),
      });
    }
  }

  private rebuildProjection(): void {
    this.#events.clearMemoryProjection();
    for (const stream of this.#events.listStreams().filter((item) => item.streamId.startsWith('memory:'))) {
      const latest = new Map<string, AgentMemoryItem>();
      for (const event of this.#events.list(stream.streamId)) {
        if (!['agent.memory_created', 'agent.memory_updated', 'agent.memory_deleted', 'agent.memory_superseded'].includes(event.kind) || !isRecord(event.payload) || typeof event.payload.id !== 'string') continue;
        latest.set(event.payload.id, event.payload as unknown as AgentMemoryItem);
      }
      for (const item of latest.values()) this.#events.upsertMemoryProjection(item);
    }
  }
}

function normalizeMemoryContent(value: unknown): string {
  if (typeof value !== 'string') throw new Error('记忆内容必须是字符串');
  const content = value.normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  if ([...content].length < 1 || [...content].length > 2_000) throw new Error('单条记忆长度必须为 1–2,000 个字符');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)) throw new Error('记忆包含不允许的控制字符');
  if (SECRET_PATTERN.test(content)) throw new Error('记忆疑似包含密钥、令牌或密码，已拒绝保存');
  return content;
}

function normalizeRefs(refs: unknown): string[] {
  if (!Array.isArray(refs) || refs.length > 200 || refs.some((ref) => typeof ref !== 'string' || !ref || ref.length > 500)) throw new Error('记忆来源引用无效');
  return [...new Set(refs)];
}

function normalizeConfidence(value: unknown): number {
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('记忆置信度必须位于 0–1');
  return confidence;
}

function normalizeForDedup(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}
