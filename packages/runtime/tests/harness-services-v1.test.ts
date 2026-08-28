import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { CuratedPluginCatalogIndexV1, SignedPluginCatalogV1, ToolchainAdapterManifestV1 } from '@openlab/protocol';
import { SqliteEventStore } from '../src/events/event-store.js';
import { CuratedPluginMarketplace, canonicalPluginCatalogJson } from '../src/extensions/curated-plugin-marketplace.js';
import { GeneratedAppBlueprintService } from '../src/workbench/generated-app-blueprint-service.js';
import { JobService } from '../src/workbench/job-service.js';
import { ScientificKernelStore } from '../src/workbench/scientific-kernel-store.js';
import { ToolchainAdapterService } from '../src/workbench/toolchain-adapter-service.js';
import { WorkbenchService } from '../src/workbench/workbench-service.js';
import { WorktableStore } from '../src/worktable/worktable-store.js';

const roots: string[] = [];
const actor = { id: 'owner', kind: 'user', label: 'Local owner' } as const;

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'sci-harness-v1-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function waitUntil<T>(read: () => T, done: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for harness service');
}

describe('thin scientific kernel', () => {
  it('replays idempotent evidence anchors, runs, and owner-reviewed decisions', () => {
    const database = join(temporaryDirectory(), 'events.sqlite');
    const events = new SqliteEventStore(database);
    const kernel = new ScientificKernelStore({ projectId: 'project', events });
    const target = { ref: { rootId: 'project', path: 'paper.pdf' }, sha256: 'a'.repeat(64), mediaType: 'application/pdf' };
    const anchor = kernel.createAnchor({
      target, page: 2, blockId: 'block-7', exact: 'measured result',
      selector: { kind: 'document-anchor', scheme: 'fixture.block.v1', anchor: 'block-7', exact: 'measured result' },
    }, actor, 'evidence:paper:block-7');
    expect(kernel.createAnchor({ target, page: 2, blockId: 'block-7', selector: anchor.selector }, actor, 'evidence:paper:block-7').id).toBe(anchor.id);
    expect(() => kernel.createAnchor({ target, page: 0, selector: anchor.selector }, actor)).toThrow(/页码/u);

    const run = kernel.startRun({ instanceId: 'workbench-1', primaryConversationId: 'conversation-1', kind: 'model', status: 'queued', progress: 0, inputRefs: [anchor.id], outputRefs: [] }, actor);
    expect(kernel.updateRun(run.id, { status: 'completed', progress: 1, outputRefs: ['artifact-revision-1'] }, actor)).toMatchObject({ status: 'completed', progress: 1 });
    expect(() => kernel.updateRun(run.id, { progress: 2 }, actor)).toThrow(/0–1/u);
    const review = kernel.requestReview({ instanceId: 'workbench-1', runId: run.id, title: '核验结论', description: '检查来源与产物', evidenceAnchorIds: [anchor.id], requiredRole: 'reviewer' }, actor);
    expect(kernel.decideReview(review.id, 'approved', actor)).toMatchObject({ status: 'approved', decidedBy: actor });
    events.close();

    const reopenedEvents = new SqliteEventStore(database);
    const reopened = new ScientificKernelStore({ projectId: 'project', events: reopenedEvents });
    expect(reopened.anchors(target)).toEqual([expect.objectContaining({ id: anchor.id, page: 2, blockId: 'block-7' })]);
    expect(reopened.runs('workbench-1')).toEqual([expect.objectContaining({ id: run.id, status: 'completed' })]);
    expect(reopened.reviews('workbench-1')).toEqual([expect.objectContaining({ id: review.id, status: 'approved' })]);
    reopenedEvents.close();
  });
});

