import { randomUUID } from 'node:crypto';
import type { AgentDefinition, AgentPreset, AgentRun, AgentTask, ChannelMessage, MailboxMessage, ModelUsage } from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { toJson } from '../util/json.js';

const EMPTY_USAGE: ModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0 };

export interface MemberRunInput {
  run: AgentRun;
  definition: AgentDefinition;
  task: AgentTask;
  preset: AgentPreset;
  signal: AbortSignal;
  mailbox: MailboxMessage[];
}

export interface TeamSnapshot {
  runs: AgentRun[];
  tasks: AgentTask[];
  mailbox: MailboxMessage[];
}

export class TeamManager {
  readonly #sessionId: string;
  readonly #events: SqliteEventStore;
  readonly #maxConcurrent: number;
  readonly #runMember: (input: MemberRunInput) => Promise<{ outputRefs?: string[]; usage?: ModelUsage; text?: string }>;
  readonly #onChange: (snapshot: TeamSnapshot) => void;
  readonly #onMessage: ((message: MailboxMessage) => ChannelMessage | undefined) | undefined;
  readonly #runs: AgentRun[] = [];
  readonly #tasks: AgentTask[] = [];
  readonly #mailbox: MailboxMessage[] = [];
  readonly #presets = new Map<string, AgentPreset>();
  readonly #definitions = new Map<string, AgentDefinition>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #activeRuns = new Map<string, Promise<void>>();
  #leadRunId = '';
  #draining = false;
  #stopping = false;

  constructor(options: {
    sessionId: string;
    events: SqliteEventStore;
    maxConcurrent?: number;
    initial?: TeamSnapshot;
    runMember: (input: MemberRunInput) => Promise<{ outputRefs?: string[]; usage?: ModelUsage; text?: string }>;
    onChange?: (snapshot: TeamSnapshot) => void;
    onMessage?: (message: MailboxMessage) => ChannelMessage | undefined;
  }) {
    this.#sessionId = options.sessionId;
    this.#events = options.events;
    this.#maxConcurrent = Math.min(8, Math.max(1, options.maxConcurrent ?? 3));
    this.#runMember = options.runMember;
    this.#onChange = options.onChange ?? (() => undefined);
    this.#onMessage = options.onMessage;
    if (options.initial) {
      this.#runs.push(...structuredClone(options.initial.runs));
      this.#tasks.push(...structuredClone(options.initial.tasks));
      this.#mailbox.push(...structuredClone(options.initial.mailbox));
      this.#leadRunId = this.#runs.find((run) => run.role === 'lead')?.id ?? '';
    }
  }

  registerAgent(definition: AgentDefinition, preset: AgentPreset): void {
    this.#definitions.set(definition.id, structuredClone(definition));
    this.#presets.set(definition.id, structuredClone(preset));
  }

  createLead(definition: AgentDefinition, preset: AgentPreset): AgentRun {
    this.registerAgent(definition, preset);
    const existing = this.#runs.find((run) => run.role === 'lead' && run.definitionId === definition.id);
    if (existing) {
      this.#leadRunId = existing.id;
      return structuredClone(existing);
    }
    const run: AgentRun = {
      id: randomUUID(), sessionId: this.#sessionId, definitionId: definition.id, name: definition.name,
      role: 'lead', status: 'idle', usage: { ...EMPTY_USAGE },
    };
    this.#leadRunId = run.id;
    this.#runs.push(run);
    this.record('agent.run_created', run.id, run);
    this.changed();
    return structuredClone(run);
  }

