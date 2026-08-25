import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentPreset, AgentTemplate, ContextContribution, JsonValue, PluginManifest, PluginPermission, PluginWorkflowDefinition, PluginWorkflowResult, ToolDefinition, ToolExecutionResult } from '@openlab/protocol';
import { attachWindowsJobObject, type WindowsJobAttachment } from '../security/windows-job-host.js';
import { physicalAsarPath } from '../util/asar.js';

interface PendingRpc {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface PluginDescription {
  apiVersion: 1 | 2 | 3;
  tools: Array<Omit<ToolDefinition, 'source' | 'sourceId'>>;
  workflows: PluginWorkflowDefinition[];
  agentTemplates: AgentTemplate[];
  agentPresets: AgentPreset[];
  hasContext: boolean;
}

export interface PluginInvocationContext {
  projectId: string;
  sessionId: string;
  agentId?: string;
  traceId?: string;
  capabilities: PluginPermission[];
  jobId?: string;
  worktableInstanceId?: string;
}

export interface PluginHostCall {
  pluginId: string;
  invocationId: string;
  method: string;
  params: Record<string, unknown>;
  context: PluginInvocationContext;
  signal?: AbortSignal;
}

export type PluginHostCallHandler = (request: PluginHostCall) => Promise<unknown>;

export class PluginProcess {
  readonly manifest: PluginManifest;
  readonly root: string;
  readonly #projectRoot: string;
  readonly #settings: Record<string, JsonValue>;
  #child: ChildProcessWithoutNullStreams | undefined;
  #job: WindowsJobAttachment | undefined;
  #stderr = '';
  #stdoutBuffer = '';
  #nextId = 1;
  #stopping = false;
  #crashHandler: ((error: Error) => void) | undefined;
  #crashError: Error | undefined;
  #hostHandler: PluginHostCallHandler | undefined;
  readonly #pending = new Map<number, PendingRpc>();
  readonly #invocations = new Map<string, { context: PluginInvocationContext; signal?: AbortSignal }>();

  constructor(options: { manifest: PluginManifest; root: string; projectRoot: string; settings?: Record<string, JsonValue>; hostHandler?: PluginHostCallHandler }) {
    this.manifest = options.manifest;
    this.root = options.root;
    this.#projectRoot = options.projectRoot;
    this.#settings = options.settings ?? {};
    this.#hostHandler = options.hostHandler;
  }

