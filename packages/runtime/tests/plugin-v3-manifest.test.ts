import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginManifest } from '@openlab/protocol';
import { validatePluginManifest } from '../src/extensions/plugin-manifest.js';
import { PluginManager } from '../src/extensions/plugin-manager.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';

const directories: string[] = [];
const OPENED_AT = '1970-01-01T00:00:00.000Z';

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'openlab-plugin-v3-'));
  directories.push(root);
  return root;
}

afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function v3Template() {
  return {
    id: 'fixture.v3:reader', version: '1.2.0', title: 'Reader', description: 'Two-pane reader', icon: 'book-open', kind: 'research',
    inputSchema: {
      type: 'object',
      properties: { sourceId: { type: 'string' } },
      required: ['sourceId'],
      additionalProperties: false,
    },
    layout: { kind: 'split', direction: 'horizontal', ratio: 0.32, first: { kind: 'pane', paneId: 'sources' }, second: { kind: 'pane', paneId: 'reading' } },
    panes: [
      {
        id: 'sources', title: 'Sources', activeTabId: 'files',
        tabs: [{ id: 'files', title: 'Files', content: { kind: 'builtin', type: 'explorer' }, pinned: true, openedAt: OPENED_AT }],
      },
      {
        id: 'reading', title: 'Reading', activeTabId: 'reader',
        tabs: [
          { id: 'reader', title: 'Reader', content: { kind: 'plugin-panel', pluginId: 'fixture.v3', panelId: 'reader' }, pinned: true, openedAt: OPENED_AT },
          { id: 'tasks', title: 'Tasks', content: { kind: 'builtin', type: 'tasks' }, openedAt: OPENED_AT },
        ],
      },
    ],
    commands: ['run'],
  };
}

function writeV3Fixture(root: string): Record<string, unknown> {
  writeFileSync(join(root, 'panel.html'), '<!doctype html><title>Reader</title>', 'utf8');
  writeFileSync(join(root, 'index.mjs'), `export default {
    apiVersion: 3,
    tools: [{
      definition: { name: 'probe', title: 'Probe', description: 'Probe v3 host', inputSchema: { type: 'object', additionalProperties: false }, risk: 'read', renderHint: 'generic' },
      async execute(_input, context) {
        const state = await context.host.worktable.list();
        return { callId: context.traceId, ok: true, content: context.projectId + ':' + state.instances.length, artifactIds: [], metadata: { capabilities: context.host.capabilities } };
      },
    }],
    workflows: [{
      definition: { id: 'fixture.v3.workflow', title: 'Fixture workflow', description: 'Run a v3 workflow.', inputSchema: { type: 'object', additionalProperties: false } },
      async run(_input, context) { return { artifactIds: [], metadata: { projectId: context.projectId, resumed: context.resume } }; },
    }],
  };`, 'utf8');
  return {
    schemaVersion: 3, apiVersion: 3, id: 'fixture.v3', name: 'Fixture V3', version: '1.0.0', engine: '^0.1.0', entry: 'index.mjs',
    permissions: ['ui', 'worktable:read', 'worktable:write', 'jobs:run', 'browser:observe', 'generated-apps:publish'],
    contributes: {
      tools: ['probe'], contextProviders: [], agentTemplates: [], agentPresets: [], researchObjectTypes: [], researchRelationTypes: [],
      uiPanels: [{ id: 'reader', title: 'Reader', entry: 'panel.html', tools: ['probe'] }],
      worktableTemplates: [v3Template()],
    },
  };
}

function validateFixture(root: string, mutate?: (manifest: Record<string, any>) => void): PluginManifest {
  const manifest = writeV3Fixture(root) as Record<string, any>;
  mutate?.(manifest);
  return validatePluginManifest(manifest, root);
}

