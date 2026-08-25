import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteEventStore } from '../src/events/event-store.js';

const temporaryDirectories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'openlab-events-'));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('SQLite event store', () => {
  it('assigns strict per-stream sequences and rebuilds event order', () => {
    const store = new SqliteEventStore(join(temporaryDirectory(), 'events.db'));
    const actor = { id: 'tester', kind: 'user' as const };
    const first = store.append({ streamId: 'session:a', kind: 'turn.started', actor, payload: { value: 1 } });
    const second = store.append({ streamId: 'session:a', kind: 'message.recorded', actor, payload: { value: 2 } });
    const other = store.append({ streamId: 'session:b', kind: 'turn.started', actor, payload: { value: 3 } });
    expect([first.sequence, second.sequence, other.sequence]).toEqual([1, 2, 1]);
    expect(store.list('session:a').map((event) => event.kind)).toEqual(['turn.started', 'message.recorded']);
    expect(store.list('session:a', 1)).toHaveLength(1);
    store.close();
  });

  it('migrates to the current schema and rolls back a failed append transaction', () => {
    const store = new SqliteEventStore(join(temporaryDirectory(), 'events.db'));
    expect(store.schemaVersion()).toBe(4);
    expect(() => store.append({
      streamId: 'session:a', kind: 'invalid', actor: { id: 'tester', kind: 'user' }, payload: { invalid: 1n } as never,
    })).toThrow();
    const recovered = store.append({ streamId: 'session:a', kind: 'valid', actor: { id: 'tester', kind: 'user' }, payload: { ok: true } });
    expect(recovered.sequence).toBe(1);
    store.close();
  });

  it('refuses a database created by a newer incompatible app version', () => {
    const path = join(temporaryDirectory(), 'future.db');
    const database = new DatabaseSync(path);
    database.exec('PRAGMA user_version = 99');
    database.close();
    expect(() => new SqliteEventStore(path)).toThrow(/高于当前支持版本/u);
  });

  it('persists JSON settings without exposing them as process globals', () => {
    const path = join(temporaryDirectory(), 'events.db');
    const first = new SqliteEventStore(path);
    first.setValue('activeSessionId', 'session-1');
    first.close();
    const reopened = new SqliteEventStore(path);
    expect(reopened.getValue('activeSessionId')).toBe('session-1');
    reopened.close();
  });

  it('creates a consistent SQLite backup without overwriting a destination', () => {
    const root = temporaryDirectory();
    const store = new SqliteEventStore(join(root, 'events.db'));
    store.append({ streamId: 'session:a', kind: 'message.recorded', actor: { id: 'user', kind: 'user' }, payload: { text: 'persisted' } });
    const backup = join(root, 'backup.db');
    store.backup(backup);
    expect(() => store.backup(backup)).toThrow(/已存在/);
    const restored = new SqliteEventStore(backup);
    expect(restored.list('session:a')[0]?.payload).toEqual({ text: 'persisted' });
    restored.close();
    store.close();
  });
});
