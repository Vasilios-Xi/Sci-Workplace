import { randomUUID } from 'node:crypto';
import AjvModule, { type ValidateFunction } from 'ajv';
import type {
  EventActor,
  JobRecord,
  JobSpec,
  JsonValue,
  ToolRunV1,
  ToolchainAdapterManifestV1,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { toJson } from '../util/json.js';
import type { JobService } from './job-service.js';

interface AjvInstance {
  compile(schema: object): ValidateFunction;
  errorsText(errors?: unknown, options?: { separator?: string }): string;
}

const AjvConstructor = AjvModule as unknown as new (options?: object) => AjvInstance;
const ajv = new AjvConstructor({ allErrors: true, strict: false });

export const MOCK_TOOLCHAIN_ADAPTER: ToolchainAdapterManifestV1 = {
  schemaVersion: 1,
  id: 'sci.mock-toolchain',
  version: '1.0.0',
  title: '科研绘图工具链模拟器',
  platforms: ['win32'],
  executableNames: [process.execPath.split(/[\\/]/u).at(-1) ?? 'node.exe'],
  versionArgs: ['--version'],
  operations: [
    {
      id: 'render-json',
      title: '模拟渲染并回收产物',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, payload: {} },
        required: ['title'],
        additionalProperties: true,
      },
      outputs: [{ path: 'mock-output.json', role: 'output', mediaType: 'application/json', required: true }],
      requiresConfirmation: true,
    },
  ],
};

type AdapterExecutor = (input: { operationId: string; values: Record<string, JsonValue>; instanceId?: string; pluginId?: string; traceId?: string; agentId?: string }) => JobSpec;

interface ToolRunEventPayload { run?: ToolRunV1 }

export class ToolchainAdapterService {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #jobs: JobService;
  readonly #importOutputs: (run: ToolRunV1, job: JobRecord, actor: EventActor) => Promise<string[]> | string[];
  readonly #onChanged: () => void;
  readonly #manifests = new Map<string, ToolchainAdapterManifestV1>();
  readonly #executors = new Map<string, AdapterExecutor>();
  readonly #runs = new Map<string, ToolRunV1>();
  readonly #settlements = new Map<string, Promise<void>>();

