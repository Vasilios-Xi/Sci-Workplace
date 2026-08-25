import type { ModelProviderConfig, ModelProviderId } from '@openlab/protocol';
import { atomicWriteJson, readJsonFile } from '../util/files.js';
import { defaultProviderConfigs, definitionFor, PROVIDER_DEFINITIONS } from './catalog.js';

function isProviderId(value: unknown): value is ModelProviderId {
  return typeof value === 'string' && PROVIDER_DEFINITIONS.some((item) => item.id === value);
}

function normalizeBaseUrl(providerId: ModelProviderId, value: unknown): string | undefined {
  const definition = definitionFor(providerId);
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : definition.defaultBaseUrl;
  if (!candidate) return undefined;
  const url = new URL(candidate);
  if (url.username || url.password || url.search || url.hash) throw new Error('Provider URL must not contain credentials, query parameters, or fragments');
  if (definition.local) {
    const loopback = url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
    if (!loopback || !['http:', 'https:'].includes(url.protocol)) throw new Error('Local providers must use a loopback HTTP(S) address');
  } else if (url.protocol !== 'https:') {
    throw new Error('Remote provider URLs must use HTTPS');
  }
  return url.toString().replace(/\/$/u, '');
}

function normalizeConfig(id: ModelProviderId, value: Partial<ModelProviderConfig> | undefined): ModelProviderConfig {
  const definition = definitionFor(id);
  const defaultConfig = defaultProviderConfigs().find((item) => item.id === id)!;
  const credentialId = typeof value?.credentialId === 'string' && /^cred_[a-f0-9]{24}$/u.test(value.credentialId)
    ? value.credentialId
    : undefined;
  const baseUrl = definition.defaultBaseUrl || value?.baseUrl ? normalizeBaseUrl(id, value?.baseUrl) : undefined;
  return {
    id,
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : defaultConfig.enabled,
    ...(credentialId ? { credentialId } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : defaultConfig.updatedAt,
  };
}

export class ProviderConfigStore {
  readonly #path: string;
  #configs: ModelProviderConfig[];

  constructor(path: string) {
    this.#path = path;
    const stored = readJsonFile<unknown>(path, []);
    const candidates = Array.isArray(stored) ? stored : [];
    this.#configs = PROVIDER_DEFINITIONS.map((definition) => {
      const value = candidates.find((item): item is Partial<ModelProviderConfig> & { id: ModelProviderId } => {
        return typeof item === 'object' && item !== null && isProviderId((item as { id?: unknown }).id) && (item as { id: ModelProviderId }).id === definition.id;
      });
      try { return normalizeConfig(definition.id, value); }
      catch { return normalizeConfig(definition.id, undefined); }
    });
  }

  list(): ModelProviderConfig[] {
    return structuredClone(this.#configs);
  }

  get(id: ModelProviderId): ModelProviderConfig {
    const config = this.#configs.find((item) => item.id === id);
    if (!config) throw new Error(`Unknown provider: ${id}`);
    return structuredClone(config);
  }

  update(id: ModelProviderId, patch: Partial<Pick<ModelProviderConfig, 'enabled' | 'credentialId' | 'baseUrl'>>): ModelProviderConfig {
    const current = this.get(id);
    const definition = definitionFor(id);
    if (patch.baseUrl !== undefined && !definition.configurableBaseUrl && patch.baseUrl !== definition.defaultBaseUrl) {
      throw new Error(`${definition.label} endpoint is fixed by the official integration`);
    }
    const next = normalizeConfig(id, { ...current, ...patch, updatedAt: new Date().toISOString() });
    const index = this.#configs.findIndex((item) => item.id === id);
    this.#configs[index] = next;
    atomicWriteJson(this.#path, this.#configs);
    return structuredClone(next);
  }
}