describe('Plugin API v3 manifest and worktable compatibility', () => {
  it('accepts schema/API v3, the new permissions, and a closed two-pane layout', () => {
    const manifest = validateFixture(temporaryDirectory());
    expect(manifest).toMatchObject({ schemaVersion: 3, apiVersion: 3, permissions: expect.arrayContaining(['worktable:read', 'browser:observe', 'generated-apps:publish']) });
    expect(manifest.contributes.worktableTemplates).toEqual([expect.objectContaining({
      id: 'fixture.v3:reader', version: '1.2.0', inputSchema: expect.objectContaining({ type: 'object' }),
      layout: expect.objectContaining({ kind: 'split' }), panes: expect.arrayContaining([expect.objectContaining({ id: 'reading', activeTabId: 'reader' })]),
    })]);
  });

  it.each([
    ['requires matching schema/API versions', (manifest: Record<string, any>) => { manifest.apiVersion = 2; }, /schemaVersion 3/u],
    ['requires a namespaced template ID', (manifest: Record<string, any>) => { manifest.contributes.worktableTemplates[0].id = 'foreign:reader'; }, /命名空间/u],
    ['requires a semantic template version', (manifest: Record<string, any>) => { manifest.contributes.worktableTemplates[0].version = 'latest'; }, /version.*语义化/u],
    ['requires an object input schema', (manifest: Record<string, any>) => { manifest.contributes.worktableTemplates[0].inputSchema = { type: 'string' }; }, /inputSchema.*JSON 对象/u],
    ['rejects an invalid input schema', (manifest: Record<string, any>) => { manifest.contributes.worktableTemplates[0].inputSchema = { type: 'object', required: 'sourceId' }; }, /inputSchema 无效/u],
    ['rejects foreign plugin panels', (manifest: Record<string, any>) => { manifest.contributes.worktableTemplates[0].panes[1].tabs[0].content.pluginId = 'foreign.plugin'; }, /本插件 uiPanel/u],
    ['rejects missing plugin panels', (manifest: Record<string, any>) => { manifest.contributes.worktableTemplates[0].panes[1].tabs[0].content.panelId = 'missing'; }, /本插件 uiPanel/u],
    ['requires active tabs to belong to their pane', (manifest: Record<string, any>) => { manifest.contributes.worktableTemplates[0].panes[0].activeTabId = 'reader'; }, /活动标签/u],
    ['rejects undeclared layout leaves', (manifest: Record<string, any>) => { manifest.contributes.worktableTemplates[0].layout.first.paneId = 'missing'; }, /布局窗格引用/u],
    ['requires every pane in the layout', (manifest: Record<string, any>) => { manifest.contributes.worktableTemplates[0].layout = { kind: 'pane', paneId: 'sources' }; }, /引用全部窗格/u],
    ['uses the runtime split-ratio bounds', (manifest: Record<string, any>) => { manifest.contributes.worktableTemplates[0].layout.ratio = 0.05; }, /分割节点/u],
    ['limits templates to six panes', (manifest: Record<string, any>) => {
      const template = manifest.contributes.worktableTemplates[0];
      template.panes = Array.from({ length: 7 }, (_, index) => ({ id: `pane-${index}`, tabs: [{ id: `tab-${index}`, title: 'Tab', content: { kind: 'builtin', type: 'explorer' }, openedAt: OPENED_AT }] }));
    }, /1–6 个窗格/u],
    ['limits templates to twenty tabs', (manifest: Record<string, any>) => {
      const template = manifest.contributes.worktableTemplates[0];
      template.panes = [{ id: 'only-pane', tabs: Array.from({ length: 21 }, (_, index) => ({ id: `tab-${index}`, title: 'Tab', content: { kind: 'builtin', type: 'explorer' }, openedAt: OPENED_AT })) }];
      template.layout = { kind: 'pane', paneId: 'only-pane' };
    }, /不得超过 20/u],
  ])('%s', (_label, mutate, message) => {
    expect(() => validateFixture(temporaryDirectory(), mutate)).toThrow(message);
  });

  it('does not widen legacy API permissions while keeping v1/v2 manifests valid', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'index.mjs'), 'export default { apiVersion: 2, tools: [] };', 'utf8');
    const legacyV2 = {
      schemaVersion: 2, apiVersion: 2, id: 'fixture.v2', name: 'Fixture V2', version: '1.0.0', engine: '^0.1.0', entry: 'index.mjs', permissions: [], contributes: { tools: [] },
    };
    expect(validatePluginManifest(legacyV2, root)).toMatchObject({ schemaVersion: 2, apiVersion: 2 });
    expect(() => validatePluginManifest({ ...legacyV2, permissions: ['worktable:read'] }, root)).toThrow(/仅支持 Plugin API v3/u);
    expect(validatePluginManifest({ ...legacyV2, schemaVersion: 1, apiVersion: 1 }, root)).toMatchObject({ schemaVersion: 1, apiVersion: 1 });
  });

  it('runs API v3 with the host bridge and exposes native plus mapped legacy templates', async () => {
    const root = temporaryDirectory();
    const projectRoot = join(root, 'project');
    mkdirSync(projectRoot, { recursive: true });
    const v3Source = join(root, 'v3-source');
    mkdirSync(v3Source);
    writeFileSync(join(v3Source, 'manifest.json'), JSON.stringify(writeV3Fixture(v3Source)), 'utf8');

    const legacySource = join(root, 'legacy-source');
    mkdirSync(legacySource);
    writeFileSync(join(legacySource, 'panel.html'), '<!doctype html><title>Legacy</title>', 'utf8');
    writeFileSync(join(legacySource, 'index.mjs'), 'export default { apiVersion: 2, tools: [] };', 'utf8');
    writeFileSync(join(legacySource, 'manifest.json'), JSON.stringify({
      schemaVersion: 2, apiVersion: 2, id: 'fixture.legacy', name: 'Legacy', version: '1.0.0', engine: '^0.1.0', entry: 'index.mjs', permissions: ['ui'],
      contributes: {
        tools: [], uiPanels: [{ id: 'legacy-panel', title: 'Legacy', entry: 'panel.html', tools: [] }],
        workbenches: [{
          id: 'fixture.legacy:reader', title: 'Legacy reader', accepts: { mediaTypes: ['application/pdf'] },
          views: [{ id: 'custom', title: 'Custom', kind: 'custom', panelId: 'legacy-panel' }, { id: 'jobs', title: 'Jobs', kind: 'jobs' }], commands: [],
        }],
      },
    }), 'utf8');

    let bridgedCapabilities: string[] = [];
    const manager = new PluginManager({
      userRoot: join(root, 'user-plugins'), projectRoot, projectId: 'project-v3', registry: new ToolRegistry(),
      hostHandler: async (request) => {
        if (request.method !== 'worktable.list') throw new Error(`unexpected host method: ${request.method}`);
        bridgedCapabilities = request.context.capabilities;
        return { instances: [] };
      },
    });
    try {
      await manager.install(v3Source, 'project');
      await manager.install(legacySource, 'project');
      expect(manager.worktableTemplates()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'fixture.v3:reader', pluginId: 'fixture.v3' }),
        expect.objectContaining({
          id: 'fixture.legacy:reader', pluginId: 'fixture.legacy',
          panes: [expect.objectContaining({ tabs: [
            expect.objectContaining({ content: { kind: 'plugin-panel', pluginId: 'fixture.legacy', panelId: 'legacy-panel' } }),
            expect.objectContaining({ content: { kind: 'builtin', type: 'tasks' } }),
          ] })],
        }),
      ]));
      const output = await manager.executePanelTool('fixture.v3', 'probe', {}, { projectId: 'project-v3', sessionId: 'session', agentId: 'agent', traceId: 'trace' });
      expect(output).toMatchObject({ ok: true, content: 'project-v3:0', metadata: { capabilities: expect.arrayContaining(['worktable:read', 'worktable:write', 'browser:observe', 'generated-apps:publish']) } });
      expect(bridgedCapabilities).toEqual(expect.arrayContaining(['worktable:read', 'worktable:write', 'browser:observe', 'generated-apps:publish']));
      expect(manager.workflows('fixture.v3')).toEqual([expect.objectContaining({ definition: expect.objectContaining({ id: 'fixture.v3.workflow' }) })]);
      await expect(manager.executeWorkflow('fixture.v3', 'fixture.v3.workflow', {}, {
        projectId: 'project-v3', sessionId: 'session', agentId: 'agent', traceId: 'trace', capabilities: ['jobs:run'],
      }, 'job-v3', false)).resolves.toEqual({ artifactIds: [], metadata: { projectId: 'project-v3', resumed: false } });
    } finally {
      await manager.stop();
    }
  }, 30_000);
});
