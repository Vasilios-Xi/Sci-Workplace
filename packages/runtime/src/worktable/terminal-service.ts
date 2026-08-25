import { createRequire } from 'node:module';
import { basename, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { EventActor, JobRecord, JobSpec } from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { PathGuard } from '../security/path-guard.js';
import { attachWindowsJobObject, type WindowsJobAttachment, type WindowsJobLimits } from '../security/windows-job-host.js';
import { isRecord, toJson } from '../util/json.js';

const SYSTEM_ACTOR: EventActor = { id: 'openlab', kind: 'system', label: 'Sci Workplace Runtime' };
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES_PER_SECOND = 256 * 1024;
const MAX_RETAINED_OUTPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHUNKS = 512;

export type TerminalSessionStatus = 'running' | 'exited' | 'cancelled' | 'interrupted';

export interface TerminalSessionRecord {
  id: string;
  projectId: string;
  rootId: string;
  worktableInstanceId?: string;
  paneId?: string;
  cwd: string;
  shell: string;
  origin: 'user';
  status: TerminalSessionStatus;
  cols: number;
  rows: number;
  outputBytes: number;
  droppedOutputBytes: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
}

export interface TerminalOutputChunk {
  sequence: number;
  data: string;
}

export interface TerminalPtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface TerminalDriver {
  availability(): { available: true } | { available: false; reason: string };
  spawn(input: { executable: string; args: string[]; cwd: string; cols: number; rows: number; env: Record<string, string> }): TerminalPtyProcess;
}

export interface TerminalJobRunner {
  run(spec: JobSpec, actor: EventActor): JobRecord;
  cancel(id: string, actor: EventActor): JobRecord;
}

interface ActiveTerminal {
  pty: TerminalPtyProcess;
  job: WindowsJobAttachment;
  disposables: Array<{ dispose(): void }>;
  windowStartedAt: number;
  windowBytes: number;
}

function defaultEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function defaultDriver(): TerminalDriver {
  const require = createRequire(import.meta.url);
  try {
    const module = require('node-pty') as { spawn?: (file: string, args: string[], options: Record<string, unknown>) => TerminalPtyProcess };
    if (typeof module.spawn !== 'function') throw new Error('node-pty spawn export is missing');
    return {
      availability: () => ({ available: true }),
      spawn: (input) => module.spawn!(input.executable, input.args, {
        name: 'xterm-256color', cwd: input.cwd, cols: input.cols, rows: input.rows, env: input.env,
      }),
    };
  } catch {
    return {
      availability: () => ({ available: false, reason: '交互终端不可用：未安装或无法加载 node-pty。' }),
      spawn: () => { throw new Error('交互终端不可用：未安装或无法加载 node-pty。'); },
    };
  }
}

function dimensions(cols: number | undefined, rows: number | undefined): { cols: number; rows: number } {
  return {
    cols: Math.min(400, Math.max(20, Math.trunc(cols ?? 100))),
    rows: Math.min(200, Math.max(5, Math.trunc(rows ?? 30))),
  };
}

function shellCommand(shell: 'default' | 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'zsh' = 'default'): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    if (shell === 'cmd') return { executable: 'cmd.exe', args: [] };
    if (shell === 'pwsh') return { executable: 'pwsh.exe', args: ['-NoLogo'] };
    if (shell === 'bash' || shell === 'zsh') throw new Error(`Windows 交互终端不支持 ${shell}`);
    if (shell === 'powershell') return { executable: 'powershell.exe', args: ['-NoLogo'] };
    return { executable: process.env.ComSpec || 'powershell.exe', args: [] };
  }
  if (shell === 'powershell' || shell === 'pwsh' || shell === 'cmd') throw new Error(`当前平台不支持 ${shell}`);
  if (shell === 'bash') return { executable: 'bash', args: [] };
  if (shell === 'zsh') return { executable: 'zsh', args: [] };
  return { executable: process.env.SHELL || '/bin/sh', args: [] };
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let prefix = bytes.subarray(0, maxBytes).toString('utf8');
  while (prefix && Buffer.byteLength(prefix, 'utf8') > maxBytes) prefix = prefix.slice(0, -1);
  return prefix;
}

function sessionPayload(value: unknown): TerminalSessionRecord | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.rootId !== 'string' || typeof value.status !== 'string') return undefined;
  return structuredClone(value as unknown as TerminalSessionRecord);
}

