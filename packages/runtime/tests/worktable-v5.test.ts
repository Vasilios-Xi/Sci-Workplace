import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { Annotation, JobRecord, ServerPushMessage } from '@openlab/protocol';
import { SqliteEventStore } from '../src/events/event-store.js';
import { OpenLabRuntime } from '../src/runtime.js';
import { startRuntimeServer } from '../src/server/runtime-server.js';
import { CORE_WORKTABLE_TEMPLATES, MAX_WORKTABLE_TABS, WorktableStore } from '../src/worktable/worktable-store.js';

const temporaryDirectories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'openlab-worktable-v5-'));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const actor = { id: 'local-user', kind: 'user', label: 'Test User' } as const;
const jsonHeaders = { Authorization: 'Bearer worktable-test', 'Content-Type': 'application/json' };

describe('protocol-v5 top-level worktable runtime', () => {
  it('event-sources instances, layouts, tabs, context metadata, and archive state', () => {
    const root = temporaryDirectory();
    const database = join(root, 'events.sqlite');
    const events = new SqliteEventStore(database);
    const store = new WorktableStore({ projectId: 'project-v5', events });
    const instance = store.create(CORE_WORKTABLE_TEMPLATES[0]!, { title: '审阅工作台', boundSessionId: 'session-1' }, actor);
    expect(instance.panes).toHaveLength(2);
    expect(instance).toMatchObject({ revision: 1, inputs: {}, templateVersion: '1.0.0' });
    expect(store.snapshot().activeInstanceId).toBe(instance.id);

    const mainPane = instance.panes[1]!;
    const sha256 = createHash('sha256').update('paper').digest('hex');
    const tab = store.mountTab(instance.id, mainPane.id, {
      title: '论文',
      content: { kind: 'document', target: { ref: { rootId: 'project', path: 'paper.pdf' }, sha256, mediaType: 'application/pdf' } },
    }, actor);
    expect(() => store.patch(instance.id, { title: '陈旧更新', ifRevision: instance.revision }, actor)).toThrow(/已被其他操作更新/u);
    const afterMount = store.snapshot().instances[0]!;
    const running = store.patch(instance.id, {
      status: 'running',
      inputs: {},
      activeRunId: 'run-1',
      artifactId: 'artifact-1',
      artifactRevisionId: 'artifact-revision-1',
      ifRevision: afterMount.revision,
    }, actor);
    expect(running).toMatchObject({
      revision: afterMount.revision + 1,
      activeRunId: 'run-1',
      artifactId: 'artifact-1',
      artifactRevisionId: 'artifact-revision-1',
    });
    const annotation: Annotation = {
      id: 'annotation-1', projectId: 'project-v5',
      target: { ref: { rootId: 'project', path: 'paper.pdf' }, sha256, mediaType: 'application/pdf' },
      selector: { kind: 'pdf-rect', page: 1, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }] },
      comments: [], status: 'open', sourceEventIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const job: JobRecord = {
      id: 'job-1', projectId: 'project-v5', status: 'running', progress: 0.5, logBytes: 0, outputs: [], createdAt: new Date().toISOString(),
      spec: { title: 'Compile', executable: 'latexmk', args: [], inputs: [], outputs: [], origin: 'user' },
      metadata: { worktableInstanceId: instance.id },
    };
    expect(store.context(instance.id, [job], [annotation])).toMatchObject({
      instanceId: instance.id,
      boundSessionId: 'session-1',
      pendingJobs: ['job-1'],
      openAnnotationIds: ['annotation-1'],
      panes: expect.arrayContaining([expect.objectContaining({ activeTab: expect.objectContaining({ kind: 'document', title: '论文' }) })]),
    });

    store.activateTab(instance.id, mainPane.id, tab.id, actor);
    const beforeLimit = store.snapshot().instances[0]!.panes.flatMap((pane) => pane.tabs).length;
    for (let index = beforeLimit; index < MAX_WORKTABLE_TABS; index += 1) {
      store.mountTab(instance.id, mainPane.id, { title: `Tab ${index}`, content: { kind: 'builtin', type: 'explorer' } }, actor);
    }
    expect(() => store.mountTab(instance.id, mainPane.id, { title: 'overflow', content: { kind: 'builtin', type: 'tasks' } }, actor)).toThrow(/最多打开 20 个标签/u);
    const changed = store.snapshot().instances[0]!;
    store.setLayout(instance.id, { ...changed.layout, ...(changed.layout.kind === 'split' ? { ratio: 0.4 } : {}) }, changed.panes, changed.activePaneId, actor);
    const beforeArchive = store.snapshot().instances[0]!;
    store.archive(instance.id, actor, beforeArchive.revision);
    const archived = store.snapshot().instances[0]!;
    expect(archived).toMatchObject({ status: 'archived', revision: beforeArchive.revision + 1, activeRunId: 'run-1', artifactId: 'artifact-1', artifactRevisionId: 'artifact-revision-1' });
    expect(archived.archivedAt).toBeTruthy();
    expect(() => store.patch(instance.id, { status: 'idle', ifRevision: archived.revision }, actor)).toThrow(/只读/u);
    expect(() => store.mountTab(instance.id, archived.panes[0]!.id, { title: '归档后写入', content: { kind: 'builtin', type: 'tasks' } }, actor)).toThrow(/只读/u);
    expect(store.activate(instance.id, actor).activeInstanceId).toBe(instance.id);
    expect(events.list('project:project-v5').some((event) => event.kind === 'worktable.layout_changed')).toBe(true);
    events.close();

    const restoredEvents = new SqliteEventStore(database);
    const restored = new WorktableStore({ projectId: 'project-v5', events: restoredEvents });
    expect(restored.snapshot().instances[0]).toMatchObject({
      id: instance.id,
      title: '审阅工作台',
      status: 'archived',
      boundSessionId: 'session-1',
      revision: archived.revision,
      inputs: {},
      templateVersion: '1.0.0',
      activeRunId: 'run-1',
      artifactId: 'artifact-1',
      artifactRevisionId: 'artifact-revision-1',
      archivedAt: archived.archivedAt,
    });
    restoredEvents.close();
  });

  it('validates versioned template inputs and migrates legacy instance projections', () => {
    const root = temporaryDirectory();
    const database = join(root, 'events.sqlite');
    const events = new SqliteEventStore(database);
    const store = new WorktableStore({ projectId: 'project-v5', events });
    const template = {
      ...structuredClone(CORE_WORKTABLE_TEMPLATES[0]!),
      id: 'fixture.reader',
      version: '2.1.0',
      inputSchema: {
        type: 'object',
        properties: { sourceId: { type: 'string' } },
        required: ['sourceId'],
        additionalProperties: false,
      },
    };
    expect(() => store.create(template, { inputs: {} }, actor)).toThrow(/实例输入不合法/u);
    const created = store.create(template, { inputs: { sourceId: 'source-1' } }, actor);
    expect(created).toMatchObject({ templateVersion: '2.1.0', inputs: { sourceId: 'source-1' }, revision: 1 });
    events.close();

    const legacyDatabase = join(root, 'legacy-events.sqlite');
    const legacyEvents = new SqliteEventStore(legacyDatabase);
    const timestamp = new Date().toISOString();
    const legacy = structuredClone(created) as Record<string, unknown>;
    delete legacy.revision;
    delete legacy.inputs;
    delete legacy.templateVersion;
    delete legacy.archivedAt;
    legacy.status = 'archived';
    legacy.updatedAt = timestamp;
    legacyEvents.append({
      streamId: 'project:legacy-project',
      kind: 'worktable.archived',
      actor,
      provenanceRefs: [created.id],
      payload: { state: { instances: [legacy], activeInstanceId: created.id }, instanceId: created.id },
    });
    const migrated = new WorktableStore({ projectId: 'legacy-project', events: legacyEvents }).snapshot().instances[0]!;
    expect(migrated).toMatchObject({ revision: 1, inputs: {}, templateVersion: '0.0.0-legacy', status: 'archived', archivedAt: timestamp });
    legacyEvents.close();
  });

  it('serves the renderer REST contract, projects legacy Workbench opens, and rejects browser secrets', async () => {
    const root = temporaryDirectory();
    const runtime = new OpenLabRuntime({ host: '127.0.0.1', port: 0, authToken: 'worktable-test', projectRoot: root, home: join(root, '.runtime'), demo: true });
    await runtime.initialize();
    const pushes: ServerPushMessage[] = [];
    const unsubscribe = runtime.subscribe((message) => pushes.push(message));
    const server = await startRuntimeServer(runtime, { host: '127.0.0.1', port: 0, authToken: 'worktable-test' });
    try {
      const createdResponse = await fetch(`${server.url}/api/worktable/instances`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ templateId: 'openlab.research', title: 'HTTP 工作台' }),
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { instance: ReturnType<OpenLabRuntime['createWorktable']> };
      const instance = created.instance;
      const paneId = instance.panes[1]!.id;

      const mountedResponse = await fetch(`${server.url}/api/worktable/instances/${instance.id}/panes/${paneId}/tabs`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title: '浏览器', content: { kind: 'builtin', type: 'browser' } }),
      });
      expect(mountedResponse.status).toBe(201);
      const mounted = await mountedResponse.json() as ReturnType<OpenLabRuntime['mountWorktableTab']>;
      expect(mounted).toMatchObject({ title: '浏览器', content: { kind: 'builtin', type: 'browser' } });
      const activated = await fetch(`${server.url}/api/worktable/instances/${instance.id}/panes/${paneId}/activate`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ tabId: mounted.id }),
      });
      expect(activated.status).toBe(200);

      const patched = await fetch(`${server.url}/api/worktable/instances/${instance.id}`, {
        method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ title: '重命名工作台' }),
      });
      expect(patched.status).toBe(200);
      const context = await fetch(`${server.url}/api/worktable/instances/${instance.id}/context`, { headers: jsonHeaders });
      expect(await context.json()).toMatchObject({ instanceId: instance.id, title: '重命名工作台' });

      const now = new Date().toISOString();
      const browserState = {
        profiles: [{ id: 'profile-1', name: '科研浏览器', partitionId: 'persist:openlab-browser-profile-1', authorizedProjectIds: [runtime.project.id], status: 'ready', createdAt: now, updatedAt: now }],
        sessions: [{ id: 'browser-1', profileId: 'profile-1', instanceId: instance.id, paneId, url: 'https://example.org/', title: 'Example', status: 'ready', authorizedDomains: ['example.org'], observationRevision: 1, createdAt: now, updatedAt: now }],
      };
      const browserResponse = await fetch(`${server.url}/api/browser/state`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(browserState) });
      expect(browserResponse.status).toBe(200);
      expect((await runtime.snapshot()).browserSessions).toEqual([expect.objectContaining({ id: 'browser-1', url: 'https://example.org/' })]);
      expect(pushes.some((message) => message.type === 'browser.changed')).toBe(true);
      expect(runtime.events.list(`project:${runtime.project.id}`).findLast((event) => event.kind === 'browser.state_changed')?.payload).not.toHaveProperty('cookies');

      const secretResponse = await fetch(`${server.url}/api/browser/state`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ...browserState, cookies: [{ value: 'secret' }] }),
      });
      expect(secretResponse.status).toBe(400);
      expect(await secretResponse.text()).toMatch(/敏感字段/u);

      runtime.openWorkbench({ title: '兼容审阅台', workbenchId: 'openlab.figure-review' });
      expect(runtime.worktables.snapshot().instances.some((candidate) => candidate.id.startsWith('legacy-workbench:'))).toBe(true);
      expect(pushes.some((message) => message.type === 'worktable.changed')).toBe(true);

      const closeResponse = await fetch(`${server.url}/api/worktable/instances/${instance.id}/panes/${paneId}/tabs/${mounted.id}`, { method: 'DELETE', headers: jsonHeaders });
      expect(closeResponse.status).toBe(200);
      const archiveResponse = await fetch(`${server.url}/api/worktable/instances/${instance.id}/archive`, { method: 'POST', headers: jsonHeaders });
      expect(archiveResponse.status).toBe(200);
      expect((await runtime.snapshot()).worktable.instances.find((candidate) => candidate.id === instance.id)?.status).toBe('archived');
    } finally {
      unsubscribe();
      await server.close();
      await runtime.stop();
    }
  }, 20_000);

  it('forwards browser tools to the authenticated loopback broker without persisting its token', async () => {
    const root = temporaryDirectory();
    const authorizationHeaders: Array<string | undefined> = [];
    const broker = createServer((request, response) => {
      authorizationHeaders.push(request.headers.authorization);
      if (request.url?.endsWith('/act')) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'broker-private-detail' }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'observation-1', text: 'sanitized page', elements: [] }));
    });
    await new Promise<void>((resolve, reject) => {
      broker.once('error', reject);
      broker.listen(0, '127.0.0.1', resolve);
    });
    const address = broker.address();
    if (!address || typeof address === 'string') throw new Error('fixture broker did not bind');
    const runtime = new OpenLabRuntime({
      host: '127.0.0.1', port: 0, authToken: 'runtime-token', projectRoot: root, home: join(root, '.runtime'), demo: true,
      browserBroker: { url: `http://127.0.0.1:${address.port}/browser`, token: 'broker-only-secret' },
    });
    await runtime.initialize();
    const context = {
      projectRoot: root, sessionId: 'session-1', agentId: 'agent-1', traceId: 'trace-1', callId: 'call-1', signal: new AbortController().signal,
      provenance: { traceId: 'trace-1', sessionId: 'session-1', agentId: 'agent-1', inputObjectIds: [], inputFileHashes: {} },
    };
    try {
      const observed = await runtime.tools.require('browser_observe').execute({ sessionId: 'browser-session-1' }, context);
      expect(observed.metadata).toMatchObject({ observation: { id: 'observation-1', text: 'sanitized page' }, trust: 'untrusted-external' });
      await expect(runtime.tools.require('browser_click').execute({ sessionId: 'browser-session-1', observationId: 'observation-1', ref: 'button-1' }, context)).rejects.toThrow('浏览器宿主请求失败（HTTP 500）');
      expect(authorizationHeaders).toEqual(['Bearer broker-only-secret', 'Bearer broker-only-secret']);
      expect(JSON.stringify(runtime.events.listAll())).not.toContain('broker-only-secret');
      expect(JSON.stringify(runtime.diagnostics())).not.toContain('broker-only-secret');
    } finally {
      await runtime.stop();
      await new Promise<void>((resolve, reject) => broker.close((error) => error ? reject(error) : resolve()));
    }
  });
});
