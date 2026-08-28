import { randomUUID } from 'node:crypto';
import type {
  EventActor,
  JsonValue,
  LayoutProposalV1,
  MountIntentV1,
  WorkbenchBlueprintV1,
  WorkbenchInstanceV1,
  WorkbenchSlotV1,
  WorktableInstance,
  WorktablePane,
  WorktableSplitNode,
  WorktableTemplateContribution,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { toJson } from '../util/json.js';
import type { WorktableStore } from '../worktable/worktable-store.js';

const EMPTY_INPUT_SCHEMA = { type: 'object', additionalProperties: false } as const;
const TEMPLATE_OPENED_AT = 'template';

export const CORE_WORKBENCH_BLUEPRINTS: WorkbenchBlueprintV1[] = [
  {
    schemaVersion: 1,
    id: 'sci.core:research',
    version: '1.0.0',
    title: '科研工作台',
    description: '项目文件、任务、审批与科研产物的通用控制底座。',
    icon: 'flask-conical',
    kind: 'research',
    inputSchema: EMPTY_INPUT_SCHEMA,
    layout: {
      kind: 'split', direction: 'horizontal', ratio: 0.28,
      first: { kind: 'pane', paneId: 'control' },
      second: { kind: 'pane', paneId: 'main' },
    },
    panes: [
      {
        id: 'control', title: '控制室',
        tabs: [
          { id: 'control-room', title: '控制室', content: { kind: 'builtin', type: 'control-room' }, openedAt: TEMPLATE_OPENED_AT },
          { id: 'tasks', title: '任务', content: { kind: 'builtin', type: 'tasks' }, openedAt: TEMPLATE_OPENED_AT },
        ],
        activeTabId: 'control-room',
      },
      {
        id: 'main', title: '项目',
        tabs: [{ id: 'explorer', title: '文件', content: { kind: 'builtin', type: 'explorer' }, openedAt: TEMPLATE_OPENED_AT }],
        activeTabId: 'explorer',
      },
    ],
    slots: [
      { id: 'control', role: 'tasks', paneId: 'control', title: '控制室', accepts: ['builtin'], autoMount: false },
      { id: 'output', role: 'output', paneId: 'main', title: '科研产物', accepts: ['artifact', 'document', 'generated-app'], autoMount: true },
    ],
    commands: ['workbench.new-run', 'workbench.mount-output'],
  },
  {
    schemaVersion: 1,
    id: 'sci.paper-reader:deep-read',
    version: '1.0.0',
    title: '论文精读',
    description: '主论文与 SI 的可追溯双语精读、主张—证据与复现报告。',
    icon: 'book-open-text',
    pluginId: 'sci.paper-reader',
    kind: 'research',
    inputSchema: {
      type: 'object',
      properties: {
        mainPdf: {
          type: 'object',
          properties: {
            rootId: { type: 'string' }, path: { type: 'string' }, name: { type: 'string' },
            sha256: { type: 'string' }, size: { type: 'number' }, mediaType: { type: 'string' },
          },
          required: ['rootId', 'path', 'sha256'],
          additionalProperties: true,
        },
        supplements: {
          type: 'array',
          items: {
            type: 'object',
            properties: { rootId: { type: 'string' }, path: { type: 'string' }, name: { type: 'string' }, sha256: { type: 'string' }, size: { type: 'number' }, mediaType: { type: 'string' } },
            required: ['rootId', 'path', 'sha256'], additionalProperties: true,
          },
        },
        language: { type: 'string', enum: ['zh-CN', 'en'] },
      },
      required: ['mainPdf'],
      additionalProperties: false,
    },
    inputUi: {
      controls: [
        { kind: 'file', field: 'mainPdf', label: '主论文 PDF', accept: ['application/pdf'], required: true },
        { kind: 'file', field: 'supplements', label: '补充材料（SI）', accept: ['application/pdf'], multiple: true },
        { kind: 'select', field: 'language', label: '解读语言', options: [{ value: 'zh-CN', label: '中文' }, { value: 'en', label: 'English' }] },
      ],
    },
    layout: {
      kind: 'split', direction: 'horizontal', ratio: 0.58,
      first: { kind: 'pane', paneId: 'source' },
      second: { kind: 'pane', paneId: 'analysis' },
    },
    panes: [
      {
        id: 'source', title: '原文',
        tabs: [{ id: 'paper-source', title: '原文 / 双语', content: { kind: 'plugin-panel', pluginId: 'sci.paper-reader', panelId: 'source' }, pinned: true, openedAt: TEMPLATE_OPENED_AT }],
        activeTabId: 'paper-source',
      },
      {
        id: 'analysis', title: '精读',
        tabs: [{ id: 'paper-analysis', title: '章节跟读与全局报告', content: { kind: 'plugin-panel', pluginId: 'sci.paper-reader', panelId: 'analysis' }, pinned: true, openedAt: TEMPLATE_OPENED_AT }],
        activeTabId: 'paper-analysis',
      },
    ],
    slots: [
      { id: 'source', role: 'source', paneId: 'source', title: '论文证据', accepts: ['document', 'plugin-panel'], autoMount: false },
      { id: 'analysis', role: 'analysis', paneId: 'analysis', title: '精读结果', accepts: ['artifact', 'plugin-panel'], autoMount: true },
      { id: 'evidence', role: 'evidence', paneId: 'analysis', title: '证据抽屉', accepts: ['artifact'], autoMount: true },
    ],
    commands: ['paper.parse', 'paper.deep-read', 'paper.regenerate-selection', 'paper.export'],
  },
];

export function workbenchBlueprintToTemplate(blueprint: WorkbenchBlueprintV1): WorktableTemplateContribution {
  return {
    id: blueprint.id,
    version: blueprint.version,
    title: blueprint.title,
    ...(blueprint.description ? { description: blueprint.description } : {}),
    ...(blueprint.icon ? { icon: blueprint.icon } : {}),
    ...(blueprint.pluginId ? { pluginId: blueprint.pluginId } : {}),
    kind: blueprint.kind,
    inputSchema: structuredClone(blueprint.inputSchema),
    ...(blueprint.inputUi ? { inputUi: structuredClone(blueprint.inputUi) } : {}),
    layout: structuredClone(blueprint.layout),
    panes: structuredClone(blueprint.panes),
    commands: [...blueprint.commands],
  };
}

interface InstanceMetadata {
  instanceId: string;
  blueprintId: string;
  blueprintVersion: string;
  primaryConversationId?: string;
  slots: WorkbenchSlotV1[];
}

interface WorkbenchEventPayload {
  metadata?: InstanceMetadata;
  proposal?: LayoutProposalV1;
  mountKey?: string;
}

function remapSlots(blueprint: WorkbenchBlueprintV1, instance: WorktableInstance): WorkbenchSlotV1[] {
  const paneIds = new Map(blueprint.panes.map((pane, index) => [pane.id, instance.panes[index]?.id]));
  return blueprint.slots.map((slot) => {
    const paneId = paneIds.get(slot.paneId);
    if (!paneId) throw new Error(`Workbench slot 未能映射到实例窗格：${slot.id}`);
    return { ...structuredClone(slot), paneId };
  });
}

export class WorkbenchService {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #worktables: WorktableStore;
  readonly #blueprints = new Map<string, WorkbenchBlueprintV1>();
  readonly #pluginBlueprintIds = new Set<string>();
  readonly #metadata = new Map<string, InstanceMetadata>();
  readonly #proposals = new Map<string, LayoutProposalV1>();
  readonly #mountKeys = new Set<string>();

  constructor(options: { projectId: string; events: SqliteEventStore; worktables: WorktableStore }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.#worktables = options.worktables;
    this.register(CORE_WORKBENCH_BLUEPRINTS);
    this.replay();
  }

  register(blueprints: WorkbenchBlueprintV1[]): void {
    for (const blueprint of blueprints) {
      if (blueprint.schemaVersion !== 1) throw new Error(`不支持的 WorkbenchBlueprint：${blueprint.id}`);
      const current = this.#blueprints.get(blueprint.id);
      if (current && current.version !== blueprint.version) throw new Error(`WorkbenchBlueprint ID 冲突：${blueprint.id}`);
      this.#blueprints.set(blueprint.id, structuredClone(blueprint));
    }
  }

  replacePluginBlueprints(blueprints: WorkbenchBlueprintV1[]): void {
    for (const id of this.#pluginBlueprintIds) this.#blueprints.delete(id);
    this.#pluginBlueprintIds.clear();
    for (const blueprint of blueprints) {
      if (!blueprint.pluginId) throw new Error(`插件 WorkbenchBlueprint 缺少 pluginId：${blueprint.id}`);
      if (CORE_WORKBENCH_BLUEPRINTS.some((candidate) => candidate.id === blueprint.id) || this.#blueprints.has(blueprint.id)) {
        throw new Error(`插件 WorkbenchBlueprint ID 冲突：${blueprint.id}`);
      }
      this.#blueprints.set(blueprint.id, structuredClone(blueprint));
      this.#pluginBlueprintIds.add(blueprint.id);
    }
  }

  blueprints(): WorkbenchBlueprintV1[] {
    return [...this.#blueprints.values()].map((blueprint) => structuredClone(blueprint));
  }

  templates(): WorktableTemplateContribution[] {
    return this.blueprints().map(workbenchBlueprintToTemplate);
  }

  list(): WorkbenchInstanceV1[] {
    return this.#worktables.snapshot().instances.flatMap((instance) => {
      const metadata = this.#metadata.get(instance.id);
      return metadata ? [this.project(instance, metadata)] : [];
    });
  }

  inspect(instanceId: string): WorkbenchInstanceV1 {
    const instance = this.#worktables.snapshot().instances.find((candidate) => candidate.id === instanceId);
    const metadata = this.#metadata.get(instanceId);
    if (!instance || !metadata) throw new Error('Workbench 实例不存在');
    return this.project(instance, metadata);
  }

  create(input: { blueprintId: string; title?: string; primaryConversationId?: string; inputs?: Record<string, JsonValue> }, actor: EventActor): WorkbenchInstanceV1 {
    const blueprint = this.#blueprints.get(input.blueprintId);
    if (!blueprint) throw new Error(`WorkbenchBlueprint 不存在：${input.blueprintId}`);
    const instance = this.#worktables.create(workbenchBlueprintToTemplate(blueprint), {
      ...(input.title ? { title: input.title } : {}),
      ...(input.primaryConversationId ? { boundSessionId: input.primaryConversationId } : {}),
      ...(input.inputs ? { inputs: input.inputs } : {}),
    }, actor);
    const metadata: InstanceMetadata = {
      instanceId: instance.id,
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
      ...(input.primaryConversationId ? { primaryConversationId: input.primaryConversationId } : {}),
      slots: remapSlots(blueprint, instance),
    };
    this.#metadata.set(instance.id, metadata);
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'workbench.instance_created',
      actor,
      revision: instance.revision,
      idempotencyKey: `workbench:create:${instance.id}`,
      provenanceRefs: [instance.id, blueprint.id],
      payload: toJson({ metadata }),
    });
    return this.project(instance, metadata);
  }

  mount(intent: MountIntentV1, actor: EventActor): WorkbenchInstanceV1 {
    if (intent.schemaVersion !== 1 || !intent.idempotencyKey.trim()) throw new Error('MountIntent 无效');
    if (this.#mountKeys.has(intent.idempotencyKey)) return this.inspect(intent.instanceId);
    const instance = this.inspect(intent.instanceId);
    const slot = instance.slots.find((candidate) => candidate.role === intent.targetRole);
    if (!slot) throw new Error(`Workbench 未声明目标角色槽位：${intent.targetRole}`);
    if (!slot.autoMount) throw new Error(`目标槽位 ${slot.title} 不允许自动挂载`);
    if (!slot.accepts.includes('artifact')) throw new Error(`目标槽位 ${slot.title} 不接受 Artifact`);
    this.#worktables.mountTab(intent.instanceId, slot.paneId, {
      title: intent.title?.trim() || `Artifact ${intent.artifact.artifactId}`,
      content: {
        kind: 'artifact', artifactId: intent.artifact.artifactId, revisionId: intent.artifact.revisionId,
        ...(intent.presentation?.role ? { role: intent.presentation.role } : {}),
      },
    }, actor);
    const updated = this.inspect(intent.instanceId);
    this.#mountKeys.add(intent.idempotencyKey);
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'workbench.mount_applied',
      actor,
      revision: updated.revision,
      idempotencyKey: intent.idempotencyKey,
      provenanceRefs: [intent.instanceId, intent.artifact.artifactId, intent.artifact.revisionId],
      payload: toJson({ mountKey: intent.idempotencyKey, intent }),
    });
    return updated;
  }

  proposeLayout(input: {
    instanceId: string;
    baseRevision: number;
    title: string;
    reason: string;
    layout: WorktableSplitNode;
    panes: WorktablePane[];
    slots: WorkbenchSlotV1[];
  }, actor: EventActor): LayoutProposalV1 {
    const instance = this.inspect(input.instanceId);
    if (instance.revision !== input.baseRevision) throw new Error('布局提案基于过期 revision');
    const paneIds = new Set(input.panes.map((pane) => pane.id));
    if (input.slots.some((slot) => !paneIds.has(slot.paneId))) throw new Error('布局提案槽位引用了不存在的窗格');
    const proposal: LayoutProposalV1 = {
      schemaVersion: 1,
      id: randomUUID(),
      instanceId: input.instanceId,
      baseRevision: input.baseRevision,
      title: input.title.trim().slice(0, 200) || '布局变更',
      reason: input.reason.trim().slice(0, 2_000),
      layout: structuredClone(input.layout),
      panes: structuredClone(input.panes),
      slots: structuredClone(input.slots),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.#proposals.set(proposal.id, proposal);
    this.recordProposal('workbench.layout_proposed', proposal, actor);
    return structuredClone(proposal);
  }

  decideLayout(proposalId: string, accepted: boolean, actor: EventActor): LayoutProposalV1 {
    const current = this.#proposals.get(proposalId);
    if (!current || current.status !== 'pending') throw new Error('布局提案不存在或已处理');
    const proposal = structuredClone(current);
    const instance = this.inspect(proposal.instanceId);
    if (instance.revision !== proposal.baseRevision) {
      proposal.status = 'stale';
    } else if (!accepted) {
      proposal.status = 'rejected';
    } else {
      this.#worktables.patch(proposal.instanceId, {
        layout: proposal.layout,
        panes: proposal.panes,
        ifRevision: proposal.baseRevision,
      }, actor);
      const metadata = this.#metadata.get(proposal.instanceId)!;
      metadata.slots = structuredClone(proposal.slots);
      this.#metadata.set(proposal.instanceId, metadata);
      proposal.status = 'accepted';
    }
    proposal.decidedAt = new Date().toISOString();
    this.#proposals.set(proposal.id, proposal);
    this.recordProposal('workbench.layout_decided', proposal, actor);
    return structuredClone(proposal);
  }

  proposals(instanceId?: string): LayoutProposalV1[] {
    return [...this.#proposals.values()]
      .filter((proposal) => !instanceId || proposal.instanceId === instanceId)
      .map((proposal) => structuredClone(proposal));
  }

  syncConversation(instanceId: string, primaryConversationId: string | undefined, actor: EventActor): WorkbenchInstanceV1 {
    const metadata = this.#metadata.get(instanceId);
    if (!metadata) throw new Error('Workbench 实例不存在');
    const instance = this.#worktables.patch(instanceId, { boundSessionId: primaryConversationId ?? null }, actor);
    if (primaryConversationId) metadata.primaryConversationId = primaryConversationId;
    else delete metadata.primaryConversationId;
    this.#metadata.set(instanceId, metadata);
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'workbench.conversation_bound',
      actor,
      revision: instance.revision,
      idempotencyKey: `workbench:bind:${instanceId}:${instance.revision}`,
      provenanceRefs: [instanceId, ...(primaryConversationId ? [primaryConversationId] : [])],
      payload: toJson({ metadata }),
    });
    return this.project(instance, metadata);
  }

  private project(instance: WorktableInstance, metadata: InstanceMetadata): WorkbenchInstanceV1 {
    return {
      ...structuredClone(instance),
      schemaVersion: 1,
      blueprintId: metadata.blueprintId,
      blueprintVersion: metadata.blueprintVersion,
      ...(instance.boundSessionId ? { primaryConversationId: instance.boundSessionId } : {}),
      slots: structuredClone(metadata.slots),
    };
  }

  private recordProposal(kind: string, proposal: LayoutProposalV1, actor: EventActor): void {
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind,
      actor,
      revision: proposal.baseRevision,
      idempotencyKey: `${kind}:${proposal.id}:${proposal.status}`,
      provenanceRefs: [proposal.instanceId, proposal.id],
      payload: toJson({ proposal }),
    });
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (!event.kind.startsWith('workbench.')) continue;
      const payload = event.payload as unknown as WorkbenchEventPayload;
      if (payload.metadata?.instanceId) this.#metadata.set(payload.metadata.instanceId, structuredClone(payload.metadata));
      if (payload.proposal?.id) this.#proposals.set(payload.proposal.id, structuredClone(payload.proposal));
      if (payload.mountKey) this.#mountKeys.add(payload.mountKey);
    }
  }
}