export class TerminalService {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
  readonly #driver: TerminalDriver;
  readonly #jobs: TerminalJobRunner | undefined;
  readonly #attachJob: (pid: number, limits: WindowsJobLimits) => WindowsJobAttachment;
  readonly #onChanged: () => void;
  readonly #sessions = new Map<string, TerminalSessionRecord>();
  readonly #active = new Map<string, ActiveTerminal>();
  readonly #outputs = new Map<string, TerminalOutputChunk[]>();
  readonly #outputSequences = new Map<string, number>();
  #shuttingDown = false;

  constructor(options: {
    projectId: string;
    events: SqliteEventStore;
    resolveRoot(rootId: string, intent: 'read' | 'write'): string;
    driver?: TerminalDriver;
    jobs?: TerminalJobRunner;
    attachJob?: (pid: number, limits: WindowsJobLimits) => WindowsJobAttachment;
    onChanged?: () => void;
  }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.#resolveRoot = options.resolveRoot;
    this.#driver = options.driver ?? defaultDriver();
    this.#jobs = options.jobs;
    this.#attachJob = options.attachJob ?? attachWindowsJobObject;
    this.#onChanged = options.onChanged ?? (() => undefined);
    this.replay();
    for (const [id, session] of this.#sessions) {
      if (session.status !== 'running') continue;
      const now = new Date().toISOString();
      const interrupted: TerminalSessionRecord = { ...session, status: 'interrupted', updatedAt: now, completedAt: now, error: 'runtime_restart' };
      this.#sessions.set(id, interrupted);
      this.record('terminal.session_interrupted', interrupted, SYSTEM_ACTOR);
    }
  }

  availability(): { available: true } | { available: false; reason: string } {
    return this.#driver.availability();
  }

