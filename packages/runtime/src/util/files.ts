import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
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
    // Windows can report EXDEV even for sibling paths when the managed app
    // data directory is protected by EFS or another filesystem filter. The
    // copy fallback preserves the completed temporary file as the source and
    // still replaces the projection only after the full payload is written.
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EXDEV') throw error;
    copyFileSync(temporary, path);
    rmSync(temporary, { force: true });
  }
}

/**
 * Copy across Windows application-container and virtual-drive boundaries.
 * Native copyFile can report UNKNOWN/EXDEV even when normal reads and writes
 * are allowed. The bounded fallback publishes through a destination-local
 * temporary file so a partial scientific artifact is never exposed.
 */
export function copyFilePortableSync(
  source: string,
  destination: string,
  nativeCopy: (source: string, destination: string) => void = copyFileSync,
): void {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.copying`;
  try {
    try {
      nativeCopy(source, temporary);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['UNKNOWN', 'EPERM', 'EACCES', 'EXDEV'].includes(code ?? '')) throw error;
      const sourceHandle = openSync(source, 'r');
      let destinationHandle: number | undefined;
      try {
        destinationHandle = openSync(temporary, 'wx');
        const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
        for (;;) {
          const bytes = readSync(sourceHandle, buffer, 0, buffer.length, null);
          if (bytes === 0) break;
          let offset = 0;
          while (offset < bytes) offset += writeSync(destinationHandle, buffer, offset, bytes - offset);
        }
      } finally {
        closeSync(sourceHandle);
        if (destinationHandle !== undefined) closeSync(destinationHandle);
      }
    }
    try {
      renameSync(temporary, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EEXIST', 'EPERM', 'EACCES', 'EXDEV', 'UNKNOWN'].includes(code ?? '')) throw error;
      nativeCopy(temporary, destination);
      rmSync(temporary, { force: true });
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
