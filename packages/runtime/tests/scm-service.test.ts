import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventActor } from '@openlab/protocol';
import { SqliteEventStore } from '../src/events/event-store.js';
import { ScmService, type ScmCommandExecutor, type ScmCommandInput, type ScmCommandResult } from '../src/worktable/scm-service.js';

const USER: EventActor = { id: 'user', kind: 'user' };
const AGENT: EventActor = { id: 'agent', kind: 'agent' };
const directories: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'openlab-scm-'));
  directories.push(root);
  return root;
}

afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fixture(root: string, execute?: ScmCommandExecutor) {
  const events = new SqliteEventStore(join(dirname(root), `events-${Math.random().toString(16).slice(2)}.db`));
  const service = new ScmService({
    projectId: 'project', events, resolveRoot: (rootId) => { if (rootId !== 'project') throw new Error('unknown root'); return root; },
    ...(execute ? { execute } : {}),
  });
  return { service, events };
}

function commandFixture(root: string, overrides: (input: ScmCommandInput) => ScmCommandResult | undefined = () => undefined) {
  const calls: ScmCommandInput[] = [];
  const execute: ScmCommandExecutor = async (input) => {
    calls.push(structuredClone(input));
    const overridden = overrides(input);
    if (overridden) return overridden;
    if (input.args.includes('--show-toplevel')) return { exitCode: 0, stdout: `${root}\n`, stderr: '' };
    if (input.args.includes('--porcelain=v1')) return { exitCode: 0, stdout: '## main...origin/main [ahead 2, behind 1]\0 M tracked.txt\0?? semi;echo-owned.txt\0', stderr: '' };
    if (input.args.at(-1) === 'HEAD') return { exitCode: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { calls, execute };
}

describe('ScmService', () => {
  it('uses executable plus argument arrays, parses status, and gates Agent writes and commits', async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'tracked.txt'), 'tracked', 'utf8');
    writeFileSync(join(root, 'semi;echo-owned.txt'), 'safe arg', 'utf8');
    const command = commandFixture(root);
    const value = fixture(root, command.execute);
    try {
      expect(await value.service.status('project', USER)).toEqual({
        rootId: 'project', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, clean: false,
        entries: [
          { path: 'tracked.txt', index: ' ', worktree: 'M' },
          { path: 'semi;echo-owned.txt', index: '?', worktree: '?' },
        ],
      });
      await expect(value.service.stage('project', ['semi;echo-owned.txt'], AGENT, false)).rejects.toThrow(/明确确认/u);
      await expect(value.service.stage('project', ['semi;echo-owned.txt'], AGENT, true)).resolves.toMatchObject({ branch: 'main' });
      await expect(value.service.unstage('project', ['semi;echo-owned.txt'], AGENT, true)).resolves.toMatchObject({ branch: 'main' });
      await expect(value.service.commit('project', 'agent commit', AGENT, false)).rejects.toThrow(/明确确认/u);
      await expect(value.service.commit('project', 'agent commit', AGENT, true)).resolves.toMatchObject({ rootId: 'project', commitId: 'a'.repeat(40) });

      const add = command.calls.find((call) => call.args.includes('add'))!;
      expect(add.executable).toBe('git');
      expect(add.args).toContain('semi;echo-owned.txt');
      expect(add.args).not.toContain('echo-owned.txt');
      expect(command.calls.every((call) => Array.isArray(call.args))).toBe(true);
      const commit = command.calls.find((call) => call.args.includes('commit'))!;
      expect(commit.args).toEqual(expect.arrayContaining(['-c', expect.stringMatching(/^core\.hooksPath=/u), 'commit', '--message', 'agent commit']));
      const events = value.events.list('project:project');
      expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(['scm.status_read', 'scm.index_changed', 'scm.commit_created']));
      expect(JSON.stringify(events)).not.toContain(root);
    } finally { value.events.close(); }
  });

  it('rejects traversal, absolute paths, and roots that are nested inside another repository', async () => {
    const root = temporaryDirectory();
    const nested = join(root, 'nested');
    mkdirSync(nested);
    const command = commandFixture(root);
    const value = fixture(nested, command.execute);
    try {
      await expect(value.service.status('project', USER)).rejects.toThrow(/仓库根目录/u);
      await expect(value.service.stage('project', ['../escape.txt'], AGENT, true)).rejects.toThrow(/rootId/u);
      await expect(value.service.diff('project', { paths: [join(root, 'absolute.txt')] }, USER)).rejects.toThrow(/rootId/u);
    } finally { value.events.close(); }
  });

  it('redacts the root alias and truncates oversized diffs without persisting their content', async () => {
    const root = temporaryDirectory();
    const oversized = `${root}/secret\n`.repeat(180_000);
    const command = commandFixture(root, (input) => {
      if (input.args.includes('diff')) return { exitCode: 0, stdout: oversized, stderr: '' };
      return undefined;
    });
    const value = fixture(root, command.execute);
    try {
      const diff = await value.service.diff('project', {}, AGENT);
      expect(diff.truncated).toBe(true);
      expect(Buffer.byteLength(diff.content, 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(diff.content).not.toContain(root);
      const event = value.events.list('project:project').find((candidate) => candidate.kind === 'scm.diff_read')!;
      expect(JSON.stringify(event)).not.toContain('secret');
      expect(JSON.stringify(event)).not.toContain(root);
    } finally { value.events.close(); }
  });

  it('removes repository absolute paths from Git failures', async () => {
    const root = temporaryDirectory();
    const command = commandFixture(root, (input) => input.args.includes('status')
      ? { exitCode: 1, stdout: '', stderr: `fatal: failed in ${root}` }
      : undefined);
    const value = fixture(root, command.execute);
    try {
      await expect(value.service.status('project', USER)).rejects.not.toThrow(root);
      await expect(value.service.status('project', USER)).rejects.toThrow(/<root:project>/u);
    } finally { value.events.close(); }
  });

  it('completes a real status, stage, commit, diff, and unstage cycle', async () => {
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); }
    catch { return; }
    const root = temporaryDirectory();
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'openlab@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'OpenLab Test'], { cwd: root });
    writeFileSync(join(root, 'paper.txt'), 'version one\n', 'utf8');
    const value = fixture(root);
    try {
      expect((await value.service.status('project', USER)).entries).toEqual([expect.objectContaining({ path: 'paper.txt', index: '?', worktree: '?' })]);
      await expect(value.service.stage('project', ['paper.txt'], USER)).rejects.toThrow(/明确确认/u);
      expect(await value.service.stage('project', ['paper.txt'], USER, true)).toMatchObject({ entries: [expect.objectContaining({ path: 'paper.txt', index: 'A' })] });
      expect(await value.service.unstage('project', ['paper.txt'], USER, true)).toMatchObject({ entries: [expect.objectContaining({ path: 'paper.txt', index: '?' })] });
      await value.service.stage('project', ['paper.txt'], USER, true);
      await expect(value.service.commit('project', 'initial paper', USER)).rejects.toThrow(/明确确认/u);
      const committed = await value.service.commit('project', 'initial paper', USER, true);
      expect(committed.commitId).toMatch(/^[a-f0-9]{40,64}$/u);
      expect(committed.status.clean).toBe(true);
      writeFileSync(join(root, 'paper.txt'), 'version two\n', 'utf8');
      expect((await value.service.diff('project', { paths: ['paper.txt'] }, USER)).content).toContain('+version two');
      await expect(value.service.stage('project', ['paper.txt'], AGENT)).rejects.toThrow(/明确确认/u);
      expect(await value.service.stage('project', ['paper.txt'], AGENT, true)).toMatchObject({ entries: [expect.objectContaining({ index: 'M' })] });
      expect(await value.service.unstage('project', ['paper.txt'], USER, true)).toMatchObject({ entries: [expect.objectContaining({ worktree: 'M' })] });
    } finally { value.events.close(); }
  }, 30_000);
});
