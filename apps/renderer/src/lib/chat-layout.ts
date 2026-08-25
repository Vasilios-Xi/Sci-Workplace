export interface ChatLayoutPreferencesV1 {
  schemaVersion: 1;
  leftSidebarOpen: boolean;
  rightWorkspaceOpen: boolean;
  workspaceTab: 'files' | 'workspace';
  composerHeight: number | null;
}

export const defaultChatLayoutPreferences: ChatLayoutPreferencesV1 = {
  schemaVersion: 1,
  leftSidebarOpen: true,
  rightWorkspaceOpen: true,
  workspaceTab: 'workspace',
  composerHeight: null,
};

const STORAGE_PREFIX = 'openlab.chat-layout.v1:';
const MIN_COMPOSER_HEIGHT = 72;
const MAX_COMPOSER_HEIGHT = 240;

export function chatLayoutStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(projectId)}`;
}

export function clampComposerHeight(value: number): number {
  return Math.round(Math.min(MAX_COMPOSER_HEIGHT, Math.max(MIN_COMPOSER_HEIGHT, value)));
}

export function parseChatLayoutPreferences(raw: string | null | undefined): ChatLayoutPreferencesV1 {
  if (!raw) return { ...defaultChatLayoutPreferences };
  try {
    const value = JSON.parse(raw) as Partial<ChatLayoutPreferencesV1> | null;
    if (
      !value
      || value.schemaVersion !== 1
      || typeof value.leftSidebarOpen !== 'boolean'
      || typeof value.rightWorkspaceOpen !== 'boolean'
      || (value.workspaceTab !== 'files' && value.workspaceTab !== 'workspace')
      || (value.composerHeight !== null && (typeof value.composerHeight !== 'number' || !Number.isFinite(value.composerHeight)))
    ) return { ...defaultChatLayoutPreferences };
    return {
      schemaVersion: 1,
      leftSidebarOpen: value.leftSidebarOpen,
      rightWorkspaceOpen: value.rightWorkspaceOpen,
      workspaceTab: value.workspaceTab,
      composerHeight: value.composerHeight === null ? null : clampComposerHeight(value.composerHeight),
    };
  } catch {
    return { ...defaultChatLayoutPreferences };
  }
}

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function loadChatLayoutPreferences(projectId: string, storage?: LayoutStorage): ChatLayoutPreferencesV1 {
  if (!storage) return { ...defaultChatLayoutPreferences };
  try {
    return parseChatLayoutPreferences(storage.getItem(chatLayoutStorageKey(projectId)));
  } catch {
    return { ...defaultChatLayoutPreferences };
  }
}

export function saveChatLayoutPreferences(projectId: string, preferences: ChatLayoutPreferencesV1, storage?: LayoutStorage): void {
  if (!storage) return;
  try {
    storage.setItem(chatLayoutStorageKey(projectId), JSON.stringify(preferences));
  } catch {
    // Storage can be unavailable in privacy modes. Layout remains usable in memory.
  }
}
