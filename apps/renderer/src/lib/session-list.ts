import type { ConversationSourceDescriptor, ProjectSummary, SessionSummary } from '@openlab/protocol';
import { chatShellZhCN as copy } from '../i18n/zh-CN.js';

export interface SessionListPreferencesV1 {
  schemaVersion: 1;
  pinnedSessionIds: string[];
  /** Projects pinned into the GPT-style Pinned section. Optional for v1 storage compatibility. */
  pinnedProjectIds?: string[];
  aliases: Record<string, string>;
  /** Last session revision the user has actually seen. Used for real unread markers. */
  readSessionUpdates: Record<string, string>;
}

export const defaultSessionListPreferences: SessionListPreferencesV1 = {
  schemaVersion: 1,
  pinnedSessionIds: [],
  pinnedProjectIds: [],
  aliases: {},
  readSessionUpdates: {},
};

const STORAGE_PREFIX = 'openlab.session-list.v1:';

export function sessionListStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(projectId)}`;
}

export function parseSessionListPreferences(raw: string | null | undefined): SessionListPreferencesV1 {
  if (!raw) return { ...defaultSessionListPreferences, aliases: {}, readSessionUpdates: {} };
  try {
    const value = JSON.parse(raw) as Partial<SessionListPreferencesV1> | null;
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.pinnedSessionIds) || !value.pinnedSessionIds.every((id) => typeof id === 'string') || !value.aliases || typeof value.aliases !== 'object' || Array.isArray(value.aliases) || !Object.values(value.aliases).every((title) => typeof title === 'string')) {
      return { ...defaultSessionListPreferences, aliases: {} };
    }
    return {
      schemaVersion: 1,
      pinnedSessionIds: [...new Set(value.pinnedSessionIds)],
      pinnedProjectIds: Array.isArray(value.pinnedProjectIds)
        ? [...new Set(value.pinnedProjectIds.filter((id): id is string => typeof id === 'string'))]
        : [],
      aliases: Object.fromEntries(Object.entries(value.aliases).filter(([, title]) => title.trim()).map(([id, title]) => [id, title.trim()])),
      readSessionUpdates: value.readSessionUpdates && typeof value.readSessionUpdates === 'object' && !Array.isArray(value.readSessionUpdates)
        ? Object.fromEntries(Object.entries(value.readSessionUpdates).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Number.isFinite(Date.parse(entry[1]))))
        : {},
    };
  } catch {
    return { ...defaultSessionListPreferences, aliases: {}, readSessionUpdates: {} };
  }
}

type SessionListStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function loadSessionListPreferences(projectId: string, storage?: SessionListStorage): SessionListPreferencesV1 {
  if (!storage) return { ...defaultSessionListPreferences, aliases: {}, readSessionUpdates: {} };
  try { return parseSessionListPreferences(storage.getItem(sessionListStorageKey(projectId))); }
  catch { return { ...defaultSessionListPreferences, aliases: {}, readSessionUpdates: {} }; }
}

export function saveSessionListPreferences(projectId: string, preferences: SessionListPreferencesV1, storage?: SessionListStorage): void {
  if (!storage) return;
  try { storage.setItem(sessionListStorageKey(projectId), JSON.stringify(preferences)); }
  catch { /* Local list preferences are optional. */ }
}

export function sessionDisplayTitle(session: SessionSummary, preferences: SessionListPreferencesV1): string {
  return preferences.aliases[session.id]?.trim() || session.title;
}

export function sessionHasUnread(session: SessionSummary, activeSessionId: string, preferences: SessionListPreferencesV1): boolean {
  if (session.id === activeSessionId) return false;
  const readAt = preferences.readSessionUpdates[session.id];
  return Boolean(readAt && Date.parse(session.updatedAt) > Date.parse(readAt));
}

export function sessionProjectDisplayName(project: Pick<ProjectSummary, 'name' | 'rootPath'>): string {
  const displayName = project.name.trim();
  if (displayName) return displayName;
  const normalized = project.rootPath.trim().replace(/[\\/]+$/u, '');
  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) || '';
}

export function sessionListMetadata(agentName: string, projectName: string | undefined, timeLabel: string): string {
  return [agentName, projectName, timeLabel].map((value) => value?.trim()).filter(Boolean).join(' · ');
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

export function groupSessionsForSidebar(sessions: SessionSummary[], preferences: SessionListPreferencesV1, projectFolderAvailable: boolean): {
  pinned: SessionSummary[];
  project: SessionSummary[];
  recent: SessionSummary[];
} {
  const pinnedIds = new Set(preferences.pinnedSessionIds);
  const pinned = sessions.filter((session) => pinnedIds.has(session.id));
  const unpinned = sessions.filter((session) => !pinnedIds.has(session.id));
  return {
    pinned,
    project: projectFolderAvailable ? unpinned : [],
    recent: projectFolderAvailable ? [] : unpinned,
  };
}

export function groupSessionsByConversationSource(
  sessions: SessionSummary[],
  preferences: SessionListPreferencesV1,
  sources: ConversationSourceDescriptor[],
): {
  pinned: SessionSummary[];
  pinnedProjects: Array<{ source: ConversationSourceDescriptor & { kind: 'project' }; sessions: SessionSummary[] }>;
  projects: Array<{ source: ConversationSourceDescriptor & { kind: 'project' }; sessions: SessionSummary[] }>;
  recent: SessionSummary[];
} {
  const pinnedIds = new Set(preferences.pinnedSessionIds);
  const pinned = sessions.filter((session) => pinnedIds.has(session.id));
  const unpinned = sessions.filter((session) => !pinnedIds.has(session.id));
  const sourceByProjectId = new Map(sources.map((source) => [source.projectId, source]));
  const pinnedProjectIds = new Set(preferences.pinnedProjectIds ?? []);
  const projectGroups = sources
    .filter((source): source is ConversationSourceDescriptor & { kind: 'project' } => source.kind === 'project')
    .map((source) => ({ source, sessions: unpinned.filter((session) => session.projectId === source.projectId) }));
  const pinnedProjects = projectGroups.filter(({ source }) => pinnedProjectIds.has(source.projectId));
  const projects = projectGroups.filter(({ source }) => !pinnedProjectIds.has(source.projectId));
  const recent = unpinned.filter((session) => sourceByProjectId.get(session.projectId)?.kind !== 'project');
  return { pinned, pinnedProjects, projects, recent };
}
