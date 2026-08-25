import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownAZ, ArrowDownWideNarrow, ChevronDown, ChevronRight, CircleAlert, Copy, Eye, File,
  FileArchive, FileCode2, FileImage, FileText, Filter, Folder, FolderInput, FolderOpen, FolderPlus, Link2, MoreHorizontal,
  Paperclip, Plus, RefreshCw, Search, ShieldCheck, Trash2, Undo2, Upload, X, Zap,
} from 'lucide-react';
import type {
  BootstrapSnapshot, ChatAttachmentRef, PermissionMode, WorkspaceEntry, WorkspacePathRef, WorkspacePreview,
  WorkspaceSearchResult,
} from '@openlab/protocol';
import { hanaZhCN as copy } from '../i18n/zh-CN.js';
import { confirmInApp, promptInApp } from './AppDialog.js';

type FileOperation =
  | { type: 'create_file'; target: WorkspacePathRef; content?: string }
  | { type: 'create_directory'; target: WorkspacePathRef }
  | { type: 'rename' | 'move' | 'copy'; source: WorkspacePathRef; target: WorkspacePathRef }
  | { type: 'delete'; target: WorkspacePathRef };

type WorkspacePanel = 'skills' | 'workspace' | 'files';

interface ConversationWorkspaceProps {
  snapshot: BootstrapSnapshot;
  running: boolean;
  tab: 'files' | 'workspace';
  onTabChange(tab: 'files' | 'workspace'): void;
  mobileOpen?: boolean;
  focusWorkspaceToken?: number;
  onCloseMobile?(): void;
  listWorkspace(ref: WorkspacePathRef, options?: { showHidden?: boolean; sort?: 'name' | 'modified'; order?: 'asc' | 'desc' }): Promise<WorkspaceEntry[]>;
  searchWorkspace(rootId: string, query: string, options?: { showHidden?: boolean; includeContent?: boolean }): Promise<WorkspaceSearchResult[]>;
  previewWorkspace(ref: WorkspacePathRef): Promise<WorkspacePreview>;
  createWorkspaceAttachment(ref: WorkspacePathRef): Promise<ChatAttachmentRef>;
  saveWorkspaceNote(note: string): Promise<void>;
  activateWorkspaceRoot(rootId: string): Promise<void>;
  confirmWorkspaceRoot(rootId: string): Promise<void>;
  revokeWorkspaceRoot(rootId: string): Promise<void>;
  authorizeWorkspaceRoot(access: PermissionMode): Promise<unknown>;
  operateWorkspaceFile(operation: FileOperation, confirmed?: boolean): Promise<{ id: string }>;
  undoWorkspaceFile(id: string): Promise<void>;
  addConversationFile(ref: WorkspacePathRef): Promise<void>;
  installSkill(): Promise<void>;
  installSkillSource(sourcePath: string): Promise<void>;
  approveSkill(id: string, sha256: string): Promise<void>;
  onReferenceAttachment(attachment: ChatAttachmentRef): void;
}

const keyOf = (ref: WorkspacePathRef) => `${ref.rootId}:${ref.path}`;
const parentPath = (path: string) => path === '.' || !path.includes('/') ? '.' : path.slice(0, path.lastIndexOf('/'));
const joinPath = (directory: string, name: string) => directory === '.' ? name : `${directory}/${name}`;

function fileIcon(entry: { kind: 'file' | 'directory'; mediaType?: string | undefined; name: string }) {
  if (entry.kind === 'directory') return <Folder size={15} fill="currentColor"/>;
  if (entry.mediaType?.startsWith('image/')) return <FileImage size={15}/>;
  if (entry.mediaType === 'application/pdf') return <FileText size={15}/>;
  if (/\.(?:zip|7z|rar|tar|gz)$/iu.test(entry.name)) return <FileArchive size={15}/>;
  if (/\.(?:ts|tsx|js|jsx|py|r|rs|go|java|c|cpp|h|css|html|json|ya?ml)$/iu.test(entry.name)) return <FileCode2 size={15}/>;
  return <File size={15}/>;
}

