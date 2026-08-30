import { randomUUID } from 'node:crypto';
import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv';
import type {
  Annotation,
  AnnotationSelector,
  DocumentRevisionRef,
  EventActor,
  JsonSchema,
  JsonValue,
  JobRecord,
  WorktableContent,
  WorktableContextSnapshot,
  WorktableInstance,
  WorktablePane,
  WorktableSplitNode,
  WorktableState,
  WorktableTab,
  WorktableTemplateContribution,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { isRecord, toJson } from '../util/json.js';

export const MAX_WORKTABLE_PANES = 6;
export const MAX_WORKTABLE_TABS = 20;

const DEFAULT_PANE_ID = 'main';
const EMPTY_INPUT_SCHEMA: JsonSchema = { type: 'object', additionalProperties: false };
const TEMPLATE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

interface AjvInstance {
  compile(schema: object): ValidateFunction;
  errorsText(errors?: ErrorObject[] | null, options?: { separator?: string }): string;
}

const AjvConstructor = AjvModule as unknown as new (options?: object) => AjvInstance;
const inputAjv = new AjvConstructor({ allErrors: true, strict: false });

export const CORE_WORKTABLE_TEMPLATES: WorktableTemplateContribution[] = [
  {
    id: 'openlab.research',
    version: '1.0.0',
    title: '科研工作台',
    description: '当前项目的文件、任务和科研产物工作区。',
    icon: 'flask-conical',
    kind: 'research',
    inputSchema: EMPTY_INPUT_SCHEMA,
    layout: {
      kind: 'split',
      direction: 'horizontal',
      ratio: 0.28,
      first: { kind: 'pane', paneId: 'control' },
      second: { kind: 'pane', paneId: DEFAULT_PANE_ID },
    },
    panes: [
      {
        id: 'control',
        title: '控制室',
        tabs: [
          { id: 'control-room', title: '控制室', content: { kind: 'builtin', type: 'control-room' }, openedAt: 'template' },
          { id: 'tasks', title: '任务', content: { kind: 'builtin', type: 'tasks' }, openedAt: 'template' },
        ],
        activeTabId: 'control-room',
      },
      {
        id: DEFAULT_PANE_ID,
        title: '项目',
        tabs: [
          { id: 'explorer', title: '文件', content: { kind: 'builtin', type: 'explorer' }, openedAt: 'template' },
        ],
        activeTabId: 'explorer',
      },
    ],
  },
];

function collectLayoutPaneIds(node: WorktableSplitNode, output: string[] = []): string[] {
  if (node.kind === 'pane') {
    output.push(node.paneId);
    return output;
  }
  if (!Number.isFinite(node.ratio) || node.ratio < 0.1 || node.ratio > 0.9) throw new Error('工作台分隔比例必须在 0.1 到 0.9 之间');
  collectLayoutPaneIds(node.first, output);
  collectLayoutPaneIds(node.second, output);
  return output;
}

export function validateWorktableLayout(layout: WorktableSplitNode, panes: WorktablePane[]): void {
  if (panes.length < 1 || panes.length > MAX_WORKTABLE_PANES) throw new Error(`工作台可见窗格数量必须为 1–${MAX_WORKTABLE_PANES}`);
  const paneIds = panes.map((pane) => pane.id);
  if (paneIds.some((id) => !id.trim()) || new Set(paneIds).size !== paneIds.length) throw new Error('工作台窗格 ID 必须非空且唯一');
  const layoutPaneIds = collectLayoutPaneIds(layout);
  if (new Set(layoutPaneIds).size !== layoutPaneIds.length) throw new Error('工作台布局不能重复引用同一窗格');
  if (layoutPaneIds.length !== paneIds.length || layoutPaneIds.some((id) => !paneIds.includes(id))) throw new Error('工作台布局必须且只能引用当前窗格');

  const tabs = panes.flatMap((pane) => pane.tabs);
  if (tabs.length > MAX_WORKTABLE_TABS) throw new Error(`单个工作台最多打开 ${MAX_WORKTABLE_TABS} 个标签`);
  const tabIds = tabs.map((tab) => tab.id);
  if (tabIds.some((id) => !id.trim()) || new Set(tabIds).size !== tabIds.length) throw new Error('工作台标签 ID 必须非空且唯一');
  for (const pane of panes) {
    if (pane.activeTabId && !pane.tabs.some((tab) => tab.id === pane.activeTabId)) throw new Error('活动标签不属于指定窗格');
  }
}

function instantiateTemplate(template: WorktableTemplateContribution): Pick<WorktableInstance, 'layout' | 'panes' | 'activePaneId'> {
  validateWorktableLayout(template.layout, template.panes);
  const paneIds = new Map(template.panes.map((pane) => [pane.id, randomUUID()]));
  const remapLayout = (node: WorktableSplitNode): WorktableSplitNode => node.kind === 'pane'
    ? { kind: 'pane', paneId: paneIds.get(node.paneId)! }
    : { kind: 'split', direction: node.direction, ratio: node.ratio, first: remapLayout(node.first), second: remapLayout(node.second) };
  const openedAt = new Date().toISOString();
  const panes = template.panes.map((pane) => {
    const tabIds = new Map(pane.tabs.map((tab) => [tab.id, randomUUID()]));
    const tabs = pane.tabs.map((tab) => ({ ...structuredClone(tab), id: tabIds.get(tab.id)!, openedAt }));
    return {
      id: paneIds.get(pane.id)!,
      ...(pane.title ? { title: pane.title } : {}),
      tabs,
      ...(pane.activeTabId && tabIds.get(pane.activeTabId) ? { activeTabId: tabIds.get(pane.activeTabId)! } : tabs[0] ? { activeTabId: tabs[0].id } : {}),
    } satisfies WorktablePane;
  });
  return { layout: remapLayout(template.layout), panes, activePaneId: panes[0]!.id };
}

export function validateWorktableInputs(template: WorktableTemplateContribution, inputs: Record<string, JsonValue>): void {
  if (!TEMPLATE_VERSION_PATTERN.test(template.version)) throw new Error('工作台模板 version 必须是语义化版本');
  if (!isRecord(template.inputSchema) || template.inputSchema.type !== 'object') throw new Error('工作台模板 inputSchema 必须描述 JSON 对象');
  let validate: ValidateFunction;
  try {
    validate = inputAjv.compile(template.inputSchema as object);
  } catch (error) {
    throw new Error(`工作台模板输入 Schema 无效：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validate(inputs)) throw new Error(`工作台实例输入不合法：${inputAjv.errorsText(validate.errors, { separator: '; ' })}`);
}

function statePayload(payload: unknown): { state: WorktableState; instanceId?: string; revision?: number } | undefined {
  if (!isRecord(payload)) return undefined;
  const candidate = isRecord(payload.state) ? payload.state : payload;
  if (!Array.isArray(candidate.instances)) return undefined;
  return {
    state: structuredClone(candidate as unknown as WorktableState),
    ...(typeof payload.instanceId === 'string' ? { instanceId: payload.instanceId } : {}),
    ...(typeof payload.revision === 'number' ? { revision: payload.revision } : {}),
  };
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function currentReplayedInstance(instance: WorktableInstance): WorktableInstance | undefined {
  if (!validRevision(instance.revision) || !isRecord(instance.inputs) || !optionalId(instance.templateId)
    || !instance.templateVersion || !TEMPLATE_VERSION_PATTERN.test(instance.templateVersion)) return undefined;
  const normalized = structuredClone(instance);
  for (const key of ['activeRunId', 'artifactId', 'artifactRevisionId'] as const) {
    const value = optionalId(instance[key]);
    if (value) normalized[key] = value;
    else delete normalized[key];
  }
  if (!normalized.artifactId) delete normalized.artifactRevisionId;
  if (normalized.status === 'archived') {
    if (!optionalId(instance.archivedAt)) return undefined;
  } else delete normalized.archivedAt;
  return normalized;
}

export class WorktableStore {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  #state: WorktableState = { instances: [] };
  readonly #revisions = new Map<string, number>();

  constructor(options: { projectId: string; events: SqliteEventStore }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.replay();
  }

  snapshot(): WorktableState {
    return structuredClone(this.#state);
  }

  create(template: WorktableTemplateContribution, input: { title?: string; boundSessionId?: string; id?: string; inputs?: Record<string, JsonValue> } = {}, actor: EventActor): WorktableInstance {
    const seeded = instantiateTemplate(template);
    const inputs = structuredClone(input.inputs ?? {});
    validateWorktableInputs(template, inputs);
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    if (this.#state.instances.some((instance) => instance.id === id)) throw new Error('工作台实例 ID 已存在');
    const title = input.title?.trim().slice(0, 200) || template.title.trim().slice(0, 200) || '科研工作台';
    const instance: WorktableInstance = {
      id,
      projectId: this.#projectId,
      templateId: template.id,
      templateVersion: template.version,
      title,
      icon: template.icon?.trim().slice(0, 100) || 'flask-conical',
      kind: template.kind ?? 'research',
      status: 'idle',
      ...(input.boundSessionId ? { boundSessionId: input.boundSessionId } : {}),
      revision: 1,
      inputs,
      ...seeded,
      createdAt: now,
      updatedAt: now,
    };
    this.#state = { instances: [...this.#state.instances, instance], activeInstanceId: id };
    this.record('worktable.instance_created', actor, id, [template.id]);
    return structuredClone(instance);
  }

  activate(instanceId: string, actor: EventActor): WorktableState {
    const instance = this.requireInstance(instanceId);
    this.#state = { ...this.#state, activeInstanceId: instanceId };
    this.record('worktable.opened', actor, instanceId);
    return this.snapshot();
  }

  patch(instanceId: string, patch: {
    title?: string;
    status?: WorktableInstance['status'];
    boundSessionId?: string | null;
    layout?: WorktableSplitNode;
    panes?: WorktablePane[];
    activePaneId?: string;
    inputs?: Record<string, JsonValue>;
    activeRunId?: string | null;
    artifactId?: string | null;
    artifactRevisionId?: string | null;
    ifRevision?: number;
  }, actor: EventActor): WorktableInstance {
    const current = this.requireMutableInstance(instanceId);
    if (patch.ifRevision !== undefined && patch.ifRevision !== current.revision) throw new Error('工作台实例已被其他操作更新，请刷新后重试');
    const layout = patch.layout ? structuredClone(patch.layout) : current.layout;
    const panes = patch.panes ? structuredClone(patch.panes) : current.panes;
    validateWorktableLayout(layout, panes);
    const activePaneId = patch.activePaneId ?? current.activePaneId ?? panes[0]?.id;
    if (activePaneId && !panes.some((pane) => pane.id === activePaneId)) throw new Error('活动窗格不存在');
    const title = patch.title === undefined ? current.title : patch.title.trim().slice(0, 200);
    if (!title) throw new Error('工作台标题不能为空');
    const status = patch.status ?? current.status;
    const updated: WorktableInstance = {
      ...current,
      title,
      status,
      revision: current.revision + 1,
      inputs: patch.inputs ? structuredClone(patch.inputs) : current.inputs,
      layout,
      panes,
      ...(activePaneId ? { activePaneId } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (patch.boundSessionId === null) delete updated.boundSessionId;
    else if (patch.boundSessionId !== undefined) updated.boundSessionId = patch.boundSessionId;
    for (const [key, value] of [['activeRunId', patch.activeRunId], ['artifactId', patch.artifactId], ['artifactRevisionId', patch.artifactRevisionId]] as const) {
      if (value === null) delete updated[key];
      else if (value !== undefined) updated[key] = value;
    }
    if (status === 'archived') updated.archivedAt = new Date().toISOString();
    this.replace(updated);
    if (status === 'archived' && this.#state.activeInstanceId === instanceId) {
      const nextActiveId = this.#state.instances.find((item) => item.id !== instanceId && item.status !== 'archived')?.id;
      this.#state = nextActiveId
        ? { ...this.#state, activeInstanceId: nextActiveId }
        : { instances: this.#state.instances };
    }
    if (status === 'archived' && this.#state.reveal?.instanceId === instanceId) delete this.#state.reveal;
    this.record(patch.layout || patch.panes ? 'worktable.layout_changed' : patch.boundSessionId !== undefined ? 'worktable.binding_changed' : 'worktable.state_changed', actor, instanceId);
    return structuredClone(updated);
  }

  setLayout(instanceId: string, layout: WorktableSplitNode, panes: WorktablePane[], activePaneId: string | undefined, actor: EventActor): WorktableInstance {
    return this.patch(instanceId, { layout, panes, ...(activePaneId ? { activePaneId } : {}) }, actor);
  }

  archive(instanceId: string, actor: EventActor, ifRevision?: number): WorktableInstance {
    const instance = this.patch(instanceId, { status: 'archived', ...(ifRevision === undefined ? {} : { ifRevision }) }, actor);
    // Preserve a distinct audit event instead of relying only on state_changed.
    this.record('worktable.archived', actor, instanceId);
    return instance;
  }

  restore(instanceId: string, actor: EventActor, ifRevision?: number): WorktableInstance {
    const current = this.requireInstance(instanceId);
    if (current.status !== 'archived') throw new Error('只有已归档工作台可以恢复');
    if (ifRevision !== undefined && ifRevision !== current.revision) throw new Error('工作台实例已被其他操作更新，请刷新后重试');
    const restored: WorktableInstance = {
      ...current,
      status: 'idle',
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    delete restored.archivedAt;
    this.replace(restored);
    this.record('worktable.restored', actor, instanceId);
    return structuredClone(restored);
  }

  mountTab(instanceId: string, paneId: string, input: { title: string; content: WorktableContent; pinned?: boolean }, actor: EventActor): WorktableTab {
    const instance = this.requireMutableInstance(instanceId);
    if (instance.panes.flatMap((pane) => pane.tabs).length >= MAX_WORKTABLE_TABS) throw new Error(`单个工作台最多打开 ${MAX_WORKTABLE_TABS} 个标签`);
    const pane = instance.panes.find((candidate) => candidate.id === paneId);
    if (!pane) throw new Error('工作台窗格不存在');
    const title = input.title.trim().slice(0, 200);
    if (!title) throw new Error('工作台标签标题不能为空');
    const tab: WorktableTab = {
      id: randomUUID(), title, content: structuredClone(input.content),
      ...(input.pinned ? { pinned: true } : {}), openedAt: new Date().toISOString(),
    };
    const panes = instance.panes.map((candidate) => candidate.id === paneId
      ? { ...candidate, tabs: [...candidate.tabs, tab], activeTabId: tab.id }
      : candidate);
    this.patch(instanceId, { panes, activePaneId: paneId }, actor);
    return structuredClone(tab);
  }

  activateTab(instanceId: string, paneId: string, tabId: string, actor: EventActor): WorktableInstance {
    const instance = this.requireMutableInstance(instanceId);
    const pane = instance.panes.find((candidate) => candidate.id === paneId);
    if (!pane || !pane.tabs.some((tab) => tab.id === tabId)) throw new Error('工作台标签不存在或不属于指定窗格');
    const panes = instance.panes.map((candidate) => candidate.id === paneId ? { ...candidate, activeTabId: tabId } : candidate);
    return this.patch(instanceId, { panes, activePaneId: paneId }, actor);
  }

  reveal(
    instanceId: string,
    target: { paneId: string; tabId: string },
    document: DocumentRevisionRef,
    selector: AnnotationSelector,
    actor: EventActor,
  ): WorktableState {
    const instance = this.requireInstance(instanceId);
    const pane = instance.panes.find((candidate) => candidate.id === target.paneId);
    if (!pane || !pane.tabs.some((tab) => tab.id === target.tabId)) throw new Error('工作台定位标签不存在');
    this.#state = {
      ...this.#state,
      reveal: {
        id: randomUUID(),
        instanceId,
        document: structuredClone(document),
        selector: structuredClone(selector),
        targetPaneId: target.paneId,
        targetTabId: target.tabId,
        requestedAt: new Date().toISOString(),
      },
    };
    this.record('worktable.evidence_revealed', actor, instanceId, [document.sha256]);
    return this.snapshot();
  }

  closeTab(instanceId: string, paneId: string, tabId: string, actor: EventActor): WorktableInstance {
    const instance = this.requireMutableInstance(instanceId);
    const pane = instance.panes.find((candidate) => candidate.id === paneId);
    if (!pane) throw new Error('工作台窗格不存在');
    const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
    if (tabs.length === pane.tabs.length) throw new Error('工作台标签不存在');
    const activeTabId = pane.activeTabId === tabId ? tabs.at(-1)?.id : pane.activeTabId;
    const panes = instance.panes.map((candidate) => {
      if (candidate.id !== paneId) return candidate;
      const updated: WorktablePane = { ...candidate, tabs };
      if (activeTabId) updated.activeTabId = activeTabId;
      else delete updated.activeTabId;
      return updated;
    });
    return this.patch(instanceId, { panes }, actor);
  }

  context(instanceId: string, jobs: JobRecord[], annotations: Annotation[]): WorktableContextSnapshot {
    const instance = this.requireInstance(instanceId);
    const documentHashes = new Set(instance.panes.flatMap((pane) => pane.tabs).flatMap((tab) => tab.content.kind === 'document' ? [tab.content.target.sha256] : []));
    const pendingJobs = jobs.filter((job) => {
      if (!['queued', 'running', 'paused'].includes(job.status)) return false;
      const metadata = job.metadata;
      return job.spec.worktableInstanceId === instanceId || metadata?.worktableInstanceId === instanceId || metadata?.instanceId === instanceId;
    }).map((job) => job.id);
    const openAnnotationIds = annotations.filter((annotation) => annotation.status === 'open' && documentHashes.has(annotation.target.sha256)).map((annotation) => annotation.id);
    return {
      instanceId: instance.id,
      title: instance.title,
      ...(instance.boundSessionId ? { boundSessionId: instance.boundSessionId } : {}),
      ...(instance.activePaneId ? { activePaneId: instance.activePaneId } : {}),
      panes: instance.panes.map((pane) => {
        const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId);
        return {
          id: pane.id,
          title: pane.title ?? '窗格',
          ...(activeTab ? {
            activeTab: {
              kind: activeTab.content.kind,
              title: activeTab.title,
              ...(activeTab.content.kind === 'document' ? { document: structuredClone(activeTab.content.target) } : {}),
              ...(activeTab.content.kind === 'artifact' && activeTab.content.revisionId ? { artifactRevisionId: activeTab.content.revisionId } : {}),
              trust: activeTab.content.kind === 'plugin-panel' || activeTab.content.kind === 'generated-app'
                ? 'untrusted-plugin'
                : activeTab.content.kind === 'builtin' && activeTab.content.type === 'browser'
                  ? 'untrusted-external'
                  : 'trusted-user',
            },
          } : {}),
        };
      }),
      pendingJobs,
      openAnnotationIds,
      ...(this.#state.reveal?.instanceId === instanceId ? { reveal: structuredClone(this.#state.reveal) } : {}),
      revision: this.#revisions.get(instanceId) ?? 0,
    };
  }

  private requireInstance(instanceId: string): WorktableInstance {
    const instance = this.#state.instances.find((candidate) => candidate.id === instanceId);
    if (!instance) throw new Error('工作台实例不存在');
    return structuredClone(instance);
  }

  private requireMutableInstance(instanceId: string): WorktableInstance {
    const instance = this.requireInstance(instanceId);
    if (instance.status === 'archived') throw new Error('已归档工作台为只读状态');
    return instance;
  }

  private replace(instance: WorktableInstance): void {
    this.#state = { ...this.#state, instances: this.#state.instances.map((candidate) => candidate.id === instance.id ? instance : candidate) };
  }

  private record(kind: string, actor: EventActor, instanceId: string, provenanceRefs: string[] = []): void {
    const revision = this.#state.instances.find((instance) => instance.id === instanceId)?.revision ?? this.#revisions.get(instanceId) ?? 0;
    this.#revisions.set(instanceId, revision);
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind,
      actor,
      provenanceRefs: [instanceId, ...provenanceRefs],
      payload: toJson({ state: this.#state, instanceId, revision }),
    });
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (!event.kind.startsWith('worktable.')) continue;
      const projected = statePayload(event.payload);
      if (!projected) continue;
      const instances = projected.state.instances.flatMap((instance) => {
        const current = currentReplayedInstance(instance);
        return current ? [current] : [];
      });
      const activeInstanceId = projected.state.activeInstanceId && instances.some((instance) => instance.id === projected.state.activeInstanceId)
        ? projected.state.activeInstanceId
        : undefined;
      this.#state = {
        ...projected.state,
        instances,
        ...(activeInstanceId ? { activeInstanceId } : {}),
      };
      if (!activeInstanceId) delete this.#state.activeInstanceId;
      for (const instance of instances) this.#revisions.set(instance.id, instance.revision);
    }
  }
}
