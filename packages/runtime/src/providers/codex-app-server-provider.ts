import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type {
  ModelDescriptor,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  OAuthAccountSummary,
  ProviderOAuthStartResult,
  ReasoningEffort,
} from '@openlab/protocol';

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

type NotificationListener = (notification: JsonRpcNotification) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function nestedString(value: unknown, ...paths: string[][]): string | undefined {
  for (const path of paths) {
    let current = value;
    for (const segment of path) {
      if (!isRecord(current)) { current = undefined; break; }
      current = current[segment];
    }
    if (typeof current === 'string' && current) return current;
  }
  return undefined;
}

class JsonRpcProcess {
  readonly #command: string;
  #process: ChildProcessWithoutNullStreams | undefined;
  #buffer = '';
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #listeners = new Set<NotificationListener>();
  #starting: Promise<void> | undefined;

  constructor(command: string) {
    this.#command = command;
  }

  async start(): Promise<void> {
    if (this.#process && !this.#process.killed) return;
    if (this.#starting) return await this.#starting;
    this.#starting = this.startProcess();
    try { await this.#starting; }
    finally { this.#starting = undefined; }
  }

  async request<T>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
    await this.start();
    const child = this.#process;
    if (!child || child.killed) throw new Error('Codex App Server is not running');
    const id = this.#nextId++;
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return await result;
  }

  notify(method: string, params: unknown = {}): void {
    const child = this.#process;
    if (!child || child.killed) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  onNotification(listener: NotificationListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    const child = this.#process;
    this.#process = undefined;
    this.rejectAll(new Error('Codex App Server stopped'));
    if (!child || child.killed) return;
    child.stdin.end();
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (!child.killed) child.kill('SIGKILL');
  }

  private async startProcess(): Promise<void> {
    const child = spawn(this.#command, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    });
    this.#process = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.resume();
    child.once('exit', (code, signal) => {
      if (this.#process === child) this.#process = undefined;
      this.rejectAll(new Error(`Codex App Server exited (${code ?? signal ?? 'unknown'})`));
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve(); }, 120);
      const onError = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => { clearTimeout(timer); child.off('error', onError); };
      child.once('error', onError);
    });
    await this.requestWithoutStart('initialize', {
      clientInfo: { name: 'sci_workplace_harness', title: 'Sci Workplace', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, 15_000);
    this.notify('initialized');
  }

  private requestWithoutStart<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const child = this.#process;
    if (!child || child.killed) return Promise.reject(new Error('Codex App Server failed to start'));
    const id = this.#nextId++;
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return result;
  }

  private consume(chunk: string): void {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line) as unknown; } catch { continue; }
      if (!isRecord(message)) continue;
      if (typeof message.id === 'number' && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
        this.handleResponse(message as unknown as JsonRpcResponse);
      } else if (typeof message.method === 'string' && typeof message.id === 'number') {
        this.handleServerRequest(message.id, message.method);
      } else if (typeof message.method === 'string') {
        for (const listener of this.#listeners) listener({ method: message.method, params: message.params });
      }
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) pending.reject(new Error(response.error.message ?? `Codex App Server error ${response.error.code ?? ''}`.trim()));
    else pending.resolve(response.result);
  }

  private handleServerRequest(id: number, method: string): void {
    const child = this.#process;
    if (!child || child.killed) return;
    const approvalMethod = /approval|permission/iu.test(method);
    const payload = approvalMethod
      ? { jsonrpc: '2.0', id, result: { decision: 'decline' } }
      : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported Sci Workplace bridge request' } };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #waiters: Array<{ resolve(value: IteratorResult<T>): void; reject(error: unknown): void }> = [];
  #ended = false;
  #failure: unknown;

  push(value: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.#ended) return;
    this.#failure = error;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.#failure) throw this.#failure;
        if (this.#ended) return { value: undefined, done: true };
        return await new Promise<IteratorResult<T>>((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

function contentToText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content.flatMap((part) => part.type === 'text' ? [part.text] : ['[image omitted by OAuth bridge]']).join('\n');
}

function promptFromMessages(messages: ModelMessage[]): string {
  return messages.map((message) => {
    const body = contentToText(message.content);
    const calls = message.toolCalls?.map((call) => `${call.name}(${call.arguments})`).join('\n');
    return `<openlab-message role="${message.role}"${message.name ? ` name="${message.name}"` : ''}>\n${body}${calls ? `\n${calls}` : ''}\n</openlab-message>`;
  }).join('\n\n');
}

function normalizeEffort(value: unknown): ReasoningEffort | undefined {
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(value)) ? value as ReasoningEffort : undefined;
}

function modelDescriptors(result: unknown): ModelDescriptor[] {
  if (!isRecord(result)) return [];
  const raw = Array.isArray(result.data) ? result.data : Array.isArray(result.models) ? result.models : [];
  return raw.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const nativeId = nestedString(item, ['id'], ['model'], ['slug']);
    if (!nativeId) return [];
    const effortsRaw = Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [];
    const efforts = effortsRaw.flatMap((entry) => {
      const value = typeof entry === 'string' ? entry : isRecord(entry) ? entry.reasoningEffort ?? entry.effort : undefined;
      const normalized = normalizeEffort(value);
      return normalized ? [normalized] : [];
    });
    const defaultEffort = normalizeEffort(item.defaultReasoningEffort);
    const modalities = Array.isArray(item.inputModalities) ? item.inputModalities.map(String) : [];
    return [{
      id: `chatgpt-oauth::${nativeId}`,
      nativeId,
      providerId: 'chatgpt-oauth' as const,
      label: nestedString(item, ['displayName'], ['name']) ?? nativeId,
      contextWindow: typeof item.contextWindow === 'number' ? item.contextWindow : 272_000,
      supportsThinking: efforts.length > 0,
      supportsTools: false,
      supportsVision: modalities.some((value) => /image/iu.test(value)),
      reasoning: efforts.length > 0
        ? { mode: 'levels' as const, efforts, ...(defaultEffort ? { defaultEffort } : {}), canDisable: efforts.includes('none') }
        : { mode: 'unsupported' as const, efforts: [], canDisable: false },
      isDefault: item.isDefault === true || index === 0,
    }];
  });
}

function accountSummary(result: unknown): OAuthAccountSummary | undefined {
  if (!isRecord(result)) return undefined;
  const account = isRecord(result.account) ? result.account : result;
  const label = nestedString(account, ['email'], ['name'], ['label']);
  const plan = nestedString(account, ['planType'], ['plan'], ['subscription']);
  if (!label && !plan && result.account === null) return undefined;
  if (!label && !plan && !nestedString(account, ['type'])) return undefined;
  return { ...(label ? { label } : {}), ...(plan ? { plan } : {}) };
}

export class CodexAppServerProvider implements ModelProvider {
  readonly id = 'chatgpt-oauth';
  readonly #rpc: JsonRpcProcess;
  readonly #workingDirectory: string;

  constructor(options: { command?: string; workingDirectory: string }) {
    this.#rpc = new JsonRpcProcess(options.command ?? 'codex');
    this.#workingDirectory = options.workingDirectory;
    mkdirSync(this.#workingDirectory, { recursive: true });
  }

  async account(): Promise<OAuthAccountSummary | undefined> {
    return accountSummary(await this.#rpc.request('account/read', {}, 15_000));
  }

  async startLogin(): Promise<ProviderOAuthStartResult> {
    const result = await this.#rpc.request<unknown>('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    }, 30_000);
    const authUrl = nestedString(result, ['authUrl'], ['url']);
    return {
      providerId: 'chatgpt-oauth',
      status: 'started',
      ...(authUrl ? { authUrl } : {}),
    };
  }

  async logout(): Promise<void> {
    await this.#rpc.request('account/logout', {}, 15_000);
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return modelDescriptors(await this.#rpc.request('model/list', { limit: 100 }, 20_000));
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const nativeModel = request.model.startsWith('chatgpt-oauth::') ? request.model.slice('chatgpt-oauth::'.length) : request.model;
    const queue = new AsyncQueue<ModelEvent>();
    let threadId = '';
    let turnId = '';
    const removeListener = this.#rpc.onNotification((notification) => {
      const params = isRecord(notification.params) ? notification.params : {};
      const eventThreadId = nestedString(params, ['threadId'], ['thread', 'id']);
      const eventTurnId = nestedString(params, ['turnId'], ['turn', 'id']);
      if (threadId && eventThreadId && eventThreadId !== threadId) return;
      if (turnId && eventTurnId && eventTurnId !== turnId) return;
      if (notification.method === 'item/agentMessage/delta') {
        const text = nestedString(params, ['delta'], ['textDelta'], ['text']);
        if (text) queue.push({ type: 'text_delta', text });
      } else if (notification.method === 'item/reasoning/summaryTextDelta' || notification.method === 'item/reasoning/textDelta') {
        const text = nestedString(params, ['delta'], ['textDelta'], ['text']);
        if (text) queue.push({ type: 'reasoning_delta', text });
      } else if (notification.method === 'thread/tokenUsage/updated') {
        const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : undefined;
        const usage = tokenUsage && isRecord(tokenUsage.last) ? tokenUsage.last : tokenUsage ?? (isRecord(params.usage) ? params.usage : undefined);
        if (usage) {
          const prompt = Number(usage.inputTokens ?? usage.promptTokens ?? 0);
          const completion = Number(usage.outputTokens ?? usage.completionTokens ?? 0);
          const cached = Number(usage.cachedInputTokens ?? usage.cacheHitTokens ?? 0);
          const reasoning = Number(usage.reasoningOutputTokens ?? usage.reasoningTokens ?? 0);
          queue.push({ type: 'usage', usage: { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, cacheHitTokens: cached, cacheMissTokens: Math.max(0, prompt - cached), reasoningTokens: reasoning } });
        }
      } else if (notification.method === 'turn/completed') {
        const status = nestedString(params, ['turn', 'status'], ['status']);
        if (status === 'failed') queue.fail(new Error(nestedString(params, ['turn', 'error', 'message'], ['error', 'message']) ?? 'Codex App Server turn failed'));
        else {
          queue.push({ type: 'done', finishReason: status === 'interrupted' || status === 'cancelled' ? 'unknown' : 'stop' });
          queue.end();
        }
      }
    });
    const onAbort = () => {
      if (threadId && turnId) void this.#rpc.request('turn/interrupt', { threadId, turnId }, 5_000).catch(() => undefined);
      queue.fail(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const thread = await this.#rpc.request<unknown>('thread/start', {
        cwd: this.#workingDirectory,
        model: nativeModel,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        environments: [],
        dynamicTools: [],
        runtimeWorkspaceRoots: [this.#workingDirectory],
        baseInstructions: 'Act only as a conversational model provider for Sci Workplace. Answer from the supplied message transcript. Never inspect files, run commands, use tools, or modify external state.',
        experimentalRawEvents: false,
      }, 30_000);
      threadId = nestedString(thread, ['thread', 'id'], ['threadId'], ['id']) ?? '';
      if (!threadId) throw new Error('Codex App Server did not return a thread id');
      const effort = request.thinking === 'disabled' ? 'none' : request.reasoningEffort;
      const turn = await this.#rpc.request<unknown>('turn/start', {
        threadId,
        model: nativeModel,
        effort,
        ...(request.responseSchema ? { outputSchema: request.responseSchema } : {}),
        input: [{ type: 'text', text: `${promptFromMessages(request.messages)}\n\nRespond to the supplied Sci Workplace messages only. Do not inspect the filesystem or run tools.`, text_elements: [] }],
      }, 30_000);
      turnId = nestedString(turn, ['turn', 'id'], ['turnId'], ['id']) ?? '';
      if (!turnId) throw new Error('Codex App Server did not return a turn id');
      for await (const event of queue) yield event;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      yield { type: 'error', code: 'codex_app_server', message: errorMessage(error), retryable: false };
    } finally {
      signal.removeEventListener('abort', onAbort);
      removeListener();
      if (threadId) await this.#rpc.request('thread/archive', { threadId }, 5_000).catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    await this.#rpc.dispose();
  }
}
