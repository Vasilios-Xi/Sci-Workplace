import { join } from 'node:path';
import type { EventActor } from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { atomicWriteJson, readJsonProjection } from '../util/files.js';
import { isRecord, toJson } from '../util/json.js';

export interface ContextPin {
  id: string;
  label: string;
  content: string;
  sourceRefs: string[];
  createdAt: string;
  trust?: 'trusted' | 'untrusted';
}

function isContextPin(value: unknown): value is ContextPin {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
    && typeof value.content === 'string'
    && Array.isArray(value.sourceRefs)
    && value.sourceRefs.every((item) => typeof item === 'string')
    && typeof value.createdAt === 'string';
}

export class ContextPins {
  readonly #path: string;
  readonly #projectId: string | undefined;
  readonly #events: SqliteEventStore | undefined;
  #pins: ContextPin[];

  constructor(input: string | { projectRoot: string; projectId: string; events: SqliteEventStore }) {
    const projectRoot = typeof input === 'string' ? input : input.projectRoot;
    this.#path = join(projectRoot, '.openlab', 'context-pins.json');
    this.#projectId = typeof input === 'string' ? undefined : input.projectId;
    this.#events = typeof input === 'string' ? undefined : input.events;
    const projectedValue = readJsonProjection<unknown>(this.#path, []);
    const projected = Array.isArray(projectedValue) ? projectedValue.filter(isContextPin) : [];
    if (!this.#events || !this.#projectId) {
      this.#pins = projected;
      return;
    }
    const replayed = new Map<string, ContextPin>();
    const seen = new Set<string>();
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if ((event.kind === 'context.pinned' || event.kind === 'context.pin_imported') && typeof event.payload === 'object' && event.payload !== null) {
        const pin = event.payload as unknown as ContextPin;
        if (typeof pin.id === 'string') { replayed.set(pin.id, structuredClone(pin)); seen.add(pin.id); }
      } else if (event.kind === 'context.unpinned' && typeof event.payload === 'object' && event.payload !== null) {
        const id = (event.payload as Record<string, unknown>).id;
        if (typeof id === 'string') { replayed.delete(id); seen.add(id); }
      }
    }
    for (const pin of projected) {
      if (seen.has(pin.id)) continue;
      replayed.set(pin.id, pin);
      this.#events.append({
        streamId: `project:${this.#projectId}`, kind: 'context.pin_imported', actor: { id: 'openlab', kind: 'system' },
        timestamp: pin.createdAt, payload: toJson(pin), provenanceRefs: pin.sourceRefs,
      });
    }
    this.#pins = [...replayed.values()];
    if (seen.size > 0 || projected.length > 0) this.persist();
  }

  list(): ContextPin[] {
    return structuredClone(this.#pins);
  }

  pin(pin: ContextPin, actor?: EventActor, agentId?: string, traceId?: string): ContextPin {
    this.#pins = [...this.#pins.filter((item) => item.id !== pin.id), pin];
    this.persist();
    if (this.#events && this.#projectId) this.#events.append({
      streamId: `project:${this.#projectId}`, kind: 'context.pinned', actor: actor ?? { id: 'openlab', kind: 'system' },
      ...(agentId ? { agentId } : {}), ...(traceId ? { traceId } : {}), provenanceRefs: pin.sourceRefs, payload: toJson(pin),
    });
    return structuredClone(pin);
  }

  unpin(id: string, actor?: EventActor, agentId?: string, traceId?: string): boolean {
    const next = this.#pins.filter((item) => item.id !== id);
    if (next.length === this.#pins.length) return false;
    this.#pins = next;
    this.persist();
    if (this.#events && this.#projectId) this.#events.append({
      streamId: `project:${this.#projectId}`, kind: 'context.unpinned', actor: actor ?? { id: 'openlab', kind: 'system' },
      ...(agentId ? { agentId } : {}), ...(traceId ? { traceId } : {}), payload: { id },
    });
    return true;
  }

  private persist(): void {
    atomicWriteJson(this.#path, this.#pins);
  }
}
