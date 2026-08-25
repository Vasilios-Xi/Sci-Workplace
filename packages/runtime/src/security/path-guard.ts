import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export class PathGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathGuardError';
  }
}
function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class PathGuard {
  readonly root: string;
  readonly #realRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.#realRoot = realpathSync.native(this.root);
  }

  resolveExisting(input: string): string {
    const candidate = resolve(this.root, input);
    const real = realpathSync.native(candidate);
    if (!isWithin(this.#realRoot, real)) throw new PathGuardError(`路径位于项目工作区之外：${input}`);
    return real;
  }

  resolveForWrite(input: string): string {
    const candidate = resolve(this.root, input);
    let current = candidate;
    while (true) {
      try {
        const realParent = realpathSync.native(current);
        if (!isWithin(this.#realRoot, realParent)) throw new PathGuardError(`写入路径位于项目工作区之外：${input}`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = dirname(current);
        if (parent === current) throw new PathGuardError(`无法解析写入路径：${input}`);
        current = parent;
      }
    }
    if (!isWithin(this.root, candidate)) throw new PathGuardError(`写入路径位于项目工作区之外：${input}`);
    try {
      if (lstatSync(candidate).isSymbolicLink()) throw new PathGuardError(`拒绝写入符号链接：${input}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return candidate;
  }
}
