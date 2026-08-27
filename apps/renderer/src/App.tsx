import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ArrowLeft, CircleAlert, FolderOpen, GitFork, Maximize2, Minimize2, PanelRight, RefreshCw, Sparkles, X } from 'lucide-react';
import type { AppMode, ChatAttachmentRef, ConversationProjectTarget, ConversationSourceDescriptor } from '@openlab/protocol';
import { Composer } from './components/Composer.js';
import { AppDialogHost } from './components/AppDialog.js';
import { ChannelsView } from './components/ChannelsView.js';
import { ConversationWorkspace } from './components/ConversationWorkspace.js';
import { CreateProjectDialog } from './components/CreateProjectDialog.js';
import { PrimaryAgentOnboarding } from './components/PrimaryAgentOnboarding.js';
import { Sidebar } from './components/Sidebar.js';
import { Timeline } from './components/Timeline.js';
import { Titlebar } from './components/Titlebar.js';
import { clampWorkspaceWidth, loadChatLayoutPreferences, saveChatLayoutPreferences } from './lib/chat-layout.js';
import type { ChatLayoutPreferencesV1 } from './lib/chat-layout.js';
import { normalizeDraftAgentBinding } from './lib/draft-agent-binding.js';
import { conversationDraftReducer } from './lib/conversation-draft.js';
import { loadSessionListPreferences, saveSessionListPreferences, sessionDisplayTitle, sortSessionsForSidebar } from './lib/session-list.js';
import type { SessionListPreferencesV1 } from './lib/session-list.js';
import { useOpenLab } from './lib/use-openlab.js';
import { useInterfacePreferences } from './lib/interface-preferences.js';
import { chatShellZhCN as shellCopy, hanaZhCN as copy, worktableZhCN as worktableCopy } from './i18n/zh-CN.js';

const SettingsModal = lazy(async () => ({ default: (await import('./components/SettingsModal.js')).SettingsModal }));
const GLOBAL_SESSION_LIST_SCOPE = 'all-conversations';

