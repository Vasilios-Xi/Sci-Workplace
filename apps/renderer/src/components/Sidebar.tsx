import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArchiveRestore, AudioLines, ChevronDown, CircleHelp, FolderOpen, LayoutDashboard, MessageSquare,
  Pin, PinOff, Plus, Search, Settings2, UsersRound, Zap,
} from 'lucide-react';
import type { AppMode, PrimaryAgentProfile, ProjectSummary, SessionSummary } from '@openlab/protocol';
import { agentV3ZhCN as v3Copy, chatShellZhCN as shellCopy, t, zhCN } from '../i18n/zh-CN.js';
import { promptInApp } from './AppDialog.js';
import { relativeSessionTime, sessionDisplayTitle, sessionWorkingFolderName, sortSessionsForSidebar } from '../lib/session-list.js';
import type { SessionListPreferencesV1 } from '../lib/session-list.js';

interface SidebarProps {
  open: boolean;
  project: ProjectSummary;
  primaryAgent: PrimaryAgentProfile;
  sessions: SessionSummary[];
  activeSessionId: string;
  sessionPreferences: SessionListPreferencesV1;
  connected: boolean;
  preview: boolean;
  onNewSession(): void;
  onSwitchSession(id: string): void;
  onTogglePin(id: string): void;
  onRenameSession(id: string, title: string): void;
  onArchiveSession(id: string): void;
  onUnarchiveSession(id: string): void;
  onModeChange(mode: AppMode): void;
  onOpenWorkspace(): void;
  onSettings(): void;
  onChooseProject(): void;
  projectFolderAvailable: boolean;
  onOpenProjectFolder(): void;
}

interface SessionContextMenuState {
  session: SessionSummary;
  x: number;
  y: number;
  summary: boolean;
  source: HTMLButtonElement | null;
}

interface ProjectContextMenuState {
  x: number;
  y: number;
  source: HTMLButtonElement | null;
}