  async start(signal?: AbortSignal): Promise<PluginDescription> {
    if (this.#child) return await this.call<PluginDescription>('describe', undefined, 20_000, signal);
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    this.#stderr = '';
    this.#stdoutBuffer = '';
    this.#stopping = false;
    this.#crashError = undefined;
    const compiledRunner = physicalAsarPath(fileURLToPath(new URL('./plugin-runner.js', import.meta.url)));
    const runner = existsSync(compiledRunner) ? compiledRunner : physicalAsarPath(fileURLToPath(new URL('./plugin-runner.ts', import.meta.url)));
    const readRoots = [dirname(runner), this.root];
    const legacyApi = (this.manifest.apiVersion ?? 1) === 1;
    if (legacyApi && this.manifest.permissions.includes('project:read')) readRoots.push(this.#projectRoot);
    const nodeArgs = ['--experimental-transform-types', '--permission', ...readRoots.map((path) => `--allow-fs-read=${resolve(path)}`)];
    if (legacyApi && this.manifest.permissions.includes('project:write')) nodeArgs.push(`--allow-fs-write=${resolve(this.#projectRoot)}`);
    if (this.manifest.permissions.includes('process:spawn')) nodeArgs.push('--allow-child-process');
    nodeArgs.push(runner, this.root, this.manifest.entry);
    this.#child = spawn(process.execPath, nodeArgs, {
      cwd: this.root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        ...(process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE } : {}),
        OPENLAB_PLUGIN_HOST: '1',
        OPENLAB_PLUGIN_NETWORK: this.manifest.permissions.includes('network') ? '1' : '0',
      },
    });
    // Electron's Node-compatible host may create one internal helper on Windows.
    // Node's permission model still denies plugin child_process APIs unless the
    // manifest explicitly grants process:spawn, so two job slots do not widen
    // the plugin API surface.
    this.#job = attachWindowsJobObject(this.#child.pid!, { memoryMb: 768, cpuMs: 30 * 60_000, activeProcesses: this.manifest.permissions.includes('process:spawn') ? 8 : 2 });
    this.#child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.#child.stderr.on('data', (chunk: Buffer) => { this.#stderr = `${this.#stderr}${chunk.toString('utf8')}`.slice(-16_000); });
    this.#child.once('exit', () => {
      this.#job?.stop();
      this.#job = undefined;
      const error = new Error(`插件进程已退出：${this.manifest.id}${this.#stderr.trim() ? `\n${this.#stderr.trim()}` : ''}`);
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      this.#child = undefined;
      this.reportCrash(error);
    });
    try { await this.#job.ready; }
    catch (error) {
      this.#child?.kill();
      this.#child = undefined;
      this.#job?.stop();
      this.#job = undefined;
      const detail = this.#stderr.trim();
      throw detail ? new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`) : error;
    }
    try {
      await this.call('settings.initialize', { settings: this.#settings }, 20_000, signal);
      return await this.call<PluginDescription>('describe', undefined, 20_000, signal);
    } catch (error) {
      // A candidate that fails its startup contract is never handed to the
      // manager, so it must tear itself down here rather than relying on a
      // later deactivate/stop call.
      this.#stopping = true;
      const child = this.#child;
      const exited = child && child.exitCode === null
        ? new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()))
        : Promise.resolve();
      child?.kill();
      this.#job?.stop();
      await Promise.race([exited, new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
      this.#job = undefined;
      if (this.#child === child) this.#child = undefined;
      throw error;
    }
  }

  async execute(name: string, input: Record<string, JsonValue>, context: PluginInvocationContext, signal?: AbortSignal, timeoutMs = 20_000): Promise<ToolExecutionResult> {
    return await this.withInvocation(context, async (invocationId) => await this.call<ToolExecutionResult>('tool.execute', {
      name,
      input,
      context: (this.manifest.apiVersion ?? 1) !== 1
        ? { ...context, invocationId }
        : { projectRoot: this.#projectRoot, sessionId: context.sessionId, agentId: context.agentId ?? '', traceId: context.traceId ?? '' },
    }, timeoutMs, signal, invocationId), signal);
  }

  async collectContext(input: PluginInvocationContext, signal?: AbortSignal): Promise<ContextContribution[]> {
    return await this.withInvocation(input, async (invocationId) => await this.call<ContextContribution[]>('context.collect', (this.manifest.apiVersion ?? 1) !== 1
      ? { ...input, invocationId }
      : { projectRoot: this.#projectRoot, sessionId: input.sessionId, agentId: input.agentId ?? '' }, 20_000, signal, invocationId), signal);
  }

  async runWorkflow(
    workflowId: string,
    input: Record<string, JsonValue>,
    context: PluginInvocationContext,
    jobId: string,
    resume: boolean,
    signal?: AbortSignal,
  ): Promise<PluginWorkflowResult> {
    return await this.withInvocation({ ...context, jobId }, async (invocationId) => await this.call<PluginWorkflowResult>('workflow.run', {
      workflowId,
      input,
      context: { ...context, invocationId, jobId, resume },
    }, 30 * 60_000, signal, invocationId), signal);
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    const exited = new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()));
    await this.call('dispose', undefined, 1_500).catch(() => undefined);
    if (child.exitCode === null) child.kill();
    await Promise.race([exited, new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
    this.#job?.stop();
    this.#job = undefined;
    this.#child = undefined;
  }

  setCrashHandler(handler: (error: Error) => void): void {
    this.#crashHandler = handler;
    if (this.#crashError) queueMicrotask(() => handler(this.#crashError!));
  }

  setHostHandler(handler: PluginHostCallHandler): void {
    this.#hostHandler = handler;
  }

  private async withInvocation<T>(context: PluginInvocationContext, run: (invocationId: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const invocationId = randomUUID();
    this.#invocations.set(invocationId, { context: structuredClone(context), ...(signal ? { signal } : {}) });
    try { return await run(invocationId); }
    finally { this.#invocations.delete(invocationId); }
  }

  private call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 20_000, signal?: AbortSignal, invocationId?: string): Promise<T> {
    const child = this.#child;
    if (!child) throw new Error(`插件尚未启动：${this.manifest.id}`);
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const id = this.#nextId++;
    return new Promise<T>((resolvePromise, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        cleanup();
        const error = new Error(`插件 RPC 超时：${this.manifest.id}/${method}`);
        reject(error);
        if (invocationId) this.cancelInvocation(child, id, invocationId, 'timeout');
        else this.terminateForRpcFailure(child, error);
      }, timeoutMs);
      const abort = () => {
        this.#pending.delete(id);
        cleanup();
        const reason = signal?.reason ?? new DOMException('Aborted', 'AbortError');
        reject(reason);
        if (invocationId) this.cancelInvocation(child, id, invocationId, 'cancelled');
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => { cleanup(); resolvePromise(value as T); },
        reject: (error) => { cleanup(); reject(error); },
        timer,
      });
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`); }
      catch (error) {
        this.#pending.delete(id);
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private cancelInvocation(child: ChildProcessWithoutNullStreams, rpcId: number, invocationId: string, reason: 'cancelled' | 'timeout'): void {
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'invocation.cancel', params: { invocationId, reason } })}\n`); }
    catch { /* the exit handler will settle outstanding RPCs */ }
    // Keep a short-lived tombstone for the cancelled RPC. A cooperative
    // plugin responds after its invocation AbortSignal fires, which clears the
    // timer in onLine(). A plugin that ignores cancellation is terminated so
    // it cannot retain host calls, memory, or project handles indefinitely.
    const graceTimer = setTimeout(() => {
      if (!this.#pending.delete(rpcId) || this.#child !== child || child.exitCode !== null) return;
      child.kill();
      this.#job?.stop();
    }, 25);
    graceTimer.unref();
    this.#pending.set(rpcId, { resolve: () => undefined, reject: () => undefined, timer: graceTimer });
  }

  private terminateForRpcFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    this.reportCrash(error);
    child.kill();
    this.#job?.stop();
  }

  private reportCrash(error: Error): void {
    if (this.#stopping || this.#crashError) return;
    this.#crashError = error;
    this.#crashHandler?.(error);
  }

  private onLine(line: string): void {
    let response: { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
    try { response = JSON.parse(line) as typeof response; } catch { return; }
    if (typeof response.id === 'string' && response.method === 'host.call') {
      void this.handleHostCall(response.id, response.params);
      return;
    }
    if (typeof response.id !== 'number') return;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) pending.reject(new Error(response.error.message ?? '插件 RPC 失败'));
    else pending.resolve(response.result);
  }

  private async handleHostCall(id: string, envelope?: Record<string, unknown>): Promise<void> {
    const child = this.#child;
    if (!child) return;
    try {
      if (!this.#hostHandler) throw new Error('插件宿主桥尚未初始化');
      const invocationId = typeof envelope?.invocationId === 'string' ? envelope.invocationId : '';
      const method = typeof envelope?.method === 'string' ? envelope.method : '';
      const params = envelope?.params && typeof envelope.params === 'object' && !Array.isArray(envelope.params)
        ? envelope.params as Record<string, unknown>
        : {};
      const invocation = this.#invocations.get(invocationId);
      if (!invocation || !method) throw new Error('插件宿主调用上下文无效或已过期');
      const result = await this.#hostHandler({ pluginId: this.manifest.id, invocationId, method, params, context: structuredClone(invocation.context), ...(invocation.signal ? { signal: invocation.signal } : {}) });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    } catch (error) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32_001, message: error instanceof Error ? error.message : String(error) } })}\n`);
    }
  }

  private onStdout(chunk: Buffer): void {
    this.#stdoutBuffer += chunk.toString('utf8');
    const maximumLineBytes = 2 * 1024 * 1024;
    while (true) {
      const boundary = this.#stdoutBuffer.indexOf('\n');
      if (boundary < 0) break;
      if (Buffer.byteLength(this.#stdoutBuffer.slice(0, boundary), 'utf8') > maximumLineBytes) {
        this.#stderr = `${this.#stderr}\n插件 RPC 单行输出超过 2 MB 上限`.slice(-16_000);
        this.#child?.kill();
        return;
      }
      const line = this.#stdoutBuffer.slice(0, boundary).replace(/\r$/u, '');
      this.#stdoutBuffer = this.#stdoutBuffer.slice(boundary + 1);
      this.onLine(line);
    }
    if (Buffer.byteLength(this.#stdoutBuffer, 'utf8') > maximumLineBytes) {
      this.#stderr = `${this.#stderr}\n插件 RPC 单行输出超过 2 MB 上限`.slice(-16_000);
      this.#child?.kill();
    }
  }
}
