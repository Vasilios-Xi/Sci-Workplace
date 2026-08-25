import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';

export function sha256FileSync(path: string): string {
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally { closeSync(descriptor); }
  return hash.digest('hex');
}
