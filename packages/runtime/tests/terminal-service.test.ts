import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventActor, JobRecord, JobSpec } from '@openlab/protocol';
import { SqliteEventStore } from '../src/events/event-store.js';
import {
  TerminalService,
  type TerminalDriver,
  type TerminalJobRunner,
  type TerminalPtyProcess,
} from '../src/worktable/terminal-service.js';

const USER: EventActor = { id: 'user', kind: 'user' };
const AGENT: EventActor = { id: 'agent', kind: 'agent' };
const directories: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'openlab-terminal-'));
  directories.push(root);
  return root;
}

afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

class FakePty implements TerminalPtyProcess {
  readonly pid = 42;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killed = 0;
  readonly #data = new Set<(value: string) => void>();
  readonly #exit = new Set<(value: { exitCode: number; signal?: number }) => void>();

  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push({ cols, rows }); }
  kill(): void { this.killed += 1; }
  onData(listener: (data: string) => void) { this.#data.add(listener); return { dispose: () => this.#data.delete(listener) }; }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) { this.#exit.add(listener); return { dispose: () => this.#exit.delete(listener) }; }
  emitData(value: string): void { for (const listener of this.#data) listener(value); }
  emitExit(exitCode: number): void { for (const listener of this.#exit) listener({ exitCode }); }
}

function fakeDriver(pty: FakePty, available = true): TerminalDriver {
  return {
    availability: () => available ? { available: true } : { available: false, reason: 'node-pty unavailable fixture' },
    spawn: () => pty,
  };
}

function serviceFixture(root: string, driver: TerminalDriver, jobs?: TerminalJobRunner) {
  const events = new SqliteEventStore(join(root, 'events.db'));
  let jobStops = 0;
  const service = new TerminalService({
    projectId: 'project', events, resolveRoot: (rootId) => { if (rootId !== 'project') throw new Error('unknown root'); return root; }, driver, jobs,
    attachJob: () => ({ ready: Promise.resolve(), stop: () => { jobStops += 1; } }),
  });
  return { service, events, jobStops: () => jobStops };
}

describe('TerminalService', () => {
  it('reports unavailable when node-pty cannot load instead of creating a fake terminal', async () => {
    const root = temporaryDirectory();
    const fixture = serviceFixture(root, fakeDriver(new FakePty(), false));
    try {
      expect(fixture.service.availability()).toEqual({ available: false, reason: 'node-pty unavailable fixture' });
      await expect(fixture.service.openUserSession({ rootId: 'project' }, AGENT)).rejects.toThrow(/只有用户/u);
      await expect(fixture.service.openUserSession({ rootId: 'project' }, USER)).resolves.toEqual({ status: 'unavailable', reason: 'node-pty unavailable fixture' });
      expect(fixture.service.list()).toEqual([]);
      expect(fixture.events.list('project:project')).toEqual([]);
    } finally { fixture.service.shutdown(); fixture.events.close(); }
  });

  it('isolates user input, rate-limits output, resizes, and kills the process tree on cancel', async () => {
    const root = temporaryDirectory();
    const pty = new FakePty();
    const fixture = serviceFixture(root, fakeDriver(pty));
    try {
      const opened = await fixture.service.openUserSession({ rootId: 'project', cols: 120, rows: 40 }, USER);
      expect(opened.status).toBe('opened');
      if (opened.status !== 'opened') throw new Error('fixture did not open');
      const id = opened.session.id;
      expect(() => fixture.service.write(id, 'whoami\r', AGENT)).toThrow(/不得.*注入/u);
      fixture.service.write(id, 'whoami\r', USER);
      expect(pty.writes).toEqual(['whoami\r']);
      expect(() => fixture.service.resize(id, 80, 24, AGENT)).toThrow(/只有用户/u);
      expect(fixture.service.resize(id, 80, 24, USER)).toMatchObject({ cols: 80, rows: 24 });

      pty.emitData('x'.repeat(300 * 1024));
      const output = fixture.service.readOutput(id);
      expect(Buffer.byteLength(output.chunks.map((chunk) => chunk.data).join(''), 'utf8')).toBeLessThanOrEqual(256 * 1024);
      expect(output.droppedOutputBytes).toBeGreaterThan(0);
      expect(() => fixture.service.cancel(id, AGENT)).toThrow(/不得控制/u);
      expect(fixture.service.cancel(id, USER)).toMatchObject({ status: 'cancelled', error: 'cancelled_by_user' });
      expect(pty.killed).toBe(1);
      expect(fixture.jobStops()).toBe(1);
      const events = fixture.events.list('project:project');
      expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(['terminal.session_opened', 'terminal.output_limited', 'terminal.session_resized', 'terminal.session_cancelled']));
      expect(JSON.stringify(events)).not.toContain(root);
    } finally { fixture.service.shutdown(); fixture.events.close(); }
  });

  it('projects formerly running sessions as interrupted after a runtime restart', async () => {
    const root = temporaryDirectory();
    const firstPty = new FakePty();
    const first = serviceFixture(root, fakeDriver(firstPty));
    const opened = await first.service.openUserSession({ rootId: 'project' }, USER);
    if (opened.status !== 'opened') throw new Error('fixture did not open');
    const second = new TerminalService({
      projectId: 'project', events: first.events, resolveRoot: () => root, driver: fakeDriver(new FakePty()),
      attachJob: () => ({ ready: Promise.resolve(), stop: () => undefined }),
    });
    try {
      expect(second.get(opened.session.id)).toMatchObject({ status: 'interrupted', error: 'runtime_restart' });
      expect(first.events.list('project:project').map((event) => event.kind)).toContain('terminal.session_interrupted');
    } finally {
      second.shutdown();
      first.service.shutdown();
      first.events.close();
    }
  });

  it('routes an approved Agent JobSpec to JobService and never through the PTY', () => {
    const root = temporaryDirectory();
    let received: JobSpec | undefined;
    const record: JobRecord = {
      id: 'job', projectId: 'project', status: 'queued', logBytes: 0, outputs: [], createdAt: new Date().toISOString(),
      spec: { title: 'Agent task', executable: 'node', args: ['--version'], inputs: [], outputs: [], origin: 'agent' },
    };
    const jobs: TerminalJobRunner = {
      run: (spec) => { received = spec; return record; },
      cancel: () => ({ ...record, status: 'cancelled' }),
    };
    const pty = new FakePty();
    const fixture = serviceFixture(root, fakeDriver(pty, false), jobs);
    const spec = structuredClone(record.spec);
    try {
      expect(() => fixture.service.runAgentJob(spec, AGENT, false)).toThrow(/上层审批/u);
      expect(() => fixture.service.runAgentJob(spec, USER, true)).toThrow(/只接受 Agent/u);
      expect(fixture.service.runAgentJob(spec, AGENT, true)).toEqual(record);
      expect(received).toEqual(spec);
      expect(pty.writes).toEqual([]);
      expect(fixture.service.cancelAgentJob('job', AGENT, true)).toMatchObject({ status: 'cancelled' });
    } finally { fixture.service.shutdown(); fixture.events.close(); }
  });
});
