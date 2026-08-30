import { randomUUID } from 'node:crypto';
import type {
  EventActor,
  JobRecord,
  JsonValue,
  PluginManifest,
  PluginWorkflowDefinition,
  PluginWorkflowResult,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { isRecord, toJson } from '../util/json.js';

const SYSTEM_ACTOR: EventActor = { id: 'openlab', kind: 'system', label: 'Sci Workplace Runtime' };

export interface PersistentWorkflowContext {
  projectId: string;
  sessionId: string;
  agentId: string;
  traceId: string;
  capabilities: PluginManifest['permissions'];
  worktableInstanceId?: string;
}

interface WorkflowEnvelope {
  pluginId: string;
  workflowId: string;
  input: Record<string, JsonValue>;
  context: PersistentWorkflowContext;
  record: JobRecord;
}

type WorkflowExecutor = (
  pluginId: string,
  workflowId: string,
  input: Record<string, JsonValue>,
  context: PersistentWorkflowContext,
  jobId: string,
  resume: boolean,
  signal: AbortSignal,
) => Promise<PluginWorkflowResult>;

export class PluginWorkflowService {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #execute: WorkflowExecutor;
  readonly #onChanged: () => void;
  readonly #records = new Map<string, WorkflowEnvelope>();
  readonly #active = new Map<string, AbortController>();
  #shuttingDown = false;

  constructor(options: {
    projectId: string;
    events: SqliteEventStore;
    execute: WorkflowExecutor;
    onChanged?: () => void;
  }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.#execute = options.execute;
    this.#onChanged = options.onChanged ?? (() => undefined);
    this.replay();
    for (const envelope of this.#records.values()) {
      if (!['queued', 'running'].includes(envelope.record.status)) continue;
      envelope.record = {
        ...envelope.record,
        status: 'interrupted',
        completedAt: new Date().toISOString(),
        error: 'runtime_restart',
      };
      this.append('workflow.interrupted', envelope, SYSTEM_ACTOR);
    }
  }

  list(): JobRecord[] {
    return [...this.#records.values()].map((value) => structuredClone(value.record)).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  get(id: string): JobRecord {
    return structuredClone(this.require(id).record);
  }

  start(
    pluginId: string,
    definition: PluginWorkflowDefinition,
    input: Record<string, JsonValue>,
    context: PersistentWorkflowContext,
    actor: EventActor,
  ): JobRecord {
    if (this.#shuttingDown) throw new Error('Runtime 正在关闭，不能启动插件工作流');
    if (!context.agentId || !context.sessionId || !context.traceId) throw new Error('插件工作流必须具有完整的 session、agent 与 trace 上下文');
    if (context.worktableInstanceId) {
      const active = [...this.#records.values()].find((candidate) =>
        candidate.context.worktableInstanceId === context.worktableInstanceId
        && ['queued', 'running', 'paused', 'interrupted'].includes(candidate.record.status));
      if (active) throw new Error('同一工作台任务实例已有活动工作流，请先完成、取消或恢复现有运行');
    }
    const id = randomUUID();
    const record: JobRecord = {
      id,
      projectId: this.#projectId,
      spec: {
        title: definition.title,
        executable: 'openlab-plugin-workflow',
        args: [definition.id],
        inputs: [],
        outputs: [],
        timeoutMs: 30 * 60_000,
        network: false,
        origin: 'plugin',
        pluginId,
        agentId: context.agentId,
        traceId: context.traceId,
        ...(context.worktableInstanceId ? { worktableInstanceId: context.worktableInstanceId } : {}),
      },
      status: 'queued',
      logBytes: 0,
      outputs: [],
      workflow: { id: definition.id, resumeCount: 0 },
      createdAt: new Date().toISOString(),
    };
    const envelope: WorkflowEnvelope = { pluginId, workflowId: definition.id, input: structuredClone(input), context: structuredClone(context), record };
    this.#records.set(id, envelope);
    this.append('workflow.queued', envelope, actor);
    queueMicrotask(() => void this.execute(id, false, actor));
    return structuredClone(record);
  }

  cancel(id: string, actor: EventActor): JobRecord {
    const envelope = this.require(id);
    if (!['queued', 'running', 'paused', 'interrupted'].includes(envelope.record.status)) return structuredClone(envelope.record);
    this.#active.get(id)?.abort(new DOMException('Cancelled', 'AbortError'));
    this.#active.delete(id);
    envelope.record = {
      ...envelope.record,
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      error: 'cancelled_by_user',
    };
    this.append('workflow.cancelled', envelope, actor);
    return structuredClone(envelope.record);
  }

  pause(id: string, actor: EventActor): JobRecord {
    const envelope = this.require(id);
    if (!['queued', 'running'].includes(envelope.record.status)) return structuredClone(envelope.record);
    this.#active.get(id)?.abort(new DOMException('Paused', 'AbortError'));
    this.#active.delete(id);
    const record: JobRecord = { ...envelope.record, status: 'paused', stage: '已暂停', error: 'paused_by_user' };
    delete record.completedAt;
    delete record.exitCode;
    envelope.record = record;
    this.append('workflow.paused', envelope, actor);
    return structuredClone(record);
  }

  resume(id: string, actor: EventActor): JobRecord {
    const envelope = this.require(id);
    if (this.#shuttingDown) throw new Error('Runtime 正在关闭，不能恢复插件工作流');
    if (!['paused', 'interrupted'].includes(envelope.record.status)) return structuredClone(envelope.record);
    const record: JobRecord = {
      ...envelope.record,
      status: 'queued',
      stage: '等待恢复',
      workflow: { id: envelope.workflowId, resumeCount: (envelope.record.workflow?.resumeCount ?? 0) + 1 },
    };
    delete record.completedAt;
    delete record.error;
    delete record.exitCode;
    envelope.record = record;
    this.append('workflow.resumed', envelope, actor);
    queueMicrotask(() => void this.execute(id, true, actor));
    return structuredClone(record);
  }

  report(id: string, update: { progress?: number; stage?: string; metadata?: Record<string, JsonValue> }, actor: EventActor): JobRecord {
    const envelope = this.require(id);
    if (!['queued', 'running'].includes(envelope.record.status)) throw new Error('只能更新正在运行的插件工作流');
    if (update.progress !== undefined && (!Number.isFinite(update.progress) || update.progress < 0 || update.progress > 1)) throw new Error('工作流进度必须介于 0 和 1 之间');
    if (update.stage !== undefined && (!update.stage.trim() || update.stage.length > 256)) throw new Error('工作流阶段无效');
    envelope.record = {
      ...envelope.record,
      ...(update.progress === undefined ? {} : { progress: update.progress }),
      ...(update.stage === undefined ? {} : { stage: update.stage }),
      ...(update.metadata === undefined ? {} : { metadata: { ...(envelope.record.metadata ?? {}), ...structuredClone(update.metadata) } }),
    };
    this.append('workflow.progressed', envelope, actor);
    return structuredClone(envelope.record);
  }

  /** Requeue jobs interrupted by a host restart after plugins are activated. */
  resumeInterrupted(actor: EventActor = SYSTEM_ACTOR): JobRecord[] {
    const resumed: JobRecord[] = [];
    if (this.#shuttingDown) return resumed;
    for (const envelope of this.#records.values()) {
      if (envelope.record.status !== 'interrupted' || !['runtime_restart', 'runtime_shutdown'].includes(envelope.record.error ?? '')) continue;
      const record: JobRecord = {
        ...envelope.record,
        status: 'queued',
        workflow: { id: envelope.workflowId, resumeCount: (envelope.record.workflow?.resumeCount ?? 0) + 1 },
      };
      delete record.completedAt;
      delete record.error;
      envelope.record = record;
      this.append('workflow.resumed', envelope, actor);
      resumed.push(structuredClone(record));
      queueMicrotask(() => void this.execute(record.id, true, actor));
    }
    return resumed;
  }

  shutdown(): void {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    for (const [id, envelope] of this.#records) {
      if (!['queued', 'running'].includes(envelope.record.status)) continue;
      this.#active.get(id)?.abort(new DOMException('Runtime shutdown', 'AbortError'));
      this.#active.delete(id);
      envelope.record = {
        ...envelope.record,
        status: 'interrupted',
        completedAt: new Date().toISOString(),
        error: 'runtime_shutdown',
      };
      this.append('workflow.interrupted', envelope, SYSTEM_ACTOR);
    }
  }

  private async execute(id: string, resume: boolean, actor: EventActor): Promise<void> {
    if (this.#shuttingDown) return;
    const envelope = this.require(id);
    if (envelope.record.status !== 'queued') return;
    const controller = new AbortController();
    this.#active.set(id, controller);
    envelope.record = {
      ...envelope.record,
      status: 'running',
      stage: resume ? '恢复工作流' : '运行工作流',
      startedAt: envelope.record.startedAt ?? new Date().toISOString(),
    };
    this.append('workflow.started', envelope, actor);
    try {
      const result = await this.#execute(envelope.pluginId, envelope.workflowId, structuredClone(envelope.input), structuredClone(envelope.context), id, resume, controller.signal);
      if (this.require(id).record.status !== 'running') return;
      envelope.record = {
        ...envelope.record,
        status: 'completed',
        progress: 1,
        stage: '已完成',
        artifactIds: [...new Set(result.artifactIds)],
        metadata: structuredClone(result.metadata),
        completedAt: new Date().toISOString(),
        exitCode: 0,
      };
      this.append('workflow.completed', envelope, actor);
    } catch (error) {
      if (this.#active.get(id) !== controller || this.require(id).record.status !== 'running') return;
      const cancelled = controller.signal.aborted;
      const message = error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000);
      const recoverable = !cancelled && /(?:RECOVERABLE:|插件 RPC 超时|quota|额度|模型不可用|schema)/iu.test(message);
      envelope.record = {
        ...envelope.record,
        status: cancelled ? 'cancelled' : recoverable ? 'interrupted' : 'failed',
        stage: cancelled ? '已取消' : recoverable ? '可恢复失败' : '失败',
        completedAt: new Date().toISOString(),
        error: cancelled ? 'cancelled_by_user' : message,
      };
      this.append(cancelled ? 'workflow.cancelled' : recoverable ? 'workflow.interrupted' : 'workflow.failed', envelope, actor);
    } finally {
      if (this.#active.get(id) === controller) this.#active.delete(id);
    }
  }

  private require(id: string): WorkflowEnvelope {
    const value = this.#records.get(id);
    if (!value) throw new Error('插件工作流不存在');
    return value;
  }

  private append(kind: string, envelope: WorkflowEnvelope, actor: EventActor): void {
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind,
      actor,
      agentId: envelope.context.agentId,
      traceId: envelope.context.traceId,
      provenanceRefs: [envelope.record.id, ...(envelope.record.artifactIds ?? [])],
      payload: toJson(envelope),
    });
    this.#onChanged();
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (!event.kind.startsWith('workflow.') || !isRecord(event.payload)) continue;
      const record = event.payload.record;
      if (!isRecord(record) || typeof record.id !== 'string') continue;
      this.#records.set(record.id, structuredClone(event.payload as unknown as WorkflowEnvelope));
    }
  }
}
