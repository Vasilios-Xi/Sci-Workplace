import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  orderedProjectRootCandidates,
  projectSourceFolders,
  readDesktopSettings,
  rememberProjectSourceFolders,
  rememberRecentProjectRoot,
  writeDesktopSettingsAtomic,
} from '../src/settings-store.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('desktop settings project history', () => {
  it('persists a bounded, de-duplicated recent-project list', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sci-workplace-settings-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'desktop-settings.json');
    writeDesktopSettingsAtomic(path, {
      projectRoot: 'F:\\Research\\Current',
      recentProjectRoots: ['F:\\Research\\Current', 'f:\\research\\current', 'G:\\Evidence'],
      projectSourceFolders: { 'project-1': ['F:\\Research\\Current', 'G:\\Evidence', 'g:\\evidence'] },
    });
    const settings = readDesktopSettings(path, 'Asia/Shanghai');
    expect(settings.projectRoot).toBe('F:\\Research\\Current');
    expect(settings.recentProjectRoots).toEqual(['F:\\Research\\Current', 'G:\\Evidence']);
    expect(settings.projectSourceFolders?.['project-1']).toEqual(['F:\\Research\\Current', 'G:\\Evidence']);
    expect(JSON.parse(readFileSync(path, 'utf8')).recentProjectRoots).toHaveLength(3);
  });

  it('keeps established project positions stable when conversations are activated', () => {
    const initial = {
      projectRoot: 'F:\\Research\\11',
      recentProjectRoots: ['F:\\Research\\11', 'F:\\Research\\22'],
    };
    const activatedSecond = { ...rememberRecentProjectRoot(initial, 'F:\\Research\\22'), projectRoot: 'F:\\Research\\22' };
    expect(activatedSecond.recentProjectRoots).toEqual(['F:\\Research\\11', 'F:\\Research\\22']);
    expect(orderedProjectRootCandidates(activatedSecond, 'F:\\Research\\22')).toEqual(['F:\\Research\\11', 'F:\\Research\\22']);
  });

  it('adds a newly discovered project once without disturbing existing relative order', () => {
    const initial = { recentProjectRoots: ['F:\\Research\\11', 'F:\\Research\\22'] };
    const next = rememberRecentProjectRoot(initial, 'F:\\Research\\33');
    expect(next.recentProjectRoots).toEqual(['F:\\Research\\33', 'F:\\Research\\11', 'F:\\Research\\22']);
    expect(rememberRecentProjectRoot(next, 'f:\\research\\11').recentProjectRoots).toEqual(next.recentProjectRoots);
  });

  it('persists multiple user-approved folders for one project with the primary folder first', () => {
    const initial = rememberProjectSourceFolders({}, 'project-1', 'F:\\Research\\Main', [
      'G:\\Evidence',
      'f:\\research\\main',
      'H:\\Datasets',
    ]);
    expect(projectSourceFolders(initial, 'project-1', 'F:\\Research\\Main')).toEqual([
      'F:\\Research\\Main',
      'G:\\Evidence',
      'H:\\Datasets',
    ]);
  });
});
