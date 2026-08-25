import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type {
  ModelDescriptor,
  ModelEvent,
  ModelProvider,
  ModelProviderConfig,
  ModelProviderId,
  ModelProviderState,
  ModelRequest,
  ProviderOAuthStartResult,
} from '@openlab/protocol';
import { DemoProvider } from '../deepseek/demo-provider.js';
import { DeepSeekProvider } from '../deepseek/provider.js';
import { CodexAppServerProvider } from './codex-app-server-provider.js';
import {
  compatibleRequestExtras,
  definitionFor,
  GLM_MODELS,
  KIMI_MODELS,
  MINIMAX_MODELS,
  PROVIDER_DEFINITIONS,
} from './catalog.js';
import { GrokCliProvider } from './grok-cli-provider.js';
import { LmStudioProvider } from './lm-studio-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { OpenAiCompatibleProvider } from './openai-compatible-provider.js';
import { ProviderConfigStore } from './provider-config-store.js';

const API_KEY_PROVIDERS = new Set<ModelProviderId>(['minimax-coding-plan', 'kimi-coding-plan', 'glm-coding-plan', 'deepseek']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDeepSeekTransportOverride(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash) throw new Error('DeepSeek transport override must not contain credentials, query parameters, or fragments');
  const loopback = url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('DeepSeek transport override must use HTTPS or loopback HTTP');
  return url.toString().replace(/\/$/u, '');
}

