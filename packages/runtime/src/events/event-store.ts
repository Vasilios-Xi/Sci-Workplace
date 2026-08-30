import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AgentMemoryItem, EventActor, JsonValue, RuntimeEventEnvelope } from '@openlab/protocol';

interface EventRow {
  id: string;
  stream_id: string;
  sequence: number;
  kind: string;
  schema_version: number;
  timestamp: string;
  actor_json: string;
  device_id: string;
  idempotency_key: string;
  entity_revision: number;
  agent_id: string | null;
  trace_id: string;
  provenance_json: string;
  payload_json: string;
}

export interface AppendEventInput<TPayload extends JsonValue> {
  streamId: string;
  kind: string;
  actor: EventActor;
  deviceId?: string;
  idempotencyKey?: string;
  revision?: number;
  agentId?: string;
  traceId?: string;
  provenanceRefs?: string[];
  payload: TPayload;
  timestamp?: string;
}

function rowToEvent(row: EventRow): RuntimeEventEnvelope {
  const base: RuntimeEventEnvelope = {
    id: row.id,
    streamId: row.stream_id,
    sequence: row.sequence,
    kind: row.kind,
    schemaVersion: row.schema_version,
    timestamp: row.timestamp,
    actor: JSON.parse(row.actor_json) as EventActor,
    deviceId: row.device_id || 'legacy-device',
    idempotencyKey: row.idempotency_key || `legacy:${row.id}`,
    revision: Number(row.entity_revision) || row.sequence,
    traceId: row.trace_id,
    provenanceRefs: JSON.parse(row.provenance_json) as string[],
    payload: JSON.parse(row.payload_json) as JsonValue,
  };
  return row.agent_id ? { ...base, agentId: row.agent_id } : base;
}

