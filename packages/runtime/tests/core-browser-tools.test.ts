import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@openlab/protocol';
import { ApprovalPolicy } from '../src/security/approval-policy.js';
import { registerCoreTools, type CoreToolDependencies } from '../src/tools/core-tools.js';
import { ToolRegistry, type ToolExecutionContext } from '../src/tools/tool-registry.js';

type BrokerRequest = {
  path: Parameters<NonNullable<CoreToolDependencies['browserRequest']>>[0];
  input: Record<string, JsonValue>;
};

const context: ToolExecutionContext = {
  projectRoot: 'C:\\workspace',
  sessionId: 'runtime-session',
  agentId: 'agent-1',
  traceId: 'trace-1',
  callId: 'call-1',
  signal: new AbortController().signal,
  provenance: { traceId: 'trace-1', sessionId: 'runtime-session', agentId: 'agent-1', inputObjectIds: [], inputFileHashes: {} },
};

function fixture(browserRequest: NonNullable<CoreToolDependencies['browserRequest']>): ToolRegistry {
  const registry = new ToolRegistry();
  registerCoreTools({
    registry,
    projectRoot: 'C:\\workspace',
    projectId: 'project-1',
    changes: undefined as never,
    research: undefined as never,
    pins: undefined as never,
    browserRequest,
  });
  return registry;
}

describe('core browser tools', () => {
  it('registers the complete browser surface with observation and approval policy constraints', () => {
    const registry = fixture(async () => ({}));
    const definitions = new Map(registry.definitions().map((definition) => [definition.name, definition]));

    expect([...definitions.keys()]).toEqual(expect.arrayContaining([
      'browser_open', 'browser_observe', 'browser_click', 'browser_type', 'browser_select', 'browser_press', 'browser_scroll',
      'browser_screenshot', 'browser_upload', 'browser_download',
    ]));

    for (const name of ['browser_click', 'browser_type', 'browser_select', 'browser_press', 'browser_scroll', 'browser_screenshot', 'browser_upload', 'browser_download']) {
      const schema = definitions.get(name)?.inputSchema as { required?: string[] };
      expect(schema.required, `${name} must bind to a fresh observation`).toContain('observationId');
    }

    expect(definitions.get('browser_screenshot')?.risk).toBe('read');
    expect(definitions.get('browser_upload')?.risk).toBe('external');
    expect(definitions.get('browser_download')?.risk).toBe('external');

    const policy = new ApprovalPolicy();
    expect(policy.evaluate(definitions.get('browser_screenshot')!, 'ask').required).toBe(false);
    expect(policy.evaluate(definitions.get('browser_upload')!, 'trusted').required).toBe(true);
    expect(policy.evaluate(definitions.get('browser_download')!, 'trusted').required).toBe(true);
  });

  it('sends broker requests with observation IDs and only confirms per-action transfers', async () => {
    const requests: BrokerRequest[] = [];
    const registry = fixture(async (path, input) => {
      requests.push({ path, input });
      if (path === 'screenshot') return {
        id: 'shot-1', sessionId: 'browser-session-1', mediaType: 'image/png', size: 321,
        sha256: 'A'.repeat(64), expiresAt: '2026-08-24T00:10:00.000Z',
        path: 'C:\\private\\shot.png', data: 'data:image/png;base64,private-bytes',
      };
      if (path === 'download') return {
        quarantineId: 'quarantine-1', sessionId: 'browser-session-1', fileName: 'private-name.pdf', mediaType: 'application/pdf',
        sourceDomain: 'EXAMPLE.ORG', size: 654, sha256: 'b'.repeat(64), status: 'quarantined', quarantinedAt: '2026-08-24T00:00:00.000Z',
        path: 'C:\\private\\download.pdf',
      };
      return { path: 'C:\\private\\upload-source.pdf' };
    });

    const screenshot = await registry.require('browser_screenshot').execute({ sessionId: 'browser-session-1', observationId: 'observation-1' }, context);
    const upload = await registry.require('browser_upload').execute({
      sessionId: 'browser-session-1', observationId: 'observation-2', ref: 'file-input-1', uploadIds: ['opaque-upload-1'],
    }, context);
    const download = await registry.require('browser_download').execute({
      sessionId: 'browser-session-1', observationId: 'observation-3', ref: 'download-link-1',
    }, context);

    expect(requests).toEqual([
      { path: 'screenshot', input: { sessionId: 'browser-session-1', observationId: 'observation-1' } },
      { path: 'upload', input: { sessionId: 'browser-session-1', observationId: 'observation-2', ref: 'file-input-1', uploadIds: ['opaque-upload-1'], confirmed: true } },
      { path: 'download', input: { sessionId: 'browser-session-1', observationId: 'observation-3', ref: 'download-link-1', confirmed: true } },
    ]);
    expect(screenshot.metadata).toEqual({
      imageResource: {
        id: 'shot-1', sessionId: 'browser-session-1', mediaType: 'image/png', size: 321,
        sha256: 'a'.repeat(64), expiresAt: '2026-08-24T00:10:00.000Z',
      },
      trust: 'untrusted-external',
    });
    expect(upload.metadata).toEqual({ observationInvalidated: true });
    expect(download.metadata).toEqual({
      quarantine: { sha256: 'b'.repeat(64), size: 654, mediaType: 'application/pdf', sourceAlias: 'example.org' },
      trust: 'untrusted-external', observationInvalidated: true,
    });

    const exposed = JSON.stringify({ screenshot, upload, download });
    expect(exposed).not.toContain('base64');
    expect(exposed).not.toContain('C:\\\\private');
    expect(exposed).not.toContain('private-name.pdf');
    expect(exposed).not.toContain('quarantine-1');
    expect(exposed).not.toContain('opaque-upload-1');
  });

  it('accepts only opaque desktop upload handles and requires an observation for transfers', async () => {
    const registry = fixture(async () => ({}));
    await expect(registry.require('browser_upload').execute({
      sessionId: 'browser-session-1', observationId: 'observation-1', ref: 'file-input-1', uploadIds: ['C:\\private\\paper.pdf'],
    }, context)).rejects.toThrow(/参数不合法/u);
    await expect(registry.require('browser_upload').execute({
      sessionId: 'browser-session-1', ref: 'file-input-1', uploadIds: ['opaque-upload-1'],
    }, context)).rejects.toThrow(/参数不合法/u);
    await expect(registry.require('browser_download').execute({ sessionId: 'browser-session-1', ref: 'download-link-1' }, context)).rejects.toThrow(/参数不合法/u);
  });
});
