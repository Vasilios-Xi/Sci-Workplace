import { describe, expect, it } from 'vitest';
import type { ArtifactRevision, BootstrapSnapshot, GeneratedWorktableApp, WorktableInstance, WorktablePane, WorktableTab } from '@openlab/protocol';
import {
  connectGeneratedApp,
  generatedAppAnnotationInput,
  generatedAppAnnotationView,
  generatedAppAnnotationsView,
  generatedAppArtifactView,
  generatedAppCapabilities,
  generatedAppCapabilityForMethod,
  generatedAppResearchView,
  generatedAppWorktableView,
  loopbackGeneratedAppOrigin,
  parseGeneratedAppRequest,
} from '../src/lib/generated-app-bridge.js';

const now = new Date(0).toISOString();
const revision: ArtifactRevision = {
  id: 'revision-1', artifactId: 'artifact-1', annotationSetIds: [], status: 'active', createdAt: now,
  files: [{ role: 'output', name: 'chart.png', mediaType: 'image/png', sha256: 'a'.repeat(64), size: 123, ref: { rootId: 'project', path: 'figures/chart.png' }, archivedPath: 'private/archive/path' }],
  provenance: { artifactId: 'artifact-1', traceId: 'trace', sessionId: 'session', agentId: 'agent', inputObjectIds: [], inputFileHashes: {}, createdAt: now },
};
const app: GeneratedWorktableApp = {
  id: 'app-1', projectId: 'project', title: 'Dashboard', artifactId: 'artifact-1', activeRevisionId: revision.id, entry: 'index.html',
  networkDomains: [], hostCapabilities: ['worktable:read', 'artifacts:read', 'annotations:read', 'annotations:write', 'research:read'], status: 'ready', createdAt: now, updatedAt: now,
};
const tab: WorktableTab = { id: 'tab-1', title: 'Dashboard', content: { kind: 'generated-app', appId: app.id, revisionId: revision.id }, openedAt: now };
const pane: WorktablePane = { id: 'pane-1', tabs: [tab], activeTabId: tab.id };
const instance: WorktableInstance = {
  id: 'instance-1', projectId: 'project', title: 'Research', icon: 'flask', kind: 'generated', status: 'idle', revision: 4,
  inputs: { secretLookingInput: 'must-not-cross-bridge' }, layout: { kind: 'pane', paneId: pane.id }, panes: [pane], activePaneId: pane.id, createdAt: now, updatedAt: now,
};

