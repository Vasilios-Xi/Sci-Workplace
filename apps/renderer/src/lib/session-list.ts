import type { ProjectSummary, SessionSummary } from '@openlab/protocol';
import { chatShellZhCN as copy } from '../i18n/zh-CN.js';

export interface SessionListPreferencesV1 {
  schemaVersion: 1;
  pinnedSessionIds: string[];
  aliases: Record<string, string>;
}

export const defaultSessionListPreferences: SessionListPreferencesV1 = {
  schemaVersion: 1,
  pinnedSessionIds: [],
  aliases: {},
};

const STORAGE_PREFIX = 'openlab.session-list.v1:';

export function sessionListStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(projectId)}`;
}

export function parseSessionListPreferences(raw: string | null | undefined): SessionListPreferencesV1 {
  if (!raw) return { ...defaultSessionListPreferences, aliases: {} };
  try {
    const value = JSON.parse(raw) as Partial<SessionListPreferencesV1> | null;
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.pinnedSessionIds) || !value.pinnedSessionIds.every((id) => typeof id === 'string') || !value.aliases || typeof value.aliases !== 'object' || Array.isArray(value.aliases) || !Object.values(value.aliases).every((title) => typeof title === 'string')) {
      return { ...defaultSessionListPreferences, aliases: {} };
    }
    return {
      schemaVersion: 1,
      pinnedSessionIds: [...new Set(value.pinnedSessionIds)],
      aliases: Object.fromEntries(Object.entries(value.aliases).filter(([, title]) => title.trim()).map(([id, title]) => [id, title.trim()])),
    };
  } catch {
    return { ...defaultSessionListPreferences, aliases: {} };
  }
}

type SessionListStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function loadSessionListPreferences(projectId: string, storage?: SessionListStorage): SessionListPreferencesV1 {
  if (!storage) return { ...defaultSessionListPreferences, aliases: {} };
  try { return parseSessionListPreferences(storage.getItem(sessionListStorageKey(projectId))); }
  catch { return { ...defaultSessionListPreferences, aliases: {} }; }
}

export function saveSessionListPreferences(projectId: string, preferences: SessionListPreferencesV1, storage?: SessionListStorage): void {
  if (!storage) return;
  try { storage.setItem(sessionListStorageKey(projectId), JSON.stringify(preferences)); }
  catch { /* Local list preferences are optional. */ }
}

export function sessionDisplayTitle(session: SessionSummary, preferences: SessionListPreferencesV1): string {
  return preferences.aliases[session.id]?.trim() || session.title;
}

export function sessionWorkingFolderName(project: Pick<ProjectSummary, 'name' | 'rootPath'>): string {
  const normalized = project.rootPath.trim().replace(/[\\/]+$/u, '');
  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) || project.name;
}

export function relativeSessionTime(updatedAt: string, now = Date.now()): string {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return '';
  const elapsed = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return copy.sidebar.relativeTime.justNow;
  if (elapsed < hour) return copy.sidebar.relativeTime.minutesAgo(Math.floor(elapsed / minute));
  if (elapsed < day) return copy.sidebar.relativeTime.hoursAgo(Math.floor(elapsed / hour));
  if (elapsed < 30 * day) return copy.sidebar.relativeTime.daysAgo(Math.floor(elapsed / day));
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(timestamp);
}

export function sortSessionsForSidebar(sessions: SessionSummary[], preferences: SessionListPreferencesV1): SessionSummary[] {
  const pinned = new Set(preferences.pinnedSessionIds);
  return [...sessions].sort((left, right) => {
    const pinOrder = Number(pinned.has(right.id)) - Number(pinned.has(left.id));
    if (pinOrder) return pinOrder;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}
