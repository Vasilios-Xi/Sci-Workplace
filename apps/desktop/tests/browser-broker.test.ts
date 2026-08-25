import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAutomationBroker } from '../src/browser-broker.js';
import type { WorktableBrowserManager } from '../src/browser-manager.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function managerFixture() {
  return {
    profiles: vi.fn(() => []),
    sessions: vi.fn(() => []),
    open: vi.fn(async () => ({ ok: true })),
    navigate: vi.fn(async () => ({ ok: true })),
    observe: vi.fn(async () => ({ id: 'observation-1' })),
    act: vi.fn(async () => ({ ok: true })),
    screenshot: vi.fn(async () => ({
      id: 'capture-1', sessionId: 'session-1', mediaType: 'image/png' as const,
      size: PNG.length, sha256: 'hash', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    readScreenshot: vi.fn(() => ({
      resource: { id: 'capture-1', sessionId: 'session-1', mediaType: 'image/png' as const, size: PNG.length, sha256: 'hash', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      bytes: PNG,
    })),
    upload: vi.fn(async () => ({ ok: true })),
    download: vi.fn(async () => ({ quarantineId: 'quarantine-1', status: 'quarantined' })),
    close: vi.fn(() => ({ ok: true })),
  };
}

async function call(url: string, token: string, path: string, input: Record<string, unknown>) {
  return await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

describe('desktop browser broker', () => {
  let broker: BrowserAutomationBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  it('rejects unknown action names before invoking the browser manager', async () => {
    const manager = managerFixture();
    broker = new BrowserAutomationBroker(() => manager as unknown as WorktableBrowserManager);
    const connection = await broker.start();
    const response = await call(connection.url, connection.token, '/act', {
      sessionId: 'session-1', observationId: 'observation-1', action: 'executeJavaScript', confirmed: true,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Browser action is invalid' });
    expect(manager.act).not.toHaveBeenCalled();
  });

  it('requires a fresh confirmation for every upload and download', async () => {
    const manager = managerFixture();
    broker = new BrowserAutomationBroker(() => manager as unknown as WorktableBrowserManager);
    const connection = await broker.start();
    const common = { sessionId: 'session-1', observationId: 'observation-1', ref: 'e1' };

    const upload = await call(connection.url, connection.token, '/upload', { ...common, uploadIds: ['upload-1'], confirmed: false });
    const download = await call(connection.url, connection.token, '/download', { ...common, confirmed: false });

    expect(upload.status).toBe(400);
    expect(download.status).toBe(400);
    expect(manager.upload).not.toHaveBeenCalled();
    expect(manager.download).not.toHaveBeenCalled();

    expect((await call(connection.url, connection.token, '/upload', { ...common, uploadIds: ['upload-1'], confirmed: true })).status).toBe(200);
    expect((await call(connection.url, connection.token, '/download', { ...common, confirmed: true })).status).toBe(200);
    expect(manager.upload).toHaveBeenCalledOnce();
    expect(manager.download).toHaveBeenCalledOnce();
  });

  it('serves screenshots only as authenticated, no-store PNG resources', async () => {
    const manager = managerFixture();
    broker = new BrowserAutomationBroker(() => manager as unknown as WorktableBrowserManager);
    const connection = await broker.start();
    const capture = await call(connection.url, connection.token, '/screenshot', { sessionId: 'session-1', observationId: 'observation-1' });
    expect(capture.status).toBe(200);
    expect(await capture.json()).toEqual(expect.objectContaining({ id: 'capture-1', mediaType: 'image/png' }));

    const unauthorized = await fetch(`${connection.url}/screenshots/capture-1`);
    expect(unauthorized.status).toBe(401);
    const resource = await fetch(`${connection.url}/screenshots/capture-1`, { headers: { authorization: `Bearer ${connection.token}` } });
    expect(resource.status).toBe(200);
    expect(resource.headers.get('content-type')).toBe('image/png');
    expect(resource.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await resource.arrayBuffer())).toEqual(PNG);
  });
});
