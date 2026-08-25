import { randomUUID } from 'node:crypto';
import type { ChannelMessage, CollaborationChannel, EventActor } from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { isRecord, toJson } from '../util/json.js';

const USER_ACTOR: EventActor = { id: 'local-user', kind: 'user', label: '本地用户' };

export class ChannelStore {
  readonly #events: SqliteEventStore;
  readonly #projectId: string;
  readonly #channels = new Map<string, CollaborationChannel>();
  #activeChannelId: string | undefined;

  constructor(options: { events: SqliteEventStore; projectId: string }) {
    this.#events = options.events;
    this.#projectId = options.projectId;
    this.replay();
    const stored = this.#events.getValue<string>(`activeChannelId:${this.#projectId}`);
    if (stored && this.#channels.get(stored)?.status !== 'archived') this.#activeChannelId = stored;
    else this.#activeChannelId = this.list()[0]?.id;
  }

  list(includeArchived = false): CollaborationChannel[] {
    return structuredClone([...this.#channels.values()]
      .filter((channel) => includeArchived || channel.status !== 'archived')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  activeChannelId(): string | undefined {
    return this.#activeChannelId;
  }

  setActive(id: string): CollaborationChannel {
    const channel = this.require(id);
    if (channel.status === 'archived') throw new Error('频道已归档');
    this.#activeChannelId = id;
    this.#events.setValue(`activeChannelId:${this.#projectId}`, id);
    return channel;
  }

  createGroup(input: { name: string; leadAgentId: string; memberAgentIds: string[]; toolAccess?: CollaborationChannel['toolAccess']; minReplies?: number; maxReplies?: number }, actor: EventActor = USER_ACTOR): CollaborationChannel {
    const members = normalizeMembers([input.leadAgentId, ...input.memberAgentIds]);
    if (members.length < 2 || members.length > 6) throw new Error('群聊必须包含 2–6 个不同 Agent');
    const now = new Date().toISOString();
    const limits = normalizeReplyLimits(input.minReplies, input.maxReplies);
    const channel: CollaborationChannel = {
      id: randomUUID(),
      projectId: this.#projectId,
      kind: 'group',
      name: normalizeName(input.name),
      leadAgentId: input.leadAgentId,
      memberAgentIds: members,
      toolAccess: input.toolAccess ?? 'read_only',
      ...limits,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    };
    this.#channels.set(channel.id, channel);
    this.#activeChannelId = channel.id;
    this.#events.append({ streamId: `project:${this.#projectId}`, kind: 'channel.created', actor, payload: toJson(channel) });
    this.#events.setValue(`activeChannelId:${this.#projectId}`, channel.id);
    return structuredClone(channel);
  }

  ensurePrivate(agentIds: [string, string], names: [string, string], actor: EventActor): CollaborationChannel {
    const sorted = [...agentIds].sort();
    const existing = this.list(true).find((channel) => channel.kind === 'private' && [...channel.memberAgentIds].sort().join(':') === sorted.join(':'));
    if (existing) {
      if (existing.status === 'archived') return this.update(existing.id, { status: 'idle' }, actor);
      return existing;
    }
    const now = new Date().toISOString();
    const channel: CollaborationChannel = {
      id: randomUUID(),
      projectId: this.#projectId,
      kind: 'private',
      name: `${names[0]} · ${names[1]}`,
      leadAgentId: agentIds[0],
      memberAgentIds: [...agentIds],
      toolAccess: 'read_only',
      minReplies: 1,
      maxReplies: 3,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    };
    this.#channels.set(channel.id, channel);
    if (!this.#activeChannelId) {
      this.#activeChannelId = channel.id;
      this.#events.setValue(`activeChannelId:${this.#projectId}`, channel.id);
    }
    this.#events.append({ streamId: `project:${this.#projectId}`, kind: 'channel.created', actor, payload: toJson(channel) });
    return structuredClone(channel);
  }

  update(id: string, patch: Partial<Pick<CollaborationChannel, 'name' | 'leadAgentId' | 'memberAgentIds' | 'toolAccess' | 'minReplies' | 'maxReplies' | 'status'>>, actor: EventActor = USER_ACTOR): CollaborationChannel {
    const current = this.require(id);
    if (['running', 'paused'].includes(current.status) && (patch.memberAgentIds || patch.leadAgentId || patch.toolAccess || patch.minReplies !== undefined || patch.maxReplies !== undefined)) {
      throw new Error('频道运行期间不能修改成员、工具权限或回复轮数');
    }
    const members = patch.memberAgentIds ? normalizeMembers(patch.memberAgentIds) : current.memberAgentIds;
    if (members.length < 2 || members.length > 6) throw new Error('频道必须包含 2–6 个不同 Agent');
    const lead = patch.leadAgentId ?? current.leadAgentId;
    if (!members.includes(lead)) throw new Error('频道主管必须属于频道成员');
    const limits = normalizeReplyLimits(patch.minReplies ?? current.minReplies, patch.maxReplies ?? current.maxReplies);
    const next: CollaborationChannel = {
      ...current,
      ...(patch.name !== undefined ? { name: normalizeName(patch.name) } : {}),
      leadAgentId: lead,
      memberAgentIds: members,
      ...(patch.toolAccess !== undefined ? { toolAccess: normalizeToolAccess(patch.toolAccess) } : {}),
      ...limits,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.#channels.set(id, next);
    this.#events.append({ streamId: `project:${this.#projectId}`, kind: patch.status ? `channel.${statusEvent(patch.status)}` : 'channel.settings_changed', actor, payload: toJson(next) });
    return structuredClone(next);
  }

  archive(id: string, actor: EventActor = USER_ACTOR): CollaborationChannel {
    const current = this.require(id);
    if (current.status === 'running') throw new Error('请先停止频道运行再归档');
    const archived = this.update(id, { status: 'archived' }, actor);
    if (this.#activeChannelId === id) {
      this.#activeChannelId = this.list()[0]?.id;
      if (this.#activeChannelId) this.#events.setValue(`activeChannelId:${this.#projectId}`, this.#activeChannelId);
    }
    return archived;
  }

  messages(channelId: string): ChannelMessage[] {
    this.require(channelId, true);
    const messages: ChannelMessage[] = [];
    for (const event of this.#events.list(`channel:${channelId}`)) {
      if (event.kind !== 'channel.message_sent' || !isRecord(event.payload) || typeof event.payload.id !== 'string') continue;
      messages.push(event.payload as unknown as ChannelMessage);
    }
    return structuredClone(messages);
  }

  send(input: { channelId: string; fromAgentId: string; toAgentIds: string[]; content: string; sessionId?: string; taskId?: string; sourceEventIds?: string[] }, actor?: EventActor): ChannelMessage {
    const channel = this.require(input.channelId);
    if (channel.status === 'archived') throw new Error('频道已归档');
    if (!channel.memberAgentIds.includes(input.fromAgentId)) throw new Error('发件 Agent 不属于频道');
    const recipients = normalizeMembers(input.toAgentIds);
    if (recipients.some((id) => !channel.memberAgentIds.includes(id))) throw new Error('收件 Agent 不属于频道');
    const content = normalizeContent(input.content);
    const message: ChannelMessage = {
      id: randomUUID(),
      channelId: input.channelId,
      fromAgentId: input.fromAgentId,
      toAgentIds: recipients,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      content,
      sourceEventIds: normalizeRefs(input.sourceEventIds ?? []),
      createdAt: new Date().toISOString(),
    };
    this.#events.append({
      streamId: `channel:${channel.id}`,
      kind: 'channel.message_sent',
      actor: actor ?? { id: input.fromAgentId, kind: 'agent' },
      agentId: input.fromAgentId,
      provenanceRefs: message.sourceEventIds,
      payload: toJson(message),
    });
    channel.updatedAt = message.createdAt;
    this.#channels.set(channel.id, channel);
    this.#events.append({ streamId: `project:${this.#projectId}`, kind: 'channel.settings_changed', actor: actor ?? { id: input.fromAgentId, kind: 'agent' }, payload: toJson(channel) });
    return structuredClone(message);
  }

  exportMarkdown(id: string, agentName: (id: string) => string): string {
    const channel = this.require(id, true);
    const lines = [`# ${channel.name}`, '', `- 类型：${channel.kind === 'private' ? '私聊' : '群聊'}`, `- 工具权限：${channel.toolAccess === 'read_only' ? '只读' : '写入上限'}`, `- 成员：${channel.memberAgentIds.map(agentName).join('、')}`, ''];
    for (const message of this.messages(id)) {
      lines.push(`## ${agentName(message.fromAgentId)} · ${message.createdAt}`, '', message.content, '');
      if (message.taskId) lines.push(`任务引用：${message.taskId}`, '');
      if (message.sourceEventIds.length) lines.push(`来源事件：${message.sourceEventIds.join(', ')}`, '');
    }
    return lines.join('\n');
  }

  require(id: string, includeArchived = false): CollaborationChannel {
    const channel = this.#channels.get(id);
    if (!channel || (!includeArchived && channel.status === 'archived')) throw new Error(`频道不存在或已归档：${id}`);
    return structuredClone(channel);
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (!['channel.created', 'channel.settings_changed', 'channel.run_started', 'channel.run_completed', 'channel.paused', 'channel.archived'].includes(event.kind) || !isRecord(event.payload) || typeof event.payload.id !== 'string') continue;
      this.#channels.set(event.payload.id, event.payload as unknown as CollaborationChannel);
    }
  }
}

function normalizeMembers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 6 || value.some((id) => typeof id !== 'string' || !id || id.length > 200)) throw new Error('频道成员列表无效');
  return [...new Set(value)];
}

function normalizeReplyLimits(minimum: unknown, maximum: unknown): Pick<CollaborationChannel, 'minReplies' | 'maxReplies'> {
  const minReplies = Math.min(8, Math.max(1, Math.trunc(Number(minimum ?? 1))));
  const maxReplies = Math.min(8, Math.max(minReplies, Math.trunc(Number(maximum ?? 3))));
  return { minReplies, maxReplies };
}

function normalizeToolAccess(value: unknown): CollaborationChannel['toolAccess'] {
  if (value !== 'read_only' && value !== 'write') throw new Error('频道工具权限无效');
  return value;
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('频道名称必须是字符串');
  const name = value.normalize('NFC').trim();
  if (!name || [...name].length > 80) throw new Error('频道名称长度必须为 1–80 个字符');
  return name;
}

function normalizeContent(value: unknown): string {
  if (typeof value !== 'string') throw new Error('频道消息必须是字符串');
  const content = value.normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  if (!content || [...content].length > 100_000) throw new Error('频道消息长度必须为 1–100,000 个字符');
  return content;
}

function normalizeRefs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500 || value.some((id) => typeof id !== 'string' || !id || id.length > 500)) throw new Error('频道来源引用无效');
  return [...new Set(value)];
}

function statusEvent(status: CollaborationChannel['status']): string {
  if (status === 'running') return 'run_started';
  if (status === 'paused') return 'paused';
  if (status === 'archived') return 'archived';
  return 'run_completed';
}
