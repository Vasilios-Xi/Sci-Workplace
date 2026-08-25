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

export function readDesktopSettings(path: string, timeZone?: string): DesktopSettings {
  try {
    if (!existsSync(path)) return {};
    const input = recordValue(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    return {
      ...(typeof input.projectRoot === 'string' && input.projectRoot ? { projectRoot: input.projectRoot } : {}),
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
