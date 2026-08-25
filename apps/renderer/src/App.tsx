import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, FolderOpen, GitFork, Maximize2, Minimize2, PanelRight, RefreshCw, Sparkles, X } from 'lucide-react';
import type { AppMode, ChatAttachmentRef } from '@openlab/protocol';
import { Composer } from './components/Composer.js';
import { AppDialogHost } from './components/AppDialog.js';
import { ChannelsView } from './components/ChannelsView.js';
import { ConversationWorkspace } from './components/ConversationWorkspace.js';
import { CreateProjectDialog } from './components/CreateProjectDialog.js';
import { PrimaryAgentOnboarding } from './components/PrimaryAgentOnboarding.js';
import { SettingsModal } from './components/SettingsModal.js';
import { Sidebar } from './components/Sidebar.js';
import { Timeline } from './components/Timeline.js';
import { Titlebar } from './components/Titlebar.js';
import { loadChatLayoutPreferences, saveChatLayoutPreferences } from './lib/chat-layout.js';
import type { ChatLayoutPreferencesV1 } from './lib/chat-layout.js';
import { conversationFolderRoot } from './lib/conversation-folder.js';
import { loadSessionListPreferences, saveSessionListPreferences, sessionDisplayTitle, sessionWorkingFolderName } from './lib/session-list.js';
import type { SessionListPreferencesV1 } from './lib/session-list.js';
import { useOpenLab } from './lib/use-openlab.js';
import { useInterfacePreferences } from './lib/interface-preferences.js';
import { chatShellZhCN as shellCopy, hanaZhCN as copy } from './i18n/zh-CN.js';

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
    projectId,
    preferences: loadSessionListPreferences(projectId, window.localStorage),
  }));
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [workspaceFocusToken, setWorkspaceFocusToken] = useState(0);
  const [workspaceMaximized, setWorkspaceMaximized] = useState(false);
  const [draftConversationId, setDraftConversationId] = useState<string | null>(null);
  const [draftAgentBinding, setDraftAgentBinding] = useState(() => openlab.snapshot.sessionAgentBinding);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [projectContext, setProjectContext] = useState<{ rootPath: string; folderName: string; location: string; gitBranch?: string }>();
  const [actionError, setActionError] = useState<string>();
  const [sessionAttachments, setSessionAttachments] = useState<Record<string, ChatAttachmentRef[]>>({});
  const [sessionQuotes, setSessionQuotes] = useState<Record<string, Array<{ id: string; label: string }>>>({});

  const layout = layoutState.projectId === projectId
    ? layoutState.preferences
    : loadChatLayoutPreferences(projectId, window.localStorage);
  const sessionListPreferences = sessionListState.projectId === projectId
    ? sessionListState.preferences
    : loadSessionListPreferences(projectId, window.localStorage);
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
      const value = current.projectId === projectId ? current.preferences : loadSessionListPreferences(projectId, window.localStorage);
      return { projectId, preferences: update(value) };
    });
  }, [projectId]);

  useEffect(() => {
    if (layoutState.projectId !== projectId) {
      setLayoutState({ projectId, preferences: loadChatLayoutPreferences(projectId, window.localStorage) });
      return;
    }
    saveChatLayoutPreferences(projectId, layoutState.preferences, window.localStorage);
  }, [layoutState, projectId]);

  useEffect(() => {
    if (sessionListState.projectId !== projectId) {
      setSessionListState({ projectId, preferences: loadSessionListPreferences(projectId, window.localStorage) });
      return;
    }
    saveSessionListPreferences(projectId, sessionListState.preferences, window.localStorage);
  }, [projectId, sessionListState]);

  useEffect(() => {
    let active = true;
    void window.openlab?.getProjectContext().then((value) => { if (active) setProjectContext(value); }).catch(() => undefined);
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

  const isDraftConversation = draftConversationId !== null;
  const activeSession = useMemo(() => openlab.snapshot.sessions.find((session) => session.id === openlab.snapshot.activeSessionId) ?? openlab.snapshot.sessions[0], [openlab.snapshot.activeSessionId, openlab.snapshot.sessions]);
  const activeSessionTitle = isDraftConversation
    ? copy.app.newConversation
    : activeSession ? sessionDisplayTitle(activeSession, sessionListPreferences) : copy.app.newConversation;
  const activeWorkspaceRoot = conversationFolderRoot(openlab.snapshot.workspace, openlab.projectFolderSelected);
  const conversationFolderAvailable = Boolean(activeWorkspaceRoot);
  const openConversationFolder = useCallback(() => {
    if (conversationFolderAvailable && activeWorkspaceRoot) void window.openlab?.openWorkspacePath({ rootId: activeWorkspaceRoot.id, path: '' });
  }, [activeWorkspaceRoot, conversationFolderAvailable]);

  useEffect(() => {
    const onShellShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      } else if (event.key.toLocaleLowerCase('en-US') === 'p' && conversationFolderAvailable) {
        event.preventDefault();
        openConversationFolder();
      }
    };
    window.addEventListener('keydown', onShellShortcut);
    return () => window.removeEventListener('keydown', onShellShortcut);
  }, [conversationFolderAvailable, openConversationFolder]);
  const sessionKey = `${projectId}:${isDraftConversation ? `draft:${draftConversationId}` : activeSession?.id ?? 'new'}`;
  const injectedAttachments = sessionAttachments[sessionKey] ?? [];
  const quotedNodes = sessionQuotes[sessionKey] ?? [];
  const running = !isDraftConversation && (activeSession?.status === 'running' || openlab.snapshot.agentRuns.some((agent) => agent.role === 'lead' && agent.status === 'running'));
  const visibleAgentBinding = isDraftConversation ? draftAgentBinding : openlab.snapshot.sessionAgentBinding;
  const sessionMembers = openlab.snapshot.agentDefinitions.filter((agent) => visibleAgentBinding.memberAgentIds.includes(agent.id));
  const draftLeadAgent = openlab.snapshot.agentDefinitions.find((agent) => agent.id === visibleAgentBinding.leadAgentId);
  const draftAgentOptions = openlab.snapshot.agentDefinitions.filter((agent) => agent.status === 'active' && openlab.snapshot.projectAgents.some((binding) => binding.agentId === agent.id && binding.enabled));
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

  const openRightWorkspace = () => {
    if (compactLayout) setCompactPanel('right');
    updateLayout((current) => ({ ...current, rightWorkspaceOpen: true }));
    setWorkspaceFocusToken((value) => value + 1);
  };
  const changeWorkspaceTab = useCallback((workspaceTab: 'files' | 'workspace') => {
    updateLayout((current) => ({ ...current, workspaceTab }));
  }, [updateLayout]);

  const beginDraftConversation = () => {
    const id = crypto.randomUUID();
    setMode('chat');
    setDraftConversationId(id);
    setDraftAgentBinding({
      ...openlab.snapshot.sessionAgentBinding,
      sessionId: `draft:${id}`,
      capabilitySnapshotIds: [],
      updatedAt: new Date().toISOString(),
    });
    setWorkspaceMaximized(false);
    if (compactLayout) setCompactPanel(null);
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.app-mode-chat .composer textarea')?.focus());
  };

  const switchConversation = (id: string) => {
    setMode('chat');
    setDraftConversationId(null);
    if (compactLayout) setCompactPanel(null);
    void openlab.switchSession(id);
  };

  const sendConversation: typeof openlab.send = async (text, options) => {
    if (isDraftConversation) {
      const created = await openlab.createSession(draftAgentBinding.leadAgentId, draftAgentBinding.memberAgentIds);
      if (!created) throw new Error(copy.app.createSessionFailed);
      setDraftConversationId(null);
    }
    await openlab.send(text, options);
  };

  const toggleSessionPin = (id: string) => updateSessionListPreferences((current) => ({
    ...current,
    pinnedSessionIds: current.pinnedSessionIds.includes(id)
      ? current.pinnedSessionIds.filter((candidate) => candidate !== id)
      : [id, ...current.pinnedSessionIds],
  }));

  const renameSessionLocally = (id: string, title: string) => updateSessionListPreferences((current) => {
    const aliases = { ...current.aliases };
    const original = openlab.snapshot.sessions.find((session) => session.id === id)?.title;
    if (!title.trim() || title.trim() === original) delete aliases[id];
    else aliases[id] = title.trim();
    return { ...current, aliases };
  });

  useEffect(() => { void openlab.hideAllBrowsers(); }, [mode, openlab.hideAllBrowsers]);

  const chooseProject = () => setCreateProjectOpen(true);
  const createProject = async (input: { sourceFolders: string[]; name: string }) => {
    const selected = await window.openlab?.activateProject(input);
    if (selected) window.location.reload();
  };
  const leaveProject = async () => {
    const selected = await window.openlab?.clearProject();
    if (selected) window.location.reload();
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

  return <div className="app-shell">
    <Titlebar projectName={openlab.snapshot.project.name} projectFolderAvailable={conversationFolderAvailable} connected={openlab.connected} preview={openlab.preview} mode={mode} leftSidebarOpen={leftSidebarOpen} workspaceOpen={rightPanelOpen} onModeChange={setMode} onToggleLeftSidebar={toggleLeftSidebar} onToggleWorkspace={toggleRightWorkspace} onChooseProject={chooseProject} onOpenProjectFolder={openConversationFolder} onSettings={() => setSettingsOpen(true)}/>
    <div className="app-mode-stack">
    <div className={`app-mode-layer app-mode-chat ${mode === 'chat' ? 'is-active' : ''}`} aria-hidden={mode !== 'chat'} inert={mode !== 'chat' ? true : undefined}><div className={`workspace chat-workspace ${leftSidebarOpen ? 'has-left-sidebar' : ''} ${rightPanelOpen ? 'has-right-workspace' : ''} ${workspaceMaximized ? 'is-workspace-maximized' : ''} ${compactLayout ? 'is-compact-layout' : workspaceOverlay ? 'is-workspace-overlay' : 'is-wide-layout'}`}>
      <Sidebar
        open={leftSidebarOpen}
        project={openlab.snapshot.project}
        primaryAgent={openlab.snapshot.primaryAgent}
        sessions={openlab.snapshot.sessions}
        activeSessionId={isDraftConversation ? '' : openlab.snapshot.activeSessionId}
        sessionPreferences={sessionListPreferences}
        connected={openlab.connected}
        preview={openlab.preview}
        onNewSession={beginDraftConversation}
        onSwitchSession={switchConversation}
        onTogglePin={toggleSessionPin}
        onRenameSession={renameSessionLocally}
        onArchiveSession={(id) => void openlab.archiveSession(id)}
        onUnarchiveSession={(id) => void openlab.unarchiveSession(id)}
        onModeChange={setMode}
        onOpenWorkspace={openRightWorkspace}
        onSettings={() => setSettingsOpen(true)}
        onChooseProject={chooseProject}
        projectFolderAvailable={conversationFolderAvailable}
        onOpenProjectFolder={openConversationFolder}
      />
      <main className={`conversation-pane ${isDraftConversation ? 'is-draft-conversation' : ''}`}>
        <header className="conversation-header" data-testid="conversation-header">
          <div className="conversation-header__meta" data-testid="conversation-header-meta"><span className="conversation-header__icon" aria-hidden="true"><FolderOpen size={16}/></span><h1>{activeSessionTitle}</h1>{openlab.preview ? <span className="preview-chip">{copy.common.preview}</span> : !openlab.connected ? <span className="mode-chip offline"><CircleAlert size={12}/>{copy.titlebar.disconnected}</span> : null}</div>
          <div className="conversation-header__actions" data-testid="conversation-header-actions"><button data-testid="fork-session" title={copy.app.forkFull} disabled={isDraftConversation || !activeSession || running} onClick={() => !isDraftConversation && activeSession && void openlab.forkSession(activeSession.id)}><GitFork size={15}/></button>{conversationFolderAvailable && <button className="conversation-open-project" data-testid="conversation-open-project" title={shellCopy.workspace.openWithSystem} onClick={openConversationFolder}><FolderOpen size={15}/><span>{shellCopy.workspace.open}</span></button>}<button data-testid="refresh-snapshot" title={copy.common.refresh} onClick={() => void openlab.refresh()}><RefreshCw size={15}/></button></div>
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
          primaryAgent={openlab.snapshot.primaryAgent}
          timeZone={preferences.timeZone}
          sessionKey={sessionKey}
          emptyProjectName={isDraftConversation ? conversationFolderAvailable ? sessionWorkingFolderName(openlab.snapshot.project) : copy.timeline.noProject : undefined}
          onChooseProject={isDraftConversation ? chooseProject : undefined}
          emptyAgent={isDraftConversation ? {
            id: draftLeadAgent?.id ?? visibleAgentBinding.leadAgentId,
            name: draftLeadAgent?.name ?? openlab.snapshot.primaryAgent.name,
            avatar: draftLeadAgent?.avatar ?? openlab.snapshot.primaryAgent.avatar,
            memoryEnabled: draftLeadAgent?.memoryPolicy.memoryEnabled ?? true,
          } : undefined}
          emptyAgentOptions={isDraftConversation ? draftAgentOptions.map((agent) => ({ id: agent.id, name: agent.name, avatar: agent.avatar })) : undefined}
          onChooseAgent={isDraftConversation ? (leadAgentId) => setDraftAgentBinding((current) => ({
            ...current,
            leadAgentId,
            memberAgentIds: [...new Set([
              ...current.memberAgentIds.filter((id) => id !== leadAgentId),
              ...(current.leadAgentId && current.leadAgentId !== leadAgentId ? [current.leadAgentId] : []),
            ])],
            updatedAt: new Date().toISOString(),
          })) : undefined}
          onApprove={(id, approved) => void openlab.approve(id, approved)}
          onRegenerate={openlab.regenerateTurn}
          onFork={async (nodeId) => { if (!isDraftConversation && activeSession) await openlab.forkSession(activeSession.id, nodeId); }}
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
          running={running}
          projectContext={conversationFolderAvailable ? {
            name: openlab.snapshot.project.name,
            location: projectContext?.location ?? shellCopy.createProject.localEnvironment,
            ...(projectContext?.gitBranch ? { gitBranch: projectContext.gitBranch } : {}),
          } : undefined}
          onOpenProjectContext={openConversationFolder}
          onCreateProject={chooseProject}
          onLeaveProject={leaveProject}
          sessionKey={sessionKey}
          composerHeight={layout.composerHeight}
          onComposerHeightChange={(composerHeight) => updateLayout((current) => ({ ...current, composerHeight }))}
          injectedAttachments={injectedAttachments}
          quotedNodes={quotedNodes}
          onRemoveInjectedAttachment={removeInjectedAttachment}
          onRemoveQuotedNode={removeQuotedNode}
          onClearInjected={clearInjected}
          onOpenWorkspace={openRightWorkspace}
          onSend={sendConversation}
          onCancel={openlab.cancel}
        />
      </main>
      <ConversationWorkspace
        snapshot={conversationSnapshot}
        focusWorkspaceToken={workspaceFocusToken}
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
        installSkill={async () => await openlab.installExtension('skill')}
        installSkillSource={openlab.installSkillSource}
        approveSkill={openlab.approveSkill}
        onReferenceAttachment={referenceAttachment}
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
      <section className="worktable-rebuild-placeholder" data-testid="worktable-placeholder">
        <div className="worktable-rebuild-placeholder__mark"><Sparkles size={24}/></div>
        <h1>{copy.app.worktableRebuildTitle}</h1>
        <p>{copy.app.worktableRebuildDescription}</p>
        <button data-testid="worktable-return-chat" onClick={() => setMode('chat')}>{copy.app.returnToChat}</button>
      </section>
    </div>
    <div className={`app-mode-layer app-mode-channels ${mode === 'channels' ? 'is-active' : ''}`} aria-hidden={mode !== 'channels'} inert={mode !== 'channels' ? true : undefined}><ChannelsView snapshot={openlab.snapshot} timeZone={preferences.timeZone} onReturnToChat={() => setMode('chat')} onCreate={openlab.createChannel} onActivate={openlab.activateChannel} onUpdate={openlab.updateChannel} onArchive={openlab.archiveChannel} onExport={openlab.exportChannel}/></div>
    </div>
    <SettingsModal
      open={settingsOpen}
      snapshot={openlab.snapshot}
      onClose={() => setSettingsOpen(false)}
      onRefresh={openlab.refresh}
      onInstallExtension={async (_kind, scope) => await openlab.installExtension('skill', scope)}
      onApproveSkill={openlab.approveSkill}
      onConfigureMcp={openlab.configureMcp}
      onMcpAction={openlab.mcpAction}
      onUpdateSettings={openlab.updateSettings}
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
    />
    <CreateProjectDialog open={createProjectOpen} onClose={() => setCreateProjectOpen(false)} onCreate={createProject}/>
    <AppDialogHost/>
    {!openlab.preview && !openlab.snapshot.primaryAgent.configured && <PrimaryAgentOnboarding onConfigure={openlab.configurePrimaryAgent}/>}
  </div>;
}
