interface OpenLabConnection {
  baseUrl: string;
  token: string;
  projectRoot: string;
  projectFolderSelected: boolean;
}

interface OpenLabAttachment {
  id: string;
  name: string;
  relativePath: string;
  sha256: string;
  size: number;
  mediaType?: string;
  rootId?: string;
}

interface Window {
  openlab?: {
    getConnection(): Promise<OpenLabConnection>;
    invalidateInactiveRuntimes(): Promise<boolean>;
    getInterfacePreferences(): Promise<import('@openlab/protocol').InterfacePreferences>;
    updateInterfacePreferences(patch: import('@openlab/protocol').InterfacePreferencesPatch): Promise<import('@openlab/protocol').InterfacePreferencesUpdateResult>;
    getWorktableUiState(instanceId: string): Promise<import('@openlab/protocol').WorktableDeviceUiState>;
    updateWorktableUiState(instanceId: string, patch: Partial<import('@openlab/protocol').WorktableDeviceUiState>): Promise<import('@openlab/protocol').WorktableDeviceUiState>;
    getDeepSeekKeyStatus(): Promise<{ configured: boolean; protected: boolean }>;
    setDeepSeekKey(value: string): Promise<{ configured: boolean; protected: boolean }>;
    saveCredential(value: string): Promise<string>;
    chooseProject(): Promise<OpenLabConnection | undefined>;
    selectProjectFolder(): Promise<{ path: string; name: string } | undefined>;
    activateProject(input: { sourceFolders: string[]; name: string }): Promise<OpenLabConnection>;
    stageProject(input: { sourceFolders: string[]; name: string }): Promise<import('@openlab/protocol').ConversationProjectTarget>;
    listProjects(): Promise<Array<{ projectId: string; rootPath: string; name: string; additionalRoots?: string[] }>>;
    renameProject(input: { projectId: string; rootPath: string; name: string }): Promise<import('@openlab/protocol').ConversationSourceDescriptor>;
    updateProjectFolders(input: { projectId: string; rootPath: string; sourceFolders: string[] }): Promise<import('@openlab/protocol').ConversationSourceDescriptor>;
    archiveProjectConversations(input: { projectId: string; rootPath: string }): Promise<{ archivedSessionIds: string[] }>;
    removeProject(input: { projectId: string; rootPath: string }): Promise<{ removed: true; connection?: OpenLabConnection }>;
    listConversationSources(): Promise<import('@openlab/protocol').ConversationSourceDescriptor[]>;
    prepareConversationTarget(target: import('@openlab/protocol').ConversationProjectTarget): Promise<boolean>;
    activateExistingProject(rootPath: string): Promise<OpenLabConnection>;
    getProjectContext(): Promise<{ rootPath: string; folderName: string; location: string; gitBranch?: string }>;
    clearProject(): Promise<OpenLabConnection>;
    openProjectFolder(): Promise<boolean>;
    openProjectRoot(rootPath: string): Promise<boolean>;
    startConversation(input: import('@openlab/protocol').DesktopConversationStartInput): Promise<import('@openlab/protocol').DesktopConversationStartResult>;
    activateConversation(input: import('@openlab/protocol').ConversationActivateInput): Promise<import('@openlab/protocol').DesktopConversationActivateResult>;
    chooseExtension(kind: 'skill' | 'plugin'): Promise<string | undefined>;
    chooseToolchain(): Promise<string | undefined>;
    chooseAttachments(): Promise<OpenLabAttachment[]>;
    importDroppedAttachments(files: File[]): Promise<OpenLabAttachment[]>;
    authorizeWorkspaceRoot(access: 'read_only' | 'ask' | 'trusted'): Promise<import('@openlab/protocol').WorkspaceRootSummary | undefined>;
    openWorkspacePath(ref: import('@openlab/protocol').WorkspacePathRef): Promise<boolean>;
    importWorkspaceFiles(directory: import('@openlab/protocol').WorkspacePathRef): Promise<string[]>;
    pathForDroppedFile(file: File): string;
    saveMessagePng(dataUrl: string, suggestedName: string): Promise<boolean>;
    writeClipboardText(value: string): Promise<boolean>;
    openExternal(url: string): Promise<boolean>;
    exportPlugin(id: string, name: string): Promise<boolean>;
    exportDiagnostics(): Promise<boolean>;
    backupData(): Promise<boolean>;
    browser: {
      list(): Promise<{ profiles: import('@openlab/protocol').BrowserProfileSummary[]; sessions: import('@openlab/protocol').BrowserSessionSummary[] }>;
      createProfile(input: { name: string; projectId: string }): Promise<import('@openlab/protocol').BrowserProfileSummary>;
      authorizeProfile(input: { profileId: string; projectId: string; confirmed: boolean }): Promise<import('@openlab/protocol').BrowserProfileSummary>;
      open(input: { profileId: string; projectId: string; instanceId: string; paneId: string; surface?: 'worktable' | 'workspace_preview'; url: string; confirmed: boolean }): Promise<import('@openlab/protocol').BrowserSessionSummary>;
      navigate(input: { sessionId: string; url: string; confirmed: boolean }): Promise<import('@openlab/protocol').BrowserSessionSummary>;
      history(input: { sessionId: string; action: 'back' | 'forward' | 'reload' }): Promise<import('@openlab/protocol').BrowserSessionSummary>;
      observe(sessionId: string): Promise<import('@openlab/protocol').BrowserObservation>;
      act(input: { sessionId: string; observationId: string; action: 'click' | 'type' | 'select' | 'press' | 'scroll'; ref?: string; value?: string; confirmed: boolean }): Promise<import('@openlab/protocol').BrowserObservation>;
      setBounds(input: { sessionId: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean }): Promise<boolean>;
      hideAll(): Promise<boolean>;
      close(sessionId: string): Promise<import('@openlab/protocol').BrowserSessionSummary>;
    };
    window: {
      newWindow(): Promise<boolean>;
      minimize(): void;
      maximize(): void;
      close(): void;
    };
    edit: {
      command(command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll'): void;
    };
    view: {
      command(command: 'zoom-in' | 'zoom-out' | 'reset-zoom' | 'toggle-fullscreen' | 'reload'): void;
      findInPage(query: string): void;
      openTerminal(): Promise<boolean>;
    };
  };
}
