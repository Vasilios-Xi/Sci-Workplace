import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EventActor, JobOutput, JobRecord, JobSpec } from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { PathGuard } from '../security/path-guard.js';
import { spawnWithResourceLimits } from '../security/windows-job-host.js';
import { isRecord, toJson } from '../util/json.js';
import { sha256FileSync } from './file-hash.js';

const SYSTEM_ACTOR: EventActor = { id: 'openlab', kind: 'system', label: 'Sci Workplace Runtime' };
const MAX_JOB_LOG_BYTES = 10 * 1024 * 1024;
const MAX_STAGE_FILES = 10_000;
const MAX_STAGE_BYTES = 1024 * 1024 * 1024;
const MAX_OUTPUT_FILES = 10_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;

interface ActiveJob {
  child: ChildProcessWithoutNullStreams;
  timer: ReturnType<typeof setTimeout>;
}

function mediaType(path: string): string | undefined {
  const lower = path.toLocaleLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.tex')) return 'application/x-tex';
  return undefined;
}

function safeRelative(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/u.test(normalized) || normalized.split('/').includes('..')) throw new Error(`任务路径越界：${path}`);
  return normalized;
}

function safeGlob(pattern: string): string {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/u.test(normalized) || normalized.split('/').includes('..') || normalized.includes('\0')) throw new Error(`任务输出 glob 越界：${pattern}`);
  if (/[^a-zA-Z0-9._/*? -]/u.test(normalized)) throw new Error(`任务输出 glob 包含不支持的字符：${pattern}`);
  return normalized;
}

function globRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') { index += 1; source += '(?:.*/)?'; }
        else source += '.*';
      } else source += '[^/]*';
    } else if (character === '?') source += '[^/]';
    else source += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
  }
  return new RegExp(`${source}$`, 'u');
}

function listFiles(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (lstatSync(absolute).isSymbolicLink()) throw new Error('任务输出不得包含符号链接或目录联接');
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) output.push(relative(root, absolute).replaceAll('\\', '/'));
    }
  };
  visit(root);
  return output;
}

function copyTree(source: string, destination: string, budget: { files: number; bytes: number }): void {
  const stats = lstatSync(source);
  if (stats.isSymbolicLink()) throw new Error('任务输入不得包含符号链接或目录联接');
  if (stats.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) copyTree(join(source, entry), join(destination, entry), budget);
    return;
  }
  if (!stats.isFile()) throw new Error('任务输入包含不支持的文件类型');
  budget.files += 1;
  budget.bytes += stats.size;
  if (budget.files > MAX_STAGE_FILES || budget.bytes > MAX_STAGE_BYTES) throw new Error('任务暂存输入超过 10,000 个文件或 1 GB 上限');
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { force: false, errorOnExist: true });
}

function validateSpec(spec: JobSpec): JobSpec {
  if (!spec.title.trim() || spec.title.length > 500) throw new Error('任务标题必须为 1–500 个字符');
  if (!spec.executable.trim() || spec.executable.length > 4_096 || spec.executable.includes('\0')) throw new Error('任务可执行文件无效');
  if (!Array.isArray(spec.args) || spec.args.length > 256 || spec.args.some((arg) => typeof arg !== 'string' || arg.length > 16_384 || arg.includes('\0'))) throw new Error('任务参数无效');
  if (!Array.isArray(spec.inputs) || spec.inputs.length > 10_000) throw new Error('任务输入数量超过上限');
  if (!Array.isArray(spec.outputs) || spec.outputs.length > 512) throw new Error('任务输出数量超过上限');
  spec.outputs.forEach((output) => {
    if (Boolean(output.path) === Boolean(output.glob)) throw new Error('任务输出必须且只能声明 path 或 glob');
    if (output.path) safeRelative(output.path);
    if (output.glob) safeGlob(output.glob);
    if (output.base) safeRelative(output.base);
  });
  const environment = spec.environment ?? {};
  if (Object.keys(environment).length > 64) throw new Error('任务环境变量超过 64 项上限');
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || value.length > 16_384) throw new Error(`任务环境变量无效：${name}`);
    if (/(?:secret|token|password|credential|api_?key|auth)/iu.test(name)) throw new Error(`任务事件中禁止保存敏感环境变量：${name}`);
  }
  const timeoutMs = Math.min(30 * 60_000, Math.max(1_000, Math.trunc(spec.timeoutMs ?? 10 * 60_000)));
  return { ...structuredClone(spec), title: spec.title.trim(), executable: spec.executable.trim(), timeoutMs };
}

export class JobService {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #root: string;
  readonly #resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
  readonly #resolveToolchainExecutable: (toolchainId: string, executable: string) => string;
  readonly #onChanged: () => void;
  readonly #records = new Map<string, JobRecord>();
  readonly #active = new Map<string, ActiveJob>();
  readonly #waiters = new Map<string, Array<(record: JobRecord) => void>>();
  #shuttingDown = false;

