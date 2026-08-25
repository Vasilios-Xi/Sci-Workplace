import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import type { EventActor } from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { PathGuard } from '../security/path-guard.js';
import { spawnWithResourceLimits } from '../security/windows-job-host.js';
import { toJson } from '../util/json.js';

const MAX_PATHS = 500;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ScmStatusEntry {
  path: string;
  index: string;
  worktree: string;
  originalPath?: string;
}

export interface ScmStatus {
  rootId: string;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  clean: boolean;
  entries: ScmStatusEntry[];
}

export interface ScmDiff {
  rootId: string;
  staged: boolean;
  paths: string[];
  content: string;
  sha256: string;
  bytes: number;
  truncated: boolean;
}

export interface ScmCommitResult {
  rootId: string;
  commitId: string;
  status: ScmStatus;
}

export interface ScmCommandInput {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ScmCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ScmCommandExecutor = (input: ScmCommandInput) => Promise<ScmCommandResult>;

function defaultExecutor(input: ScmCommandInput): Promise<ScmCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnWithResourceLimits(input.executable, input.args, {
      cwd: input.cwd,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
      },
      limits: { memoryMb: 512, cpuMs: input.timeoutMs, activeProcesses: 8 },
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      run();
    };
    const failForOutput = () => finish(() => {
      child.kill();
      reject(new Error('Git 输出超过 4 MB 安全上限'));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length + stderr.length > MAX_COMMAND_BYTES) failForOutput();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderr = Buffer.concat([stderr, chunk]);
      if (stdout.length + stderr.length > MAX_COMMAND_BYTES) failForOutput();
    });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code) => finish(() => resolvePromise({ exitCode: code ?? -1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') })));
    child.stdin.end();
    const timer = setTimeout(() => finish(() => {
      child.kill();
      reject(new Error('Git 操作超时'));
    }), input.timeoutMs);
    const abort = () => finish(() => {
      child.kill();
      reject(input.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    });
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener('abort', abort, { once: true });
  });
}

function safeRootId(rootId: string): string {
  const normalized = rootId.trim();
  if (!normalized || normalized.length > 200 || /[\0\r\n]/u.test(normalized)) throw new Error('SCM rootId 无效');
  return normalized;
}

function safePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!normalized || normalized.includes('\0') || isAbsolute(normalized) || /^[a-zA-Z]:/u.test(normalized) || normalized.split('/').includes('..')) throw new Error('SCM 路径必须是 rootId 根目录内的相对路径');
  return normalized;
}

function safePaths(paths: string[] | undefined, required: boolean): string[] {
  const values = [...new Set((paths ?? []).map(safePath))];
  if (required && values.length === 0) throw new Error('SCM 写操作必须指定至少一个相对路径');
  if (values.length > MAX_PATHS) throw new Error(`SCM 单次操作最多支持 ${MAX_PATHS} 个路径`);
  return values;
}

function cleanLabel(value: string, fallback = ''): string {
  return value.replace(/[\0\r\n]/gu, ' ').trim().slice(0, 300) || fallback;
}

function parseBranch(value: string): Pick<ScmStatus, 'branch' | 'upstream' | 'ahead' | 'behind'> {
  const line = value.replace(/^##\s*/u, '').trim();
  const unborn = line.match(/^No commits yet on\s+(.+)$/u);
  if (unborn) return { branch: cleanLabel(unborn[1]!, 'unborn'), ahead: 0, behind: 0 };
  const detached = line.match(/^HEAD\s+\(no branch\)$/u);
  if (detached) return { branch: 'HEAD', ahead: 0, behind: 0 };
  const match = line.match(/^(.+?)(?:\.\.\.([^\s]+))?(?:\s+\[([^\]]+)\])?$/u);
  const branch = cleanLabel(match?.[1] ?? line, 'unknown');
  const upstream = match?.[2] ? cleanLabel(match[2]) : undefined;
  const counters = match?.[3] ?? '';
  const ahead = Number(counters.match(/ahead\s+(\d+)/u)?.[1] ?? 0);
  const behind = Number(counters.match(/behind\s+(\d+)/u)?.[1] ?? 0);
  return { branch, ...(upstream ? { upstream } : {}), ahead, behind };
}

