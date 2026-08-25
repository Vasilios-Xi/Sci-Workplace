import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { desktopZhCN as copy } from './i18n/zh-CN.js';

interface ProjectManifestFile {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
}

const PROJECT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readManifest(rootPath: string): ProjectManifestFile | undefined {
  try {
    const value = recordValue(JSON.parse(readFileSync(join(rootPath, '.openlab', 'project.json'), 'utf8')) as unknown);
    if (value.schemaVersion !== 1
      || typeof value.id !== 'string' || !PROJECT_ID.test(value.id)
      || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200
      || typeof value.createdAt !== 'string') return undefined;
    return { schemaVersion: 1, id: value.id, name: value.name.trim(), createdAt: value.createdAt };
  } catch {
    return undefined;
  }
}

export function normalizeProjectName(value: unknown): string {
  if (typeof value !== 'string') throw new Error(copy.projectNameRequired);
  const name = value.trim();
  if (!name) throw new Error(copy.projectNameRequired);
  if (name.length > 200) throw new Error(copy.projectNameTooLong);
  if (/[\u0000-\u001f\u007f]/u.test(name)) throw new Error(copy.projectNameInvalid);
  return name;
}

export function resolveProjectFolder(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(copy.projectSourceRequired);
  const rootPath = resolve(value);
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) throw new Error(copy.projectSourceMissing);
  return rootPath;
}

export function projectFolderSelection(rootPath: string): { path: string; name: string } {
  const path = resolveProjectFolder(rootPath);
  return { path, name: readManifest(path)?.name ?? basename(path) ?? 'Sci Workplace Project' };
}

export function writeProjectManifest(rootPath: string, projectName: string): ProjectManifestFile {
  const path = resolveProjectFolder(rootPath);
  const name = normalizeProjectName(projectName);
  const metadataRoot = join(path, '.openlab');
  const manifestPath = join(metadataRoot, 'project.json');
  const existing = readManifest(path);
  const manifest: ProjectManifestFile = {
    schemaVersion: 1,
    id: existing?.id ?? randomUUID(),
    name,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  mkdirSync(metadataRoot, { recursive: true });
  const temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, manifestPath);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
  return manifest;
}

function gitDirectory(rootPath: string): string | undefined {
  const dotGit = join(rootPath, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const pointer = readFileSync(dotGit, 'utf8').trim().match(/^gitdir:\s*(.+)$/iu)?.[1]?.trim();
    return pointer ? resolve(dirname(dotGit), pointer) : undefined;
  } catch {
    return undefined;
  }
}

export function projectGitBranch(rootPath: string): string | undefined {
  const directory = gitDirectory(resolve(rootPath));
  if (!directory) return undefined;
  try {
    const head = readFileSync(join(directory, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: refs/heads/')) return head.slice('ref: refs/heads/'.length);
    return /^[a-f0-9]{7,64}$/iu.test(head) ? head.slice(0, 7) : undefined;
  } catch {
    return undefined;
  }
}
