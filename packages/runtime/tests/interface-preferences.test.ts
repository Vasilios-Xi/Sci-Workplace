import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultInterfacePreferences,
  isValidTimeZone,
  mergeInterfacePreferences,
  normalizeInterfacePreferences,
} from '@openlab/protocol';
import { readDesktopSettings, writeDesktopSettingsAtomic } from '../../../apps/desktop/src/settings-store.js';
import { formatClockTime, formatDateTime, zonedDayOrdinal } from '../../../apps/renderer/src/lib/date-time.js';

const roots: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'openlab-interface-settings-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('interface preferences', () => {
  it('uses the Hana-style defaults without hard-coding the machine timezone', () => {
    const preferences = defaultInterfacePreferences('Europe/London');
    expect(preferences).toMatchObject({
      schemaVersion: 2,
      theme: 'warm-paper',
      semanticPaletteOverrides: {},
      readingFont: 'serif',
      readingSizeDelta: 0,
      chatWidth: 800,
      paperTexture: true,
      sunnyMode: false,
      hardwareAcceleration: true,
      singleLineSessions: false,
      locale: 'zh-CN',
      timeZone: 'Europe/London',
      markdown: { font: 'follow-reading', bodySize: 16, contentWidth: 800, heading1Size: 28, heading2Size: 21, heading3Size: 18, lineHeight: 1.5, contentPadding: 24 },
    });
  });

  it('sanitizes externally edited settings and clamps numeric boundaries', () => {
    const preferences = normalizeInterfacePreferences({
      theme: 'not-a-theme', readingFont: 'comic', readingSizeDelta: 9, chatWidth: 900,
      paperTexture: 'yes', hardwareAcceleration: false, timeZone: 'Not/AZone',
      markdown: { bodySize: 80, heading1Size: 1, heading2Size: 99, heading3Size: 5, lineHeight: 4, contentPadding: -8 },
    }, 'UTC');
    expect(preferences).toMatchObject({
      theme: 'warm-paper', readingFont: 'serif', readingSizeDelta: 0, chatWidth: 800,
      paperTexture: true, hardwareAcceleration: false, timeZone: 'UTC',
      markdown: { bodySize: 24, heading1Size: 20, heading2Size: 40, heading3Size: 14, lineHeight: 2.2, contentPadding: 0 },
    });
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });

  it('deep-merges markdown patches without resetting other preferences', () => {
    const current = defaultInterfacePreferences('UTC');
    const next = mergeInterfacePreferences(current, { theme: 'cyan-night', markdown: { bodySize: 19 } });
    expect(next.theme).toBe('cyan-night');
    expect(next.markdown).toMatchObject({ bodySize: 19, heading1Size: 28, contentWidth: 800 });
  });

  it('migrates schema v1 palettes and keeps only valid per-theme overrides', () => {
    const preferences = normalizeInterfacePreferences({
      schemaVersion: 1,
      theme: 'coral-paper',
      semanticPaletteOverrides: {
        'warm-paper': { neutral: '#abcdef', success: '#12345G', unknown: '#112233' },
        'cyan-night': { info: '#82b7d1' },
        auto: { accent: '#112233' },
        unknown: { danger: '#AABBCC' },
      },
    }, 'UTC');
    expect(preferences.schemaVersion).toBe(2);
    expect(preferences.semanticPaletteOverrides).toEqual({
      'warm-paper': { neutral: '#ABCDEF' },
      'cyan-night': { info: '#82B7D1' },
    });
  });

  it('isolates palette overrides by theme and supports role, theme, and global resets', () => {
    const initial = mergeInterfacePreferences(defaultInterfacePreferences('UTC'), {
      semanticPaletteOverrides: {
        'warm-paper': { accent: '#123456', success: '#234567' },
        'coral-paper': { accent: '#345678' },
      },
    });
    expect(initial.semanticPaletteOverrides['warm-paper']).toEqual({ accent: '#123456', success: '#234567' });
    expect(initial.semanticPaletteOverrides['coral-paper']).toEqual({ accent: '#345678' });

    const roleReset = mergeInterfacePreferences(initial, {
      semanticPaletteOverrides: { 'warm-paper': { success: '#234567' }, 'coral-paper': { accent: '#345678' } },
    });
    expect(roleReset.semanticPaletteOverrides['warm-paper']).toEqual({ success: '#234567' });

    const themeReset = mergeInterfacePreferences(roleReset, {
      semanticPaletteOverrides: { 'coral-paper': { accent: '#345678' } },
    });
    expect(themeReset.semanticPaletteOverrides).toEqual({ 'coral-paper': { accent: '#345678' } });
    expect(mergeInterfacePreferences(themeReset, { semanticPaletteOverrides: {} }).semanticPaletteOverrides).toEqual({});
  });

  it('formats timeline and channel timestamps in the selected timezone', () => {
    const timestamp = '2026-01-01T16:30:00.000Z';
    expect(formatClockTime(timestamp, 'Asia/Tokyo')).toContain('01:30');
    expect(formatDateTime(timestamp, 'America/New_York')).toContain('2026/1/1');
    expect(zonedDayOrdinal(timestamp, 'Asia/Tokyo')).toBe(zonedDayOrdinal('2026-01-02T03:00:00.000Z', 'Asia/Tokyo'));
    expect(zonedDayOrdinal(timestamp, 'UTC')).not.toBe(zonedDayOrdinal(timestamp, 'Asia/Tokyo'));
  });

  it('migrates a schema-zero desktop file and writes it atomically', () => {
    const root = temporaryDirectory();
    const path = join(root, 'desktop-settings.json');
    writeFileSync(path, JSON.stringify({ projectRoot: 'F:\\Research' }), 'utf8');
    const migrated = readDesktopSettings(path, 'Asia/Shanghai');
    expect(migrated.projectRoot).toBe('F:\\Research');
    expect(migrated.interfacePreferences).toMatchObject({ schemaVersion: 2, semanticPaletteOverrides: {}, timeZone: 'Asia/Shanghai' });
    writeDesktopSettingsAtomic(path, { ...migrated, interfacePreferences: mergeInterfacePreferences(migrated.interfacePreferences!, { theme: 'coral-paper' }) });
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).interfacePreferences.theme).toBe('coral-paper');
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('normalizes device-local worktable geometry without adding it to interface preferences', () => {
    const root = temporaryDirectory();
    const path = join(root, 'desktop-settings.json');
    writeFileSync(path, JSON.stringify({ worktableUi: { alpha: { drawerWidth: 999, chatWidth: 10, drawerCollapsed: true, chatCollapsed: false, paneRatios: { split: .99, invalid: 'x' } } } }), 'utf8');
    const settings = readDesktopSettings(path, 'UTC');
    expect(settings.worktableUi?.alpha).toEqual({ drawerWidth: 420, chatWidth: 360, chatHeight: 620, drawerCollapsed: true, chatCollapsed: false, paneRatios: { split: .85 }, activeTabIds: {}, openInstanceIds: [] });
    expect(settings.interfacePreferences).not.toHaveProperty('worktableUi');
  });
});
