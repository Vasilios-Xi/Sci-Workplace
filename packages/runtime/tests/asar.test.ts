import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { physicalAsarPath } from '../src/util/asar.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('ASAR child-process path resolution', () => {
  it('maps a virtual ASAR module to its physical unpacked file', () => {
    const root = mkdtempSync(join(tmpdir(), 'openlab-asar-'));
    temporaryDirectories.push(root);
    const virtual = join(root, 'app.asar', 'node_modules', 'tool', 'runner.js');
    const physical = join(root, 'app.asar.unpacked', 'node_modules', 'tool', 'runner.js');
    mkdirSync(join(physical, '..'), { recursive: true });
    writeFileSync(physical, 'export {};\n', 'utf8');
    expect(physicalAsarPath(virtual)).toBe(physical);
  });

  it('leaves ordinary and non-unpacked paths unchanged', () => {
    expect(physicalAsarPath(join('C:\\openlab', 'runner.js'))).toBe(join('C:\\openlab', 'runner.js'));
    expect(physicalAsarPath(join('C:\\openlab', 'app.asar', 'runner.js'))).toBe(join('C:\\openlab', 'app.asar', 'runner.js'));
  });
});
