import { randomUUID } from 'node:crypto';
import type { AnnotationSelector, DocumentRevisionRef, EventActor, WorkbenchContribution, WorkbenchState, WorkbenchTab } from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { isRecord, toJson } from '../util/json.js';

export const CORE_WORKBENCHES: WorkbenchContribution[] = [
  {
    id: 'openlab.figure-review', title: '科研图表审阅台',
    accepts: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'], objectTypes: ['artifact'] },
    views: [
      { id: 'figure', title: '图', kind: 'image', role: 'output' },
      { id: 'source', title: '代码', kind: 'editor', role: 'source' },
      { id: 'environment', title: '环境', kind: 'environment', role: 'environment' },
      { id: 'annotations', title: '批注', kind: 'annotations' },
      { id: 'jobs', title: '构建日志', kind: 'jobs', role: 'log' },
    ],
    commands: ['submit-annotations', 'rerun', 'archive'],
  },
  {
    id: 'openlab.latex', title: 'LaTeX 论文工作台',
    accepts: { mediaTypes: ['application/x-tex', 'application/pdf'], objectTypes: ['artifact'] },
    views: [
      { id: 'source', title: '源码', kind: 'editor', role: 'source' },
      { id: 'pdf', title: 'PDF', kind: 'pdf', role: 'output' },
      { id: 'annotations', title: '批注', kind: 'annotations' },
      { id: 'jobs', title: '编译日志', kind: 'jobs', role: 'log' },
      { id: 'environment', title: '环境', kind: 'environment', role: 'environment' },
    ],
    commands: ['compile', 'submit-annotations', 'archive'],
  },
];

export class WorkbenchStore {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  #state: WorkbenchState = { tabs: [], maximized: false };

  constructor(options: { projectId: string; events: SqliteEventStore }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.replay();
  }

  snapshot(): WorkbenchState {
    return structuredClone(this.#state);
  }

  open(input: {
    title: string;
    workbenchId: string;
    document?: DocumentRevisionRef;
    artifactId?: string;
    artifactRevisionId?: string;
    pluginId?: string;
    activeViewId: string;
  }, actor: EventActor): WorkbenchState {
    const existing = this.#state.tabs.find((tab) => tab.workbenchId === input.workbenchId
      && tab.document?.sha256 === input.document?.sha256 && tab.artifactRevisionId === input.artifactRevisionId);
    if (existing) {
      this.#state = { ...this.#state, activeTabId: existing.id };
      this.record('workbench.state_changed', actor);
      return this.snapshot();
    }
    if (this.#state.tabs.length >= 20) throw new Error('工作台最多同时打开 20 个标签');
    const tab: WorkbenchTab = {
      id: randomUUID(), title: input.title.trim().slice(0, 200) || '科研工作台', workbenchId: input.workbenchId,
      ...(input.pluginId ? { pluginId: input.pluginId } : {}),
      ...(input.document ? { document: structuredClone(input.document) } : {}),
      ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      ...(input.artifactRevisionId ? { artifactRevisionId: input.artifactRevisionId } : {}),
      activeViewId: input.activeViewId, openedAt: new Date().toISOString(),
    };
    this.#state = { ...this.#state, tabs: [...this.#state.tabs, tab], activeTabId: tab.id };
    this.record('workbench.opened', actor, [tab.id, ...(tab.document ? [tab.document.sha256] : [])]);
    return this.snapshot();
  }

  close(tabId: string, actor: EventActor): WorkbenchState {
    const tabs = this.#state.tabs.filter((tab) => tab.id !== tabId);
    if (tabs.length === this.#state.tabs.length) throw new Error('工作台标签不存在');
    const activeTabId = this.#state.activeTabId === tabId ? tabs.at(-1)?.id : this.#state.activeTabId;
    this.#state = { tabs, ...(activeTabId ? { activeTabId } : {}), maximized: tabs.length > 0 && this.#state.maximized };
    this.record('workbench.closed', actor, [tabId]);
    return this.snapshot();
  }

  activate(tabId: string, actor: EventActor): WorkbenchState {
    if (!this.#state.tabs.some((tab) => tab.id === tabId)) throw new Error('工作台标签不存在');
    this.#state = { ...this.#state, activeTabId: tabId };
    this.record('workbench.state_changed', actor, [tabId]);
    return this.snapshot();
  }

  setView(tabId: string, viewId: string, actor: EventActor): WorkbenchState {
    const tabs = this.#state.tabs.map((tab) => tab.id === tabId ? { ...tab, activeViewId: viewId } : tab);
    if (!tabs.some((tab) => tab.id === tabId)) throw new Error('工作台标签不存在');
    this.#state = { ...this.#state, tabs, activeTabId: tabId };
    this.record('workbench.state_changed', actor, [tabId]);
    return this.snapshot();
  }

  setMaximized(maximized: boolean, actor: EventActor): WorkbenchState {
    this.#state = { ...this.#state, maximized: Boolean(maximized) && this.#state.tabs.length > 0 };
    this.record('workbench.state_changed', actor);
    return this.snapshot();
  }

  reveal(tabId: string, document: DocumentRevisionRef, selector: Extract<AnnotationSelector, { kind: 'pdf-rect' | 'pdf-text' }>, actor: EventActor): WorkbenchState {
    const tab = this.#state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.document?.sha256 !== document.sha256) throw new Error('证据目标不属于指定工作台标签');
    this.#state = {
      ...this.#state,
      activeTabId: tabId,
      reveal: { id: randomUUID(), tabId, document: structuredClone(document), selector: structuredClone(selector), requestedAt: new Date().toISOString() },
    };
    this.record('workbench.reveal_requested', actor, [tabId, document.sha256]);
    return this.snapshot();
  }

  private record(kind: string, actor: EventActor, provenanceRefs: string[] = []): void {
    this.#events.append({ streamId: `project:${this.#projectId}`, kind, actor, provenanceRefs, payload: toJson(this.#state) });
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (!event.kind.startsWith('workbench.') || !isRecord(event.payload) || !Array.isArray(event.payload.tabs)) continue;
      this.#state = structuredClone(event.payload as unknown as WorkbenchState);
    }
  }
}
