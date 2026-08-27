import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelEvent, ModelProvider, ModelRequest } from '@openlab/protocol';
import { SqliteEventStore } from '../src/events/event-store.js';
import { OpenLabRuntime } from '../src/runtime.js';
import { SessionWorkspaceStore } from '../src/workspace/session-workspace-store.js';

const temporaryDirectories: string[] = [];
function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `openlab-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const actor = { id: 'workspace-test', kind: 'user' as const };

async function waitForIdle(runtime: OpenLabRuntime, timeout = 3_000): Promise<void> {
  const started = Date.now();
  while (true) {
    const snapshot = await runtime.snapshot();
    if (snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)?.status !== 'running') return;
    if (Date.now() - started > timeout) throw new Error('runtime did not become idle');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

describe('session workspace store', () => {
  it('treats every folder bound to a project as a stable first-class workspace root', () => {
    const project = temporaryDirectory('project');
    const evidence = temporaryDirectory('project-evidence');
    const datasets = temporaryDirectory('project-datasets');
    const state = temporaryDirectory('state');
    writeFileSync(join(evidence, 'paper.md'), 'bound evidence', 'utf8');
    const events = new SqliteEventStore(join(state, 'events.db'));
    const options = {
      projectId: 'project-1', projectRoot: project, projectRoots: [evidence], projectName: 'Project', sessionId: 'session-1',
      model: 'fixture-model', snapshotRoot: join(state, 'snapshots'), events,
    };
    const workspace = new SessionWorkspaceStore(options);
    const bound = workspace.snapshot().roots.find((root) => root.displayPath === evidence);
    expect(bound).toMatchObject({ name: basename(evidence), kind: 'project', access: 'trusted', status: 'online' });
    expect(workspace.listDirectory({ rootId: bound!.id, path: '.' })[0]).toMatchObject({ name: 'paper.md' });
    expect(() => workspace.revokeRoot(bound!.id, actor)).toThrow(/项目设置/u);

    const restoredForAnotherConversation = new SessionWorkspaceStore({ ...options, sessionId: 'session-2' });
    expect(restoredForAnotherConversation.snapshot().roots.some((root) => root.displayPath === evidence)).toBe(true);
    restoredForAnotherConversation.setProjectRoots([datasets]);
    expect(restoredForAnotherConversation.snapshot().roots.some((root) => root.displayPath === evidence)).toBe(false);
    expect(restoredForAnotherConversation.snapshot().roots.some((root) => root.displayPath === datasets)).toBe(true);
    events.close();
  });

  it('persists roots, notes and conversation files while keeping paths root-relative', () => {
    const project = temporaryDirectory('project');
    const external = temporaryDirectory('external');
    const state = temporaryDirectory('state');
    writeFileSync(join(external, 'evidence.md'), '# Evidence\nneedle', 'utf8');
    writeFileSync(join(external, 'paper.pdf'), Buffer.from('%PDF-1.4\npreview fixture', 'utf8'));
    writeFileSync(join(external, 'notes.docx'), Buffer.from('PK\u0003\u0004docx preview fixture', 'binary'));
    const events = new SqliteEventStore(join(state, 'events.db'));
    const options = {
      projectId: 'project-1', projectRoot: project, projectName: 'Project', sessionId: 'session-1',
      model: 'fixture-model', snapshotRoot: join(state, 'snapshots'), events,
    };
    const workspace = new SessionWorkspaceStore(options);
    expect(workspace.snapshot().roots.find((candidate) => candidate.id === 'project')?.name).toBe(basename(project));
    const root = workspace.authorizeRoot(external, 'ask', actor);
    workspace.setActiveRoot(root.id, actor);
    workspace.setNote('Only compare measured evidence.', actor);

    expect(workspace.listDirectory({ rootId: root.id, path: '.' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ rootId: root.id, path: 'evidence.md', name: 'evidence.md' }),
    ]));
    expect(workspace.search(root.id, 'needle', { includeContent: true })[0]?.matches?.[0]).toMatchObject({ line: 2 });
    expect(workspace.preview({ rootId: root.id, path: 'evidence.md' })).toMatchObject({ kind: 'text', content: '# Evidence\nneedle' });
    expect(workspace.preview({ rootId: root.id, path: 'paper.pdf' })).toMatchObject({ kind: 'pdf', mediaType: 'application/pdf', dataUrl: expect.stringMatching(/^data:application\/pdf;base64,/u) });
    expect(workspace.preview({ rootId: root.id, path: 'notes.docx' })).toMatchObject({ kind: 'word', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dataUrl: expect.stringMatching(/^data:application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document;base64,/u) });
    expect(workspace.chatAttachment({ rootId: root.id, path: 'evidence.md' })).toMatchObject({ rootId: root.id, relativePath: 'evidence.md' });
    workspace.registerConversationFile({ rootId: root.id, path: 'evidence.md' }, 'reference', actor);

    const restored = new SessionWorkspaceStore(options);
    expect(restored.snapshot()).toMatchObject({ activeRootId: root.id, note: 'Only compare measured evidence.', conversationFileCount: 1 });
    expect(restored.conversationFiles()[0]).toMatchObject({ ref: { rootId: root.id, path: 'evidence.md' }, origin: 'reference' });
    expect(JSON.stringify(restored.rootForModel(root.id))).not.toContain(external);
    const anotherConversation = new SessionWorkspaceStore({ ...options, sessionId: 'session-2' });
    expect(anotherConversation.snapshot().note).toBe('Only compare measured evidence.');
    restored.removeConversationFile(restored.conversationFiles()[0]!.id, actor);
    const restoredAfterRemoval = new SessionWorkspaceStore(options);
    expect(restoredAfterRemoval.snapshot().conversationFileCount).toBe(0);
    expect(restoredAfterRemoval.conversationFiles()).toEqual([]);
    events.close();
  });

  it('supports cross-root copy and conflict-safe undo', () => {
    const project = temporaryDirectory('project');
    const external = temporaryDirectory('external');
    const state = temporaryDirectory('state');
    writeFileSync(join(project, 'source.txt'), 'source-v1', 'utf8');
    const events = new SqliteEventStore(join(state, 'events.db'));
    const workspace = new SessionWorkspaceStore({
      projectId: 'project-1', projectRoot: project, projectName: 'Project', sessionId: 'session-1',
      model: 'fixture-model', snapshotRoot: join(state, 'snapshots'), events,
    });
    const root = workspace.authorizeRoot(external, 'trusted', actor);
    const copied = workspace.operate({
      type: 'copy', source: { rootId: 'project', path: 'source.txt' }, target: { rootId: root.id, path: 'copied.txt' },
    }, actor);
    expect(readFileSync(join(external, 'copied.txt'), 'utf8')).toBe('source-v1');
    workspace.undo(copied.id, actor);
    expect(existsSync(join(external, 'copied.txt'))).toBe(false);
    expect(readFileSync(join(project, 'source.txt'), 'utf8')).toBe('source-v1');

    const created = workspace.operate({ type: 'create_file', target: { rootId: root.id, path: 'changed.txt' }, content: 'initial' }, actor);
    writeFileSync(join(external, 'changed.txt'), 'modified later', 'utf8');
    expect(() => workspace.undo(created.id, actor)).toThrow(/发生变化/u);
    expect(readFileSync(join(external, 'changed.txt'), 'utf8')).toBe('modified later');
    events.close();
  });

  it('enforces traversal, read-only and fork reauthorization boundaries', () => {
    const project = temporaryDirectory('project');
    const external = temporaryDirectory('external');
    const state = temporaryDirectory('state');
    writeFileSync(join(external, 'readme.txt'), 'safe', 'utf8');
    mkdirSync(join(project, '.openlab'), { recursive: true });
    writeFileSync(join(project, '.openlab', 'private.txt'), 'hidden', 'utf8');
    const events = new SqliteEventStore(join(state, 'events.db'));
    const base = {
      projectId: 'project-1', projectRoot: project, projectName: 'Project', model: 'fixture-model',
      snapshotRoot: join(state, 'snapshots'), events,
    };
    const source = new SessionWorkspaceStore({ ...base, sessionId: 'source-session' });
    const root = source.authorizeRoot(external, 'read_only', actor);
    expect(source.listDirectory({ rootId: 'project', path: '.' }).map((entry) => entry.name)).not.toContain('.openlab');
    expect(() => source.preview({ rootId: root.id, path: '../outside.txt' })).toThrow(/不安全|无效/u);
    expect(() => source.operate({ type: 'create_file', target: { rootId: root.id, path: 'blocked.txt' } }, actor)).toThrow(/只读/u);

    source.forkAuthorizationEvents('fork-session', actor);
    const fork = new SessionWorkspaceStore({ ...base, sessionId: 'fork-session' });
    expect(fork.snapshot()).toMatchObject({ activeRootId: 'project' });
    expect(fork.snapshot().roots).toEqual(expect.arrayContaining([expect.objectContaining({ id: root.id, status: 'pending_confirmation' })]));
    expect(() => fork.listDirectory({ rootId: root.id, path: '.' })).toThrow(/重新确认/u);
    fork.confirmRoot(root.id, actor);
    expect(fork.listDirectory({ rootId: root.id, path: '.' })[0]).toMatchObject({ name: 'readme.txt' });
    events.close();
  });

  it('allows ordinary model writes in a trusted external root without an approval round-trip', async () => {
    const project = temporaryDirectory('project');
    const external = temporaryDirectory('external');
    let rootId = '';
    const provider: ModelProvider = {
      id: 'fixture',
      async listModels() { return [{ id: 'fixture-model', label: 'Fixture', contextWindow: 128_000, supportsThinking: true, supportsTools: true, supportsVision: false }]; },
      async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        if (!request.messages.some((message) => message.role === 'tool')) {
          yield { type: 'tool_call_delta', index: 0, id: 'trusted-write', name: 'write_file', arguments: JSON.stringify({ rootId, path: 'trusted.txt', content: 'written without approval' }) };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const runtime = new OpenLabRuntime({
      host: '127.0.0.1', port: 0, authToken: 'token', projectRoot: project, home: join(project, '.runtime'),
      demo: false, modelProvider: provider,
    });
    await runtime.initialize();
    runtime.createAgent({ name: 'Workspace Lead', model: 'fixture-model' });
    rootId = runtime.authorizeWorkspaceRoot(external, 'trusted').id;
    runtime.setActiveWorkspaceRoot(rootId);
    runtime.submitChat({ text: 'write the trusted file', model: 'fixture-model', permissionMode: 'ask' });
    await waitForIdle(runtime);
    const snapshot = await runtime.snapshot();
    expect(snapshot.pendingApprovals).toHaveLength(0);
    expect(readFileSync(join(external, 'trusted.txt'), 'utf8')).toBe('written without approval');
    expect(runtime.events.list(`session:${snapshot.activeSessionId}`).some((event) => event.kind === 'approval.requested')).toBe(false);
    await runtime.stop();
  });

  it('automatically disables a changed workspace Skill hash', async () => {
    const project = temporaryDirectory('project');
    const skillRoot = join(project, '.openlab', 'skills', 'watched-skill');
    mkdirSync(skillRoot, { recursive: true });
    const skillPath = join(skillRoot, 'SKILL.md');
    writeFileSync(skillPath, '---\nid: watched-skill\nname: Watched Skill\ndescription: detects changes\n---\n\nVersion one.\n', 'utf8');
    const runtime = new OpenLabRuntime({ host: '127.0.0.1', port: 0, authToken: 'token', projectRoot: project, home: join(project, '.runtime'), demo: true });
    await runtime.initialize();
    const discovered = (await runtime.snapshot()).skills.find((skill) => skill.id === 'watched-skill');
    expect(discovered).toMatchObject({ enabled: false, approvalRequired: true });
    runtime.approveSkill(discovered!.id, discovered!.sha256!);
    expect((await runtime.snapshot()).skills.find((skill) => skill.id === 'watched-skill')).toMatchObject({ enabled: true });
    const pushes: unknown[] = [];
    const unsubscribe = runtime.subscribe((message) => pushes.push(message));
    writeFileSync(skillPath, '---\nid: watched-skill\nname: Watched Skill\ndescription: detects changes\n---\n\nVersion two.\n', 'utf8');
    const started = Date.now();
    while ((await runtime.snapshot()).skills.find((skill) => skill.id === 'watched-skill')?.enabled !== false) {
      if (Date.now() - started > 4_000) throw new Error('Skill watcher did not detect the hash change');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    expect((await runtime.snapshot()).skills.find((skill) => skill.id === 'watched-skill')).toMatchObject({ approvalRequired: true });
    expect(pushes).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'capabilities.changed' })]));
    unsubscribe();
    await runtime.stop();
  });
});
