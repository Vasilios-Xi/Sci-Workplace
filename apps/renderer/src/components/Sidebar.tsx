import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArchiveRestore, CheckCheck, ChevronDown, ChevronRight, CirclePlus, Folder, FolderMinus,
  FolderOpen, FolderPlus, LayoutDashboard, Pencil, Pin, PinOff, Search, Settings2, SquarePen, UsersRound,
} from 'lucide-react';
import type { AgentDefinition, AppMode, ConversationSourceDescriptor, PrimaryAgentProfile, ProjectSummary, SessionSummary } from '@openlab/protocol';
import { agentV3ZhCN as v3Copy, chatShellZhCN as shellCopy, t, zhCN } from '../i18n/zh-CN.js';
import { confirmInApp, promptInApp } from './AppDialog.js';
import { groupSessionsByConversationSource, relativeSessionTime, sessionDisplayTitle, sessionHasUnread, sessionListMetadata, sessionProjectDisplayName, sortSessionsForSidebar } from '../lib/session-list.js';
import type { SessionListPreferencesV1 } from '../lib/session-list.js';
import { AgentAvatar } from './AgentAvatar.js';

interface SidebarProps {
  open: boolean;
  project: ProjectSummary;
  primaryAgent: PrimaryAgentProfile;
  agentDefinitions: AgentDefinition[];
  activeLeadAgentId?: string;
  sessions: SessionSummary[];
  conversationSources: ConversationSourceDescriptor[];
  activeSessionId: string;
  sessionPreferences: SessionListPreferencesV1;
  onNewSession(): void;
  onSwitchSession(id: string): void;
  onTogglePin(id: string): void;
  onRenameSession(id: string, title: string): void;
  onArchiveSession(id: string): void;
  onUnarchiveSession(id: string): void;
  onModeChange(mode: AppMode): void;
  onSettings(): void;
  projectFolderAvailable: boolean;
  onToggleProjectPin(id: string): void;
  onMarkProjectRead(id: string): void;
  onRenameProject(source: ConversationSourceDescriptor & { kind: 'project' }, name: string): Promise<void>;
  onManageProjectFolders(source: ConversationSourceDescriptor & { kind: 'project' }): void;
  onArchiveProjectConversations(source: ConversationSourceDescriptor & { kind: 'project' }): Promise<void>;
  onRemoveProject(source: ConversationSourceDescriptor & { kind: 'project' }): Promise<void>;
  userName: string;
  userAvatar?: string;
}

interface SessionContextMenuState {
  session: SessionSummary;
  x: number;
  y: number;
  summary: boolean;
  source: HTMLButtonElement | null;
}

interface ProjectContextMenuState {
  project: ConversationSourceDescriptor & { kind: 'project' };
  sessions: SessionSummary[];
  x: number;
  y: number;
  source: HTMLButtonElement | null;
}