  assignTask(input: { leadRunId: string; target: AgentDefinition; preset: AgentPreset; title: string; description: string; inputRefs: string[] }): { runId: string; taskId: string } {
    if (this.#stopping) throw new Error('Agent 调度正在停止，不能再派发任务');
    const lead = this.#runs.find((run) => run.id === input.leadRunId && run.role === 'lead');
    if (!lead) throw new Error('只有当前会话主管可以委派任务');
    if (input.target.id === lead.definitionId) throw new Error('主管不能把成员任务委派给自己');
    this.registerAgent(input.target, input.preset);
    const now = new Date().toISOString();
    const task: AgentTask = {
      id: randomUUID(), sessionId: this.#sessionId, title: normalizeText(input.title, '任务标题', 200),
      description: normalizeText(input.description, '任务描述', 20_000), status: 'queued',
      inputRefs: normalizeRefs(input.inputRefs), outputRefs: [], createdAt: now, updatedAt: now,
    };
    const run: AgentRun = {
      id: randomUUID(), sessionId: this.#sessionId, definitionId: input.target.id, name: input.target.name,
      role: 'member', status: 'queued', currentTaskId: task.id, usage: { ...EMPTY_USAGE },
    };
    task.assignedAgentId = run.id;
    this.#tasks.push(task);
    this.#runs.push(run);
    this.record('task.assigned', lead.id, { task, run, targetAgentId: input.target.id });
    this.record('agent.run_created', run.id, run);
    this.changed();
    queueMicrotask(() => { void this.drain(); });
    return { runId: run.id, taskId: task.id };
  }

  sendMessage(input: { fromAgentId: string; toAgentId: string; content: string; taskId?: string }): MailboxMessage {
    const fromDefinition = this.definitionIdForActor(input.fromAgentId);
    const toDefinition = this.definitionIdForActor(input.toAgentId);
    if (!fromDefinition || !toDefinition) throw new Error('发件或收件 Agent 不属于当前会话');
    const message: MailboxMessage = {
      id: randomUUID(), sessionId: this.#sessionId, fromAgentId: fromDefinition, toAgentId: toDefinition,
      content: normalizeText(input.content, 'Agent 消息', 100_000), createdAt: new Date().toISOString(),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
    this.#mailbox.push(message);
    this.record('mailbox.message_sent', fromDefinition, message);
    this.#onMessage?.(structuredClone(message));
    this.changed();
    return structuredClone(message);
  }

  readMailbox(definitionId: string): MailboxMessage[] {
    const now = new Date().toISOString();
    let updated = false;
    for (let index = 0; index < this.#mailbox.length; index += 1) {
      const message = this.#mailbox[index];
      if (message?.toAgentId === definitionId && !message.readAt) {
        this.#mailbox[index] = { ...message, readAt: now };
        this.record('mailbox.message_read', definitionId, { id: message.id, readAt: now });
        updated = true;
      }
    }
    if (updated) this.changed();
    return structuredClone(this.#mailbox.filter((message) => message.toAgentId === definitionId));
  }

  pause(runId: string): void {
    const run = this.requireRun(runId);
    if (run.role !== 'member' || !['queued', 'running'].includes(run.status)) return;
    this.#controllers.get(runId)?.abort(new Error('Agent paused'));
    run.status = 'paused';
    const task = this.taskFor(run);
    if (task) { task.status = 'waiting_user'; task.updatedAt = new Date().toISOString(); }
    this.record('agent.run_paused', run.definitionId, { runId, taskId: task?.id });
    this.changed();
  }

  resume(runId: string): void {
    if (this.#stopping) throw new Error('Agent 调度正在停止，不能恢复任务');
    const run = this.requireRun(runId);
    if (!['paused', 'failed'].includes(run.status)) return;
    if (!this.#presets.has(run.definitionId)) throw new Error(`Agent 配置无法恢复：${run.definitionId}`);
    run.status = 'queued';
    delete run.finishedAt;
    const task = this.taskFor(run);
    if (task) { task.status = 'queued'; task.outputRefs = []; task.updatedAt = new Date().toISOString(); }
    this.record('agent.run_resumed', run.definitionId, { runId, taskId: task?.id });
    this.changed();
    queueMicrotask(() => { void this.drain(); });
  }

  cancel(runId: string): void {
    const run = this.requireRun(runId);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return;
    this.#controllers.get(runId)?.abort(new Error('Agent cancelled'));
    run.status = 'cancelled';
    run.finishedAt = new Date().toISOString();
    const task = this.taskFor(run);
    if (task) { task.status = 'cancelled'; task.updatedAt = run.finishedAt; }
    this.record('agent.run_cancelled', run.definitionId, { runId, taskId: task?.id });
    this.changed();
  }

  takeOver(runId: string): AgentTask {
    const run = this.requireRun(runId);
    if (run.role !== 'member') throw new Error('只能接管成员 Agent 的任务');
    const task = this.taskFor(run);
    if (!task) throw new Error('Agent 没有可接管任务');
    this.#controllers.get(runId)?.abort(new Error('Task taken over by lead'));
    run.status = 'cancelled';
    run.finishedAt = new Date().toISOString();
    task.status = 'waiting_user';
    task.assignedAgentId = this.#leadRunId;
    task.updatedAt = run.finishedAt;
    this.record('task.taken_over', this.lead().definitionId, { task, previousRunId: runId });
    this.changed();
    return structuredClone(task);
  }

  requestClarification(runId: string, question: string, taskId?: string): MailboxMessage {
    const run = this.requireRun(runId);
    if (run.role !== 'member') throw new Error('只有成员 Agent 可以向主管追问');
    const lead = this.lead();
    const message = this.sendMessage({ fromAgentId: run.definitionId, toAgentId: lead.definitionId, content: `需要澄清：${question}`, ...(taskId ? { taskId } : {}) });
    run.status = 'paused';
    const task = this.taskFor(run);
    if (task) { task.status = 'waiting_user'; task.updatedAt = new Date().toISOString(); }
    this.record('agent.clarification_requested', run.definitionId, { runId, taskId: task?.id, messageId: message.id, question });
    this.changed();
    queueMicrotask(() => this.#controllers.get(runId)?.abort(new Error('Agent waiting for clarification')));
    return message;
  }

  snapshot(): TeamSnapshot {
    return structuredClone({ runs: this.#runs, tasks: this.#tasks, mailbox: this.#mailbox });
  }

  hasInFlightRuns(): boolean { return this.#activeRuns.size > 0; }

  setLeadStatus(status: AgentRun['status']): void {
    const lead = this.#runs.find((run) => run.id === this.#leadRunId);
    if (!lead) return;
    lead.status = status;
    if (status === 'running') lead.startedAt ??= new Date().toISOString();
    if (['completed', 'failed', 'cancelled'].includes(status)) lead.finishedAt = new Date().toISOString();
    this.changed();
  }

  addLeadUsage(usage: ModelUsage): void {
    const lead = this.#runs.find((run) => run.id === this.#leadRunId);
    if (!lead) return;
    lead.usage = addUsage(lead.usage, usage);
    this.changed();
  }

  async waitForRuns(runIds: string[], signal: AbortSignal): Promise<string> {
    const unique = [...new Set(runIds)];
    if (unique.length === 0) throw new Error('至少指定一个 Agent 运行');
    for (const id of unique) if (this.requireRun(id).role !== 'member') throw new Error(`不是成员 Agent 运行：${id}`);
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error('等待已取消');
      const runs = unique.map((id) => this.requireRun(id));
      if (runs.every((run) => ['completed', 'failed', 'cancelled'].includes(run.status))) {
        const lead = this.lead();
        const reports = this.#mailbox.filter((message) => message.toAgentId === lead.definitionId && unique.some((id) => this.requireRun(id).definitionId === message.fromAgentId));
        return runs.map((run) => {
          const task = this.taskFor(run);
          const report = reports.filter((message) => message.fromAgentId === run.definitionId && (!task || message.taskId === task.id)).at(-1)?.content;
          return `## ${run.name} · ${run.status}\n任务：${task?.title ?? '未知'}\n${report ?? '未提交文本报告'}\n产物引用：${task?.outputRefs.join(', ') || '无'}`;
        }).join('\n\n');
      }
      await wait(120, signal);
    }
  }

  async stop(): Promise<void> {
    if (this.#stopping) { await Promise.allSettled([...this.#activeRuns.values()]); return; }
    this.#stopping = true;
    const now = new Date().toISOString();
    for (const run of this.#runs.filter((item) => item.role === 'member' && ['queued', 'running'].includes(item.status))) {
      run.status = 'paused';
      const task = this.taskFor(run);
      if (task) { task.status = 'waiting_user'; task.updatedAt = now; }
      this.record('agent.run_paused', run.definitionId, { runId: run.id, taskId: task?.id, reason: 'runtime_shutdown' });
      this.#controllers.get(run.id)?.abort(new Error('Runtime stopped'));
    }
    this.changed();
    await Promise.allSettled([...this.#activeRuns.values()]);
  }

  lead(): AgentRun {
    const lead = this.#runs.find((run) => run.id === this.#leadRunId);
    if (!lead) throw new Error('当前会话尚未绑定主管 Agent');
    return structuredClone(lead);
  }

  private async drain(): Promise<void> {
    if (this.#draining || this.#stopping) return;
    this.#draining = true;
    try {
      while (this.#runs.filter((run) => run.role === 'member' && run.status === 'running').length < this.#maxConcurrent) {
        const run = this.#runs.find((candidate) => candidate.role === 'member' && candidate.status === 'queued');
        if (!run) break;
        const active = this.startMember(run);
        this.#activeRuns.set(run.id, active);
        void active.finally(() => {
          this.#activeRuns.delete(run.id);
          this.changed();
          if (!this.#stopping) queueMicrotask(() => { void this.drain(); });
        }).catch(() => undefined);
      }
    } finally { this.#draining = false; }
  }

  private async startMember(run: AgentRun): Promise<void> {
    const task = this.taskFor(run);
    const preset = this.#presets.get(run.definitionId);
    const definition = this.#definitions.get(run.definitionId);
    if (!task || !preset || !definition) return;
    const controller = new AbortController();
    this.#controllers.set(run.id, controller);
    run.status = 'running';
    run.startedAt ??= new Date().toISOString();
    task.status = 'running';
    task.updatedAt = new Date().toISOString();
    this.record('agent.run_started', run.definitionId, { runId: run.id, taskId: task.id });
    this.changed();
    try {
      const output = await this.#runMember({ run: structuredClone(run), definition: structuredClone(definition), task: structuredClone(task), preset: structuredClone(preset), signal: controller.signal, mailbox: this.readMailbox(run.definitionId) });
      if (['paused', 'cancelled'].includes(run.status as string)) return;
      run.status = 'completed';
      run.finishedAt = new Date().toISOString();
      run.usage = output.usage ?? run.usage;
      task.status = 'completed';
      task.outputRefs = output.outputRefs ?? [];
      task.updatedAt = run.finishedAt;
      this.record('agent.run_completed', run.definitionId, { run, task });
      if (output.text?.trim()) this.sendMessage({ fromAgentId: run.definitionId, toAgentId: this.lead().definitionId, taskId: task.id, content: output.text });
    } catch (error) {
      if (['paused', 'cancelled'].includes(run.status as string)) return;
      run.status = 'failed';
      run.finishedAt = new Date().toISOString();
      task.status = 'failed';
      task.updatedAt = run.finishedAt;
      this.record('agent.run_failed', run.definitionId, { runId: run.id, taskId: task.id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.#controllers.delete(run.id);
      this.changed();
    }
  }

  private definitionIdForActor(id: string): string | undefined {
    if (this.#definitions.has(id)) return id;
    return this.#runs.find((run) => run.id === id)?.definitionId;
  }

  private requireRun(id: string): AgentRun {
    const run = this.#runs.find((item) => item.id === id);
    if (!run) throw new Error(`Agent 运行不存在：${id}`);
    return run;
  }

  private taskFor(run: AgentRun): AgentTask | undefined { return this.#tasks.find((task) => task.id === run.currentTaskId); }

  private record(kind: string, agentId: string, payload: unknown): void {
    this.#events.append({ streamId: `session:${this.#sessionId}`, kind, actor: { id: agentId, kind: 'agent' }, agentId, payload: toJson(payload) });
  }

  private changed(): void { this.#onChange(this.snapshot()); }
}

function normalizeText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
  const text = value.normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  if (!text || [...text].length > maximum) throw new Error(`${label}长度必须为 1–${maximum} 个字符`);
  return text;
}

function normalizeRefs(refs: unknown): string[] {
  if (!Array.isArray(refs) || refs.length > 500 || refs.some((ref) => typeof ref !== 'string' || !ref || ref.length > 500)) throw new Error('任务输入引用无效');
  return [...new Set(refs)];
}

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens, completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens, cacheHitTokens: left.cacheHitTokens + right.cacheHitTokens,
    cacheMissTokens: left.cacheMissTokens + right.cacheMissTokens, reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('等待已取消')); };
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    signal.addEventListener('abort', abort, { once: true });
  });
}
