import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { SqliteEventStore } from '../src/events/event-store.js';
import { ResearchStore } from '../src/research/research-store.js';
import { ChangeSetStore } from '../src/tools/change-set-store.js';
import { PathGuard } from '../src/security/path-guard.js';
import { SkillManager } from '../src/extensions/skills.js';
import { scaffoldPlugin, testScaffoldedPlugin } from '../src/extensions/plugin-scaffolder.js';
import { PluginManager } from '../src/extensions/plugin-manager.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { registerCoreTools } from '../src/tools/core-tools.js';
import { ContextPins } from '../src/context/pins.js';
import { spawnWithResourceLimits } from '../src/security/windows-job-host.js';

const temporaryDirectories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'openlab-project-'));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function tarField(buffer: Buffer, offset: number, length: number, value: string): void {
  buffer.write(value.slice(0, length), offset, length, 'ascii');
}

function tarArchive(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, source] of Object.entries(files)) {
    const content = Buffer.from(source, 'utf8');
    const header = Buffer.alloc(512);
    tarField(header, 0, 100, name);
    tarField(header, 100, 8, '0000644\0');
    tarField(header, 108, 8, '0000000\0');
    tarField(header, 116, 8, '0000000\0');
    tarField(header, 124, 12, `${content.length.toString(8).padStart(11, '0')}\0`);
    tarField(header, 136, 12, '00000000000\0');
    tarField(header, 148, 8, '        ');
    tarField(header, 156, 1, '0');
    tarField(header, 257, 6, 'ustar\0');
    tarField(header, 263, 2, '00');
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    tarField(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1_024));
  return gzipSync(Buffer.concat(blocks));
}

