import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv';
import type {
  EventActor,
  JsonValue,
  ModelDescriptor,
  ModelDisclosureScope,
  ModelGenerationRecord,
  ModelGenerationSpec,
  ModelMessage,
  ModelProvider,
  ModelRunMetrics,
  ModelSourceReference,
  ModelStructuredRunSpec,
  ModelUsage,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { PathGuard } from '../security/path-guard.js';
import { isRecord, toJson } from '../util/json.js';

interface AjvInstance {
  compile(schema: object): ValidateFunction;
  errorsText(errors?: ErrorObject[] | null, options?: { separator?: string }): string;
}

interface CachedGeneration {
  cacheIdentity: string;
  record: ModelGenerationRecord;
}

const AjvConstructor = AjvModule as unknown as new (options?: object) => AjvInstance;
const EMPTY_USAGE: ModelUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  reasoningTokens: 0,
};
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function schemaExample(schema: unknown): JsonValue {
  if (!isRecord(schema)) return null;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return toJson(schema.enum[0]);
  if ('const' in schema) return toJson(schema.const);
  if (schema.type === 'object') {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
    return Object.fromEntries(required.map((key) => [key, schemaExample(properties[key])])) as JsonValue;
  }
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer' || schema.type === 'number') return typeof schema.minimum === 'number' ? schema.minimum : 0;
  if (schema.type === 'null') return null;
  return '';
}

function structuredContract(schema: unknown): string {
  return [
    'JSON OUTPUT CONTRACT (host enforced):',
    '- Return exactly one JSON value. Do not use Markdown fences or explanatory text.',
    '- Include every required property, use the declared primitive types, and do not add undeclared properties.',
    `JSON Schema: ${canonicalJson(schema)}`,
    `Example shape: ${canonicalJson(schemaExample(schema))}`,
  ].join('\n');
}

function inferredJsonType(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (isRecord(value)) return 'object';
  return undefined;
}

/** OpenAI/Codex native structured output uses a stricter JSON Schema dialect:
 * every object property must be required and every object must reject unknown
 * keys. Optional OpenLab properties are represented as nullable to the
 * provider, then removed before validating the original plugin contract. */
function strictProviderSchema(schema: unknown): JsonValue {
  if (!isRecord(schema)) return toJson(schema);
  const output = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, toJson(value)])) as Record<string, JsonValue>;
  if (output.type === undefined) {
    const sample = Array.isArray(schema.enum) ? schema.enum.find((value) => value !== null) : schema.const;
    const inferred = inferredJsonType(sample);
    if (inferred) output.type = inferred;
  }
  if (isRecord(schema.properties)) {
    const originalRequired = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
    const properties: Record<string, JsonValue> = {};
    for (const [key, property] of Object.entries(schema.properties)) {
      const strict = strictProviderSchema(property);
      properties[key] = originalRequired.has(key) ? strict : { anyOf: [strict, { type: 'null' }] };
    }
    output.type = 'object';
    output.properties = properties;
    output.required = Object.keys(properties);
    output.additionalProperties = false;
  }
  if ('items' in schema) output.items = strictProviderSchema(schema.items);
  if (Array.isArray(schema.anyOf)) output.anyOf = schema.anyOf.map(strictProviderSchema);
  if (Array.isArray(schema.oneOf)) output.oneOf = schema.oneOf.map(strictProviderSchema);
  return output;
}

function normalizeStructuredOutput(value: JsonValue, schema: unknown): JsonValue {
  if (!isRecord(schema)) return value;
  if (Array.isArray(value) && 'items' in schema) return value.map((item) => normalizeStructuredOutput(item, schema.items));
  if (!isRecord(value) || !isRecord(schema.properties)) return value;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
  const normalized: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const property = schema.properties[key];
    if (item === null && property !== undefined && !required.has(key)) continue;
    normalized[key] = property === undefined ? item : normalizeStructuredOutput(item, property);
  }
  return normalized;
}

