import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyFilePortableSync } from '../src/util/files.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('portable artifact copy', () => {
  it('falls back to a bounded userspace copy when Windows reports UNKNOWN', () => {
    const root = mkdtempSync(join(tmpdir(), 'sci-portable-copy-'));
    roots.push(root);
    const source = join(root, 'virtual-source.bin');
    const destination = join(root, 'archive', 'object.bin');
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 19, 0x5a);
    writeFileSync(source, bytes);

    copyFilePortableSync(source, destination, () => {
      throw Object.assign(new Error('cross-container copy failed'), { code: 'UNKNOWN' });
    });

    expect(readFileSync(destination).equals(bytes)).toBe(true);
    expect(readdirSync(join(root, 'archive'))).toEqual(['object.bin']);
  });
});
