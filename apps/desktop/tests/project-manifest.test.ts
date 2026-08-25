import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeProjectName,
  projectFolderSelection,
  projectGitBranch,
  resolveProjectFolder,
  writeProjectManifest,
} from '../src/project-manifest.js';

const roots: string[] = [];
const temporaryDirectory = () => {
  const root = mkdtempSync(join(tmpdir(), 'openlab-project-manifest-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project manifest creation', () => {
  it('normalizes names and rejects invalid input', () => {
    expect(normalizeProjectName('  科研项目  ')).toBe('科研项目');
    expect(() => normalizeProjectName('   ')).toThrow('请输入项目名称');
    expect(() => normalizeProjectName(`项目${'x'.repeat(200)}`)).toThrow('200');
  });

  it('creates metadata and preserves identity when the display name changes', () => {
    const root = temporaryDirectory();
    const first = writeProjectManifest(root, '第一版');
    const second = writeProjectManifest(root, '第二版');
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(projectFolderSelection(root)).toEqual({ path: root, name: '第二版' });
    expect(JSON.parse(readFileSync(join(root, '.openlab', 'project.json'), 'utf8'))).toMatchObject({ name: '第二版', id: first.id });
  });

  it('requires an existing directory', () => {
    expect(() => resolveProjectFolder(join(temporaryDirectory(), 'missing'))).toThrow('不存在');
  });

  it('reads normal, nested, detached and worktree Git heads', () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/feature/chat-ui\n', 'utf8');
    expect(projectGitBranch(root)).toBe('feature/chat-ui');
    writeFileSync(join(root, '.git', 'HEAD'), '0123456789abcdef\n', 'utf8');
    expect(projectGitBranch(root)).toBe('0123456');

    const worktree = temporaryDirectory();
    const gitDirectory = join(temporaryDirectory(), 'worktrees', 'openlab');
    mkdirSync(gitDirectory, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitDirectory}\n`, 'utf8');
    writeFileSync(join(gitDirectory, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    expect(projectGitBranch(worktree)).toBe('main');
  });
});