function parseStatus(rootId: string, output: string): ScmStatus {
  const records = output.split('\0');
  const header = records[0]?.startsWith('## ') ? records.shift()! : '## unknown';
  const entries: ScmStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw new Error('Git status 返回了无法解析的记录');
    const indexStatus = record[0]!;
    const worktreeStatus = record[1]!;
    const path = safePath(record.slice(3));
    const entry: ScmStatusEntry = { path, index: indexStatus, worktree: worktreeStatus };
    if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
      const original = records[index + 1];
      if (!original) throw new Error('Git status 重命名记录不完整');
      entry.originalPath = safePath(original);
      index += 1;
    }
    entries.push(entry);
  }
  const branch = parseBranch(header);
  return { rootId, ...branch, clean: entries.length === 0, entries };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function redactRoot(value: string, root: string, rootId: string): string {
  let output = value;
  for (const candidate of new Set([root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\')])) {
    if (!candidate) continue;
    output = output.replace(new RegExp(escapeRegExp(candidate), process.platform === 'win32' ? 'giu' : 'gu'), `<root:${rootId}>`);
  }
  return output;
}

function requireApproval(_actor: EventActor, confirmed: boolean, operation: string): void {
  if (!confirmed) throw new Error(`SCM ${operation} 必须经过用户明确确认`);
}

export class ScmService {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #resolveRoot: (rootId: string, intent: 'read' | 'write') => string;
  readonly #gitExecutable: string;
  readonly #execute: ScmCommandExecutor;

  constructor(options: {
    projectId: string;
    events: SqliteEventStore;
    resolveRoot(rootId: string, intent: 'read' | 'write'): string;
    gitExecutable?: string;
    execute?: ScmCommandExecutor;
  }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.#resolveRoot = options.resolveRoot;
    this.#gitExecutable = options.gitExecutable?.trim() || 'git';
    if (this.#gitExecutable.includes('\0')) throw new Error('Git executable 无效');
    this.#execute = options.execute ?? defaultExecutor;
  }

  async status(rootId: string, actor: EventActor, signal?: AbortSignal): Promise<ScmStatus> {
    const repository = await this.repository(rootId, 'read', signal);
    const status = await this.readStatus(repository, signal);
    this.record('scm.status_read', actor, { rootId: repository.rootId, status });
    return status;
  }

  async diff(rootId: string, input: { staged?: boolean; paths?: string[] } = {}, actor: EventActor, signal?: AbortSignal): Promise<ScmDiff> {
    const repository = await this.repository(rootId, 'read', signal);
    const paths = safePaths(input.paths, false);
    for (const path of paths) new PathGuard(repository.root).resolveForWrite(path);
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', ...(input.staged ? ['--cached'] : []), '--', ...paths];
    const result = await this.command(repository, args, 'diff', signal);
    const bytes = Buffer.byteLength(result, 'utf8');
    const content = bytes > MAX_DIFF_BYTES ? Buffer.from(result, 'utf8').subarray(0, MAX_DIFF_BYTES).toString('utf8') : result;
    const diff: ScmDiff = {
      rootId: repository.rootId, staged: input.staged === true, paths, content,
      sha256: createHash('sha256').update(result).digest('hex'), bytes, truncated: bytes > MAX_DIFF_BYTES,
    };
    this.record('scm.diff_read', actor, { rootId: repository.rootId, staged: diff.staged, paths, sha256: diff.sha256, bytes, truncated: diff.truncated });
    return diff;
  }

  async stage(rootId: string, pathsInput: string[], actor: EventActor, confirmed = false, signal?: AbortSignal): Promise<ScmStatus> {
    requireApproval(actor, confirmed, '暂存');
    const repository = await this.repository(rootId, 'write', signal);
    const paths = this.validateWritePaths(repository.root, pathsInput);
    await this.command(repository, ['add', '--', ...paths], 'stage', signal);
    const status = await this.readStatus(repository, signal);
    this.record('scm.index_changed', actor, { rootId: repository.rootId, operation: 'stage', paths, confirmed });
    return status;
  }

  async unstage(rootId: string, pathsInput: string[], actor: EventActor, confirmed = false, signal?: AbortSignal): Promise<ScmStatus> {
    requireApproval(actor, confirmed, '取消暂存');
    const repository = await this.repository(rootId, 'write', signal);
    const paths = this.validateWritePaths(repository.root, pathsInput);
    const head = await this.repositoryRaw(repository, ['-c', 'color.ui=false', 'rev-parse', '--verify', 'HEAD'], signal);
    const args = head.exitCode === 0
      ? ['restore', '--staged', '--', ...paths]
      : ['rm', '--cached', '--ignore-unmatch', '--', ...paths];
    await this.command(repository, args, 'unstage', signal);
    const status = await this.readStatus(repository, signal);
    this.record('scm.index_changed', actor, { rootId: repository.rootId, operation: 'unstage', paths, confirmed });
    return status;
  }

  async commit(rootId: string, messageInput: string, actor: EventActor, confirmed = false, signal?: AbortSignal): Promise<ScmCommitResult> {
    requireApproval(actor, confirmed, '提交');
    const message = messageInput.trim();
    if (!message || message.length > 10_000 || message.includes('\0')) throw new Error('Git commit message 必须为 1–10,000 个字符');
    const repository = await this.repository(rootId, 'write', signal);
    const nullHooks = process.platform === 'win32' ? 'NUL' : '/dev/null';
    await this.command(repository, ['-c', `core.hooksPath=${nullHooks}`, '-c', 'commit.gpgSign=false', 'commit', '--message', message], 'commit', signal);
    const commitId = (await this.command(repository, ['rev-parse', 'HEAD'], 'rev-parse', signal)).trim();
    if (!/^[a-f0-9]{40,64}$/u.test(commitId)) throw new Error('Git 返回了无效 commit ID');
    const status = await this.readStatus(repository, signal);
    this.record('scm.commit_created', actor, { rootId: repository.rootId, commitId, message: redactRoot(message, repository.root, repository.rootId), confirmed });
    return { rootId: repository.rootId, commitId, status };
  }

  private validateWritePaths(root: string, paths: string[]): string[] {
    const values = safePaths(paths, true);
    const guard = new PathGuard(root);
    for (const path of values) guard.resolveForWrite(path);
    return values;
  }

  private async repository(rootIdInput: string, intent: 'read' | 'write', signal?: AbortSignal): Promise<{ rootId: string; root: string }> {
    const rootId = safeRootId(rootIdInput);
    let root: string;
    try { root = this.#resolveRoot(rootId, intent); }
    catch { throw new Error('SCM 工作区根不可用或权限不足'); }
    let guardedRoot: string;
    try { guardedRoot = new PathGuard(root).resolveExisting('.'); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Git 仓库根目录不可用：${redactRoot(message, root, rootId).slice(0, 2_000)}`);
    }
    let result: ScmCommandResult;
    try { result = await this.raw(guardedRoot, ['rev-parse', '--show-toplevel'], signal); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Git 仓库验证失败：${redactRoot(message, guardedRoot, rootId).slice(0, 2_000)}`);
    }
    if (result.exitCode !== 0) throw new Error(`Git 仓库验证失败：${redactRoot(result.stderr, guardedRoot, rootId).trim().slice(0, 2_000) || `退出代码 ${result.exitCode}`}`);
    let topLevel: string;
    try { topLevel = realpathSync.native(result.stdout.trim()); }
    catch { throw new Error('Git 返回的仓库根目录无效'); }
    const relativeRoot = relative(realpathSync.native(guardedRoot), topLevel);
    if (relativeRoot !== '') throw new Error('rootId 必须直接指向 Git 仓库根目录');
    return { rootId, root: guardedRoot };
  }

  private async readStatus(repository: { rootId: string; root: string }, signal?: AbortSignal): Promise<ScmStatus> {
    const output = await this.command(repository, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], 'status', signal);
    return parseStatus(repository.rootId, output);
  }

  private async command(repository: { rootId: string; root: string }, args: string[], operation: string, signal?: AbortSignal): Promise<string> {
    const result = await this.repositoryRaw(repository, ['-c', 'color.ui=false', '-c', 'core.quotepath=false', ...args], signal);
    const stdout = redactRoot(result.stdout, repository.root, repository.rootId);
    const stderr = redactRoot(result.stderr, repository.root, repository.rootId);
    if (result.exitCode !== 0) throw new Error(`Git ${operation} 失败（${result.exitCode}）：${stderr.trim().slice(0, 2_000) || '无诊断输出'}`);
    return stdout;
  }

  private async repositoryRaw(repository: { rootId: string; root: string }, args: string[], signal?: AbortSignal): Promise<ScmCommandResult> {
    try { return await this.raw(repository.root, args, signal); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(redactRoot(message, repository.root, repository.rootId).slice(0, 2_000));
    }
  }

  private async raw(cwd: string, args: string[], signal?: AbortSignal): Promise<ScmCommandResult> {
    if (args.some((arg) => typeof arg !== 'string' || arg.length > 16_384 || arg.includes('\0'))) throw new Error('Git 参数无效');
    return await this.#execute({ executable: this.#gitExecutable, args: [...args], cwd, timeoutMs: DEFAULT_TIMEOUT_MS, ...(signal ? { signal } : {}) });
  }

  private record(kind: string, actor: EventActor, payload: Record<string, unknown>): void {
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind,
      actor,
      provenanceRefs: [String(payload.rootId ?? '')].filter(Boolean),
      payload: toJson(payload),
    });
  }
}
