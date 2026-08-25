import type {
  MessageContent,
  ModelDescriptor,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelUsage,
  ReasoningEffort,
  ToolDefinition,
} from '@openlab/protocol';
import { parseSseData } from '../deepseek/sse.js';

type LmReasoningOption = 'off' | 'on' | 'low' | 'medium' | 'high';

interface LmModel {
  type?: 'llm' | 'embedding';
  key?: string;
  display_name?: string;
  max_context_length?: number;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    reasoning?: {
      allowed_options?: LmReasoningOption[];
      default?: LmReasoningOption;
    };
  };
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  output_index?: number;
  item?: {
    id?: string;
    call_id?: string;
    type?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    status?: string;
    error?: { code?: string; message?: string } | null;
    incomplete_details?: { reason?: string } | null;
    usage?: ResponsesUsage | null;
  };
  error?: { code?: string; message?: string };
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/u, '');
}

function nativeModelId(requested: string): string {
  return requested.startsWith('lm-studio::') ? requested.slice('lm-studio::'.length) : requested;
}

function serverRoot(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/?$/u, '/');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}

function contentText(content: MessageContent | null): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  return content.flatMap((part) => part.type === 'text' ? [part.text] : [`[image: ${part.imageUrl}]`]).join('\n');
}

function inputMessage(message: ModelMessage): Array<Record<string, unknown>> {
  if (message.role === 'tool') {
    return message.toolCallId ? [{ type: 'function_call_output', call_id: message.toolCallId, output: contentText(message.content) }] : [];
  }
  const items: Array<Record<string, unknown>> = [];
  if (message.content !== null) {
    if (typeof message.content === 'string') {
      if (message.content) items.push({ role: message.role, content: message.content });
    } else {
      const content = message.content.map((part) => part.type === 'text'
        ? { type: 'input_text', text: part.text }
        : { type: 'input_image', image_url: part.imageUrl });
      if (content.length > 0) items.push({ role: message.role, content });
    }
  }
  for (const call of message.toolCalls ?? []) {
    items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
  }
  return items;
}

function responseTool(tool: ToolDefinition): Record<string, unknown> {
  return { type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema };
}