export function App() {
  const openlab = useOpenLab();
  const { preferences } = useInterfacePreferences();
  const projectId = openlab.snapshot.project.id;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<AppMode>('chat');
  const [layoutState, setLayoutState] = useState<{ projectId: string; preferences: ChatLayoutPreferencesV1 }>(() => ({
    projectId,
    preferences: loadChatLayoutPreferences(projectId, window.localStorage),
  }));
  const [sessionListState, setSessionListState] = useState<{ projectId: string; preferences: SessionListPreferencesV1 }>(() => ({
    projectId: GLOBAL_SESSION_LIST_SCOPE,
    preferences: loadSessionListPreferences(GLOBAL_SESSION_LIST_SCOPE, window.localStorage),
  }));
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [workspaceFocusToken, setWorkspaceFocusToken] = useState(0);
  const [workspaceFocusPanel, setWorkspaceFocusPanel] = useState<'files' | 'workspace'>('workspace');
  const [bottomPanelOpen, setBottomPanelOpen] = useState(true);
  const [workspaceMaximized, setWorkspaceMaximized] = useState(false);
  const [workspaceDragWidth, setWorkspaceDragWidth] = useState<number | null>(null);
  const workspaceResize = useRef<{ pointerId: number; startX: number; startWidth: number; latestWidth: number; host: HTMLDivElement } | undefined>(undefined);
  const [conversationDraft, dispatchConversationDraft] = useReducer(conversationDraftReducer, null);
  const [sessionTitleEdit, setSessionTitleEdit] = useState<{ sessionId: string; value: string }>();
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [projectFoldersEditor, setProjectFoldersEditor] = useState<ConversationSourceDescriptor & { kind: 'project' }>();
  const [projectOptions, setProjectOptions] = useState<Array<{ rootPath: string; name: string; additionalRoots?: string[] }>>([]);
  const [conversationSources, setConversationSources] = useState<ConversationSourceDescriptor[]>([]);
  const [actionError, setActionError] = useState<string>();
  const [sessionAttachments, setSessionAttachments] = useState<Record<string, ChatAttachmentRef[]>>({});
  const [sessionQuotes, setSessionQuotes] = useState<Record<string, Array<{ id: string; label: string }>>>({});
  const [editingMessage, setEditingMessage] = useState<{ requestId: string; nodeId: string; text: string; sessionId: string; branched?: boolean }>();
  const sessionTitleInput = useRef<HTMLInputElement>(null);
  const cancelSessionTitleEdit = useRef(false);
  const projectFoldersInitial = useMemo(() => projectFoldersEditor ? {
    name: projectFoldersEditor.name,
    sourceFolders: [projectFoldersEditor.rootPath, ...(projectFoldersEditor.additionalRoots ?? [])],
  } : undefined, [projectFoldersEditor]);

  const layout = layoutState.projectId === projectId
    ? layoutState.preferences
    : loadChatLayoutPreferences(projectId, window.localStorage);
  const sessionListPreferences = sessionListState.preferences;
  const [compactPanel, setCompactPanel] = useState<'left' | 'right' | null>(() => window.innerWidth < 960
    ? layout.leftSidebarOpen ? 'left' : layout.rightWorkspaceOpen ? 'right' : null
    : null);
  const wasCompactLayout = useRef(window.innerWidth < 960);
  const updateLayout = useCallback((update: (current: ChatLayoutPreferencesV1) => ChatLayoutPreferencesV1) => {
    setLayoutState((current) => {
      const value = current.projectId === projectId ? current.preferences : loadChatLayoutPreferences(projectId, window.localStorage);
      const preferences = update(value);
      saveChatLayoutPreferences(projectId, preferences, window.localStorage);
      return { projectId, preferences };
    });
  }, [projectId]);
  const updateSessionListPreferences = useCallback((update: (current: SessionListPreferencesV1) => SessionListPreferencesV1) => {
    setSessionListState((current) => {
      const preferences = update(current.preferences);
      return preferences === current.preferences ? current : { projectId: GLOBAL_SESSION_LIST_SCOPE, preferences };
    });
  }, []);
  const refreshProjectCatalog = useCallback(async () => {
    if (!window.openlab) return;
    const [projects, sources] = await Promise.all([
      window.openlab.listProjects(),
      window.openlab.listConversationSources(),
    ]);
    setProjectOptions(projects);
    setConversationSources(sources);
  }, []);

  useEffect(() => {
    if (layoutState.projectId !== projectId) {
      setLayoutState({ projectId, preferences: loadChatLayoutPreferences(projectId, window.localStorage) });
      return;
    }
    saveChatLayoutPreferences(projectId, layoutState.preferences, window.localStorage);
  }, [layoutState, projectId]);

  useEffect(() => {
    saveSessionListPreferences(GLOBAL_SESSION_LIST_SCOPE, sessionListState.preferences, window.localStorage);
  }, [sessionListState.preferences]);

  useEffect(() => {
    let active = true;
    if (window.openlab) void Promise.all([window.openlab.listProjects(), window.openlab.listConversationSources()]).then(([projects, sources]) => {
      if (!active) return;
      setProjectOptions(projects);
      setConversationSources(sources);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setViewportWidth(window.innerWidth));
    };
    window.addEventListener('resize', update);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener('resize', update); };
  }, []);

  useEffect(() => {
    const onUnhandled = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      setActionError(event.reason instanceof Error ? event.reason.message : String(event.reason));
    };
    window.addEventListener('unhandledrejection', onUnhandled);
    return () => window.removeEventListener('unhandledrejection', onUnhandled);
  }, []);

  const isDraftConversation = conversationDraft !== null;
  const draftConversationId = conversationDraft?.id ?? null;
  const draftTemporary = conversationDraft?.temporary ?? false;
  const draftAgentBinding = conversationDraft?.binding ?? openlab.snapshot.sessionAgentBinding;
  const draftProject = conversationDraft?.target.kind === 'project' ? conversationDraft.target : undefined;
  const sessionCatalog = useMemo(() => openlab.snapshot.sessionCatalog ?? openlab.snapshot.sessions, [openlab.snapshot.sessionCatalog, openlab.snapshot.sessions]);
  const sessionCatalogRef = useRef(sessionCatalog);
  const conversationSwitchQueue = useRef<Promise<void>>(Promise.resolve());
  const conversationSwitchRevision = useRef(0);
  sessionCatalogRef.current = sessionCatalog;
  const activeSession = useMemo(() => openlab.snapshot.sessions.find((session) => session.id === openlab.snapshot.activeSessionId) ?? openlab.snapshot.sessions[0], [openlab.snapshot.activeSessionId, openlab.snapshot.sessions]);
  const activeSessionTitle = isDraftConversation
    ? draftTemporary ? shellCopy.titlebar.temporaryChat : copy.app.newConversation
    : activeSession ? sessionDisplayTitle(activeSession, sessionListPreferences) : copy.app.newConversation;

  useEffect(() => {
    if (!sessionTitleEdit) return;
    const frame = window.requestAnimationFrame(() => {
      sessionTitleInput.current?.focus();
      sessionTitleInput.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sessionTitleEdit?.sessionId]);

  useEffect(() => {
    if (!sessionTitleEdit || (!isDraftConversation && activeSession?.id === sessionTitleEdit.sessionId)) return;
    setSessionTitleEdit(undefined);
  }, [activeSession?.id, isDraftConversation, sessionTitleEdit]);

  useEffect(() => {
    updateSessionListPreferences((current) => {
      const next = { ...current.readSessionUpdates };
      const sessionIds = new Set(sessionCatalog.filter((session) => !session.temporary).map((session) => session.id));
      let changed = false;
      for (const session of sessionCatalog) {
        if (session.temporary) continue;
        if (!(session.id in next) || (!isDraftConversation && session.id === openlab.snapshot.activeSessionId && next[session.id] !== session.updatedAt)) {
          next[session.id] = session.updatedAt;
          changed = true;
        }
      }
      for (const id of Object.keys(next)) {
        if (sessionIds.has(id)) continue;
        delete next[id];
        changed = true;
      }
      return changed ? { ...current, readSessionUpdates: next } : current;
    });
  }, [isDraftConversation, openlab.snapshot.activeSessionId, sessionCatalog, updateSessionListPreferences]);
  const projectFolderAvailable = isDraftConversation ? Boolean(draftProject) : openlab.projectFolderSelected;
  const openProjectFolder = useCallback(() => {
    if (draftProject) void window.openlab?.openProjectRoot(draftProject.rootPath);
    else if (projectFolderAvailable) void window.openlab?.openProjectFolder();
  }, [draftProject, projectFolderAvailable]);

  useEffect(() => {
    const onShellShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onShellShortcut);
    return () => window.removeEventListener('keydown', onShellShortcut);
  }, []);
  const sessionKey = isDraftConversation
    ? `conversation:draft:${draftConversationId}`
    : `${projectId}:${activeSession?.id ?? 'new'}`;
  const injectedAttachments = sessionAttachments[sessionKey] ?? [];
  const quotedNodes = sessionQuotes[sessionKey] ?? [];
  const running = !isDraftConversation && (activeSession?.status === 'running' || openlab.snapshot.agentRuns.some((agent) => agent.role === 'lead' && agent.status === 'running'));
  const visibleAgentBinding = isDraftConversation ? draftAgentBinding : openlab.snapshot.sessionAgentBinding;
  const sessionMembers = openlab.snapshot.agentDefinitions.filter((agent) => visibleAgentBinding.memberAgentIds.includes(agent.id));
  const draftLeadAgent = openlab.snapshot.agentDefinitions.find((agent) => agent.id === visibleAgentBinding.leadAgentId);
  const draftAgentOptions = openlab.snapshot.agentDefinitions.filter((agent) => agent.status === 'active');
  const conversationSnapshot = isDraftConversation ? {
    ...openlab.snapshot,
    activeSessionId: '',
    timeline: [],
    pendingApprovals: [],
    turnVariants: [],
    agentRuns: [],
    tasks: [],
    conversationFiles: [],
    workspace: { ...openlab.snapshot.workspace, note: '', conversationFileCount: 0 },
    sessionAgentBinding: draftAgentBinding,
  } : openlab.snapshot;
  const compactLayout = viewportWidth < 960;
  const workspaceOverlay = viewportWidth < 1280;
  const leftSidebarOpen = compactLayout ? compactPanel === 'left' : layout.leftSidebarOpen;
  const rightPanelOpen = compactLayout ? compactPanel === 'right' : layout.rightWorkspaceOpen;
  const overlayOpen = mode === 'chat' && ((compactLayout && leftSidebarOpen) || (workspaceOverlay && rightPanelOpen));

  useEffect(() => {
    if (!conversationDraft || !openlab.connected) return;
    const binding = normalizeDraftAgentBinding({
      sessionId: `draft:${draftConversationId}`,
      current: conversationDraft.binding,
      fallback: openlab.snapshot.sessionAgentBinding,
      definitions: openlab.snapshot.agentDefinitions,
    });
    if (binding !== conversationDraft.binding) {
      dispatchConversationDraft({ type: 'sync-binding', draftId: conversationDraft.id, binding });
    }
  }, [conversationDraft, draftConversationId, openlab.connected, openlab.snapshot.agentDefinitions, openlab.snapshot.sessionAgentBinding]);

  useEffect(() => {
    if (!conversationDraft || conversationDraft.phase !== 'editing' || !window.openlab) return;
    void window.openlab.prepareConversationTarget(conversationDraft.target).catch(() => undefined);
  }, [conversationDraft?.phase, conversationDraft?.target]);

  useEffect(() => {
    if (!conversationDraft || conversationDraft.phase !== 'committing' || !conversationDraft.attemptId || !conversationDraft.committedSessionId) return;
    if (openlab.snapshot.activeSessionId !== conversationDraft.committedSessionId) return;
    dispatchConversationDraft({
      type: 'complete',
      draftId: conversationDraft.id,
      attemptId: conversationDraft.attemptId,
      sessionId: conversationDraft.committedSessionId,
    });
  }, [conversationDraft, openlab.snapshot.activeSessionId]);

  useEffect(() => {
    if (!rightPanelOpen || workspaceOverlay) setWorkspaceMaximized(false);
  }, [rightPanelOpen, workspaceOverlay]);

  useEffect(() => {
    if (compactLayout && !wasCompactLayout.current) {
      setCompactPanel(layout.leftSidebarOpen ? 'left' : layout.rightWorkspaceOpen ? 'right' : null);
    } else if (!compactLayout && wasCompactLayout.current) {
      setCompactPanel(null);
    }
    wasCompactLayout.current = compactLayout;
  }, [compactLayout, layout.leftSidebarOpen, layout.rightWorkspaceOpen]);

  const restorePanelFocus = useCallback((panel: 'left' | 'right') => {
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(panel === 'left' ? '[data-testid="titlebar-left-toggle"]' : '[data-testid="titlebar-workspace-toggle"]')?.focus());
  }, []);

  const closeOverlay = useCallback(() => {
    if (compactLayout && leftSidebarOpen) {
      updateLayout((current) => ({ ...current, leftSidebarOpen: false }));
      setCompactPanel(null);
      restorePanelFocus('left');
      return;
    }
    if (rightPanelOpen) {
      updateLayout((current) => ({ ...current, rightWorkspaceOpen: false }));
      if (compactLayout) setCompactPanel(null);
      restorePanelFocus('right');
    }
  }, [compactLayout, leftSidebarOpen, restorePanelFocus, rightPanelOpen, updateLayout]);

  useEffect(() => {
    if (!overlayOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeOverlay();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeOverlay, overlayOpen]);

  const toggleLeftSidebar = () => {
    if (compactLayout) {
      const nextOpen = compactPanel !== 'left';
      setCompactPanel(nextOpen ? 'left' : null);
      updateLayout((current) => ({ ...current, leftSidebarOpen: nextOpen }));
      return;
    }
    updateLayout((current) => {
      const nextOpen = !current.leftSidebarOpen;
      return { ...current, leftSidebarOpen: nextOpen };
    });
  };

  const toggleRightWorkspace = () => {
    if (compactLayout) {
      const nextOpen = compactPanel !== 'right';
      setCompactPanel(nextOpen ? 'right' : null);
      updateLayout((current) => ({ ...current, rightWorkspaceOpen: nextOpen }));
      return;
    }
    updateLayout((current) => {
      const nextOpen = !current.rightWorkspaceOpen;
      return { ...current, rightWorkspaceOpen: nextOpen };
    });
  };

  const focusRightWorkspace = (panel: 'files' | 'workspace') => {
    if (compactLayout) setCompactPanel('right');
    updateLayout((current) => ({ ...current, rightWorkspaceOpen: true, workspaceTab: panel }));
    setWorkspaceFocusPanel(panel);
    setWorkspaceFocusToken((value) => value + 1);
  };
  const openRightWorkspace = () => focusRightWorkspace('workspace');
  const toggleWorkspacePanel = (panel: 'files' | 'workspace') => {
    if (rightPanelOpen && layout.workspaceTab === panel) toggleRightWorkspace();
    else focusRightWorkspace(panel);
  };
  const changeWorkspaceTab = useCallback((workspaceTab: 'files' | 'workspace') => {
    updateLayout((current) => ({ ...current, workspaceTab }));
  }, [updateLayout]);

  const workspaceWidth = workspaceDragWidth ?? layout.workspaceWidth;
  const workspaceWidthLimit = useCallback(() => {
    const leftTrack = leftSidebarOpen ? 264 : 0;
    return Math.max(320, Math.min(720, window.innerWidth - leftTrack - 500));
  }, [leftSidebarOpen]);
  const beginWorkspaceResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || workspaceOverlay || workspaceMaximized) return;
    const host = event.currentTarget.closest('.chat-workspace');
    if (!(host instanceof HTMLDivElement)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    workspaceResize.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: workspaceWidth, latestWidth: workspaceWidth, host };
    // Disable the grid transition synchronously. Waiting for React to commit
    // this class leaves one animated frame where the divider trails a quick
    // pointer movement.
    host.classList.add('is-resizing-workspace');
    setWorkspaceDragWidth(workspaceWidth);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [workspaceMaximized, workspaceOverlay, workspaceWidth]);
  const moveWorkspaceResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const resize = workspaceResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const next = Math.min(workspaceWidthLimit(), clampWorkspaceWidth(resize.startWidth + resize.startX - event.clientX));
    resize.latestWidth = next;
    resize.host.style.setProperty('--chat-workspace-width', `${next}px`);
  }, [workspaceWidthLimit]);
  const finishWorkspaceResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const resize = workspaceResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    workspaceResize.current = undefined;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    updateLayout((current) => ({ ...current, workspaceWidth: resize.latestWidth }));
    resize.host.classList.remove('is-resizing-workspace');
    setWorkspaceDragWidth(null);
  }, [updateLayout]);
  const resizeWorkspaceFromKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home'
      ? 400
      : Math.min(workspaceWidthLimit(), clampWorkspaceWidth(layout.workspaceWidth + (event.key === 'ArrowLeft' ? (event.shiftKey ? 48 : 16) : -(event.shiftKey ? 48 : 16))));
    updateLayout((current) => ({ ...current, workspaceWidth: next }));
  }, [layout.workspaceWidth, updateLayout, workspaceWidthLimit]);

  const startDraftConversation = (temporary: boolean) => {
    if (conversationDraft && conversationDraft.phase !== 'editing') return;
    setEditingMessage(undefined);
    setSessionTitleEdit(undefined);
    const id = crypto.randomUUID();
    setMode('chat');
    dispatchConversationDraft({
      type: 'start',
      id,
      temporary,
      binding: normalizeDraftAgentBinding({
      sessionId: `draft:${id}`,
      current: conversationDraft?.binding ?? openlab.snapshot.sessionAgentBinding,
      fallback: openlab.snapshot.sessionAgentBinding,
      definitions: openlab.snapshot.agentDefinitions,
      }),
    });
    setWorkspaceMaximized(false);
    if (compactLayout) setCompactPanel(null);
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.app-mode-chat .composer textarea')?.focus());
  };
  const beginDraftConversation = () => startDraftConversation(false);
  const beginTemporaryConversation = () => startDraftConversation(true);

  const switchConversation = async (id: string) => {
    if (conversationDraft && conversationDraft.phase !== 'editing') return;
    const revision = ++conversationSwitchRevision.current;
    setEditingMessage(undefined);
    setSessionTitleEdit(undefined);
    setMode('chat');
    dispatchConversationDraft({ type: 'cancel', ...(conversationDraft ? { draftId: conversationDraft.id } : {}) });
    if (compactLayout) setCompactPanel(null);
    const run = async () => {
      if (revision !== conversationSwitchRevision.current) return;
      const session = sessionCatalogRef.current.find((candidate) => candidate.id === id);
      try {
        if (!session || !window.openlab) {
          await openlab.switchSession(id);
          return;
        }
        const next = await window.openlab.activateConversation({ sessionId: id, projectId: session.projectId });
        if (revision !== conversationSwitchRevision.current) return;
        await openlab.replaceConnection(next.connection, next.snapshot);
      } catch (cause) {
        if (revision === conversationSwitchRevision.current) setActionError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    const queued = conversationSwitchQueue.current.then(run, run);
    conversationSwitchQueue.current = queued.catch(() => undefined);
    await queued;
  };

  const cycleConversation = (direction: -1 | 1) => {
    const sessions = sortSessionsForSidebar(sessionCatalog.filter((session) => session.status !== 'archived'), sessionListPreferences);
    if (sessions.length === 0) return;
    const current = sessions.findIndex((session) => session.id === openlab.snapshot.activeSessionId);
    const next = current < 0
      ? direction > 0 ? 0 : sessions.length - 1
      : (current + direction + sessions.length) % sessions.length;
    void switchConversation(sessions[next]!.id);
  };

  const setConversationArchived = async (id: string, archived: boolean) => {
    const session = sessionCatalog.find((candidate) => candidate.id === id);
    if (session && session.projectId !== openlab.snapshot.project.id && window.openlab) {
      const next = await window.openlab.activateConversation({ sessionId: id, projectId: session.projectId, activate: false });
      await openlab.replaceConnection(next.connection, next.snapshot);
    }
    if (archived) await openlab.archiveSession(id);
    else await openlab.unarchiveSession(id);
  };

  const sendConversation: typeof openlab.send = async (text, options) => {
    setActionError(undefined);
    const edit = editingMessage;
    if (edit) {
      if (!activeSession || activeSession.id !== edit.sessionId || isDraftConversation) throw new Error(copy.app.editMessageSessionChanged);
      if (!edit.branched) {
        const forked = await openlab.forkSessionBefore(edit.sessionId, edit.nodeId);
        if (forked) {
          setEditingMessage((current) => current?.requestId === edit.requestId
            ? { ...current, sessionId: forked.id, branched: true }
            : current);
        }
      }
    }
    if (conversationDraft) {
      if (conversationDraft.phase !== 'editing') throw new Error(copy.app.createSessionFailed);
      const draft = conversationDraft;
      const attemptId = crypto.randomUUID();
      const binding = normalizeDraftAgentBinding({
        sessionId: `draft:${draft.id}`,
        current: draft.binding,
        fallback: openlab.snapshot.sessionAgentBinding,
        definitions: openlab.snapshot.agentDefinitions,
      });
      if (!binding.leadAgentId) throw new Error(copy.app.noProjectAgent);
      dispatchConversationDraft({ type: 'submit', draftId: draft.id, attemptId });
      try {
        const started = await openlab.startConversation({
          target: draft.target,
          temporary: draft.temporary,
          leadAgentId: binding.leadAgentId,
          memberAgentIds: binding.memberAgentIds,
          message: { text, ...options, interfaceLocale: preferences.locale },
        });
        dispatchConversationDraft({
          type: 'commit-ready',
          draftId: draft.id,
          attemptId,
          sessionId: started.session.id,
        });
      } catch (cause) {
        dispatchConversationDraft({ type: 'submit-failed', draftId: draft.id, attemptId });
        throw cause;
      }
      return;
    }
    await openlab.send(text, { ...options, interfaceLocale: preferences.locale });
  };

  const toggleSessionPin = (id: string) => updateSessionListPreferences((current) => ({
    ...current,
    pinnedSessionIds: current.pinnedSessionIds.includes(id)
      ? current.pinnedSessionIds.filter((candidate) => candidate !== id)
      : [id, ...current.pinnedSessionIds],
  }));

  const toggleProjectPin = (id: string) => updateSessionListPreferences((current) => ({
    ...current,
    pinnedProjectIds: (current.pinnedProjectIds ?? []).includes(id)
      ? (current.pinnedProjectIds ?? []).filter((candidate) => candidate !== id)
      : [id, ...(current.pinnedProjectIds ?? [])],
  }));

  const markProjectConversationsRead = (id: string) => updateSessionListPreferences((current) => ({
    ...current,
    readSessionUpdates: {
      ...current.readSessionUpdates,
      ...Object.fromEntries(sessionCatalog.filter((session) => session.projectId === id).map((session) => [session.id, session.updatedAt])),
    },
  }));

  const renameProject = async (source: ConversationSourceDescriptor & { kind: 'project' }, name: string) => {
    if (!window.openlab) return;
    try {
      await window.openlab.renameProject({ projectId: source.projectId, rootPath: source.rootPath, name });
      if (source.projectId === openlab.snapshot.project.id) await openlab.refresh();
      await refreshProjectCatalog();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const archiveProjectConversations = async (source: ConversationSourceDescriptor & { kind: 'project' }) => {
    if (!window.openlab) return;
    try {
      await window.openlab.archiveProjectConversations({ projectId: source.projectId, rootPath: source.rootPath });
      await openlab.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const removeProject = async (source: ConversationSourceDescriptor & { kind: 'project' }) => {
    if (!window.openlab) return;
    try {
      const result = await window.openlab.removeProject({ projectId: source.projectId, rootPath: source.rootPath });
      updateSessionListPreferences((current) => ({
        ...current,
        pinnedProjectIds: (current.pinnedProjectIds ?? []).filter((id) => id !== source.projectId),
      }));
      if (result.connection) {
        dispatchConversationDraft({ type: 'cancel', ...(conversationDraft ? { draftId: conversationDraft.id } : {}) });
        await openlab.replaceConnection(result.connection);
      }
      await refreshProjectCatalog();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const updateProjectFolders = async (input: { sourceFolders: string[]; name: string }) => {
    if (!window.openlab || !projectFoldersEditor) return;
    const updated = await window.openlab.updateProjectFolders({
      projectId: projectFoldersEditor.projectId,
      rootPath: projectFoldersEditor.rootPath,
      sourceFolders: input.sourceFolders,
    });
    setProjectFoldersEditor(undefined);
    if (updated.projectId === openlab.snapshot.project.id) await openlab.refresh();
    await refreshProjectCatalog();
  };

  const renameSessionLocally = (id: string, title: string) => updateSessionListPreferences((current) => {
    const aliases = { ...current.aliases };
    const original = sessionCatalog.find((session) => session.id === id)?.title;
    if (!title.trim() || title.trim() === original) delete aliases[id];
    else aliases[id] = title.trim();
    return { ...current, aliases };
  });

  const beginActiveSessionRename = () => {
    if (isDraftConversation || !activeSession) return;
    cancelSessionTitleEdit.current = false;
    setSessionTitleEdit({ sessionId: activeSession.id, value: activeSessionTitle });
  };
  const finishActiveSessionRename = (edit: { sessionId: string; value: string }) => {
    if (cancelSessionTitleEdit.current) {
      cancelSessionTitleEdit.current = false;
      return;
    }
    const next = edit.value.trim();
    if (next) renameSessionLocally(edit.sessionId, next);
    setSessionTitleEdit((current) => current?.sessionId === edit.sessionId ? undefined : current);
  };

  useEffect(() => { void openlab.hideAllBrowsers(); }, [mode, openlab.hideAllBrowsers]);

  const chooseProject = () => {
    setCreateProjectOpen(true);
  };
  const createProject = async (input: { sourceFolders: string[]; name: string }) => {
    if (!window.openlab || !conversationDraft || conversationDraft.phase !== 'editing') return;
    const target = await window.openlab.stageProject(input);
    dispatchConversationDraft({ type: 'select-target', draftId: conversationDraft.id, target });
    if (target.kind === 'project') {
      setProjectOptions((current) => [
        { rootPath: target.rootPath, name: target.name, ...(target.additionalRoots ? { additionalRoots: target.additionalRoots } : {}) },
        ...current.filter((project) => project.rootPath.toLocaleLowerCase() !== target.rootPath.toLocaleLowerCase()),
      ]);
      void window.openlab.listConversationSources().then(setConversationSources).catch(() => undefined);
    }
    setCreateProjectOpen(false);
  };
  const activateExistingProject = (rootPath: string) => {
    if (!conversationDraft || conversationDraft.phase !== 'editing') return;
    const project = projectOptions.find((candidate) => candidate.rootPath.toLocaleLowerCase() === rootPath.toLocaleLowerCase());
    if (!project) return;
    dispatchConversationDraft({ type: 'select-target', draftId: conversationDraft.id, target: { kind: 'project', ...project } });
  };
  const detachDraftProject = () => {
    if (!conversationDraft || conversationDraft.phase !== 'editing') return;
    dispatchConversationDraft({ type: 'select-target', draftId: conversationDraft.id, target: { kind: 'detached' } });
  };
  const quote = (ids: string[]) => setSessionQuotes((sessions) => {
    const current = sessions[sessionKey] ?? [];
    const next = new Map(current.map((item) => [item.id, item]));
    for (const id of ids) {
      const node = openlab.snapshot.timeline.find((item) => item.id === id);
      if (node && ['user', 'assistant'].includes(node.kind)) next.set(id, { id, label: `${node.kind === 'user' ? copy.common.you : node.title ?? copy.common.supervisor} · ${node.content.replace(/\s+/gu, ' ').slice(0, 24)}` });
    }
    return { ...sessions, [sessionKey]: [...next.values()] };
  });

  const removeInjectedAttachment = (id: string) => setSessionAttachments((sessions) => ({ ...sessions, [sessionKey]: (sessions[sessionKey] ?? []).filter((item) => item.id !== id) }));
  const removeQuotedNode = (id: string) => setSessionQuotes((sessions) => ({ ...sessions, [sessionKey]: (sessions[sessionKey] ?? []).filter((item) => item.id !== id) }));
  const clearInjected = () => {
    setSessionAttachments((sessions) => ({ ...sessions, [sessionKey]: [] }));
    setSessionQuotes((sessions) => ({ ...sessions, [sessionKey]: [] }));
  };
  const referenceAttachment = (attachment: ChatAttachmentRef) => setSessionAttachments((sessions) => {
    const current = sessions[sessionKey] ?? [];
    return { ...sessions, [sessionKey]: [...new Map([...current, attachment].map((item) => [item.id, item])).values()] };
  });
  const userProfile = openlab.snapshot.userProfile ?? { name: shellCopy.sidebar.defaultUserName, profile: '' };

  const openFolderAsProject = async () => {
    if (!window.openlab) return;
    try {
      if (conversationDraft) {
        if (conversationDraft.phase !== 'editing') return;
        const selected = await window.openlab.selectProjectFolder();
        if (!selected) return;
        const target: ConversationProjectTarget = { kind: 'project', rootPath: selected.path, name: selected.name };
        dispatchConversationDraft({ type: 'select-target', draftId: conversationDraft.id, target });
        setProjectOptions((current) => [
          { rootPath: selected.path, name: selected.name },
          ...current.filter((project) => project.rootPath.toLocaleLowerCase() !== selected.path.toLocaleLowerCase()),
        ]);
      } else {
        const next = await window.openlab.chooseProject();
        if (next) await openlab.replaceConnection(next);
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <div className="app-shell">
    <Titlebar projectName={openlab.snapshot.project.name} projectFolderAvailable={projectFolderAvailable} mode={mode} leftSidebarOpen={leftSidebarOpen} bottomPanelOpen={bottomPanelOpen} runtimeConnected={openlab.connected} onToggleLeftSidebar={toggleLeftSidebar} onToggleBottomPanel={() => setBottomPanelOpen((value) => !value)} onTogglePinnedSummary={() => window.dispatchEvent(new Event('sci-workplace:toggle-pinned-summary'))} onOpenFileTree={() => toggleWorkspacePanel('workspace')} onOpenReviewPanel={() => toggleWorkspacePanel('files')} onPreviousChat={() => cycleConversation(-1)} onNextChat={() => cycleConversation(1)} onNewConversation={beginDraftConversation} onNewTemporaryConversation={beginTemporaryConversation} onOpenFolder={openFolderAsProject} onSettings={() => setSettingsOpen(true)}/>
    <div className="app-mode-stack">
    <div className={`app-mode-layer app-mode-chat ${mode === 'chat' ? 'is-active' : ''}`} aria-hidden={mode !== 'chat'} inert={mode !== 'chat' ? true : undefined}><div className={`workspace chat-workspace ${leftSidebarOpen ? 'has-left-sidebar' : ''} ${rightPanelOpen ? 'has-right-workspace' : ''} ${bottomPanelOpen ? '' : 'is-bottom-panel-hidden'} ${workspaceMaximized ? 'is-workspace-maximized' : ''} ${workspaceDragWidth !== null ? 'is-resizing-workspace' : ''} ${compactLayout ? 'is-compact-layout' : workspaceOverlay ? 'is-workspace-overlay' : 'is-wide-layout'}`} style={{ '--chat-workspace-width': `${workspaceWidth}px` } as React.CSSProperties}>
      <Sidebar
        open={leftSidebarOpen}
        project={openlab.snapshot.project}
        primaryAgent={openlab.snapshot.primaryAgent}
        agentDefinitions={openlab.snapshot.agentDefinitions}
        activeLeadAgentId={openlab.snapshot.sessionAgentBinding.leadAgentId}
        sessions={sessionCatalog.filter((session) => !session.temporary)}
        conversationSources={conversationSources}
        activeSessionId={isDraftConversation ? '' : openlab.snapshot.activeSessionId}
        sessionPreferences={sessionListPreferences}
        onNewSession={beginDraftConversation}
        onSwitchSession={switchConversation}
        onTogglePin={toggleSessionPin}
        onRenameSession={renameSessionLocally}
        onArchiveSession={(id) => void setConversationArchived(id, true)}
        onUnarchiveSession={(id) => void setConversationArchived(id, false)}
        onModeChange={setMode}
        onSettings={() => setSettingsOpen(true)}
        projectFolderAvailable={projectFolderAvailable}
        onToggleProjectPin={toggleProjectPin}
        onMarkProjectRead={markProjectConversationsRead}
        onRenameProject={renameProject}
        onManageProjectFolders={setProjectFoldersEditor}
        onArchiveProjectConversations={archiveProjectConversations}
        onRemoveProject={removeProject}
        userName={userProfile.name}
        {...(userProfile.avatar ? { userAvatar: userProfile.avatar } : {})}
      />
      <main className={`conversation-pane ${isDraftConversation ? 'is-draft-conversation' : ''}`}>
        <header className="conversation-header" data-testid="conversation-header">
          <div className="conversation-header__meta" data-testid="conversation-header-meta">{projectFolderAvailable && <button type="button" className="conversation-header__icon" data-testid="conversation-open-project" aria-label={shellCopy.workspace.openWithSystem} title={shellCopy.workspace.openWithSystem} onClick={openProjectFolder}><FolderOpen size={16}/></button>}{isDraftConversation ? <h1>{activeSessionTitle}</h1> : sessionTitleEdit && activeSession?.id === sessionTitleEdit.sessionId ? <input
            ref={sessionTitleInput}
            className="conversation-title-input"
            data-testid="conversation-title-input"
            aria-label={shellCopy.sidebar.rename}
            value={sessionTitleEdit.value}
            size={Math.max(4, Math.min(40, sessionTitleEdit.value.length + 1))}
            maxLength={200}
            onChange={(event) => setSessionTitleEdit((current) => current ? { ...current, value: event.target.value } : current)}
            onBlur={() => finishActiveSessionRename(sessionTitleEdit)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelSessionTitleEdit.current = true;
                setSessionTitleEdit(undefined);
              }
            }}
          /> : <button type="button" className="conversation-title-rename" data-testid="conversation-title-rename" title={shellCopy.sidebar.rename} aria-label={`${shellCopy.sidebar.rename}：${activeSessionTitle}`} onClick={beginActiveSessionRename}><span>{activeSessionTitle}</span></button>}{openlab.preview ? <span className="preview-chip">{copy.common.preview}</span> : !openlab.connected ? <span className="mode-chip offline"><CircleAlert size={12}/>{copy.titlebar.disconnected}</span> : null}</div>
          <div className="conversation-header__actions" data-testid="conversation-header-actions"><button data-testid="fork-session" title={copy.app.forkFull} disabled={isDraftConversation || !activeSession || running} onClick={() => !isDraftConversation && activeSession && void openlab.forkSession(activeSession.id)}><GitFork size={15}/></button><button data-testid="refresh-snapshot" title={copy.common.refresh} onClick={() => void openlab.refresh()}><RefreshCw size={15}/></button></div>
        </header>
        {openlab.error && openlab.preview && <div className="preview-banner"><CircleAlert size={13}/><span>{copy.app.runtimePreview}</span><code>{openlab.error}</code></div>}
        {openlab.capabilityNotice && <div className="capability-banner"><Sparkles size={13}/><span><strong>{copy.app.capabilitiesUpdated}</strong>{openlab.capabilityNotice.reason}</span><button onClick={() => void openlab.refresh()}>{copy.app.refreshAgentTools}</button><button aria-label={copy.app.ignore} onClick={openlab.dismissCapabilityNotice}><X size={12}/></button></div>}
        {actionError && <div className="action-error-banner" role="alert"><CircleAlert size={13}/><span><strong>{copy.app.actionFailed}</strong>{actionError}</span><button aria-label={copy.common.close} onClick={() => setActionError(undefined)}><X size={12}/></button></div>}
        <Timeline
          nodes={conversationSnapshot.timeline}
          approvals={conversationSnapshot.pendingApprovals}
          variants={conversationSnapshot.turnVariants}
          agents={conversationSnapshot.agentRuns}
          tasks={conversationSnapshot.tasks}
          agentDefinitions={conversationSnapshot.agentDefinitions}
          primaryAgent={openlab.snapshot.primaryAgent}
          timeZone={preferences.timeZone}
          sessionKey={sessionKey}
          emptyProjectName={isDraftConversation ? draftProject?.name ?? copy.timeline.noProject : undefined}
          emptyProjectPath={isDraftConversation ? draftProject?.rootPath : undefined}
          projectOptions={isDraftConversation ? projectOptions : undefined}
          onChooseProject={isDraftConversation ? chooseProject : undefined}
          onSelectProject={isDraftConversation ? activateExistingProject : undefined}
          onClearProject={isDraftConversation ? detachDraftProject : undefined}
          emptyAgent={isDraftConversation ? {
            id: draftLeadAgent?.id ?? visibleAgentBinding.leadAgentId,
            name: draftLeadAgent?.name ?? openlab.snapshot.primaryAgent.name,
            avatar: draftLeadAgent?.avatar ?? openlab.snapshot.primaryAgent.avatar,
            memoryEnabled: draftLeadAgent?.memoryPolicy.memoryEnabled ?? true,
          } : undefined}
          emptyAgentOptions={isDraftConversation ? draftAgentOptions.map((agent) => ({ id: agent.id, name: agent.name, avatar: agent.avatar })) : undefined}
          onChooseAgent={isDraftConversation && conversationDraft ? (leadAgentId) => dispatchConversationDraft({
            type: 'choose-agent',
            draftId: conversationDraft.id,
            leadAgentId,
            updatedAt: new Date().toISOString(),
          }) : undefined}
          onToggleMemory={isDraftConversation && draftLeadAgent && !openlab.preview ? async (memoryEnabled) => {
            await openlab.updateAgent(draftLeadAgent.id, {
              memoryPolicy: { ...draftLeadAgent.memoryPolicy, memoryEnabled },
            });
          } : undefined}
          onApprove={(id, approved) => void openlab.approve(id, approved)}
          onRegenerate={openlab.regenerateTurn}
          onFork={async (nodeId) => { if (!isDraftConversation && activeSession) await openlab.forkSession(activeSession.id, nodeId); }}
          onEdit={(nodeId, content) => {
            if (isDraftConversation || !activeSession) return;
            setActionError(undefined);
            setEditingMessage({ requestId: crypto.randomUUID(), nodeId, text: content, sessionId: activeSession.id });
          }}
          onQuote={quote}
          onActivateVariant={openlab.activateTurnVariant}
          onAgentAction={openlab.agentAction}
          onAgentMessage={openlab.messageAgent}
        />
        <Composer
          models={openlab.snapshot.models}
          skills={openlab.snapshot.skills}
          agents={sessionMembers}
          researchObjects={openlab.snapshot.researchObjects}
          running={running || Boolean(conversationDraft && conversationDraft.phase !== 'editing')}
          sessionKey={sessionKey}
          {...(!isDraftConversation && activeSession?.model ? { preferredModel: activeSession.model } : {})}
          composerHeight={layout.composerHeight}
          onComposerHeightChange={(composerHeight) => updateLayout((current) => ({ ...current, composerHeight }))}
          injectedAttachments={injectedAttachments}
          quotedNodes={quotedNodes}
          editingMessage={editingMessage}
          onRemoveInjectedAttachment={removeInjectedAttachment}
          onRemoveQuotedNode={removeQuotedNode}
          onClearInjected={clearInjected}
          onOpenWorkspace={openRightWorkspace}
          onCancelEditingMessage={() => setEditingMessage(undefined)}
          onFinishEditingMessage={() => setEditingMessage(undefined)}
          onSend={sendConversation}
          onCancel={openlab.cancel}
        />
      </main>
      {rightPanelOpen && !workspaceOverlay && !workspaceMaximized && <div
        className="conversation-workspace-resizer"
        data-testid="workspace-resizer"
        role="separator"
        aria-label={copy.workspace.resizeWorkspace}
        aria-orientation="vertical"
        aria-valuemin={320}
        aria-valuemax={workspaceWidthLimit()}
        aria-valuenow={workspaceWidth}
        tabIndex={0}
        onPointerDown={beginWorkspaceResize}
        onPointerMove={moveWorkspaceResize}
        onPointerUp={finishWorkspaceResize}
        onPointerCancel={finishWorkspaceResize}
        onLostPointerCapture={finishWorkspaceResize}
        onKeyDown={resizeWorkspaceFromKeyboard}
        onDoubleClick={() => updateLayout((current) => ({ ...current, workspaceWidth: 400 }))}
      />}
      <ConversationWorkspace
        snapshot={conversationSnapshot}
        focusWorkspaceToken={workspaceFocusToken}
        focusWorkspacePanel={workspaceFocusPanel}
        running={running}
        mobileOpen={rightPanelOpen}
        tab={layout.workspaceTab}
        onTabChange={changeWorkspaceTab}
        onCloseMobile={closeOverlay}
        listWorkspace={openlab.listWorkspace}
        searchWorkspace={openlab.searchWorkspace}
        previewWorkspace={openlab.previewWorkspace}
        createWorkspaceAttachment={openlab.createWorkspaceAttachment}
        saveWorkspaceNote={openlab.saveWorkspaceNote}
        activateWorkspaceRoot={openlab.activateWorkspaceRoot}
        confirmWorkspaceRoot={openlab.confirmWorkspaceRoot}
        revokeWorkspaceRoot={openlab.revokeWorkspaceRoot}
        authorizeWorkspaceRoot={openlab.authorizeWorkspaceRoot}
        operateWorkspaceFile={openlab.operateWorkspaceFile}
        undoWorkspaceFile={openlab.undoWorkspaceFile}
        addConversationFile={openlab.addConversationFile}
        removeConversationFile={openlab.removeConversationFile}
        installSkill={async () => await openlab.installExtension('skill')}
        installSkillSource={openlab.installSkillSource}
        approveSkill={openlab.approveSkill}
        onReferenceAttachment={referenceAttachment}
        createBrowserProfile={openlab.createBrowserProfile}
        openBrowserSession={openlab.openBrowserSession}
        browserAction={openlab.browserAction}
        setBrowserBounds={openlab.setBrowserBounds}
        hideAllBrowsers={openlab.hideAllBrowsers}
        closeBrowserSession={openlab.closeBrowserSession}
        previewTerminalAction={openlab.previewTerminalAction}
      />
      <div className="chat-workspace-controls" data-testid="chat-workspace-controls">
        {rightPanelOpen && !workspaceOverlay && <button
          className={`workspace-maximize-toggle ${workspaceMaximized ? 'is-active' : ''}`}
          data-testid="workspace-maximize-toggle"
          title={workspaceMaximized ? copy.titlebar.restoreWorkspace : copy.titlebar.maximizeWorkspace}
          aria-label={workspaceMaximized ? copy.titlebar.restoreWorkspace : copy.titlebar.maximizeWorkspace}
          aria-pressed={workspaceMaximized}
          aria-controls="conversation-workspace"
          onClick={() => setWorkspaceMaximized((value) => !value)}
        >{workspaceMaximized ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button>}
        <button
          className={`conversation-workspace-toggle ${rightPanelOpen ? 'is-active' : ''}`}
          data-testid="titlebar-workspace-toggle"
          title={rightPanelOpen ? copy.titlebar.hideWorkspace : copy.titlebar.showWorkspace}
          aria-label={rightPanelOpen ? copy.titlebar.hideWorkspace : copy.titlebar.showWorkspace}
          aria-pressed={rightPanelOpen}
          aria-controls="conversation-workspace"
          onClick={toggleRightWorkspace}
        ><PanelRight size={16}/></button>
      </div>
      <button className={`chat-drawer-backdrop ${overlayOpen ? 'is-open' : 'is-closed'}`} data-testid="chat-drawer-backdrop" aria-label={copy.common.close} aria-hidden={!overlayOpen} disabled={!overlayOpen} onClick={closeOverlay}/>
    </div></div>
    <div className={`app-mode-layer app-mode-worktable ${mode === 'worktable' ? 'is-active' : ''}`} aria-hidden={mode !== 'worktable'} inert={mode !== 'worktable' ? true : undefined}>
      {mode === 'worktable' && <section className="worktable-reserved" data-testid="worktable-shell"><button type="button" className="worktable-reserved__return" data-testid="worktable-return-chat" title={worktableCopy.navigation.returnChat} aria-label={worktableCopy.navigation.returnChat} onClick={() => setMode('chat')}><ArrowLeft size={17}/></button></section>}
    </div>
    <div className={`app-mode-layer app-mode-channels ${mode === 'channels' ? 'is-active' : ''}`} aria-hidden={mode !== 'channels'} inert={mode !== 'channels' ? true : undefined}><ChannelsView snapshot={openlab.snapshot} timeZone={preferences.timeZone} onReturnToChat={() => setMode('chat')} onCreate={openlab.createChannel} onActivate={openlab.activateChannel} onUpdate={openlab.updateChannel} onArchive={openlab.archiveChannel} onExport={openlab.exportChannel}/></div>
    </div>
    {settingsOpen && <Suspense fallback={null}><SettingsModal
      open={settingsOpen}
      snapshot={openlab.snapshot}
      onClose={() => setSettingsOpen(false)}
      onRefresh={openlab.refresh}
      onInstallExtension={async (_kind, scope) => await openlab.installExtension('skill', scope)}
      onApproveSkill={openlab.approveSkill}
      onConfigureMcp={openlab.configureMcp}
      onMcpAction={openlab.mcpAction}
      onUpdateSettings={openlab.updateSettings}
      onUpdateUserProfile={openlab.updateUserProfile}
      onCreateAgent={openlab.createAgent}
      onUpdateAgent={openlab.updateAgent}
      onArchiveAgent={openlab.archiveAgentDefinition}
      onImportAgent={openlab.importAgent}
      onExportAgent={openlab.exportAgent}
      onSetAgentToolPolicy={openlab.setAgentToolPolicy}
      onSetProjectAgentCapabilities={openlab.setProjectAgentCapabilities}
      onListMemories={openlab.listMemories}
      onCreateMemory={openlab.createMemory}
      onUpdateMemory={openlab.updateMemory}
      onDeleteMemory={openlab.deleteMemory}
      onClearMemories={openlab.clearMemories}
      onConfigureProvider={openlab.configureProvider}
      onRefreshProvider={openlab.refreshProvider}
      onProviderOAuth={openlab.startProviderOAuth}
      onProviderLogout={openlab.logoutProviderOAuth}
      onExportDiagnostics={async () => { await window.openlab?.exportDiagnostics(); }}
      onBackupData={async () => { await window.openlab?.backupData(); }}
    /></Suspense>}
    <CreateProjectDialog open={createProjectOpen} onClose={() => setCreateProjectOpen(false)} onCreate={createProject}/>
    <CreateProjectDialog
      open={Boolean(projectFoldersEditor)}
      {...(projectFoldersInitial ? { initialProject: projectFoldersInitial } : {})}
      onClose={() => setProjectFoldersEditor(undefined)}
      onCreate={updateProjectFolders}
    />
    <AppDialogHost/>
    {!openlab.preview && !openlab.snapshot.primaryAgent.configured && <PrimaryAgentOnboarding onConfigure={openlab.configurePrimaryAgent}/>}
  </div>;
}