  list(): TerminalSessionRecord[] {
    return [...this.#sessions.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map((value) => structuredClone(value));
  }

  get(id: string): TerminalSessionRecord {
    const value = this.#sessions.get(id);
    if (!value) throw new Error('终端会话不存在');
    return structuredClone(value);
  }

  async openUserSession(input: {
    rootId: string;
    worktableInstanceId?: string;
    paneId?: string;
    cwd?: string;
    shell?: 'default' | 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'zsh';
    cols?: number;
    rows?: number;
  }, actor: EventActor): Promise<{ status: 'opened'; session: TerminalSessionRecord } | { status: 'unavailable'; reason: string }> {
    if (actor.kind !== 'user') throw new Error('只有用户可以创建交互终端；Agent 必须提交受控 JobSpec');
    if (this.#shuttingDown) throw new Error('Runtime 正在关闭，不能创建终端');
    const availability = this.availability();
    if (!availability.available) return { status: 'unavailable', reason: availability.reason };
    const cwd = (input.cwd ?? '.').replaceAll('\\', '/');
    if (!cwd || cwd.includes('\0') || isAbsolute(cwd)) throw new Error('终端工作目录必须是 rootId 内的相对路径');
    let root: string;
    try { root = this.#resolveRoot(input.rootId, 'write'); }
    catch { throw new Error('终端工作区根不可用或没有写权限'); }
    let absoluteCwd: string;
    try {
      absoluteCwd = new PathGuard(root).resolveExisting(cwd);
      if (!statSync(absoluteCwd).isDirectory()) throw new Error('终端工作目录不是目录');
    } catch (error) {
      throw new Error(`终端工作目录不可用：${this.safeError(error, root)}`);
    }
    const size = dimensions(input.cols, input.rows);
    const command = shellCommand(input.shell);
    let pty: TerminalPtyProcess;
    try {
      pty = this.#driver.spawn({ ...command, cwd: absoluteCwd, ...size, env: defaultEnvironment() });
    } catch (error) {
      throw new Error(`交互终端启动失败：${this.safeError(error, root)}`);
    }
    let job: WindowsJobAttachment;
    try {
      job = this.#attachJob(pty.pid, { memoryMb: 2_048, cpuMs: 24 * 60 * 60_000, activeProcesses: 32 });
    } catch (error) {
      try { pty.kill(); } catch { /* process already exited */ }
      throw new Error(`交互终端进程树防护启动失败：${this.safeError(error, root)}`);
    }
    const now = new Date().toISOString();
    const session: TerminalSessionRecord = {
      id: randomUUID(), projectId: this.#projectId, rootId: input.rootId, cwd, shell: basename(command.executable), origin: 'user', status: 'running',
      ...(input.worktableInstanceId ? { worktableInstanceId: input.worktableInstanceId } : {}),
      ...(input.paneId ? { paneId: input.paneId } : {}),
      ...size, outputBytes: 0, droppedOutputBytes: 0, createdAt: now, updatedAt: now,
    };
    const active: ActiveTerminal = { pty, job, disposables: [], windowStartedAt: Date.now(), windowBytes: 0 };
    this.#sessions.set(session.id, session);
    this.#active.set(session.id, active);
    this.#outputs.set(session.id, []);
    this.record('terminal.session_opened', session, actor);
    active.disposables.push(pty.onData((data) => this.handleOutput(session.id, data)));
    active.disposables.push(pty.onExit((event) => this.handleExit(session.id, event.exitCode)));
    try {
      await job.ready;
    } catch (error) {
      this.terminate(session.id);
      const failedAt = new Date().toISOString();
      const failed: TerminalSessionRecord = { ...session, status: 'exited', updatedAt: failedAt, completedAt: failedAt, error: this.safeError(error, root) };
      this.#sessions.set(session.id, failed);
      this.record('terminal.session_failed', failed, actor);
      throw error;
    }
    return { status: 'opened', session: structuredClone(session) };
  }

  write(id: string, data: string, actor: EventActor): void {
    if (actor.kind !== 'user') throw new Error('Agent 不得向用户交互终端注入输入；请提交 JobSpec');
    if (!data || data.includes('\0') || Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) throw new Error('终端输入无效或超过 64 KB');
    this.requireActive(id).pty.write(data);
  }

  resize(id: string, cols: number, rows: number, actor: EventActor): TerminalSessionRecord {
    if (actor.kind !== 'user') throw new Error('只有用户界面可以调整交互终端尺寸');
    const active = this.requireActive(id);
    const size = dimensions(cols, rows);
    active.pty.resize(size.cols, size.rows);
    const current = this.require(id);
    const updated = { ...current, ...size, updatedAt: new Date().toISOString() };
    this.#sessions.set(id, updated);
    this.record('terminal.session_resized', updated, actor);
    return structuredClone(updated);
  }

  cancel(id: string, actor: EventActor): TerminalSessionRecord {
    if (actor.kind !== 'user') throw new Error('Agent 不得控制用户交互终端');
    const current = this.require(id);
    if (current.status !== 'running') return structuredClone(current);
    const now = new Date().toISOString();
    const cancelled: TerminalSessionRecord = { ...current, status: 'cancelled', updatedAt: now, completedAt: now, error: 'cancelled_by_user' };
    this.#sessions.set(id, cancelled);
    this.terminate(id);
    this.record('terminal.session_cancelled', cancelled, actor);
    return structuredClone(cancelled);
  }

  readOutput(id: string, afterSequence = 0, limit = 128): { chunks: TerminalOutputChunk[]; droppedOutputBytes: number } {
    const session = this.require(id);
    const boundedLimit = Math.min(512, Math.max(1, Math.trunc(limit)));
    return {
      chunks: (this.#outputs.get(id) ?? []).filter((chunk) => chunk.sequence > afterSequence).slice(0, boundedLimit).map((chunk) => structuredClone(chunk)),
      droppedOutputBytes: session.droppedOutputBytes,
    };
  }

  runAgentJob(spec: JobSpec, actor: EventActor, confirmed: boolean): JobRecord {
    if (actor.kind !== 'agent') throw new Error('runAgentJob 只接受 Agent 受控任务');
    if (!confirmed) throw new Error('Agent JobSpec 必须经过上层审批');
    if (spec.origin !== 'agent') throw new Error('Agent JobSpec origin 必须为 agent');
    if (!this.#jobs) throw new Error('受控 JobService 尚未连接');
    return this.#jobs.run(structuredClone(spec), actor);
  }

  cancelAgentJob(id: string, actor: EventActor, confirmed: boolean): JobRecord {
    if (actor.kind !== 'agent' || !confirmed) throw new Error('取消 Agent Job 必须经过上层审批');
    if (!this.#jobs) throw new Error('受控 JobService 尚未连接');
    return this.#jobs.cancel(id, actor);
  }

  shutdown(): void {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    for (const [id, current] of [...this.#sessions]) {
      if (current.status !== 'running') continue;
      const now = new Date().toISOString();
      const interrupted: TerminalSessionRecord = { ...current, status: 'interrupted', updatedAt: now, completedAt: now, error: 'runtime_shutdown' };
      this.#sessions.set(id, interrupted);
      this.terminate(id);
      this.record('terminal.session_interrupted', interrupted, SYSTEM_ACTOR);
    }
  }

  private require(id: string): TerminalSessionRecord {
    const session = this.#sessions.get(id);
    if (!session) throw new Error('终端会话不存在');
    return session;
  }

  private requireActive(id: string): ActiveTerminal {
    const session = this.require(id);
    const active = this.#active.get(id);
    if (session.status !== 'running' || !active) throw new Error('终端会话未运行');
    return active;
  }

  private handleOutput(id: string, data: string): void {
    const active = this.#active.get(id);
    const current = this.#sessions.get(id);
    if (!active || !current || current.status !== 'running' || !data) return;
    const nowMs = Date.now();
    if (nowMs - active.windowStartedAt >= 1_000) {
      active.windowStartedAt = nowMs;
      active.windowBytes = 0;
    }
    const bytes = Buffer.byteLength(data, 'utf8');
    const allowedBytes = Math.max(0, MAX_OUTPUT_BYTES_PER_SECOND - active.windowBytes);
    const accepted = utf8Prefix(data, allowedBytes);
    const acceptedBytes = Buffer.byteLength(accepted, 'utf8');
    active.windowBytes += acceptedBytes;
    const droppedBytes = Math.max(0, bytes - acceptedBytes);
    const updated: TerminalSessionRecord = {
      ...current,
      outputBytes: current.outputBytes + acceptedBytes,
      droppedOutputBytes: current.droppedOutputBytes + droppedBytes,
      updatedAt: new Date().toISOString(),
    };
    this.#sessions.set(id, updated);
    if (accepted) this.pushOutput(id, accepted);
    if (droppedBytes > 0 && current.droppedOutputBytes === 0) this.record('terminal.output_limited', updated, SYSTEM_ACTOR);
    this.#onChanged();
  }

  private pushOutput(id: string, data: string): void {
    const sequence = (this.#outputSequences.get(id) ?? 0) + 1;
    this.#outputSequences.set(id, sequence);
    const chunks = this.#outputs.get(id) ?? [];
    chunks.push({ sequence, data });
    let retainedBytes = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.data, 'utf8'), 0);
    while (chunks.length > MAX_OUTPUT_CHUNKS || retainedBytes > MAX_RETAINED_OUTPUT_BYTES) {
      const removed = chunks.shift();
      if (!removed) break;
      retainedBytes -= Buffer.byteLength(removed.data, 'utf8');
    }
    this.#outputs.set(id, chunks);
  }

  private handleExit(id: string, exitCode: number): void {
    const current = this.#sessions.get(id);
    if (!current || current.status !== 'running') return;
    const now = new Date().toISOString();
    const exited: TerminalSessionRecord = { ...current, status: 'exited', updatedAt: now, completedAt: now, exitCode };
    this.#sessions.set(id, exited);
    this.terminate(id);
    this.record('terminal.session_exited', exited, SYSTEM_ACTOR);
  }

  private terminate(id: string): void {
    const active = this.#active.get(id);
    if (!active) return;
    this.#active.delete(id);
    for (const disposable of active.disposables) disposable.dispose();
    try { active.pty.kill(); } catch { /* already exited */ }
    active.job.stop();
  }

  private record(kind: string, session: TerminalSessionRecord, actor: EventActor): void {
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind,
      actor,
      provenanceRefs: [session.id, session.rootId],
      payload: toJson(session),
    });
    this.#onChanged();
  }

  private safeError(error: unknown, root: string): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const value of new Set([root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\')])) {
      if (value) message = message.split(value).join(`<root:${this.#projectId}>`);
    }
    return message.slice(0, 2_000);
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (!event.kind.startsWith('terminal.')) continue;
      const session = sessionPayload(event.payload);
      if (session) this.#sessions.set(session.id, session);
    }
  }
}
