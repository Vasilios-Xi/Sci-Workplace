import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRevision } from '@openlab/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteEventStore } from '../src/events/event-store.js';
import { GeneratedAppService } from '../src/worktable/generated-app-service.js';

const roots: string[] = [];
const actor = { id: 'user', kind: 'user' as const };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openlab-generated-app-'));
  roots.push(root);
  const events = new SqliteEventStore(join(root, 'events.db'));
  const revision: ArtifactRevision = {
    id: 'revision-1', artifactId: 'artifact-1', annotationSetIds: [], status: 'active', createdAt: new Date().toISOString(),
    files: [{ role: 'output', name: 'dist/index.html', mediaType: 'text/html', sha256: 'a'.repeat(64), size: 120 }],
    provenance: { artifactId: 'artifact-1', traceId: 'trace', sessionId: 'session', agentId: 'agent', inputObjectIds: [], inputFileHashes: {}, createdAt: new Date().toISOString() },
  };
  const service = new GeneratedAppService({ projectId: 'project', events, resolveRevision: (id) => id === revision.id ? revision : undefined });
  return { events, service };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('GeneratedAppService', () => {
  it('publishes static artifact revisions and replays them', () => {
    const { events, service } = fixture();
    const app = service.publish({ title: 'Dashboard', artifactId: 'artifact-1', revisionId: 'revision-1', entry: 'dist/index.html', networkDomains: ['https://example.org'], hostCapabilities: ['worktable:read'] }, actor);
    expect(app.status).toBe('ready');
    expect(app.networkDomains).toEqual(['example.org']);
    const replayed = new GeneratedAppService({ projectId: 'project', events, resolveRevision: () => undefined });
    expect(replayed.get(app.id)).toEqual(app);
    events.close();
  });

  it('rejects executable payloads, missing entries and unsupported capabilities', () => {
    const { events, service } = fixture();
    expect(() => service.publish({ title: 'Bad', artifactId: 'artifact-1', revisionId: 'revision-1', entry: '../index.html' }, actor)).toThrow(/entry/u);
    expect(() => service.publish({ title: 'Bad', artifactId: 'artifact-1', revisionId: 'revision-1', entry: 'dist/missing.html' }, actor)).toThrow(/not present/u);
    expect(() => service.publish({ title: 'Bad', artifactId: 'artifact-1', revisionId: 'revision-1', entry: 'dist/index.html', hostCapabilities: ['workspace:write'] }, actor)).toThrow(/unsupported/u);
    events.close();
  });
});
