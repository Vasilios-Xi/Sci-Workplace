import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

/**
 * Reads a rebuildable JSON projection. Missing or malformed projections are
 * treated as empty so their authoritative event stream can reconstruct them.
 * Filesystem failures are still surfaced to avoid hiding permission or disk
 * errors.
 */
export function readJsonProjection<T>(path: string, fallback: T): T {
  try {
    return readJsonFile(path, fallback);
  } catch (error) {
    if (error instanceof SyntaxError) return fallback;
    throw error;
  }
}

export function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function atomicWriteText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, 'utf8');
  try {
    renameSync(temporary, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM') throw error;
    copyFileSync(temporary, path);
    rmSync(temporary, { force: true });
  }
}
