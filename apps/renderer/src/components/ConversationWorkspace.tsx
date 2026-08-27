import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownWideNarrow, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Copy, Eye, File,
  FileArchive, FileCode2, FileImage, FileText, Filter, Folder, FolderInput, FolderOpen, FolderPlus, Link2,
  Globe2, Plus, ShieldCheck, SquareTerminal, Trash2, Undo2, Upload, X, Zap,
} from 'lucide-react';
import type {
  BootstrapSnapshot, BrowserProfileSummary, BrowserSessionSummary, ChatAttachmentRef, JsonValue, WorkspaceAccessMode, WorkspaceEntry,
  WorkspacePathRef, WorkspacePreview, WorkspaceSearchResult,
} from '@openlab/protocol';
import { hanaZhCN as copy } from '../i18n/zh-CN.js';
import { confirmInApp, promptInApp } from './AppDialog.js';
import { WorkspacePreviewDeck, type WorkspacePreviewTab } from './WorkspacePreviewDeck.js';

type FileOperation =
  | { type: 'create_file'; target: WorkspacePathRef; content?: string }
  | { type: 'create_directory'; target: WorkspacePathRef }
  | { type: 'rename' | 'move' | 'copy'; source: WorkspacePathRef; target: WorkspacePathRef }
  | { type: 'delete'; target: WorkspacePathRef };

type WorkspacePanel = 'skills' | 'workspace' | 'files';
type WorkspaceSurface = 'launcher' | 'content';
type WorkspaceFilter = 'all' | 'text' | 'image' | 'video';
type WorkspaceSort = 'modified' | 'name-asc' | 'name-desc' | 'size' | 'type';

interface ConversationWorkspaceProps {
  snapshot: BootstrapSnapshot;
  running: boolean;
  tab: 'files' | 'workspace';
  onTabChange(tab: 'files' | 'workspace'): void;
  mobileOpen?: boolean;
  focusWorkspaceToken?: number;
  focusWorkspacePanel?: 'files' | 'workspace';
  onCloseMobile?(): void;
  listWorkspace(ref: WorkspacePathRef, options?: { showHidden?: boolean; sort?: 'name' | 'modified'; order?: 'asc' | 'desc' }): Promise<WorkspaceEntry[]>;
  searchWorkspace(rootId: string, query: string, options?: { showHidden?: boolean; includeContent?: boolean }): Promise<WorkspaceSearchResult[]>;
  previewWorkspace(ref: WorkspacePathRef): Promise<WorkspacePreview>;
  createWorkspaceAttachment(ref: WorkspacePathRef): Promise<ChatAttachmentRef>;
  saveWorkspaceNote(note: string): Promise<void>;
  activateWorkspaceRoot(rootId: string): Promise<void>;
  confirmWorkspaceRoot(rootId: string): Promise<void>;
  revokeWorkspaceRoot(rootId: string): Promise<void>;
  authorizeWorkspaceRoot(access: WorkspaceAccessMode): Promise<unknown>;
  operateWorkspaceFile(operation: FileOperation, confirmed?: boolean): Promise<{ id: string }>;
  undoWorkspaceFile(id: string): Promise<void>;
  addConversationFile(ref: WorkspacePathRef, origin?: 'upload' | 'reference' | 'agent' | 'artifact'): Promise<void>;
  removeConversationFile(id: string): Promise<void>;
  installSkill(): Promise<void>;
  installSkillSource(sourcePath: string): Promise<void>;
  approveSkill(id: string, sha256: string): Promise<void>;
  onReferenceAttachment(attachment: ChatAttachmentRef): void;
  createBrowserProfile(name: string): Promise<BrowserProfileSummary | undefined>;
  openBrowserSession(input: { profileId: string; instanceId: string; paneId: string; surface?: 'worktable' | 'workspace_preview'; url?: string }): Promise<BrowserSessionSummary | undefined>;
  browserAction(sessionId: string, input: Record<string, unknown>): Promise<unknown>;
  setBrowserBounds(sessionId: string, bounds: { x: number; y: number; width: number; height: number }, visible: boolean): Promise<void>;
  hideAllBrowsers(): Promise<void>;
  closeBrowserSession(sessionId: string): Promise<void>;
  previewTerminalAction(terminalId: string, input: Record<string, unknown>): Promise<JsonValue | undefined>;
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

function filterEntry(entry: WorkspaceEntry, filter: WorkspaceFilter) {
  if (entry.kind === 'directory' || filter === 'all') return true;
  if (filter === 'image') return entry.mediaType?.startsWith('image/') === true;
  if (filter === 'video') return entry.mediaType?.startsWith('video/') === true || /\.(?:mp4|m4v|mov|avi|mkv|webm|wmv)$/iu.test(entry.name);
  return entry.mediaType?.startsWith('text/') === true || /\.(?:md|txt|csv|tsv|json|ya?ml|xml|tex|log|py|r|ts|tsx|js|jsx)$/iu.test(entry.name);
}

const entryNameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function entryType(entry: WorkspaceEntry): string {
  if (entry.kind === 'directory') return '';
  return entry.mediaType ?? entry.name.match(/\.([^./]+)$/u)?.[1]?.toLocaleLowerCase() ?? '';
}

function compareWorkspaceEntries(left: WorkspaceEntry, right: WorkspaceEntry, sort: WorkspaceSort): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
  const byName = entryNameCollator.compare(left.name, right.name);
  if (sort === 'name-asc') return byName;
  if (sort === 'name-desc') return -byName;
  if (sort === 'size') return left.size - right.size || byName;
  if (sort === 'type') return entryNameCollator.compare(entryType(left), entryType(right)) || byName;
  return right.modifiedAt.localeCompare(left.modifiedAt) || byName;
}

