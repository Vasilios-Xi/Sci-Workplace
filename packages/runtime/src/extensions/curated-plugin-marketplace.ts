import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type {
  CuratedPluginCatalogEntryV1,
  CuratedPluginCatalogIndexV1,
  SignedPluginCatalogV1,
} from '@openlab/protocol';
import { atomicWriteJson } from '../util/files.js';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function validateIndex(index: CuratedPluginCatalogIndexV1): void {
  if (index.schemaVersion !== 1 || !Number.isSafeInteger(index.sequence) || index.sequence < 1 || !Number.isFinite(Date.parse(index.generatedAt))) throw new Error('插件市场索引元数据无效');
  if (!Array.isArray(index.entries) || index.entries.length > 10_000 || !Array.isArray(index.revocations) || index.revocations.length > 10_000) throw new Error('插件市场索引规模无效');
  const identities = new Set<string>();
  for (const entry of index.entries) {
    const identity = `${entry.id}@${entry.version}`;
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(entry.id) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(entry.version) || identities.has(identity)) throw new Error('插件市场条目 ID 或版本无效');
    identities.add(identity);
    if (!entry.name.trim() || !entry.description.trim() || !/^https:\/\//u.test(entry.packageUrl) || !/^[a-f0-9]{64}$/u.test(entry.sha256) || !Number.isFinite(Date.parse(entry.publishedAt))) throw new Error(`插件市场条目不完整：${identity}`);
    if (!Array.isArray(entry.permissions) || new Set(entry.permissions).size !== entry.permissions.length) throw new Error(`插件市场权限列表无效：${identity}`);
  }
  for (const revocation of index.revocations) {
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(revocation.id) || !revocation.reason.trim() || !Number.isFinite(Date.parse(revocation.revokedAt))) throw new Error('插件撤回记录无效');
  }
}

export { canonicalJson as canonicalPluginCatalogJson };

export class CuratedPluginMarketplace {
  readonly #cachePath: string;
  readonly #trustedKeys: ReadonlyMap<string, string | Buffer>;
  #catalog: SignedPluginCatalogV1 | undefined;
  #lastError: string | undefined;

  constructor(options: { cachePath: string; trustedKeys: ReadonlyMap<string, string | Buffer> }) {
    this.#cachePath = options.cachePath;
    this.#trustedKeys = options.trustedKeys;
    if (existsSync(this.#cachePath)) {
      try { this.#catalog = this.verify(JSON.parse(readFileSync(this.#cachePath, 'utf8')) as SignedPluginCatalogV1); }
      catch (error) { this.#lastError = error instanceof Error ? error.message : String(error); }
    }
  }

  status(): { source: 'cache' | 'empty'; sequence: number; generatedAt?: string; error?: string } {
    return {
      source: this.#catalog ? 'cache' : 'empty',
      sequence: this.#catalog?.index.sequence ?? 0,
      ...(this.#catalog ? { generatedAt: this.#catalog.index.generatedAt } : {}),
      ...(this.#lastError ? { error: this.#lastError } : {}),
    };
  }

  entries(): CuratedPluginCatalogEntryV1[] {
    const index = this.#catalog?.index;
    if (!index) return [];
    return index.entries
      .filter((entry) => !this.isRevoked(entry.id, entry.version))
      .map((entry) => structuredClone(entry));
  }

  updateFromFile(path: string): SignedPluginCatalogV1 {
    const candidate = this.verify(JSON.parse(readFileSync(path, 'utf8')) as SignedPluginCatalogV1);
    const currentSequence = this.#catalog?.index.sequence ?? 0;
    if (candidate.index.sequence <= currentSequence) throw new Error('插件市场索引 sequence 未递增，拒绝回滚或重放');
    atomicWriteJson(this.#cachePath, candidate);
    this.#catalog = candidate;
    this.#lastError = undefined;
    return structuredClone(candidate);
  }

  verifyPackage(path: string, entry: Pick<CuratedPluginCatalogEntryV1, 'id' | 'version' | 'sha256'>): void {
    if (this.isRevoked(entry.id, entry.version)) throw new Error(`插件 ${entry.id}@${entry.version} 已撤回，禁止启动或安装`);
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== entry.sha256) throw new Error(`插件包 SHA-256 不匹配：${entry.id}@${entry.version}`);
  }

  revocationReason(id: string, version?: string): string | undefined {
    return this.#catalog?.index.revocations
      .find((revocation) => revocation.id === id && (!revocation.version || !version || revocation.version === version))?.reason;
  }

  isRevoked(id: string, version?: string): boolean {
    return Boolean(this.revocationReason(id, version));
  }

  private verify(value: SignedPluginCatalogV1): SignedPluginCatalogV1 {
    if (!value || value.algorithm !== 'Ed25519' || typeof value.keyId !== 'string' || typeof value.signature !== 'string' || !value.index) throw new Error('签名插件市场索引结构无效');
    const key = this.#trustedKeys.get(value.keyId);
    if (!key) throw new Error(`插件市场签名 keyId 不受信任：${value.keyId}`);
    validateIndex(value.index);
    const signature = Buffer.from(value.signature, 'base64');
    if (signature.length !== 64 || !verify(null, Buffer.from(canonicalJson(value.index), 'utf8'), createPublicKey(key), signature)) throw new Error('插件市场 Ed25519 签名无效');
    return structuredClone(value);
  }
}
