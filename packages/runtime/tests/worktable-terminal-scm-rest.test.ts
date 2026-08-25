import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerPushMessage } from '@openlab/protocol';
import { OpenLabRuntime } from '../src/runtime.js';
import { startRuntimeServer } from '../src/server/runtime-server.js';
import type { ScmCommandExecutor, ScmCommandInput } from '../src/worktable/scm-service.js';
import type { TerminalDriver, TerminalPtyProcess } from '../src/worktable/terminal-service.js';

const directories: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'openlab-worktable-shells-'));
  directories.push(root);
  return root;
}

afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

class FakePty implements TerminalPtyProcess {
  readonly pid: number;
  readonly writes: string[] = [];
  readonly sizes: Array<{ cols: number; rows: number }> = [];
  killed = 0;
  readonly #data = new Set<(value: string) => void>();
  readonly #exit = new Set<(value: { exitCode: number; signal?: number }) => void>();

  constructor(pid: number) { this.pid = pid; }
  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.sizes.push({ cols, rows }); }
  kill(): void { this.killed += 1; }
  onData(listener: (data: string) => void) { this.#data.add(listener); return { dispose: () => this.#data.delete(listener) }; }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) { this.#exit.add(listener); return { dispose: () => this.#exit.delete(listener) }; }
  emitData(data: string): void { for (const listener of this.#data) listener(data); }
}

class FakeTerminalDriver implements TerminalDriver {
  readonly processes: FakePty[] = [];
  availability() { return { available: true } as const; }
  spawn(): TerminalPtyProcess {
    const process = new FakePty(10_000 + this.processes.length);
    this.processes.push(process);
    return process;
  }
}

describe('worktable terminal and SCM REST services', () => {
  it('keeps PTY input user-only, requires SCM confirmation, emits updates, and never returns local roots', async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'paper.txt'), 'draft\n', 'utf8');
    const terminalDriver = new FakeTerminalDriver();
    let stoppedJobs = 0;
    const gitCalls: Array<{ executable: string; args: string[]; cwd: string }> = [];
    const scmExecute: ScmCommandExecutor = async (input: ScmCommandInput) => {
      gitCalls.push({ executable: input.executable, args: [...input.args], cwd: input.cwd });
      if (input.args.includes('--show-toplevel')) return { exitCode: 0, stdout: `${root}\n`, stderr: '' };
      if (input.args.includes('--porcelain=v1')) return { exitCode: 0, stdout: '## main\0 M paper.txt\0', stderr: '' };
      if (input.args.includes('diff')) return { exitCode: 0, stdout: `diff --git ${root}/paper.txt\n`, stderr: '' };
      if (input.args.at(-1) === 'HEAD') return { exitCode: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const runtime = new OpenLabRuntime({
      host: '127.0.0.1', port: 0, authToken: 'shell-test', projectRoot: root, home: join(root, '.runtime'), demo: true,
    }, {
      terminalDriver,
      terminalAttachJob: () => ({ ready: Promise.resolve(), stop: () => { stoppedJobs += 1; } }),
      scmExecute,
    });
    await runtime.initialize();
    const instance = runtime.createWorktable({});
    const paneId = instance.panes[1]!.id;
    runtime.mountWorktableTab(instance.id, paneId, { title: '终端', content: { kind: 'builtin', type: 'terminal' } });
    runtime.mountWorktableTab(instance.id, paneId, { title: 'Git', content: { kind: 'builtin', type: 'scm' } });
    const pushes: ServerPushMessage[] = [];
    const unsubscribe = runtime.subscribe((message) => pushes.push(message));
    const server = await startRuntimeServer(runtime, { host: '127.0.0.1', port: 0, authToken: 'shell-test' });
    const headers = { Authorization: 'Bearer shell-test', 'Content-Type': 'application/json' };
    const terminalUrl = `${server.url}/api/worktable/instances/${instance.id}/panes/${paneId}/terminal`;
    const scmUrl = `${server.url}/api/worktable/instances/${instance.id}/scm`;
    const post = async (url: string, body: Record<string, unknown>) => {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      return { response, body: await response.json() as Record<string, unknown> };
    };
    let stopped = false;
    try {
      const started = await post(terminalUrl, { action: 'start' });
      expect(started.response.status).toBe(200);
      expect(started.body).toMatchObject({ status: 'opened', session: { rootId: 'project', worktableInstanceId: instance.id, paneId, origin: 'user', status: 'running' } });
      expect(JSON.stringify(started.body)).not.toContain(root);
      expect(terminalDriver.processes).toHaveLength(1);

      expect((await post(terminalUrl, { action: 'input', data: 'echo safe\r' })).response.status).toBe(200);
      expect(terminalDriver.processes[0]!.writes).toEqual(['echo safe\r']);
      terminalDriver.processes[0]!.emitData('safe output\r\n');
      const read = await post(terminalUrl, { action: 'read', afterSequence: 0 });
      expect(JSON.stringify(read.body)).toContain('safe output');
      expect(JSON.stringify(read.body)).not.toContain(root);
      expect((await post(terminalUrl, { action: 'resize', cols: 88, rows: 31 })).body).toMatchObject({ status: 'resized' });
      expect(terminalDriver.processes[0]!.sizes).toEqual([{ cols: 88, rows: 31 }]);
      expect((await post(terminalUrl, { action: 'close' })).body).toMatchObject({ status: 'closed' });
      expect(terminalDriver.processes[0]!.killed).toBe(1);
      expect(stoppedJobs).toBe(1);

      const status = await post(scmUrl, { action: 'status' });
      expect(status.response.status).toBe(200);
      expect(status.body).toMatchObject({ rootId: 'project', branch: 'main' });
      const rejectedCommit = await post(scmUrl, { action: 'commit', message: 'reviewed' });
      expect(rejectedCommit.response.status).toBe(400);
      expect(JSON.stringify(rejectedCommit.body)).toMatch(/明确确认/u);
      expect(gitCalls.some((call) => call.args.includes('commit'))).toBe(false);
      const committed = await post(scmUrl, { action: 'commit', message: 'reviewed', confirmed: true });
      expect(committed.response.status).toBe(200);
      expect(committed.body).toMatchObject({ rootId: 'project', commitId: 'a'.repeat(40) });
      const rejectedStage = await post(scmUrl, { action: 'stage', paths: ['paper.txt'] });
      expect(rejectedStage.response.status).toBe(400);
      expect((await post(scmUrl, { action: 'stage', paths: ['paper.txt'], confirmed: true })).response.status).toBe(200);
      const diff = await post(scmUrl, { action: 'diff', paths: ['paper.txt'] });
      expect(diff.response.status).toBe(200);
      expect(JSON.stringify(diff.body)).not.toContain(root);
      const absolutePath = await post(scmUrl, { action: 'diff', paths: [join(root, 'paper.txt')] });
      expect(absolutePath.response.status).toBe(400);
      expect(JSON.stringify(absolutePath.body)).not.toContain(root);
      expect(gitCalls.every((call) => call.executable === 'git' && Array.isArray(call.args))).toBe(true);
      expect(pushes).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'terminal.changed', instanceId: instance.id, paneId, status: 'running' }),
        expect.objectContaining({ type: 'terminal.changed', instanceId: instance.id, paneId, status: 'closed' }),
        expect.objectContaining({ type: 'scm.changed', instanceId: instance.id }),
      ]));
      expect(JSON.stringify(runtime.events.listAll())).not.toContain(root);

      await post(terminalUrl, { action: 'start' });
      expect(terminalDriver.processes).toHaveLength(2);
      await server.close();
      await runtime.stop();
      stopped = true;
      expect(terminalDriver.processes[1]!.killed).toBe(1);
      expect(stoppedJobs).toBe(2);
      expect(runtime.terminals.list().at(-1)).toMatchObject({ status: 'interrupted', error: 'runtime_shutdown' });
    } finally {
      unsubscribe();
      if (!stopped) {
        await server.close().catch(() => undefined);
        await runtime.stop();
      }
    }
  }, 20_000);
});
