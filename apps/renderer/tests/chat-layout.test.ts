import { describe, expect, it } from 'vitest';
import {
  chatLayoutStorageKey,
  defaultChatLayoutPreferences,
  loadChatLayoutPreferences,
  parseChatLayoutPreferences,
  saveChatLayoutPreferences,
} from '../src/lib/chat-layout.js';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe('chat layout preferences', () => {
  it('uses the expanded two-panel default when no value exists', () => {
    expect(parseChatLayoutPreferences(null)).toEqual(defaultChatLayoutPreferences);
  });

  it('parses valid version one data and clamps the composer height', () => {
    expect(parseChatLayoutPreferences(JSON.stringify({
      schemaVersion: 1,
      leftSidebarOpen: false,
      rightWorkspaceOpen: true,
      workspaceTab: 'files',
      workspaceWidth: 999,
      composerHeight: 999,
    }))).toEqual({
      schemaVersion: 1,
      leftSidebarOpen: false,
      rightWorkspaceOpen: true,
      workspaceTab: 'files',
      workspaceWidth: 720,
      composerHeight: 240,
    });
  });

  it('loads old version-one data with the default workspace width', () => {
    expect(parseChatLayoutPreferences(JSON.stringify({
      schemaVersion: 1,
      leftSidebarOpen: true,
      rightWorkspaceOpen: true,
      workspaceTab: 'workspace',
      composerHeight: null,
    })).workspaceWidth).toBe(400);
  });

  it.each([
    '{bad json',
    JSON.stringify({ schemaVersion: 0 }),
    JSON.stringify({ schemaVersion: 1, leftSidebarOpen: 'yes', rightWorkspaceOpen: true, workspaceTab: 'workspace', composerHeight: null }),
    JSON.stringify({ schemaVersion: 1, leftSidebarOpen: true, rightWorkspaceOpen: true, workspaceTab: 'unknown', composerHeight: null }),
  ])('falls back as a unit for invalid or old data', (raw) => {
    expect(parseChatLayoutPreferences(raw)).toEqual(defaultChatLayoutPreferences);
  });

  it('isolates saved preferences by project id', () => {
    const storage = new MemoryStorage();
    saveChatLayoutPreferences('project/a', { ...defaultChatLayoutPreferences, leftSidebarOpen: false }, storage);
    saveChatLayoutPreferences('project/b', { ...defaultChatLayoutPreferences, rightWorkspaceOpen: false }, storage);

    expect(loadChatLayoutPreferences('project/a', storage).leftSidebarOpen).toBe(false);
    expect(loadChatLayoutPreferences('project/a', storage).rightWorkspaceOpen).toBe(true);
    expect(loadChatLayoutPreferences('project/b', storage).leftSidebarOpen).toBe(true);
    expect(loadChatLayoutPreferences('project/b', storage).rightWorkspaceOpen).toBe(false);
    expect(chatLayoutStorageKey('project/a')).not.toBe(chatLayoutStorageKey('project/b'));
  });
});
