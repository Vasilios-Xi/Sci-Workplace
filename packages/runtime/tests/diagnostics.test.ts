import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalLogger, redactSensitive } from '../src/diagnostics/local-logger.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('local diagnostics', () => {
  it('writes local JSONL logs while redacting key names and credential-shaped values', () => {
    const root = mkdtempSync(join(tmpdir(), 'openlab-logs-'));
    roots.push(root);
    const logger = new LocalLogger(root);
    logger.info('provider.test', { apiKey: 'sk-test-value', nested: { authorization: 'Bearer abcdefghijklmnop' }, note: 'sk-test-marker' });
    const entry = logger.tail(1)[0];
    expect(entry?.data).toEqual({ apiKey: '[REDACTED]', nested: { authorization: '[REDACTED]' }, note: 'sk-[REDACTED]' });
    const raw = readFileSync(join(root, logger.files()[0]!), 'utf8');
    expect(raw).not.toContain('test-value');
    expect(raw).not.toContain('abcdefghijklmnop');
  });

  it('redacts recursively without changing non-sensitive diagnostics', () => {
    expect(redactSensitive({ status: 'ok', values: [1, 'plain'] })).toEqual({ status: 'ok', values: [1, 'plain'] });
  });

  it('replaces local workspace paths with root aliases', () => {
    expect(redactSensitive({
      root: { id: 'root-evidence', displayPath: 'G:\\private\\evidence' },
      absolutePath: 'G:\\private\\evidence',
      relativePath: 'paper.md',
    })).toEqual({
      root: { id: 'root-evidence', displayPath: '<root:root-evidence>' },
      absolutePath: '<root:root-evidence>',
      relativePath: 'paper.md',
    });
  });
});
