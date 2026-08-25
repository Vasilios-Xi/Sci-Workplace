import type {
  ModelDescriptor,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelProviderId,
  ModelRequest,
  ModelUsage,
  ToolDefinition,
} from '@openlab/protocol';
import { parseSseData } from '../deepseek/sse.js';

interface CompatibleChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      reasoning_details?: Array<{ text?: string | null }> | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
  error?: { code?: string; message?: string };
}

export interface OpenAiCompatibleProviderOptions {
  id: string;
  providerId: ModelProviderId;
  baseUrl: string;
  getApiKey(): string | undefined;
  fallbackModels: ModelDescriptor[];
  requiresApiKey: boolean;
  strictModelDiscovery?: boolean;
  requestExtras(request: ModelRequest, nativeModel: string): Record<string, unknown>;
  modelDefaults?(nativeId: string): Partial<ModelDescriptor>;
  requestHeaders?(): Record<string, string>;
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/u, '');
}

function nativeModelId(requested: string, providerId: ModelProviderId): string {
  const prefix = `${providerId}::`;
  return requested.startsWith(prefix) ? requested.slice(prefix.length) : requested;
}

function toMessage(message: ModelMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls ? {
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    } : {}),
    ...(message.reasoningContent !== undefined ? { reasoning_content: message.reasoningContent } : {}),
  };
}

function toTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