describe('project services', () => {
  it('validates every tool input against its registered JSON Schema before execution', async () => {
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register({
      definition: {
        name: 'schema_probe', title: 'Schema probe', description: 'Schema validation fixture',
        inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false },
        risk: 'read', renderHint: 'generic', source: 'core',
      },
      async execute(_input, context) {
        executions += 1;
        return { callId: context.callId, ok: true, content: 'validated', artifactIds: [], metadata: {} };
      },
    });
    const context = { projectRoot: temporaryDirectory(), sessionId: 'session', agentId: 'agent', traceId: 'trace', callId: 'call', signal: new AbortController().signal } as never;
    await expect(registry.require('schema_probe').execute({}, context)).rejects.toThrow(/参数不合法/u);
    await expect(registry.require('schema_probe').execute({ path: '', extra: true }, context)).rejects.toThrow(/参数不合法/u);
    expect(executions).toBe(0);
    await expect(registry.require('schema_probe').execute({ path: 'notes.md' }, context)).resolves.toMatchObject({ content: 'validated' });
    expect(executions).toBe(1);
  });

  it('blocks workspace traversal and supports diff-backed write, delete, and undo', () => {
    const root = temporaryDirectory();
    const events = new SqliteEventStore(join(root, 'runtime.db'));
    const changes = new ChangeSetStore({ projectId: 'project', projectRoot: root, snapshotRoot: join(root, 'snapshots'), events });
    const guard = new PathGuard(root);
    expect(() => guard.resolveForWrite('..\\outside.txt')).toThrow(/工作区之外/);
    writeFileSync(join(root, 'notes.txt'), 'before', 'utf8');
    const change = changes.write('notes.txt', 'after', { id: 'agent', kind: 'agent' }, 'agent', 'trace');
    expect(change.diff).toContain('-before');
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('after');
    writeFileSync(join(root, 'snapshots', 'project', 'changes.json'), '{corrupted projection', 'utf8');
    expect(new ChangeSetStore({ projectId: 'project', projectRoot: root, snapshotRoot: join(root, 'snapshots'), events }).list()).toHaveLength(1);
    writeFileSync(join(root, 'snapshots', 'project', 'changes.json'), JSON.stringify({ structurally: 'invalid' }), 'utf8');
    const rebuilt = new ChangeSetStore({ projectId: 'project', projectRoot: root, snapshotRoot: join(root, 'snapshots'), events });
    rebuilt.undo(change.id, { id: 'agent', kind: 'agent' }, 'agent', 'trace-undo');
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('before');
    expect(rebuilt.previewDelete('notes.txt')).toContain('-before');
    const deletion = rebuilt.delete('notes.txt', { id: 'agent', kind: 'agent' }, 'agent', 'trace-delete');
    expect(deletion.afterHash).toBeNull();
    expect(existsSync(join(root, 'notes.txt'))).toBe(false);
    const afterDeleteRestart = new ChangeSetStore({ projectId: 'project', projectRoot: root, snapshotRoot: join(root, 'snapshots'), events });
    expect(afterDeleteRestart.list()).toHaveLength(2);
    afterDeleteRestart.undo(deletion.id, { id: 'agent', kind: 'agent' }, 'agent', 'trace-restore');
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('before');
    const conflictingDeletion = afterDeleteRestart.delete('notes.txt', { id: 'agent', kind: 'agent' }, 'agent', 'trace-delete-2');
    writeFileSync(join(root, 'notes.txt'), 'newer file', 'utf8');
    expect(() => afterDeleteRestart.undo(conflictingDeletion.id, { id: 'agent', kind: 'agent' }, 'agent', 'trace-conflict')).toThrow(/重新创建/u);
    events.close();
  });

  it('persists research objects, relations and artifact provenance', () => {
    const root = temporaryDirectory();
    const events = new SqliteEventStore(join(root, 'runtime.db'));
    const research = new ResearchStore({ projectId: 'project', projectRoot: root, events });
    const actor = { id: 'agent', kind: 'agent' as const };
    const dataset = research.createObject({ type: 'dataset', title: 'Dataset A' }, actor, 'trace-1');
    const evidence = research.createObject({ type: 'evidence', title: 'Evidence A' }, actor, 'trace-2');
    expect(dataset.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(research.updateObject(dataset.id, { status: 'archived' }, actor, 'trace-update').checksum).not.toBe(dataset.checksum);
    research.createRelation({ fromId: evidence.id, predicate: 'supports', toId: dataset.id }, actor, 'trace-3');
    writeFileSync(join(root, 'report.md'), '# report', 'utf8');
    const artifact = research.registerArtifact({
      relativePath: 'report.md',
      provenance: { traceId: 'trace-4', sessionId: 'session', agentId: 'agent', inputObjectIds: [dataset.id], inputFileHashes: {} },
    }, actor);
    expect(research.listObjects()).toHaveLength(3);
    expect(research.listRelations()[0]?.predicate).toBe('supports');
    expect(artifact.object.attachments[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(research.listProvenance()[0]?.inputObjectIds).toEqual([dataset.id]);
    const projectionPath = join(root, '.openlab', 'research.json');
    const projected = JSON.parse(readFileSync(projectionPath, 'utf8')) as { objects: unknown[]; relations: unknown[] };
    const recoveryTime = new Date(Date.now() + 1_000).toISOString();
    const recoveredObject = {
      id: 'projection-leading-object', projectId: 'project', type: 'source', title: 'Projection-leading source', status: 'active',
      attributes: {}, attachments: [], checksum: 'a'.repeat(64), createdBy: actor, createdAt: recoveryTime, updatedAt: recoveryTime,
    };
    const recoveredRelation = {
      id: 'projection-leading-relation', projectId: 'project', fromId: recoveredObject.id, predicate: 'supports', toId: dataset.id,
      evidenceIds: [], traceId: 'trace-recovered-relation', createdBy: actor, createdAt: recoveryTime,
    };
    projected.objects.push(recoveredObject);
    projected.relations.push(recoveredRelation);
    writeFileSync(projectionPath, JSON.stringify(projected), 'utf8');
    const provenancePath = join(root, '.openlab', 'provenance.jsonl');
    const recoveredProvenance = {
      artifactId: 'projection-leading-artifact', traceId: 'trace-recovered-provenance', sessionId: 'session', agentId: 'agent',
      inputObjectIds: [recoveredObject.id], inputFileHashes: {}, createdAt: recoveryTime,
    };
    writeFileSync(provenancePath, `${readFileSync(provenancePath, 'utf8')}${JSON.stringify(recoveredProvenance)}\n`, 'utf8');
    const reconciled = new ResearchStore({ projectId: 'project', projectRoot: root, events });
    expect(reconciled.listObjects()).toHaveLength(4);
    expect(reconciled.listRelations()).toHaveLength(2);
    expect(reconciled.listProvenance()).toHaveLength(2);
    expect(events.list('project:project').map((event) => event.kind)).toEqual(expect.arrayContaining([
      'research_object.imported', 'research_object.relation_imported', 'artifact.provenance_imported',
    ]));
    writeFileSync(join(root, '.openlab', 'research.json'), '{corrupted projection', 'utf8');
    writeFileSync(join(root, '.openlab', 'provenance.jsonl'), '{corrupted projection\n', 'utf8');
    const rebuilt = new ResearchStore({ projectId: 'project', projectRoot: root, events });
    expect(rebuilt.listObjects()).toHaveLength(4);
    expect(rebuilt.listRelations()).toHaveLength(2);
    expect(rebuilt.listProvenance()).toHaveLength(2);
    writeFileSync(join(root, '.openlab', 'research.json'), JSON.stringify({ schemaVersion: 1, objects: [null, { id: 'incomplete' }], relations: 'invalid' }), 'utf8');
    expect(new ResearchStore({ projectId: 'project', projectRoot: root, events }).listObjects()).toHaveLength(4);
    events.close();
  });

  it('scaffolds project Skills and tests generated plugins in a restricted process', async () => {
    const root = temporaryDirectory();
    const skills = new SkillManager({ userRoot: join(root, '.user-skills'), projectRoot: root });
    const skill = skills.scaffoldProject({ id: 'genomics', name: 'Genomics', description: 'Genome workflow', instructions: 'Keep sample provenance.' });
    expect(skill.name).toBe('Genomics');
    expect(skills.load(skill.id).content).toContain('sample provenance');
    const plugin = scaffoldPlugin(root, { id: 'demo.plugin', name: 'Demo Plugin', description: 'Echo test' });
    expect(plugin.files).toEqual(expect.arrayContaining(['src/index.ts', 'types/openlab-plugin.d.ts', 'package.json', 'tsconfig.json']));
    await expect(testScaffoldedPlugin(plugin.root, new AbortController().signal)).resolves.toMatch(/typecheck: ok[\s\S]*contract: ok/u);
    writeFileSync(join(plugin.root, '.npmrc'), '//registry.example/:_authToken=must-not-be-copied', 'utf8');
    const registry = new ToolRegistry();
    const plugins = new PluginManager({ userRoot: join(root, '.user-plugins'), projectRoot: root, registry });
    expect(plugins.inspectSource(plugin.root).package.packageManagerConfigurationIgnored).toBe(true);
    await plugins.install(plugin.root, 'project');
    expect(existsSync(join(root, '.openlab', 'plugins', 'demo.plugin', '.npmrc'))).toBe(false);
    await expect(registry.require('plugin__demo_plugin__describe_research_input').execute(
      { text: 'sample' },
      { projectRoot: root, sessionId: 'session', agentId: 'agent', traceId: 'trace', callId: 'call', signal: new AbortController().signal } as never,
    )).resolves.toMatchObject({ content: 'sample' });
    await plugins.stop();
  }, 15_000);

  it('installs declared plugin dependencies from a registry without running lifecycle scripts', async () => {
    const root = temporaryDirectory();
    const plugin = scaffoldPlugin(root, { id: 'dependency.plugin', name: 'Dependency Plugin', description: 'Dependency test' });
    const dependencyName = 'openlab-fixture-dependency';
    const tarball = tarArchive({
      'package/package.json': JSON.stringify({ name: dependencyName, version: '1.0.0', type: 'module', main: 'index.js', types: 'index.d.ts' }),
      'package/index.js': "export const fixtureValue = (value) => `fixture:${value}`;\n",
      'package/index.d.ts': 'export declare const fixtureValue: (value: string) => string;\n',
    });
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    const marker = join(root, 'lifecycle-ran.txt');
    const packagePath = join(plugin.root, 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
    packageJson.dependencies = { [dependencyName]: '1.0.0' };
    packageJson.scripts = { preinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')"` };
    writeFileSync(packagePath, JSON.stringify(packageJson), 'utf8');
    const entryPath = join(plugin.root, 'src', 'index.ts');
    writeFileSync(entryPath, `${readFileSync(entryPath, 'utf8').replace("import type { OpenLabPlugin } from '@openlab/plugin-sdk';", "import type { OpenLabPlugin } from '@openlab/plugin-sdk';\nimport { fixtureValue } from 'openlab-fixture-dependency';").replace('content: String(input.text)', 'content: fixtureValue(String(input.text))')}`, 'utf8');

    const server = createServer((request, response) => {
      const address = server.address();
      const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
      if (request.url === `/${dependencyName}`) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          name: dependencyName,
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: dependencyName, version: '1.0.0', type: 'module', main: 'index.js', types: 'index.d.ts',
              dist: { tarball: `${base}/${dependencyName}/-/${dependencyName}-1.0.0.tgz`, integrity },
            },
          },
        }));
        return;
      }
      if (request.url === `/${dependencyName}/-/${dependencyName}-1.0.0.tgz`) {
        response.setHeader('content-type', 'application/octet-stream');
        response.end(tarball);
        return;
      }
      response.statusCode = 404;
      response.end('not found');
    });
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    try {
      const address = server.address();
      if (typeof address !== 'object' || !address) throw new Error('fixture registry did not start');
      const output = await testScaffoldedPlugin(plugin.root, new AbortController().signal, {
        registry: `http://127.0.0.1:${address.port}`,
        cacheRoot: join(root, 'package-cache'),
      });
      expect(output).toMatch(/dependencies: 1[\s\S]*typecheck: ok[\s\S]*runtime contract: ok/u);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(plugin.root, 'node_modules'))).toBe(false);
    } finally {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    }
  }, 30_000);

  it('rejects vendored modules, local dependency protocols, and unsafe archive paths', () => {
    const root = temporaryDirectory();
    const plugin = scaffoldPlugin(root, { id: 'unsafe.plugin', name: 'Unsafe Plugin', description: 'Unsafe fixture' });
    const manager = new PluginManager({ userRoot: join(root, '.user-plugins'), projectRoot: root, registry: new ToolRegistry() });
    mkdirSync(join(plugin.root, 'node_modules', 'vendored'), { recursive: true });
    writeFileSync(join(plugin.root, 'node_modules', 'vendored', 'index.js'), 'export default true', 'utf8');
    expect(() => manager.inspectSource(plugin.root)).toThrow(/不得携带 node_modules/u);
    rmSync(join(plugin.root, 'node_modules'), { recursive: true, force: true });
    const packagePath = join(plugin.root, 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
    packageJson.dependencies = { unsafe: 'file:../../outside' };
    writeFileSync(packagePath, JSON.stringify(packageJson), 'utf8');
    expect(() => manager.inspectSource(plugin.root)).toThrow(/不允许的本地路径/u);

    const zipPath = join(root, 'unsafe.zip');
    const zip = new AdmZip();
    zip.addFile('unsafe.plugin/manifest.json', Buffer.from(readFileSync(join(plugin.root, 'manifest.json'))));
    zip.addFile('unsafe.plugin/src/index.ts', Buffer.from(readFileSync(join(plugin.root, 'src', 'index.ts'))));
    zip.addFile('unsafe.plugin/CON', Buffer.from('reserved'));
    zip.writeZip(zipPath);
    expect(() => manager.inspectSource(zipPath)).toThrow(/Windows 保留路径/u);
  });

  it('installs directory and nested-ZIP Skills transactionally, and rolls back malformed packages', () => {
    const root = temporaryDirectory();
    const sources = join(root, 'skill-sources');
    const directorySource = join(sources, 'directory-skill');
    mkdirSync(directorySource, { recursive: true });
    writeFileSync(join(directorySource, 'SKILL.md'), '---\nid: directory-skill\nname: Directory Skill\ndescription: local workflow\n---\nRun locally.\n', 'utf8');
    const manager = new SkillManager({ userRoot: join(root, '.user-skills'), projectRoot: root });
    expect(manager.install(directorySource, 'project')).toEqual([expect.objectContaining({ id: 'directory-skill', scope: 'project' })]);

    const zipPath = join(sources, 'nested-skill.zip');
    const zip = new AdmZip();
    zip.addFile('package/SKILL.md', Buffer.from('---\nid: nested-skill\nname: Nested Skill\ndescription: zipped workflow\n---\nUse the ZIP.\n'));
    zip.writeZip(zipPath);
    expect(manager.install(zipPath, 'user')).toEqual([expect.objectContaining({ id: 'nested-skill', scope: 'user' })]);

    const invalidSource = join(sources, 'invalid-skill');
    mkdirSync(invalidSource, { recursive: true });
    writeFileSync(join(invalidSource, 'SKILL.md'), '---\nid: invalid-skill\nreferences: [../escape.md]\n---\nInvalid.\n', 'utf8');
    expect(() => manager.install(invalidSource, 'project')).toThrow(/校验失败/u);
    expect(existsSync(join(root, '.openlab', 'skills', 'invalid-skill'))).toBe(false);
    expect(manager.list().map((skill) => skill.id).sort()).toEqual(['directory-skill', 'nested-skill']);
  });

  it('pins and unpins context through the audited core-tool surface', async () => {
    const root = temporaryDirectory();
    const events = new SqliteEventStore(join(root, 'runtime.db'));
    const registry = new ToolRegistry();
    const pins = new ContextPins({ projectRoot: root, projectId: 'project', events });
    const dispose = registerCoreTools({
      registry, projectRoot: root, projectId: 'project', pins,
      changes: new ChangeSetStore({ projectId: 'project', projectRoot: root, snapshotRoot: join(root, 'snapshots'), events }),
      research: new ResearchStore({ projectId: 'project', projectRoot: root, events }),
    });
    const context = { projectRoot: root, sessionId: 'session', agentId: 'agent', traceId: 'trace', callId: 'call', signal: new AbortController().signal } as never;
    await registry.require('pin_context').execute({ label: 'Evidence set', content: 'Pinned evidence', sourceRefs: ['evidence-1'] }, context);
    const pin = pins.list()[0];
    expect(pin).toMatchObject({ label: 'Evidence set', trust: 'untrusted' });
    writeFileSync(join(root, '.openlab', 'context-pins.json'), '{corrupted projection', 'utf8');
    expect(new ContextPins({ projectRoot: root, projectId: 'project', events }).list()).toEqual([expect.objectContaining({ id: pin?.id, label: 'Evidence set' })]);
    writeFileSync(join(root, '.openlab', 'context-pins.json'), JSON.stringify({ structurally: 'invalid' }), 'utf8');
    expect(new ContextPins({ projectRoot: root, projectId: 'project', events }).list()).toHaveLength(1);
    await expect(registry.require('unpin_context').execute({ id: `pin:${pin?.id}` }, context)).resolves.toMatchObject({ content: '已解除固定：Evidence set' });
    expect(pins.list()).toHaveLength(0);
    expect(events.list('project:project').map((event) => event.kind)).toEqual(expect.arrayContaining(['context.pinned', 'context.unpinned']));
    dispose();
    events.close();
  });

  it('loads bounded Skill reference files and ignores a Skill whose reference escapes its directory', () => {
    const root = temporaryDirectory();
    const skillRoot = join(root, '.openlab', 'skills', 'referenced');
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(join(skillRoot, 'guide.md'), 'Reference evidence checklist.', 'utf8');
    writeFileSync(join(skillRoot, 'SKILL.md'), `---\nid: referenced\nname: Referenced Skill\ndescription: evidence workflow\nallowed-tools: [read_file]\nreferences: [guide.md]\n---\nUse the checklist.\n`, 'utf8');
    const manager = new SkillManager({ userRoot: join(root, '.user-skills'), projectRoot: root });
    expect(manager.list()[0]).toMatchObject({ id: 'referenced', references: ['guide.md'], allowedTools: ['read_file'] });
    expect(manager.load('referenced').content).toContain('<skill-reference path="guide.md">');
    expect(manager.load('referenced').content).toContain('Reference evidence checklist.');
    expect(manager.match('run the evidence workflow')).toHaveLength(1);

    const invalidRoot = join(root, '.openlab', 'skills', 'invalid');
    mkdirSync(invalidRoot, { recursive: true });
    writeFileSync(join(root, '.openlab', 'skills', 'outside.md'), 'outside', 'utf8');
    writeFileSync(join(invalidRoot, 'SKILL.md'), `---\nid: invalid\nname: Invalid\nreferences: [../outside.md]\n---\nDo not load.\n`, 'utf8');
    manager.refresh();
    expect(manager.list().some((skill) => skill.id === 'invalid')).toBe(false);
  });

  it('activates plugins in the job host and serves panels with a restrictive iframe policy', async () => {
    const root = temporaryDirectory();
    const pluginRoot = join(root, '.openlab', 'plugins', 'demo.ui');
    mkdirSync(pluginRoot, { recursive: true });
    const pluginSource = (version: string) => `export default {
      apiVersion: 1,
      tools: [{ definition: { name: 'ping', title: 'Ping', description: 'Ping', inputSchema: { type: 'object', additionalProperties: false }, risk: 'read', renderHint: 'generic' }, async execute(_input, context) { return { callId: context.traceId, ok: true, content: '${version}:' + String(context.settings.mode ?? 'none'), artifactIds: [], metadata: {} }; } }],
      context(input) { return [{ id: 'demo-context', label: 'Demo context', category: 'plugin', priority: 1, content: String(input.settings.mode ?? 'none'), trust: 'trusted', sourceRefs: [], cache: 'dynamic' }]; },
      agentTemplates: [{ id: 'demo.ui:analyst', name: 'Plugin Analyst', summary: 'Analyze one explicit input.', avatar: 'ocean', identity: '# {{agentName}}', instructions: 'Analyze without creating Agents.', source: 'plugin' }],
      agentPresets: [{ id: 'demo.ui:reviewer', name: 'Plugin Reviewer', role: 'worker', instructions: 'Review one item.', model: 'deepseek-v4-flash', thinking: 'disabled', reasoningEffort: 'low', toolNames: ['ping'], skillIds: [], permissionMode: 'read_only', contextBudget: 32000 }]
    };`;
    writeFileSync(join(pluginRoot, 'index.mjs'), pluginSource('v1'), 'utf8');
    writeFileSync(join(pluginRoot, 'panel.html'), '<html><head><title>Panel</title></head><body><script>parent.postMessage({type:"openlab:panel-ready"}, "*")</script></body></html>', 'utf8');
    writeFileSync(join(pluginRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, id: 'demo.ui', name: 'Demo UI', version: '1.0.0', engine: '^0.1.0', entry: 'index.mjs', permissions: ['ui', 'settings:read'],
      contributes: {
        tools: ['ping'], contextProviders: ['demo.ui:context'], agentTemplates: ['demo.ui:analyst'], agentPresets: ['demo.ui:reviewer'],
        researchObjectTypes: ['demo.ui:sample'], researchRelationTypes: ['demo.ui:validates'],
        settingsSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['fast', 'careful'] } }, required: ['mode'], additionalProperties: false },
        toolCards: [{ tool: 'ping', renderHint: 'artifact' }],
        uiPanels: [{ id: 'overview', title: 'Overview', entry: 'panel.html' }],
      },
    }), 'utf8');
    writeFileSync(join(root, '.openlab', 'plugin-state.json'), JSON.stringify({ 'demo.ui': true }), 'utf8');
    const registry = new ToolRegistry();
    const manager = new PluginManager({ userRoot: join(root, '.user-plugins'), projectRoot: root, registry });
    await manager.activate('demo.ui');
    const execute = async () => await registry.require('plugin__demo_ui__ping').execute({}, { projectRoot: root, sessionId: 'session', agentId: 'agent', traceId: 'trace', callId: 'call', signal: new AbortController().signal });
    await expect(execute()).resolves.toMatchObject({ content: 'v1:none' });
    expect(registry.require('plugin__demo_ui__ping').definition.renderHint).toBe('artifact');
    expect(manager.agentPresets()[0]).toMatchObject({ id: 'demo.ui:reviewer', toolNames: ['plugin__demo_ui__ping'] });
    expect(manager.agentTemplates()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'demo.ui:analyst', source: 'plugin', sourceId: 'demo.ui' }),
      expect.objectContaining({ id: 'demo.ui:reviewer', source: 'plugin', sourceId: 'demo.ui' }),
    ]));
    expect(manager.researchObjectTypes()).toEqual(['demo.ui:sample']);
    expect(manager.researchRelationTypes()).toEqual(['demo.ui:validates']);
    await manager.updateSettings('demo.ui', { mode: 'fast' });
    await expect(execute()).resolves.toMatchObject({ content: 'v1:fast' });
    expect((await manager.collectContext('session', 'agent'))[0]).toMatchObject({ content: 'fast', trust: 'untrusted' });
    const html = manager.readUiPanel('demo.ui', 'overview');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('openlab:panel-ready');
    expect(() => manager.readUiPanel('demo.ui', 'missing')).toThrow(/面板不存在/);
    writeFileSync(join(pluginRoot, 'index.mjs'), 'throw new Error("candidate failed")', 'utf8');
    await expect(manager.reload('demo.ui')).rejects.toThrow();
    await expect(execute()).resolves.toMatchObject({ content: 'v1:fast' });
    writeFileSync(join(pluginRoot, 'index.mjs'), pluginSource('v2'), 'utf8');
    await manager.reload('demo.ui');
    await expect(execute()).resolves.toMatchObject({ content: 'v2:fast' });
    await manager.stop();
  }, 20_000);

  it('never auto-starts an unlocked plugin copied in with a project, then persists explicit machine approval', async () => {
    const root = temporaryDirectory();
    const pluginRoot = join(root, '.openlab', 'plugins', 'preloaded.plugin');
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, id: 'preloaded.plugin', name: 'Preloaded Plugin', version: '1.0.0', engine: '^0.1.0', entry: 'index.mjs', permissions: [], contributes: { tools: ['ping'] },
    }), 'utf8');
    writeFileSync(join(pluginRoot, 'index.mjs'), `export default { apiVersion: 1, tools: [{ definition: { name: 'ping', title: 'Ping', description: 'Ping', inputSchema: { type: 'object', additionalProperties: false }, risk: 'read', renderHint: 'generic' }, async execute(_input, context) { return { callId: context.traceId, ok: true, content: 'approved', artifactIds: [], metadata: {} }; } }] };`, 'utf8');
    writeFileSync(join(root, '.openlab', 'plugin-state.json'), JSON.stringify({ 'preloaded.plugin': true }), 'utf8');
    writeFileSync(join(root, '.openlab', 'plugin-lock.json'), JSON.stringify({ 'preloaded.plugin': 'a'.repeat(64) }), 'utf8');
    const userRoot = join(root, '.user-plugins');
    const registry = new ToolRegistry();
    const manager = new PluginManager({ userRoot, projectRoot: root, registry });
    expect(manager.list()[0]).toMatchObject({ integrity: 'unlocked', enabled: false });
    await manager.activateEnabled();
    expect(registry.definitions()).toHaveLength(0);
    await manager.activate('preloaded.plugin');
    expect(manager.list()[0]).toMatchObject({ integrity: 'verified', enabled: true });
    await manager.stop();

    const restartedRegistry = new ToolRegistry();
    const restarted = new PluginManager({ userRoot, projectRoot: root, registry: restartedRegistry });
    expect(restarted.list()[0]).toMatchObject({ integrity: 'verified', enabled: true });
    await restarted.activateEnabled();
    await expect(restartedRegistry.require('plugin__preloaded_plugin__ping').execute({}, { projectRoot: root, sessionId: 'session', agentId: 'agent', traceId: 'trace', callId: 'call', signal: new AbortController().signal } as never)).resolves.toMatchObject({ content: 'approved' });
    await restarted.stop();
  }, 20_000);

  it('installs and upgrades plugins transactionally, then detects disk tampering', async () => {
    const root = temporaryDirectory();
    const sources = join(root, 'sources');
    const makeSource = (folder: string, version: string, output: string, broken = false) => {
      const source = join(sources, folder);
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, 'manifest.json'), JSON.stringify({
        schemaVersion: 1, id: 'upgrade.demo', name: 'Upgrade Demo', version, engine: '^0.1.0', entry: 'index.mjs', permissions: [], contributes: { tools: ['ping'] },
      }), 'utf8');
      writeFileSync(join(source, 'index.mjs'), broken ? 'throw new Error("broken candidate")' : `export default { apiVersion: 1, tools: [{ definition: { name: 'ping', title: 'Ping', description: 'Ping', inputSchema: { type: 'object', additionalProperties: false }, risk: 'read', renderHint: 'generic' }, async execute(_input, context) { return { callId: context.traceId, ok: true, content: '${output}', artifactIds: [], metadata: {} }; } }] };`, 'utf8');
      return source;
    };
    const registry = new ToolRegistry();
    const manager = new PluginManager({ userRoot: join(root, '.user-plugins'), projectRoot: root, registry });
    const firstSource = makeSource('v1', '1.0.0', 'v1');
    expect(manager.inspectSource(firstSource)).toMatchObject({ sourceType: 'directory', manifest: { id: 'upgrade.demo', version: '1.0.0', permissions: [] } });
    await manager.install(firstSource, 'project');
    const exported = join(root, 'upgrade-demo.zip');
    manager.export('upgrade.demo', exported);
    expect(new AdmZip(exported).getEntries().map((entry) => entry.entryName)).toContain('upgrade.demo/manifest.json');
    expect(manager.inspectSource(exported)).toMatchObject({ sourceType: 'zip', manifest: { id: 'upgrade.demo', version: '1.0.0' } });
    const execute = async () => await registry.require('plugin__upgrade_demo__ping').execute({}, { projectRoot: root, sessionId: 'session', agentId: 'agent', traceId: 'trace', callId: 'call', signal: new AbortController().signal } as never);
    await expect(execute()).resolves.toMatchObject({ content: 'v1' });
    expect(manager.list()[0]).toMatchObject({ integrity: 'verified', enabled: true });
    await manager.install(makeSource('v2', '1.1.0', 'v2'), 'project');
    await expect(execute()).resolves.toMatchObject({ content: 'v2' });
    await expect(manager.install(makeSource('bad', '1.2.0', 'bad', true), 'project')).rejects.toBeInstanceOf(Error);
    await expect(execute()).resolves.toMatchObject({ content: 'v2' });
    expect(readdirSync(join(root, '.openlab', 'plugins')).filter((name) => name.startsWith('.install-') || name.startsWith('.rollback-'))).toEqual([]);
    await manager.stop();

    const installedEntry = join(root, '.openlab', 'plugins', 'upgrade.demo', 'index.mjs');
    writeFileSync(installedEntry, `export default { apiVersion: 1, tools: [{ definition: { name: 'ping', title: 'Ping', description: 'Ping', inputSchema: { type: 'object', additionalProperties: false }, risk: 'read', renderHint: 'generic' }, async execute(_input, context) { return { callId: context.traceId, ok: true, content: 'v3-local', artifactIds: [], metadata: {} }; } }] };`, 'utf8');
    const registryAfterRestart = new ToolRegistry();
    const restarted = new PluginManager({ userRoot: join(root, '.user-plugins'), projectRoot: root, registry: registryAfterRestart });
    expect(restarted.list()[0]).toMatchObject({ integrity: 'mismatch', enabled: false });
    await restarted.reload('upgrade.demo');
    expect(restarted.list()[0]).toMatchObject({ integrity: 'verified', enabled: true });
    await expect(registryAfterRestart.require('plugin__upgrade_demo__ping').execute({}, { projectRoot: root, sessionId: 'session', agentId: 'agent', traceId: 'trace', callId: 'call', signal: new AbortController().signal } as never)).resolves.toMatchObject({ content: 'v3-local' });
    await restarted.stop();
  }, 30_000);

  it('blocks common network APIs when a plugin has no network permission', async () => {
    const root = temporaryDirectory();
    const pluginRoot = join(root, '.openlab', 'plugins', 'network.denied');
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, id: 'network.denied', name: 'Network Denied', version: '1.0.0', engine: '^0.1.0', entry: 'index.mjs', permissions: [], contributes: { tools: ['probe'] },
    }), 'utf8');
    writeFileSync(join(pluginRoot, 'index.mjs'), `export default { apiVersion: 1, tools: [{ definition: { name: 'probe', title: 'Probe', description: 'Probe', inputSchema: { type: 'object', additionalProperties: false }, risk: 'read', renderHint: 'generic' }, async execute(_input, context) { await fetch('https://example.com'); return { callId: context.traceId, ok: true, content: 'unexpected', artifactIds: [], metadata: {} }; } }] };`, 'utf8');
    const registry = new ToolRegistry();
    const manager = new PluginManager({ userRoot: join(root, '.user-plugins'), projectRoot: root, registry });
    await manager.activate('network.denied');
    await expect(registry.require('plugin__network_denied__probe').execute({}, { projectRoot: root, sessionId: 'session', agentId: 'agent', traceId: 'trace', callId: 'call', signal: new AbortController().signal } as never)).rejects.toThrow(/network 权限/u);
    await manager.stop();
  }, 20_000);

  it('blocks named Node network imports when a plugin has no network permission', async () => {
    const root = temporaryDirectory();
    const pluginRoot = join(root, '.openlab', 'plugins', 'network.named-denied');
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, id: 'network.named-denied', name: 'Named Network Denied', version: '1.0.0', engine: '^0.1.0', entry: 'index.mjs', permissions: [], contributes: { tools: ['probe'] },
    }), 'utf8');
    writeFileSync(join(pluginRoot, 'index.mjs'), `import { get } from 'node:http'; export default { apiVersion: 1, tools: [{ definition: { name: 'probe', title: 'Probe', description: 'Probe', inputSchema: { type: 'object', additionalProperties: false }, risk: 'read', renderHint: 'generic' }, async execute() { get('http://127.0.0.1'); return { callId: 'call', ok: true, content: 'unexpected', artifactIds: [], metadata: {} }; } }] };`, 'utf8');
    const registry = new ToolRegistry();
    const manager = new PluginManager({ userRoot: join(root, '.user-plugins'), projectRoot: root, registry });
    await manager.activate('network.named-denied');
    await expect(registry.require('plugin__network_named_denied__probe').execute({}, { projectRoot: root, sessionId: 'session', agentId: 'agent', traceId: 'trace', callId: 'call', signal: new AbortController().signal } as never)).rejects.toThrow(/network 权限/u);
    await manager.stop();
  }, 20_000);

  it('removes stale tool proxies and marks a plugin disabled after its process crashes', async () => {
    const root = temporaryDirectory();
    const pluginRoot = join(root, '.openlab', 'plugins', 'crash.fixture');
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, id: 'crash.fixture', name: 'Crash Fixture', version: '1.0.0', engine: '^0.1.0', entry: 'index.mjs', permissions: [], contributes: { tools: ['crash'] },
    }), 'utf8');
    writeFileSync(join(pluginRoot, 'index.mjs'), `export default { apiVersion: 1, tools: [{ definition: { name: 'crash', title: 'Crash', description: 'Crash', inputSchema: { type: 'object', additionalProperties: false }, risk: 'read', renderHint: 'generic' }, async execute() { process.exit(7); } }] };`, 'utf8');
    const registry = new ToolRegistry();
    const manager = new PluginManager({ userRoot: join(root, '.user-plugins'), projectRoot: root, registry });
    await manager.activate('crash.fixture');
    await expect(registry.require('plugin__crash_fixture__crash').execute({}, { projectRoot: root, sessionId: 'session', agentId: 'agent', traceId: 'trace', callId: 'call', signal: new AbortController().signal } as never)).rejects.toThrow(/插件进程已退出/u);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    expect(() => registry.require('plugin__crash_fixture__crash')).toThrow();
    expect(manager.list()[0]).toMatchObject({ enabled: false, error: expect.stringMatching(/插件进程已退出/u) });
    await manager.stop();
  }, 20_000);

  it('terminates a non-cooperative legacy plugin process when cancellation cannot be delivered', async () => {
    const root = temporaryDirectory();
    const pluginRoot = join(root, '.openlab', 'plugins', 'cancel.fixture');
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, id: 'cancel.fixture', name: 'Cancel Fixture', version: '1.0.0', engine: '^0.1.0', entry: 'index.mjs', permissions: [], contributes: { tools: ['wait'] },
    }), 'utf8');
    writeFileSync(join(pluginRoot, 'index.mjs'), `export default { apiVersion: 1, tools: [{ definition: { name: 'wait', title: 'Wait', description: 'Wait forever', inputSchema: { type: 'object', additionalProperties: false }, risk: 'read', renderHint: 'generic' }, async execute() { return await new Promise(() => {}); } }] };`, 'utf8');
    const registry = new ToolRegistry();
    const manager = new PluginManager({ userRoot: join(root, '.user-plugins'), projectRoot: root, registry });
    await manager.activate('cancel.fixture');
    const controller = new AbortController();
    const pending = registry.require('plugin__cancel_fixture__wait').execute({}, { projectRoot: root, sessionId: 'session', agentId: 'agent', traceId: 'trace', callId: 'call', signal: controller.signal } as never);
    controller.abort(new Error('cancel fixture'));
    await expect(pending).rejects.toThrow(/cancel fixture/u);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(() => registry.require('plugin__cancel_fixture__wait')).toThrow();
    expect(manager.list()[0]).toMatchObject({ enabled: false, error: expect.stringMatching(/插件进程已退出/u) });
    await manager.stop();
  }, 20_000);

  it('cancels only the cooperative v2 invocation and keeps the plugin process enabled', async () => {
    const root = temporaryDirectory();
    const pluginRoot = join(root, '.openlab', 'plugins', 'cancel-v2.fixture');
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 2, apiVersion: 2, id: 'cancel-v2.fixture', name: 'Cancel V2 Fixture', version: '1.0.0', engine: '^0.1.0', entry: 'index.mjs', permissions: [], contributes: { tools: ['wait', 'ping'] },
    }), 'utf8');
    writeFileSync(join(pluginRoot, 'index.mjs'), `export default { apiVersion: 2, tools: [
      { definition: { name: 'wait', title: 'Wait', description: 'Cooperative wait', inputSchema: { type: 'object', additionalProperties: false }, risk: 'read', renderHint: 'generic' }, async execute(_input, context) { await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true })); return { callId: context.traceId, ok: true, content: 'cancelled cooperatively', artifactIds: [], metadata: {} }; } },
      { definition: { name: 'ping', title: 'Ping', description: 'Process liveness', inputSchema: { type: 'object', additionalProperties: false }, risk: 'read', renderHint: 'generic' }, async execute(_input, context) { return { callId: context.traceId, ok: true, content: 'pong', artifactIds: [], metadata: {} }; } }
    ] };`, 'utf8');
    const registry = new ToolRegistry();
    const manager = new PluginManager({ userRoot: join(root, '.user-plugins'), projectRoot: root, registry });
    await manager.activate('cancel-v2.fixture');
    const controller = new AbortController();
    const pending = registry.require('plugin__cancel_v2_fixture__wait').execute({}, { projectRoot: root, sessionId: 'session', agentId: 'agent', traceId: 'trace', callId: 'call', signal: controller.signal } as never);
    controller.abort(new Error('cancel only this invocation'));
    await expect(pending).rejects.toThrow(/cancel only this invocation/u);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
    expect(manager.list()[0]).toMatchObject({ enabled: true });
    await expect(registry.require('plugin__cancel_v2_fixture__ping').execute({}, { projectRoot: root, sessionId: 'session', agentId: 'agent', traceId: 'trace-2', callId: 'call-2', signal: new AbortController().signal } as never)).resolves.toMatchObject({ ok: true, content: 'pong' });
    await manager.stop();
  }, 20_000);

  it('rolls back a plugin process that fails during startup discovery', async () => {
    const root = temporaryDirectory();
    const pluginRoot = join(root, '.openlab', 'plugins', 'startup.failure');
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, id: 'startup.failure', name: 'Startup Failure', version: '1.0.0', engine: '^0.1.0', entry: 'index.mjs', permissions: [], contributes: { tools: [] },
    }), 'utf8');
    writeFileSync(join(pluginRoot, 'index.mjs'), `export default { apiVersion: 1, get tools() { throw new Error('startup discovery failed'); } };`, 'utf8');
    const registry = new ToolRegistry();
    const manager = new PluginManager({ userRoot: join(root, '.user-plugins'), projectRoot: root, registry });
    await expect(manager.activate('startup.failure')).rejects.toThrow(/startup discovery failed/u);
    expect(registry.definitions()).toHaveLength(0);
    expect(manager.list()[0]).toMatchObject({ enabled: false });
    await manager.stop();
  }, 20_000);

  it('runs child processes through the resource-limited host', async () => {
    const root = temporaryDirectory();
    const execution = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
      const child = spawnWithResourceLimits(process.execPath, ['-e', "process.stdout.write('job-ok')"], {
        cwd: root,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
        limits: { memoryMb: 256, cpuMs: 10_000, activeProcesses: 1 },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
      child.stdin.end();
    });
    expect(execution).toMatchObject({ code: 0, stdout: 'job-ok', stderr: '' });
  }, 20_000);
});