export function Sidebar(props: SidebarProps) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null);
  const [projectExpanded, setProjectExpanded] = useState(true);
  const workingFolderName = sessionWorkingFolderName(props.project);
  const profileAreaRef = useRef<HTMLDivElement>(null);
  const profileTriggerRef = useRef<HTMLButtonElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const projectContextMenuRef = useRef<HTMLDivElement>(null);
  const visibleSessions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return sortSessionsForSidebar(props.sessions.filter((session) => (
      showArchived ? session.status === 'archived' : session.status !== 'archived'
    ) && (!normalized || sessionDisplayTitle(session, props.sessionPreferences).toLocaleLowerCase('zh-CN').includes(normalized))), props.sessionPreferences);
  }, [props.sessionPreferences, props.sessions, query, showArchived]);

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

  const openProjectMenu = (source: HTMLButtonElement, x: number, y: number) => {
    setProfileOpen(false);
    setContextMenu(null);
    setProjectContextMenu({ source, x, y });
  };

  const renameSession = async (session: SessionSummary) => {
    setContextMenu(null);
    const currentTitle = sessionDisplayTitle(session, props.sessionPreferences);
    const next = await promptInApp(shellCopy.sidebar.renamePrompt, currentTitle, { title: shellCopy.sidebar.rename, confirmLabel: shellCopy.sidebar.saveName });
    if (next?.trim()) props.onRenameSession(session.id, next.trim());
  };

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
      <span><b>{shellCopy.sidebar.agent}</b>{props.primaryAgent.name}</span>
      <span><b>{shellCopy.sidebar.updated}</b>{relativeSessionTime(contextMenu.session.updatedAt)}</span>
      <span><b>{shellCopy.sidebar.model}</b>{contextMenu.session.model || '—'}</span>
      <code>{contextMenu.session.id}</code>
      <button autoFocus onClick={() => setContextMenu((current) => current ? { ...current, summary: false } : null)}>{shellCopy.sidebar.back}</button>
    </div> : <>
      <button role="menuitem" onClick={() => setContextMenu((current) => current ? { ...current, summary: true } : null)}>{shellCopy.sidebar.summary}</button>
      <button role="menuitem" onClick={() => { void navigator.clipboard.writeText(contextMenu.session.id); setContextMenu(null); }}>{shellCopy.sidebar.copySessionId}</button>
      {!showArchived && <button role="menuitem" onClick={() => { props.onTogglePin(contextMenu.session.id); setContextMenu(null); }}>{props.sessionPreferences.pinnedSessionIds.includes(contextMenu.session.id) ? shellCopy.sidebar.unpin : shellCopy.sidebar.pin}</button>}
      <button role="menuitem" onClick={() => void renameSession(contextMenu.session)}>{shellCopy.sidebar.rename}</button>
      <span className="session-context-menu__separator"/>
      <button role="menuitem" className="is-danger" onClick={() => { showArchived ? props.onUnarchiveSession(contextMenu.session.id) : props.onArchiveSession(contextMenu.session.id); setContextMenu(null); }}>{showArchived ? shellCopy.sidebar.unarchive : shellCopy.sidebar.archive}</button>
    </>}</div>, document.body) : null;

  const projectContextMenuPortal = projectContextMenu ? createPortal(<div
    ref={projectContextMenuRef}
    className="session-context-menu project-context-menu"
    data-testid="project-context-menu"
    role="menu"
    aria-label={shellCopy.sidebar.projectActions}
    style={{
      left: Math.max(8, Math.min(projectContextMenu.x, window.innerWidth - 210)),
      top: Math.max(8, Math.min(projectContextMenu.y, window.innerHeight - (props.projectFolderAvailable ? 190 : 150))),
    }}
  >
    <button role="menuitem" onClick={() => { setProjectContextMenu(null); setProjectExpanded(true); props.onNewSession(); }}><MessageSquare size={15}/><span>{zhCN.newConversation}</span></button>
    <button role="menuitem" onClick={() => { setProjectExpanded((value) => !value); setProjectContextMenu(null); }}><ChevronDown size={15}/><span>{projectExpanded ? shellCopy.sidebar.collapseProject : shellCopy.sidebar.expandProject}</span></button>
    <span className="session-context-menu__separator"/>
    {props.projectFolderAvailable && <button role="menuitem" onClick={() => { setProjectContextMenu(null); props.onOpenProjectFolder(); }}><FolderOpen size={15}/><span>{shellCopy.titlebar.openProjectFolder}</span></button>}
    <button role="menuitem" onClick={() => { setProjectContextMenu(null); props.onSettings(); }}><Settings2 size={15}/><span>{shellCopy.titlebar.settings}</span></button>
  </div>, document.body) : null;

  return <><aside id="chat-sidebar" className={`sidebar ${props.open ? 'is-panel-open' : 'is-panel-closed'}`} aria-label={zhCN.conversations} aria-hidden={!props.open} inert={!props.open ? true : undefined}>
    <header className="sidebar-chatgpt-header">
      <button className="sidebar-brand-trigger" title={shellCopy.titlebar.switchProject} onClick={props.onChooseProject}><strong>Sci Workplace</strong><ChevronDown size={16}/></button>
      <span>
        <button className={searchOpen ? 'is-active' : ''} aria-label={zhCN.search} title={zhCN.search} aria-pressed={searchOpen} onClick={() => setSearchOpen((value) => !value)}><Search size={17}/></button>
        <button data-testid="toggle-archived" className={showArchived ? 'is-active' : ''} aria-label={showArchived ? t('copy203') : t('copy204')} title={showArchived ? t('copy203') : t('copy204')} aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)}>{showArchived ? <ArchiveRestore size={17}/> : <Archive size={17}/>}</button>
      </span>
    </header>

    <nav className="sidebar-chatgpt-nav" aria-label={shellCopy.sidebar.navigation}>
      <button data-testid="new-conversation" onClick={props.onNewSession}><MessageSquare size={18}/><span>{zhCN.newConversation}</span></button>
      <button data-testid="sidebar-worktable" onClick={() => props.onModeChange('worktable')}><LayoutDashboard size={18}/><span>{v3Copy.titlebar.worktable}</span></button>
      <button onClick={() => props.onModeChange('channels')}><UsersRound size={18}/><span>{v3Copy.titlebar.channels}</span></button>
      <button onClick={props.onOpenWorkspace}><Zap size={18}/><span>{shellCopy.sidebar.projectSkills}</span></button>
    </nav>

    {searchOpen && <label className="session-search"><Search size={15}/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zhCN.search}/>{query && <button aria-label={shellCopy.sidebar.clearSearch} onClick={() => setQuery('')}>×</button>}</label>}

    <div className="session-list">
      <section className="session-group">
        <div className="session-heading"><span>{showArchived ? shellCopy.sidebar.archived : shellCopy.sidebar.project}</span></div>
        <button
          data-testid="sidebar-project-row"
          className="sidebar-project-row"
          title={projectExpanded ? shellCopy.sidebar.collapseProject : shellCopy.sidebar.expandProject}
          aria-expanded={projectExpanded}
          onClick={() => setProjectExpanded((value) => !value)}
          onContextMenu={(event) => { event.preventDefault(); openProjectMenu(event.currentTarget, event.clientX, event.clientY); }}
          onKeyDown={(event) => {
            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            openProjectMenu(event.currentTarget, bounds.left + 24, bounds.bottom - 2);
          }}
        ><FolderOpen size={18}/><strong>{props.project.name}</strong><ChevronDown size={15}/></button>
        <div className={`sidebar-project-body ${projectExpanded ? 'is-open' : 'is-closed'}`} aria-hidden={!projectExpanded} inert={!projectExpanded ? true : undefined}><div>
        <div className="sidebar-project-sessions">
          {visibleSessions.map((session) => {
            const title = sessionDisplayTitle(session, props.sessionPreferences);
            const pinned = props.sessionPreferences.pinnedSessionIds.includes(session.id);
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
              <button className="session-item__main" title={title} onClick={() => showArchived ? props.onUnarchiveSession(session.id) : props.onSwitchSession(session.id)} onKeyDown={(event) => {
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                openSessionMenu(session, event.currentTarget, bounds.left + 22, bounds.bottom - 4);
              }}>
                <span className="session-item__copy"><strong>{title}</strong><small>{props.primaryAgent.name} · {workingFolderName} · {relativeSessionTime(session.updatedAt)}</small></span>
                {session.status === 'running' && <span className="running-dot"/>}
              </button>
              <span className="session-item__actions">
                {!showArchived && <button data-testid={`session-pin-${session.id}`} className={`session-item__pin ${pinned ? 'is-active' : ''}`} title={pinned ? shellCopy.sidebar.unpin : shellCopy.sidebar.pin} aria-label={`${pinned ? shellCopy.sidebar.unpin : shellCopy.sidebar.pin} ${title}`} onClick={() => props.onTogglePin(session.id)}>{pinned ? <PinOff size={13}/> : <Pin size={13}/>}</button>}
                <button data-testid={`session-archive-${session.id}`} className="session-item__archive" title={showArchived ? t('copy205') : t('copy206')} aria-label={`${showArchived ? t('copy207') : t('copy208')} ${title}`} onClick={() => showArchived ? props.onUnarchiveSession(session.id) : props.onArchiveSession(session.id)}>{showArchived ? <ArchiveRestore size={13}/> : <Archive size={13}/>}</button>
              </span>
            </div>;
          })}
        </div>
        {visibleSessions.length === 0 && <div className="session-list__empty">{query ? shellCopy.sidebar.noMatches : showArchived ? shellCopy.sidebar.noArchived : t('copy209')}</div>}
        </div></div>
      </section>
    </div>

    <div className="sidebar-profile-area" ref={profileAreaRef}>
      {profileOpen && <div className="sidebar-profile-menu" role="menu" data-testid="sidebar-profile-menu">
        <header><span className="sidebar-profile-avatar">S</span><span><strong>Sci Workplace</strong><small>{props.project.name} · {props.primaryAgent.name}</small></span></header>
        <div className={`sidebar-profile-runtime ${props.connected ? 'is-online' : ''}`}><span className="status-dot"/><span><strong>{props.preview ? t('copy210') : props.connected ? zhCN.connected : zhCN.disconnected}</strong><small>{t('copy211')}</small></span></div>
        <span className="sidebar-profile-menu__separator"/>
        {props.projectFolderAvailable && <button role="menuitem" onClick={() => runProfileAction(props.onOpenProjectFolder)}><FolderOpen size={17}/><span>{shellCopy.titlebar.openProjectFolder}</span></button>}
        <button role="menuitem" onClick={() => runProfileAction(props.onChooseProject)}><Plus size={17}/><span>{shellCopy.titlebar.switchProject}</span></button>
        <button data-testid="open-settings" role="menuitem" onClick={() => runProfileAction(props.onSettings)}><Settings2 size={17}/><span>{shellCopy.titlebar.settings}</span><kbd>Ctrl+,</kbd></button>
      </div>}
      <footer className="sidebar__footer">
        <button ref={profileTriggerRef} data-testid="sidebar-profile-trigger" className="sidebar-profile-trigger" aria-haspopup="menu" aria-expanded={profileOpen} onClick={() => setProfileOpen((value) => !value)}><span className="sidebar-profile-avatar">S</span><span><strong>Sci Workplace</strong><small>{props.project.name}</small></span></button>
        <span className="sidebar-runtime-label" title={props.connected ? zhCN.connected : zhCN.disconnected}><AudioLines size={17}/><span>{props.connected ? shellCopy.sidebar.connected : shellCopy.sidebar.offline}</span></span>
        <button className="sidebar-help-button" aria-label={shellCopy.sidebar.runtimeAndSettings} title={shellCopy.sidebar.runtimeAndSettings} onClick={() => setProfileOpen((value) => !value)}><CircleHelp size={18}/></button>
      </footer>
    </div>
  </aside>{contextMenuPortal}{projectContextMenuPortal}</>;
}
