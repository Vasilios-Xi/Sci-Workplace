import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bot,
  Check,
  ChevronLeft,
  File,
  FileText,
  FlaskConical,
  Folder,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  TerminalSquare,
  X,
} from 'lucide-react';
import type {
  AnnotationSelector,
  BootstrapSnapshot,
  DocumentRevisionRef,
  JsonPrimitive,
  JsonSchema,
  JsonValue,
  WorktableBuiltinKind,
  WorktableContent,
  WorktableInstance,
  WorktablePane,
  WorktableRevealTarget,
  WorktableSplitNode,
  WorktableTab,
  WorktableTemplateContribution,
  WorkspaceEntry,
  WorkspacePreview,
} from '@openlab/protocol';
import { confirmInApp, promptInApp } from './AppDialog.js';
import { TerminalPane } from './TerminalPane.js';
import { worktableZhCN as copy } from '../i18n/zh-CN.js';
import type { OpenLabController } from '../lib/use-openlab.js';
import {
  connectGeneratedApp,
  generatedAppAnnotationInput,
  generatedAppAnnotationsView,
  generatedAppArtifactView,
  generatedAppCapabilities,
  generatedAppCapabilityForMethod,
  generatedAppResearchView,
  generatedAppWorktableView,
  loopbackGeneratedAppOrigin,
  parseGeneratedAppRequest,
} from '../lib/generated-app-bridge.js';
import { connectPluginPanel, parsePluginPanelRequest } from '../lib/plugin-panel-bridge.js';

interface WorktableShellProps {
  controller: OpenLabController;
  onReturnToChat(): void;
  onSwitchSession(id: string): void;
}

type WorktablePatch = Partial<Pick<WorktableInstance, 'title' | 'status' | 'layout' | 'panes' | 'activePaneId'>> & { boundSessionId?: string | null };