function sortWorkspaceEntries(entries: WorkspaceEntry[], sort: WorkspaceSort): WorkspaceEntry[] {
  return [...entries].sort((left, right) => compareWorkspaceEntries(left, right, sort));
}

function listSortOptions(sort: WorkspaceSort): { sort: 'name' | 'modified'; order: 'asc' | 'desc' } {
  if (sort === 'modified') return { sort: 'modified', order: 'desc' };
  if (sort === 'name-desc') return { sort: 'name', order: 'desc' };
  return { sort: 'name', order: 'asc' };
}

export function ConversationWorkspace(props: ConversationWorkspaceProps) {
  const [surface, setSurface] = useState<WorkspaceSurface>('launcher');
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<WorkspaceFilter>('all');
  const [sort, setSort] = useState<WorkspaceSort>('modified');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [entries, setEntries] = useState<Record<string, WorkspaceEntry[]>>({});
  const [searchResults, setSearchResults] = useState<WorkspaceSearchResult[]>([]);
  const [selectedDirectory, setSelectedDirectory] = useState<WorkspacePathRef>({ rootId: props.snapshot.workspace.activeRootId, path: '.' });
  const [selectedEntry, setSelectedEntry] = useState<WorkspacePathRef>({ rootId: props.snapshot.workspace.activeRootId, path: '.' });
  const [previewTabs, setPreviewTabs] = useState<WorkspacePreviewTab[]>([]);
  const [activePreviewId, setActivePreviewId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lastChangeId, setLastChangeId] = useState<string>();
  const [note, setNote] = useState(props.snapshot.workspace.note);
  const [noteOpen, setNoteOpen] = useState(() => {
    try { return sessionStorage.getItem(`openlab-workspace-journal:${props.snapshot.project.id}`) !== 'closed'; }
    catch { return true; }
  });
  const noteSession = useRef(props.snapshot.activeSessionId);
  const previewProject = useRef(props.snapshot.project.id);
  const lastFocusWorkspaceToken = useRef(props.focusWorkspaceToken);
  const panelWasOpen = useRef(Boolean(props.mobileOpen));
  const toolbar = useRef<HTMLDivElement>(null);
  const skillsTrigger = useRef<HTMLButtonElement>(null);
  const skillsPopover = useRef<HTMLElement>(null);
  const noteDirty = useRef(false);
  const noteRevision = useRef(0);
  const activeSkills = props.snapshot.skills.filter((skill) => skill.scope !== 'user' && (skill.rootId ?? 'project') === props.snapshot.workspace.activeRootId);

  useEffect(() => {
    if (!skillsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!skillsPopover.current?.contains(target) && !skillsTrigger.current?.contains(target)) setSkillsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSkillsOpen(false);
        skillsTrigger.current?.focus();
      }
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [skillsOpen]);

  const loadDirectory = useCallback(async (ref: WorkspacePathRef, force = false) => {
    const key = keyOf(ref);
    if (!force && entries[key]) return;
    const value = await props.listWorkspace(ref, { showHidden: false, ...listSortOptions(sort) });
    setEntries((current) => ({ ...current, [key]: sortWorkspaceEntries(value, sort) }));
  }, [entries, props.listWorkspace, sort]);

  useEffect(() => {
    let active = true;
    const rootRef = { rootId: props.snapshot.workspace.activeRootId, path: '.' };
    setSelectedDirectory(rootRef);
    setSelectedEntry(rootRef);
    setExpanded(new Set([keyOf(rootRef)]));
    setEntries({});
    setError(undefined);
    void props.listWorkspace(rootRef, { showHidden: false, ...listSortOptions(sort) })
      .then((value) => { if (active) setEntries({ [keyOf(rootRef)]: sortWorkspaceEntries(value, sort) }); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [props.listWorkspace, props.snapshot.project.id, props.snapshot.workspace.activeRootId, sort]);

  useEffect(() => {
    if (props.focusWorkspaceToken === undefined || props.focusWorkspaceToken === lastFocusWorkspaceToken.current) return;
    lastFocusWorkspaceToken.current = props.focusWorkspaceToken;
    setSurface('content');
    setSkillsOpen(false);
    props.onTabChange(props.focusWorkspacePanel ?? 'workspace');
  }, [props.focusWorkspacePanel, props.focusWorkspaceToken, props.onTabChange]);

  useEffect(() => {
    if (!props.mobileOpen && panelWasOpen.current) {
      setSurface('launcher');
      setSkillsOpen(false);
      void props.hideAllBrowsers();
      setFilterMenuOpen(false);
      setSortMenuOpen(false);
    }
    panelWasOpen.current = Boolean(props.mobileOpen);
  }, [props.hideAllBrowsers, props.mobileOpen]);

  useEffect(() => {
    if (!filterMenuOpen && !sortMenuOpen) return;
    const closeMenus = (event: PointerEvent) => {
      if (toolbar.current?.contains(event.target as Node)) return;
      setFilterMenuOpen(false);
      setSortMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenus);
    return () => document.removeEventListener('pointerdown', closeMenus);
  }, [filterMenuOpen, sortMenuOpen]);

  useEffect(() => {
    if (noteSession.current !== props.snapshot.activeSessionId) {
      noteSession.current = props.snapshot.activeSessionId;
      noteDirty.current = false;
      noteRevision.current = 0;
      setNote(props.snapshot.workspace.note);
      try { setNoteOpen(sessionStorage.getItem(`openlab-workspace-journal:${props.snapshot.project.id}`) !== 'closed'); }
      catch { setNoteOpen(true); }
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
    void props.searchWorkspace(props.snapshot.workspace.activeRootId, query, { showHidden: false }).then(setSearchResults).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [props, query]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(undefined);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const addFilePreviews = (values: WorkspacePreview[]) => {
    if (values.length === 0) return;
    const additions: WorkspacePreviewTab[] = values.map((value) => ({ id: `file:${keyOf(value.ref)}`, kind: 'file', preview: value }));
    setPreviewTabs((current) => {
      const next = [...current];
      for (const addition of additions) {
        const index = next.findIndex((tab) => tab.id === addition.id);
        if (index >= 0) next[index] = addition;
        else next.push(addition);
      }
      return next;
    });
    setActivePreviewId(additions.at(-1)!.id);
    setSurface('content');
    setSkillsOpen(false);
  };

  const openWorkspacePreview = async (ref: WorkspacePathRef) => addFilePreviews([await props.previewWorkspace(ref)]);

  const choosePreviewFiles = async () => {
    const files = await window.openlab?.chooseAttachments() ?? [];
    const values = await Promise.all(files.map((file) => props.previewWorkspace({ rootId: file.rootId ?? 'project', path: file.relativePath })));
    addFilePreviews(values);
  };

  const openBrowserPreview = async () => {
    const projectId = props.snapshot.project.id;
    const profile = props.snapshot.browserProfiles.find((candidate) => candidate.status === 'ready' && candidate.authorizedProjectIds.includes(projectId))
      ?? await props.createBrowserProfile(copy.workspace.previewBrowserProfile);
    if (!profile) throw new Error(copy.workspace.browserUnavailable);
    const paneId = `workspace-preview:${crypto.randomUUID()}`;
    const initialUrl = 'about:blank';
    const session = await props.openBrowserSession({ profileId: profile.id, instanceId: `workspace-preview:${props.snapshot.activeSessionId ?? projectId}`, paneId, surface: 'workspace_preview', url: initialUrl });
    if (!session) throw new Error(copy.workspace.browserUnavailable);
    const tab: WorkspacePreviewTab = { id: `browser:${session.id}`, kind: 'browser', sessionId: session.id, initialUrl };
    setPreviewTabs((current) => [...current, tab]);
    setActivePreviewId(tab.id);
    setSurface('content');
    setSkillsOpen(false);
  };

  const openTerminalPreview = () => {
    const terminalId = crypto.randomUUID();
    const root = props.snapshot.workspace.roots.find((candidate) => candidate.id === props.snapshot.workspace.activeRootId);
    const tab: WorkspacePreviewTab = { id: `terminal:${terminalId}`, kind: 'terminal', terminalId, title: root?.displayPath ?? root?.name ?? copy.workspace.previewPanel.terminal };
    setPreviewTabs((current) => [...current, tab]);
    setActivePreviewId(tab.id);
    setSurface('content');
    setSkillsOpen(false);
  };

  const closePreviewTab = async (id: string) => {
    const index = previewTabs.findIndex((tab) => tab.id === id);
    const target = previewTabs[index];
    const remaining = previewTabs.filter((tab) => tab.id !== id);
    const fallback = remaining[Math.min(index, Math.max(0, remaining.length - 1))];
    setPreviewTabs(remaining);
    if (activePreviewId === id) setActivePreviewId(fallback?.id ?? '');
    if (target?.kind === 'browser') await props.closeBrowserSession(target.sessionId);
    if (target?.kind === 'terminal') await props.previewTerminalAction(target.terminalId, { action: 'close' }).catch(() => undefined);
    if (remaining.length === 0) await props.hideAllBrowsers();
  };

  useEffect(() => {
    if (previewProject.current === props.snapshot.project.id) return;
    const staleBrowserSessions = previewTabs.filter((tab): tab is Extract<WorkspacePreviewTab, { kind: 'browser' }> => tab.kind === 'browser').map((tab) => tab.sessionId);
    const staleTerminalSessions = previewTabs.filter((tab): tab is Extract<WorkspacePreviewTab, { kind: 'terminal' }> => tab.kind === 'terminal').map((tab) => tab.terminalId);
    previewProject.current = props.snapshot.project.id;
    setPreviewTabs([]);
    setActivePreviewId('');
    void props.hideAllBrowsers();
    for (const sessionId of staleBrowserSessions) void props.closeBrowserSession(sessionId);
    for (const terminalId of staleTerminalSessions) void props.previewTerminalAction(terminalId, { action: 'close' });
  }, [props.closeBrowserSession, props.hideAllBrowsers, props.previewTerminalAction, props.snapshot.project.id, previewTabs]);

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
      <div className={`workspace-tree__row ${selectedEntry.rootId === entry.rootId && selectedEntry.path === entry.path ? 'is-selected' : ''}`} style={{ '--tree-depth': depth } as React.CSSProperties}>
        <button className="workspace-tree__main" onClick={() => void run(async () => {
          setSelectedEntry(ref);
          if (entry.kind === 'directory') {
            setSelectedDirectory(ref);
            setExpanded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
            if (!isExpanded) await loadDirectory(ref);
          } else await openWorkspacePreview(ref);
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

  const visibleSearch = useMemo(() => [...searchResults]
    .filter((result) => filterEntry(result.entry, filter))
    .sort((left, right) => compareWorkspaceEntries(left.entry, right.entry, sort)), [filter, searchResults, sort]);

  const choosePanel = (panel: WorkspacePanel) => {
    setSurface('content');
    setSkillsOpen(panel === 'skills');
    setFilterMenuOpen(false);
    setSortMenuOpen(false);
    if (panel === 'files' || panel === 'workspace') props.onTabChange(panel);
  };
  const returnToLauncher = () => {
    setSurface('launcher');
    setSkillsOpen(false);
    void props.hideAllBrowsers();
    setFilterMenuOpen(false);
    setSortMenuOpen(false);
  };
  const panelIcon = (panel: WorkspacePanel, size = 17) => panel === 'skills'
    ? <Zap size={size}/>
    : panel === 'workspace'
      ? <FolderOpen size={size}/>
      : <FileText size={size}/>;
  const panelLabel = (panel: WorkspacePanel) => panel === 'skills'
    ? copy.workspace.projectSkills
    : panel === 'workspace'
      ? copy.workspace.workspace
      : copy.workspace.conversationFiles;
  const filterLabels: Record<Exclude<WorkspaceFilter, 'all'>, string> = {
    image: copy.workspace.imageFiles,
    text: copy.workspace.textFiles,
    video: copy.workspace.videoFiles,
  };
  const sortLabels: Record<WorkspaceSort, string> = {
    modified: copy.workspace.sortModified,
    'name-asc': copy.workspace.sortNameAsc,
    'name-desc': copy.workspace.sortNameDesc,
    size: copy.workspace.sortSize,
    type: copy.workspace.sortType,
  };
  const sortTriggerLabels: Record<WorkspaceSort, string> = {
    modified: copy.workspace.time,
    'name-asc': copy.workspace.name,
    'name-desc': copy.workspace.name,
    size: copy.workspace.size,
    type: copy.workspace.type,
  };
  const toggleNote = () => {
    const next = !noteOpen;
    setNoteOpen(next);
    try { sessionStorage.setItem(`openlab-workspace-journal:${props.snapshot.project.id}`, next ? 'open' : 'closed'); }
    catch { /* Journal visibility persistence is optional. */ }
  };

  return <aside id="conversation-workspace" className={`conversation-workspace ${props.mobileOpen ? 'is-mobile-open is-panel-open' : 'is-panel-closed'}`} aria-hidden={!props.mobileOpen} inert={!props.mobileOpen ? true : undefined}>
    {surface === 'launcher' ? <section className="workspace-panel-launcher" data-testid="workspace-panel-launcher">
      <div className="workspace-panel-launcher__options">
        <button onClick={() => choosePanel('skills')}><span><Zap size={16}/><strong>{copy.workspace.projectSkills}</strong></span></button>
        <button onClick={openTerminalPreview}><span><SquareTerminal size={16}/><strong>{copy.workspace.previewPanel.terminal}</strong></span></button>
        <button onClick={() => void run(openBrowserPreview)}><span><Globe2 size={16}/><strong>{copy.workspace.previewPanel.browser}</strong></span></button>
        <button data-testid="workspace-panel-option-workspace" onClick={() => choosePanel('workspace')}><span>{panelIcon('workspace')}<strong>{panelLabel('workspace')}</strong></span></button>
        <button onClick={() => choosePanel('files')}><span>{panelIcon('files')}<strong>{panelLabel('files')}</strong></span></button>
      </div>
    </section> : <>
    <header className="conversation-workspace__header">
      <button className="hana-workspace-identity" aria-label={copy.workspace.backToLauncher} title={copy.workspace.backToLauncher} onClick={returnToLauncher}><ChevronLeft size={16}/><strong>{copy.workspace.workspace}</strong></button>
      <div className="conversation-workspace__actions">
        <button className="workspace-preview-launcher" title={copy.workspace.selectPreviewFile} aria-label={copy.workspace.selectPreviewFile} onClick={() => void run(choosePreviewFiles)}><Plus size={14}/></button>
        <button className="workspace-preview-launcher" title={copy.workspace.newBrowser} aria-label={copy.workspace.newBrowser} onClick={() => void run(openBrowserPreview)}><Globe2 size={14}/></button>
        <button className="workspace-preview-launcher" title={copy.workspace.previewPanel.terminal} aria-label={copy.workspace.previewPanel.terminal} onClick={openTerminalPreview}><SquareTerminal size={14}/></button>
        <button ref={skillsTrigger} className={`workspace-skills-trigger ${skillsOpen ? 'is-active' : ''}`} data-testid="workspace-skills-trigger" aria-haspopup="dialog" aria-expanded={skillsOpen} aria-pressed={skillsOpen} onClick={() => setSkillsOpen((value) => !value)}><Zap size={14}/><span>{copy.workspace.projectSkills}</span></button>
      </div>
    </header>

    <nav className="hana-workspace-tabs" role="tablist" aria-label={copy.workspace.choosePanel}>
      <button role="tab" data-testid="workspace-tab-files" aria-selected={props.tab === 'files'} className={props.tab === 'files' ? 'is-active' : ''} onClick={() => { setSkillsOpen(false); props.onTabChange('files'); }}><span>{copy.workspace.conversationFiles}</span></button>
      <button role="tab" data-testid="workspace-tab-workspace" aria-selected={props.tab === 'workspace'} className={props.tab === 'workspace' ? 'is-active' : ''} onClick={() => { setSkillsOpen(false); props.onTabChange('workspace'); }}><span>{copy.workspace.workbench}</span></button>
    </nav>

    {skillsOpen && <section ref={skillsPopover} className="workspace-skills-popover" data-testid="project-skills-panel" role="dialog" aria-label={copy.workspace.projectSkills} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault();
      const file = event.dataTransfer.files[0];
      if (!file || !window.openlab) return;
      const path = window.openlab.pathForDroppedFile(file);
      if (path) void confirmInApp(copy.workspace.confirmInstallSkill(file.name), { title: copy.workspace.projectSkills }).then((confirmed) => confirmed ? run(() => props.installSkillSource(path)) : undefined);
    }}>
      <header><span><Zap size={14}/><strong>{copy.workspace.projectSkills}</strong></span><button aria-label={copy.common.close} onClick={() => { setSkillsOpen(false); skillsTrigger.current?.focus(); }}><X size={14}/></button></header>
      <div className="project-skills">
        <div className="project-skills__rule"><span/>{copy.workspace.skillsFollowWorkbench}<span/></div>
        {activeSkills.length === 0 ? <div className="project-skills__empty"><Zap size={30}/><strong>{copy.workspace.noProjectSkills}</strong><span>{copy.workspace.dropSkill}</span><button onClick={() => void run(props.installSkill)}><Upload size={13}/>{copy.workspace.selectSkill}</button></div>
          : <div className="project-skills__list">{activeSkills.map((skill) => <article key={skill.id} className={!skill.enabled ? 'needs-approval' : ''}><span><Zap size={15}/></span><div><strong>{skill.name}</strong><small>{skill.description}</small><code>SHA-256 · {skill.sha256?.slice(0, 16)}…</code></div>{skill.approvalRequired && skill.sha256 ? <button onClick={() => void run(async () => { if (await confirmInApp(copy.workspace.confirmSkillHash(skill.sha256!), { title: copy.workspace.approve })) await props.approveSkill(skill.id, skill.sha256!); })}><ShieldCheck size={13}/>{copy.workspace.approve}</button> : <em>{copy.workspace.enabled}</em>}</article>)}</div>}
      </div>
    </section>}

    {props.tab === 'files' ? <section className="conversation-files" data-testid="conversation-files-panel">
      {props.snapshot.conversationFiles.length === 0 ? <div className="conversation-files__empty"><span>{copy.workspace.noConversationFiles}</span></div> : <div className="conversation-files__list">
        {props.snapshot.conversationFiles.map((item) => <article key={item.id}><span className="workspace-entry-icon file">{fileIcon({ kind: 'file', name: item.name, mediaType: item.mediaType })}</span><div><strong title={item.name}>{item.name}</strong><small>{item.origin === 'agent' ? copy.workspace.agentGenerated : item.origin === 'artifact' ? copy.workspace.researchArtifact : item.origin === 'upload' ? copy.workspace.uploaded : copy.workspace.referenced} · {(item.size / 1024).toFixed(item.size > 1024 ? 0 : 1)} KB</small></div><button title={copy.workspace.preview} onClick={() => void run(() => openWorkspacePreview(item.ref))}><Eye size={13}/></button><button title={copy.workspace.referenceComposer} onClick={() => void run(() => reference(item.ref))}><Link2 size={13}/></button><button title={copy.workspace.removeConversationFile} onClick={() => void run(async () => {
          await props.removeConversationFile(item.id);
        })}><X size={13}/></button></article>)}
      </div>}
    </section> : <section className="workspace-browser" data-testid="workspace-browser-panel">
        <div className="workspace-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.workspace.search}/></div>
        <div className="workspace-file-toolbar" ref={toolbar}>
          <span className="workspace-file-toolbar__spacer"/>
          <button disabled={props.running || busy} title={copy.workspace.newFile} onClick={() => void run(async () => { const name = (await promptInApp(copy.workspace.newFileName, '', { title: copy.workspace.newFile }))?.trim(); if (name) await operate({ type: 'create_file', target: { rootId: selectedDirectory.rootId, path: joinPath(selectedDirectory.path, name) }, content: '' }); })}><FileText size={14}/></button>
          <button disabled={props.running || busy} title={copy.workspace.newFolder} onClick={() => void run(async () => { const name = (await promptInApp(copy.workspace.newFolderName, '', { title: copy.workspace.newFolder }))?.trim(); if (name) await operate({ type: 'create_directory', target: { rootId: selectedDirectory.rootId, path: joinPath(selectedDirectory.path, name) } }); })}><FolderPlus size={14}/></button>
          <button data-testid="workspace-filter-trigger" className={`workspace-toolbar-label ${filterMenuOpen || filter !== 'all' ? 'is-active' : ''}`} title={copy.workspace.filterType} aria-expanded={filterMenuOpen} onClick={() => { setFilterMenuOpen((value) => !value); setSortMenuOpen(false); }}><Filter size={14}/><span>{filter === 'all' ? copy.workspace.filter : filterLabels[filter]}</span></button>
          <button data-testid="workspace-sort-trigger" className={`workspace-toolbar-label ${sortMenuOpen || sort !== 'modified' ? 'is-active' : ''}`} title={copy.workspace.toggleSort} aria-expanded={sortMenuOpen} onClick={() => { setSortMenuOpen((value) => !value); setFilterMenuOpen(false); }}><ArrowDownWideNarrow size={14}/><span>{sortTriggerLabels[sort]}</span></button>
          {filterMenuOpen && <div className="workspace-toolbar-menu workspace-toolbar-menu--filter" data-testid="workspace-filter-menu" role="menu">
            {(['image', 'text', 'video'] as const).map((value) => <button key={value} role="menuitemradio" aria-checked={filter === value} className={filter === value ? 'is-active' : ''} onClick={() => { setFilter(value); setFilterMenuOpen(false); }}><span>{filterLabels[value]}</span>{filter === value && <Check size={13}/>}</button>)}
            {filter !== 'all' && <><span className="workspace-toolbar-menu__rule"/><button role="menuitem" onClick={() => { setFilter('all'); setFilterMenuOpen(false); }}><span>{copy.workspace.clearFilter}</span></button></>}
          </div>}
          {sortMenuOpen && <div className="workspace-toolbar-menu workspace-toolbar-menu--sort" data-testid="workspace-sort-menu" role="menu">
            {(['modified', 'name-asc', 'name-desc', 'size', 'type'] as const).map((value) => <button key={value} role="menuitemradio" aria-checked={sort === value} className={sort === value ? 'is-active' : ''} onClick={() => { setSort(value); setSortMenuOpen(false); }}><span className="workspace-toolbar-menu__dot" aria-hidden="true"/><span>{sortLabels[value]}</span></button>)}
          </div>}
        </div>
        <div className="workspace-tree">{query.trim() ? visibleSearch.map((result) => <div key={keyOf(result.entry)}>{renderEntry(result.entry, 0)}{result.matches?.map((match) => <small className="workspace-search-match" key={match.line}>L{match.line} · {match.preview}</small>)}</div>) : props.snapshot.workspace.roots.map((root) => {
          const rootRef = { rootId: root.id, path: '.' };
          const rootKey = keyOf(rootRef);
          const isExpanded = expanded.has(rootKey);
          return <div className="workspace-tree__branch workspace-tree__root" key={root.id}>
            <div className={`workspace-tree__row ${selectedEntry.rootId === root.id && selectedEntry.path === '.' ? 'is-selected' : ''}`} style={{ '--tree-depth': 0 } as React.CSSProperties}>
              <button className="workspace-tree__main" disabled={props.running || root.status === 'offline'} title={root.displayPath} onClick={() => void run(async () => {
                if (root.status === 'pending_confirmation') await props.confirmWorkspaceRoot(root.id);
                else if (root.id !== props.snapshot.workspace.activeRootId) await props.activateWorkspaceRoot(root.id);
                setSelectedDirectory(rootRef);
                setSelectedEntry(rootRef);
                setExpanded((current) => { const next = new Set(current); if (next.has(rootKey)) next.delete(rootKey); else next.add(rootKey); return next; });
                if (!isExpanded) await loadDirectory(rootRef);
              })}>{isExpanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<span className="workspace-entry-icon directory"><Folder size={15}/></span><span>{root.name}</span></button>
              <span className="workspace-tree__actions"><button title={copy.workspace.openSystem} onClick={() => void window.openlab?.openWorkspacePath(rootRef)}><FolderOpen size={12}/></button>{root.kind === 'authorized' && <button disabled={props.running} title={copy.workspace.revokeAuthorization} onClick={() => void run(async () => { if (await confirmInApp(copy.workspace.confirmRevoke(root.name), { title: copy.workspace.revokeAuthorization, tone: 'danger' })) await props.revokeWorkspaceRoot(root.id); })}><X size={11}/></button>}</span>
            </div>
            {isExpanded && <div>{(entries[rootKey] ?? []).map((entry) => renderEntry(entry, 1))}</div>}
          </div>;
        })}</div>
        {lastChangeId && <div className="workspace-undo"><span>{copy.workspace.fileOperationComplete}</span><button onClick={() => void run(async () => { await props.undoWorkspaceFile(lastChangeId); setLastChangeId(undefined); await refreshSelected(); })}><Undo2 size={12}/>{copy.workspace.undo}</button></div>}
      </section>}

    <section className={`workspace-note ${noteOpen ? 'is-open' : ''}`} data-testid="workspace-note">
      <div className="workspace-note__heading"><strong>{copy.workspace.note}</strong></div>
      {noteOpen && <textarea aria-label={copy.workspace.note} maxLength={20_000} value={note} onChange={(event) => { noteDirty.current = true; noteRevision.current += 1; setNote(event.target.value); }} placeholder={copy.workspace.notePlaceholder}/>}
      <button className="workspace-note__toggle" aria-label={noteOpen ? copy.workspace.collapseGoal : copy.workspace.expandGoal} title={noteOpen ? copy.workspace.collapseGoal : copy.workspace.expandGoal} aria-expanded={noteOpen} onClick={toggleNote}><ChevronDown size={14}/></button>
    </section>

    {error && <div className="workspace-error"><CircleAlert size={13}/><span>{error}</span><button onClick={() => setError(undefined)}><X size={12}/></button></div>}
    {previewTabs.length > 0 && <WorkspacePreviewDeck
      tabs={previewTabs}
      activeId={activePreviewId || previewTabs[0]!.id}
      browserSessions={props.snapshot.browserSessions}
      onActivate={setActivePreviewId}
      onClose={(id) => void closePreviewTab(id)}
      onAddFile={() => void run(choosePreviewFiles)}
      onAddBrowser={() => void run(openBrowserPreview)}
      onAddTerminal={openTerminalPreview}
      onNavigateBrowser={async (sessionId, url) => { await props.browserAction(sessionId, { action: 'open', url, confirmed: true }); }}
      onBrowserHistory={async (sessionId, action) => { await props.browserAction(sessionId, { action }); }}
      onSetBrowserBounds={props.setBrowserBounds}
      onHideBrowsers={props.hideAllBrowsers}
      onTerminalAction={props.previewTerminalAction}
      onOpenSystem={(value) => { void window.openlab?.openWorkspacePath(value.ref); }}
    />}
    </>}
  </aside>;
}