function filterEntry(entry: WorkspaceEntry, filter: 'all' | 'text' | 'image' | 'pdf') {
  if (entry.kind === 'directory' || filter === 'all') return true;
  if (filter === 'image') return entry.mediaType?.startsWith('image/') === true;
  if (filter === 'pdf') return entry.mediaType === 'application/pdf';
  return entry.mediaType?.startsWith('text/') === true || /\.(?:md|txt|csv|tsv|json|ya?ml|xml|tex|log|py|r|ts|tsx|js|jsx)$/iu.test(entry.name);
}

export function ConversationWorkspace(props: ConversationWorkspaceProps) {
  const [activePanel, setActivePanel] = useState<WorkspacePanel | null>(null);
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'text' | 'image' | 'pdf'>('all');
  const [showHidden, setShowHidden] = useState(false);
  const [sort, setSort] = useState<'name' | 'modified'>('name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [entries, setEntries] = useState<Record<string, WorkspaceEntry[]>>({});
  const [searchResults, setSearchResults] = useState<WorkspaceSearchResult[]>([]);
  const [selectedDirectory, setSelectedDirectory] = useState<WorkspacePathRef>({ rootId: props.snapshot.workspace.activeRootId, path: '.' });
  const [preview, setPreview] = useState<WorkspacePreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lastChangeId, setLastChangeId] = useState<string>();
  const [note, setNote] = useState(props.snapshot.workspace.note);
  const [noteOpen, setNoteOpen] = useState(() => Boolean(props.snapshot.workspace.note.trim()));
  const [conversationOpen, setConversationOpen] = useState(false);
  const [authorizeOpen, setAuthorizeOpen] = useState(false);
  const noteSession = useRef(props.snapshot.activeSessionId);
  const lastFocusWorkspaceToken = useRef(props.focusWorkspaceToken);
  const noteDirty = useRef(false);
  const noteRevision = useRef(0);
  const skillsOpen = activePanel === 'skills';

  const activeRoot = props.snapshot.workspace.roots.find((root) => root.id === props.snapshot.workspace.activeRootId) ?? props.snapshot.workspace.roots[0];
  const activeSkills = props.snapshot.skills.filter((skill) => skill.scope !== 'user' && (skill.rootId ?? 'project') === props.snapshot.workspace.activeRootId);

  const loadDirectory = useCallback(async (ref: WorkspacePathRef, force = false) => {
    const key = keyOf(ref);
    if (!force && entries[key]) return;
    const value = await props.listWorkspace(ref, { showHidden, sort, order });
    setEntries((current) => ({ ...current, [key]: value }));
  }, [entries, order, props, showHidden, sort]);

  useEffect(() => {
    const rootRef = { rootId: props.snapshot.workspace.activeRootId, path: '.' };
    setSelectedDirectory(rootRef);
    setExpanded(new Set([keyOf(rootRef)]));
    void loadDirectory(rootRef, true).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  // The loader intentionally refreshes only when the active root changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.snapshot.workspace.activeRootId]);

  useEffect(() => {
    if (props.focusWorkspaceToken === undefined || props.focusWorkspaceToken === lastFocusWorkspaceToken.current) return;
    lastFocusWorkspaceToken.current = props.focusWorkspaceToken;
    setActivePanel('workspace');
    props.onTabChange('workspace');
  }, [props.focusWorkspaceToken, props.onTabChange]);

  useEffect(() => {
    if (noteSession.current !== props.snapshot.activeSessionId) {
      noteSession.current = props.snapshot.activeSessionId;
      noteDirty.current = false;
      noteRevision.current = 0;
      setNote(props.snapshot.workspace.note);
      const stored = sessionStorage.getItem(`openlab-workspace-goal:${props.snapshot.project.id}:${props.snapshot.activeSessionId}`);
      setNoteOpen(stored === null ? Boolean(props.snapshot.workspace.note.trim()) : stored === 'open');
    } else if (!noteDirty.current && note !== props.snapshot.workspace.note) {
      setNote(props.snapshot.workspace.note);
    }
  }, [note, props.snapshot.activeSessionId, props.snapshot.workspace.note]);

  useEffect(() => {
    if (!noteDirty.current || note === props.snapshot.workspace.note) {
      if (note === props.snapshot.workspace.note) noteDirty.current = false;
      return;
    }
    const revision = noteRevision.current;
    const timer = window.setTimeout(() => void props.saveWorkspaceNote(note).then(() => {
      if (noteRevision.current === revision) noteDirty.current = false;
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))), 750);
    return () => window.clearTimeout(timer);
  }, [note, props.saveWorkspaceNote, props.snapshot.workspace.note]);

  useEffect(() => {
    if (!query.trim()) { setSearchResults([]); return; }
    const timer = window.setTimeout(() => {
      void props.searchWorkspace(props.snapshot.workspace.activeRootId, query, { showHidden }).then(setSearchResults).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [props, query, showHidden]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(undefined);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const refreshSelected = async () => {
    setEntries((current) => { const next = { ...current }; delete next[keyOf(selectedDirectory)]; return next; });
    await loadDirectory(selectedDirectory, true);
  };

  const operate = async (operation: FileOperation, confirmed = false) => {
    const change = await props.operateWorkspaceFile(operation, confirmed);
    setLastChangeId(change.id);
    await refreshSelected();
  };

  const reference = async (ref: WorkspacePathRef) => {
    const attachment = await props.createWorkspaceAttachment(ref);
    await props.addConversationFile(ref);
    props.onReferenceAttachment(attachment);
  };

  const requestTarget = async (entry: WorkspaceEntry, operation: 'rename' | 'move' | 'copy'): Promise<WorkspacePathRef | undefined> => {
    if (operation === 'rename') {
      const name = (await promptInApp(copy.workspace.newName, entry.name, { title: copy.workspace.rename }))?.trim();
      return name ? { rootId: entry.rootId, path: joinPath(parentPath(entry.path), name) } : undefined;
    }
    const value = (await promptInApp(copy.workspace.targetLocation, `${entry.rootId}:${entry.path}`, { title: operation === 'move' ? copy.workspace.move : copy.workspace.copy }))?.trim();
    if (!value) return undefined;
    const separator = value.indexOf(':');
    return separator > 0 ? { rootId: value.slice(0, separator), path: value.slice(separator + 1) } : { rootId: entry.rootId, path: value };
  };

  const renderEntry = (entry: WorkspaceEntry, depth: number): React.ReactNode => {
    if (!filterEntry(entry, filter)) return null;
    const ref = { rootId: entry.rootId, path: entry.path };
    const key = keyOf(ref);
    const isExpanded = expanded.has(key);
    return <div key={key} className="workspace-tree__branch">
      <div className={`workspace-tree__row ${entry.kind === 'directory' && selectedDirectory.rootId === entry.rootId && selectedDirectory.path === entry.path ? 'is-selected' : ''}`} style={{ '--tree-depth': depth } as React.CSSProperties}>
        <button className="workspace-tree__main" onClick={() => void run(async () => {
          if (entry.kind === 'directory') {
            setSelectedDirectory(ref);
            setExpanded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
            if (!isExpanded) await loadDirectory(ref);
          } else setPreview(await props.previewWorkspace(ref));
        })}>
          {entry.kind === 'directory' ? isExpanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/> : <span className="tree-spacer"/>}
          <span className={`workspace-entry-icon ${entry.kind}`}>{fileIcon(entry)}</span><span title={entry.path}>{entry.name}</span>
        </button>
        <span className="workspace-tree__actions">
          {entry.kind === 'file' && <button title={copy.workspace.referenceConversation} onClick={() => void run(() => reference(ref))}><Link2 size={12}/></button>}
          <button title={copy.workspace.openSystem} onClick={() => void window.openlab?.openWorkspacePath(ref)}><FolderOpen size={12}/></button>
          <button title={copy.workspace.rename} onClick={() => void run(async () => { const target = await requestTarget(entry, 'rename'); if (target) await operate({ type: 'rename', source: ref, target }); })}><FileText size={12}/></button>
          <button title={copy.workspace.move} onClick={() => void run(async () => { const target = await requestTarget(entry, 'move'); if (target) await operate({ type: 'move', source: ref, target }, target.rootId !== ref.rootId); })}><FolderInput size={12}/></button>
          <button title={copy.workspace.copy} onClick={() => void run(async () => { const target = await requestTarget(entry, 'copy'); if (target) await operate({ type: 'copy', source: ref, target }); })}><Copy size={12}/></button>
          <button title={copy.workspace.delete} onClick={() => void run(async () => { if (await confirmInApp(copy.workspace.confirmDelete(entry.name), { title: copy.workspace.delete, confirmLabel: copy.workspace.delete, tone: 'danger' })) await operate({ type: 'delete', target: ref }, true); })}><Trash2 size={12}/></button>
        </span>
      </div>
      {entry.kind === 'directory' && isExpanded && <div>{(entries[key] ?? []).map((child) => renderEntry(child, depth + 1))}</div>}
    </div>;
  };

  const visibleSearch = useMemo(() => searchResults.filter((result) => filterEntry(result.entry, filter)), [filter, searchResults]);

  const choosePanel = (panel: WorkspacePanel) => {
    setActivePanel(panel);
    setPreview(undefined);
    setViewOptionsOpen(false);
    setAuthorizeOpen(false);
    if (panel === 'files' || panel === 'workspace') props.onTabChange(panel);
  };

  const showPanelChoices = () => {
    setActivePanel(null);
    setPreview(undefined);
    setViewOptionsOpen(false);
    setAuthorizeOpen(false);
  };

  const toggleNote = () => {
    const next = !noteOpen;
    setNoteOpen(next);
    sessionStorage.setItem(`openlab-workspace-goal:${props.snapshot.project.id}:${props.snapshot.activeSessionId}`, next ? 'open' : 'closed');
  };

  const panelIcon = (panel: WorkspacePanel, size = 15) => panel === 'skills'
    ? <Zap size={size}/>
    : panel === 'workspace'
      ? <FolderOpen size={size}/>
      : <FileText size={size}/>;
  const panelLabel = (panel: WorkspacePanel) => panel === 'skills'
    ? copy.workspace.projectSkills
    : panel === 'workspace'
      ? copy.workspace.workbench
      : copy.workspace.conversationFiles;

  return <aside id="conversation-workspace" className={`conversation-workspace ${props.mobileOpen ? 'is-mobile-open is-panel-open' : 'is-panel-closed'}`} aria-hidden={!props.mobileOpen} inert={!props.mobileOpen ? true : undefined}>
    <header className="conversation-workspace__header">
      <div className="workspace-panel-tabs">
        {activePanel && <><div className="workspace-panel-tab" data-testid="workspace-active-panel">{panelIcon(activePanel)}<strong>{panelLabel(activePanel)}</strong><button aria-label={copy.common.close} title={copy.common.close} onClick={showPanelChoices}><X size={14}/></button></div><button className="workspace-panel-add" data-testid="workspace-panel-add" aria-label={copy.workspace.choosePanel} title={copy.workspace.choosePanel} onClick={showPanelChoices}><Plus size={18}/></button></>}
      </div>
      <div className="conversation-workspace__actions">
        <button className="workspace-mobile-close" aria-label={copy.common.close} onClick={props.onCloseMobile}><X size={15}/></button>
      </div>
    </header>

    {activePanel === null ? <section className="workspace-panel-launcher" data-testid="workspace-panel-launcher"><div className="workspace-panel-launcher__options">{(['skills', 'workspace', 'files'] as const).map((panel) => <button key={panel} data-testid={`workspace-panel-option-${panel}`} onClick={() => choosePanel(panel)}><span>{panelIcon(panel, 17)}<strong>{panelLabel(panel)}</strong></span>{panel === 'files' && <em>{props.snapshot.conversationFiles.length}</em>}</button>)}</div></section>
    : skillsOpen ? <section className="project-skills" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault();
      const file = event.dataTransfer.files[0];
      if (!file || !window.openlab) return;
      const path = window.openlab.pathForDroppedFile(file);
      if (path) void confirmInApp(copy.workspace.confirmInstallSkill(file.name), { title: copy.workspace.projectSkills }).then((confirmed) => confirmed ? run(() => props.installSkillSource(path)) : undefined);
    }}>
      <div className="project-skills__rule"><span/>{copy.workspace.skillsFollowWorkbench}<span/></div>
      {activeSkills.length === 0 ? <div className="project-skills__empty"><Zap size={30}/><strong>{copy.workspace.noProjectSkills}</strong><span>{copy.workspace.dropSkill}</span><button onClick={() => void run(props.installSkill)}><Upload size={13}/>{copy.workspace.selectSkill}</button></div>
        : <div className="project-skills__list">{activeSkills.map((skill) => <article key={skill.id} className={!skill.enabled ? 'needs-approval' : ''}><span><Zap size={15}/></span><div><strong>{skill.name}</strong><small>{skill.description}</small><code>SHA-256 · {skill.sha256?.slice(0, 16)}…</code></div>{skill.approvalRequired && skill.sha256 ? <button onClick={() => void run(async () => { if (await confirmInApp(copy.workspace.confirmSkillHash(skill.sha256!), { title: copy.workspace.approve })) await props.approveSkill(skill.id, skill.sha256!); })}><ShieldCheck size={13}/>{copy.workspace.approve}</button> : <em>{copy.workspace.enabled}</em>}</article>)}</div>}
    </section> : <>
      {activePanel === 'files' ? <section className="conversation-files">
{props.snapshot.conversationFiles.length === 0 ? <div className="conversation-files__empty"><Paperclip size={26}/><span>{copy.workspace.noConversationFiles}</span></div> : props.snapshot.conversationFiles.map((item) => <article key={item.id}><span className="workspace-entry-icon file">{fileIcon({ kind: 'file', name: item.name, mediaType: item.mediaType })}</span><div><strong>{item.name}</strong><small>{item.origin === 'agent' ? copy.workspace.agentGenerated : item.origin === 'artifact' ? copy.workspace.researchArtifact : item.origin === 'upload' ? copy.workspace.uploaded : copy.workspace.referenced} · {(item.size / 1024).toFixed(item.size > 1024 ? 0 : 1)} KB</small></div><button title={copy.workspace.preview} onClick={() => void run(async () => setPreview(await props.previewWorkspace(item.ref)))}><Eye size={13}/></button><button title={copy.workspace.referenceComposer} onClick={() => void run(() => reference(item.ref))}><Link2 size={13}/></button></article>)}
      </section> : <section className="workspace-browser">
        <div className="workspace-search"><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.workspace.search}/><button title={copy.workspace.filterType} aria-expanded={viewOptionsOpen} className={viewOptionsOpen || filter !== 'all' || showHidden || sort !== 'name' || order !== 'asc' ? 'is-active' : ''} onClick={() => setViewOptionsOpen((value) => !value)}><MoreHorizontal size={16}/></button>{viewOptionsOpen && <div className="workspace-view-options">
          <label>{copy.workspace.filterType}<select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">{copy.workspace.allFiles}</option><option value="text">{copy.workspace.textFiles}</option><option value="image">{copy.workspace.imageFiles}</option><option value="pdf">{copy.workspace.pdfFiles}</option></select></label>
          <button className={showHidden ? 'is-active' : ''} onClick={() => { setShowHidden((value) => !value); setEntries({}); }}><Filter size={14}/><span>{copy.workspace.showInternal}</span></button>
          <button onClick={() => setSort((value) => value === 'name' ? 'modified' : 'name')}>{sort === 'name' ? <ArrowDownAZ size={14}/> : <ArrowDownWideNarrow size={14}/>}<span>{copy.workspace.toggleSort}</span></button>
          <button className={order === 'desc' ? 'is-active' : ''} onClick={() => setOrder((value) => value === 'asc' ? 'desc' : 'asc')}><ChevronDown size={14}/><span>{copy.workspace.descending}</span></button>
        </div>}</div>
        <div className="workspace-file-toolbar"><button disabled={props.running || busy} title={copy.workspace.newFile} onClick={() => void run(async () => { const name = (await promptInApp(copy.workspace.newFileName, '', { title: copy.workspace.newFile }))?.trim(); if (name) await operate({ type: 'create_file', target: { rootId: selectedDirectory.rootId, path: joinPath(selectedDirectory.path, name) }, content: '' }); })}><Plus size={13}/><File size={13}/></button><button disabled={props.running || busy} title={copy.workspace.newFolder} onClick={() => void run(async () => { const name = (await promptInApp(copy.workspace.newFolderName, '', { title: copy.workspace.newFolder }))?.trim(); if (name) await operate({ type: 'create_directory', target: { rootId: selectedDirectory.rootId, path: joinPath(selectedDirectory.path, name) } }); })}><FolderPlus size={14}/></button><button disabled={props.running || busy || !window.openlab} title={copy.workspace.importFile} onClick={() => void run(async () => { const ids = await window.openlab!.importWorkspaceFiles(selectedDirectory); setLastChangeId(ids.at(-1)); await refreshSelected(); })}><Upload size={14}/></button><button title={copy.common.refresh} onClick={() => void run(refreshSelected)}><RefreshCw size={13}/></button><span>{selectedDirectory.path === '.' ? activeRoot?.name : selectedDirectory.path}</span></div>
        <div className="workspace-root-strip">{props.snapshot.workspace.roots.map((root) => <div key={root.id} className={root.id === props.snapshot.workspace.activeRootId ? 'is-active' : ''}><button disabled={props.running || root.status === 'offline'} onClick={() => root.status === 'pending_confirmation' ? void run(() => props.confirmWorkspaceRoot(root.id)) : void run(() => props.activateWorkspaceRoot(root.id))}><Folder size={14}/><span>{root.name}</span><small>{root.status === 'pending_confirmation' ? copy.workspace.pendingConfirmation : root.status === 'offline' ? copy.workspace.offline : root.access === 'read_only' ? copy.workspace.readOnly : copy.workspace.readWrite}</small></button>{root.kind === 'authorized' && <button disabled={props.running} title={copy.workspace.revokeAuthorization} onClick={() => void run(async () => { if (await confirmInApp(copy.workspace.confirmRevoke(root.name), { title: copy.workspace.revokeAuthorization, tone: 'danger' })) await props.revokeWorkspaceRoot(root.id); })}><X size={11}/></button>}</div>)}</div>
        <div className="workspace-tree">{query.trim() ? visibleSearch.map((result) => <div key={keyOf(result.entry)}>{renderEntry(result.entry, 0)}{result.matches?.map((match) => <small className="workspace-search-match" key={match.line}>L{match.line} · {match.preview}</small>)}</div>) : (entries[keyOf({ rootId: props.snapshot.workspace.activeRootId, path: '.' })] ?? []).map((entry) => renderEntry(entry, 0))}</div>
        {lastChangeId && <div className="workspace-undo"><span>{copy.workspace.fileOperationComplete}</span><button onClick={() => void run(async () => { await props.undoWorkspaceFile(lastChangeId); setLastChangeId(undefined); await refreshSelected(); })}><Undo2 size={12}/>{copy.workspace.undo}</button></div>}
      </section>}
    </>}

    {activePanel !== null && !skillsOpen && <section className={`workspace-note ${noteOpen ? 'is-open' : ''}`}>{noteOpen ? <><div className="workspace-note__heading"><strong>{copy.workspace.note}</strong></div><textarea maxLength={20_000} value={note} onChange={(event) => { noteDirty.current = true; noteRevision.current += 1; setNote(event.target.value); }} placeholder={copy.workspace.notePlaceholder}/><button className="workspace-note__toggle" aria-label={copy.workspace.collapseGoal} title={copy.workspace.collapseGoal} aria-expanded="true" onClick={toggleNote}><ChevronDown size={15}/></button></> : <button className="workspace-note__heading" aria-label={copy.workspace.expandGoal} title={copy.workspace.expandGoal} aria-expanded="false" onClick={toggleNote}><strong>{copy.workspace.note}</strong><ChevronDown size={15}/></button>}</section>}
    {activePanel !== null && !skillsOpen && <section className={`conversation-summary ${conversationOpen ? 'is-open' : ''}`}><header><strong>{copy.workspace.thisConversation}</strong><button disabled={props.running} title={copy.workspace.authorizeDirectory} className={authorizeOpen ? 'is-active' : ''} onClick={() => setAuthorizeOpen((value) => !value)}><FolderPlus size={14}/></button><button aria-label={conversationOpen ? copy.workspace.collapseConversation : copy.workspace.expandConversation} title={conversationOpen ? copy.workspace.collapseConversation : copy.workspace.expandConversation} aria-expanded={conversationOpen} onClick={() => setConversationOpen((value) => !value)}><ChevronDown size={14}/></button></header>{authorizeOpen && <div className="workspace-authorize-menu">{([
      ['read_only', copy.workspace.authorizeReadOnly, copy.workspace.authorizeReadOnlyHint],
      ['ask', copy.workspace.authorizeAsk, copy.workspace.authorizeAskHint],
      ['trusted', copy.workspace.authorizeTrusted, copy.workspace.authorizeTrustedHint],
    ] as const).map(([access, label, hint]) => <button key={access} onClick={() => void run(async () => { await props.authorizeWorkspaceRoot(access); setAuthorizeOpen(false); })}><ShieldCheck size={13}/><span><strong>{label}</strong><small>{hint}</small></span></button>)}</div>}{conversationOpen && <dl><dt>{copy.workspace.workDirectory}</dt><dd>{activeRoot?.name ?? copy.common.project}</dd><dt>{copy.workspace.authorizedDirectories}</dt><dd>{props.snapshot.workspace.roots.filter((root) => root.kind === 'authorized').length}</dd><dt>{copy.workspace.model}</dt><dd title={props.snapshot.workspace.model}>{props.snapshot.workspace.model.replace('deepseek-', '')}</dd><dt>{copy.workspace.files}</dt><dd>{props.snapshot.conversationFiles.length}</dd></dl>}</section>}

    {error && <div className="workspace-error"><CircleAlert size={13}/><span>{error}</span><button onClick={() => setError(undefined)}><X size={12}/></button></div>}
{preview && <div className="workspace-preview"><header><strong>{preview.name}</strong><span><button onClick={() => setPreview(undefined)}><X size={14}/></button></span></header><div>{preview.kind === 'image' && preview.dataUrl ? <img src={preview.dataUrl} alt={preview.name}/> : preview.kind === 'text' ? <pre>{preview.content}</pre> : <div className="workspace-preview__metadata"><File size={28}/><strong>{preview.mediaType ?? copy.workspace.binaryFile}</strong><span>{(preview.size / 1024).toFixed(1)} KB</span><button onClick={() => void window.openlab?.openWorkspacePath(preview.ref)}><FolderOpen size={13}/>{copy.workspace.openWithSystem}</button></div>}</div></div>}
  </aside>;
}
