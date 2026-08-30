import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginManifest } from '@openlab/protocol';
import { validatePluginManifest } from '../src/extensions/plugin-manifest.js';
import { PluginManager } from '../src/extensions/plugin-manager.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { OpenLabRuntime } from '../src/runtime.js';

const roots: string[] = [];
const OPENED_AT = '1970-01-01T00:00:00.000Z';

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'sci-plugin-v4-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function blueprint() {
  return {
    schemaVersion: 1, id: 'fixture.v4:reader', version: '1.0.0', title: 'Reader', description: 'Evidence reader', kind: 'research',
    inputSchema: { type: 'object', properties: { sourceId: { type: 'string' } }, required: ['sourceId'], additionalProperties: false },
    layout: { kind: 'pane', paneId: 'main' },
    panes: [{
      id: 'main', title: 'Reader', activeTabId: 'reader',
      tabs: [{ id: 'reader', title: 'Reader', content: { kind: 'plugin-panel', pluginId: 'fixture.v4', panelId: 'reader' }, pinned: true, openedAt: OPENED_AT }],
    }],
    slots: [{ id: 'analysis', role: 'analysis', paneId: 'main', title: 'Analysis', accepts: ['artifact'], autoMount: true }],
    commands: ['fixture.v4:run'],
  };
}

function writeFixture(root: string): Record<string, any> {
  writeFileSync(join(root, 'panel.html'), '<!doctype html><title>Reader</title>', 'utf8');
  writeFileSync(join(root, 'index.mjs'), `export default {
    apiVersion: 4,
    tools: [{
      definition: { name: 'probe', title: 'Probe', description: 'Probe v4 host', inputSchema: { type: 'object', additionalProperties: false }, risk: 'read', renderHint: 'generic' },
      async execute(_input, context) {
        const instances = await context.host.workbenches.list();
        return { callId: context.traceId, ok: true, content: String(instances.length), artifactIds: [], metadata: {
          legacyNamesVisible: 'workbench' in context.host || 'worktable' in context.host,
          capabilities: context.host.capabilities,
        } };
      },
    }],
  };`, 'utf8');
  return {
    schemaVersion: 4, apiVersion: 4, id: 'fixture.v4', name: 'Fixture V4', version: '1.0.0', engine: '^0.1.0', entry: 'index.mjs',
    permissions: ['ui', 'workbench:read'],
    contributes: {
      tools: ['probe'], uiPanels: [{ id: 'reader', title: 'Reader', entry: 'panel.html', tools: ['probe'] }],
      workbenchBlueprints: [blueprint()],
    },
  };
}

function validateFixture(root: string, mutate?: (manifest: Record<string, any>) => void): PluginManifest {
  const manifest = writeFixture(root);
  mutate?.(manifest);
  return validatePluginManifest(manifest, root);
}

