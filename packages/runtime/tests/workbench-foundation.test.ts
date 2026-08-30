import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentRevisionRef } from '@openlab/protocol';
import { OpenLabRuntime } from '../src/runtime.js';

const directories: string[] = [];
function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'openlab-workbench-'));
  directories.push(root);
  return root;
}
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function hash(content: string | Buffer): string { return createHash('sha256').update(content).digest('hex'); }

async function runtimeFor(root: string): Promise<OpenLabRuntime> {
  const runtime = new OpenLabRuntime({ host: '127.0.0.1', port: 0, authToken: 'test', projectRoot: root, home: join(root, '.runtime'), demo: true });
  await runtime.initialize();
  if ((await runtime.snapshot()).agentDefinitions.length === 0) runtime.createAgent({ name: 'Workbench Lead', model: 'openlab-demo' });
  return runtime;
}

describe('scientific kernel foundation', () => {
  it('applies and undoes multi-file edits atomically and exposes pending diffs', async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'a.txt'), 'alpha', 'utf8');
    writeFileSync(join(root, 'b.txt'), 'beta', 'utf8');
    const runtime = await runtimeFor(root);
    try {
      const preview = runtime.previewWorkspaceEdit({
        label: 'paired edit',
        edits: [
          { ref: { rootId: 'project', path: 'a.txt' }, baseSha256: hash('alpha'), content: 'ALPHA' },
          { ref: { rootId: 'project', path: 'b.txt' }, baseSha256: hash('beta'), content: 'BETA' },
        ],
      });
      expect((await runtime.snapshot()).workspaceEditPreviews).toEqual([expect.objectContaining({ id: preview.id, files: expect.arrayContaining([expect.objectContaining({ diff: expect.stringContaining('ALPHA') })]) })]);
      const group = runtime.applyWorkspaceEdit(preview.id);
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('ALPHA');
      expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('BETA');
      runtime.undoWorkspaceEdit(group.id);
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('alpha');
      expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('beta');

      const conflicting = runtime.previewWorkspaceEdit({
        label: 'conflicting edit',
        edits: [
          { ref: { rootId: 'project', path: 'a.txt' }, baseSha256: hash('alpha'), content: 'next-a' },
          { ref: { rootId: 'project', path: 'b.txt' }, baseSha256: hash('beta'), content: 'next-b' },
        ],
      });
      writeFileSync(join(root, 'b.txt'), 'external', 'utf8');
      expect(() => runtime.applyWorkspaceEdit(conflicting.id)).toThrow(/审批期间发生变化/u);
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('alpha');
      expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('external');
    } finally { await runtime.stop(); }
  });

  it('recovers dirty documents, range-reads revision resources, and marks moved annotations stale', async () => {
    const root = temporaryDirectory();
    const path = join(root, 'draft.txt');
    writeFileSync(path, '0123456789', 'utf8');
    const runtime = await runtimeFor(root);
    const initialHash = hash('0123456789');
    const target: DocumentRevisionRef = { ref: { rootId: 'project', path: 'draft.txt' }, sha256: initialHash, mediaType: 'text/plain' };
    const handle = runtime.openResource(target);
    expect(runtime.resources.read(handle.id, 2, 7).toString('utf8')).toBe('23456');
    const annotation = runtime.createAnnotation({ target, selector: { kind: 'image-rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, comment: 'review this region' });
    expect(annotation.status).toBe('open');
    const buffer = runtime.openDocument(target.ref);
    runtime.updateDocument(buffer.id, 'dirty recovery content');
    writeFileSync(path, 'external-revision', 'utf8');
    expect(runtime.annotations.list().find((item) => item.id === annotation.id)?.status).toBe('stale');
    runtime.releaseResource(handle.id);
    await runtime.stop();

    // A dirty buffer is only recovered when the underlying revision still
    // matches its base. Restore that base to exercise the safe recovery path.
    writeFileSync(path, '0123456789', 'utf8');
    const restored = await runtimeFor(root);
    try {
      const reopened = restored.openDocument(target.ref);
      expect(reopened).toMatchObject({ content: 'dirty recovery content', dirty: true, recovered: true, baseSha256: initialHash });
      expect(() => restored.openResource({ ...target, sha256: '0'.repeat(64) })).toThrow(/已经变化/u);
    } finally { await restored.stop(); }
  });

  it('runs persistent jobs, registers source maps, archives immutable revisions, and restores into a new directory', async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'input.txt'), 'scientific-input', 'utf8');
    writeFileSync(join(root, 'plot.py'), '# plot source\nprint(1)\n', 'utf8');
    const runtime = await runtimeFor(root);
    try {
      const agent = (await runtime.snapshot()).agentDefinitions[0]!;
      const artifact = runtime.research.createObject({ type: 'artifact', title: 'Figure bundle', status: 'active', attributes: {}, attachments: [] }, { id: 'local-user', kind: 'user' });
      const job = runtime.runJob({
        title: 'fixture build',
        executable: process.execPath,
        args: ['-e', "const fs=require('fs');fs.mkdirSync('nested',{recursive:true});fs.writeFileSync('out.txt',fs.readFileSync('input.txt'));fs.writeFileSync('nested/build.log','ok')"],
        inputs: [{ ref: { rootId: 'project', path: 'input.txt' }, destination: 'input.txt' }],
        outputs: [
          { path: 'out.txt', role: 'output', mediaType: 'text/plain' },
          { glob: '**/*.log', role: 'log', mediaType: 'text/plain' },
        ],
        network: false,
      });
      const completed = await runtime.jobs.wait(job.id);
      expect(completed.status).toBe('completed');
      expect(completed.outputs.map((output) => output.path)).toEqual(['nested/build.log', 'out.txt']);
      const output = completed.outputs.find((candidate) => candidate.path === 'out.txt')!;
      const map = runtime.registerSourceMap({
        target: { ref: output.ref, sha256: output.sha256, mediaType: output.mediaType },
        regions: [{ selector: { kind: 'image-rect', x: 0.1, y: 0.1, width: 0.4, height: 0.4 }, sources: [{ ref: { rootId: 'project', path: 'plot.py' }, startLine: 1, endLine: 2 }] }],
      });
      expect((await runtime.snapshot()).sourceMaps).toEqual([expect.objectContaining({ id: map.id })]);
      const revision = runtime.createArtifactRevision({
        artifactId: artifact.id,
        files: [
          { role: 'source', ref: { rootId: 'project', path: 'plot.py' }, name: 'plot.py' },
          { role: 'output', ref: output.ref, name: 'out.txt', mediaType: output.mediaType },
        ],
        jobId: completed.id,
        provenance: { traceId: 'trace', sessionId: 'forged-session', agentId: 'forged-agent', inputObjectIds: [], inputFileHashes: { forged: 'value' } },
      });
      expect(revision.provenance).toMatchObject({ agentId: agent.id, sessionId: (await runtime.snapshot()).activeSessionId, tool: 'workbench.register_revision' });
      expect(revision.provenance.inputFileHashes).not.toHaveProperty('forged');
      const archived = runtime.archiveArtifactRevision(revision.id);
      expect(archived.status).toBe('archived');
      expect(existsSync(join(root, '.openlab', 'archive', 'manifests', `${revision.id}.json`))).toBe(true);
      const restored = runtime.restoreArtifactRevision(revision.id, { rootId: 'project', path: 'restored-v1' });
      expect(restored.missing).toEqual([]);
      expect(restored.restored).toHaveLength(2);
      expect(existsSync(join(root, 'restored-v1', 'source'))).toBe(true);
    } finally { await runtime.stop(); }
  }, 20_000);
});
