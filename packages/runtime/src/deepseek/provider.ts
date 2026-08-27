import type {
  ModelDescriptor,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelUsage,
  ToolDefinition,
} from '@openlab/protocol';
import { parseSseData } from './sse.js';
import { openAiChatContent } from '../providers/message-content.js';

interface DeepSeekChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
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
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
  error?: { code?: string; message?: string };
}

const FALLBACK_MODELS: ModelDescriptor[] = [
  { id: 'deepseek::deepseek-v4-pro', nativeId: 'deepseek-v4-pro', providerId: 'deepseek', label: 'DeepSeek V4 Pro', contextWindow: 1_000_000, supportsThinking: true, supportsTools: true, supportsVision: false, reasoning: { mode: 'levels', efforts: ['high', 'max'], defaultEffort: 'high', canDisable: true }, isDefault: true },
  { id: 'deepseek::deepseek-v4-flash', nativeId: 'deepseek-v4-flash', providerId: 'deepseek', label: 'DeepSeek V4 Flash', contextWindow: 1_000_000, supportsThinking: true, supportsTools: true, supportsVision: false, reasoning: { mode: 'levels', efforts: ['high', 'max'], defaultEffort: 'high', canDisable: true } },
  { id: 'deepseek::deepseek-v4-flash-vision-exp', nativeId: 'deepseek-v4-flash-vision-exp', providerId: 'deepseek', label: 'DeepSeek V4 Flash Vision', contextWindow: 1_000_000, supportsThinking: true, supportsTools: true, supportsVision: true, reasoning: { mode: 'levels', efforts: ['high', 'max'], defaultEffort: 'high', canDisable: true } },
];

function toDeepSeekMessage(message: ModelMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: openAiChatContent(message.content),
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls ? {
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    } : {}),
    ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
  };
}

function toDeepSeekTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toUsage(usage: NonNullable<DeepSeekChunk['usage']>): ModelUsage {
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    cacheHitTokens: usage.prompt_cache_hit_tokens ?? 0,
    cacheMissTokens: usage.prompt_cache_miss_tokens ?? 0,
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

export class DeepSeekProvider implements ModelProvider {
  readonly id = 'deepseek';
  readonly #getApiKey: () => string | undefined;
  readonly #baseUrl: string;
  readonly #strictModelDiscovery: boolean;

  constructor(options: { getApiKey: () => string | undefined; baseUrl?: string; strictModelDiscovery?: boolean }) {
    this.#getApiKey = options.getApiKey;
    this.#baseUrl = options.baseUrl ?? 'https://api.deepseek.com';
    this.#strictModelDiscovery = options.strictModelDiscovery ?? false;
  }

  async listModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const key = this.#getApiKey();
    if (!key) return FALLBACK_MODELS;
    try {
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
      const response = await fetch(`${this.#baseUrl}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: requestSignal,
      });
      if (!response.ok) {
        if (this.#strictModelDiscovery) throw new Error(`DeepSeek model discovery failed (${response.status})`);
        return FALLBACK_MODELS;
      }
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (declaredLength > 2 * 1024 * 1024) return FALLBACK_MODELS;
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) return FALLBACK_MODELS;
      const json = JSON.parse(text) as { data?: Array<{ id?: string }> };
      const ids = json.data?.flatMap((item) => item.id ? [item.id] : []) ?? [];
      if (ids.length === 0) return FALLBACK_MODELS;
      return ids.map((nativeId) => FALLBACK_MODELS.find((model) => model.nativeId === nativeId) ?? {
        id: `deepseek::${nativeId}`,
        nativeId,
        providerId: 'deepseek',
        label: nativeId,
        contextWindow: 128_000,
        supportsThinking: true,
        supportsTools: true,
        supportsVision: nativeId.includes('vision'),
        reasoning: { mode: 'levels', efforts: ['high', 'max'], defaultEffort: 'high', canDisable: true },
      });
    } catch (error) {
      if (this.#strictModelDiscovery) throw error;
      return FALLBACK_MODELS;
    }
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const key = this.#getApiKey();
    if (!key) {
      yield { type: 'error', code: 'missing_api_key', message: '尚未配置 DeepSeek API Key', retryable: false };
      return;
    }
    const body = {
      model: request.model.startsWith('deepseek::') ? request.model.slice('deepseek::'.length) : request.model,
      messages: request.messages.map(toDeepSeekMessage),
      tools: request.tools.length > 0 ? request.tools.map(toDeepSeekTool) : undefined,
      tool_choice: request.tools.length > 0 ? 'auto' : undefined,
      thinking: { type: request.thinking },
      reasoning_effort: ['max', 'xhigh'].includes(request.reasoningEffort) ? 'max' : 'high',
      max_tokens: request.maxOutputTokens,
      ...(request.responseSchema ? { response_format: { type: 'json_object' } } : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...(request.userId ? { user_id: request.userId } : {}),
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let receivedFrame = false;
      let terminalFrame = false;
      let idleTimer: NodeJS.Timeout | undefined;
      const attemptController = new AbortController();
      const forwardAbort = () => attemptController.abort(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', forwardAbort, { once: true });
      const firstByteTimer = setTimeout(() => attemptController.abort(new Error('DeepSeek 首字节等待超时')), 30_000);
      const clearAttempt = () => {
        clearTimeout(firstByteTimer);
        if (idleTimer) clearTimeout(idleTimer);
        signal.removeEventListener('abort', forwardAbort);
      };
      const armIdleTimeout = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => attemptController.abort(new Error('DeepSeek 流 60 秒未返回新数据')), 60_000);
      };
      try {
        const response = await fetch(`${this.#baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: attemptController.signal,
        });
        if (!response.ok || !response.body) {
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < 2) {
            await response.body?.cancel().catch(() => undefined);
            clearAttempt();
            await delay(350 * 2 ** attempt + Math.floor(Math.random() * 120), signal);
            continue;
          }
          let message = `DeepSeek request failed (${response.status})`;
          try {
            const raw = (await response.text()).slice(0, 100_000);
            const errorBody = JSON.parse(raw) as { error?: { message?: string } };
            if (errorBody.error?.message) message = errorBody.error.message;
          } catch { /* retain the redacted fallback */ }
          yield { type: 'error', code: `http_${response.status}`, message, retryable };
          return;
        }

        for await (const data of parseSseData(response.body, attemptController.signal)) {
          if (!receivedFrame) {
            receivedFrame = true;
            clearTimeout(firstByteTimer);
            armIdleTimeout();
          } else {
            armIdleTimeout();
          }
          if (data === '[DONE]') {
            terminalFrame = true;
            break;
          }
          let chunk: DeepSeekChunk;
          try { chunk = JSON.parse(data) as DeepSeekChunk; } catch { continue; }
          if (chunk.error) {
            yield { type: 'error', code: chunk.error.code ?? 'provider_error', message: chunk.error.message ?? 'DeepSeek 返回未知错误', retryable: false };
            return;
          }
          if (chunk.usage) yield { type: 'usage', usage: toUsage(chunk.usage) };
          for (const choice of chunk.choices ?? []) {
            const reasoning = choice.delta?.reasoning_content;
            const text = choice.delta?.content;
            if (reasoning) yield { type: 'reasoning_delta', text: reasoning };
            if (text) yield { type: 'text_delta', text };
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
        if (!terminalFrame) throw new Error(receivedFrame ? 'DeepSeek 流在完成标记前断开' : 'DeepSeek 未返回流数据');
        return;
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        if (!receivedFrame && attempt < 2) {
          clearAttempt();
          await delay(350 * 2 ** attempt + Math.floor(Math.random() * 120), signal);
          continue;
        }
        if (receivedFrame) throw error;
        yield {
          type: 'error',
          code: attemptController.signal.aborted ? 'first_byte_timeout' : 'network_error',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        };
        return;
      } finally {
        clearAttempt();
      }
    }
  }
}

export { FALLBACK_MODELS };