  constructor(options: {
    projectId: string;
    events: SqliteEventStore;
    jobs: JobService;
    importOutputs?: (run: ToolRunV1, job: JobRecord, actor: EventActor) => Promise<string[]> | string[];
    onChanged?: () => void;
  }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.#jobs = options.jobs;
    this.#importOutputs = options.importOutputs ?? (() => []);
    this.#onChanged = options.onChanged ?? (() => undefined);
    this.register(MOCK_TOOLCHAIN_ADAPTER, ({ values, instanceId, pluginId, traceId, agentId }) => {
      const encoded = Buffer.from(JSON.stringify(values), 'utf8').toString('base64');
      const source = [
        "const fs=require('node:fs')",
        "const input=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'))",
        "fs.writeFileSync('mock-output.json',JSON.stringify({adapter:'sci.mock-toolchain',renderedAt:new Date().toISOString(),input},null,2))",
      ].join(';');
      return {
        title: `模拟科研绘图：${typeof values.title === 'string' ? values.title : 'untitled'}`,
        executable: process.execPath,
        args: ['-e', source, encoded],
        inputs: [],
        outputs: structuredClone(MOCK_TOOLCHAIN_ADAPTER.operations[0]!.outputs),
        timeoutMs: 60_000,
        network: false,
        origin: pluginId ? 'plugin' : 'user',
        ...(pluginId ? { pluginId } : {}),
        ...(traceId ? { traceId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(instanceId ? { worktableInstanceId: instanceId } : {}),
      };
    });
    this.replay();
  }

  register(manifest: ToolchainAdapterManifestV1, executor?: AdapterExecutor): void {
    if (manifest.schemaVersion !== 1 || !manifest.id.trim() || !manifest.operations.length) throw new Error('ToolchainAdapterManifest 无效');
    const current = this.#manifests.get(manifest.id);
    if (current && current.version !== manifest.version) throw new Error(`工具链适配器 ID 冲突：${manifest.id}`);
    this.#manifests.set(manifest.id, structuredClone(manifest));
    if (executor) this.#executors.set(manifest.id, executor);
  }

  manifests(): ToolchainAdapterManifestV1[] {
    return [...this.#manifests.values()].map((manifest) => structuredClone(manifest));
  }

  runs(): ToolRunV1[] {
    return [...this.#runs.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map((run) => structuredClone(run));
  }

  get(id: string): ToolRunV1 {
    const run = this.#runs.get(id);
    if (!run) throw new Error('ToolRun 不存在');
    return structuredClone(run);
  }

  run(input: {
    adapterId: string;
    operationId: string;
    values: Record<string, JsonValue>;
    confirmed: boolean;
    instanceId?: string;
    pluginId?: string;
    traceId?: string;
    agentId?: string;
  }, actor: EventActor): ToolRunV1 {
    const manifest = this.#manifests.get(input.adapterId);
    const operation = manifest?.operations.find((candidate) => candidate.id === input.operationId);
    if (!manifest || !operation) throw new Error('工具链适配器或操作不存在');
    if (operation.requiresConfirmation && !input.confirmed) throw new Error(`外部工具操作“${operation.title}”需要用户明确授权`);
    const validate = ajv.compile(operation.inputSchema as object);
    if (!validate(input.values)) throw new Error(`工具链输入无效：${ajv.errorsText(validate.errors, { separator: '; ' })}`);
    const executor = this.#executors.get(manifest.id);
    if (!executor) throw new Error(`工具链适配器 ${manifest.title} 尚未安装受信执行实现`);
    const job = this.#jobs.run(executor(input), actor);
    const now = new Date().toISOString();
    const run: ToolRunV1 = {
      id: randomUUID(),
      projectId: this.#projectId,
      adapterId: manifest.id,
      operationId: operation.id,
      jobId: job.id,
      status: job.status,
      artifactRevisionIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.#runs.set(run.id, run);
    this.record('tool-run.started', run, actor);
    this.#onChanged();
    const settlement = this.settle(run.id, actor).finally(() => this.#settlements.delete(run.id));
    this.#settlements.set(run.id, settlement);
    return structuredClone(run);
  }

  async wait(id: string): Promise<ToolRunV1> {
    this.get(id);
    await this.#settlements.get(id);
    return this.get(id);
  }

  cancel(id: string, actor: EventActor): ToolRunV1 {
    const current = this.get(id);
    const job = this.#jobs.cancel(current.jobId, actor);
    const run = { ...current, status: job.status, updatedAt: new Date().toISOString() };
    this.#runs.set(id, run);
    this.record('tool-run.cancelled', run, actor);
    this.#onChanged();
    return structuredClone(run);
  }

  log(id: string, offset = 0): { content: string; nextOffset: number } {
    return this.#jobs.log(this.get(id).jobId, offset);
  }

  private async settle(id: string, actor: EventActor): Promise<void> {
    try {
      const current = this.get(id);
      const job = await this.#jobs.wait(current.jobId);
      const artifactRevisionIds = job.status === 'completed' ? await this.#importOutputs(current, job, actor) : [];
      const run: ToolRunV1 = { ...current, status: job.status, artifactRevisionIds: [...artifactRevisionIds], updatedAt: new Date().toISOString() };
      this.#runs.set(id, run);
      this.record('tool-run.settled', run, actor);
      this.#onChanged();
    } catch {
      const current = this.#runs.get(id);
      if (!current) return;
      const run: ToolRunV1 = { ...current, status: 'failed', updatedAt: new Date().toISOString() };
      this.#runs.set(id, run);
      this.record('tool-run.settled', run, actor);
      this.#onChanged();
    }
  }

  private record(kind: string, run: ToolRunV1, actor: EventActor): void {
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind,
      actor,
      idempotencyKey: `${kind}:${run.id}:${run.updatedAt}`,
      provenanceRefs: [run.id, run.jobId, ...run.artifactRevisionIds],
      payload: toJson({ run }),
    });
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (!event.kind.startsWith('tool-run.')) continue;
      const payload = event.payload as unknown as ToolRunEventPayload;
      if (payload.run?.id) this.#runs.set(payload.run.id, structuredClone(payload.run));
    }
  }
}
