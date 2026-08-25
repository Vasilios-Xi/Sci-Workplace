import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { DocumentRevisionRef, ResourceHandle } from '@openlab/protocol';
import { PathGuard } from '../security/path-guard.js';
import { sha256FileSync } from './file-hash.js';

const HANDLE_TTL_MS = 15 * 60_000;
const MAX_RPC_CHUNK = 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  '.bib': 'application/x-bibtex', '.csv': 'text/csv', '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.json': 'application/json', '.md': 'text/markdown', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.tex': 'application/x-tex', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.txt': 'text/plain', '.webp': 'image/webp',
};

interface InternalResource {
  handle: ResourceHandle;
  absolutePath: string;
}

export class ResourceService {
  readonly #resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
  readonly #handles = new Map<string, InternalResource>();

  constructor(resolveRoot: (rootId: string, intent: 'read' | 'write') => string) {
    this.#resolveRoot = resolveRoot;
  }

  open(target: DocumentRevisionRef): ResourceHandle {
    this.cleanup();
    const root = this.#resolveRoot(target.ref.rootId, 'read');
    const absolute = new PathGuard(root).resolveExisting(target.ref.path);
    const stats = statSync(absolute);
    if (!stats.isFile()) throw new Error('资源目标不是普通文件');
    const actualHash = sha256FileSync(absolute);
    if (actualHash !== target.sha256) throw new Error('资源文件已经变化，原 revision 不能继续复用');
    const id = randomUUID();
    const mediaType = target.mediaType ?? MEDIA_TYPES[extname(target.ref.path).toLocaleLowerCase()] ?? 'application/octet-stream';
    const expiresAt = new Date(Date.now() + HANDLE_TTL_MS).toISOString();
    const handle: ResourceHandle = {
      id,
      name: basename(target.ref.path),
      mediaType,
      size: stats.size,
      sha256: actualHash,
      etag: `"sha256-${actualHash}"`,
      expiresAt,
      source: structuredClone(target),
    };
    this.#handles.set(id, { handle, absolutePath: absolute });
    return structuredClone(handle);
  }

  describe(id: string): ResourceHandle {
    return structuredClone(this.require(id).handle);
  }

  resolve(id: string): { handle: ResourceHandle; absolutePath: string } {
    const resource = this.require(id);
    return { handle: structuredClone(resource.handle), absolutePath: resource.absolutePath };
  }

  read(id: string, start = 0, end?: number): Buffer {
    const resource = this.require(id);
    const first = Math.max(0, Math.trunc(start));
    const lastExclusive = Math.min(resource.handle.size, end === undefined ? first + MAX_RPC_CHUNK : Math.max(first, Math.trunc(end)));
    if (lastExclusive - first > MAX_RPC_CHUNK) throw new Error('插件单次资源读取不能超过 1 MB');
    const output = Buffer.alloc(Math.max(0, lastExclusive - first));
    if (output.length === 0) return output;
    const descriptor = openSync(resource.absolutePath, 'r');
    try {
      let offset = 0;
      while (offset < output.length) {
        const bytes = readSync(descriptor, output, offset, output.length - offset, first + offset);
        if (bytes === 0) throw new Error('资源在读取期间被截断');
        offset += bytes;
      }
    }
    finally { closeSync(descriptor); }
    return output;
  }

  release(id: string): void {
    this.#handles.delete(id);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, resource] of this.#handles) {
      if (Date.parse(resource.handle.expiresAt) <= now) this.#handles.delete(id);
    }
  }

  dispose(): void {
    this.#handles.clear();
  }

  private require(id: string): InternalResource {
    this.cleanup();
    const resource = this.#handles.get(id);
    if (!resource) throw new Error('资源句柄不存在或已经失效');
    return resource;
  }
}