function parseJson(text: string): JsonValue {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  try { return JSON.parse(trimmed) as JsonValue; }
  catch {
    const objectStart = trimmed.indexOf('{');
    const objectEnd = trimmed.lastIndexOf('}');
    const arrayStart = trimmed.indexOf('[');
    const arrayEnd = trimmed.lastIndexOf(']');
    if (objectStart >= 0 && objectEnd > objectStart) return JSON.parse(trimmed.slice(objectStart, objectEnd + 1)) as JsonValue;
    if (arrayStart >= 0 && arrayEnd > arrayStart) return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1)) as JsonValue;
    throw new Error('模型没有返回有效 JSON');
  }
}

function validateSpec(spec: ModelGenerationSpec): ModelGenerationSpec {
  if (!spec.model?.trim() || spec.model.length > 256) throw new Error('模型 ID 无效');
  if (!spec.purpose?.trim() || spec.purpose.length > 256) throw new Error('模型调用 purpose 无效');
  if (!spec.cacheKey?.trim() || spec.cacheKey.length > 512) throw new Error('模型调用 cacheKey 无效');
  if (!Array.isArray(spec.inputHashes) || spec.inputHashes.length > 1_024 || spec.inputHashes.some((value) => typeof value !== 'string' || !value || value.length > 512)) throw new Error('模型调用 inputHashes 无效');
  if (!Array.isArray(spec.messages) || spec.messages.length === 0 || spec.messages.length > 256) throw new Error('模型消息数量无效');
  if (!Number.isInteger(spec.maxOutputTokens) || spec.maxOutputTokens < 1 || spec.maxOutputTokens > 100_000) throw new Error('模型输出 token 上限无效');
  for (const message of spec.messages) {
    if (!['system', 'user', 'assistant'].includes(message.role)) throw new Error('模型消息角色无效');
    if (typeof message.content === 'string') {
      if (message.content.length > 2_000_000) throw new Error('单条模型消息超过 2,000,000 字符');
      continue;
    }
    if (!Array.isArray(message.content) || message.content.length === 0 || message.content.length > 32) throw new Error('模型多模态消息无效');
    for (const part of message.content) {
      if (part.type === 'text') {
        if (typeof part.text !== 'string' || part.text.length > 2_000_000) throw new Error('模型文本输入无效');
      } else if (part.type === 'image') {
        if (!part.ref?.rootId || !part.ref.path || !/^[a-f0-9]{64}$/u.test(part.sha256) || !/^image\/(?:png|jpeg|webp|gif)$/u.test(part.mediaType)) throw new Error('模型视觉输入引用无效');
      } else throw new Error('模型消息包含未知内容类型');
    }
  }
  return structuredClone(spec);
}

function validateSources(sources: ModelSourceReference[], required: boolean): ModelSourceReference[] {
  if (!Array.isArray(sources) || sources.length > 1_024 || (required && sources.length === 0)) throw new Error('模型调用来源引用无效');
  const ids = new Set<string>();
  for (const source of sources) {
    if (!source || typeof source.id !== 'string' || !source.id.trim() || source.id.length > 512 || ids.has(source.id)) throw new Error('模型调用来源 ID 无效或重复');
    ids.add(source.id);
    if (!['document', 'citation', 'bibliography', 'metadata', 'attachment', 'user_input'].includes(source.kind)) throw new Error(`模型调用来源类型无效：${source.id}`);
    if (typeof source.label !== 'string' || !source.label.trim() || source.label.length > 1_024) throw new Error(`模型调用来源标签无效：${source.id}`);
    if (source.sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(source.sha256)) throw new Error(`模型调用来源哈希无效：${source.id}`);
  }
  return structuredClone(sources);
}

function validateDisclosure(disclosure: ModelDisclosureScope | undefined, required: boolean): ModelDisclosureScope | undefined {
  if (!disclosure) {
    if (required) throw new Error('结构化模型调用必须披露送模范围');
    return undefined;
  }
  if (!['snippet', 'full_text'].includes(disclosure.mode) || !Array.isArray(disclosure.fields) || disclosure.fields.length === 0 || disclosure.fields.length > 128 || disclosure.fields.some((field) => typeof field !== 'string' || !field.trim() || field.length > 256)) throw new Error('模型送模披露范围无效');
  if (disclosure.mode === 'full_text' && (!disclosure.authorizationId?.trim() || !disclosure.authorizedAt || Number.isNaN(Date.parse(disclosure.authorizedAt)))) throw new Error('全文送模必须携带本次用户授权');
  return structuredClone(disclosure);
}

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cacheHitTokens: left.cacheHitTokens + right.cacheHitTokens,
    cacheMissTokens: left.cacheMissTokens + right.cacheMissTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