function toUsage(usage: NonNullable<CompatibleChunk['usage']>): ModelUsage {
  const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const prompt = usage.prompt_tokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? prompt + (usage.completion_tokens ?? 0),
    cacheHitTokens: cached,
    cacheMissTokens: usage.prompt_cache_miss_tokens ?? Math.max(0, prompt - cached),
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

function finishReason(reason: string | null | undefined): Extract<ModelEvent, { type: 'done' }>['finishReason'] {
  if (reason === 'stop' || reason === 'length' || reason === 'tool_calls' || reason === 'content_filter') return reason;
  if (reason === 'insufficient_system_resource') return 'resource';
  return 'unknown';
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly #options: OpenAiCompatibleProviderOptions;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.id = options.id;
    this.#options = { ...options, baseUrl: normalizedBaseUrl(options.baseUrl) };
  }

  async listModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const key = this.#options.getApiKey();
    if (this.#options.requiresApiKey && !key) return this.#options.fallbackModels;
    try {
      const response = await fetch(`${this.#options.baseUrl}/models`, {
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          'User-Agent': 'Sci-Workplace/0.1.0',
          ...this.#options.requestHeaders?.(),
        },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        if (this.#options.strictModelDiscovery) throw new Error(`${this.#options.id} model discovery failed (${response.status})`);
        return this.#options.fallbackModels;
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) return this.#options.fallbackModels;
      const json = JSON.parse(text) as { data?: Array<{ id?: string }> };
      const ids = [...new Set(json.data?.flatMap((item) => item.id ? [item.id] : []) ?? [])];
      if (ids.length === 0) return this.#options.fallbackModels;
      return ids.map((nativeId) => {
        const fallback = this.#options.fallbackModels.find((model) => model.nativeId === nativeId);
        if (fallback) return fallback;
        return {
          id: `${this.#options.providerId}::${nativeId}`,
          nativeId,
          providerId: this.#options.providerId,
          label: nativeId,
          contextWindow: 128_000,
          supportsThinking: false,
          supportsTools: true,
          supportsVision: /vision|vl|image/iu.test(nativeId),
          reasoning: { mode: 'unsupported', efforts: [], canDisable: false },
          ...this.#options.modelDefaults?.(nativeId),
        } satisfies ModelDescriptor;
      });
    } catch (error) {
      if (this.#options.strictModelDiscovery) throw error;
      return this.#options.fallbackModels;
    }
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const key = this.#options.getApiKey();
    if (this.#options.requiresApiKey && !key) {
      yield { type: 'error', code: 'missing_api_key', message: `${this.#options.id} credential is not configured`, retryable: false };
      return;
    }
    const nativeModel = nativeModelId(request.model, this.#options.providerId);
    const body = {
      model: nativeModel,
      messages: request.messages.map(toMessage),
      tools: request.tools.length > 0 ? request.tools.map(toTool) : undefined,
      tool_choice: request.tools.length > 0 ? 'auto' : undefined,
      max_tokens: request.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...this.#options.requestExtras(request, nativeModel),
    };
    const reasoningBuffers = new Map<number, string>();
    const contentBuffers = new Map<number, string>();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let receivedFrame = false;
      let terminalFrame = false;
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', forwardAbort, { once: true });
      const firstByteTimer = setTimeout(() => controller.abort(new Error(`${this.#options.id} first-byte timeout`)), 30_000);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(new Error(`${this.#options.id} stream idle timeout`)), 60_000);
      };
      const cleanup = () => {
        clearTimeout(firstByteTimer);
        if (idleTimer) clearTimeout(idleTimer);
        signal.removeEventListener('abort', forwardAbort);
      };
      try {
        const response = await fetch(`${this.#options.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
            'Content-Type': 'application/json',
            'User-Agent': 'Sci-Workplace/0.1.0',
            ...this.#options.requestHeaders?.(),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < 2) {
            await response.body?.cancel().catch(() => undefined);
            cleanup();
            await delay(350 * 2 ** attempt, signal);
            continue;
          }
          const raw = (await response.text().catch(() => '')).slice(0, 100_000);
          let message = `${this.#options.id} request failed (${response.status})`;
          try {
            const parsed = JSON.parse(raw) as { error?: { message?: string } };
            if (parsed.error?.message) message = parsed.error.message;
          } catch { /* use bounded fallback */ }
          yield { type: 'error', code: `http_${response.status}`, message, retryable };
          return;
        }
        for await (const data of parseSseData(response.body, controller.signal)) {
          receivedFrame = true;
          clearTimeout(firstByteTimer);
          armIdle();
          if (data === '[DONE]') {
            terminalFrame = true;
            break;
          }
          let chunk: CompatibleChunk;
          try { chunk = JSON.parse(data) as CompatibleChunk; } catch { continue; }
          if (chunk.error) {
            yield { type: 'error', code: chunk.error.code ?? 'provider_error', message: chunk.error.message ?? `${this.#options.id} provider error`, retryable: false };
            return;
          }
          if (chunk.usage) yield { type: 'usage', usage: toUsage(chunk.usage) };
          for (const [choicePosition, choice] of (chunk.choices ?? []).entries()) {
            const choiceIndex = choice.index ?? choicePosition;
            const detailedReasoning = choice.delta?.reasoning_details?.flatMap((item) => item.text ? [item.text] : []).join('') ?? '';
            const directReasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? '';
            if (detailedReasoning) {
              const previous = reasoningBuffers.get(choiceIndex) ?? '';
              const delta = detailedReasoning.startsWith(previous) ? detailedReasoning.slice(previous.length) : detailedReasoning;
              reasoningBuffers.set(choiceIndex, detailedReasoning);
              if (delta) yield { type: 'reasoning_delta', text: delta };
            } else if (directReasoning) {
              yield { type: 'reasoning_delta', text: directReasoning };
            }
            if (choice.delta?.content) {
              if (this.#options.providerId === 'minimax-coding-plan') {
                const previous = contentBuffers.get(choiceIndex) ?? '';
                const delta = choice.delta.content.startsWith(previous) ? choice.delta.content.slice(previous.length) : choice.delta.content;
                contentBuffers.set(choiceIndex, choice.delta.content);
                if (delta) yield { type: 'text_delta', text: delta };
              } else yield { type: 'text_delta', text: choice.delta.content };
            }
            for (const tool of choice.delta?.tool_calls ?? []) {
              yield {
                type: 'tool_call_delta',
                index: tool.index,
                ...(tool.id ? { id: tool.id } : {}),
                ...(tool.function?.name ? { name: tool.function.name } : {}),
                ...(tool.function?.arguments ? { arguments: tool.function.arguments } : {}),
              };
            }
            if (choice.finish_reason) {
              terminalFrame = true;
              yield { type: 'done', finishReason: finishReason(choice.finish_reason) };
            }
          }
        }
        if (!terminalFrame) throw new Error(receivedFrame ? `${this.#options.id} stream ended before completion` : `${this.#options.id} returned no stream data`);
        return;
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        if (!receivedFrame && attempt < 2) {
          cleanup();
          await delay(350 * 2 ** attempt, signal);
          continue;
        }
        yield { type: 'error', code: 'network_error', message: error instanceof Error ? error.message : String(error), retryable: !receivedFrame };
        return;
      } finally {
        cleanup();
      }
    }
  }
}
