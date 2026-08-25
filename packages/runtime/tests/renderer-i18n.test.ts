import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('renderer localization boundary', () => {
  it('keeps Chinese UI copy in the zh-CN language package instead of components', () => {
    const root = join(process.cwd(), 'apps', 'renderer', 'src');
    const violations: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) visit(path);
        else if (/\.(?:ts|tsx)$/u.test(entry) && !path.endsWith(join('i18n', 'zh-CN.ts'))) {
          if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(readFileSync(path, 'utf8'))) violations.push(path);
        }
      }
    };
    visit(root);
    expect(violations).toEqual([]);
  });

  it('keeps native desktop UI copy in its zh-CN language package', () => {
    const root = join(process.cwd(), 'apps', 'desktop', 'src');
    const violations: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) visit(path);
        else if (/\.(?:ts|cts)$/u.test(entry) && !path.endsWith(join('i18n', 'zh-CN.ts'))) {
          if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(readFileSync(path, 'utf8'))) violations.push(path);
        }
      }
    };
    visit(root);
    expect(violations).toEqual([]);
  });
});