  constructor(options: {
    projectId: string;
    events: SqliteEventStore;
    root: string;
    resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
    resolveToolchainExecutable: (toolchainId: string, executable: string) => string;
    onChanged?: () => void;
  }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.#root = options.root;
    this.#resolveRoot = options.resolveRoot;
    this.#resolveToolchainExecutable = options.resolveToolchainExecutable;
    this.#onChanged = options.onChanged ?? (() => undefined);
    mkdirSync(this.#root, { recursive: true });
    this.replay();
    for (const [id, record] of this.#records) {
      if (!['queued', 'running'].includes(record.status)) continue;
      const interrupted: JobRecord = { ...record, status: 'interrupted', completedAt: new Date().toISOString(), error: 'runtime_restart' };
      this.#records.set(id, interrupted);
      this.append('job.interrupted', interrupted, SYSTEM_ACTOR);
    }
  }

  list(): JobRecord[] {
    return [...this.#records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((record) => structuredClone(record));
  }

  get(id: string): JobRecord {
    return structuredClone(this.require(id));
  }

  rootFor(rootId: string): string | undefined {
    if (!rootId.startsWith('job:')) return undefined;
    const id = rootId.slice(4);
    if (!this.#records.has(id)) return undefined;
    return join(this.#root, id, 'work');
  }

  run(input: JobSpec, actor: EventActor): JobRecord {
    if (this.#shuttingDown) throw new Error('Runtime 正在关闭，不能启动新任务');
    const spec = validateSpec(input);
    if (spec.network) throw new Error('科研任务默认离线；联网任务必须由专用网络插件实现并单独审批');
    const id = randomUUID();
    const record: JobRecord = {
      id, projectId: this.#projectId, spec, status: 'queued', logBytes: 0, outputs: [], createdAt: new Date().toISOString(),
    };
    this.#records.set(id, record);
    this.append('job.queued', record, actor);
    queueMicrotask(() => void this.execute(id, actor));
    return structuredClone(record);
  }

  cancel(id: string, actor: EventActor): JobRecord {
    const record = this.require(id);
    if (!['queued', 'running'].includes(record.status)) return structuredClone(record);
    const active = this.#active.get(id);
    if (active) {
      clearTimeout(active.timer);
      active.child.kill();
      this.#active.delete(id);
    }
    const cancelled: JobRecord = { ...record, status: 'cancelled', completedAt: new Date().toISOString(), error: 'cancelled_by_user' };
    this.#records.set(id, cancelled);
    this.append('job.cancelled', cancelled, actor);
    this.settle(cancelled);
    return structuredClone(cancelled);
  }

  async wait(id: string): Promise<JobRecord> {
    const current = this.require(id);
    if (!['queued', 'running'].includes(current.status)) return structuredClone(current);
    return await new Promise<JobRecord>((resolvePromise) => {
      const values = this.#waiters.get(id) ?? [];
      values.push((record) => resolvePromise(structuredClone(record)));
      this.#waiters.set(id, values);
    });
  }

  shutdown(): void {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    for (const [id, current] of [...this.#records]) {
      if (!['queued', 'running'].includes(current.status)) continue;
      const active = this.#active.get(id);
      if (active) {
        clearTimeout(active.timer);
        this.#active.delete(id);
        active.child.kill();
      }
      const interrupted: JobRecord = {
        ...current,
        status: 'interrupted',
        completedAt: new Date().toISOString(),
        error: 'runtime_shutdown',
      };
      this.#records.set(id, interrupted);
      this.append('job.interrupted', interrupted, SYSTEM_ACTOR);
      this.settle(interrupted);
    }
  }

  log(id: string, offset = 0): { content: string; nextOffset: number } {
    this.require(id);
    const path = join(this.#root, id, 'job.log');
    if (!existsSync(path)) return { content: '', nextOffset: 0 };
    const content = readFileSync(path, 'utf8');
    const start = Math.min(content.length, Math.max(0, Math.trunc(offset)));
    const chunk = content.slice(start, start + 256_000);
    return { content: chunk, nextOffset: start + chunk.length };
  }

  private async execute(id: string, actor: EventActor): Promise<void> {
    if (this.#shuttingDown) return;
    const queued = this.require(id);
    if (queued.status !== 'queued') return;
    const jobRoot = join(this.#root, id);
    const work = join(jobRoot, 'work');
    mkdirSync(work, { recursive: true });
    writeFileSync(join(jobRoot, 'job.log'), '', 'utf8');
    try {
      this.stageInputs(queued.spec, work);
      const executable = queued.spec.toolchainId
        ? this.#resolveToolchainExecutable(queued.spec.toolchainId, queued.spec.executable)
        : queued.spec.executable;
      if (isAbsolute(executable) && (!existsSync(executable) || !statSync(executable).isFile())) throw new Error('任务可执行文件不存在');
      const args = queued.spec.toolchainId && basename(executable).toLocaleLowerCase().includes('latexmk')
        ? this.secureLatexArgs(queued.spec.args)
        : queued.spec.args;
      const running: JobRecord = { ...queued, status: 'running', startedAt: new Date().toISOString(), stage: '运行中' };
      this.#records.set(id, running);
      this.append('job.started', running, actor);
      const environment: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        ...queued.spec.environment,
        OPENLAB_JOB_ID: id,
      };
      const child = spawnWithResourceLimits(executable, args, {
        cwd: work, env: environment, limits: { memoryMb: queued.spec.toolchainId === 'openlab.reader-runtime' ? 4_096 : 2_048, cpuMs: queued.spec.timeoutMs ?? 10 * 60_000, activeProcesses: 16 },
      });
      const timer = setTimeout(() => {
        child.kill();
        this.finishFailed(id, actor, '任务超时');
      }, queued.spec.timeoutMs ?? 10 * 60_000);
      this.#active.set(id, { child, timer });
      child.stdin.end();
      const onData = (chunk: Buffer, channel: 'stdout' | 'stderr') => this.writeLog(id, channel, chunk.toString('utf8'), actor);
      child.stdout.on('data', (chunk: Buffer) => onData(chunk, 'stdout'));
      child.stderr.on('data', (chunk: Buffer) => onData(chunk, 'stderr'));
      child.once('error', (error) => this.finishFailed(id, actor, error.message));
      child.once('exit', (code) => {
        const active = this.#active.get(id);
        if (!active) return;
        clearTimeout(active.timer);
        this.#active.delete(id);
        const current = this.require(id);
        if (current.status !== 'running') return;
        if (code !== 0) { this.finishFailed(id, actor, `任务退出代码：${code ?? 'unknown'}`, code ?? undefined); return; }
        try {
          const outputs = this.collectOutputs(id, current.spec, work);
          const completed: JobRecord = { ...current, status: 'completed', progress: 1, stage: '已完成', outputs, completedAt: new Date().toISOString(), exitCode: 0 };
          this.#records.set(id, completed);
          this.append('job.completed', completed, actor);
          this.settle(completed);
        } catch (error) { this.finishFailed(id, actor, error instanceof Error ? error.message : String(error), 0); }
      });
    } catch (error) {
      this.finishFailed(id, actor, error instanceof Error ? error.message : String(error));
    }
  }

  private stageInputs(spec: JobSpec, work: string): void {
    const budget = { files: 0, bytes: 0 };
    if (spec.inputs.length > 0) {
      for (const input of spec.inputs) {
        const root = this.#resolveRoot(input.ref.rootId, 'read');
        const source = new PathGuard(root).resolveExisting(input.ref.path);
        const destination = join(work, safeRelative(input.destination ?? input.ref.path));
        copyTree(source, destination, budget);
      }
      return;
    }
    if (spec.cwd) {
      const root = this.#resolveRoot(spec.cwd.rootId, 'read');
      const source = new PathGuard(root).resolveExisting(spec.cwd.path);
      if (statSync(source).isDirectory()) {
        for (const entry of readdirSync(source)) copyTree(join(source, entry), join(work, entry), budget);
      } else copyTree(source, join(work, basename(source)), budget);
    }
  }

  private secureLatexArgs(args: string[]): string[] {
    if (args.some((arg) => /(?:^|-)shell-escape$/iu.test(arg) && !/no-shell-escape/iu.test(arg))) throw new Error('TeX 任务禁止 shell escape');
    const output = [...args];
    if (!output.some((arg) => arg === '-no-shell-escape')) output.unshift('-no-shell-escape');
    if (!output.some((arg) => arg.startsWith('-interaction='))) output.unshift('-interaction=nonstopmode');
    if (!output.includes('-halt-on-error')) output.unshift('-halt-on-error');
    if (!output.includes('-file-line-error')) output.unshift('-file-line-error');
    if (!output.some((arg) => arg.startsWith('-synctex='))) output.unshift('-synctex=1');
    return output;
  }

  private collectOutputs(id: string, spec: JobSpec, work: string): JobOutput[] {
    const files = listFiles(work);
    const selected: Array<{ path: string; role: JobOutput['role']; mediaType?: string }> = [];
    for (const output of spec.outputs) {
      if (output.path) {
        const path = safeRelative(output.path);
        if (!files.includes(path)) {
          if (output.required === false) continue;
          throw new Error(`任务缺少声明输出：${path}`);
        }
        selected.push({ path, role: output.role, ...(output.mediaType ? { mediaType: output.mediaType } : {}) });
        continue;
      }
      const pattern = safeGlob(output.glob!);
      const matcher = globRegex(pattern);
      const base = output.base ? safeRelative(output.base).replace(/\/$/u, '') : undefined;
      const matches = files.filter((path) => matcher.test(path) && (!base || path === base || path.startsWith(`${base}/`)));
      if (matches.length === 0 && output.required !== false) throw new Error(`任务输出 glob 没有匹配文件：${pattern}`);
      for (const path of matches) selected.push({ path, role: output.role, ...(output.mediaType ? { mediaType: output.mediaType } : {}) });
    }
    const unique = new Map(selected.map((value) => [`${value.role}\0${value.path.toLocaleLowerCase()}`, value]));
    if (unique.size > MAX_OUTPUT_FILES) throw new Error(`任务输出超过 ${MAX_OUTPUT_FILES} 个文件`);
    let totalBytes = 0;
    return [...unique.values()].sort((left, right) => left.path.localeCompare(right.path)).map((output) => {
      const absolute = new PathGuard(work).resolveExisting(output.path);
      const stats = statSync(absolute);
      if (!stats.isFile()) throw new Error(`任务声明输出不是普通文件：${output.path}`);
      totalBytes += stats.size;
      if (totalBytes > MAX_OUTPUT_BYTES) throw new Error('任务输出总计超过 2 GB');
      return {
        role: output.role, path: output.path, ref: { rootId: `job:${id}`, path: output.path },
        ...(output.mediaType ?? mediaType(output.path) ? { mediaType: output.mediaType ?? mediaType(output.path)! } : {}),
        size: stats.size, sha256: sha256FileSync(absolute),
      };
    });
  }

  private writeLog(id: string, channel: 'stdout' | 'stderr', content: string, actor: EventActor): void {
    const current = this.require(id);
    if (current.status !== 'running') return;
    const remaining = Math.max(0, MAX_JOB_LOG_BYTES - current.logBytes);
    if (remaining === 0) return;
    const encoded = Buffer.from(`[${channel}] ${content}`, 'utf8').subarray(0, remaining);
    appendFileSync(join(this.#root, id, 'job.log'), encoded);
    let progress = current.progress;
    let stage = current.stage;
    const match = content.match(/::openlab-progress\s+([01](?:\.\d+)?)\s*(.*)/u);
    if (match) {
      progress = Math.min(1, Math.max(0, Number(match[1])));
      stage = match[2]?.trim().slice(0, 200) || stage;
    }
    const updated: JobRecord = { ...current, logBytes: current.logBytes + encoded.length, ...(progress === undefined ? {} : { progress }), ...(stage ? { stage } : {}) };
    this.#records.set(id, updated);
    this.#events.append({
      streamId: `job:${id}`, kind: 'job.log', actor,
      ...(current.spec.traceId ? { traceId: current.spec.traceId } : {}),
      payload: toJson({ jobId: id, channel, bytes: encoded.length, totalBytes: updated.logBytes, progress, stage }),
    });
    if (match) this.append('job.progress', updated, actor);
    else this.#onChanged();
  }

  private finishFailed(id: string, actor: EventActor, error: string, exitCode?: number): void {
    const current = this.#records.get(id);
    if (!current || !['queued', 'running'].includes(current.status)) return;
    const active = this.#active.get(id);
    if (active) { clearTimeout(active.timer); active.child.kill(); this.#active.delete(id); }
    const failed: JobRecord = {
      ...current, status: 'failed', completedAt: new Date().toISOString(), error: error.slice(0, 4_000),
      ...(exitCode === undefined ? {} : { exitCode }),
    };
    this.#records.set(id, failed);
    this.append('job.failed', failed, actor);
    this.settle(failed);
  }

  private settle(record: JobRecord): void {
    for (const resolvePromise of this.#waiters.get(record.id) ?? []) resolvePromise(record);
    this.#waiters.delete(record.id);
  }

  private require(id: string): JobRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error('科研任务不存在');
    return record;
  }

  private append(kind: string, record: JobRecord, actor: EventActor): void {
    this.#events.append({
      streamId: `project:${this.#projectId}`, kind, actor,
      ...(record.spec.agentId ? { agentId: record.spec.agentId } : {}),
      ...(record.spec.traceId ? { traceId: record.spec.traceId } : {}),
      provenanceRefs: [record.id, ...record.outputs.map((output) => output.sha256)], payload: toJson(record),
    });
    this.#onChanged();
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (!event.kind.startsWith('job.') || event.kind === 'job.log' || !isRecord(event.payload) || typeof event.payload.id !== 'string') continue;
      this.#records.set(event.payload.id, structuredClone(event.payload as unknown as JobRecord));
    }
  }
}
