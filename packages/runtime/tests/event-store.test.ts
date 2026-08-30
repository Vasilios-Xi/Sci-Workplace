import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
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
    expect(store.schemaVersion()).toBe(5);
    expect(() => store.append({
      streamId: 'session:a', kind: 'invalid', actor: { id: 'tester', kind: 'user' }, payload: { invalid: 1n } as never,
    })).toThrow();
    const recovered = store.append({ streamId: 'session:a', kind: 'valid', actor: { id: 'tester', kind: 'user' }, payload: { ok: true } });
    expect(recovered.sequence).toBe(1);
    store.close();
  });

  it('deduplicates idempotent writes while preserving device and entity revisions', () => {
    const store = new SqliteEventStore(join(temporaryDirectory(), 'events.db'));
    const input = {
      streamId: 'workbench:one', kind: 'workbench.mounted', actor: { id: 'owner', kind: 'user' as const },
      deviceId: 'device-a', idempotencyKey: 'mount:artifact:one', revision: 7, payload: { artifactId: 'artifact-1' },
    };
    const first = store.append(input);
    const duplicate = store.append(input);
    expect(duplicate.id).toBe(first.id);
    expect(duplicate).toMatchObject({ sequence: 1, deviceId: 'device-a', idempotencyKey: 'mount:artifact:one', revision: 7 });
    expect(store.list('workbench:one')).toHaveLength(1);
    expect(() => store.append({ ...input, payload: { artifactId: 'artifact-2' } })).toThrow(/幂等键/u);
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

  it('waits for a short concurrent WAL writer instead of leaking SQLITE_BUSY', async () => {
    const path = join(temporaryDirectory(), 'events.db');
    const store = new SqliteEventStore(path);
    const locker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(workerData.path);
      database.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;');
      parentPort.postMessage('locked');
      setTimeout(() => {
        database.exec('COMMIT');
        database.close();
        parentPort.postMessage('released');
      }, 150);
    `, { eval: true, workerData: { path } });
    const message = (expected: string) => new Promise<void>((resolve, reject) => {
      const onMessage = (value: unknown) => {
        if (value !== expected) return;
        cleanup(); resolve();
      };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => { locker.off('message', onMessage); locker.off('error', onError); };
      locker.on('message', onMessage); locker.on('error', onError);
    });
    await message('locked');
    const released = message('released');

    const event = store.append({ streamId: 'session:concurrent', kind: 'binding.updated', actor: { id: 'tester', kind: 'user' }, payload: { ok: true } });

    await released;
    expect(event.sequence).toBe(1);
    await locker.terminate();
    store.close();
  });

  it('keeps temporary chat streams in memory and discards them without persistence', () => {
    const path = join(temporaryDirectory(), 'events.db');
    const streamId = 'session:temporary-chat';
    const first = new SqliteEventStore(path);
    first.markTemporaryStream(streamId);
    first.append({ streamId, kind: 'message.recorded', actor: { id: 'user', kind: 'user' }, payload: { text: 'ephemeral' } });
    expect(first.isTemporaryStream(streamId)).toBe(true);
    expect(first.list(streamId).map((event) => event.payload)).toEqual([{ text: 'ephemeral' }]);
    expect(first.listStreams().some((stream) => stream.streamId === streamId)).toBe(true);
    first.close();

    const reopened = new SqliteEventStore(path);
    expect(reopened.list(streamId)).toEqual([]);
    expect(reopened.listStreams().some((stream) => stream.streamId === streamId)).toBe(false);
    reopened.close();
  });

  it('promotes a temporary stream without changing event identity or order', () => {
    const path = join(temporaryDirectory(), 'events.db');
    const streamId = 'session:bound-workbench';
    const first = new SqliteEventStore(path);
    first.markTemporaryStream(streamId);
    const event = first.append({
      streamId,
      kind: 'agent.session_binding_changed',
      actor: { id: 'user', kind: 'user' },
      idempotencyKey: 'binding:initial',
      payload: { leadAgentId: 'agent-1' },
    });
    first.persistTemporaryStream(streamId);
    expect(first.isTemporaryStream(streamId)).toBe(false);
    expect(first.list(streamId)).toEqual([event]);
    first.close();

    const reopened = new SqliteEventStore(path);
    expect(reopened.list(streamId)).toEqual([event]);
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