function usage(value: ResponsesUsage): ModelUsage {
  const prompt = value.input_tokens ?? 0;
  const completion = value.output_tokens ?? 0;
  const cached = value.input_tokens_details?.cached_tokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: value.total_tokens ?? prompt + completion,
    cacheHitTokens: cached,
    cacheMissTokens: Math.max(0, prompt - cached),
    reasoningTokens: value.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

function reasoningCapabilities(model: LmModel): NonNullable<ModelDescriptor['reasoning']> {
  const reasoning = model.capabilities?.reasoning;
  if (!reasoning) return { mode: 'unsupported', efforts: [], canDisable: false };
  const efforts = (reasoning.allowed_options ?? []).filter((item): item is Extract<LmReasoningOption, ReasoningEffort> => ['low', 'medium', 'high'].includes(item));
  if (efforts.length > 0) {
    const preferred = reasoning.default && efforts.includes(reasoning.default as Extract<LmReasoningOption, ReasoningEffort>)
      ? reasoning.default as Extract<LmReasoningOption, ReasoningEffort>
      : efforts.includes('medium') ? 'medium' : efforts[0]!;
    return { mode: 'levels', efforts, defaultEffort: preferred, canDisable: false };
  }
  return { mode: 'always', efforts: [], defaultEffort: 'high', canDisable: false };
}

function effectiveEffort(request: ModelRequest, model: LmModel | undefined): 'low' | 'medium' | 'high' | undefined {
  const allowed = model?.capabilities?.reasoning?.allowed_options?.filter((item): item is 'low' | 'medium' | 'high' => ['low', 'medium', 'high'].includes(item)) ?? [];
  if (allowed.length === 0) return undefined;
  const desired = request.reasoningEffort === 'max' || request.reasoningEffort === 'xhigh' || request.reasoningEffort === 'high' ? 'high'
    : request.reasoningEffort === 'medium' ? 'medium' : 'low';
  if (allowed.includes(desired)) return desired;
  const fallback = model?.capabilities?.reasoning?.default;
  if (fallback === 'low' || fallback === 'medium' || fallback === 'high') return fallback;
  return allowed[0];
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

export class LmStudioProvider implements ModelProvider {
  readonly id = 'lm-studio';
  readonly #baseUrl: string;
  readonly #models = new Map<string, LmModel>();

  constructor(baseUrl = 'http://127.0.0.1:1234/v1') {
    this.#baseUrl = normalizeBaseUrl(baseUrl);
  }

  async listModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const response = await fetch(`${serverRoot(this.#baseUrl)}/api/v1/models`, {
      headers: { 'User-Agent': 'Sci-Workplace/0.1.0' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`LM Studio model discovery failed (${response.status})`);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) throw new Error('LM Studio model catalog exceeds 4 MB');
    const parsed = JSON.parse(text) as { models?: LmModel[] };
    const models = (parsed.models ?? []).filter((model): model is LmModel & { key: string } => model.type === 'llm' && typeof model.key === 'string' && Boolean(model.key));
    this.#models.clear();
    for (const model of models) this.#models.set(model.key, model);
    return models.map((model, index) => ({
      id: `lm-studio::${model.key}`,
      nativeId: model.key,
      providerId: 'lm-studio',
      label: model.display_name ?? model.key,
      contextWindow: model.max_context_length ?? 128_000,
      supportsThinking: Boolean(model.capabilities?.reasoning),
      supportsTools: true,
      supportsVision: Boolean(model.capabilities?.vision),
      reasoning: reasoningCapabilities(model),
      ...(index === 0 ? { isDefault: true } : {}),
    }));
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const nativeModel = nativeModelId(request.model);
    const effort = effectiveEffort(request, this.#models.get(nativeModel));
    const body = {
      model: nativeModel,
      input: request.messages.flatMap(inputMessage),
      tools: request.tools.length > 0 ? request.tools.map(responseTool) : undefined,
      tool_choice: request.tools.length > 0 ? 'auto' : undefined,
      max_output_tokens: request.maxOutputTokens,
      stream: true,
      ...(effort ? { reasoning: { effort } } : {}),
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let receivedFrame = false;
      let completed = false;
      let sawToolCall = false;
      const emittedArguments = new Map<number, string>();
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', forwardAbort, { once: true });
      const firstByteTimer = setTimeout(() => controller.abort(new Error('LM Studio first-byte timeout')), 30_000);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(new Error('LM Studio stream idle timeout')), 60_000);
      };
      const cleanup = () => {
        clearTimeout(firstByteTimer);
        if (idleTimer) clearTimeout(idleTimer);
        signal.removeEventListener('abort', forwardAbort);
      };
      try {
        const response = await fetch(`${this.#baseUrl}/responses`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Sci-Workplace/0.1.0' },
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
          let message = `LM Studio request failed (${response.status})`;
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
          if (data === '[DONE]') break;
          let event: ResponsesEvent;
          try { event = JSON.parse(data) as ResponsesEvent; } catch { continue; }
          if (event.type === 'response.output_text.delta' && event.delta) yield { type: 'text_delta', text: event.delta };
          if (['response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.reasoning.delta'].includes(event.type ?? '') && event.delta) {
            yield { type: 'reasoning_delta', text: event.delta };
          }
          if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
            const index = event.output_index ?? 0;
            sawToolCall = true;
            yield {
              type: 'tool_call_delta', index,
              ...(event.item.call_id || event.item.id ? { id: event.item.call_id ?? event.item.id! } : {}),
              ...(event.item.name ? { name: event.item.name } : {}),
              ...(event.item.arguments ? { arguments: event.item.arguments } : {}),
            };
            if (event.item.arguments) emittedArguments.set(index, event.item.arguments);
          }
          if (event.type === 'response.function_call_arguments.delta' && event.delta) {
            const index = event.output_index ?? 0;
            sawToolCall = true;
            emittedArguments.set(index, `${emittedArguments.get(index) ?? ''}${event.delta}`);
            yield { type: 'tool_call_delta', index, arguments: event.delta };
          }
          if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
            const index = event.output_index ?? 0;
            const previous = emittedArguments.get(index) ?? '';
            const full = event.item.arguments ?? '';
            const remainder = full.startsWith(previous) ? full.slice(previous.length) : previous ? '' : full;
            sawToolCall = true;
            if (remainder || (!previous && (event.item.call_id || event.item.id || event.item.name))) {
              yield {
                type: 'tool_call_delta', index,
                ...(event.item.call_id || event.item.id ? { id: event.item.call_id ?? event.item.id! } : {}),
                ...(event.item.name ? { name: event.item.name } : {}),
                ...(remainder ? { arguments: remainder } : {}),
              };
            }
          }
          if (event.type === 'response.completed') {
            if (event.response?.usage) yield { type: 'usage', usage: usage(event.response.usage) };
            completed = true;
            yield { type: 'done', finishReason: sawToolCall ? 'tool_calls' : 'stop' };
          }
          if (event.type === 'response.incomplete') {
            if (event.response?.usage) yield { type: 'usage', usage: usage(event.response.usage) };
            completed = true;
            yield { type: 'done', finishReason: event.response?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'unknown' };
          }
          if (event.type === 'response.failed' || event.type === 'error') {
            const failure = event.response?.error ?? event.error;
            yield { type: 'error', code: failure?.code ?? 'lm_studio_error', message: failure?.message ?? 'LM Studio response failed', retryable: false };
            return;
          }
        }
        if (!completed) throw new Error(receivedFrame ? 'LM Studio stream ended before completion' : 'LM Studio returned no stream data');
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
