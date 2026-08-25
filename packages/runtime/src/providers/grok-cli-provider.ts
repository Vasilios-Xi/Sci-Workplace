import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ModelDescriptor, ModelEvent, ModelProvider, ModelRequest, ProviderOAuthStartResult, ReasoningEffort } from '@openlab/protocol';
import { GROK_MODELS } from './catalog.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (Array.isArray(value)) {
    const text = value.flatMap((item) => {
      if (typeof item === 'string') return [item];
      if (!isRecord(item)) return [];
      const candidate = contentText(item.text ?? item.content);
      return candidate ? [candidate] : [];
    }).join('');
    return text || undefined;
  }
  if (!isRecord(value)) return undefined;
  return contentText(value.text ?? value.content);
}

async function runCommand(command: string, args: string[], timeoutMs: number, maxBytes = 2 * 1024 * 1024): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    let overflow = false;
    const consume = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const value = chunk.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') + Buffer.byteLength(value, 'utf8') > maxBytes) {
        overflow = true;
        child.kill();
        return;
      }
      if (target === 'stdout') stdout += value;
      else stderr += value;
    };
    child.stdout.on('data', (chunk: Buffer) => consume('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => consume('stderr', chunk));
    child.once('error', reject);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (overflow) reject(new Error('Grok CLI output exceeded the safety limit'));
      else resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function normalizeEffort(effort: ReasoningEffort): 'low' | 'medium' | 'high' | 'xhigh' {
  if (effort === 'xhigh' || effort === 'max') return 'xhigh';
  if (effort === 'high') return 'high';
  if (effort === 'low' || effort === 'minimal' || effort === 'none') return 'low';
  return 'medium';
}

function promptFromRequest(request: ModelRequest): string {
  const messages = request.messages.map((message) => {
    const content = typeof message.content === 'string'
      ? message.content
      : message.content?.flatMap((part) => part.type === 'text' ? [part.text] : ['[image omitted by OAuth bridge]']).join('\n') ?? '';
    return `<openlab-message role="${message.role}">\n${content}\n</openlab-message>`;
  }).join('\n\n');
  return `${messages}\n\nRespond only to the supplied Sci Workplace messages. Do not inspect the filesystem or invoke tools.`;
}

function modelIdFromLine(line: string): string | undefined {
  const trimmed = line.trim().replace(/^[*\-\s]+/u, '');
  if (!trimmed || /model|available|default/iu.test(trimmed) && !/grok[-_]/iu.test(trimmed)) return undefined;
  const match = trimmed.match(/\b(grok[-_][a-z0-9._-]+)\b/iu);
  return match?.[1];
}

export class GrokCliProvider implements ModelProvider {
  readonly id = 'grok-oauth';
  readonly #command: string;
  readonly #workingDirectory: string;
  #loginProcess: ChildProcess | undefined;

  constructor(options: { command?: string; workingDirectory: string }) {
    this.#command = options.command ?? 'grok';
    this.#workingDirectory = options.workingDirectory;
    mkdirSync(this.#workingDirectory, { recursive: true });
  }

  async probe(): Promise<boolean> {
    try { return (await runCommand(this.#command, ['--version'], 5_000, 128 * 1024)).code === 0; }
    catch { return false; }
  }

  async authenticated(): Promise<boolean> {
    try { return (await runCommand(this.#command, ['models'], 15_000)).code === 0; }
    catch { return false; }
  }

  async startLogin(): Promise<ProviderOAuthStartResult> {
    if (this.#loginProcess && !this.#loginProcess.killed) return { providerId: 'grok-oauth', status: 'started' };
    const child = spawn(this.#command, ['login', '--oauth'], {
      cwd: this.#workingDirectory,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    });
    this.#loginProcess = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 250);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { if (this.#loginProcess === child) this.#loginProcess = undefined; });
    });
    return { providerId: 'grok-oauth', status: 'started' };
  }

  async logout(): Promise<void> {
    const result = await runCommand(this.#command, ['logout'], 20_000, 256 * 1024);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Grok CLI logout failed');
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const result = await runCommand(this.#command, ['models'], 20_000);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Grok CLI is not logged in');
    const ids = [...new Set(result.stdout.split(/\r?\n/u).flatMap((line) => {
      const id = modelIdFromLine(line);
      return id ? [id] : [];
    }))];
    if (ids.length === 0) return structuredClone(GROK_MODELS);
    return ids.map((nativeId, index) => {
      const known = GROK_MODELS.find((model) => model.nativeId === nativeId);
      return known ?? {
        id: `grok-oauth::${nativeId}`,
        nativeId,
        providerId: 'grok-oauth',
        label: nativeId,
        contextWindow: 1_000_000,
        supportsThinking: true,
        supportsTools: false,
        supportsVision: true,
        reasoning: { mode: 'levels', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisable: false },
        isDefault: index === 0,
      } satisfies ModelDescriptor;
    });
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const nativeModel = request.model.startsWith('grok-oauth::') ? request.model.slice('grok-oauth::'.length) : request.model;
    const child = spawn(this.#command, [
      '--no-auto-update',
      '-p', promptFromRequest(request),
      '--output-format', 'streaming-json',
      '--cwd', this.#workingDirectory,
      '--model', nativeModel,
      '--effort', normalizeEffort(request.reasoningEffort),
      '--max-turns', '1',
      '--no-plan',
      '--no-subagents',
      '--no-memory',
      '--disable-web-search',
      '--sandbox', 'read-only',
    ], {
      cwd: this.#workingDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stderr = '';
    let emittedText = false;
    let finalText = '';
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 100_000) stderr += chunk; });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let event: unknown;
        try { event = JSON.parse(line) as unknown; } catch { continue; }
        if (!isRecord(event)) continue;
        const type = nestedString(event, ['type'], ['event']) ?? '';
        const eventPayload = event.delta ?? event.content ?? (isRecord(event.message) ? event.message.content : undefined);
        const reasoning = /reason|thinking/iu.test(type) ? contentText(eventPayload) : undefined;
        const text = !/reason|thinking|tool/iu.test(type) && (/delta|assistant|message|content/iu.test(type)) ? contentText(eventPayload) : undefined;
        if (reasoning) yield { type: 'reasoning_delta', text: reasoning };
        if (text) { emittedText = true; yield { type: 'text_delta', text }; }
        finalText = contentText(event.result ?? event.response ?? event.output ?? (isRecord(event.message) ? event.message.content : undefined)) ?? finalText;
        const usage = isRecord(event.usage) ? event.usage : undefined;
        if (usage) {
          const prompt = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
          const completion = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
          const cached = Number(usage.cached_tokens ?? 0);
          yield { type: 'usage', usage: { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, cacheHitTokens: cached, cacheMissTokens: Math.max(0, prompt - cached), reasoningTokens: Number(usage.reasoning_tokens ?? 0) } };
        }
      }
      const code = child.exitCode ?? await new Promise<number>((resolve) => child.once('exit', (value) => resolve(value ?? -1)));
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (code !== 0) {
        yield { type: 'error', code: 'grok_cli', message: stderr.trim() || `Grok CLI exited with code ${code}`, retryable: false };
        return;
      }
      if (!emittedText && finalText) yield { type: 'text_delta', text: finalText };
      yield { type: 'done', finishReason: 'stop' };
    } finally {
      signal.removeEventListener('abort', onAbort);
      lines.close();
      if (!child.killed && child.exitCode === null) child.kill();
    }
  }

  async dispose(): Promise<void> {
    this.#loginProcess?.kill();
    this.#loginProcess = undefined;
  }
}
