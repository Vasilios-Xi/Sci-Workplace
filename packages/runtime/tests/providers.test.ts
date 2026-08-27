import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRequest } from '@openlab/protocol';
import { codexDynamicTools, codexTurnInput, reasoningSummaryFromCompletedItem } from '../src/providers/codex-app-server-provider.js';
import { ollamaChatContent, openAiChatContent } from '../src/providers/message-content.js';
import { compatibleRequestExtras, KIMI_MODELS, MINIMAX_MODELS } from '../src/providers/catalog.js';
import { LmStudioProvider } from '../src/providers/lm-studio-provider.js';
import { OllamaProvider } from '../src/providers/ollama-provider.js';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible-provider.js';
import { ProviderConfigStore } from '../src/providers/provider-config-store.js';
import { ProviderManager } from '../src/providers/provider-manager.js';

function sse(parts: unknown[]): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(`${parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join('')}data: [DONE]\n\n`);
  return new ReadableStream({ start(controller) { controller.enqueue(encoded); controller.close(); } });
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'kimi-coding-plan::k3',
    messages: [{ role: 'user', content: 'test' }],
    tools: [],
    thinking: 'enabled',
    reasoningEffort: 'medium',
    maxOutputTokens: 128,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('model providers', () => {
  it('recovers a user-visible reasoning summary from a completed Codex item when no deltas were sent', () => {
    expect(reasoningSummaryFromCompletedItem({
      item: { type: 'reasoning', summary: [{ text: '先确认问题边界。' }, { text: '再比较可验证路径。' }] },
    })).toBe('先确认问题边界。\n\n再比较可验证路径。');
    expect(reasoningSummaryFromCompletedItem({ item: { type: 'agentMessage', summary: ['not reasoning'] } })).toBeUndefined();
  });

  it('registers Harness tools as Codex App Server dynamic functions', () => {
    expect(codexDynamicTools([{
      name: 'list_files', title: '列出文件', description: '列出项目文件',
      inputSchema: { type: 'object', properties: { maxFiles: { type: 'integer' } } },
      risk: 'read', renderHint: 'generic', source: 'core',
    }])).toEqual([{
      type: 'function', name: 'list_files', description: '列出文件\n列出项目文件',
      inputSchema: { type: 'object', properties: { maxFiles: { type: 'integer' } } },
    }]);
  });

  it('forwards multimodal message images to Codex App Server without embedding data in transcript text', () => {
    const imageUrl = 'data:image/png;base64,AAAA';
    const input = codexTurnInput([{
      role: 'user',
      content: [{ type: 'text', text: '请看图' }, { type: 'image_url', imageUrl }],
    }]);
    expect(input).toHaveLength(2);
    expect(input[0]).toMatchObject({ type: 'text', text_elements: [] });
    expect(String(input[0]?.text)).toContain('[image attachment 1]');
    expect(String(input[0]?.text)).not.toContain(imageUrl);
    expect(input[1]).toEqual({ type: 'image', detail: 'auto', url: imageUrl });
  });

  it('maps internal multimodal content to provider-native image formats', () => {
    const imageUrl = 'data:image/png;base64,QUJD';
    const content = [{ type: 'text' as const, text: 'inspect' }, { type: 'image_url' as const, imageUrl }];
    expect(openAiChatContent(content)).toEqual([
      { type: 'text', text: 'inspect' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ]);
    expect(ollamaChatContent(content)).toEqual({ content: 'inspect', images: ['QUJD'] });
  });

  it('uses the current official Coding Plan model catalog and effort mappings', () => {
    expect(MINIMAX_MODELS[0]).toMatchObject({ nativeId: 'MiniMax-M3', contextWindow: 1_048_576, supportsVision: true });
    expect(KIMI_MODELS[0]?.reasoning).toMatchObject({ efforts: ['low', 'high', 'max'], defaultEffort: 'high' });
    expect(compatibleRequestExtras('kimi-coding-plan', request({ reasoningEffort: 'medium' }), 'k3')).toMatchObject({ reasoning_effort: 'high' });
    expect(compatibleRequestExtras('kimi-coding-plan', request({ reasoningEffort: 'xhigh' }), 'k3')).toMatchObject({ reasoning_effort: 'max' });
    expect(compatibleRequestExtras('glm-coding-plan', request({ thinking: 'disabled' }), 'glm-5.2')).toEqual({ thinking: { type: 'disabled' } });
    expect(compatibleRequestExtras('minimax-coding-plan', request(), 'MiniMax-M2.7')).toEqual({ reasoning_split: true });
  });

  it('persists redacted provider configuration and rejects unsafe endpoints', () => {
    const root = mkdtempSync(join(tmpdir(), 'openlab-providers-'));
    try {
      const store = new ProviderConfigStore(join(root, 'providers.json'));
      const updated = store.update('deepseek', { enabled: true, credentialId: 'cred_0123456789abcdef01234567' });
      expect(updated).toMatchObject({ credentialId: 'cred_0123456789abcdef01234567', baseUrl: 'https://api.deepseek.com' });
      expect(() => store.update('ollama', { baseUrl: 'http://192.168.1.3:11434' })).toThrow(/loopback/u);
      expect(() => store.update('deepseek', { baseUrl: 'http://api.deepseek.com' })).toThrow(/HTTPS/u);
      expect(() => store.update('kimi-coding-plan', { baseUrl: 'https://example.com/v1' })).toThrow(/fixed/u);
      expect(new ProviderConfigStore(join(root, 'providers.json')).get('deepseek').credentialId).toBe('cred_0123456789abcdef01234567');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('only permits secure or loopback DeepSeek transport overrides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openlab-provider-router-'));
    const options = {
      configPath: join(root, 'providers.json'), bridgeRoot: join(root, 'bridge'),
      getCredential: () => undefined, getLegacyDeepSeekKey: () => undefined,
    };
    try {
      expect(() => new ProviderManager({ ...options, deepSeekBaseUrl: 'http://api.deepseek.com' })).toThrow(/HTTPS|loopback/u);
      expect(() => new ProviderManager({ ...options, deepSeekBaseUrl: 'https://user:secret@example.com' })).toThrow(/credentials/u);
      const manager = new ProviderManager({ ...options, deepSeekBaseUrl: 'http://127.0.0.1:8765' });
      await manager.dispose();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('normalizes cumulative MiniMax reasoning and text without duplication', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse([
      { choices: [{ index: 0, delta: { reasoning_details: [{ text: 'plan' }], content: 'A' } }] },
      { choices: [{ index: 0, delta: { reasoning_details: [{ text: 'plan more' }], content: 'AB' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]), { status: 200 })));
    const provider = new OpenAiCompatibleProvider({
      id: 'minimax-coding-plan', providerId: 'minimax-coding-plan', baseUrl: 'https://api.minimax.io/v1',
      getApiKey: () => 'secret', fallbackModels: MINIMAX_MODELS, requiresApiKey: true,
      requestExtras: (value, nativeId) => compatibleRequestExtras('minimax-coding-plan', value, nativeId),
    });
    let reasoning = '';
    let text = '';
    for await (const event of provider.stream(request({ model: 'minimax-coding-plan::MiniMax-M2.7' }), new AbortController().signal)) {
      if (event.type === 'reasoning_delta') reasoning += event.text;
      if (event.type === 'text_delta') text += event.text;
    }
    expect(reasoning).toBe('plan more');
    expect(text).toBe('AB');
  });

  it('discovers Ollama capabilities and exposes official thinking semantics', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'gpt-oss:20b' }, { name: 'llama3.2-vision' }] }), { status: 200 });
      const model = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      return new Response(JSON.stringify(model.model?.startsWith('gpt-oss')
        ? { capabilities: ['thinking', 'tools'], model_info: { 'gptoss.context_length': 131_072 } }
        : { capabilities: ['vision'] }), { status: 200 });
    }));
    const models = await new OllamaProvider().listModels();
    expect(models[0]).toMatchObject({ supportsThinking: true, supportsTools: true, reasoning: { efforts: ['low', 'medium', 'high'], canDisable: false } });
    expect(models[1]).toMatchObject({ supportsVision: true, supportsThinking: false });
  });

  it('uses LM Studio native capability metadata with the official Responses reasoning field', async () => {
    let responseBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/models')) {
        return new Response(JSON.stringify({ models: [{
          type: 'llm', key: 'openai/gpt-oss-20b', display_name: 'GPT OSS 20B', max_context_length: 131_072,
          capabilities: { vision: false, trained_for_tool_use: true, reasoning: { allowed_options: ['low', 'medium', 'high'], default: 'medium' } },
        }] }), { status: 200 });
      }
      responseBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(sse([
        { type: 'response.reasoning_summary_text.delta', delta: 'plan' },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'read_file' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"notes.md"}' },
        { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28, output_tokens_details: { reasoning_tokens: 3 } } } },
      ]), { status: 200 });
    }));
    const provider = new LmStudioProvider();
    const models = await provider.listModels();
    expect(models[0]).toMatchObject({
      id: 'lm-studio::openai/gpt-oss-20b', contextWindow: 131_072, supportsThinking: true,
      reasoning: { mode: 'levels', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', canDisable: false },
    });
    const events = [];
    for await (const event of provider.stream(request({
      model: models[0]!.id,
      reasoningEffort: 'max',
      tools: [{ name: 'read_file', title: 'Read', description: 'Read a file', inputSchema: { type: 'object' }, risk: 'read', renderHint: 'generic', source: 'core' }],
    }), new AbortController().signal)) events.push(event);
    expect(responseBody).toMatchObject({ model: 'openai/gpt-oss-20b', reasoning: { effort: 'high' }, stream: true });
    expect(responseBody?.tools).toEqual([expect.objectContaining({ type: 'function', name: 'read_file' })]);
    expect(events).toEqual(expect.arrayContaining([
      { type: 'reasoning_delta', text: 'plan' },
      expect.objectContaining({ type: 'tool_call_delta', id: 'call_1', name: 'read_file' }),
      expect.objectContaining({ type: 'tool_call_delta', arguments: '{"path":"notes.md"}' }),
      expect.objectContaining({ type: 'usage', usage: expect.objectContaining({ reasoningTokens: 3 }) }),
      { type: 'done', finishReason: 'tool_calls' },
    ]));
  });
});