describe('generated app host bridge', () => {
  it('accepts only exact loopback generated-app ticket origins', () => {
    expect(loopbackGeneratedAppOrigin('http://127.0.0.1:43120/generated-apps/ticket/index.html')).toBe('http://127.0.0.1:43120');
    expect(loopbackGeneratedAppOrigin('http://localhost:43120/generated-apps/ticket/index.html')).toBe('http://localhost:43120');
    expect(loopbackGeneratedAppOrigin('http://127.0.0.1:43120/api/snapshot')).toBeUndefined();
    expect(loopbackGeneratedAppOrigin('http://127.0.0.1.evil.test/generated-apps/ticket/index.html')).toBeUndefined();
    expect(loopbackGeneratedAppOrigin('https://127.0.0.1:43120/generated-apps/ticket/index.html')).toBeUndefined();
  });

  it('transfers the port only to the exact validated origin', () => {
    const calls: unknown[][] = [];
    const target = { postMessage: (...args: unknown[]) => calls.push(args) };
    const channel = new MessageChannel();
    connectGeneratedApp(target, 'http://127.0.0.1:43120', 'one-time-token', ['worktable:read'], channel.port2);
    expect(calls).toEqual([[{ type: 'openlab.generated-app.connect', token: 'one-time-token', capabilities: ['worktable:read'] }, 'http://127.0.0.1:43120', [channel.port2]]]);
    channel.port1.close();
    channel.port2.close();
  });

  it('requires the one-time token and bounded structured requests', () => {
    const token = 'one-time-token';
    expect(parseGeneratedAppRequest({ id: '1', token, method: 'worktable.read', params: {} }, token)).toMatchObject({ id: '1', method: 'worktable.read' });
    expect(parseGeneratedAppRequest({ id: '1', token: 'forged', method: 'worktable.read', params: {} }, token)).toBeUndefined();
    expect(parseGeneratedAppRequest({ id: '1', token, method: 'worktable.read', params: [] }, token)).toBeUndefined();
    expect(parseGeneratedAppRequest({ id: '1', token, method: 'worktable.read', params: { data: 'x'.repeat(129 * 1024) } }, token)).toBeUndefined();
  });

  it('maps only declared read/write methods to the approved capability set', () => {
    expect(generatedAppCapabilityForMethod('annotations.create')).toBe('annotations:write');
    expect(generatedAppCapabilityForMethod('workspace.read')).toBeUndefined();
    expect(generatedAppCapabilities({ ...app, hostCapabilities: ['worktable:read', 'workspace:read', 'annotations:write'] })).toEqual(new Set(['worktable:read', 'annotations:write']));
  });

  it('exposes only current pane and immutable revision metadata', () => {
    const worktable = generatedAppWorktableView(app, instance, pane, tab);
    expect(worktable).toMatchObject({ app: { id: app.id, revisionId: revision.id }, instance: { id: instance.id }, pane: { id: pane.id }, tab: { id: tab.id } });
    expect(worktable).not.toHaveProperty('instance.inputs');
    expect(worktable).not.toHaveProperty('instance.boundSessionId');
    const artifact = generatedAppArtifactView(revision);
    expect(artifact).toMatchObject({ id: revision.id, files: [{ name: 'chart.png', sha256: 'a'.repeat(64) }] });
    expect(artifact).not.toHaveProperty('files.0.ref');
    expect(artifact).not.toHaveProperty('files.0.archivedPath');
  });

  it('canonicalizes annotation targets from the current revision and rejects foreign files', () => {
    const accepted = generatedAppAnnotationInput({
      target: { ref: { rootId: 'project', path: 'figures/chart.png' }, sha256: 'a'.repeat(64), artifactId: 'forged' },
      selector: { kind: 'image-rect', x: .1, y: .2, width: .3, height: .4 }, comment: 'Adjust this panel',
    }, revision);
    expect(accepted.target).toEqual({ ref: { rootId: 'project', path: 'figures/chart.png' }, sha256: 'a'.repeat(64), mediaType: 'image/png', artifactId: 'artifact-1', artifactRevisionId: 'revision-1' });
    expect(() => generatedAppAnnotationInput({
      target: { ref: { rootId: 'project', path: '../secret.txt' }, sha256: 'b'.repeat(64) },
      selector: { kind: 'image-point', x: .5, y: .5 }, comment: 'No',
    }, revision)).toThrow(/outside/u);
    expect(() => generatedAppAnnotationInput({
      target: { ref: { rootId: 'project', path: 'figures/chart.png' }, sha256: 'a'.repeat(64) },
      selector: { kind: 'image-rect', x: .9, y: .9, width: .2, height: .2 }, comment: 'No',
    }, revision)).toThrow(/rectangle/u);
  });

  it('filters annotations and research data to the generated app artifact without paths', () => {
    const snapshot = {
      annotations: [{ id: 'annotation-1', projectId: 'project', target: { ref: { rootId: 'project', path: 'figures/chart.png' }, sha256: 'a'.repeat(64) }, selector: { kind: 'image-point', x: .5, y: .5 }, comments: [{ id: 'comment', actor: { id: 'user', kind: 'user' }, content: 'Review', createdAt: now }], status: 'open', sourceEventIds: [], createdAt: now, updatedAt: now },
        { id: 'foreign', projectId: 'project', target: { ref: { rootId: 'project', path: 'secret.txt' }, sha256: 'b'.repeat(64) }, selector: { kind: 'document-anchor', scheme: 'text', anchor: '1' }, comments: [], status: 'open', sourceEventIds: [], createdAt: now, updatedAt: now }],
      researchObjects: [{ id: 'artifact-1', projectId: 'project', type: 'artifact', title: 'Dashboard', status: 'active', attributes: { result: 'ok' }, attachments: [{ id: 'attachment', name: 'chart.png', relativePath: 'absolute-looking/private/path', sha256: 'a'.repeat(64) }], checksum: 'sum', createdBy: { id: 'user', kind: 'user' }, createdAt: now, updatedAt: now }],
      relations: [{ id: 'relation', projectId: 'project', fromId: 'artifact-1', predicate: 'derivedFrom', toId: 'source-1', evidenceIds: [], traceId: 'private-trace', createdBy: { id: 'user', kind: 'user' }, createdAt: now }],
    } as unknown as BootstrapSnapshot;
    const createdView = generatedAppAnnotationView(snapshot.annotations[0]!, revision);
    expect(createdView).not.toHaveProperty('projectId');
    expect(createdView).not.toHaveProperty('target');
    expect(createdView).not.toHaveProperty('sourceEventIds');
    expect(createdView).not.toHaveProperty('comments.0.actor');
    expect(generatedAppAnnotationsView(snapshot, revision)).toHaveLength(1);
    const research = generatedAppResearchView(snapshot, app);
    expect(research).toMatchObject({ object: { id: 'artifact-1', attributeKeys: ['result'], attachments: [{ name: 'chart.png' }] }, relations: [{ id: 'relation' }] });
    expect(research).not.toHaveProperty('object.attributes');
    expect(research).not.toHaveProperty('object.attachments.0.relativePath');
    expect(research).not.toHaveProperty('relations.0.traceId');
  });
});
