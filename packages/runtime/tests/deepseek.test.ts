import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeepSeekProvider } from '../src/deepseek/provider.js';
import { DeepSeekPricingTable } from '../src/deepseek/pricing.js';
import { parseSseData } from '../src/deepseek/sse.js';

function stream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('DeepSeek SSE', () => {
  it('parses events split across arbitrary byte chunks', async () => {
    const values: string[] = [];
    for await (const value of parseSseData(stream(['data: {"a":', '1}\r\n\r\ndata: [DO', 'NE]\n\n']))) values.push(value);
    expect(values).toEqual(['{"a":1}', '[DONE]']);
  });

  it('rejects an unbounded SSE frame before it can exhaust host memory', async () => {
    const consume = async () => {
      for await (const _value of parseSseData(stream([`data: ${'x'.repeat(4 * 1024 * 1024 + 1)}`]))) { /* consume */ }
    };
    await expect(consume()).rejects.toThrow(/单帧超过 4 MB/u);
  });

  it('normalizes reasoning, text, fragmented tool calls and cache usage', async () => {
    const chunks = [
      { choices: [{ delta: { reasoning_content: 'plan ' } }] },
      { choices: [{ delta: { content: 'answer' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 } } },
    ];
    const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(stream([body]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }));
    const provider = new DeepSeekProvider({ getApiKey: () => 'test-key' });
    const events = [];
    for await (const event of provider.stream({
      model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'test' }], tools: [],
      thinking: 'enabled', reasoningEffort: 'high', maxOutputTokens: 100,
      responseSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false },
    }, new AbortController().signal)) events.push(event);
    expect(requestBody.response_format).toEqual({ type: 'json_object' });
    expect(events).toContainEqual({ type: 'reasoning_delta', text: 'plan ' });
    expect(events).toContainEqual({ type: 'text_delta', text: 'answer' });
    expect(events.filter((event) => event.type === 'tool_call_delta')).toHaveLength(2);
    expect(events).toContainEqual({ type: 'done', finishReason: 'tool_calls' });
    expect(events).toContainEqual({ type: 'usage', usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14, cacheHitTokens: 7, cacheMissTokens: 3, reasoningTokens: 2 } });
  });

  it('retries temporary HTTP failures only before the first stream frame', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"busy"}}', { status: 503 }))
      .mockResolvedValueOnce(new Response(stream(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new DeepSeekProvider({ getApiKey: () => 'test-key' });
    const events = [];
    for await (const event of provider.stream({
      model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'test' }], tools: [],
      thinking: 'enabled', reasoningEffort: 'high', maxOutputTokens: 100,
    }, new AbortController().signal)) events.push(event);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: 'text_delta', text: 'ok' });
  });

  it('does not replay a request after any model delta has been observed', async () => {
    const encoder = new TextEncoder();
    let pullCount = 0;
    const interrupted = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount++ === 0) controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        else controller.error(new Error('connection lost'));
      },
    });
    const fetchMock = vi.fn(async () => new Response(interrupted, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new DeepSeekProvider({ getApiKey: () => 'test-key' });
    const consume = async () => {
      const events = [];
      for await (const event of provider.stream({
        model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'test' }], tools: [],
        thinking: 'enabled', reasoningEffort: 'high', maxOutputTokens: 100,
      }, new AbortController().signal)) events.push(event);
      return events;
    };
    await expect(consume()).rejects.toThrow('connection lost');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forwards cancellation to the active request without retrying it', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error('missing signal'));
      signal.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new DeepSeekProvider({ getApiKey: () => 'test-key' });
    const controller = new AbortController();
    const consume = async () => {
      for await (const _event of provider.stream({
        model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'test' }], tools: [],
        thinking: 'enabled', reasoningEffort: 'medium', maxOutputTokens: 100,
      }, controller.signal)) { /* consume */ }
    };
    const pending = consume();
    controller.abort(new Error('cancelled by user'));
    await expect(pending).rejects.toThrow('cancelled by user');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('estimates cost from an independently updateable pricing table', () => {
    const root = mkdtempSync(join(tmpdir(), 'openlab-pricing-'));
    try {
      const table = new DeepSeekPricingTable(join(root, 'deepseek.json'));
      const estimate = table.estimate('deepseek-v4-pro', {
        promptTokens: 2_000_000, completionTokens: 1_000_000, totalTokens: 3_000_000,
        cacheHitTokens: 1_000_000, cacheMissTokens: 1_000_000, reasoningTokens: 200_000,
      });
      expect(estimate?.amount).toBe(1.308625);
      expect(estimate?.pricingVersion).toMatch(/^deepseek-/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