export class ModelGenerationService {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #provider: () => ModelProvider;
  readonly #models: () => ModelDescriptor[];
  readonly #resolveRoot: (rootId: string) => string;
  readonly #estimate: (model: string, usage: ModelUsage) => ModelRunMetrics['estimatedCost'] | undefined;
  readonly #cache = new Map<string, ModelGenerationRecord>();
  readonly #ajv = new AjvConstructor({ allErrors: true, strict: false });

  constructor(options: {
    projectId: string;
    events: SqliteEventStore;
    provider: () => ModelProvider;
    models: () => ModelDescriptor[];
    resolveRoot: (rootId: string) => string;
    estimate?: (model: string, usage: ModelUsage) => ModelRunMetrics['estimatedCost'] | undefined;
  }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.#provider = options.provider;
    this.#models = options.models;
    this.#resolveRoot = options.resolveRoot;
    this.#estimate = options.estimate ?? (() => undefined);
    this.replay();
  }

  list(): ModelDescriptor[] {
    return structuredClone(this.#models());
  }

  async generate(pluginId: string, input: ModelGenerationSpec, actor: EventActor, signal?: AbortSignal): Promise<ModelGenerationRecord> {
    return await this.run(pluginId, input, actor, signal, false);
  }

  async runStructured(pluginId: string, input: ModelStructuredRunSpec, actor: EventActor, signal?: AbortSignal): Promise<ModelGenerationRecord> {
    if (!input.responseSchema || typeof input.responseSchema !== 'object') throw new Error('结构化模型调用必须提供 JSON Schema');
    validateSources(input.sourceReferences, true);
    validateDisclosure(input.disclosure, true);
    return await this.run(pluginId, input, actor, signal, true);
  }

  private async run(pluginId: string, input: ModelGenerationSpec, actor: EventActor, signal: AbortSignal | undefined, structured: boolean): Promise<ModelGenerationRecord> {
    const spec = validateSpec(input);
    const sourceReferences = validateSources(spec.sourceReferences ?? [], structured);
    const disclosure = validateDisclosure(spec.disclosure, structured);
    const descriptor = this.#models().find((model) => model.id === spec.model);
    if (!descriptor) throw new Error(`模型不可用：${spec.model}`);
    // A cache hit is still revision-bound. Resolve and hash every visual input
    // before consulting the persistent cache so a stale ref cannot reuse a
    // result produced for bytes that are no longer present at that path.
    const requestMessages: ModelGenerationSpec['messages'] = (() => {
      if (!spec.responseSchema) return spec.messages;
      const contract = structuredContract(spec.responseSchema);
      const systemIndex = spec.messages.findIndex((message) => message.role === 'system' && typeof message.content === 'string');
      if (systemIndex >= 0) return spec.messages.map((message, index) => index === systemIndex
        ? { ...message, content: `${message.content as string}\n\n${contract}` }
        : message);
      const userIndex = spec.messages.findIndex((message) => message.role === 'user');
      if (userIndex < 0) return [{ role: 'system', content: contract }, ...spec.messages];
      return spec.messages.map((message, index) => {
        if (index !== userIndex) return message;
        return typeof message.content === 'string'
          ? { ...message, content: `${contract}\n\n${message.content}` }
          : { ...message, content: [{ type: 'text', text: contract }, ...message.content] };
      });
    })();
    const messages = this.resolveMessages({ ...spec, messages: requestMessages }, descriptor);
    const providerResponseSchema = spec.responseSchema ? strictProviderSchema(spec.responseSchema) : undefined;
    const cacheIdentity = createHash('sha256').update(canonicalJson({
      pluginId,
      model: spec.model,
      purpose: spec.purpose,
      messages: spec.messages,
      responseSchema: spec.responseSchema ?? null,
      reasoningEffort: spec.reasoningEffort,
      maxOutputTokens: spec.maxOutputTokens,
      cacheKey: spec.cacheKey,
      inputHashes: spec.inputHashes,
      sourceReferences,
      disclosure: disclosure ?? null,
    })).digest('hex');
    const cached = this.#cache.get(cacheIdentity);
    if (cached) {
      const now = new Date().toISOString();
      const record: ModelGenerationRecord = {
        ...structuredClone(cached),
        id: randomUUID(),
        cacheHit: true,
        usage: structuredClone(EMPTY_USAGE),
        createdAt: now,
        completedAt: now,
      };
      delete record.estimatedCost;
      this.append('model.generation_cache_hit', { cacheIdentity, record }, actor);
      return record;
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    let usage = structuredClone(EMPTY_USAGE);
    let text = '';
    let json: JsonValue | undefined;
    let attemptCount = 0;
    const retryReasons: string[] = [];
    this.appendAudit('model.generation_started', {
      id, pluginId, model: spec.model, purpose: spec.purpose, messages: spec.messages,
      responseSchema: spec.responseSchema ?? null, reasoningEffort: spec.reasoningEffort,
      maxOutputTokens: spec.maxOutputTokens, inputHashes: spec.inputHashes,
      sourceReferences, disclosure: disclosure ?? null, createdAt,
    }, [id, ...sourceReferences.map((source) => source.id)], actor);
    try {
      let attemptMessages = messages;
      let attemptAuditMessages: ModelGenerationSpec['messages'] = requestMessages;
      const maximumAttempts = structured ? 2 : 1;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        attemptCount = attempt;
        if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        this.appendAudit('model.generation_attempt_started', { id, pluginId, attempt, model: spec.model, messages: attemptAuditMessages, responseSchema: providerResponseSchema ?? null, sourceReferences, disclosure: disclosure ?? null }, [id], actor);
        let attemptText = '';
        let attemptUsage = structuredClone(EMPTY_USAGE);
        for await (const event of this.#provider().stream({
          model: spec.model,
          messages: attemptMessages,
          tools: [],
          thinking: spec.reasoningEffort === 'none' ? 'disabled' : 'enabled',
          reasoningEffort: spec.reasoningEffort,
          maxOutputTokens: spec.maxOutputTokens,
          ...(providerResponseSchema ? { responseSchema: providerResponseSchema as NonNullable<ModelGenerationSpec['responseSchema']> } : {}),
          userId: `plugin:${pluginId}`,
        }, signal ?? new AbortController().signal)) {
          if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
          if (event.type === 'text_delta') attemptText += event.text;
          if (Buffer.byteLength(attemptText, 'utf8') > 1_500_000) throw new Error('模型输出超过插件 RPC 安全上限');
          if (event.type === 'tool_call_delta') throw new Error('插件模型调用禁止工具调用');
          if (event.type === 'usage') attemptUsage = structuredClone(event.usage);
          if (event.type === 'error') throw new Error(`${event.code}: ${event.message}`);
        }
        usage = addUsage(usage, attemptUsage);
        text = attemptText;
        let schemaError: Error | undefined;
        if (spec.responseSchema) {
          try {
            json = normalizeStructuredOutput(parseJson(attemptText), spec.responseSchema);
            const validate = this.#ajv.compile(spec.responseSchema as object);
            if (!validate(json)) throw new Error(`模型结构化输出不符合 schema：${this.#ajv.errorsText(validate.errors, { separator: '; ' })}`);
          } catch (error) {
            schemaError = error instanceof Error ? error : new Error(String(error));
          }
        }
        this.appendAudit('model.generation_attempted', {
          id, pluginId, attempt, model: spec.model, output: attemptText, usage: attemptUsage,
          status: schemaError ? 'invalid' : 'valid', error: schemaError?.message ?? null,
          completedAt: new Date().toISOString(),
        }, [id], actor);
        if (!schemaError) break;
        if (attempt >= maximumAttempts) throw schemaError;
        retryReasons.push(schemaError.message.slice(0, 4_000));
        this.appendAudit('model.generation_retrying', {
          id, pluginId, attempt, reason: schemaError.message.slice(0, 4_000),
        }, [id], actor);
        attemptMessages = [
          ...messages,
          { role: 'assistant', content: attemptText },
          { role: 'user', content: `The previous response was invalid: ${schemaError.message}\nReturn only JSON that conforms exactly to this schema:\n${canonicalJson(spec.responseSchema)}` },
        ];
        attemptAuditMessages = [
          ...requestMessages,
          { role: 'assistant', content: attemptText },
          { role: 'user', content: `The previous response was invalid: ${schemaError.message}\nReturn only JSON that conforms exactly to this schema:\n${canonicalJson(spec.responseSchema)}` },
        ];
      }
      const estimatedCost = this.#estimate(spec.model, usage);
      const record: ModelGenerationRecord = {
        id,
        pluginId,
        status: 'completed',
        model: spec.model,
        purpose: spec.purpose,
        text,
        ...(json === undefined ? {} : { json }),
        cacheHit: false,
        usage,
        attemptCount,
        ...(retryReasons.length > 0 ? { retryReasons } : {}),
        ...(sourceReferences.length > 0 ? { sourceReferences } : {}),
        ...(disclosure ? { disclosure } : {}),
        ...(estimatedCost ? { estimatedCost } : {}),
        createdAt,
        completedAt: new Date().toISOString(),
      };
      this.#cache.set(cacheIdentity, structuredClone(record));
      this.append('model.generation_completed', { cacheIdentity, record }, actor);
      return record;
    } catch (error) {
      const cancelled = signal?.aborted || (error instanceof Error && error.name === 'AbortError');
      const record: ModelGenerationRecord = {
        id,
        pluginId,
        status: cancelled ? 'cancelled' : 'failed',
        model: spec.model,
        purpose: spec.purpose,
        text,
        cacheHit: false,
        usage,
        attemptCount,
        ...(retryReasons.length > 0 ? { retryReasons } : {}),
        ...(sourceReferences.length > 0 ? { sourceReferences } : {}),
        ...(disclosure ? { disclosure } : {}),
        failureReason: cancelled ? 'cancelled' : error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000),
        error: cancelled ? 'cancelled' : error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000),
        createdAt,
        completedAt: new Date().toISOString(),
      };
      this.append(cancelled ? 'model.generation_cancelled' : 'model.generation_failed', { cacheIdentity, record }, actor);
      return record;
    }
  }

  private resolveMessages(spec: ModelGenerationSpec, descriptor: ModelDescriptor): ModelMessage[] {
    let totalImageBytes = 0;
    return spec.messages.map((message) => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content : message.content.map((part) => {
        if (part.type === 'text') return { type: 'text' as const, text: part.text, trust: 'untrusted' as const };
        if (!descriptor.supportsVision) throw new Error(`模型不支持视觉输入：${descriptor.id}`);
        const absolute = new PathGuard(this.#resolveRoot(part.ref.rootId)).resolveExisting(part.ref.path);
        const stats = statSync(absolute);
        if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES) throw new Error('模型视觉输入必须是小于 32 MB 的普通文件');
        totalImageBytes += stats.size;
        if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) throw new Error('单次模型调用视觉输入超过 64 MB');
        const bytes = readFileSync(absolute);
        const actualHash = createHash('sha256').update(bytes).digest('hex');
        if (actualHash !== part.sha256) throw new Error('模型视觉输入修订已变化');
        return { type: 'image_url' as const, imageUrl: `data:${part.mediaType};base64,${bytes.toString('base64')}` };
      }),
    }));
  }

  private append(kind: string, value: CachedGeneration, actor: EventActor): void {
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind,
      actor,
      provenanceRefs: [value.record.id, ...(value.record.cacheHit ? [] : [value.cacheIdentity])],
      payload: toJson(value),
    });
  }

  private appendAudit(kind: string, payload: unknown, provenanceRefs: string[], actor: EventActor): void {
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind,
      actor,
      provenanceRefs: [...new Set(provenanceRefs)],
      payload: toJson(payload),
    });
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (event.kind !== 'model.generation_completed' || !isRecord(event.payload)) continue;
      const cacheIdentity = event.payload.cacheIdentity;
      const record = event.payload.record;
      if (typeof cacheIdentity !== 'string' || !isRecord(record) || record.status !== 'completed') continue;
      this.#cache.set(cacheIdentity, structuredClone(record as unknown as ModelGenerationRecord));
    }
  }
}
