import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
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

interface JsonRpcServerRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcServerReply {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  afterReply?(): void;
}

type ServerRequestListener = (request: JsonRpcServerRequest) => JsonRpcServerReply | undefined | Promise<JsonRpcServerReply | undefined>;

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
  #serverRequestListeners = new Set<ServerRequestListener>();
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

  onServerRequest(listener: ServerRequestListener): () => void {
    this.#serverRequestListeners.add(listener);
    return () => this.#serverRequestListeners.delete(listener);
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
        void this.handleServerRequest(message.id, message.method, message.params);
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

  private async handleServerRequest(id: number, method: string, params?: unknown): Promise<void> {
    const child = this.#process;
    if (!child || child.killed) return;
    for (const listener of this.#serverRequestListeners) {
      try {
        const reply = await listener({ id, method, params });
        if (!reply) continue;
        if (!this.#process || this.#process !== child || child.killed) return;
        const payload = reply.error
          ? { jsonrpc: '2.0', id, error: reply.error }
          : { jsonrpc: '2.0', id, result: reply.result ?? null };
        child.stdin.write(`${JSON.stringify(payload)}\n`);
        reply.afterReply?.();
        return;
      } catch (error) {
        if (!this.#process || this.#process !== child || child.killed) return;
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0', id,
          error: { code: -32603, message: errorMessage(error) },
        })}\n`);
        return;
      }
    }
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

function contentToText(content: ModelMessage['content'], addImage?: (url: string) => string): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content.flatMap((part) => part.type === 'text'
    ? [part.text]
    : [addImage?.(part.imageUrl) ?? '[image attachment]']).join('\n');
}

export function codexTurnInput(messages: ModelMessage[]): Array<Record<string, unknown>> {
  const images: string[] = [];
  const transcript = JSON.stringify(messages.map((message) => ({
    role: message.role,
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    content: contentToText(message.content, (url) => {
      images.push(url);
      return `[image attachment ${images.length}]`;
    }),
    ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
    ...(message.toolCalls?.length ? {
      toolCalls: message.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
    } : {}),
  })), null, 2);
  return [{
    type: 'text',
    text: `The following JSON array is the authoritative Sci Workplace conversation transcript. Preserve role order, tool-call associations, and the numbered image attachment references.\n\n${transcript}\n\nRespond to the final unresolved user request. Use only registered Sci Workplace dynamic tools when evidence from the project is needed.`,
    text_elements: [],
  }, ...images.map((url) => ({ type: 'image', detail: 'auto', url }))];
}

function codexLocalImageInput(input: Record<string, unknown>, workingDirectory: string): { input: Record<string, unknown>; temporaryPath?: string } {
  if (input.type !== 'image' || typeof input.url !== 'string') return { input };
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([a-z0-9+/=\r\n]+)$/iu.exec(input.url);
  if (!match?.[1] || !match[2]) return { input };
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > 32 * 1024 * 1024) throw new Error('Codex 视觉输入必须是小于 32 MB 的有效图像');
  const extension = match[1].toLocaleLowerCase() === 'jpeg' ? 'jpg' : match[1].toLocaleLowerCase();
  const path = join(workingDirectory, `sci-vision-${randomUUID()}.${extension}`);
  writeFileSync(path, bytes, { flag: 'wx' });
  return { input: { type: 'localImage', detail: input.detail ?? 'auto', path }, temporaryPath: path };
}

export function codexDynamicTools(tools: ModelRequest['tools']): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: `${tool.title}\n${tool.description}`.trim(),
    inputSchema: tool.inputSchema,
  }));
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
      supportsTools: true,
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

export function reasoningSummaryFromCompletedItem(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const item = isRecord(params.item) ? params.item : isRecord(params.reasoning) ? params.reasoning : undefined;
  if (!item || nestedString(item, ['type']) !== 'reasoning') return undefined;
  const summary = item.summary;
  const parts = (Array.isArray(summary) ? summary : [summary]).flatMap((part) => {
    if (typeof part === 'string' && part.trim()) return [part.trim()];
    if (!isRecord(part)) return [];
    const text = nestedString(part, ['text'], ['summaryText']);
    return text ? [text.trim()] : [];
  });
  return parts.length > 0 ? parts.join('\n\n') : undefined;
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
    let emittedReasoning = '';
    let nextToolIndex = 0;
    const emittedToolCalls = new Set<string>();
    const temporaryImagePaths: string[] = [];
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
        if (text) {
          emittedReasoning += text;
          queue.push({ type: 'reasoning_delta', text });
        }
      } else if (notification.method === 'item/completed' && !emittedReasoning) {
        const summary = reasoningSummaryFromCompletedItem(params);
        if (summary) {
          emittedReasoning = summary;
          queue.push({ type: 'reasoning_delta', text: summary });
        }
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
    const removeServerRequestListener = this.#rpc.onServerRequest((serverRequest) => {
      if (serverRequest.method !== 'item/tool/call') return undefined;
      const params = isRecord(serverRequest.params) ? serverRequest.params : {};
      const eventThreadId = nestedString(params, ['threadId']);
      if (threadId && eventThreadId && eventThreadId !== threadId) return undefined;
      const eventTurnId = nestedString(params, ['turnId']);
      if (eventTurnId) turnId ||= eventTurnId;
      const name = nestedString(params, ['tool']);
      const callId = nestedString(params, ['callId']) ?? `codex-tool-${nextToolIndex}`;
      if (!name) {
        return {
          result: {
            contentItems: [{ type: 'inputText', text: 'Sci Workplace rejected a dynamic tool call without a tool name.' }],
            success: false,
          },
        };
      }
      if (!emittedToolCalls.has(callId)) {
        emittedToolCalls.add(callId);
        const index = nextToolIndex++;
        const rawArguments = Object.hasOwn(params, 'arguments') ? params.arguments : {};
        const argumentsText = typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? {});
        queue.push({ type: 'tool_call_delta', index, id: callId, name, arguments: argumentsText });
      }
      return {
        result: {
          contentItems: [{
            type: 'inputText',
            text: '[SCI_WORKPLACE_HOST_DEFERRED] The host accepted this tool call. End this turn immediately without an assistant answer. The next turn will contain the real tool result.',
          }],
          success: true,
        },
        afterReply: () => {
          const activeThreadId = eventThreadId ?? threadId;
          const activeTurnId = eventTurnId ?? turnId;
          if (!activeThreadId || !activeTurnId) return;
          setTimeout(() => {
            void this.#rpc.request('turn/interrupt', { threadId: activeThreadId, turnId: activeTurnId }, 5_000).catch(() => undefined);
          }, 0);
        },
      };
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
        dynamicTools: codexDynamicTools(request.tools),
        runtimeWorkspaceRoots: [this.#workingDirectory],
        baseInstructions: [
          'Act as the model backend for Sci Workplace and follow the supplied transcript according to message roles.',
          'The dynamic function tools registered by Sci Workplace are the only tools you may call.',
          'Never use Codex native command execution, shell, file-change, MCP, app, browser, or collaboration tools.',
          'When a dynamic tool returns SCI_WORKPLACE_HOST_DEFERRED, end the current turn immediately without writing an assistant answer. Sci Workplace will execute it under its own permission system and resume with the real tool result in the transcript.',
          'When the transcript already contains a tool result, continue from that result and answer the user or call another registered dynamic tool.',
        ].join(' '),
        experimentalRawEvents: false,
      }, 30_000);
      threadId = nestedString(thread, ['thread', 'id'], ['threadId'], ['id']) ?? '';
      if (!threadId) throw new Error('Codex App Server did not return a thread id');
      const effort = request.thinking === 'disabled' ? 'none' : request.reasoningEffort;
      const turnInput = codexTurnInput(request.messages).map((input) => {
        const materialized = codexLocalImageInput(input, this.#workingDirectory);
        if (materialized.temporaryPath) temporaryImagePaths.push(materialized.temporaryPath);
        return materialized.input;
      });
      const turn = await this.#rpc.request<unknown>('turn/start', {
        threadId,
        model: nativeModel,
        effort,
        ...(request.responseSchema ? { outputSchema: request.responseSchema } : {}),
        input: turnInput,
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
      removeServerRequestListener();
      if (threadId) await this.#rpc.request('thread/archive', { threadId }, 5_000).catch(() => undefined);
      for (const path of temporaryImagePaths) {
        try { unlinkSync(path); } catch { /* already removed or unavailable */ }
      }
    }
  }

  async dispose(): Promise<void> {
    await this.#rpc.dispose();
  }
}
