import type { EventActor, JsonValue, PluginStorageEntry } from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { isRecord, toJson } from '../util/json.js';

const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_SCOPE_BYTES = 10 * 1024 * 1024;

interface StoredEntry {
  streamId: string;
  entry: PluginStorageEntry;
}

function validatePluginId(pluginId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(pluginId)) throw new Error('插件存储 ID 无效');
}

function validateKey(key: string): string {
  const normalized = key.normalize('NFC').trim();
  if (!normalized || normalized.length > 300 || normalized.includes('\0') || normalized.startsWith('/') || normalized.includes('..')) throw new Error('插件存储 key 无效');
  return normalized;
}

export class PluginStorage {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #activeSessionId: () => string;
  readonly #entries = new Map<string, StoredEntry>();

  constructor(options: { projectId: string; events: SqliteEventStore; activeSessionId: () => string }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.#activeSessionId = options.activeSessionId;
    this.replay();
  }

  get(pluginId: string, scope: PluginStorageEntry['scope'], key: string): PluginStorageEntry | undefined {
    const streamId = this.stream(scope);
    const stored = this.#entries.get(this.composite(streamId, pluginId, validateKey(key)));
    return stored ? structuredClone(stored.entry) : undefined;
  }

  list(pluginId: string, scope: PluginStorageEntry['scope'], prefix = ''): PluginStorageEntry[] {
    validatePluginId(pluginId);
    const streamId = this.stream(scope);
    return [...this.#entries.values()]
      .filter((stored) => stored.streamId === streamId && stored.entry.pluginId === pluginId && stored.entry.key.startsWith(prefix))
      .map((stored) => structuredClone(stored.entry));
  }

  put(pluginId: string, scope: PluginStorageEntry['scope'], keyInput: string, value: JsonValue, actor: EventActor, ifRevision?: number): PluginStorageEntry {
    validatePluginId(pluginId);
    const key = validateKey(keyInput);
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_ENTRY_BYTES) throw new Error('插件单个状态条目超过 1 MB 上限；大型内容应使用 Resource 或 Artifact');
    const streamId = this.stream(scope);
    const composite = this.composite(streamId, pluginId, key);
    const current = this.#entries.get(composite)?.entry;
    if (ifRevision !== undefined && current?.revision !== ifRevision) throw new Error('插件状态 revision 冲突');
    const otherBytes = [...this.#entries.values()]
      .filter((stored) => stored.streamId === streamId && stored.entry.pluginId === pluginId && stored.entry.key !== key)
      .reduce((total, stored) => total + Buffer.byteLength(JSON.stringify(stored.entry.value), 'utf8'), 0);
    if (otherBytes + Buffer.byteLength(serialized, 'utf8') > MAX_SCOPE_BYTES) throw new Error('插件在当前作用域的状态超过 10 MB 上限');
    const entry: PluginStorageEntry = {
      pluginId, scope, key, value: structuredClone(value), revision: (current?.revision ?? 0) + 1, updatedAt: new Date().toISOString(),
    };
    this.#entries.set(composite, { streamId, entry });
    this.#events.append({ streamId, kind: 'plugin_storage.put', actor, provenanceRefs: [pluginId], payload: toJson(entry) });
    return structuredClone(entry);
  }

  delete(pluginId: string, scope: PluginStorageEntry['scope'], keyInput: string, actor: EventActor, ifRevision?: number): void {
    validatePluginId(pluginId);
    const key = validateKey(keyInput);
    const streamId = this.stream(scope);
    const composite = this.composite(streamId, pluginId, key);
    const current = this.#entries.get(composite)?.entry;
    if (!current) return;
    if (ifRevision !== undefined && current.revision !== ifRevision) throw new Error('插件状态 revision 冲突');
    this.#entries.delete(composite);
    this.#events.append({
      streamId, kind: 'plugin_storage.deleted', actor, provenanceRefs: [pluginId],
      payload: toJson({ pluginId, scope, key, revision: current.revision + 1, updatedAt: new Date().toISOString() }),
    });
  }

  private stream(scope: PluginStorageEntry['scope']): string {
    if (scope === 'user') return 'app:plugin-storage';
    if (scope === 'project') return `project:${this.#projectId}:plugin-storage`;
    if (scope === 'session') return `session:${this.#activeSessionId()}:plugin-storage`;
    throw new Error('插件存储作用域无效');
  }

  private composite(streamId: string, pluginId: string, key: string): string {
    return `${streamId}\u0000${pluginId}\u0000${key}`;
  }

  private replay(): void {
    for (const event of this.#events.listAll(100_000)) {
      if (event.kind === 'plugin_storage.put' && isRecord(event.payload) && typeof event.payload.pluginId === 'string' && typeof event.payload.key === 'string') {
        const entry = structuredClone(event.payload as unknown as PluginStorageEntry);
        this.#entries.set(this.composite(event.streamId, entry.pluginId, entry.key), { streamId: event.streamId, entry });
      } else if (event.kind === 'plugin_storage.deleted' && isRecord(event.payload) && typeof event.payload.pluginId === 'string' && typeof event.payload.key === 'string') {
        this.#entries.delete(this.composite(event.streamId, event.payload.pluginId, event.payload.key));
      }
    }
  }
}
