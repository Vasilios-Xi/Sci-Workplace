import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@openlab/protocol';
import {
  defaultSessionListPreferences,
  groupSessionsByConversationSource,
  groupSessionsForSidebar,
  loadSessionListPreferences,
  parseSessionListPreferences,
  relativeSessionTime,
  sessionListMetadata,
  saveSessionListPreferences,
  sessionDisplayTitle,
  sessionHasUnread,
  sessionListStorageKey,
  sessionProjectDisplayName,
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
      pinnedProjectIds: [],
      aliases: { a: '新标题' },
      readSessionUpdates: {},
    });
  });

  it('keeps projects isolated and resolves local display titles', () => {
    const storage = new MemoryStorage();
    saveSessionListPreferences('one', { schemaVersion: 1, pinnedSessionIds: ['a'], aliases: { a: '别名' }, readSessionUpdates: {} }, storage);
    expect(sessionDisplayTitle(session('a', '2026-08-25T00:00:00.000Z'), loadSessionListPreferences('one', storage))).toBe('别名');
    expect(loadSessionListPreferences('two', storage)).toEqual(defaultSessionListPreferences);
    expect(sessionListStorageKey('one')).not.toBe(sessionListStorageKey('two'));
  });

  it('sorts pinned sessions first and formats relative time', () => {
    const older = session('older', '2026-08-22T00:00:00.000Z');
    const newer = session('newer', '2026-08-24T00:00:00.000Z');
    expect(sortSessionsForSidebar([older, newer], { schemaVersion: 1, pinnedSessionIds: ['older'], aliases: {}, readSessionUpdates: {} }).map((item) => item.id)).toEqual(['older', 'newer']);
    expect(relativeSessionTime(older.updatedAt, Date.parse('2026-08-25T00:00:00.000Z'))).toBe('3 天前');
  });

  it('uses the project display name in session metadata and only falls back to the folder name', () => {
    expect(sessionProjectDisplayName({ name: '自定义项目名', rootPath: 'F:\\Research\\Getting Started\\' })).toBe('自定义项目名');
    expect(sessionProjectDisplayName({ name: '  ', rootPath: '/srv/openlab/paper' })).toBe('paper');
    expect(sessionProjectDisplayName({ name: '备用名称', rootPath: '' })).toBe('备用名称');
  });

  it('omits the project segment for conversations that are not attached to a project', () => {
    expect(sessionListMetadata('小弓', undefined, '12 小时前')).toBe('小弓 · 12 小时前');
    expect(sessionListMetadata('小弓', '负极-电解质文献汇报', '12 小时前')).toBe('小弓 · 负极-电解质文献汇报 · 12 小时前');
  });

  it('places unbound conversations in Recent while keeping pins separate', () => {
    const pinned = session('pinned', '2026-08-25T01:00:00.000Z');
    const ordinary = session('ordinary', '2026-08-25T02:00:00.000Z');
    const preferences = { schemaVersion: 1 as const, pinnedSessionIds: ['pinned'], aliases: {}, readSessionUpdates: {} };
    expect(groupSessionsForSidebar([pinned, ordinary], preferences, false)).toEqual({ pinned: [pinned], project: [], recent: [ordinary] });
    expect(groupSessionsForSidebar([pinned, ordinary], preferences, true)).toEqual({ pinned: [pinned], project: [ordinary], recent: [] });
  });

  it('keeps project and detached conversations visible in the same global sidebar catalog', () => {
    const projectSession = { ...session('project-chat', '2026-08-25T03:00:00.000Z'), projectId: 'project-a' };
    const detachedSession = { ...session('detached-chat', '2026-08-25T04:00:00.000Z'), projectId: 'detached' };
    const sources = [
      { kind: 'detached' as const, projectId: 'detached', rootPath: 'F:\\Detached', name: '' },
      { kind: 'project' as const, projectId: 'project-a', rootPath: 'F:\\Research\\A', name: 'A' },
    ];
    const grouped = groupSessionsByConversationSource([detachedSession, projectSession], defaultSessionListPreferences, sources);
    expect(grouped.pinnedProjects).toEqual([]);
    expect(grouped.projects).toEqual([{ source: sources[1], sessions: [projectSession] }]);
    expect(grouped.recent).toEqual([detachedSession]);
  });

  it('keeps project groups in source order regardless of the active or newest conversation', () => {
    const projectASession = { ...session('project-a-chat', '2026-08-25T03:00:00.000Z'), projectId: 'project-a' };
    const projectBSession = { ...session('project-b-chat', '2026-08-27T03:00:00.000Z'), projectId: 'project-b' };
    const sources = [
      { kind: 'project' as const, projectId: 'project-a', rootPath: 'F:\\Research\\11', name: '11' },
      { kind: 'project' as const, projectId: 'project-b', rootPath: 'F:\\Research\\22', name: '22' },
    ];
    const grouped = groupSessionsByConversationSource([projectBSession, projectASession], defaultSessionListPreferences, sources);
    expect(grouped.projects.map(({ source }) => source.projectId)).toEqual(['project-a', 'project-b']);
  });

  it('moves a pinned project and its conversations into the Pinned section without duplication', () => {
    const projectSession = { ...session('project-chat', '2026-08-25T03:00:00.000Z'), projectId: 'project-a' };
    const sources = [{ kind: 'project' as const, projectId: 'project-a', rootPath: 'F:\\Research\\A', name: 'A' }];
    const grouped = groupSessionsByConversationSource([projectSession], {
      ...defaultSessionListPreferences,
      pinnedProjectIds: ['project-a'],
    }, sources);
    expect(grouped.pinnedProjects).toEqual([{ source: sources[0], sessions: [projectSession] }]);
    expect(grouped.projects).toEqual([]);
  });

  it('shows unread only after an inactive session advances beyond its last read revision', () => {
    const item = session('other', '2026-08-25T02:00:00.000Z');
    const preferences = { schemaVersion: 1 as const, pinnedSessionIds: [], aliases: {}, readSessionUpdates: { other: '2026-08-25T01:00:00.000Z' } };
    expect(sessionHasUnread(item, 'active', preferences)).toBe(true);
    expect(sessionHasUnread(item, 'other', preferences)).toBe(false);
    expect(sessionHasUnread({ ...item, status: 'running' }, 'active', preferences)).toBe(true);
    expect(sessionHasUnread(item, 'active', { ...preferences, readSessionUpdates: { other: item.updatedAt } })).toBe(false);
    expect(sessionHasUnread(item, 'active', { ...preferences, readSessionUpdates: {} })).toBe(false);
  });
});
