import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  File,
  FileText,
  FlaskConical,
  Folder,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  LayoutTemplate,
  ListChecks,
  LoaderCircle,
  Minus,
  Play,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wrench,
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
  WorktableDeviceUiState,
  WorktableInstance,
  WorktablePane,
  WorktableRevealTarget,
  WorktableSplitNode,
  WorktableTab,
  WorktableTemplateContribution,
  WorkspaceEntry,
  WorkspacePreview,
} from '@openlab/protocol';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { confirmInApp, promptInApp } from './AppDialog.js';
import { TerminalPane } from './TerminalPane.js';
import { worktableZhCN as copy } from '../i18n/zh-CN.js';
import type { OpenLabController } from '../lib/use-openlab.js';
import {
  describeWorkbenchLayoutDiff,
  mergeWorkbenchPane,
  moveWorkbenchTab,
  reorderWorkbenchTab,
  splitWorkbenchPane,
  type WorkbenchLayoutDraft,
} from '../lib/workbench-layout.js';
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
  chatDock?: ReactNode;
  chatTitle?: string;
  chatSubtitle?: string;
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
    <WorkbenchStudio controller={controller} instance={instance}/>
  </div>;
}

function WorkbenchStudio({ controller, instance }: { controller: OpenLabController; instance: WorktableInstance }) {
  const snapshot = controller.snapshot;
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [layoutExpanded, setLayoutExpanded] = useState(false);
  const pendingLayouts = snapshot.layoutProposals.filter((proposal) => proposal.instanceId === instance.id && proposal.status === 'pending');
  const sharedWorkbench = snapshot.workbenchInstances.find((candidate) => candidate.id === instance.id);
  const activeLayoutPane = sharedWorkbench?.panes.find((pane) => pane.id === instance.activePaneId) ?? sharedWorkbench?.panes[0];
  const generated = snapshot.generatedAppBlueprints.slice(0, 8);
  const toolRuns = snapshot.toolRuns.filter((run) => snapshot.jobs.find((job) => job.id === run.jobId)?.spec.worktableInstanceId === instance.id).slice(0, 8);
  useEffect(() => {
    if (pendingLayouts.length > 0) setLayoutExpanded(true);
  }, [pendingLayouts.length]);
  const perform = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await operation(); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const decideLayout = async (id: string, accepted: boolean) => {
    if (!await confirmInApp(accepted ? copy.studio.layout.applyQuestion : copy.studio.layout.rejectQuestion, { title: copy.studio.layout.confirmTitle, confirmLabel: accepted ? copy.studio.layout.apply : copy.studio.layout.reject })) return;
    await controller.decideWorkbenchLayoutProposal(id, accepted);
  };
  const proposeLayout = async (draft: WorkbenchLayoutDraft) => {
    if (!sharedWorkbench) throw new Error(copy.studio.layout.unavailable);
    await controller.proposeWorkbenchLayout({
      instanceId: sharedWorkbench.id,
      baseRevision: sharedWorkbench.revision,
      ...draft,
    });
  };
  const decideGenerated = async (id: string, accepted: boolean) => {
    if (!await confirmInApp(accepted ? copy.studio.generated.acceptBlueprintQuestion : copy.studio.generated.rejectBlueprintQuestion, { title: copy.studio.generated.confirmTitle, confirmLabel: accepted ? copy.studio.generated.build : copy.studio.generated.reject })) return;
    await controller.decideGeneratedWorkbench(id, accepted);
  };
  const previewGenerated = async (id: string) => {
    const ticket = await controller.previewGeneratedWorkbench(id);
    if (ticket?.url) setPreviewUrl(ticket.url);
  };
  const acceptGenerated = async (id: string) => {
    if (!await confirmInApp(copy.studio.generated.acceptQuestion, { title: copy.studio.generated.acceptTitle, confirmLabel: copy.studio.generated.accept })) return;
    await controller.acceptGeneratedWorkbench(id);
  };
  const runMock = async () => {
    if (!await confirmInApp(copy.studio.toolchain.confirmQuestion, { title: copy.studio.toolchain.confirmTitle, confirmLabel: copy.studio.toolchain.runConfirm })) return;
    await controller.runToolchainAdapter('sci.mock-toolchain', 'render-json', { title: `Workbench ${instance.title}`, payload: { instanceId: instance.id, requestedAt: new Date().toISOString() } }, instance.id);
  };
  const importCatalog = async () => {
    if (!await confirmInApp(copy.studio.catalog.importQuestion, { title: copy.studio.catalog.confirmTitle, confirmLabel: copy.studio.catalog.confirmImport })) return;
    await controller.updatePluginCatalog();
  };
  const installCatalogEntry = async (entry: BootstrapSnapshot['pluginCatalog']['entries'][number]) => {
    if (!await confirmInApp(copy.studio.catalog.installQuestion(entry.name, entry.version), { title: copy.studio.catalog.confirmTitle, confirmLabel: copy.studio.catalog.confirmInstall })) return;
    await controller.installCuratedPlugin(entry.id);
  };
  return <section className="workbench-studio" data-testid="workbench-studio">
    <details open={layoutExpanded} onToggle={(event) => setLayoutExpanded(event.currentTarget.open)}>
      <summary><LayoutTemplate size={14}/><span>{copy.studio.layout.title}</span><b>{pendingLayouts.length}</b></summary>
      {sharedWorkbench && activeLayoutPane && <div className="layout-editor" data-testid="workbench-layout-editor">
        <header><div><strong>{copy.studio.layout.editor}</strong><small>{copy.studio.layout.activePane(activeLayoutPane.title ?? activeLayoutPane.id.slice(0, 8))}</small></div><span>{copy.studio.layout.previewFirst}</span></header>
        <div className="layout-editor-actions">
          <button data-testid="workbench-layout-split-right" disabled={busy || sharedWorkbench.panes.length >= 6} onClick={() => void perform(() => proposeLayout(splitWorkbenchPane(sharedWorkbench, activeLayoutPane.id, 'horizontal', undefined, copy.studio.layout.draft)))}>{copy.studio.layout.splitRight}</button>
          <button data-testid="workbench-layout-split-below" disabled={busy || sharedWorkbench.panes.length >= 6} onClick={() => void perform(() => proposeLayout(splitWorkbenchPane(sharedWorkbench, activeLayoutPane.id, 'vertical', undefined, copy.studio.layout.draft)))}>{copy.studio.layout.splitBelow}</button>
          <button data-testid="workbench-layout-merge" disabled={busy || sharedWorkbench.panes.length <= 1} onClick={() => void perform(() => proposeLayout(mergeWorkbenchPane(sharedWorkbench, activeLayoutPane.id, copy.studio.layout.draft)))}>{copy.studio.layout.merge}</button>
        </div>
        <div className="layout-tab-editor">{activeLayoutPane.tabs.map((tab, index) => <div key={tab.id}>
          <span>{tab.title}</span>
          <button aria-label={copy.studio.layout.moveEarlier(tab.title)} disabled={busy || index === 0} onClick={() => void perform(() => proposeLayout(reorderWorkbenchTab(sharedWorkbench, activeLayoutPane.id, tab.id, -1, copy.studio.layout.draft)))}>←</button>
          <button aria-label={copy.studio.layout.moveLater(tab.title)} disabled={busy || index === activeLayoutPane.tabs.length - 1} onClick={() => void perform(() => proposeLayout(reorderWorkbenchTab(sharedWorkbench, activeLayoutPane.id, tab.id, 1, copy.studio.layout.draft)))}>→</button>
          <select aria-label={copy.studio.layout.moveTab(tab.title)} defaultValue="" disabled={busy || sharedWorkbench.panes.length <= 1} onChange={(event) => { const target = event.target.value; event.target.value = ''; if (target) void perform(() => proposeLayout(moveWorkbenchTab(sharedWorkbench, tab.id, target, copy.studio.layout.draft))); }}>
            <option value="">{copy.studio.layout.moveTo}</option>
            {sharedWorkbench.panes.filter((pane) => pane.id !== activeLayoutPane.id).map((pane) => <option key={pane.id} value={pane.id}>{pane.title ?? pane.id.slice(0, 8)}</option>)}
          </select>
        </div>)}</div>
      </div>}
      <div className="studio-list">{pendingLayouts.length === 0 ? <p>{copy.studio.layout.empty}</p> : pendingLayouts.map((proposal) => <article key={proposal.id}>
        <header><strong>{proposal.title}</strong><span>{copy.studio.layout.basedOn(proposal.baseRevision)}</span></header><p>{proposal.reason}</p>
        <dl><dt>{copy.studio.layout.current}</dt><dd>{copy.studio.layout.currentPanes(instance.panes.length)}</dd><dt>{copy.studio.layout.proposal}</dt><dd>{copy.studio.layout.proposalPanes(proposal.panes.length, proposal.slots.length)}</dd></dl>
        {sharedWorkbench && (() => { const diff = describeWorkbenchLayoutDiff(sharedWorkbench, proposal, copy.studio.layout.draft); const items = [
          ...diff.addedPanes.map((name) => copy.studio.layout.added(name)),
          ...diff.removedPanes.map((name) => copy.studio.layout.removed(name)),
          ...diff.movedTabs.map((name) => copy.studio.layout.moved(name)),
          ...diff.reorderedTabs.map((name) => copy.studio.layout.reordered(name)),
        ]; return items.length > 0 ? <ul className="layout-diff">{items.map((item) => <li key={item}>{item}</li>)}</ul> : null; })()}
        <footer><button disabled={busy} onClick={() => void perform(() => decideLayout(proposal.id, false))}>{copy.studio.layout.reject}</button><button className="primary" disabled={busy} onClick={() => void perform(() => decideLayout(proposal.id, true))}>{copy.studio.layout.confirm}</button></footer>
      </article>)}</div>
    </details>
    <details>
      <summary><Sparkles size={14}/><span>{copy.studio.generated.title}</span><b>{generated.filter((item) => item.status === 'awaiting_confirmation' || item.status === 'preview').length}</b></summary>
      <form className="studio-prompt" onSubmit={(event) => { event.preventDefault(); const value = prompt.trim(); if (value) void perform(async () => { await controller.proposeGeneratedWorkbench(value); setPrompt(''); }); }}>
        <textarea value={prompt} maxLength={20_000} onChange={(event) => setPrompt(event.target.value)} placeholder={copy.studio.generated.placeholder}/>
        <button className="primary" disabled={busy || !prompt.trim()}><Sparkles size={13}/>{copy.studio.generated.generate}</button>
      </form>
      <div className="studio-list">{generated.map((blueprint) => <article key={blueprint.id}>
        <header><strong>{blueprint.title}</strong><span>{blueprint.status}</span></header><p>{blueprint.prompt}</p>
        <dl><dt>{copy.studio.generated.layout}</dt><dd>{copy.studio.generated.topology(blueprint.workbench.panes.length, blueprint.workbench.slots.length)}</dd><dt>{copy.studio.generated.capabilities}</dt><dd>{blueprint.hostCapabilities.join('、') || copy.studio.generated.noCapability}</dd><dt>{copy.studio.generated.network}</dt><dd>{blueprint.networkDomains.join('、') || copy.studio.generated.networkDenied}</dd></dl>
        {blueprint.buildLog && <pre>{blueprint.buildLog}</pre>}{blueprint.error && <p className="error">{blueprint.error}</p>}
        <footer>{blueprint.status === 'awaiting_confirmation' && <><button disabled={busy} onClick={() => void perform(() => decideGenerated(blueprint.id, false))}>{copy.studio.generated.reject}</button><button className="primary" disabled={busy} onClick={() => void perform(() => decideGenerated(blueprint.id, true))}>{copy.studio.generated.build}</button></>}{blueprint.status === 'preview' && <><button disabled={busy} onClick={() => void perform(() => previewGenerated(blueprint.id))}>{copy.studio.generated.preview}</button><button className="primary" disabled={busy} onClick={() => void perform(() => acceptGenerated(blueprint.id))}>{copy.studio.generated.accept}</button></>}</footer>
      </article>)}</div>
      {previewUrl && <div className="studio-preview"><header><span>{copy.studio.generated.previewTitle}</span><button onClick={() => setPreviewUrl(undefined)}><X size={13}/></button></header><iframe src={previewUrl} title={copy.studio.generated.previewTitle} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer"/></div>}
    </details>
    <details>
      <summary><Wrench size={14}/><span>{copy.studio.toolchain.title}</span><b>{toolRuns.filter((run) => run.status === 'running' || run.status === 'queued').length}</b></summary>
      <div className="studio-tool"><div><strong>{copy.studio.toolchain.simulator}</strong><small>{copy.studio.toolchain.description}</small></div><button className="primary" disabled={busy} onClick={() => void perform(runMock)}><Play size={13}/>{copy.studio.toolchain.run}</button></div>
      <div className="studio-list">{toolRuns.map((run) => <article key={run.id}><header><strong>{run.adapterId} / {run.operationId}</strong><span>{run.status}</span></header><p>{copy.studio.toolchain.result(run.jobId, run.artifactRevisionIds.length)}</p>{(run.status === 'queued' || run.status === 'running') && <footer><button className="danger" onClick={() => void perform(() => controller.cancelToolchainRun(run.id))}>{copy.studio.toolchain.cancel}</button></footer>}</article>)}</div>
    </details>
    <details>
      <summary><ShieldCheck size={14}/><span>{copy.studio.catalog.title}</span><b>{snapshot.pluginCatalog.entries.length}</b></summary>
      <div className="catalog-status"><span>{copy.studio.catalog.sequence(snapshot.pluginCatalog.status.sequence)}</span><span>{snapshot.pluginCatalog.status.source === 'cache' ? copy.studio.catalog.trustedCache : copy.studio.catalog.empty}</span>{snapshot.pluginCatalog.status.error && <span className="error">{snapshot.pluginCatalog.status.error}</span>}<button disabled={busy} onClick={() => void perform(importCatalog)}>{copy.studio.catalog.importIndex}</button></div>
      <div className="studio-list">{snapshot.pluginCatalog.entries.map((entry) => <article key={`${entry.id}@${entry.version}`}><header><strong>{entry.name}</strong><span>{entry.version}</span></header><p>{entry.description}</p><small>SHA-256 {entry.sha256.slice(0, 16)}… · {copy.studio.catalog.permissions(entry.permissions.join('、'))}</small><footer><button className="primary" disabled={busy} onClick={() => void perform(() => installCatalogEntry(entry))}>{copy.studio.catalog.install}</button></footer></article>)}</div>
    </details>
    {error && <p className="studio-error">{error}</p>}
  </section>;
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
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const loadPluginPanel = controller.loadPluginPanel;
  useEffect(() => {
    let active = true;
    setError(undefined);
    void loadPluginPanel(content.pluginId, content.panelId)
      .then((value) => { if (active) setUrl(value); })
      .catch((cause) => { if (active) setError(messageOf(cause)); });
    return () => { active = false; portRef.current?.close(); portRef.current = undefined; };
  }, [content.panelId, content.pluginId, loadPluginPanel]);
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
        const host = controllerRef.current;
        let value: unknown;
        if (request.method === 'context.read') {
          value = await host.pluginPanelContext(content.pluginId, content.panelId, tab.id, worktable);
        } else if (request.method === 'tool.execute') {
          const tool = typeof request.params.tool === 'string' ? request.params.tool : '';
          const params = record(request.params.params) ? request.params.params as Record<string, JsonValue> : {};
          if (!tool) throw new Error(copy.pluginPanel.missingTool);
          const paperBatchStart = content.pluginId === 'sci.paper-reader' && (tool === 'paper.start' || tool === 'paper.resume');
          if (paperBatchStart) {
            const rawContext = await host.pluginPanelContext(content.pluginId, content.panelId, tab.id, worktable);
            const panelContext = record(rawContext) ? rawContext : {};
            const preview = record(panelContext.callPreview) ? panelContext.callPreview : {};
            const reader = record(panelContext.reader) ? panelContext.reader : {};
            const authorization = record(reader.batchAuthorization) ? reader.batchAuthorization : undefined;
            const reusable = authorization?.status === 'active'
              && authorization.documentSetHash === reader.documentSetHash
              && authorization.textModel === preview.textModel
              && (authorization.visionModel ?? '') === (preview.visionModel ?? '');
            if (!reusable) {
              if (preview.ready !== true) throw new Error(copy.pluginPanel.paperBatchPreviewRequired);
              const confirmed = await confirmInApp(copy.pluginPanel.paperBatchConfirm(
                typeof preview.textModel === 'string' ? preview.textModel : copy.pluginPanel.paperBatchUnconfiguredModel,
                typeof preview.visionModel === 'string' ? preview.visionModel : copy.pluginPanel.paperBatchUnconfiguredModel,
                typeof preview.textModelCalls === 'number' ? preview.textModelCalls : 0,
                typeof preview.visionModelCalls === 'number' ? preview.visionModelCalls : 0,
                typeof preview.estimatedTotalTokens === 'number' ? preview.estimatedTotalTokens : 0,
                typeof preview.maximumTotalTokens === 'number' ? preview.maximumTotalTokens : 0,
              ), {
                title: copy.pluginPanel.paperBatchTitle,
                confirmLabel: copy.pluginPanel.paperBatchAccept,
              });
              if (!confirmed) throw new Error(copy.pluginPanel.cancelled);
            }
            value = await host.pluginPanelTool(content.pluginId, content.panelId, tab.id, tool, params, !reusable, worktable);
          } else {
          try {
            value = await host.pluginPanelTool(content.pluginId, content.panelId, tab.id, tool, params, false, worktable);
          } catch (cause) {
            if (!messageOf(cause).includes(copy.pluginPanel.confirmationRequiredMarker)) throw cause;
            const confirmed = await confirmInApp(copy.pluginPanel.confirmTool.replace('{tool}', tool), {
              title: copy.pluginPanel.confirmTitle,
              confirmLabel: copy.pluginPanel.confirm,
            });
            if (!confirmed) throw new Error(copy.pluginPanel.cancelled);
            value = await host.pluginPanelTool(content.pluginId, content.panelId, tab.id, tool, params, true, worktable);
          }
          }
        } else if (request.method === 'resource.open') {
          if (!record(request.params.document)) throw new Error(copy.pluginPanel.invalidReveal);
          value = await host.pluginPanelResource(request.params.document as unknown as DocumentRevisionRef);
        } else {
          if (!record(request.params.document) || !record(request.params.selector)) throw new Error(copy.pluginPanel.invalidReveal);
          value = await host.pluginPanelReveal(
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

function WorktablePdfPane({ controller, target, reveal }: { controller: OpenLabController; target: DocumentRevisionRef; reveal?: BootstrapSnapshot['worktable']['reveal'] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderRevision = useRef(0);
  const [document, setDocument] = useState<import('pdfjs-dist').PDFDocumentProxy>();
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(.9);
  const [error, setError] = useState<string>();
  const openResource = controller.openResource;
  const readResource = controller.readResource;
  const releaseResource = controller.releaseResource;
  useEffect(() => {
    if (!reveal || reveal.document.sha256 !== target.sha256) return;
    if (reveal.selector.kind === 'pdf-rect' || reveal.selector.kind === 'pdf-text') {
      setPageNumber(document ? Math.min(document.numPages, reveal.selector.page) : reveal.selector.page);
    }
  }, [document, reveal?.id, target.sha256]);
  useEffect(() => {
    let active = true;
    let handleId: string | undefined;
    let loadingTask: import('pdfjs-dist').PDFDocumentLoadingTask | undefined;
    setDocument(undefined);
    setPageNumber(1);
    setError(undefined);
    void (async () => {
      const handle = await openResource(target);
      handleId = handle.id;
      if (!active) {
        await releaseResource(handle.id).catch(() => undefined);
        return;
      }
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const chunkSize = 1024 * 1024;
      const initialEnd = Math.min(handle.size, chunkSize);
      const initialData = await readResource(handle.id, 0, initialEnd - 1);
      class HostRangeTransport extends pdfjs.PDFDataRangeTransport {
        #aborted = false;
        constructor() { super(handle.size, initialData); }
        requestDataRange(begin: number, end: number): void {
          if (this.#aborted || !active) return;
          void readResource(handle.id, begin, end - 1).then((chunk) => {
            if (!this.#aborted && active) this.onDataRange(begin, chunk);
          }).catch((cause) => {
            if (!this.#aborted && active) setError(messageOf(cause));
          });
        }
        override abort(): void { this.#aborted = true; }
      }
      loadingTask = pdfjs.getDocument({
        range: new HostRangeTransport(),
        rangeChunkSize: chunkSize,
        disableStream: true,
      });
      const loaded = await loadingTask.promise;
      if (active) setDocument(loaded);
      else await loadingTask.destroy();
    })().catch((cause) => { if (active) setError(messageOf(cause)); });
    return () => {
      active = false;
      renderRevision.current += 1;
      if (loadingTask) void loadingTask.destroy();
      if (handleId) void releaseResource(handleId).catch(() => undefined);
    };
  }, [openResource, readResource, releaseResource, target.mediaType, target.ref.path, target.ref.rootId, target.sha256]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    const revision = ++renderRevision.current;
    let task: import('pdfjs-dist').RenderTask | undefined;
    void document.getPage(pageNumber).then((page) => {
      if (revision !== renderRevision.current || !canvas.current) return;
      const viewport = page.getViewport({ scale: zoom });
      const outputScale = Math.max(1, window.devicePixelRatio || 1);
      const targetCanvas = canvas.current;
      const context = targetCanvas.getContext('2d');
      if (!context) throw new Error(copy.pdf.canvasUnavailable);
      targetCanvas.width = Math.floor(viewport.width * outputScale);
      targetCanvas.height = Math.floor(viewport.height * outputScale);
      targetCanvas.style.width = `${Math.floor(viewport.width)}px`;
      targetCanvas.style.height = `${Math.floor(viewport.height)}px`;
      task = page.render({
        canvas: targetCanvas,
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      });
      return task.promise;
    }).catch((cause) => {
      if (revision === renderRevision.current && (!(cause instanceof Error) || cause.name !== 'RenderingCancelledException')) setError(messageOf(cause));
    });
    return () => { renderRevision.current += 1; task?.cancel(); };
  }, [document, pageNumber, zoom]);
  if (error) return <div className="worktable-empty" role="alert"><FileText size={24}/><span>{copy.pdf.failed(error)}</span></div>;
  if (!document) return <div className="worktable-empty"><LoaderCircle className="spin" size={22}/><span>{copy.pdf.loading}</span></div>;
  return <div className="workbench-pdf worktable-native-pdf" data-testid="worktable-pdf-viewer">
    <div className="workbench-pdf__status">
      <button aria-label={copy.pdf.previousPage} disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => Math.max(1, value - 1))}><ChevronLeft size={13}/></button>
      <span>{pageNumber} / {document.numPages}</span>
      <button aria-label={copy.pdf.nextPage} disabled={pageNumber >= document.numPages} onClick={() => setPageNumber((value) => Math.min(document.numPages, value + 1))}><ChevronRight size={13}/></button>
      <button aria-label={copy.pdf.zoomOut} disabled={zoom <= .4} onClick={() => setZoom((value) => Math.max(.4, value - .1))}><Minus size={13}/></button>
      <span>{Math.round(zoom * 100)}%</span>
      <button aria-label={copy.pdf.zoomIn} disabled={zoom >= 2.4} onClick={() => setZoom((value) => Math.min(2.4, value + .1))}><Plus size={13}/></button>
    </div>
    <div className="pdf-page-shell"><canvas ref={canvas} data-testid="worktable-pdf-canvas"/>{reveal && (reveal.selector.kind === 'pdf-rect' || reveal.selector.kind === 'pdf-text') && reveal.selector.page === pageNumber && reveal.document.sha256 === target.sha256 && <div className="pdf-evidence-layer" data-testid="worktable-pdf-evidence-highlight">{reveal.selector.rects.map((rect, index) => <span key={`${reveal.id}-${index}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}/>)}</div>}</div>
  </div>;
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
  if (content.kind === 'document') return content.target.mediaType === 'application/pdf' || content.target.ref.path.toLocaleLowerCase().endsWith('.pdf')
    ? <WorktablePdfPane controller={controller} target={content.target} reveal={controller.snapshot.worktable.reveal?.targetTabId === tab.id ? controller.snapshot.worktable.reveal : undefined}/>
    : <div className="worktable-empty"><FileText size={24}/><span>{content.target.ref.path}</span><button onClick={() => void window.openlab?.openWorkspacePath(content.target.ref)}>{copy.open}</button></div>;
  if (content.kind === 'artifact') return <div className="worktable-empty"><File size={24}/><span>Artifact {content.artifactId}{content.revisionId ? ` · ${content.revisionId}` : ''}</span></div>;
  return <PluginPanelPane controller={controller} instance={instance} pane={pane} tab={tab} content={content}/>;
}

function PaneView({ controller, instance, pane, onSwitchSession, onActivateTab, onFocusPane }: {
  controller: OpenLabController;
  instance: WorktableInstance;
  pane: WorktablePane;
  onSwitchSession(id: string): void;
  onActivateTab(paneId: string, tabId: string): void;
  onFocusPane(paneId: string): void;
}) {
  const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
  const archived = instance.status === 'archived';
  const add = async (kind: WorktableBuiltinKind) => {
    await controller.mountWorktableContent(instance.id, pane.id, { title: builtinTitle(kind), content: { kind: 'builtin', type: kind } });
  };
  return <section className={`worktable-pane ${instance.activePaneId === pane.id ? 'is-active' : ''}`} data-testid={`worktable-pane-${pane.id}`} onPointerDown={() => onFocusPane(pane.id)}>
    <header className="worktable-pane-tabs"><div>{pane.tabs.map((tab) => <button key={tab.id} className={tab.id === activeTab?.id ? 'is-active' : ''} onClick={() => onActivateTab(pane.id, tab.id)}>{iconForContent(tab.content)}<span>{tab.title}</span>{!archived && <i role="button" aria-label={copy.closeTab} onClick={(event) => { event.stopPropagation(); void controller.closeWorktableTab(instance.id, pane.id, tab.id); }}><X size={11}/></i>}</button>)}</div><div className="worktable-pane-actions">{!archived && <select aria-label={copy.addContent} defaultValue="" onChange={(event) => { const kind = event.target.value as WorktableBuiltinKind; event.target.value = ''; if (kind) void add(kind); }}><option value="">{copy.addContent}</option>{builtinOrder.map((kind) => <option key={kind} value={kind}>{builtinTitle(kind)}</option>)}</select>}</div></header>
    <div className="worktable-pane-body">{activeTab ? <ContentView controller={controller} instance={instance} pane={pane} tab={activeTab} content={activeTab.content} active onSwitchSession={onSwitchSession}/> : <div className="worktable-empty"><span>{copy.emptyPane}</span><small>{copy.emptyPaneHint}</small></div>}</div>
  </section>;
}

interface LayoutViewProps {
  controller: OpenLabController;
  instance: WorktableInstance;
  node: WorktableSplitNode;
  onSwitchSession(id: string): void;
  path: string;
  paneRatios: Record<string, number>;
  onRatioChange(path: string, ratio: number): void;
  onActivateTab(paneId: string, tabId: string): void;
  onFocusPane(paneId: string): void;
}

function LayoutView(props: LayoutViewProps) {
  const { controller, instance, node, onSwitchSession } = props;
  if (node.kind === 'pane') {
    const pane = instance.panes.find((candidate) => candidate.id === node.paneId);
    return pane ? <PaneView controller={controller} instance={instance} pane={pane} onSwitchSession={onSwitchSession} onActivateTab={props.onActivateTab} onFocusPane={props.onFocusPane}/> : <div className="worktable-invalid-pane">{copy.errors.missingPane}</div>;
  }
  return <SplitLayoutView {...props} node={node}/>;
}

function SplitLayoutView({ controller, instance, node, onSwitchSession, path, paneRatios, onRatioChange, onActivateTab, onFocusPane }: Omit<LayoutViewProps, 'node'> & { node: Extract<WorktableSplitNode, { kind: 'split' }> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const effectiveRatio = paneRatios[path] ?? node.ratio;
  const ratioRef = useRef(effectiveRatio);
  const [ratio, setRatio] = useState(effectiveRatio);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { ratioRef.current = effectiveRatio; setRatio(effectiveRatio); }, [effectiveRatio]);
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
    onRatioChange(path, ratioRef.current);
  };
  const style = node.direction === 'horizontal'
    ? { gridTemplateColumns: `minmax(0, ${ratio}fr) 5px minmax(0, ${1 - ratio}fr)` }
    : { gridTemplateRows: `minmax(0, ${ratio}fr) 5px minmax(0, ${1 - ratio}fr)` };
  return <div ref={containerRef} className={`worktable-split is-${node.direction} ${dragging ? 'is-resizing' : ''}`} style={style as CSSProperties}>
    <LayoutView controller={controller} instance={instance} node={node.first} onSwitchSession={onSwitchSession} path={`${path}.first`} paneRatios={paneRatios} onRatioChange={onRatioChange} onActivateTab={onActivateTab} onFocusPane={onFocusPane}/>
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
        onRatioChange(path, next);
      }}
    />
    <LayoutView controller={controller} instance={instance} node={node.second} onSwitchSession={onSwitchSession} path={`${path}.second`} paneRatios={paneRatios} onRatioChange={onRatioChange} onActivateTab={onActivateTab} onFocusPane={onFocusPane}/>
  </div>;
}

const DEFAULT_DEVICE_STATE: WorktableDeviceUiState = {
  drawerWidth: 236,
  chatWidth: 360,
  chatHeight: 420,
  drawerCollapsed: false,
  chatCollapsed: true,
  paneRatios: {},
  activeTabIds: {},
};

export function WorktableShell({ controller, onReturnToChat, onSwitchSession, chatDock, chatTitle, chatSubtitle }: WorktableShellProps) {
  const snapshot = controller.snapshot;
  const getWorktableUiState = controller.getWorktableUiState;
  const saveWorktableUiState = controller.saveWorktableUiState;
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [deviceState, setDeviceState] = useState<WorktableDeviceUiState>(DEFAULT_DEVICE_STATE);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState<string>();
  const activeSource = snapshot.worktable.instances.find((instance) => instance.id === snapshot.worktable.activeInstanceId)
    ?? snapshot.worktable.instances.find((instance) => instance.status !== 'archived');
  const requestedSession = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (activeSource?.boundSessionId === snapshot.activeSessionId) requestedSession.current = undefined;
    else if (activeSource?.boundSessionId && requestedSession.current !== activeSource.boundSessionId) {
      requestedSession.current = activeSource.boundSessionId;
      onSwitchSession(activeSource.boundSessionId);
    }
  }, [activeSource?.boundSessionId, onSwitchSession, snapshot.activeSessionId]);
  useEffect(() => {
    let current = true;
    setDeviceState(DEFAULT_DEVICE_STATE);
    if (activeSource) void getWorktableUiState(activeSource.id).then((value) => {
      if (current && value) setDeviceState({ ...DEFAULT_DEVICE_STATE, ...value, paneRatios: { ...value.paneRatios }, activeTabIds: { ...(value.activeTabIds ?? {}) } });
    }).catch(() => undefined);
    return () => { current = false; };
  }, [activeSource?.id, getWorktableUiState]);
  const updateDeviceState = useCallback((patch: Partial<WorktableDeviceUiState>) => {
    setDeviceState((current) => {
      const next = { ...current, ...patch };
      if (activeSource) void saveWorktableUiState(activeSource.id, patch);
      return next;
    });
  }, [activeSource?.id, saveWorktableUiState]);
  const appliedReveal = useRef<string | undefined>(undefined);
  useEffect(() => {
    const reveal = snapshot.worktable.reveal;
    if (!activeSource || !reveal || reveal.instanceId !== activeSource.id || appliedReveal.current === reveal.id) return;
    appliedReveal.current = reveal.id;
    updateDeviceState({
      activeTabIds: { ...(deviceState.activeTabIds ?? {}), [reveal.targetPaneId]: reveal.targetTabId },
      focusedPaneId: reveal.targetPaneId,
    });
  }, [activeSource, deviceState.activeTabIds, snapshot.worktable.reveal, updateDeviceState]);
  const active = useMemo<WorktableInstance | undefined>(() => {
    if (!activeSource) return undefined;
    const panes = activeSource.panes.map((pane) => {
      const activeTabId = deviceState.activeTabIds?.[pane.id];
      return activeTabId ? { ...pane, activeTabId } : pane;
    });
    return {
      ...activeSource,
      ...(deviceState.focusedPaneId ? { activePaneId: deviceState.focusedPaneId } : {}),
      panes,
    };
  }, [activeSource, deviceState.activeTabIds, deviceState.focusedPaneId]);
  const drawerCollapsed = deviceState.drawerCollapsed;
  const chatCollapsed = deviceState.chatCollapsed;
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
  const activateLocalTab = (paneId: string, tabId: string) => updateDeviceState({ activeTabIds: { ...(deviceState.activeTabIds ?? {}), [paneId]: tabId }, focusedPaneId: paneId });
  const focusLocalPane = (paneId: string) => {
    if (deviceState.focusedPaneId !== paneId) updateDeviceState({ focusedPaneId: paneId });
  };
  const saveRatio = (path: string, ratio: number) => updateDeviceState({ paneRatios: { ...deviceState.paneRatios, [path]: ratio } });
  return <div
    className={`worktable-shell ${chatCollapsed ? 'is-chat-collapsed' : ''} ${drawerCollapsed ? 'is-drawer-collapsed' : ''} ${active?.status === 'archived' ? 'is-read-only' : ''}`}
    style={{ '--worktable-drawer-width': `${deviceState.drawerWidth}px`, '--worktable-chat-width': `${deviceState.chatWidth}px` } as CSSProperties}
    data-testid="worktable-shell"
  >
    <aside className="worktable-drawer">
      <header><div><FlaskConical size={18}/><span><span>{copy.title}</span><small>{copy.subtitle}</small></span></div><div className="worktable-drawer-actions"><button data-testid="worktable-new" aria-label={copy.newInstance} onClick={() => setCreateOpen(true)}><Plus size={16}/></button><button aria-label={drawerCollapsed ? copy.navigation.expandDrawer : copy.navigation.collapseDrawer} onClick={() => updateDeviceState({ drawerCollapsed: !drawerCollapsed })}>{drawerCollapsed ? <PanelLeftOpen size={16}/> : <PanelLeftClose size={16}/>}</button></div></header>
      <button className="worktable-return-chat" data-testid="worktable-return-chat" onClick={onReturnToChat}><ArrowLeft size={15}/><span>{copy.navigation.returnChat}</span></button>
      <label className="worktable-search"><Search size={13}/><input value={query} placeholder={copy.searchPlaceholder} onChange={(event) => setQuery(event.target.value)}/></label>
      <div className="worktable-drawer-tabs"><button className={!archived ? 'is-active' : ''} onClick={() => setArchived(false)}>{copy.recent}<span>{snapshot.worktable.instances.filter((instance) => instance.status !== 'archived').length}</span></button><button className={archived ? 'is-active' : ''} onClick={() => setArchived(true)}>{copy.archived}<span>{snapshot.worktable.instances.filter((instance) => instance.status === 'archived').length}</span></button></div>
      <div className="worktable-instance-list">{instances.length === 0 ? <div className="worktable-empty compact"><span>{query ? copy.noMatches : copy.noInstances}</span></div> : instances.map((instance) => <article key={instance.id} className={instance.id === active?.id ? 'is-active' : ''} data-testid={`worktable-instance-${instance.id}`}><button onClick={() => void run(() => controller.activateWorktableInstance(instance.id))}><span className="worktable-instance-icon"><FlaskConical size={16}/></span><span><span>{instance.title}</span><small>{statusLabel(instance.status)} · r{instance.revision}</small></span></button><span className="worktable-instance-actions">{instance.status === 'archived' ? <button className="is-restore" aria-label={copy.restore} onClick={() => void restoreInstance(instance)}><ArchiveRestore size={13}/></button> : <button aria-label={copy.archive} onClick={() => void archiveInstance(instance)}><Archive size={13}/></button>}</span></article>)}</div>
      <footer><span className="worktable-footer-label">{copy.templates}</span>{snapshot.worktableTemplates.map((template) => <button key={template.id} onClick={() => setCreateOpen(true)}><FlaskConical size={14}/><span>{template.title}</span></button>)}</footer>
    </aside>
    <main className="worktable-stage" data-testid="worktable-stage">{active ? <><header className="worktable-stage-toolbar"><div><FlaskConical size={16}/><span><span data-testid="worktable-title">{active.title}</span><small>{statusLabel(active.status)} · revision {active.revision}</small></span></div><div className="worktable-stage-actions">{active.status === 'archived' ? <button onClick={() => void restoreInstance(active)}><ArchiveRestore size={13}/>{copy.restore}</button> : <button onClick={() => void run(async () => {
      const value = await promptInApp(copy.rename, active.title, { title: copy.rename, confirmLabel: copy.rename });
      if (value?.trim()) await controller.updateWorktableInstance(active.id, { title: value.trim() } satisfies WorktablePatch);
    })}><Settings2 size={13}/>{copy.rename}</button>}</div></header><div className="worktable-layout"><LayoutView controller={controller} instance={active} node={active.layout} onSwitchSession={onSwitchSession} path="root" paneRatios={deviceState.paneRatios} onRatioChange={saveRatio} onActivateTab={activateLocalTab} onFocusPane={focusLocalPane}/></div></> : <section className="worktable-welcome"><FlaskConical size={34}/><h2>{copy.noInstances}</h2><p>{copy.noInstancesHint}</p><button data-testid="worktable-welcome-create" onClick={() => setCreateOpen(true)}><Plus size={15}/>{copy.newInstance}</button></section>}{error && <div className="worktable-action-error" role="alert"><span>{error}</span><button aria-label={copy.navigation.close} onClick={() => setError(undefined)}><X size={13}/></button></div>}</main>
    {chatCollapsed && <button className="worktable-chat-toggle" data-testid="worktable-chat-expand" aria-label={copy.chatDock.expand} title={copy.chatDock.expand} onClick={() => updateDeviceState({ chatCollapsed: false })}><ChevronLeft size={18}/></button>}
    <aside className="worktable-chat-dock" aria-hidden={chatCollapsed}>
      <header><div><Bot size={16}/><span><span>{chatTitle ?? copy.chatDock.title}</span><small>{chatSubtitle ?? active?.boundSessionId ?? copy.chatDock.unbound}</small></span></div><button data-testid="worktable-chat-collapse" aria-label={copy.chatDock.collapse} title={copy.chatDock.collapse} onClick={() => updateDeviceState({ chatCollapsed: true })}><ChevronRight size={17}/></button></header>
      <div className="worktable-bound-chat">{chatDock ?? <div className="worktable-empty"><span>{copy.chatDock.unbound}</span></div>}</div>
    </aside>
    {createOpen && <CreateWorktableDialog snapshot={snapshot} controller={controller} onClose={() => setCreateOpen(false)} onCreated={(instance) => { setCreateOpen(false); void controller.activateWorktableInstance(instance.id); }}/>}
  </div>;
}
