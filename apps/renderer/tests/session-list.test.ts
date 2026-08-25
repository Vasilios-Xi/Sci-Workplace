import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@openlab/protocol';
import {
  defaultSessionListPreferences,
  loadSessionListPreferences,
  parseSessionListPreferences,
  relativeSessionTime,
  saveSessionListPreferences,
  sessionDisplayTitle,
  sessionListStorageKey,
  sessionWorkingFolderName,
  sortSessionsForSidebar,
} from '../src/lib/session-list.js';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const session = (id: string, updatedAt: string): SessionSummary => ({ id, projectId: 'project', title: `会话 ${id}`, status: 'idle', updatedAt, model: 'model' });

describe('session list preferences', () => {
  it('falls back for missing, old, or invalid values', () => {
    expect(parseSessionListPreferences(null)).toEqual(defaultSessionListPreferences);
    expect(parseSessionListPreferences('{bad')).toEqual(defaultSessionListPreferences);
    expect(parseSessionListPreferences(JSON.stringify({ schemaVersion: 0 }))).toEqual(defaultSessionListPreferences);
    expect(parseSessionListPreferences(JSON.stringify({ schemaVersion: 1, pinnedSessionIds: [1], aliases: {} }))).toEqual(defaultSessionListPreferences);
  });

  it('normalizes pins and aliases', () => {
    expect(parseSessionListPreferences(JSON.stringify({ schemaVersion: 1, pinnedSessionIds: ['a', 'a'], aliases: { a: '  新标题  ', b: ' ' } }))).toEqual({
      schemaVersion: 1,
      pinnedSessionIds: ['a'],
      aliases: { a: '新标题' },
    });
  });

  it('keeps projects isolated and resolves local display titles', () => {
    const storage = new MemoryStorage();
    saveSessionListPreferences('one', { schemaVersion: 1, pinnedSessionIds: ['a'], aliases: { a: '别名' } }, storage);
    expect(sessionDisplayTitle(session('a', '2026-08-25T00:00:00.000Z'), loadSessionListPreferences('one', storage))).toBe('别名');
    expect(loadSessionListPreferences('two', storage)).toEqual(defaultSessionListPreferences);
    expect(sessionListStorageKey('one')).not.toBe(sessionListStorageKey('two'));
  });

  it('sorts pinned sessions first and formats relative time', () => {
    const older = session('older', '2026-08-22T00:00:00.000Z');
    const newer = session('newer', '2026-08-24T00:00:00.000Z');
    expect(sortSessionsForSidebar([older, newer], { schemaVersion: 1, pinnedSessionIds: ['older'], aliases: {} }).map((item) => item.id)).toEqual(['older', 'newer']);
    expect(relativeSessionTime(older.updatedAt, Date.parse('2026-08-25T00:00:00.000Z'))).toBe('3 天前');
  });

  it('uses the actual working-folder name in Hana-style session metadata', () => {
    expect(sessionWorkingFolderName({ name: '自定义项目名', rootPath: 'F:\\Research\\Getting Started\\' })).toBe('Getting Started');
    expect(sessionWorkingFolderName({ name: '备用名称', rootPath: '/srv/openlab/paper' })).toBe('paper');
    expect(sessionWorkingFolderName({ name: '备用名称', rootPath: '' })).toBe('备用名称');
  });
});