describe('Plugin API v4 manifest and host boundary', () => {
  it('accepts namespaced WorkbenchBlueprint contributions with role slots', () => {
    const manifest = validateFixture(temporaryDirectory());
    expect(manifest).toMatchObject({ schemaVersion: 4, apiVersion: 4, permissions: ['ui', 'workbench:read'] });
    expect(manifest.contributes.workbenchBlueprints).toEqual([expect.objectContaining({
      id: 'fixture.v4:reader', schemaVersion: 1, slots: [expect.objectContaining({ role: 'analysis', autoMount: true })],
    })]);
  });

  it.each([
    ['requires matching API v4', (manifest: Record<string, any>) => { manifest.apiVersion = 3; }, /schemaVersion 4/u],
    ['requires namespaced blueprint IDs', (manifest: Record<string, any>) => { manifest.contributes.workbenchBlueprints[0].id = 'foreign:reader'; }, /命名空间/u],
    ['requires at least one role slot', (manifest: Record<string, any>) => { manifest.contributes.workbenchBlueprints[0].slots = []; }, /slots 无效/u],
    ['requires unique roles', (manifest: Record<string, any>) => { manifest.contributes.workbenchBlueprints[0].slots.push({ ...manifest.contributes.workbenchBlueprints[0].slots[0], id: 'second' }); }, /role 必须唯一/u],
    ['rejects legacy template contributions', (manifest: Record<string, any>) => { manifest.contributes.worktableTemplates = [blueprint()]; }, /仅支持 Plugin API v3/u],
    ['rejects legacy v3 permission names', (manifest: Record<string, any>) => { manifest.permissions.push('worktable:read'); }, /必须使用 workbench/u],
    ['rejects legacy model permission names', (manifest: Record<string, any>) => { manifest.permissions.push('models:run'); }, /models:invoke/u],
    ['rejects direct project access', (manifest: Record<string, any>) => { manifest.permissions.push('project:read'); }, /宿主代理/u],
    ['rejects direct child processes', (manifest: Record<string, any>) => { manifest.permissions.push('process:spawn'); }, /宿主代理/u],
    ['rejects direct network access', (manifest: Record<string, any>) => { manifest.permissions.push('network'); }, /宿主代理/u],
  ])('%s', (_label, mutate, message) => {
    expect(() => validateFixture(temporaryDirectory(), mutate)).toThrow(message);
  });

  it('runs with only the v4 Workbench host names visible to plugin code', async () => {
    const root = temporaryDirectory();
    const source = join(root, 'source');
    const projectRoot = join(root, 'project');
    mkdirSync(source, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(source, 'manifest.json'), JSON.stringify(writeFixture(source)), 'utf8');
    const methods: string[] = [];
    const manager = new PluginManager({
      userRoot: join(root, 'user-plugins'), projectRoot, projectId: 'project-v4', registry: new ToolRegistry(),
      hostHandler: async (request) => {
        methods.push(request.method);
        if (request.method === 'workbenches.list') return [];
        throw new Error(`unexpected host method: ${request.method}`);
      },
    });
    try {
      await manager.install(source, 'project');
      expect(manager.workbenchBlueprints()).toEqual([expect.objectContaining({ id: 'fixture.v4:reader', pluginId: 'fixture.v4' })]);
      const output = await manager.executePanelTool('fixture.v4', 'probe', {}, { projectId: 'project-v4', sessionId: 'session', agentId: 'agent', traceId: 'trace' });
      expect(output).toMatchObject({ ok: true, metadata: { legacyNamesVisible: false, capabilities: expect.arrayContaining(['workbench:read']) } });
      expect(methods).toEqual(['workbenches.list']);
    } finally {
      await manager.stop();
    }
  }, 20_000);

  it('gates unsigned local installation and launch behind explicit developer mode', async () => {
    const root = temporaryDirectory();
    const source = join(root, 'source');
    const projectRoot = join(root, 'project');
    mkdirSync(source, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(source, 'manifest.json'), JSON.stringify(writeFixture(source)), 'utf8');
    const runtime = new OpenLabRuntime({ host: '127.0.0.1', port: 0, authToken: 'test', projectRoot, home: join(root, '.runtime'), demo: true });
    await runtime.initialize();
    try {
      await expect(runtime.installPlugin(source, 'project')).rejects.toThrow(/开发者模式/u);
      await runtime.setHarnessSettings({ developerMode: true });
      expect(await runtime.installPlugin(source, 'project')).toMatchObject({ manifest: { id: 'fixture.v4', apiVersion: 4 }, enabled: true, trusted: false });
      expect(runtime.plugins.list().find((plugin) => plugin.manifest.id === 'fixture.v4')?.enabled).toBe(true);
      await runtime.setHarnessSettings({ developerMode: false });
      expect(runtime.plugins.list().find((plugin) => plugin.manifest.id === 'fixture.v4')?.enabled).toBe(false);
    } finally {
      await runtime.stop();
    }
  }, 20_000);
});