export function Sidebar(props: SidebarProps) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null);
  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  const [projectExpanded, setProjectExpanded] = useState(true);
  const [recentExpanded, setRecentExpanded] = useState(true);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const profileAreaRef = useRef<HTMLDivElement>(null);
  const profileTriggerRef = useRef<HTMLButtonElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const projectContextMenuRef = useRef<HTMLDivElement>(null);
  const visibleSessions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return sortSessionsForSidebar(props.sessions.filter((session) => (
      session.status !== 'archived' || Boolean(normalized)
    ) && (!normalized || sessionDisplayTitle(session, props.sessionPreferences).toLocaleLowerCase('zh-CN').includes(normalized))), props.sessionPreferences);
  }, [props.sessionPreferences, props.sessions, query]);
  const pinnedIds = useMemo(() => new Set(props.sessionPreferences.pinnedSessionIds), [props.sessionPreferences.pinnedSessionIds]);
  const normalizedSources = useMemo(() => {
    if (!props.projectFolderAvailable || props.conversationSources.some((source) => source.projectId === props.project.id)) return props.conversationSources;
    return [...props.conversationSources, { kind: 'project' as const, projectId: props.project.id, rootPath: props.project.rootPath, name: props.project.name }];
  }, [props.conversationSources, props.project, props.projectFolderAvailable]);
  const sourceByProjectId = useMemo(() => new Map(normalizedSources.map((source) => [source.projectId, source])), [normalizedSources]);
  const groupedSessions = useMemo(() => groupSessionsByConversationSource(visibleSessions, props.sessionPreferences, normalizedSources), [normalizedSources, props.sessionPreferences, visibleSessions]);
  const pinnedSessions = groupedSessions.pinned;
  const pinnedProjectGroups = groupedSessions.pinnedProjects;
  const projectGroups = groupedSessions.projects;
  const recentSessions = groupedSessions.recent;
  const sourceLabel = (session: SessionSummary) => {
    const source = sourceByProjectId.get(session.projectId);
    return source?.kind === 'project' ? sessionProjectDisplayName(source) : undefined;
  };
  const userName = props.userName.trim() || shellCopy.sidebar.defaultUserName;
  const userInitial = [...userName][0]?.toLocaleUpperCase('zh-CN') ?? [...shellCopy.sidebar.defaultUserName][0];
  const userAvatar = props.userAvatar && /^data:image\/(?:png|jpeg|webp);base64,/u.test(props.userAvatar) ? props.userAvatar : undefined;
  const renderUserAvatar = () => <span className="sidebar-profile-avatar">{userAvatar ? <img src={userAvatar} alt="" draggable={false}/> : userInitial}</span>;
  const agentForSession = (session: SessionSummary) => props.agentDefinitions.find((agent) => agent.id === (
    session.leadAgentId || (session.id === props.activeSessionId ? props.activeLeadAgentId : undefined)
  ));

  useEffect(() => {
    if (!profileOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!profileAreaRef.current?.contains(event.target as Node)) setProfileOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setProfileOpen(false);
      profileTriggerRef.current?.focus();
    };
    window.addEventListener('pointerdown', closeOnOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [profileOpen]);

  useEffect(() => {
    const togglePinnedSummary = () => setPinnedExpanded((value) => !value);
    window.addEventListener('sci-workplace:toggle-pinned-summary', togglePinnedSummary);
    return () => window.removeEventListener('sci-workplace:toggle-pinned-summary', togglePinnedSummary);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const frame = window.requestAnimationFrame(() => contextMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
    const closeOnOutside = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setContextMenu(null);
      window.requestAnimationFrame(() => contextMenu.source?.focus());
    };
    const closeOnResize = () => setContextMenu(null);
    document.addEventListener('pointerdown', closeOnOutside);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnResize);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', closeOnOutside);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnResize);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!projectContextMenu) return;
    const frame = window.requestAnimationFrame(() => projectContextMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
    const closeOnOutside = (event: PointerEvent) => {
      if (projectContextMenuRef.current?.contains(event.target as Node)) return;
      setProjectContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setProjectContextMenu(null);
      window.requestAnimationFrame(() => projectContextMenu.source?.focus());
    };
    const closeOnResize = () => setProjectContextMenu(null);
    document.addEventListener('pointerdown', closeOnOutside);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnResize);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', closeOnOutside);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnResize);
    };
  }, [projectContextMenu]);

  const runProfileAction = (action: () => void) => {
    setProfileOpen(false);
    action();
  };

  const openSessionMenu = (session: SessionSummary, source: HTMLButtonElement, x: number, y: number) => {
    setProfileOpen(false);
    setProjectContextMenu(null);
    setContextMenu({ session, source, x, y, summary: false });
  };

  const openProjectMenu = (project: ConversationSourceDescriptor & { kind: 'project' }, source: HTMLButtonElement, x: number, y: number) => {
    setProfileOpen(false);
    setContextMenu(null);
    setProjectContextMenu({ project, sessions: props.sessions.filter((session) => session.projectId === project.projectId), source, x, y });
  };

  const renameSession = async (session: SessionSummary) => {
    setContextMenu(null);
    const currentTitle = sessionDisplayTitle(session, props.sessionPreferences);
    const next = await promptInApp(shellCopy.sidebar.renamePrompt, currentTitle, { title: shellCopy.sidebar.rename, confirmLabel: shellCopy.sidebar.saveName });
    if (next?.trim()) props.onRenameSession(session.id, next.trim());
  };

  const renderSessionItems = (sessions: SessionSummary[], scopeLabel?: string | ((session: SessionSummary) => string | undefined)) => sessions.map((session) => {
    const title = sessionDisplayTitle(session, props.sessionPreferences);
    const pinned = pinnedIds.has(session.id);
    const archived = session.status === 'archived';
    const agent = agentForSession(session);
    const unread = sessionHasUnread(session, props.activeSessionId, props.sessionPreferences);
    return <div
      key={session.id}
      className={`session-item ${session.id === props.activeSessionId ? 'is-active' : ''} ${pinned ? 'is-pinned' : ''}`}
      data-session-id={session.id}
      onContextMenu={(event) => {
        event.preventDefault();
        const source = event.currentTarget.querySelector<HTMLButtonElement>('.session-item__main');
        if (source) openSessionMenu(session, source, event.clientX, event.clientY);
      }}
    >
      <button className="session-item__main" title={title} onClick={() => archived ? props.onUnarchiveSession(session.id) : props.onSwitchSession(session.id)} onKeyDown={(event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        openSessionMenu(session, event.currentTarget, bounds.left + 22, bounds.bottom - 4);
      }}>
        <AgentAvatar avatar={agent?.avatar ?? props.primaryAgent.avatar} size="tiny"/>
        <span className="session-item__copy"><strong>{title}</strong><small>{sessionListMetadata(agent?.name ?? props.primaryAgent.name, typeof scopeLabel === 'function' ? scopeLabel(session) : scopeLabel, relativeSessionTime(session.updatedAt))}</small></span>
        {unread && <span className="session-item__unread" data-testid={`session-unread-${session.id}`} title={shellCopy.sidebar.unread} aria-label={shellCopy.sidebar.unread}/>}
      </button>
      <span className="session-item__actions">
        {!archived && <button data-testid={`session-pin-${session.id}`} className={`session-item__pin ${pinned ? 'is-active' : ''}`} title={pinned ? shellCopy.sidebar.unpin : shellCopy.sidebar.pin} aria-label={`${pinned ? shellCopy.sidebar.unpin : shellCopy.sidebar.pin} ${title}`} aria-pressed={pinned} onClick={() => props.onTogglePin(session.id)}>{pinned ? <PinOff size={11}/> : <Pin size={11}/>}</button>}
        <button data-testid={`session-archive-${session.id}`} className="session-item__archive" title={archived ? t('copy205') : t('copy206')} aria-label={`${archived ? t('copy207') : t('copy208')} ${title}`} onClick={() => archived ? props.onUnarchiveSession(session.id) : props.onArchiveSession(session.id)}>{archived ? <ArchiveRestore size={11}/> : <Archive size={11}/>}</button>
      </span>
    </div>;
  });

  const toggleProjectExpanded = (projectId: string) => setCollapsedProjectIds((current) => {
    const next = new Set(current);
    if (next.has(projectId)) next.delete(projectId);
    else next.add(projectId);
    return next;
  });

  const renderProjectGroups = (groups: typeof projectGroups) => groups.map(({ source, sessions }) => {
    const expanded = !collapsedProjectIds.has(source.projectId);
    return <div className="sidebar-project-entry" key={source.projectId}>
      <button
        data-testid={source.projectId === props.project.id ? 'sidebar-project-row' : `sidebar-project-row-${source.projectId}`}
        className="sidebar-project-row"
        title={expanded ? shellCopy.sidebar.collapseProject : shellCopy.sidebar.expandProject}
        aria-expanded={expanded}
        onClick={() => toggleProjectExpanded(source.projectId)}
        onContextMenu={(event) => {
          event.preventDefault();
          openProjectMenu(source, event.currentTarget, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          openProjectMenu(source, event.currentTarget, bounds.left + 24, bounds.bottom - 2);
        }}
      >{expanded ? <FolderOpen size={17}/> : <Folder size={17}/>}<strong>{source.name}</strong></button>
      <div className={`sidebar-project-session-body ${expanded ? 'is-open' : 'is-closed'}`} aria-hidden={!expanded} inert={!expanded ? true : undefined}>
        <div className="sidebar-project-sessions">{renderSessionItems(sessions, sessionProjectDisplayName(source))}</div>
      </div>
    </div>;
  });

  const contextMenuPortal = contextMenu ? createPortal(<div
    ref={contextMenuRef}
    className="session-context-menu"
    data-testid="session-context-menu"
    role={contextMenu.summary ? 'dialog' : 'menu'}
    aria-label={contextMenu.summary ? shellCopy.sidebar.summary : shellCopy.sidebar.sessionActions}
    style={{
      left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - (contextMenu.summary ? 238 : 202))),
      top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - (contextMenu.summary ? 238 : 230))),
    }}
  >{contextMenu.summary ? <div className="session-context-summary">
      <strong>{sessionDisplayTitle(contextMenu.session, props.sessionPreferences)}</strong>
      <span><b>{shellCopy.sidebar.agent}</b>{agentForSession(contextMenu.session)?.name ?? props.primaryAgent.name}</span>
      <span><b>{shellCopy.sidebar.updated}</b>{relativeSessionTime(contextMenu.session.updatedAt)}</span>
      <span><b>{shellCopy.sidebar.model}</b>{contextMenu.session.model || '—'}</span>
      <code>{contextMenu.session.id}</code>
      <button autoFocus onClick={() => setContextMenu((current) => current ? { ...current, summary: false } : null)}>{shellCopy.sidebar.back}</button>
    </div> : <>
      <button role="menuitem" onClick={() => setContextMenu((current) => current ? { ...current, summary: true } : null)}>{shellCopy.sidebar.summary}</button>
      <button role="menuitem" onClick={() => { void navigator.clipboard.writeText(contextMenu.session.id); setContextMenu(null); }}>{shellCopy.sidebar.copySessionId}</button>
      {contextMenu.session.status !== 'archived' && <button role="menuitem" onClick={() => { props.onTogglePin(contextMenu.session.id); setContextMenu(null); }}>{props.sessionPreferences.pinnedSessionIds.includes(contextMenu.session.id) ? shellCopy.sidebar.unpin : shellCopy.sidebar.pin}</button>}
      <button role="menuitem" onClick={() => void renameSession(contextMenu.session)}>{shellCopy.sidebar.rename}</button>
      <span className="session-context-menu__separator"/>
      <button role="menuitem" className={contextMenu.session.status === 'archived' ? '' : 'is-danger'} onClick={() => { contextMenu.session.status === 'archived' ? props.onUnarchiveSession(contextMenu.session.id) : props.onArchiveSession(contextMenu.session.id); setContextMenu(null); }}>{contextMenu.session.status === 'archived' ? shellCopy.sidebar.unarchive : shellCopy.sidebar.archive}</button>
    </>}</div>, document.body) : null;

  const projectContextMenuPortal = projectContextMenu ? createPortal(<div
    ref={projectContextMenuRef}
    className="session-context-menu project-context-menu"
    data-testid="project-context-menu"
    role="menu"
    aria-label={shellCopy.sidebar.projectActions}
    style={{
      left: Math.max(8, Math.min(projectContextMenu.x, window.innerWidth - 210)),
      top: Math.max(8, Math.min(projectContextMenu.y, window.innerHeight - 286)),
    }}
  >
    <button role="menuitem" onClick={() => void (async () => {
      const project = projectContextMenu.project;
      setProjectContextMenu(null);
      const next = await promptInApp(shellCopy.sidebar.renameProjectPrompt, project.name, { title: shellCopy.sidebar.editProject, confirmLabel: shellCopy.sidebar.saveName });
      if (next?.trim() && next.trim() !== project.name) await props.onRenameProject(project, next.trim());
    })()}><Pencil size={15}/><span>{shellCopy.sidebar.editProject}</span></button>
    <button role="menuitem" onClick={() => { props.onManageProjectFolders(projectContextMenu.project); setProjectContextMenu(null); }}><FolderPlus size={15}/><span>{shellCopy.sidebar.manageProjectFolders}</span></button>
    <button role="menuitem" onClick={() => { props.onToggleProjectPin(projectContextMenu.project.projectId); setProjectContextMenu(null); }}><Pin size={15}/><span>{(props.sessionPreferences.pinnedProjectIds ?? []).includes(projectContextMenu.project.projectId) ? shellCopy.sidebar.unpinProject : shellCopy.sidebar.pinProject}</span></button>
    <button role="menuitem" disabled={!projectContextMenu.sessions.some((session) => sessionHasUnread(session, props.activeSessionId, props.sessionPreferences))} onClick={() => { props.onMarkProjectRead(projectContextMenu.project.projectId); setProjectContextMenu(null); }}><CheckCheck size={15}/><span>{shellCopy.sidebar.markAllRead}</span></button>
    <span className="session-context-menu__separator"/>
    <button role="menuitem" onClick={() => void (async () => {
      const project = projectContextMenu.project;
      const count = projectContextMenu.sessions.filter((session) => !session.temporary && session.status !== 'archived').length;
      setProjectContextMenu(null);
      if (count === 0) return;
      const confirmed = await confirmInApp(shellCopy.sidebar.archiveProjectPrompt(project.name, count), { title: shellCopy.sidebar.archiveProjectChats, confirmLabel: shellCopy.sidebar.archiveAll });
      if (confirmed) await props.onArchiveProjectConversations(project);
    })()}><Archive size={15}/><span>{shellCopy.sidebar.archiveProjectChats}</span></button>
    <button role="menuitem" className="is-danger" onClick={() => void (async () => {
      const project = projectContextMenu.project;
      setProjectContextMenu(null);
      const confirmed = await confirmInApp(shellCopy.sidebar.removeProjectPrompt(project.name), { title: shellCopy.sidebar.removeProject, confirmLabel: shellCopy.sidebar.removeProject, tone: 'danger' });
      if (confirmed) await props.onRemoveProject(project);
    })()}><FolderMinus size={15}/><span>{shellCopy.sidebar.removeProject}</span></button>
  </div>, document.body) : null;

  return <><aside id="chat-sidebar" className={`sidebar ${props.open ? 'is-panel-open' : 'is-panel-closed'}`} aria-label={zhCN.conversations} aria-hidden={!props.open} inert={!props.open ? true : undefined}>
    <header className="sidebar-chatgpt-header">
      <div className="sidebar-harness-title" data-testid="sidebar-harness-title"><strong>Sci Workplace</strong><ChevronDown size={14}/></div>
      <span>
        <button data-testid="sidebar-search-toggle" className={searchOpen ? 'is-active' : ''} aria-label={zhCN.search} title={zhCN.search} aria-pressed={searchOpen} onClick={() => setSearchOpen((value) => { if (value) setQuery(''); return !value; })}><Search size={17}/></button>
      </span>
    </header>

    <button className="sidebar-new-conversation" data-testid="new-conversation" title={zhCN.newConversation} onClick={props.onNewSession}><SquarePen size={17}/><span>{zhCN.newConversation}</span><CirclePlus size={17}/></button>

    {searchOpen && <label className="session-search"><Search size={15}/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zhCN.search}/>{query && <button aria-label={shellCopy.sidebar.clearSearch} onClick={() => setQuery('')}>×</button>}</label>}

    <div className="session-list">
      <nav className="sidebar-chatgpt-nav" aria-label={shellCopy.sidebar.navigation}>
        <button data-testid="sidebar-worktable" onClick={() => props.onModeChange('worktable')}><LayoutDashboard size={18}/><span>{v3Copy.titlebar.worktable}</span></button>
        <button data-testid="sidebar-channels" onClick={() => props.onModeChange('channels')}><UsersRound size={18}/><span>{v3Copy.titlebar.channels}</span></button>
      </nav>
      <section className="session-group sidebar-section" data-testid="sidebar-pinned-section">
        <button className="sidebar-section-heading" aria-expanded={pinnedExpanded} onClick={() => setPinnedExpanded((value) => !value)}><span>{shellCopy.sidebar.pinned}</span><ChevronRight size={13}/></button>
        <div className={`sidebar-section-body ${pinnedExpanded ? 'is-open' : 'is-closed'}`} aria-hidden={!pinnedExpanded} inert={!pinnedExpanded ? true : undefined}><div>{renderProjectGroups(pinnedProjectGroups)}<div className="sidebar-section-sessions">{renderSessionItems(pinnedSessions, sourceLabel)}</div></div></div>
      </section>
      <section className="session-group sidebar-section" data-testid="sidebar-project-section">
        <button className="sidebar-section-heading" aria-expanded={projectExpanded} onClick={() => setProjectExpanded((value) => !value)}><span>{shellCopy.sidebar.project}</span><ChevronRight size={13}/></button>
        <div className={`sidebar-section-body ${projectExpanded ? 'is-open' : 'is-closed'}`} aria-hidden={!projectExpanded} inert={!projectExpanded ? true : undefined}><div>{renderProjectGroups(projectGroups)}</div></div>
      </section>
      <section className="session-group sidebar-section" data-testid="sidebar-recent-section">
        <button className="sidebar-section-heading" aria-expanded={recentExpanded} onClick={() => setRecentExpanded((value) => !value)}><span>{shellCopy.sidebar.recent}</span><ChevronRight size={13}/></button>
        <div className={`sidebar-section-body ${recentExpanded ? 'is-open' : 'is-closed'}`} aria-hidden={!recentExpanded} inert={!recentExpanded ? true : undefined}><div className="sidebar-section-sessions">{renderSessionItems(recentSessions)}</div></div>
      </section>
      {visibleSessions.length === 0 && <div className="session-list__empty">{query ? shellCopy.sidebar.noMatches : t('copy209')}</div>}
    </div>

    <div className="sidebar-profile-area" ref={profileAreaRef}>
      {profileOpen && <div className="sidebar-profile-menu" role="menu" data-testid="sidebar-profile-menu">
        <button data-testid="open-settings" role="menuitem" onClick={() => runProfileAction(props.onSettings)}><Settings2 size={17}/><span>{shellCopy.titlebar.settings}</span><kbd>Ctrl+,</kbd></button>
      </div>}
      <footer className="sidebar__footer">
        <button ref={profileTriggerRef} data-testid="sidebar-profile-trigger" className="sidebar-profile-trigger" aria-haspopup="menu" aria-expanded={profileOpen} onClick={() => setProfileOpen((value) => !value)}>{renderUserAvatar()}<span><span className="sidebar-profile-name">{userName}</span></span></button>
      </footer>
    </div>
  </aside>{contextMenuPortal}{projectContextMenuPortal}</>;
}