async function commandAvailable(command: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn(command, ['--version'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 5_000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

export interface ProviderManagerOptions {
  configPath: string;
  bridgeRoot: string;
  getCredential(id: string): string | undefined;
  getLegacyDeepSeekKey(): string | undefined;
  /** Test/development transport override. Production settings keep the official fixed endpoint. */
  deepSeekBaseUrl?: string;
}

export class ProviderManager implements ModelProvider {
  readonly id = 'provider-router';
  readonly #store: ProviderConfigStore;
  readonly #getCredential: (id: string) => string | undefined;
  readonly #getLegacyDeepSeekKey: () => string | undefined;
  readonly #deepSeekBaseUrl: string | undefined;
  readonly #demo = new DemoProvider();
  readonly #chatgpt: CodexAppServerProvider;
  readonly #grok: GrokCliProvider;
  #states: ModelProviderState[];
  #models: ModelDescriptor[] = [];
  #refreshed = false;

  constructor(options: ProviderManagerOptions) {
    this.#store = new ProviderConfigStore(options.configPath);
    this.#getCredential = options.getCredential;
    this.#getLegacyDeepSeekKey = options.getLegacyDeepSeekKey;
    this.#deepSeekBaseUrl = normalizeDeepSeekTransportOverride(options.deepSeekBaseUrl);
    this.#chatgpt = new CodexAppServerProvider({ workingDirectory: join(options.bridgeRoot, 'chatgpt') });
    this.#grok = new GrokCliProvider({ workingDirectory: join(options.bridgeRoot, 'grok') });
    this.#states = PROVIDER_DEFINITIONS.map((definition) => ({
      definition,
      config: this.#store.get(definition.id),
      status: 'disabled',
      credentialConfigured: false,
      models: [],
    }));
  }

  states(): ModelProviderState[] {
    return structuredClone(this.#states);
  }

  realModels(): ModelDescriptor[] {
    return structuredClone(this.#models);
  }

  async listModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    if (!this.#refreshed) await this.refresh(undefined, signal);
    return this.#models.length > 0 ? structuredClone(this.#models) : await this.#demo.listModels();
  }

  async refresh(id?: ModelProviderId, signal?: AbortSignal): Promise<ModelProviderState[]> {
    const targets = id ? [id] : PROVIDER_DEFINITIONS.map((definition) => definition.id);
    const refreshed = await Promise.all(targets.map(async (providerId) => await this.refreshOne(providerId, signal)));
    for (const state of refreshed) {
      const index = this.#states.findIndex((item) => item.definition.id === state.definition.id);
      if (index >= 0) this.#states[index] = state;
    }
    this.#models = this.#states.flatMap((state) => state.status === 'connected' ? state.models : []);
    this.#refreshed = true;
    return this.states();
  }

  async configure(id: ModelProviderId, patch: Partial<Pick<ModelProviderConfig, 'enabled' | 'credentialId' | 'baseUrl'>>): Promise<ModelProviderState> {
    this.#store.update(id, patch);
    await this.refresh(id);
    return structuredClone(this.#states.find((state) => state.definition.id === id)!);
  }

  async startOAuth(id: Extract<ModelProviderId, 'chatgpt-oauth' | 'grok-oauth'>): Promise<ProviderOAuthStartResult> {
    this.#store.update(id, { enabled: true });
    if (id === 'chatgpt-oauth' && await this.#chatgpt.account().catch(() => undefined)) {
      await this.refresh(id);
      return { providerId: id, status: 'completed' };
    }
    if (id === 'grok-oauth' && await this.#grok.authenticated().catch(() => false)) {
      await this.refresh(id);
      return { providerId: id, status: 'completed' };
    }
    const result = id === 'chatgpt-oauth' ? await this.#chatgpt.startLogin() : await this.#grok.startLogin();
    await this.refresh(id).catch(() => undefined);
    return result;
  }

  async logoutOAuth(id: Extract<ModelProviderId, 'chatgpt-oauth' | 'grok-oauth'>): Promise<void> {
    if (id === 'chatgpt-oauth') await this.#chatgpt.logout();
    else await this.#grok.logout();
    await this.refresh(id).catch(() => undefined);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const provider = this.providerForModel(request.model);
    for await (const event of provider.stream(request, signal)) yield event;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.#chatgpt.dispose(), this.#grok.dispose()]);
  }

  private credential(config: ModelProviderConfig): string | undefined {
    if (config.credentialId) return this.#getCredential(config.credentialId);
    if (config.id === 'deepseek') return this.#getLegacyDeepSeekKey();
    return undefined;
  }

  private provider(config: ModelProviderConfig): ModelProvider {
    const baseUrl = config.baseUrl ?? definitionFor(config.id).defaultBaseUrl ?? '';
    const getKey = () => this.credential(this.#store.get(config.id));
    if (config.id === 'chatgpt-oauth') return this.#chatgpt;
    if (config.id === 'grok-oauth') return this.#grok;
    if (config.id === 'deepseek') return new DeepSeekProvider({ getApiKey: getKey, baseUrl: this.#deepSeekBaseUrl ?? baseUrl, strictModelDiscovery: true });
    if (config.id === 'ollama') return new OllamaProvider(baseUrl);
    if (config.id === 'minimax-coding-plan') {
      return new OpenAiCompatibleProvider({ id: config.id, providerId: config.id, baseUrl, getApiKey: getKey, fallbackModels: MINIMAX_MODELS, requiresApiKey: true, strictModelDiscovery: true, requestExtras: (request, nativeId) => compatibleRequestExtras(config.id, request, nativeId) });
    }
    if (config.id === 'kimi-coding-plan') {
      return new OpenAiCompatibleProvider({ id: config.id, providerId: config.id, baseUrl, getApiKey: getKey, fallbackModels: KIMI_MODELS, requiresApiKey: true, strictModelDiscovery: true, requestExtras: (request, nativeId) => compatibleRequestExtras(config.id, request, nativeId) });
    }
    if (config.id === 'glm-coding-plan') {
      return new OpenAiCompatibleProvider({ id: config.id, providerId: config.id, baseUrl, getApiKey: getKey, fallbackModels: GLM_MODELS, requiresApiKey: true, strictModelDiscovery: true, requestExtras: (request, nativeId) => compatibleRequestExtras(config.id, request, nativeId) });
    }
    return new LmStudioProvider(baseUrl);
  }

  private providerForModel(model: string): ModelProvider {
    if (model === 'openlab-demo') return this.#demo;
    const prefix = model.includes('::') ? model.slice(0, model.indexOf('::')) : undefined;
    const providerId = PROVIDER_DEFINITIONS.some((definition) => definition.id === prefix)
      ? prefix as ModelProviderId
      : this.#models.find((item) => item.id === model || item.nativeId === model)?.providerId
        ?? (/^deepseek-/u.test(model) ? 'deepseek' : undefined);
    if (!providerId) return this.#demo;
    return this.provider(this.#store.get(providerId));
  }

  private async refreshOne(id: ModelProviderId, signal?: AbortSignal): Promise<ModelProviderState> {
    const definition = definitionFor(id);
    const config = this.#store.get(id);
    const credentialConfigured = Boolean(this.credential(config));
    if (id === 'chatgpt-oauth') {
      const available = await commandAvailable('codex');
      if (!available) return { definition, config, status: 'unavailable', credentialConfigured: false, commandAvailable: false, models: [], error: 'Codex CLI is not installed or is not on PATH' };
      if (!config.enabled) return { definition, config, status: 'disabled', credentialConfigured: false, commandAvailable: true, models: [] };
      try {
        const account = await this.#chatgpt.account();
        if (!account) return { definition, config, status: 'unconfigured', credentialConfigured: false, commandAvailable: true, models: [] };
        const models = await this.#chatgpt.listModels();
        return { definition, config, status: 'connected', credentialConfigured: true, commandAvailable: true, account, models };
      } catch (error) {
        return { definition, config, status: 'failed', credentialConfigured: false, commandAvailable: true, models: [], error: errorMessage(error) };
      }
    }
    if (id === 'grok-oauth') {
      const available = await this.#grok.probe();
      if (!available) return { definition, config, status: 'unavailable', credentialConfigured: false, commandAvailable: false, models: [], error: 'Grok Build CLI is not installed or is not on PATH' };
      if (!config.enabled) return { definition, config, status: 'disabled', credentialConfigured: false, commandAvailable: true, models: [] };
      try {
        if (!await this.#grok.authenticated()) return { definition, config, status: 'unconfigured', credentialConfigured: false, commandAvailable: true, models: [] };
        const models = await this.#grok.listModels();
        return { definition, config, status: 'connected', credentialConfigured: true, commandAvailable: true, account: { label: 'Grok Build OAuth' }, models };
      } catch (error) {
        return { definition, config, status: 'failed', credentialConfigured: false, commandAvailable: true, models: [], error: errorMessage(error) };
      }
    }
    if (!config.enabled) return { definition, config, status: 'disabled', credentialConfigured, models: [] };
    if (API_KEY_PROVIDERS.has(id) && !credentialConfigured) return { definition, config, status: 'unconfigured', credentialConfigured: false, models: [] };
    try {
      const models = await this.provider(config).listModels(signal);
      if (models.length === 0 && definition.local) return { definition, config, status: 'offline', credentialConfigured, models: [], error: 'Local server is offline or has no loaded models' };
      return { definition, config, status: 'connected', credentialConfigured, models };
    } catch (error) {
      return { definition, config, status: definition.local ? 'offline' : 'failed', credentialConfigured, models: [], error: errorMessage(error) };
    }
  }
}