describe('prompt-generated application pipeline', () => {
  it('requires blueprint confirmation, builds a network-denied bundle, previews, accepts, mounts, and replays', () => {
    const database = join(temporaryDirectory(), 'events.sqlite');
    const events = new SqliteEventStore(database);
    const tables = new WorktableStore({ projectId: 'project', events });
    const workbenches = new WorkbenchService({ projectId: 'project', events, worktables: tables });
    let builtFiles: Array<{ name: string; content: string; mediaType: string }> = [];
    const service = new GeneratedAppBlueprintService({
      projectId: 'project', events,
      createArtifact: (input) => {
        builtFiles = input.files;
        return { artifactId: `artifact-${input.blueprint.id}`, revisionId: `revision-${input.blueprint.id}` };
      },
      publish: (blueprint) => ({
        id: `app-${blueprint.id}`, projectId: 'project', title: blueprint.title, artifactId: blueprint.artifact!.artifactId,
        activeRevisionId: blueprint.artifact!.revisionId, entry: blueprint.entry, networkDomains: [], hostCapabilities: [],
        status: 'ready', createdAt: blueprint.createdAt, updatedAt: blueprint.updatedAt,
      }),
      mount: (blueprint, mountActor, conversationId) => {
        workbenches.register([blueprint]);
        return workbenches.create({ blueprintId: blueprint.id, ...(conversationId ? { primaryConversationId: conversationId } : {}) }, mountActor);
      },
    });
    expect(() => service.propose('', actor)).toThrow(/1–20,000/u);
    const proposed = service.propose('创建一个 <证据> 记录面板', actor);
    expect(proposed).toMatchObject({ status: 'awaiting_confirmation', networkDomains: [], hostCapabilities: [] });
    expect(() => service.build(proposed.id, actor)).toThrow(/尚未通过/u);
    service.confirm(proposed.id, true, actor);
    const built = service.build(proposed.id, actor);
    expect(built).toMatchObject({ status: 'preview', artifact: { artifactId: `artifact-${proposed.id}` } });
    expect(builtFiles.map((file) => file.name)).toEqual(['index.html', 'generated-app.json']);
    const html = builtFiles.find((file) => file.name === 'index.html')!.content;
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('&lt;证据&gt;');
    expect(html).not.toMatch(/https?:\/\//u);
    expect(() => service.accept(proposed.id, false, actor)).toThrow(/明确确认/u);
    const accepted = service.accept(proposed.id, true, actor, 'conversation-1');
    expect(accepted.instance).toMatchObject({ primaryConversationId: 'conversation-1', blueprintId: `generated:${proposed.id}` });
    expect(accepted.instance.panes[0]?.tabs[0]?.content).toMatchObject({ kind: 'generated-app', appId: accepted.app.id, revisionId: accepted.app.activeRevisionId });
    events.close();

    const reopenedEvents = new SqliteEventStore(database);
    const replayed = new GeneratedAppBlueprintService({
      projectId: 'project', events: reopenedEvents,
      createArtifact: () => { throw new Error('not called'); }, publish: () => { throw new Error('not called'); }, mount: () => { throw new Error('not called'); },
    });
    expect(replayed.get(proposed.id).status).toBe('accepted');
    reopenedEvents.close();
  });
});

describe('curated plugin catalog', () => {
  it('verifies Ed25519, hashes, anti-rollback, revocation, and trusted offline cache', () => {
    const root = temporaryDirectory();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const packagePath = join(root, 'fixture-plugin.zip');
    writeFileSync(packagePath, 'signed plugin package', 'utf8');
    const packageHash = createHash('sha256').update(readFileSync(packagePath)).digest('hex');
    const signCatalog = (index: CuratedPluginCatalogIndexV1): SignedPluginCatalogV1 => ({
      keyId: 'curated-test', algorithm: 'Ed25519', index,
      signature: signBytes(null, Buffer.from(canonicalPluginCatalogJson(index), 'utf8'), privateKey).toString('base64'),
    });
    const baseIndex: CuratedPluginCatalogIndexV1 = {
      schemaVersion: 1, sequence: 1, generatedAt: '2026-08-28T00:00:00.000Z', revocations: [],
      entries: [{ id: 'fixture.signed', version: '1.0.0', name: 'Signed fixture', description: 'Verified package', packageUrl: 'https://example.test/fixture.zip', sha256: packageHash, permissions: ['workbench:read'], publishedAt: '2026-08-28T00:00:00.000Z' }],
    };
    const firstPath = join(root, 'catalog-1.json');
    writeFileSync(firstPath, JSON.stringify(signCatalog(baseIndex)), 'utf8');
    const cachePath = join(root, 'catalog-cache.json');
    const market = new CuratedPluginMarketplace({ cachePath, trustedKeys: new Map([['curated-test', publicPem]]) });
    market.updateFromFile(firstPath);
    expect(market.entries()).toEqual([expect.objectContaining({ id: 'fixture.signed', sha256: packageHash })]);
    expect(() => market.updateFromFile(firstPath)).toThrow(/回滚或重放/u);
    expect(() => market.verifyPackage(packagePath, { id: 'fixture.signed', version: '1.0.0', sha256: '0'.repeat(64) })).toThrow(/SHA-256/u);
    expect(() => market.updateFromFile(join(root, 'missing.json'))).toThrow();

    const revokedIndex: CuratedPluginCatalogIndexV1 = {
      ...baseIndex, sequence: 2, generatedAt: '2026-08-28T01:00:00.000Z',
      revocations: [{ id: 'fixture.signed', version: '1.0.0', reason: 'security audit', revokedAt: '2026-08-28T01:00:00.000Z' }],
    };
    const revokedPath = join(root, 'catalog-2.json');
    writeFileSync(revokedPath, JSON.stringify(signCatalog(revokedIndex)), 'utf8');
    market.updateFromFile(revokedPath);
    expect(market.entries()).toEqual([]);
    expect(market.revocationReason('fixture.signed', '1.0.0')).toBe('security audit');
    expect(() => market.verifyPackage(packagePath, baseIndex.entries[0]!)).toThrow(/已撤回/u);

    const offline = new CuratedPluginMarketplace({ cachePath, trustedKeys: new Map([['curated-test', publicPem]]) });
    expect(offline.status()).toMatchObject({ source: 'cache', sequence: 2 });
    expect(offline.revocationReason('fixture.signed', '1.0.0')).toBe('security audit');
  });
});

describe('external toolchain adapter contract', () => {
  it('requires authorization, isolates a mock run, imports output revisions, and cancels a long run', async () => {
    const root = temporaryDirectory();
    const events = new SqliteEventStore(join(root, 'events.sqlite'));
    const jobs = new JobService({
      projectId: 'project', events, root: join(root, 'jobs'),
      resolveRoot: () => root,
      resolveToolchainExecutable: (_toolchainId, executable) => executable,
    });
    const service = new ToolchainAdapterService({
      projectId: 'project', events, jobs,
      importOutputs: (_run, job) => {
        expect(job.outputs[0]).toMatchObject({ path: 'mock-output.json', ref: { rootId: `job:${job.id}` } });
        return ['artifact-revision-1'];
      },
    });
    expect(() => service.run({ adapterId: 'sci.mock-toolchain', operationId: 'render-json', values: { title: 'Figure 3' }, confirmed: false }, actor)).toThrow(/明确授权/u);
    const started = service.run({ adapterId: 'sci.mock-toolchain', operationId: 'render-json', values: { title: 'Figure 3', payload: { panel: 'a' } }, confirmed: true, instanceId: 'workbench-1' }, actor);
    const completed = await waitUntil(() => service.get(started.id), (run) => run.status === 'completed');
    expect(completed.artifactRevisionIds).toEqual(['artifact-revision-1']);
    const output = jobs.get(completed.jobId).outputs[0]!;
    expect(JSON.parse(readFileSync(join(jobs.rootFor(output.ref.rootId)!, output.ref.path), 'utf8'))).toMatchObject({ adapter: 'sci.mock-toolchain', input: { title: 'Figure 3' } });

    const longManifest: ToolchainAdapterManifestV1 = {
      schemaVersion: 1, id: 'fixture.long-tool', version: '1.0.0', title: 'Long tool', platforms: ['win32'], executableNames: ['node.exe'], versionArgs: ['--version'],
      operations: [{ id: 'run', title: 'Long run', inputSchema: { type: 'object', additionalProperties: false }, outputs: [], requiresConfirmation: true }],
    };
    service.register(longManifest, () => ({
      title: 'Long tool run', executable: process.execPath,
      args: ['-e', "console.log('started');setTimeout(()=>process.exit(0),15000)"], inputs: [], outputs: [], timeoutMs: 20_000, network: false, origin: 'user',
    }));
    const long = service.run({ adapterId: longManifest.id, operationId: 'run', values: {}, confirmed: true }, actor);
    const cancelled = service.cancel(long.id, actor);
    expect(cancelled.status).toBe('cancelled');
    expect((await service.wait(long.id)).status).toBe('cancelled');
    jobs.shutdown();
    events.close();
  }, 30_000);
});
