import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  normalizeInterfacePreferences,
  type InterfacePreferences,
  type WorktableDeviceUiState,
} from '@openlab/protocol';

export interface DesktopSettings {
  projectRoot?: string;
  recentProjectRoots?: string[];
  /** User-approved folders bound to a project, keyed by the project's stable manifest id. */
  projectSourceFolders?: Record<string, string[]>;
  interfacePreferences?: InterfacePreferences;
  worktableUi?: Record<string, WorktableDeviceUiState>;
}

const DEFAULT_WORKTABLE_UI: WorktableDeviceUiState = { drawerWidth: 236, chatWidth: 460, chatHeight: 620, drawerCollapsed: false, chatCollapsed: true, paneRatios: {} };

function normalizeWorktableUi(value: unknown): Record<string, WorktableDeviceUiState> {
  const input = recordValue(value);
  const output: Record<string, WorktableDeviceUiState> = {};
  for (const [id, raw] of Object.entries(input).slice(0, 500)) {
    if (!id || id.length > 200) continue;
    const state = recordValue(raw);
    const ratios = recordValue(state.paneRatios);
    output[id] = {
      drawerWidth: typeof state.drawerWidth === 'number' && Number.isFinite(state.drawerWidth) ? Math.min(420, Math.max(180, Math.round(state.drawerWidth))) : DEFAULT_WORKTABLE_UI.drawerWidth,
      chatWidth: typeof state.chatWidth === 'number' && Number.isFinite(state.chatWidth) ? Math.min(760, Math.max(360, Math.round(state.chatWidth))) : DEFAULT_WORKTABLE_UI.chatWidth,
      chatHeight: typeof state.chatHeight === 'number' && Number.isFinite(state.chatHeight) ? Math.min(900, Math.max(360, Math.round(state.chatHeight))) : DEFAULT_WORKTABLE_UI.chatHeight,
      drawerCollapsed: state.drawerCollapsed === true,
      chatCollapsed: state.chatCollapsed !== false,
      paneRatios: Object.fromEntries(Object.entries(ratios).filter(([key, ratio]) => key.length <= 200 && typeof ratio === 'number' && Number.isFinite(ratio)).slice(0, 100).map(([key, ratio]) => [key, Math.min(0.85, Math.max(0.15, ratio as number))])),
      ...(typeof state.focusedPaneId === 'string' && state.focusedPaneId.length <= 200 ? { focusedPaneId: state.focusedPaneId } : {}),
      ...(typeof state.maximizedPaneId === 'string' && state.maximizedPaneId.length <= 200 ? { maximizedPaneId: state.maximizedPaneId } : {}),
      activeTabIds: Object.fromEntries(Object.entries(recordValue(state.activeTabIds)).filter(([paneId, tabId]) => paneId.length <= 200 && typeof tabId === 'string' && tabId.length <= 200).slice(0, 100).map(([paneId, tabId]) => [paneId, tabId as string])),
      openInstanceIds: Array.isArray(state.openInstanceIds) ? state.openInstanceIds.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length <= 200).slice(0, 20) : [],
    };
  }
  return output;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeRecentProjectRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const root = candidate.trim();
    const key = root.toLocaleLowerCase();
    if (!root || root.length > 32_768 || seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
    if (roots.length >= 20) break;
  }
  return roots;
}

function normalizeFolderList(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const folder = candidate.trim();
    const key = folder.toLocaleLowerCase();
    if (!folder || folder.length > 32_768 || seen.has(key)) continue;
    seen.add(key);
    folders.push(folder);
    if (folders.length >= limit) break;
  }
  return folders;
}

function normalizeProjectSourceFolderMap(value: unknown): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const [projectId, rawFolders] of Object.entries(recordValue(value)).slice(0, 100)) {
    if (!projectId || projectId.length > 200) continue;
    const folders = normalizeFolderList(rawFolders);
    if (folders.length) output[projectId] = folders;
  }
  return output;
}

export function projectSourceFolders(settings: DesktopSettings, projectId: string, rootPath: string): string[] {
  return normalizeFolderList([rootPath, ...(settings.projectSourceFolders?.[projectId] ?? [])]);
}

export function rememberProjectSourceFolders(settings: DesktopSettings, projectId: string, rootPath: string, folders: string[]): DesktopSettings {
  const projectSourceFolders = normalizeProjectSourceFolderMap(settings.projectSourceFolders);
  projectSourceFolders[projectId] = normalizeFolderList([rootPath, ...folders]);
  return { ...settings, projectSourceFolders };
}

export function forgetProjectSourceFolders(settings: DesktopSettings, projectId: string): DesktopSettings {
  const projectSourceFolders = normalizeProjectSourceFolderMap(settings.projectSourceFolders);
  delete projectSourceFolders[projectId];
  return { ...settings, projectSourceFolders };
}

/**
 * Adds a project to the desktop catalog without turning ordinary navigation
 * into an MRU reorder. A project's first insertion establishes its sidebar
 * position; activating another conversation in that project must not move it.
 */
export function rememberRecentProjectRoot(settings: DesktopSettings, rootPath: string): DesktopSettings {
  const root = rootPath.trim();
  const recentProjectRoots = normalizeRecentProjectRoots(settings.recentProjectRoots);
  if (!root) return { ...settings, recentProjectRoots };
  const key = root.toLocaleLowerCase();
  if (recentProjectRoots.some((candidate) => candidate.toLocaleLowerCase() === key)) {
    return { ...settings, recentProjectRoots };
  }
  return { ...settings, recentProjectRoots: [root, ...recentProjectRoots].slice(0, 20) };
}

/** Returns the stable catalog order, adding active/legacy roots only as fallbacks. */
export function orderedProjectRootCandidates(settings: DesktopSettings, activeRoot?: string): string[] {
  return normalizeRecentProjectRoots([
    ...(settings.recentProjectRoots ?? []),
    activeRoot,
    settings.projectRoot,
  ]);
}

export function readDesktopSettings(path: string, timeZone?: string): DesktopSettings {
  try {
    if (!existsSync(path)) return {};
    const input = recordValue(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    return {
      ...(typeof input.projectRoot === 'string' && input.projectRoot ? { projectRoot: input.projectRoot } : {}),
      recentProjectRoots: normalizeRecentProjectRoots(input.recentProjectRoots),
      projectSourceFolders: normalizeProjectSourceFolderMap(input.projectSourceFolders),
      interfacePreferences: normalizeInterfacePreferences(input.interfacePreferences, timeZone),
      worktableUi: normalizeWorktableUi(input.worktableUi),
    };
  } catch {
    return {};
  }
}

export function writeDesktopSettingsAtomic(path: string, settings: DesktopSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}
