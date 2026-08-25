import type { ModelUsage } from '@openlab/protocol';
import { atomicWriteJson, readJsonFile } from '../util/files.js';

export interface ModelPrice {
  cacheHitInputUsdPerMillion: number;
  cacheMissInputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface DeepSeekPricingConfig {
  schemaVersion: 1;
  version: string;
  updatedAt: string;
  currency: 'USD';
  source: string;
  models: Record<string, ModelPrice>;
}

export interface CostEstimate {
  currency: 'USD';
  amount: number;
  pricingVersion: string;
  pricingSource: string;
}

export const BUILTIN_DEEPSEEK_PRICING: DeepSeekPricingConfig = {
  schemaVersion: 1,
  version: 'deepseek-2026-08-22',
  updatedAt: '2026-08-22',
  currency: 'USD',
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
  models: {
    'deepseek-v4-flash': { cacheHitInputUsdPerMillion: 0.0028, cacheMissInputUsdPerMillion: 0.14, outputUsdPerMillion: 0.28 },
    'deepseek-v4-pro': { cacheHitInputUsdPerMillion: 0.003625, cacheMissInputUsdPerMillion: 0.435, outputUsdPerMillion: 0.87 },
  },
};

function validPrice(value: unknown): value is ModelPrice {
  if (typeof value !== 'object' || value === null) return false;
  const price = value as Partial<ModelPrice>;
  return [price.cacheHitInputUsdPerMillion, price.cacheMissInputUsdPerMillion, price.outputUsdPerMillion]
    .every((number) => typeof number === 'number' && Number.isFinite(number) && number >= 0);
}

function validConfig(value: unknown): value is DeepSeekPricingConfig {
  if (typeof value !== 'object' || value === null) return false;
  const config = value as Partial<DeepSeekPricingConfig>;
  return config.schemaVersion === 1 && typeof config.version === 'string' && typeof config.updatedAt === 'string'
    && config.currency === 'USD' && typeof config.source === 'string' && typeof config.models === 'object' && config.models !== null
    && Object.values(config.models).every(validPrice);
}

export class DeepSeekPricingTable {
  readonly config: DeepSeekPricingConfig;

  constructor(path: string) {
    const stored = readJsonFile<unknown>(path, undefined);
    if (validConfig(stored)) this.config = stored;
    else {
      this.config = structuredClone(BUILTIN_DEEPSEEK_PRICING);
      atomicWriteJson(path, this.config);
    }
  }

  estimate(model: string, usage: ModelUsage): CostEstimate | undefined {
    const nativeModel = model.startsWith('deepseek::') ? model.slice('deepseek::'.length) : model;
    const price = this.config.models[nativeModel];
    if (!price) return undefined;
    const hit = Math.max(0, usage.cacheHitTokens);
    const miss = Math.max(usage.cacheMissTokens, usage.promptTokens - hit, 0);
    const amount = (hit * price.cacheHitInputUsdPerMillion + miss * price.cacheMissInputUsdPerMillion + usage.completionTokens * price.outputUsdPerMillion) / 1_000_000;
    return {
      currency: 'USD',
      amount: Number(amount.toFixed(10)),
      pricingVersion: this.config.version,
      pricingSource: this.config.source,
    };
  }
}