export class SqliteEventStore {
  readonly #database: DatabaseSync;
  readonly #deviceId: string;
  readonly #temporaryStreams = new Map<string, RuntimeEventEnvelope[]>();
  #closed = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    // More than one warm Runtime can briefly share an application event DB
    // while the desktop switches between cached project/conversation hosts.
    // WAL permits concurrent readers, but a second writer otherwise fails
    // immediately at BEGIN IMMEDIATE. Let short, legitimate writes drain
    // before surfacing SQLITE_BUSY to the caller.
    this.#database.exec('PRAGMA busy_timeout = 5000;');
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS runtime_events (
        id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        device_id TEXT NOT NULL DEFAULT 'legacy-device',
        idempotency_key TEXT NOT NULL DEFAULT '',
        entity_revision INTEGER NOT NULL DEFAULT 0,
        agent_id TEXT,
        trace_id TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(stream_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS runtime_events_stream_idx ON runtime_events(stream_id, sequence);
      CREATE INDEX IF NOT EXISTS runtime_events_trace_idx ON runtime_events(trace_id);
      CREATE TABLE IF NOT EXISTS app_kv (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const current = Number((this.#database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (current > 5) {
      this.#database.close();
      this.#closed = true;
      throw new Error(`数据库 schema 版本 ${current} 高于当前支持版本 5`);
    }
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (current < 1) {
        this.#database.exec(`
          INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, CURRENT_TIMESTAMP);
          PRAGMA user_version = 1;
        `);
      }
      if (current < 2) {
        this.#database.exec(`
          CREATE INDEX IF NOT EXISTS runtime_events_kind_idx ON runtime_events(kind, timestamp);
          INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, CURRENT_TIMESTAMP);
          PRAGMA user_version = 2;
        `);
      }
      if (current < 3) {
        this.#database.exec(`
          CREATE TABLE IF NOT EXISTS agent_memory_projection (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            project_id TEXT,
            scope TEXT NOT NULL,
            kind TEXT NOT NULL,
            content TEXT NOT NULL,
            confidence REAL,
            status TEXT NOT NULL,
            created_by TEXT NOT NULL,
            source_event_ids_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS agent_memory_projection_scope_idx
            ON agent_memory_projection(agent_id, project_id, status, kind, updated_at);
          CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
            id UNINDEXED,
            content,
            tokenize = 'unicode61'
          );
          INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, CURRENT_TIMESTAMP);
          PRAGMA user_version = 3;
        `);
      }
      if (current < 4) {
        this.#database.exec(`
          CREATE INDEX IF NOT EXISTS runtime_events_feature_idx ON runtime_events(stream_id, kind, sequence);
          INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, CURRENT_TIMESTAMP);
          PRAGMA user_version = 4;
        `);
      }
      if (current < 5) {
        const eventColumns = new Set(
          (this.#database.prepare('PRAGMA table_info(runtime_events)').all() as Array<{ name: string }>).map((column) => column.name),
        );
        if (!eventColumns.has('device_id')) {
          this.#database.exec("ALTER TABLE runtime_events ADD COLUMN device_id TEXT NOT NULL DEFAULT 'legacy-device'");
        }
        if (!eventColumns.has('idempotency_key')) {
          this.#database.exec("ALTER TABLE runtime_events ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT ''");
        }
        if (!eventColumns.has('entity_revision')) {
          this.#database.exec('ALTER TABLE runtime_events ADD COLUMN entity_revision INTEGER NOT NULL DEFAULT 0');
        }
        this.#database.exec(`
          UPDATE runtime_events SET idempotency_key = 'legacy:' || id WHERE idempotency_key = '';
          UPDATE runtime_events SET entity_revision = sequence WHERE entity_revision = 0;
          CREATE UNIQUE INDEX IF NOT EXISTS runtime_events_idempotency_idx
            ON runtime_events(stream_id, idempotency_key);
          INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, CURRENT_TIMESTAMP);
          PRAGMA user_version = 5;
        `);
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      this.#database.close();
      this.#closed = true;
      throw error;
    }
    const check = this.#database.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (check.quick_check !== 'ok') {
      this.#database.close();
      this.#closed = true;
      throw new Error(`SQLite 完整性检查失败：${check.quick_check}`);
    }
    const storedDeviceId = this.getValue<string>('device.id');
    this.#deviceId = storedDeviceId ?? randomUUID();
    if (!storedDeviceId) this.setValue('device.id', this.#deviceId);
  }

  append<TPayload extends JsonValue>(input: AppendEventInput<TPayload>): RuntimeEventEnvelope<TPayload> {
    const temporary = this.#temporaryStreams.get(input.streamId);
    if (temporary) {
      if (input.idempotencyKey) {
        const existing = temporary.find((event) => event.idempotencyKey === input.idempotencyKey);
        if (existing) {
          if (existing.kind !== input.kind || JSON.stringify(existing.payload) !== JSON.stringify(input.payload)) {
            throw new Error(`幂等键 ${input.idempotencyKey} 已用于不同事件`);
          }
          return structuredClone(existing) as RuntimeEventEnvelope<TPayload>;
        }
      }
      const id = randomUUID();
      const sequence = temporary.length + 1;
      const event: RuntimeEventEnvelope<TPayload> = {
        id,
        streamId: input.streamId,
        sequence,
        kind: input.kind,
        schemaVersion: 1,
        timestamp: input.timestamp ?? new Date().toISOString(),
        actor: input.actor,
        deviceId: input.deviceId ?? this.#deviceId,
        idempotencyKey: input.idempotencyKey ?? `event:${id}`,
        revision: input.revision ?? sequence,
        traceId: input.traceId ?? randomUUID(),
        provenanceRefs: input.provenanceRefs ?? [],
        payload: input.payload,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      };
      temporary.push(event);
      return event;
    }
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (input.idempotencyKey) {
        const duplicate = this.#database.prepare(`
          SELECT * FROM runtime_events WHERE stream_id = ? AND idempotency_key = ?
        `).get(input.streamId, input.idempotencyKey) as unknown as EventRow | undefined;
        if (duplicate) {
          const existing = rowToEvent(duplicate);
          if (existing.kind !== input.kind || JSON.stringify(existing.payload) !== JSON.stringify(input.payload)) {
            throw new Error(`幂等键 ${input.idempotencyKey} 已用于不同事件`);
          }
          this.#database.exec('COMMIT');
          return existing as RuntimeEventEnvelope<TPayload>;
        }
      }
      const row = this.#database.prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM runtime_events WHERE stream_id = ?',
      ).get(input.streamId) as { sequence: number };
      const id = randomUUID();
      const sequence = Number(row.sequence) + 1;
      const event: RuntimeEventEnvelope<TPayload> = {
        id,
        streamId: input.streamId,
        sequence,
        kind: input.kind,
        schemaVersion: 1,
        timestamp: input.timestamp ?? new Date().toISOString(),
        actor: input.actor,
        deviceId: input.deviceId ?? this.#deviceId,
        idempotencyKey: input.idempotencyKey ?? `event:${id}`,
        revision: input.revision ?? sequence,
        traceId: input.traceId ?? randomUUID(),
        provenanceRefs: input.provenanceRefs ?? [],
        payload: input.payload,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      };
      this.#database.prepare(`
        INSERT INTO runtime_events (
          id, stream_id, sequence, kind, schema_version, timestamp,
          actor_json, device_id, idempotency_key, entity_revision,
          agent_id, trace_id, provenance_json, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.streamId,
        event.sequence,
        event.kind,
        event.schemaVersion,
        event.timestamp,
        JSON.stringify(event.actor),
        event.deviceId,
        event.idempotencyKey,
        event.revision,
        event.agentId ?? null,
        event.traceId,
        JSON.stringify(event.provenanceRefs),
        JSON.stringify(event.payload),
      );
      this.#database.exec('COMMIT');
      return event;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  list(streamId: string, afterSequence = 0): RuntimeEventEnvelope[] {
    const temporary = this.#temporaryStreams.get(streamId);
    if (temporary) return temporary.filter((event) => event.sequence > afterSequence).map((event) => structuredClone(event));
    const rows = this.#database.prepare(`
      SELECT * FROM runtime_events
      WHERE stream_id = ? AND sequence > ?
      ORDER BY sequence ASC
    `).all(streamId, afterSequence) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  listByKind(kind: string, limit = 200): RuntimeEventEnvelope[] {
    const rows = this.#database.prepare(`
      SELECT * FROM runtime_events WHERE kind = ? ORDER BY timestamp DESC LIMIT ?
    `).all(kind, limit) as unknown as EventRow[];
    const persisted = rows.map(rowToEvent);
    const temporary = [...this.#temporaryStreams.values()].flat().filter((event) => event.kind === kind);
    return [...persisted, ...temporary]
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, limit)
      .map((event) => structuredClone(event));
  }

  listAll(limit = 10_000): RuntimeEventEnvelope[] {
    const rows = this.#database.prepare(`
      SELECT * FROM runtime_events ORDER BY timestamp DESC, stream_id DESC, sequence DESC LIMIT ?
    `).all(limit) as unknown as EventRow[];
    const persisted = rows.map(rowToEvent);
    const temporary = [...this.#temporaryStreams.values()].flat();
    return [...persisted, ...temporary]
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.streamId.localeCompare(left.streamId) || right.sequence - left.sequence)
      .slice(0, limit)
      .map((event) => structuredClone(event));
  }

  listStreams(): Array<{ streamId: string; lastSequence: number; updatedAt: string }> {
    const persisted = this.#database.prepare(`
      SELECT stream_id AS streamId, MAX(sequence) AS lastSequence, MAX(timestamp) AS updatedAt
      FROM runtime_events GROUP BY stream_id ORDER BY updatedAt DESC
    `).all() as unknown as Array<{ streamId: string; lastSequence: number; updatedAt: string }>;
    const temporary = [...this.#temporaryStreams.entries()].flatMap(([streamId, events]) => {
      const last = events.at(-1);
      return last ? [{ streamId, lastSequence: last.sequence, updatedAt: last.timestamp }] : [];
    });
    return [...persisted, ...temporary].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** Keeps every event for this stream in memory only. Used by temporary chats. */
  markTemporaryStream(streamId: string): void {
    if (!this.#temporaryStreams.has(streamId)) this.#temporaryStreams.set(streamId, []);
  }

  /**
   * Makes an in-memory stream durable without changing its event identities.
   * Workbench bindings use this when the deferred first conversation becomes
   * shared application state that must survive a restart.
   */
  persistTemporaryStream(streamId: string): void {
    const temporary = this.#temporaryStreams.get(streamId);
    if (!temporary) return;
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#database.prepare(
        'SELECT COUNT(*) AS count FROM runtime_events WHERE stream_id = ?',
      ).get(streamId) as { count: number };
      if (Number(existing.count) !== 0) throw new Error(`临时事件流已存在持久化事件：${streamId}`);
      const insert = this.#database.prepare(`
        INSERT INTO runtime_events (
          id, stream_id, sequence, kind, schema_version, timestamp,
          actor_json, device_id, idempotency_key, entity_revision,
          agent_id, trace_id, provenance_json, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of temporary) {
        insert.run(
          event.id,
          event.streamId,
          event.sequence,
          event.kind,
          event.schemaVersion,
          event.timestamp,
          JSON.stringify(event.actor),
          event.deviceId,
          event.idempotencyKey,
          event.revision,
          event.agentId ?? null,
          event.traceId,
          JSON.stringify(event.provenanceRefs),
          JSON.stringify(event.payload),
        );
      }
      this.#database.exec('COMMIT');
      this.#temporaryStreams.delete(streamId);
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  discardTemporaryStream(streamId: string): void {
    this.#temporaryStreams.delete(streamId);
  }

  isTemporaryStream(streamId: string): boolean {
    return this.#temporaryStreams.has(streamId);
  }

  setValue(key: string, value: JsonValue): void {
    this.#database.prepare(`
      INSERT INTO app_kv (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  }

  getValue<T extends JsonValue>(key: string): T | undefined {
    const row = this.#database.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : undefined;
  }

  upsertMemoryProjection(item: AgentMemoryItem): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(`
        INSERT INTO agent_memory_projection (
          id, agent_id, project_id, scope, kind, content, confidence, status,
          created_by, source_event_ids_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          agent_id = excluded.agent_id,
          project_id = excluded.project_id,
          scope = excluded.scope,
          kind = excluded.kind,
          content = excluded.content,
          confidence = excluded.confidence,
          status = excluded.status,
          created_by = excluded.created_by,
          source_event_ids_json = excluded.source_event_ids_json,
          updated_at = excluded.updated_at
      `).run(
        item.id, item.agentId, item.projectId ?? null, item.scope, item.kind, item.content,
        item.confidence ?? null, item.status, item.createdBy, JSON.stringify(item.sourceEventIds),
        item.createdAt, item.updatedAt,
      );
      this.#database.prepare('DELETE FROM agent_memory_fts WHERE id = ?').run(item.id);
      if (item.status === 'active') this.#database.prepare('INSERT INTO agent_memory_fts (id, content) VALUES (?, ?)').run(item.id, item.content);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  listMemoryProjection(input: { agentId: string; projectId?: string; includeGlobal?: boolean; kind?: AgentMemoryItem['kind']; status?: AgentMemoryItem['status']; limit?: number }): AgentMemoryItem[] {
    const clauses = ['agent_id = ?'];
    const parameters: Array<string | number> = [input.agentId];
    if (input.projectId) {
      clauses.push(input.includeGlobal ? '(project_id = ? OR project_id IS NULL)' : 'project_id = ?');
      parameters.push(input.projectId);
    } else if (!input.includeGlobal) {
      clauses.push('project_id IS NULL');
    }
    if (input.kind) { clauses.push('kind = ?'); parameters.push(input.kind); }
    if (input.status) { clauses.push('status = ?'); parameters.push(input.status); }
    parameters.push(Math.min(5_000, Math.max(1, input.limit ?? 1_000)));
    const rows = this.#database.prepare(`
      SELECT * FROM agent_memory_projection
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC LIMIT ?
    `).all(...parameters) as unknown as MemoryProjectionRow[];
    return rows.map(memoryRowToItem);
  }

  searchMemoryProjection(input: { agentId: string; projectId: string; query: string; kinds?: AgentMemoryItem['kind'][]; limit?: number }): AgentMemoryItem[] {
    const tokens = input.query.normalize('NFC').trim().split(/\s+/u).filter(Boolean).slice(0, 16);
    if (tokens.length === 0) return this.listMemoryProjection({ agentId: input.agentId, projectId: input.projectId, includeGlobal: true, status: 'active', limit: input.limit ?? 50 });
    const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
    const kinds = input.kinds?.length ? input.kinds : ['pinned', 'current', 'experience'];
    const placeholders = kinds.map(() => '?').join(', ');
    const rows = this.#database.prepare(`
      SELECT projection.*
      FROM agent_memory_fts
      JOIN agent_memory_projection AS projection ON projection.id = agent_memory_fts.id
      WHERE agent_memory_fts MATCH ?
        AND projection.agent_id = ?
        AND (projection.project_id = ? OR projection.project_id IS NULL)
        AND projection.status = 'active'
        AND projection.kind IN (${placeholders})
      ORDER BY bm25(agent_memory_fts), projection.updated_at DESC
      LIMIT ?
    `).all(match, input.agentId, input.projectId, ...kinds, Math.min(200, Math.max(1, input.limit ?? 50))) as unknown as MemoryProjectionRow[];
    return rows.map(memoryRowToItem);
  }

  clearMemoryProjection(): void {
    this.#database.exec('DELETE FROM agent_memory_projection; DELETE FROM agent_memory_fts;');
  }

  backup(destination: string): void {
    if (existsSync(destination)) throw new Error('备份目标已存在，拒绝覆盖');
    mkdirSync(dirname(destination), { recursive: true });
    this.#database.exec('PRAGMA wal_checkpoint(FULL)');
    this.#database.prepare('VACUUM INTO ?').run(destination);
  }

  schemaVersion(): number {
    return Number((this.#database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#temporaryStreams.clear();
    this.#database.close();
  }
}

interface MemoryProjectionRow {
  id: string;
  agent_id: string;
  project_id: string | null;
  scope: AgentMemoryItem['scope'];
  kind: AgentMemoryItem['kind'];
  content: string;
  confidence: number | null;
  status: AgentMemoryItem['status'];
  created_by: AgentMemoryItem['createdBy'];
  source_event_ids_json: string;
  created_at: string;
  updated_at: string;
}

function memoryRowToItem(row: MemoryProjectionRow): AgentMemoryItem {
  return {
    id: row.id,
    agentId: row.agent_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    scope: row.scope,
    kind: row.kind,
    content: row.content,
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    status: row.status,
    createdBy: row.created_by,
    sourceEventIds: JSON.parse(row.source_event_ids_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
