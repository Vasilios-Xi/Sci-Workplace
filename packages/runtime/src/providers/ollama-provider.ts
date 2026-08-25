import type { ModelDescriptor, ModelEvent, ModelProvider, ModelRequest, ModelUsage, ToolDefinition } from '@openlab/protocol';

interface OllamaModelSummary {
  name?: string;
  model?: string;
  details?: { family?: string; families?: string[] };
}

interface OllamaShowResponse {
  capabilities?: string[];
  details?: { family?: string; families?: string[] };
  model_info?: Record<string, unknown>;
}

interface OllamaChunk {
  error?: string;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

function toTool(tool: ToolDefinition): Record<string, unknown> {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } };
}

function toUsage(chunk: OllamaChunk): ModelUsage {
  const prompt = chunk.prompt_eval_count ?? 0;
  const completion = chunk.eval_count ?? 0;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, cacheHitTokens: 0, cacheMissTokens: prompt, reasoningTokens: 0 };
}

function parseToolArguments(value: string): unknown {
  try { return JSON.parse(value || '{}') as unknown; }
  catch { return {}; }
}

function reasoningFor(name: string, capabilities: string[]): NonNullable<ModelDescriptor['reasoning']> {
  if (!capabilities.includes('thinking')) return { mode: 'unsupported', efforts: [], canDisable: false };
  if (/gpt[-_]?oss/iu.test(name)) return { mode: 'levels', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', canDisable: false };
  return { mode: 'toggle', efforts: [], canDisable: true };
}

async function* jsonLines(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<OllamaChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try { yield JSON.parse(line) as OllamaChunk; } catch { /* ignore malformed transport line */ }
      }
    }
    const tail = `${buffer}${decoder.decode()}`.trim();
    if (tail) {
      try { yield JSON.parse(tail) as OllamaChunk; } catch { /* ignore malformed tail */ }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama';
  readonly #baseUrl: string;

  constructor(baseUrl = 'http://127.0.0.1:11434') {
    this.#baseUrl = baseUrl.replace(/\/+$/u, '');
  }

  async listModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(3_000)]) : AbortSignal.timeout(3_000);
    const response = await fetch(`${this.#baseUrl}/api/tags`, { signal: requestSignal });
    if (!response.ok) throw new Error(`Ollama model discovery failed (${response.status})`);
    const json = await response.json() as { models?: OllamaModelSummary[] };
    const models = (json.models ?? []).slice(0, 500);
    return await Promise.all(models.map(async (item, index) => {
      const nativeId = item.name ?? item.model ?? '';
      let show: OllamaShowResponse = {};
      try {
        const detailResponse = await fetch(`${this.#baseUrl}/api/show`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: nativeId }),
          signal: requestSignal,
        });
        if (detailResponse.ok) show = await detailResponse.json() as OllamaShowResponse;
      } catch { /* summary metadata remains usable */ }
      const capabilities = show.capabilities ?? [];
      const family = show.details?.family ?? item.details?.family ?? '';
      const contextCandidate = Object.entries(show.model_info ?? {}).find(([key, value]) => key.endsWith('.context_length') && typeof value === 'number')?.[1];
      const contextWindow = typeof contextCandidate === 'number' ? contextCandidate : 128_000;
      const reasoning = reasoningFor(`${nativeId} ${family}`, capabilities);
      return {
        id: `ollama::${nativeId}`,
        nativeId,
        providerId: 'ollama',
        label: nativeId,
        contextWindow,
        supportsThinking: reasoning.mode !== 'unsupported',
        supportsTools: capabilities.includes('tools'),
        supportsVision: capabilities.includes('vision'),
        reasoning,
        isDefault: index === 0,
      } satisfies ModelDescriptor;
    }));
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const nativeModel = request.model.startsWith('ollama::') ? request.model.slice('ollama::'.length) : request.model;
    const isGptOss = /gpt[-_]?oss/iu.test(nativeModel);
    const effort = request.reasoningEffort === 'high' || request.reasoningEffort === 'max' || request.reasoningEffort === 'xhigh'
      ? 'high'
      : request.reasoningEffort === 'low' || request.reasoningEffort === 'minimal' ? 'low' : 'medium';
    const response = await fetch(`${this.#baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Sci-Workplace/0.1.0' },
      body: JSON.stringify({
        model: nativeModel,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
          ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: parseToolArguments(call.arguments) } })) } : {}),
        })),
        ...(request.tools.length ? { tools: request.tools.map(toTool) } : {}),
        stream: true,
        think: isGptOss ? effort : request.thinking === 'enabled',
        options: { num_predict: request.maxOutputTokens },
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      const message = (await response.text().catch(() => '')).slice(0, 100_000) || `Ollama request failed (${response.status})`;
      yield { type: 'error', code: `http_${response.status}`, message, retryable: response.status >= 500 };
      return;
    }
    let terminal = false;
    for await (const chunk of jsonLines(response.body, signal)) {
      if (chunk.error) {
        yield { type: 'error', code: 'ollama_error', message: chunk.error, retryable: false };
        return;
      }
      if (chunk.message?.thinking) yield { type: 'reasoning_delta', text: chunk.message.thinking };
      if (chunk.message?.content) yield { type: 'text_delta', text: chunk.message.content };
      for (const [index, call] of (chunk.message?.tool_calls ?? []).entries()) {
        yield {
          type: 'tool_call_delta', index,
          id: `ollama-tool-${index}`,
          ...(call.function?.name ? { name: call.function.name } : {}),
          arguments: JSON.stringify(call.function?.arguments ?? {}),
        };
      }
      if (chunk.done) {
        terminal = true;
        yield { type: 'usage', usage: toUsage(chunk) };
        yield { type: 'done', finishReason: chunk.message?.tool_calls?.length ? 'tool_calls' : chunk.done_reason === 'length' ? 'length' : 'stop' };
      }
    }
    if (!terminal) yield { type: 'error', code: 'stream_interrupted', message: 'Ollama stream ended before completion', retryable: false };
  }
}
