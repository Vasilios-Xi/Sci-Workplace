import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerPushMessage } from '@openlab/protocol';
import { OpenLabRuntime } from '../src/runtime.js';
import { startRuntimeServer } from '../src/server/runtime-server.js';

const roots: string[] = [];
function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'openlab-generated-app-runtime-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

describe('generated worktable app runtime integration', () => {
  it('archives, broadcasts, tickets, and serves a verified static artifact revision with a restrictive CSP', async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, 'site', 'dist', 'assets'), { recursive: true });
    writeFileSync(join(root, 'site', 'dist', 'index.html'), '<!doctype html><script type="module" src="./assets/app.js"></script><h1>OpenLab app</h1>', 'utf8');
    writeFileSync(join(root, 'site', 'dist', 'assets', 'app.js'), 'document.body.dataset.ready="yes";', 'utf8');
    const runtime = new OpenLabRuntime({ host: '127.0.0.1', port: 0, authToken: 'generated-test', projectRoot: root, home: join(root, '.runtime'), demo: true });
    await runtime.initialize();
    const pushes: ServerPushMessage[] = [];
    const unsubscribe = runtime.subscribe((message) => pushes.push(message));
    const artifact = runtime.research.createObject({ type: 'artifact', title: 'Static app', status: 'active', attributes: {}, attachments: [] }, { id: 'user', kind: 'user' });
    const revision = runtime.artifactRevisions.create({
      artifactId: artifact.id,
      files: [
        { role: 'output', ref: { rootId: 'project', path: 'site/dist/index.html' }, name: 'dist/index.html', mediaType: 'text/html' },
        { role: 'output', ref: { rootId: 'project', path: 'site/dist/assets/app.js' }, name: 'dist/assets/app.js', mediaType: 'text/javascript' },
      ],
      provenance: { traceId: 'trace', sessionId: 'session', agentId: 'agent', inputObjectIds: [], inputFileHashes: {} },
    }, { id: 'user', kind: 'user' });
    const app = runtime.publishGeneratedApp({
      title: 'Interactive report', artifactId: artifact.id, revisionId: revision.id, entry: 'dist/index.html', networkDomains: ['https://example.org'],
    });
    expect(runtime.artifactRevisions.list(artifact.id)[0]?.status).toBe('archived');
    expect((await runtime.snapshot()).generatedApps).toEqual([expect.objectContaining({ id: app.id, activeRevisionId: revision.id, status: 'ready' })]);
    expect(pushes.some((message) => message.type === 'generated-app.changed')).toBe(true);

    // The immutable archive, not the mutable source directory, is served.
    writeFileSync(join(root, 'site', 'dist', 'assets', 'app.js'), 'tampered source', 'utf8');
    const server = await startRuntimeServer(runtime, { host: '127.0.0.1', port: 0, authToken: 'generated-test', generatedAppTicketTtlMs: 120 });
    try {
      const unauthorized = await fetch(`${server.url}/api/generated-apps/${app.id}/revisions/${revision.id}/ticket`, { method: 'POST' });
      expect(unauthorized.status).toBe(401);
      const issued = await fetch(`${server.url}/api/generated-apps/${app.id}/revisions/${revision.id}/ticket`, {
        method: 'POST', headers: { Authorization: 'Bearer generated-test', 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(issued.status).toBe(201);
      const ticket = await issued.json() as { url: string; expiresAt: string };
      expect(ticket.url).not.toContain('generated-test');
      expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(Date.now());

      const html = await fetch(ticket.url);
      expect(html.status).toBe(200);
      expect(await html.text()).toContain('OpenLab app');
      expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(html.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-forms allow-same-origin');
      expect(html.headers.get('content-security-policy')).toContain('connect-src');
      expect(html.headers.get('content-security-policy')).toContain('https://example.org');
      expect(html.headers.get('x-content-type-options')).toBe('nosniff');

      // One scoped ticket can be replayed briefly for the entry and its static
      // module graph, but cannot escape the revision file manifest.
      const scriptUrl = new URL('./assets/app.js', ticket.url).toString();
      const script = await fetch(scriptUrl);
      expect(script.status).toBe(200);
      expect(await script.text()).toBe('document.body.dataset.ready="yes";');
      const cached = await fetch(scriptUrl, { headers: { 'If-None-Match': script.headers.get('etag') ?? '' } });
      expect(cached.status).toBe(304);
      const outside = await fetch(new URL('../not-in-revision.js', ticket.url));
      expect(outside.status).toBe(404);

      const wrongRevision = await fetch(`${server.url}/api/generated-apps/${app.id}/revisions/not-active/ticket`, {
        method: 'POST', headers: { Authorization: 'Bearer generated-test', 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(wrongRevision.status).toBe(404);

      const expiring = await fetch(`${server.url}/api/generated-apps/${app.id}/revisions/${revision.id}/ticket`, {
        method: 'POST', headers: { Authorization: 'Bearer generated-test', 'Content-Type': 'application/json' }, body: '{}',
      });
      const expiringTicket = await expiring.json() as { url: string };
      await new Promise((resolve) => setTimeout(resolve, 160));
      expect((await fetch(expiringTicket.url)).status).toBe(404);
    } finally {
      await server.close();
      unsubscribe();
      await runtime.stop();
    }
  }, 20_000);

  it('refuses tickets for archived apps and forbidden static resource types', async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'index.html'), '<h1>safe</h1>', 'utf8');
    writeFileSync(join(root, 'payload.exe'), 'not really executable', 'utf8');
    const runtime = new OpenLabRuntime({ host: '127.0.0.1', port: 0, authToken: 'generated-test', projectRoot: root, home: join(root, '.runtime'), demo: true });
    await runtime.initialize();
    const artifact = runtime.research.createObject({ type: 'artifact', title: 'Static app', status: 'active', attributes: {}, attachments: [] }, { id: 'user', kind: 'user' });
    const revision = runtime.artifactRevisions.create({
      artifactId: artifact.id,
      files: [
        { role: 'output', ref: { rootId: 'project', path: 'index.html' }, name: 'index.html' },
        { role: 'output', ref: { rootId: 'project', path: 'payload.exe' }, name: 'payload.exe' },
      ],
      provenance: { traceId: 'trace', sessionId: 'session', agentId: 'agent', inputObjectIds: [], inputFileHashes: {} },
    }, { id: 'user', kind: 'user' });
    expect(() => runtime.publishGeneratedApp({ title: 'Rejected', artifactId: artifact.id, revisionId: revision.id, entry: 'index.html' })).toThrow(/executable/u);

    // Publish a clean revision, then archive the app itself. Tickets validate
    // live app status on every asset request rather than only at issuance.
    const cleanArtifact = runtime.research.createObject({ type: 'artifact', title: 'Clean app', status: 'active', attributes: {}, attachments: [] }, { id: 'user', kind: 'user' });
    const cleanRevision = runtime.artifactRevisions.create({
      artifactId: cleanArtifact.id,
      files: [{ role: 'output', ref: { rootId: 'project', path: 'index.html' }, name: 'index.html' }],
      provenance: { traceId: 'trace-2', sessionId: 'session', agentId: 'agent', inputObjectIds: [], inputFileHashes: {} },
    }, { id: 'user', kind: 'user' });
    const app = runtime.publishGeneratedApp({ title: 'Clean', artifactId: cleanArtifact.id, revisionId: cleanRevision.id, entry: 'index.html' });
    const server = await startRuntimeServer(runtime, { host: '127.0.0.1', port: 0, authToken: 'generated-test' });
    try {
      const issued = await fetch(`${server.url}/api/generated-apps/${app.id}/revisions/${cleanRevision.id}/ticket`, {
        method: 'POST', headers: { Authorization: 'Bearer generated-test', 'Content-Type': 'application/json' }, body: '{}',
      });
      const ticket = await issued.json() as { url: string };
      runtime.archiveGeneratedApp(app.id);
      expect((await fetch(ticket.url)).status).toBe(404);
      const reissue = await fetch(`${server.url}/api/generated-apps/${app.id}/revisions/${cleanRevision.id}/ticket`, {
        method: 'POST', headers: { Authorization: 'Bearer generated-test', 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(reissue.status).toBe(404);
    } finally {
      await server.close();
      await runtime.stop();
    }
  }, 20_000);
});
