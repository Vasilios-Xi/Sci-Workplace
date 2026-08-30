import { beforeEach, describe, expect, it, vi } from 'vitest';

const filesystem = vi.hoisted(() => ({
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:fs', async () => ({
  ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
  ...filesystem,
}));

import { atomicWriteText } from '../src/util/files.js';

describe('atomic filesystem projections', () => {
  beforeEach(() => {
    for (const mock of Object.values(filesystem)) mock.mockReset();
  });

  it('falls back to a completed copy when a Windows filesystem filter reports EXDEV', () => {
    filesystem.renameSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    });

    const target = 'C:\\managed-app-data\\pricing\\deepseek.json';
    atomicWriteText(target, '{"ok":true}');

    expect(filesystem.writeFileSync).toHaveBeenCalledWith(expect.stringMatching(/deepseek\.json\..+\.tmp$/u), '{"ok":true}', 'utf8');
    const temporary = filesystem.writeFileSync.mock.calls[0]?.[0];
    expect(filesystem.copyFileSync).toHaveBeenCalledWith(temporary, target);
    expect(filesystem.rmSync).toHaveBeenCalledWith(temporary, { force: true });
  });

  it('does not hide unexpected rename failures', () => {
    filesystem.renameSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('read-only filesystem'), { code: 'EROFS' });
    });

    expect(() => atomicWriteText('C:\\managed-app-data\\pricing\\deepseek.json', '{}')).toThrow(/read-only filesystem/u);
    expect(filesystem.copyFileSync).not.toHaveBeenCalled();
    expect(filesystem.rmSync).not.toHaveBeenCalled();
  });
});