const builtinOrder: WorktableBuiltinKind[] = ['control-room', 'explorer', 'tasks', 'terminal', 'scm'];

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} KB`;
  return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function builtinTitle(kind: WorktableBuiltinKind): string {
  if (kind === 'control-room') return copy.builtin.controlRoom;
  return copy.builtin[kind];
}

function statusLabel(status: WorktableInstance['status']): string {
  return copy.status[status];
}

function statusTone(status: string): string {
  if (status === 'failed') return 'danger';
  if (status === 'running' || status === 'queued' || status === 'pending') return 'info';
  if (status === 'completed' || status === 'approved') return 'success';
  if (status === 'waiting_user' || status === 'waiting_approval' || status === 'needs_input') return 'warning';
  return '';
}

function iconForContent(content: WorktableContent) {
  if (content.kind !== 'builtin') return content.kind === 'document' ? <FileText size={13}/> : <File size={13}/>;
  if (content.type === 'terminal') return <TerminalSquare size={13}/>;
  if (content.type === 'scm') return <GitBranch size={13}/>;
  if (content.type === 'tasks') return <ListChecks size={13}/>;
  if (content.type === 'explorer') return <FolderOpen size={13}/>;
  return <LayoutDashboard size={13}/>;
}

function propertySchema(template: WorktableTemplateContribution, field: string): JsonSchema | undefined {
  const properties = typeof template.inputSchema === 'object' && template.inputSchema !== null && !Array.isArray(template.inputSchema)
    ? template.inputSchema.properties
    : undefined;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
  const candidate = (properties as Record<string, unknown>)[field];
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as JsonSchema : undefined;
}

function attachmentInputValue(template: WorktableTemplateContribution, field: string, files: Array<{ rootId?: string; relativePath: string; name: string; sha256: string; size: number; mediaType?: string }>): JsonValue {
  const schema = propertySchema(template, field) as Record<string, unknown> | undefined;
  const refs = files.map((file) => ({
    rootId: file.rootId ?? 'project',
    path: file.relativePath,
    name: file.name,
    sha256: file.sha256,
    size: file.size,
    ...(file.mediaType ? { mediaType: file.mediaType } : {}),
  }));
  if (schema?.type === 'string') return refs[0]?.path ?? '';
  if (schema?.type === 'array') return refs.map((ref) => ref.path);
  return (refs.length === 1 ? refs[0] : refs) as JsonValue;
}

function CreateWorktableDialog({ snapshot, controller, onClose, onCreated }: {
  snapshot: BootstrapSnapshot;
  controller: OpenLabController;
  onClose(): void;
  onCreated(instance: WorktableInstance): void;
}) {
  const templates = snapshot.worktableTemplates;
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const template = templates.find((candidate) => candidate.id === templateId) ?? templates[0];
  const [title, setTitle] = useState(template?.title ?? copy.customInstance);
  const [inputs, setInputs] = useState<Record<string, JsonValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setTitle(template?.title ?? copy.customInstance);
    setInputs({});
    setError(undefined);
  }, [template?.id]);

  const chooseFiles = async (field: string, multiple = false) => {
    try {
      const selected = await window.openlab?.chooseAttachments() ?? [];
      const files = multiple ? selected : selected.slice(0, 1);
      if (!template || files.length === 0) return;
      setInputs((current) => ({ ...current, [field]: attachmentInputValue(template, field, files) }));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const create = async () => {
    if (!template || !title.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const instance = await controller.createWorktableInstance({
        templateId: template.id,
        title: title.trim(),
        inputs,
        ...(snapshot.activeSessionId ? { boundSessionId: snapshot.activeSessionId } : {}),
      });
      if (!instance) throw new Error(copy.errors.actionFailed);
      onCreated(instance);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return <div className="worktable-dialog-backdrop" data-testid="worktable-create-dialog" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
    <section className="worktable-create-dialog" role="dialog" aria-modal="true" aria-labelledby="worktable-create-title">
      <header><div><span id="worktable-create-title">{copy.newInstance}</span><small>{copy.noInstancesHint}</small></div><button aria-label={copy.cancel} onClick={onClose}><X size={16}/></button></header>
      <div className="worktable-template-grid">{templates.map((candidate) => <button
        key={candidate.id}
        data-testid={`worktable-template-${candidate.id}`}
        className={candidate.id === template?.id ? 'is-active' : ''}
        onClick={() => setTemplateId(candidate.id)}
      ><FlaskConical size={19}/><span className="worktable-template-name">{candidate.title}</span><span>{candidate.description ?? copy.customDescription}</span>{candidate.id === template?.id && <Check size={14}/>}</button>)}</div>
      <label>{copy.instanceName}<input data-testid="worktable-create-title-input" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)}/></label>
      {template?.inputUi && <div className="worktable-create-inputs">{template.inputUi.controls.map((control) => {
        const value = inputs[control.field];
        if (control.kind === 'file') return <label key={control.field}><span>{control.label}</span><button type="button" onClick={() => void chooseFiles(control.field, control.multiple)}>{value ? copy.input.selectedFile : copy.input.chooseFile}</button>{value !== undefined && <button className="clear" aria-label={copy.input.remove} onClick={() => setInputs((current) => { const next = { ...current }; delete next[control.field]; return next; })}><X size={13}/></button>}</label>;
        if (control.kind === 'select') return <label key={control.field}><span>{control.label}</span><select value={value === undefined ? '' : String(value)} onChange={(event) => {
          const selected = control.options.find((option) => String(option.value) === event.target.value)?.value;
          setInputs((current) => ({ ...current, [control.field]: selected as JsonPrimitive }));
        }}><option value="">{copy.input.choose}</option>{control.options.map((option) => <option key={`${control.field}:${String(option.value)}`} value={String(option.value)}>{option.label}</option>)}</select></label>;
        return <label key={control.field}><span>{control.label}</span><input value={typeof value === 'string' ? value : ''} placeholder={control.placeholder} onChange={(event) => setInputs((current) => ({ ...current, [control.field]: event.target.value }))}/></label>;
      })}</div>}
      {error && <p className="worktable-create-error" role="alert">{error}</p>}
      <footer><button onClick={onClose}>{copy.cancel}</button><button className="primary" data-testid="worktable-create-confirm" disabled={busy || !template || !title.trim()} onClick={() => void create()}>{copy.create}</button></footer>
    </section>
  </div>;
}

function ExplorerPane({ controller }: { controller: OpenLabController }) {
  const rootId = controller.snapshot.workspace.activeRootId;
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [preview, setPreview] = useState<WorkspacePreview>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    if (!rootId) return;
    setLoading(true);
    setError(undefined);
    try { setEntries(await controller.listWorkspace({ rootId, path }, { sort: 'name', order: 'asc' })); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }, [controller, path, rootId]);
  useEffect(() => { void load(); }, [load]);
  const parent = path.split('/').slice(0, -1).join('/');
  const open = async (entry: WorkspaceEntry) => {
    if (entry.kind === 'directory') { setPath(entry.path); setPreview(undefined); return; }
    try { setPreview(await controller.previewWorkspace(entry)); }
    catch (cause) { setError(messageOf(cause)); }
  };
  return <div className="worktable-explorer-pane" data-testid="worktable-explorer">
    <header>{path && <button aria-label={copy.navigation.parent} onClick={() => { setPath(parent); setPreview(undefined); }}><ChevronLeft size={13}/></button>}<code>/{path}</code><button onClick={() => void load()}><RefreshCw size={12}/>{copy.explorer.refresh}</button></header>
    {preview ? <div className="worktable-file-preview"><header><button onClick={() => setPreview(undefined)}><ArrowLeft size={13}/></button><span>{preview.name}</span><small>{formatBytes(preview.size)}</small></header>{preview.kind === 'image' && preview.dataUrl ? <img src={preview.dataUrl} alt={preview.name}/> : preview.content ? <pre>{preview.content}</pre> : <p>{preview.mediaType ?? preview.kind}</p>}</div> : <div>{loading && <div className="worktable-empty compact"><span>{copy.explorer.loading}</span></div>}{!loading && error && <div className="worktable-empty compact"><span>{error}</span><button onClick={() => void load()}>{copy.explorer.refresh}</button></div>}{!loading && !error && entries.length === 0 && <div className="worktable-empty compact"><span>{copy.explorer.empty}</span></div>}{!loading && !error && entries.map((entry) => <button key={`${entry.rootId}:${entry.path}`} onClick={() => void open(entry)}><span>{entry.kind === 'directory' ? <Folder size={14}/> : <File size={14}/>}</span><span className="worktable-entry-name">{entry.name}</span><small>{entry.kind === 'directory' ? '' : formatBytes(entry.size)}</small></button>)}</div>}
  </div>;
}

function TasksPane({ snapshot }: { snapshot: BootstrapSnapshot }) {
  const activities = [
    ...snapshot.tasks.map((task) => ({ id: `task:${task.id}`, title: task.title, detail: task.description, status: task.status })),
    ...snapshot.agentRuns.map((run) => ({ id: `run:${run.id}`, title: run.name, detail: run.role === 'lead' ? copy.tasks.leadAgent : copy.tasks.memberAgent, status: run.status })),
    ...snapshot.jobs.map((job) => ({ id: `job:${job.id}`, title: job.spec.title, detail: job.stage ?? job.spec.executable, status: job.status })),
  ];
  return <div className="worktable-tasks-pane" data-testid="worktable-tasks"><header><ListChecks size={14}/><span>{copy.tasks.title}</span></header><div>{activities.length === 0 ? <div className="worktable-empty compact"><span>{copy.tasks.noTasks}</span></div> : activities.map((item) => <article key={item.id}><span><span>{item.title}</span><small>{item.detail}</small></span><span className={`worktable-status ${statusTone(item.status)}`}>{copy.runtimeStatus[item.status as keyof typeof copy.runtimeStatus] ?? item.status}</span></article>)}</div></div>;
}

function ScmPane({ controller, instance }: { controller: OpenLabController; instance: WorktableInstance }) {
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (action: 'status' | 'diff') => {
    setBusy(true);
    try { setOutput(JSON.stringify(await controller.scmAction(instance.id, { action }), null, 2)); }
    catch (cause) { setOutput(messageOf(cause)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void run('status'); }, [instance.id]);
  return <div className="worktable-scm-pane" data-testid="worktable-scm"><header><span><GitBranch size={14}/><span>{copy.scm.title}</span></span><span><button disabled={busy} onClick={() => void run('status')}><RefreshCw size={12}/>{copy.scm.refresh}</button><button disabled={busy} onClick={() => void run('diff')}>Diff</button></span></header><p></p><pre>{output || copy.scm.empty}</pre><form onSubmit={(event) => event.preventDefault()}></form></div>;
}

function ControlRoomPane({ controller, instance, onSwitchSession }: { controller: OpenLabController; instance: WorktableInstance; onSwitchSession(id: string): void }) {
  const snapshot = controller.snapshot;
  const running = snapshot.agentRuns.filter((run) => run.status === 'running').length + snapshot.jobs.filter((job) => job.status === 'running').length;
  const waiting = snapshot.pendingApprovals.filter((approval) => approval.status === 'pending').length + snapshot.tasks.filter((task) => task.status === 'waiting_user').length;
  const failed = snapshot.tasks.filter((task) => task.status === 'failed').length + snapshot.jobs.filter((job) => job.status === 'failed').length;
  const completed = snapshot.tasks.filter((task) => task.status === 'completed').length + snapshot.jobs.filter((job) => job.status === 'completed').length;
  const bind = async (boundSessionId: string) => controller.updateWorktableInstance(instance.id, { boundSessionId: boundSessionId || null });
  const rename = async () => {
    const value = await promptInApp(copy.rename, instance.title, { title: copy.rename, confirmLabel: copy.rename });
    if (value?.trim()) await controller.updateWorktableInstance(instance.id, { title: value.trim() });
  };
  return <div className="worktable-control-room" data-testid="worktable-control-room">
    <header><div><LayoutDashboard size={17}/><span><span>{copy.control.overview}</span><small>{snapshot.project.name}</small></span></div><button onClick={() => void rename()}><Settings2 size={13}/>{copy.rename}</button></header>
    <div className="worktable-control-metrics"><article className="warning"><span>{copy.control.waiting}</span><span className="metric-value">{waiting}</span></article><article className="info"><span>{copy.control.running}</span><span className="metric-value">{running}</span></article><article className="danger"><span>{copy.control.failed}</span><span className="metric-value">{failed}</span></article><article className="success"><span>{copy.control.completed}</span><span className="metric-value">{completed}</span></article></div>
    <label className="worktable-session-binding"><span>{copy.chatDock.bind}</span><select value={instance.boundSessionId ?? ''} onChange={(event) => void bind(event.target.value)}><option value="">{copy.chatDock.unbound}</option>{snapshot.sessions.filter((session) => session.status !== 'archived' && !session.temporary).map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select>{instance.boundSessionId && <button onClick={() => onSwitchSession(instance.boundSessionId!)}>{copy.control.openConversation}</button>}</label>
    <div className="worktable-activity-list">{snapshot.pendingApprovals.filter((approval) => approval.status === 'pending').map((approval) => <article key={approval.id}><Bot size={14}/><div><span>{approval.tool.title}</span><small>{approval.rationale}</small></div></article>)}{snapshot.tasks.length === 0 && snapshot.jobs.length === 0 && snapshot.pendingApprovals.every((approval) => approval.status !== 'pending') && <div className="worktable-empty compact"><span>{copy.control.noActivity}</span></div>}</div>
  </div>;
}

function GeneratedAppPane({ controller, instance, pane, tab, content }: {
  controller: OpenLabController;
  instance: WorktableInstance;
  pane: WorktablePane;
  tab: WorktableTab;
  content: Extract<WorktableContent, { kind: 'generated-app' }>;
}) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | undefined>(undefined);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const app = controller.snapshot.generatedApps.find((candidate) => candidate.id === content.appId);
  const revision = controller.snapshot.artifactRevisions.find((candidate) => candidate.id === content.revisionId && candidate.artifactId === app?.artifactId);
  useEffect(() => {
    let active = true;
    void controller.loadGeneratedApp(content.appId, content.revisionId).then((result) => { if (active) setUrl(result?.url); }).catch((cause) => { if (active) setError(messageOf(cause)); });
    return () => { active = false; portRef.current?.close(); portRef.current = undefined; };
  }, [content.appId, content.revisionId, controller]);
  const connect = () => {
    const target = iframeRef.current?.contentWindow;
    const origin = url ? loopbackGeneratedAppOrigin(url) : undefined;
    if (!target || !origin || !app || !revision) {
      setError(copy.generatedApp.invalidRevision);
      return;
    }
    portRef.current?.close();
    const token = crypto.randomUUID();
    const channel = new MessageChannel();
    const capabilities = generatedAppCapabilities(app);
    channel.port1.onmessage = (event) => {
      const request = parseGeneratedAppRequest(event.data, token);
      if (!request) return;
      void (async () => {
        const required = generatedAppCapabilityForMethod(request.method);
        if (!required || !capabilities.has(required)) throw new Error(copy.generatedApp.capabilityDenied);
        const latest = controllerRef.current.snapshot;
        let value: unknown;
        if (request.method === 'worktable.read') value = generatedAppWorktableView(app, instance, pane, tab);
        else if (request.method === 'artifacts.read') value = generatedAppArtifactView(revision);
        else if (request.method === 'annotations.read') value = generatedAppAnnotationsView(latest, revision);
        else if (request.method === 'annotations.create') value = await controllerRef.current.createAnnotation(generatedAppAnnotationInput(request.params, revision));
        else if (request.method === 'research.read') value = generatedAppResearchView(latest, app);
        else throw new Error(copy.generatedApp.unsupportedMethod);
        channel.port1.postMessage({ id: request.id, ok: true, value });
      })().catch((cause) => channel.port1.postMessage({ id: request.id, ok: false, error: messageOf(cause) }));
    };
    channel.port1.start();
    portRef.current = channel.port1;
    connectGeneratedApp(target, origin, token, capabilities, channel.port2);
  };
  if (error) return <div className="worktable-empty"><span>{error}</span></div>;
  if (!url) return <div className="worktable-empty"><span>{copy.generatedApp.loading}</span></div>;
  return <div className="worktable-generated-app"><iframe ref={iframeRef} title={app?.title ?? copy.generatedApp.title} sandbox="allow-scripts allow-same-origin" src={url} referrerPolicy="no-referrer" onLoad={connect}/><small>{copy.generatedApp.sandbox}</small></div>;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function PluginPanelPane({ controller, instance, pane, tab, content }: {
  controller: OpenLabController;
  instance: WorktableInstance;
  pane: WorktablePane;
  tab: WorktableTab;
  content: Extract<WorktableContent, { kind: 'plugin-panel' }>;
}) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | undefined>(undefined);
  useEffect(() => {
    let active = true;
    setError(undefined);
    void controller.loadPluginPanel(content.pluginId, content.panelId)
      .then((value) => { if (active) setUrl(value); })
      .catch((cause) => { if (active) setError(messageOf(cause)); });
    return () => { active = false; portRef.current?.close(); portRef.current = undefined; };
  }, [content.panelId, content.pluginId, controller]);
  const connect = () => {
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    portRef.current?.close();
    const token = crypto.randomUUID();
    const channel = new MessageChannel();
    const worktable = { instanceId: instance.id, paneId: pane.id };
    channel.port1.onmessage = (event) => {
      const request = parsePluginPanelRequest(event.data, token);
      if (!request) return;
      void (async () => {
        let value: unknown;
        if (request.method === 'context.read') {
          value = await controller.pluginPanelContext(content.pluginId, content.panelId, tab.id, worktable);
        } else if (request.method === 'tool.execute') {
          const tool = typeof request.params.tool === 'string' ? request.params.tool : '';
          const params = record(request.params.params) ? request.params.params as Record<string, JsonValue> : {};
          if (!tool) throw new Error(copy.pluginPanel.missingTool);
          try {
            value = await controller.pluginPanelTool(content.pluginId, content.panelId, tab.id, tool, params, false, worktable);
          } catch (cause) {
            if (!messageOf(cause).includes(copy.pluginPanel.confirmationRequiredMarker)) throw cause;
            const confirmed = await confirmInApp(copy.pluginPanel.confirmTool.replace('{tool}', tool), {
              title: copy.pluginPanel.confirmTitle,
              confirmLabel: copy.pluginPanel.confirm,
            });
            if (!confirmed) throw new Error(copy.pluginPanel.cancelled);
            value = await controller.pluginPanelTool(content.pluginId, content.panelId, tab.id, tool, params, true, worktable);
          }
        } else {
          if (!record(request.params.document) || !record(request.params.selector)) throw new Error(copy.pluginPanel.invalidReveal);
          value = await controller.pluginPanelReveal(
            content.pluginId,
            content.panelId,
            tab.id,
            request.params.document as unknown as DocumentRevisionRef,
            request.params.selector as unknown as AnnotationSelector,
            worktable,
            record(request.params.target) ? request.params.target as unknown as WorktableRevealTarget : undefined,
          );
        }
        channel.port1.postMessage({ id: request.id, ok: true, value });
      })().catch((cause) => channel.port1.postMessage({ id: request.id, ok: false, error: messageOf(cause) }));
    };
    channel.port1.start();
    portRef.current = channel.port1;
    connectPluginPanel(target, token, channel.port2);
  };
  if (error) return <div className="worktable-empty"><span>{error}</span></div>;
  if (!url) return <div className="worktable-empty"><span>{copy.errors.pluginLoading}</span><small>{content.pluginId} · {content.panelId}</small></div>;
  return <div className="worktable-plugin-panel"><iframe ref={iframeRef} title={tab.title} sandbox="allow-scripts" src={url} referrerPolicy="no-referrer" onLoad={connect}/><small>{copy.pluginPanel.sandbox}</small></div>;
}

function ContentView({ controller, instance, pane, tab, content, active, onSwitchSession }: {
  controller: OpenLabController;
  instance: WorktableInstance;
  pane: WorktablePane;
  tab: WorktableTab;
  content: WorktableContent;
  active: boolean;
  onSwitchSession(id: string): void;
}) {
  if (content.kind === 'builtin') {
    if (content.type === 'control-room') return <ControlRoomPane controller={controller} instance={instance} onSwitchSession={onSwitchSession}/>;
    if (content.type === 'explorer') return <ExplorerPane controller={controller}/>;
    if (content.type === 'tasks') return <TasksPane snapshot={controller.snapshot}/>;
    if (content.type === 'terminal') return <TerminalPane actions={controller} instanceId={instance.id} paneId={pane.id} visible active={active}/>;
    if (content.type === 'scm') return <ScmPane controller={controller} instance={instance}/>;
    return <div className="worktable-empty"><span>{copy.browser.noProfile}</span></div>;
  }
  if (content.kind === 'generated-app') return <GeneratedAppPane controller={controller} instance={instance} pane={pane} tab={tab} content={content}/>;
  if (content.kind === 'document') return <div className="worktable-empty"><FileText size={24}/><span>{content.target.ref.path}</span><button onClick={() => void window.openlab?.openWorkspacePath(content.target.ref)}>{copy.open}</button></div>;
  if (content.kind === 'artifact') return <div className="worktable-empty"><File size={24}/><span>Artifact {content.artifactId}{content.revisionId ? ` · ${content.revisionId}` : ''}</span></div>;
  return <PluginPanelPane controller={controller} instance={instance} pane={pane} tab={tab} content={content}/>;
}

function PaneView({ controller, instance, pane, onSwitchSession }: { controller: OpenLabController; instance: WorktableInstance; pane: WorktablePane; onSwitchSession(id: string): void }) {
  const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
  const archived = instance.status === 'archived';
  const add = async (kind: WorktableBuiltinKind) => {
    await controller.mountWorktableContent(instance.id, pane.id, { title: builtinTitle(kind), content: { kind: 'builtin', type: kind } });
  };
  return <section className={`worktable-pane ${instance.activePaneId === pane.id ? 'is-active' : ''}`} data-testid={`worktable-pane-${pane.id}`} onPointerDown={() => instance.activePaneId !== pane.id && void controller.updateWorktableInstance(instance.id, { activePaneId: pane.id })}>
    <header className="worktable-pane-tabs"><div>{pane.tabs.map((tab) => <button key={tab.id} className={tab.id === activeTab?.id ? 'is-active' : ''} onClick={() => void controller.activateWorktableTab(instance.id, pane.id, tab.id)}>{iconForContent(tab.content)}<span>{tab.title}</span>{!archived && <i role="button" aria-label={copy.closeTab} onClick={(event) => { event.stopPropagation(); void controller.closeWorktableTab(instance.id, pane.id, tab.id); }}><X size={11}/></i>}</button>)}</div><div className="worktable-pane-actions">{!archived && <select aria-label={copy.addContent} defaultValue="" onChange={(event) => { const kind = event.target.value as WorktableBuiltinKind; event.target.value = ''; if (kind) void add(kind); }}><option value="">{copy.addContent}</option>{builtinOrder.map((kind) => <option key={kind} value={kind}>{builtinTitle(kind)}</option>)}</select>}</div></header>
    <div className="worktable-pane-body">{activeTab ? <ContentView controller={controller} instance={instance} pane={pane} tab={activeTab} content={activeTab.content} active onSwitchSession={onSwitchSession}/> : <div className="worktable-empty"><span>{copy.emptyPane}</span><small>{copy.emptyPaneHint}</small></div>}</div>
  </section>;
}

interface LayoutViewProps {
  controller: OpenLabController;
  instance: WorktableInstance;
  node: WorktableSplitNode;
  onSwitchSession(id: string): void;
  onLayoutChange(node: WorktableSplitNode): void;
}

function LayoutView(props: LayoutViewProps) {
  const { controller, instance, node, onSwitchSession } = props;
  if (node.kind === 'pane') {
    const pane = instance.panes.find((candidate) => candidate.id === node.paneId);
    return pane ? <PaneView controller={controller} instance={instance} pane={pane} onSwitchSession={onSwitchSession}/> : <div className="worktable-invalid-pane">{copy.errors.missingPane}</div>;
  }
  return <SplitLayoutView {...props} node={node}/>;
}

function SplitLayoutView({ controller, instance, node, onSwitchSession, onLayoutChange }: Omit<LayoutViewProps, 'node'> & { node: Extract<WorktableSplitNode, { kind: 'split' }> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ratioRef = useRef(node.ratio);
  const [ratio, setRatio] = useState(node.ratio);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { ratioRef.current = node.ratio; setRatio(node.ratio); }, [node.ratio]);
  const updateRatio = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const raw = node.direction === 'horizontal'
      ? (event.clientX - bounds.left) / bounds.width
      : (event.clientY - bounds.top) / bounds.height;
    const next = Math.min(0.9, Math.max(0.1, raw));
    ratioRef.current = next;
    setRatio(next);
  };
  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    updateRatio(event);
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onLayoutChange({ ...node, ratio: ratioRef.current });
  };
  const style = node.direction === 'horizontal'
    ? { gridTemplateColumns: `minmax(0, ${ratio}fr) 5px minmax(0, ${1 - ratio}fr)` }
    : { gridTemplateRows: `minmax(0, ${ratio}fr) 5px minmax(0, ${1 - ratio}fr)` };
  return <div ref={containerRef} className={`worktable-split is-${node.direction} ${dragging ? 'is-resizing' : ''}`} style={style as CSSProperties}>
    <LayoutView controller={controller} instance={instance} node={node.first} onSwitchSession={onSwitchSession} onLayoutChange={(first) => onLayoutChange({ ...node, first })}/>
    <div
      className="worktable-splitter"
      role="separator"
      aria-label={node.direction === 'horizontal' ? copy.pane.resizeHorizontal : copy.pane.resizeVertical}
      aria-orientation={node.direction === 'horizontal' ? 'vertical' : 'horizontal'}
      aria-valuemin={10}
      aria-valuemax={90}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={instance.status === 'archived' ? -1 : 0}
      onPointerDown={(event) => {
        if (instance.status === 'archived') return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        updateRatio(event);
      }}
      onPointerMove={(event) => { if (dragging) updateRatio(event); }}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
      onKeyDown={(event) => {
        if (instance.status === 'archived' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -0.05 : 0.05;
        const next = Math.min(0.9, Math.max(0.1, ratio + delta));
        ratioRef.current = next;
        setRatio(next);
        onLayoutChange({ ...node, ratio: next });
      }}
    />
    <LayoutView controller={controller} instance={instance} node={node.second} onSwitchSession={onSwitchSession} onLayoutChange={(second) => onLayoutChange({ ...node, second })}/>
  </div>;
}

export function WorktableShell({ controller, onReturnToChat, onSwitchSession }: WorktableShellProps) {
  const snapshot = controller.snapshot;
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState<string>();
  const active = snapshot.worktable.instances.find((instance) => instance.id === snapshot.worktable.activeInstanceId)
    ?? snapshot.worktable.instances.find((instance) => instance.status !== 'archived');
  const instances = useMemo(() => snapshot.worktable.instances.filter((instance) => (instance.status === 'archived') === archived && (!query.trim() || instance.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))), [archived, query, snapshot.worktable.instances]);
  const run = async (operation: () => Promise<unknown>) => {
    setError(undefined);
    try { await operation(); }
    catch (cause) { setError(messageOf(cause)); }
  };
  const archiveInstance = async (instance: WorktableInstance) => {
    if (!await confirmInApp(copy.panel.archiveConfirm, { title: copy.archive, confirmLabel: copy.archive, tone: 'danger' })) return;
    await run(() => controller.archiveWorktableInstance(instance.id));
  };
  const restoreInstance = async (instance: WorktableInstance) => {
    await run(async () => {
      await controller.restoreWorktableInstance(instance.id);
      await controller.activateWorktableInstance(instance.id);
      setArchived(false);
    });
  };
  return <div className={`worktable-shell is-chat-collapsed ${drawerCollapsed ? 'is-drawer-collapsed' : ''} ${active?.status === 'archived' ? 'is-read-only' : ''}`} data-testid="worktable-shell">
    <aside className="worktable-drawer">
      <header><div><FlaskConical size={18}/><span><span>{copy.title}</span><small>{copy.subtitle}</small></span></div><div className="worktable-drawer-actions"><button data-testid="worktable-new" aria-label={copy.newInstance} onClick={() => setCreateOpen(true)}><Plus size={16}/></button><button aria-label={drawerCollapsed ? copy.navigation.expandDrawer : copy.navigation.collapseDrawer} onClick={() => setDrawerCollapsed((value) => !value)}>{drawerCollapsed ? <PanelLeftOpen size={16}/> : <PanelLeftClose size={16}/>}</button></div></header>
      <button className="worktable-return-chat" data-testid="worktable-return-chat" onClick={onReturnToChat}><ArrowLeft size={15}/><span>{copy.navigation.returnChat}</span></button>
      <label className="worktable-search"><Search size={13}/><input value={query} placeholder={copy.searchPlaceholder} onChange={(event) => setQuery(event.target.value)}/></label>
      <div className="worktable-drawer-tabs"><button className={!archived ? 'is-active' : ''} onClick={() => setArchived(false)}>{copy.recent}<span>{snapshot.worktable.instances.filter((instance) => instance.status !== 'archived').length}</span></button><button className={archived ? 'is-active' : ''} onClick={() => setArchived(true)}>{copy.archived}<span>{snapshot.worktable.instances.filter((instance) => instance.status === 'archived').length}</span></button></div>
      <div className="worktable-instance-list">{instances.length === 0 ? <div className="worktable-empty compact"><span>{query ? copy.noMatches : copy.noInstances}</span></div> : instances.map((instance) => <article key={instance.id} className={instance.id === active?.id ? 'is-active' : ''} data-testid={`worktable-instance-${instance.id}`}><button onClick={() => void run(() => controller.activateWorktableInstance(instance.id))}><span className="worktable-instance-icon"><FlaskConical size={16}/></span><span><span>{instance.title}</span><small>{statusLabel(instance.status)} · r{instance.revision}</small></span></button><span className="worktable-instance-actions">{instance.status === 'archived' ? <button className="is-restore" aria-label={copy.restore} onClick={() => void restoreInstance(instance)}><ArchiveRestore size={13}/></button> : <button aria-label={copy.archive} onClick={() => void archiveInstance(instance)}><Archive size={13}/></button>}</span></article>)}</div>
      <footer><span className="worktable-footer-label">{copy.templates}</span>{snapshot.worktableTemplates.map((template) => <button key={template.id} onClick={() => setCreateOpen(true)}><FlaskConical size={14}/><span>{template.title}</span></button>)}</footer>
    </aside>
    <main className="worktable-stage" data-testid="worktable-stage">{active ? <><header className="worktable-stage-toolbar"><div><FlaskConical size={16}/><span><span data-testid="worktable-title">{active.title}</span><small>{statusLabel(active.status)} · revision {active.revision}</small></span></div><div className="worktable-stage-actions">{active.status === 'archived' ? <button onClick={() => void restoreInstance(active)}><ArchiveRestore size={13}/>{copy.restore}</button> : <button onClick={() => void run(async () => {
      const value = await promptInApp(copy.rename, active.title, { title: copy.rename, confirmLabel: copy.rename });
      if (value?.trim()) await controller.updateWorktableInstance(active.id, { title: value.trim() } satisfies WorktablePatch);
    })}><Settings2 size={13}/>{copy.rename}</button>}</div></header><div className="worktable-layout"><LayoutView controller={controller} instance={active} node={active.layout} onSwitchSession={onSwitchSession} onLayoutChange={(layout) => void run(() => controller.setWorktableLayout(active.id, layout, active.panes, active.activePaneId))}/></div></> : <section className="worktable-welcome"><FlaskConical size={34}/><h2>{copy.noInstances}</h2><p>{copy.noInstancesHint}</p><button data-testid="worktable-welcome-create" onClick={() => setCreateOpen(true)}><Plus size={15}/>{copy.newInstance}</button></section>}{error && <div className="worktable-action-error" role="alert"><span>{error}</span><button aria-label={copy.navigation.close} onClick={() => setError(undefined)}><X size={13}/></button></div>}</main>
    {createOpen && <CreateWorktableDialog snapshot={snapshot} controller={controller} onClose={() => setCreateOpen(false)} onCreated={(instance) => { setCreateOpen(false); void controller.activateWorktableInstance(instance.id); }}/>} 
  </div>;
}
