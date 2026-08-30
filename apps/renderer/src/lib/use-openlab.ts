import { chatShellZhCN as shellCopy, t, tf } from "./../i18n/zh-CN.js";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
    AgentCardExport, AgentDefinition, AgentDefinitionUpdate, AgentMemoryItem, AgentToolPolicy, Annotation, AnnotationSelector, ArtifactProvenance, ArtifactRevisionFile, BootstrapSnapshot, ChatAttachmentRef, CollaborationChannel, DocumentBuffer, DocumentRevisionRef, HarnessSettings, JobRecord, JobSpec, JsonValue, ModelProviderConfig, ModelProviderId, PermissionMode, PluginManifest, PrimaryAgentProfileUpdate, ProviderOAuthStartResult, ReasoningEffort, ResourceHandle, ServerPushMessage, SourceMapDescriptor,
    BrowserObservation, BrowserProfileSummary, BrowserSessionSummary, DesktopConversationStartInput, DesktopConversationStartResult, SessionSummary, TurnVariantGroup, UserProfileUpdate, WorkspaceAccessMode, WorkspaceEditGroup, WorkspaceEditPreview, WorkspaceEditRequest, WorkspaceEntry, WorkspacePathRef, WorkspacePreview, WorkspaceRootSummary, WorkspaceSearchResult, WorkbenchState,
    WorktableContent, WorktableDeviceUiState, WorktableInstance, WorktablePane, WorktableRevealTarget, WorktableSplitNode, WorktableState, WorktableTab,
} from '@openlab/protocol';
import type { McpServerConfig } from '@openlab/protocol';
import { mockSnapshot } from './mock-snapshot.js';
import { RuntimeClient } from './runtime-client.js';
import { confirmInApp } from '../components/AppDialog.js';
function applyMessage(snapshot: BootstrapSnapshot, message: ServerPushMessage): BootstrapSnapshot {
    if (message.type === 'snapshot')
        return message.snapshot;
    if (message.type === 'sessions.changed') {
        const currentProjectIds = new Set(message.sessions.map((session) => session.projectId));
        const retained = (snapshot.sessionCatalog ?? snapshot.sessions).filter((session) => !currentProjectIds.has(session.projectId));
        return {
            ...snapshot,
            sessions: message.sessions,
            sessionCatalog: [...message.sessions.filter((session) => !session.temporary), ...retained]
                .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
            activeSessionId: message.activeSessionId,
        };
    }
    if (message.type === 'timeline.append')
        return { ...snapshot, timeline: [...snapshot.timeline, message.node] };
    if (message.type === 'timeline.patch')
        return { ...snapshot, timeline: snapshot.timeline.map((node) => node.id === message.id ? { ...node, ...message.patch } : node) };
    if (message.type === 'workspace.changed')
        return { ...snapshot, workspace: message.workspace };
    if (message.type === 'conversation-files.changed')
        return { ...snapshot, conversationFiles: message.files, workspace: { ...snapshot.workspace, conversationFileCount: message.files.length } };
    if (message.type === 'turn-variants.changed')
        return { ...snapshot, turnVariants: message.variants };
    if (message.type === 'providers.changed')
        return { ...snapshot, providers: message.providers, models: message.models };
    if (message.type === 'profile.changed')
        return { ...snapshot, primaryAgent: message.profile };
    if (message.type === 'user-profile.changed')
        return { ...snapshot, userProfile: message.profile };
    if (message.type === 'agent-definitions.changed')
        return { ...snapshot, agentDefinitions: message.definitions, projectAgents: message.projectAgents };
    if (message.type === 'session-agents.changed')
        return { ...snapshot, sessionAgentBinding: message.binding, agentRuns: message.runs, tasks: message.tasks };
    if (message.type === 'agent-memory.changed')
        return { ...snapshot, memorySummaries: message.summaries };
    if (message.type === 'agent-tools.changed')
        return { ...snapshot, toolCapabilities: message.capabilities };
    if (message.type === 'channels.changed')
        return { ...snapshot, channels: message.channels, ...(message.activeChannelId ? { activeChannelId: message.activeChannelId } : {}) };
    if (message.type === 'channel-messages.changed')
        return message.channelId === snapshot.activeChannelId ? { ...snapshot, activeChannelMessages: message.messages } : snapshot;
    if (message.type === 'context.changed')
        return { ...snapshot, contextPlan: message.plan };
    if (message.type === 'research.changed')
        return { ...snapshot, researchObjects: message.objects, relations: message.relations, provenance: message.provenance };
    if (message.type === 'workspace-edits.changed')
        return { ...snapshot, workspaceEditPreviews: message.previews, workspaceEditGroups: message.groups };
    if (message.type === 'workbench.changed')
        return { ...snapshot, workbench: message.workbench, workbenchContributions: message.contributions };
    if (message.type === 'worktable.changed')
        return { ...snapshot, worktable: message.worktable, worktableTemplates: message.templates };
    if (message.type === 'workbench-v1.changed')
        return { ...snapshot, workbenchBlueprints: message.blueprints, workbenchInstances: message.instances, layoutProposals: message.proposals };
    if (message.type === 'scientific-kernel.changed')
        return { ...snapshot, evidenceAnchors: message.evidenceAnchors, runRecords: message.runs, reviewRequests: message.reviews };
    if (message.type === 'browser.changed')
        return { ...snapshot, browserProfiles: message.profiles, browserSessions: message.sessions };
    if (message.type === 'generated-app.changed')
        return { ...snapshot, generatedApps: message.apps };
    if (message.type === 'generated-blueprints.changed')
        return { ...snapshot, generatedAppBlueprints: message.blueprints };
    if (message.type === 'annotations.changed')
        return { ...snapshot, annotations: message.annotations, annotationSets: message.annotationSets };
    if (message.type === 'artifact-revisions.changed')
        return { ...snapshot, artifactRevisions: message.revisions };
    if (message.type === 'source-maps.changed')
        return { ...snapshot, sourceMaps: message.sourceMaps };
    if (message.type === 'jobs.changed')
        return { ...snapshot, jobs: message.jobs };
    if (message.type === 'toolchains.changed')
        return { ...snapshot, toolchains: message.toolchains };
    if (message.type === 'tool-runs.changed')
        return { ...snapshot, toolchainAdapters: message.adapters, toolRuns: message.runs };
    if (message.type === 'paper-readers.changed')
        return { ...snapshot, paperReaders: message.readers };
    if (message.type === 'approval.changed')
        return { ...snapshot, pendingApprovals: message.approvals };
    return snapshot;
}
export function useOpenLab() {
    const client = useMemo(() => new RuntimeClient(), []);
    const [snapshot, setSnapshot] = useState<BootstrapSnapshot>(mockSnapshot);
    const [connected, setConnected] = useState(false);
    const [preview, setPreview] = useState(true);
    const [projectFolderSelected, setProjectFolderSelected] = useState(false);
    const [error, setError] = useState<string>();
    const [capabilityNotice, setCapabilityNotice] = useState<{ revision: number; reason: string }>();
    const mounted = useRef(true);
    const socketDispose = useRef<(() => void) | undefined>(undefined);
    const connectionGeneration = useRef(0);
    useEffect(() => {
        mounted.current = true;
        const generation = ++connectionGeneration.current;
        let dispose: (() => void) | undefined;
        let retry: number | undefined;
        let stopped = false;
        const initialize = async () => {
            try {
                const connection = await client.connect();
                const initial = await client.bootstrap();
                if (stopped || !mounted.current || generation !== connectionGeneration.current)
                    return;
                setSnapshot(initial);
                setProjectFolderSelected(connection.projectFolderSelected);
                setPreview(false);
                setError(undefined);
                dispose = await client.socket((message) => {
                    if (stopped || !mounted.current || generation !== connectionGeneration.current) return;
                    if (message.type === 'capabilities.changed') setCapabilityNotice({ revision: message.revision, reason: message.reason });
                    setSnapshot((current) => applyMessage(current, message));
                }, (value) => { if (!stopped && mounted.current && generation === connectionGeneration.current) setConnected(value); });
                if (stopped || generation !== connectionGeneration.current) dispose();
                else socketDispose.current = dispose;
            }
            catch (cause) {
                if (stopped || !mounted.current || generation !== connectionGeneration.current)
                    return;
                client.resetConnection();
                setConnected(false);
                setError(cause instanceof Error ? cause.message : String(cause));
                setPreview(true);
                retry = window.setTimeout(() => {
                    retry = undefined;
                    void initialize();
                }, 800);
            }
        };
        void initialize();
        return () => {
            stopped = true;
            mounted.current = false;
            connectionGeneration.current++;
            if (retry !== undefined)
                window.clearTimeout(retry);
            const activeSocket = socketDispose.current;
            socketDispose.current = undefined;
            activeSocket?.();
            if (dispose && activeSocket !== dispose) dispose();
        };
    }, [client]);
    const replaceConnection = useCallback(async (connection: OpenLabConnection, preparedSnapshot?: BootstrapSnapshot) => {
        const generation = ++connectionGeneration.current;
        const previousSocket = socketDispose.current;
        socketDispose.current = undefined;
        previousSocket?.();
        client.replaceConnection(connection);
        try {
            const initial = preparedSnapshot ?? await client.bootstrap();
            if (!mounted.current || generation !== connectionGeneration.current) return;
            setSnapshot(initial);
            setProjectFolderSelected(connection.projectFolderSelected);
            setPreview(false);
            setError(undefined);
            const dispose = await client.socket((message) => {
                if (!mounted.current || generation !== connectionGeneration.current) return;
                if (message.type === 'capabilities.changed') setCapabilityNotice({ revision: message.revision, reason: message.reason });
                setSnapshot((current) => applyMessage(current, message));
            }, (value) => {
                if (mounted.current && generation === connectionGeneration.current) setConnected(value);
            });
            if (!mounted.current || generation !== connectionGeneration.current) dispose();
            else socketDispose.current = dispose;
        } catch (cause) {
            if (!mounted.current || generation !== connectionGeneration.current) return;
            client.resetConnection();
            setConnected(false);
            setError(cause instanceof Error ? cause.message : String(cause));
            throw cause;
        }
    }, [client]);
    const refresh = useCallback(async () => {
        const next = await client.bootstrap();
        setSnapshot(next);
        setPreview(false);
    }, [client]);
    const send = useCallback(async (text: string, options: {
        model?: string;
        thinking?: 'enabled' | 'disabled';
        reasoningEffort?: ReasoningEffort;
        permissionMode?: PermissionMode;
        interfaceLocale?: string;
        skillIds?: string[];
        attachments?: ChatAttachmentRef[];
        researchObjectIds?: string[];
        mentionedAgentIds?: string[];
        quotedNodeIds?: string[];
    }) => {
        if (preview) {
            const now = new Date().toISOString();
            setSnapshot((current) => ({ ...current, timeline: [...current.timeline, { id: crypto.randomUUID(), kind: 'user', content: text, timestamp: now, metadata: {} }, { id: crypto.randomUUID(), kind: 'assistant', title: t("copy267"), content: t("copy268"), status: 'completed', timestamp: now, metadata: {} }] }));
            return;
        }
        await client.request('/api/chat', { method: 'POST', body: JSON.stringify({ text, ...options }) });
    }, [client, preview]);
    const approve = useCallback(async (id: string, approved: boolean) => {
        if (preview) {
            setSnapshot((current) => ({ ...current, pendingApprovals: current.pendingApprovals.filter((item) => item.id !== id) }));
            return;
        }
        await client.request(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ approved }) });
    }, [client, preview]);
    const cancel = useCallback(async () => {
        if (!preview)
            await client.request('/api/chat/cancel', { method: 'POST', body: '{}' });
    }, [client, preview]);
    const createSession = useCallback(async (leadAgentId?: string, memberAgentIds: string[] = [], temporary = false): Promise<SessionSummary | undefined> => {
        if (preview) {
            const now = new Date().toISOString();
            const id = crypto.randomUUID();
            const session: SessionSummary = { id, projectId: snapshot.project.id, title: temporary ? shellCopy.titlebar.temporaryChat : t("copy001"), status: 'idle', updatedAt: now, model: snapshot.models[0]?.id ?? '', ...(temporary ? { temporary: true } : {}) };
            setSnapshot((current) => ({
                ...current,
                sessions: [...current.sessions, session],
                activeSessionId: id,
                timeline: [],
                pendingApprovals: [],
                turnVariants: [],
                agentRuns: [],
                tasks: [],
                sessionAgentBinding: {
                    sessionId: id,
                    leadAgentId: leadAgentId ?? current.sessionAgentBinding.leadAgentId,
                    memberAgentIds,
                    capabilitySnapshotIds: [],
                    updatedAt: now,
                },
            }));
            return session;
        }
        const created = await client.request<SessionSummary>('/api/sessions', { method: 'POST', body: JSON.stringify({ title: temporary ? shellCopy.titlebar.temporaryChat : t("copy001"), ...(leadAgentId ? { leadAgentId } : {}), memberAgentIds, temporary }) });
        await refresh();
        return created;
    }, [client, preview, refresh, snapshot.models, snapshot.project.id]);
    const startConversation = useCallback(async (input: DesktopConversationStartInput): Promise<DesktopConversationStartResult> => {
        if (!window.openlab || preview) throw new Error(shellCopy.runtimeUnavailableForConversation);
        const started = await window.openlab.startConversation(input);
        await replaceConnection(started.connection, started.snapshot);
        return started;
    }, [preview, replaceConnection]);
    const switchSession = useCallback(async (id: string) => {
        if (preview) {
            setSnapshot((current) => ({ ...current, activeSessionId: id }));
            return;
        }
        const next = await client.request<BootstrapSnapshot>(`/api/sessions/${id}/activate`, { method: 'POST', body: '{}' });
        setSnapshot(next);
        setPreview(false);
    }, [client, preview]);
    const archiveSession = useCallback(async (id: string) => {
        if (preview) {
            setSnapshot((current) => {
                const sessions = current.sessions.map((session) => session.id === id ? { ...session, status: 'archived' as const } : session);
                const nextActive = sessions.find((session) => session.status !== 'archived')?.id ?? current.activeSessionId;
                return { ...current, sessions, activeSessionId: nextActive };
            });
            return;
        }
        await client.request(`/api/sessions/${id}/archive`, { method: 'POST', body: '{}' });
        await refresh();
    }, [client, preview, refresh]);
    const unarchiveSession = useCallback(async (id: string) => {
        if (preview) {
            setSnapshot((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === id ? { ...session, status: 'idle' as const } : session) }));
            return;
        }
        await client.request(`/api/sessions/${id}/unarchive`, { method: 'POST', body: '{}' });
        await refresh();
    }, [client, preview, refresh]);
    const forkSession = useCallback(async (id: string, throughNodeId?: string) => {
        if (preview)
            return;
        await client.request(`/api/sessions/${id}/fork`, { method: 'POST', body: JSON.stringify({ ...(throughNodeId ? { throughNodeId } : {}) }) });
        await refresh();
    }, [client, preview, refresh]);

    const forkSessionBefore = useCallback(async (id: string, beforeNodeId: string): Promise<SessionSummary | undefined> => {
        if (preview)
            return undefined;
        const created = await client.request<SessionSummary>(`/api/sessions/${id}/fork`, { method: 'POST', body: JSON.stringify({ beforeNodeId }) });
        await refresh();
        return created;
    }, [client, preview, refresh]);

    const regenerateTurn = useCallback(async (turnId: string) => {
        if (preview) return;
        await client.request('/api/chat/regenerate', { method: 'POST', body: JSON.stringify({ turnId }) });
    }, [client, preview]);
    const activateTurnVariant = useCallback(async (turnId: string, variantId: string): Promise<TurnVariantGroup | undefined> => {
        if (preview) return undefined;
        return await client.request(`/api/turns/${encodeURIComponent(turnId)}/variants/${encodeURIComponent(variantId)}/activate`, { method: 'POST', body: '{}' });
    }, [client, preview]);
    const listWorkspace = useCallback(async (ref: WorkspacePathRef, options: { showHidden?: boolean; sort?: 'name' | 'modified'; order?: 'asc' | 'desc' } = {}): Promise<WorkspaceEntry[]> => {
        if (preview) return [];
        const query = new URLSearchParams({ rootId: ref.rootId, path: ref.path, ...(options.showHidden ? { showHidden: 'true' } : {}), ...(options.sort ? { sort: options.sort } : {}), ...(options.order ? { order: options.order } : {}) });
        return await client.request(`/api/workspace/entries?${query}`);
    }, [client, preview]);
    const searchWorkspace = useCallback(async (rootId: string, queryText: string, options: { showHidden?: boolean; includeContent?: boolean } = {}): Promise<WorkspaceSearchResult[]> => {
        if (preview) return [];
        const query = new URLSearchParams({ rootId, query: queryText, ...(options.showHidden ? { showHidden: 'true' } : {}), ...(options.includeContent ? { includeContent: 'true' } : {}) });
        return await client.request(`/api/workspace/search?${query}`);
    }, [client, preview]);
    const previewWorkspace = useCallback(async (ref: WorkspacePathRef): Promise<WorkspacePreview> => await client.request('/api/workspace/preview', { method: 'POST', body: JSON.stringify(ref) }), [client]);
    const createWorkspaceAttachment = useCallback(async (ref: WorkspacePathRef): Promise<ChatAttachmentRef> => await client.request('/api/workspace/attachment-ref', { method: 'POST', body: JSON.stringify(ref) }), [client]);
    const saveWorkspaceNote = useCallback(async (note: string) => {
        if (preview) { setSnapshot((current) => ({ ...current, workspace: { ...current.workspace, note } })); return; }
        await client.request('/api/workspace/note', { method: 'POST', body: JSON.stringify({ note }) });
    }, [client, preview]);
    const activateWorkspaceRoot = useCallback(async (rootId: string) => {
        if (preview) return;
        await client.request(`/api/workspace/roots/${encodeURIComponent(rootId)}/activate`, { method: 'POST', body: '{}' });
        await refresh();
    }, [client, preview, refresh]);
    const confirmWorkspaceRoot = useCallback(async (rootId: string) => {
        if (preview) return;
        await client.request(`/api/workspace/roots/${encodeURIComponent(rootId)}/confirm`, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
        await refresh();
    }, [client, preview, refresh]);
    const revokeWorkspaceRoot = useCallback(async (rootId: string) => {
        if (preview) return;
        await client.request(`/api/workspace/roots/${encodeURIComponent(rootId)}/revoke`, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
        await refresh();
    }, [client, preview, refresh]);
    const authorizeWorkspaceRoot = useCallback(async (access: WorkspaceAccessMode): Promise<WorkspaceRootSummary | undefined> => {
        if (!window.openlab || preview) return undefined;
        const root = await window.openlab.authorizeWorkspaceRoot(access);
        if (root) await refresh();
        return root;
    }, [preview, refresh]);
    const operateWorkspaceFile = useCallback(async (operation: Record<string, unknown>, confirmed = false): Promise<{ id: string }> => {
        const result = await client.request<{ id: string }>('/api/workspace/files/operate', { method: 'POST', body: JSON.stringify({ operation, confirmed }) });
        await refresh();
        return result;
    }, [client, refresh]);
    const undoWorkspaceFile = useCallback(async (id: string) => {
        await client.request(`/api/workspace/files/${encodeURIComponent(id)}/undo`, { method: 'POST', body: '{}' });
        await refresh();
    }, [client, refresh]);
    const addConversationFile = useCallback(async (ref: WorkspacePathRef, origin: 'upload' | 'reference' | 'agent' | 'artifact' = 'reference') => {
        await client.request('/api/workspace/conversation-files', { method: 'POST', body: JSON.stringify({ ref, origin }) });
    }, [client]);
    const removeConversationFile = useCallback(async (id: string) => {
        await client.request(`/api/workspace/conversation-files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }, [client]);
    const openWorkbench = useCallback(async (input: { title: string; workbenchId: string; document?: DocumentRevisionRef; artifactId?: string; artifactRevisionId?: string; activeViewId?: string }): Promise<WorkbenchState> => {
        if (preview) {
            const state: WorkbenchState = { tabs: [{ id: crypto.randomUUID(), title: input.title, workbenchId: input.workbenchId, ...(input.document ? { document: input.document } : {}), activeViewId: input.activeViewId ?? 'source', openedAt: new Date().toISOString() }], maximized: false };
            const activeTabId = state.tabs[0]?.id;
            if (activeTabId) state.activeTabId = activeTabId;
            setSnapshot((current) => ({ ...current, workbench: state }));
            return state;
        }
        const state = await client.request<WorkbenchState>('/api/workbench/open', { method: 'POST', body: JSON.stringify(input) });
        setSnapshot((current) => ({ ...current, workbench: state }));
        return state;
    }, [client, preview]);
    const updateWorkbench = useCallback(async (path: string, init: RequestInit): Promise<WorkbenchState> => {
        if (preview) return snapshot.workbench;
        const state = await client.request<WorkbenchState>(path, init);
        setSnapshot((current) => ({ ...current, workbench: state }));
        return state;
    }, [client, preview, snapshot.workbench]);
    const closeWorkbench = useCallback(async (tabId: string) => await updateWorkbench(`/api/workbench/${encodeURIComponent(tabId)}`, { method: 'DELETE' }), [updateWorkbench]);
    const activateWorkbench = useCallback(async (tabId: string) => await updateWorkbench(`/api/workbench/${encodeURIComponent(tabId)}/activate`, { method: 'POST', body: '{}' }), [updateWorkbench]);
    const setWorkbenchView = useCallback(async (tabId: string, viewId: string) => await updateWorkbench(`/api/workbench/${encodeURIComponent(tabId)}/view`, { method: 'POST', body: JSON.stringify({ viewId }) }), [updateWorkbench]);
    const maximizeWorkbench = useCallback(async (maximized: boolean) => await updateWorkbench('/api/workbench/maximized', { method: 'POST', body: JSON.stringify({ maximized }) }), [updateWorkbench]);
    const updateWorktableState = useCallback(async (path: string, init: RequestInit): Promise<WorktableState> => {
        const state = await client.request<WorktableState>(path, init);
        setSnapshot((current) => ({ ...current, worktable: state }));
        return state;
    }, [client]);
    const mergeWorktableInstance = useCallback((instance: WorktableInstance): WorktableInstance => {
        setSnapshot((current) => ({
            ...current,
            worktable: {
                ...current.worktable,
                instances: current.worktable.instances.some((candidate) => candidate.id === instance.id)
                    ? current.worktable.instances.map((candidate) => candidate.id === instance.id ? instance : candidate)
                    : [instance, ...current.worktable.instances],
                activeInstanceId: current.worktable.activeInstanceId ?? instance.id,
            },
        }));
        return instance;
    }, []);
    const createWorktableInstance = useCallback(async (input: { templateId?: string; title?: string; inputs?: Record<string, JsonValue>; boundSessionId?: string }): Promise<WorktableInstance | undefined> => {
        if (preview) {
            const template = snapshot.worktableTemplates.find((candidate) => candidate.id === input.templateId) ?? snapshot.worktableTemplates[0];
            const now = new Date().toISOString();
            const instance: WorktableInstance = {
                id: crypto.randomUUID(), projectId: snapshot.project.id, ...(template ? { templateId: template.id } : {}),
                title: input.title?.trim() || template?.title || 'Worktable', icon: template?.icon ?? 'flask',
                kind: template?.kind ?? 'research', status: 'idle', revision: 1, inputs: input.inputs ?? {}, ...(input.boundSessionId ? { boundSessionId: input.boundSessionId } : {}),
                layout: template ? structuredClone(template.layout) : { kind: 'pane', paneId: 'control' },
                panes: template ? structuredClone(template.panes) : [{ id: 'control', tabs: [{ id: crypto.randomUUID(), title: 'Control room', content: { kind: 'builtin', type: 'control-room' }, openedAt: now }] }],
                createdAt: now, updatedAt: now,
            };
            if (instance.panes[0]) instance.activePaneId = instance.panes[0].id;
            setSnapshot((current) => ({ ...current, worktable: { instances: [instance, ...current.worktable.instances], activeInstanceId: instance.id } }));
            return instance;
        }
        const result = await client.request<{ worktable: WorktableState; instance: WorktableInstance }>('/api/worktable/instances', { method: 'POST', body: JSON.stringify(input) });
        setSnapshot((current) => ({ ...current, worktable: result.worktable }));
        return result.instance;
    }, [client, mergeWorktableInstance, preview, snapshot.project.id, snapshot.worktableTemplates]);
    const activateWorktableInstance = useCallback(async (id: string): Promise<WorktableState> => {
        if (preview) {
            const state = { ...snapshot.worktable, activeInstanceId: id };
            setSnapshot((current) => ({ ...current, worktable: state }));
            return state;
        }
        return await updateWorktableState(`/api/worktable/instances/${encodeURIComponent(id)}/activate`, { method: 'POST', body: '{}' });
    }, [preview, snapshot.worktable, updateWorktableState]);
    type WorktablePatch = Partial<Pick<WorktableInstance, 'title' | 'status' | 'layout' | 'panes' | 'activePaneId'>> & { boundSessionId?: string | null };
    const updateWorktableInstance = useCallback(async (id: string, patch: WorktablePatch): Promise<WorktableInstance> => {
        if (preview) {
            let updated: WorktableInstance | undefined;
            const state: WorktableState = { ...snapshot.worktable, instances: snapshot.worktable.instances.map((instance) => {
                if (instance.id !== id) return instance;
                const { boundSessionId: _previous, ...withoutBinding } = instance;
                if (patch.boundSessionId === null) {
                    const { boundSessionId: _patchBinding, ...rest } = patch;
                    updated = { ...withoutBinding, ...rest, updatedAt: new Date().toISOString() };
                    return updated;
                }
                updated = { ...instance, ...patch, updatedAt: new Date().toISOString() } as WorktableInstance;
                return updated;
            }) };
            setSnapshot((current) => ({ ...current, worktable: state }));
            if (!updated) throw new Error('Worktable instance not found');
            return updated;
        }
        return mergeWorktableInstance(await client.request<WorktableInstance>(`/api/worktable/instances/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }));
    }, [client, mergeWorktableInstance, preview, snapshot.worktable]);
    const archiveWorktableInstance = useCallback(async (id: string): Promise<WorktableInstance> => {
        if (preview) return await updateWorktableInstance(id, { status: 'archived' });
        return mergeWorktableInstance(await client.request<WorktableInstance>(`/api/worktable/instances/${encodeURIComponent(id)}/archive`, { method: 'POST', body: '{}' }));
    }, [client, mergeWorktableInstance, preview, updateWorktableInstance]);
    const restoreWorktableInstance = useCallback(async (id: string): Promise<WorktableInstance> => {
        if (preview) {
            const current = snapshot.worktable.instances.find((candidate) => candidate.id === id);
            if (!current || current.status !== 'archived') throw new Error('Worktable instance is not archived');
            const { archivedAt: _archivedAt, ...rest } = current;
            const restored: WorktableInstance = { ...rest, status: 'idle', revision: current.revision + 1, updatedAt: new Date().toISOString() };
            setSnapshot((value) => ({ ...value, worktable: { ...value.worktable, instances: value.worktable.instances.map((candidate) => candidate.id === id ? restored : candidate) } }));
            return restored;
        }
        return mergeWorktableInstance(await client.request<WorktableInstance>(`/api/worktable/instances/${encodeURIComponent(id)}/restore`, { method: 'POST', body: '{}' }));
    }, [client, mergeWorktableInstance, preview, snapshot.worktable.instances]);
    const setWorktableLayout = useCallback(async (id: string, layout: WorktableSplitNode, panes: WorktablePane[], activePaneId?: string): Promise<WorktableInstance> => {
        if (preview) return await updateWorktableInstance(id, { layout, panes, ...(activePaneId ? { activePaneId } : {}) });
        return mergeWorktableInstance(await client.request<WorktableInstance>(`/api/worktable/instances/${encodeURIComponent(id)}/layout`, { method: 'POST', body: JSON.stringify({ layout, panes, ...(activePaneId ? { activePaneId } : {}) }) }));
    }, [client, mergeWorktableInstance, preview, updateWorktableInstance]);
    const decideWorkbenchLayoutProposal = useCallback(async (id: string, accepted: boolean) => {
        if (preview) return undefined;
        const proposal = await client.request(`/api/workbench-v1/layout-proposals/${encodeURIComponent(id)}/decision`, { method: 'POST', body: JSON.stringify({ accepted, confirmed: true }) });
        await refresh();
        return proposal;
    }, [client, preview, refresh]);
    const proposeWorkbenchLayout = useCallback(async (input: {
        instanceId: string;
        baseRevision: number;
        title: string;
        reason: string;
        layout: WorktableSplitNode;
        panes: WorktablePane[];
        slots: import('@openlab/protocol').WorkbenchSlotV1[];
    }) => {
        if (preview) throw new Error(shellCopy.previewLayoutProposalUnsupported);
        const { instanceId, ...body } = input;
        const proposal = await client.request(`/api/workbench-v1/instances/${encodeURIComponent(instanceId)}/layout-proposals`, { method: 'POST', body: JSON.stringify(body) });
        await refresh();
        return proposal;
    }, [client, preview, refresh]);
    const mountWorktableContent = useCallback(async (instanceId: string, paneId: string, input: { title: string; content: WorktableContent }): Promise<WorktableTab> => {
        if (preview) {
            const instance = snapshot.worktable.instances.find((candidate) => candidate.id === instanceId);
            if (!instance) throw new Error('Worktable instance not found');
            const tab: WorktableTab = { id: crypto.randomUUID(), title: input.title, content: input.content, openedAt: new Date().toISOString() };
            const panes = instance.panes.map((pane) => pane.id === paneId ? { ...pane, tabs: [...pane.tabs, tab], activeTabId: tab.id } : pane);
            await updateWorktableInstance(instanceId, { panes, activePaneId: paneId });
            return tab;
        }
        return await client.request<WorktableTab>(`/api/worktable/instances/${encodeURIComponent(instanceId)}/panes/${encodeURIComponent(paneId)}/tabs`, { method: 'POST', body: JSON.stringify(input) });
    }, [client, preview, snapshot.worktable, updateWorktableInstance]);
    const activateWorktableTab = useCallback(async (instanceId: string, paneId: string, tabId: string): Promise<WorktableInstance> => {
        if (preview) {
            const instance = snapshot.worktable.instances.find((candidate) => candidate.id === instanceId);
            if (!instance) throw new Error('Worktable instance not found');
            return await updateWorktableInstance(instanceId, { panes: instance.panes.map((pane) => pane.id === paneId ? { ...pane, activeTabId: tabId } : pane), activePaneId: paneId });
        }
        return mergeWorktableInstance(await client.request<WorktableInstance>(`/api/worktable/instances/${encodeURIComponent(instanceId)}/panes/${encodeURIComponent(paneId)}/activate`, { method: 'POST', body: JSON.stringify({ tabId }) }));
    }, [client, mergeWorktableInstance, preview, snapshot.worktable, updateWorktableInstance]);
    const closeWorktableTab = useCallback(async (instanceId: string, paneId: string, tabId: string): Promise<WorktableInstance> => {
        if (preview) {
            const instance = snapshot.worktable.instances.find((candidate) => candidate.id === instanceId);
            if (!instance) throw new Error('Worktable instance not found');
            const panes = instance.panes.map((pane) => {
                if (pane.id !== paneId) return pane;
                const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
                const activeTabId = pane.activeTabId === tabId ? tabs.at(-1)?.id : pane.activeTabId;
                const { activeTabId: _previous, ...base } = pane;
                return { ...base, tabs, ...(activeTabId ? { activeTabId } : {}) };
            });
            return await updateWorktableInstance(instanceId, { panes });
        }
        return mergeWorktableInstance(await client.request<WorktableInstance>(`/api/worktable/instances/${encodeURIComponent(instanceId)}/panes/${encodeURIComponent(paneId)}/tabs/${encodeURIComponent(tabId)}`, { method: 'DELETE' }));
    }, [client, mergeWorktableInstance, preview, snapshot.worktable, updateWorktableInstance]);
    const syncBrowserBridge = useCallback(async (): Promise<{ profiles: BrowserProfileSummary[]; sessions: BrowserSessionSummary[] } | undefined> => {
        if (!window.openlab || preview) return undefined;
        const state = await window.openlab.browser.list();
        await client.request('/api/browser/state', { method: 'POST', body: JSON.stringify(state) });
        setSnapshot((current) => ({ ...current, browserProfiles: state.profiles, browserSessions: state.sessions }));
        return state;
    }, [client, preview]);
    const createBrowserProfile = useCallback(async (name: string): Promise<BrowserProfileSummary | undefined> => {
        if (!window.openlab || preview) return undefined;
        const created = await window.openlab.browser.createProfile({ name, projectId: snapshot.project.id });
        await syncBrowserBridge();
        return created;
    }, [preview, snapshot.project.id, syncBrowserBridge]);
    const openBrowserSession = useCallback(async (input: { profileId: string; instanceId: string; paneId: string; surface?: 'worktable' | 'workspace_preview'; url?: string }): Promise<BrowserSessionSummary | undefined> => {
        if (!window.openlab || preview) return undefined;
        const opened = await window.openlab.browser.open({ ...input, projectId: snapshot.project.id, url: input.url ?? 'https://', confirmed: true });
        await syncBrowserBridge();
        return opened;
    }, [preview, snapshot.project.id, syncBrowserBridge]);
    const browserObserve = useCallback(async (sessionId: string): Promise<BrowserObservation | undefined> => {
        if (!window.openlab || preview) return undefined;
        const observed = await window.openlab.browser.observe(sessionId);
        await syncBrowserBridge();
        return observed;
    }, [preview, syncBrowserBridge]);
    const browserAction = useCallback(async (sessionId: string, input: Record<string, unknown>): Promise<JsonValue | undefined> => {
        if (!window.openlab || preview) return undefined;
        if (input.action === 'open' && typeof input.url === 'string') {
            const result = await window.openlab.browser.navigate({ sessionId, url: input.url, confirmed: input.confirmed === true });
            await syncBrowserBridge();
            return result as unknown as JsonValue;
        }
        if (input.action === 'back' || input.action === 'forward' || input.action === 'reload') {
            const result = await window.openlab.browser.history({ sessionId, action: input.action });
            await syncBrowserBridge();
            return result as unknown as JsonValue;
        }
        if (typeof input.observationId !== 'string' || !['click', 'type', 'select', 'press', 'scroll'].includes(String(input.action))) return undefined;
        const result = await window.openlab.browser.act({ sessionId, observationId: input.observationId, action: input.action as 'click' | 'type' | 'select' | 'press' | 'scroll', ...(typeof input.ref === 'string' ? { ref: input.ref } : {}), ...(typeof input.value === 'string' ? { value: input.value } : {}), confirmed: input.confirmed === true });
        await syncBrowserBridge();
        return result as unknown as JsonValue;
    }, [preview, syncBrowserBridge]);
    const setBrowserBounds = useCallback(async (sessionId: string, bounds: { x: number; y: number; width: number; height: number }, visible: boolean): Promise<void> => { if (window.openlab && !preview) await window.openlab.browser.setBounds({ sessionId, bounds, visible }); }, [preview]);
    const hideAllBrowsers = useCallback(async (): Promise<void> => { if (window.openlab && !preview) await window.openlab.browser.hideAll(); }, [preview]);
    const closeBrowserSession = useCallback(async (sessionId: string): Promise<void> => {
        if (!window.openlab || preview) return;
        await window.openlab.browser.close(sessionId);
        await syncBrowserBridge();
    }, [preview, syncBrowserBridge]);
    const terminalAction = useCallback(async (instanceId: string, paneId: string, input: Record<string, unknown>): Promise<JsonValue | undefined> => preview ? undefined : await client.request(`/api/worktable/instances/${encodeURIComponent(instanceId)}/panes/${encodeURIComponent(paneId)}/terminal`, { method: 'POST', body: JSON.stringify(input) }), [client, preview]);
    const previewTerminalAction = useCallback(async (terminalId: string, input: Record<string, unknown>): Promise<JsonValue | undefined> => preview ? undefined : await client.request(`/api/terminal/previews/${encodeURIComponent(terminalId)}`, { method: 'POST', body: JSON.stringify(input) }), [client, preview]);
    const scmAction = useCallback(async (instanceId: string, input: Record<string, unknown>): Promise<JsonValue | undefined> => preview ? undefined : await client.request(`/api/worktable/instances/${encodeURIComponent(instanceId)}/scm`, { method: 'POST', body: JSON.stringify(input) }), [client, preview]);
    const loadGeneratedApp = useCallback(async (appId: string, revisionId: string): Promise<{ url: string } | undefined> => preview ? undefined : await client.request(`/api/generated-apps/${encodeURIComponent(appId)}/revisions/${encodeURIComponent(revisionId)}/ticket`, { method: 'POST', body: '{}' }), [client, preview]);
    const proposeGeneratedWorkbench = useCallback(async (prompt: string) => {
        if (preview) return undefined;
        const blueprint = await client.request('/api/generated-blueprints', { method: 'POST', body: JSON.stringify({ prompt }) });
        await refresh();
        return blueprint;
    }, [client, preview, refresh]);
    const decideGeneratedWorkbench = useCallback(async (id: string, accepted: boolean) => {
        if (preview) return undefined;
        const blueprint = await client.request(`/api/generated-blueprints/${encodeURIComponent(id)}/decision`, { method: 'POST', body: JSON.stringify({ accepted, confirmed: true }) });
        await refresh();
        return blueprint;
    }, [client, preview, refresh]);
    const previewGeneratedWorkbench = useCallback(async (id: string): Promise<{ url: string; expiresAt: string } | undefined> => preview ? undefined : await client.request(`/api/generated-blueprints/${encodeURIComponent(id)}/preview-ticket`, { method: 'POST', body: '{}' }), [client, preview]);
    const acceptGeneratedWorkbench = useCallback(async (id: string) => {
        if (preview) return undefined;
        const result = await client.request(`/api/generated-blueprints/${encodeURIComponent(id)}/accept`, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
        await refresh();
        return result;
    }, [client, preview, refresh]);
    const runToolchainAdapter = useCallback(async (adapterId: string, operationId: string, values: Record<string, JsonValue>, instanceId?: string) => {
        if (preview) return undefined;
        const run = await client.request(`/api/toolchain-adapters/${encodeURIComponent(adapterId)}/operations/${encodeURIComponent(operationId)}/run`, { method: 'POST', body: JSON.stringify({ values, ...(instanceId ? { instanceId } : {}), confirmed: true }) });
        await refresh();
        return run;
    }, [client, preview, refresh]);
    const cancelToolchainRun = useCallback(async (id: string) => {
        if (preview) return undefined;
        const run = await client.request(`/api/toolchain-runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
        await refresh();
        return run;
    }, [client, preview, refresh]);
    const getWorktableUiState = useCallback(async (instanceId: string): Promise<WorktableDeviceUiState | undefined> => preview ? undefined : await window.openlab?.getWorktableUiState(instanceId), [preview]);
    const saveWorktableUiState = useCallback(async (instanceId: string, patch: Partial<WorktableDeviceUiState>): Promise<void> => {
        if (!preview) await window.openlab?.updateWorktableUiState(instanceId, patch);
    }, [preview]);
    const openDocument = useCallback(async (ref: WorkspacePathRef): Promise<DocumentBuffer> => await client.request('/api/documents/open', { method: 'POST', body: JSON.stringify(ref) }), [client]);
    const updateDocument = useCallback(async (id: string, content: string): Promise<DocumentBuffer> => await client.request(`/api/documents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ content }) }), [client]);
    const saveDocument = useCallback(async (id: string): Promise<DocumentBuffer> => await client.request(`/api/documents/${encodeURIComponent(id)}/save`, { method: 'POST', body: '{}' }), [client]);
    const closeDocument = useCallback(async (id: string, discard = false): Promise<void> => { await client.request(`/api/documents/${encodeURIComponent(id)}?discard=${discard}`, { method: 'DELETE' }); }, [client]);
    const previewWorkspaceEdit = useCallback(async (request: Omit<WorkspaceEditRequest, 'origin'>): Promise<WorkspaceEditPreview> => await client.request('/api/workspace-edits/preview', { method: 'POST', body: JSON.stringify(request) }), [client]);
    const applyWorkspaceEdit = useCallback(async (id: string): Promise<WorkspaceEditGroup> => await client.request(`/api/workspace-edits/${encodeURIComponent(id)}/apply`, { method: 'POST', body: JSON.stringify({ confirmed: true }) }), [client]);
    const undoWorkspaceEdit = useCallback(async (id: string): Promise<WorkspaceEditGroup> => await client.request(`/api/workspace-edits/${encodeURIComponent(id)}/undo`, { method: 'POST', body: '{}' }), [client]);
    const openResource = useCallback(async (target: DocumentRevisionRef): Promise<ResourceHandle> => await client.request('/api/resources', { method: 'POST', body: JSON.stringify(target) }), [client]);
    const readResource = useCallback(async (id: string, start: number, end: number): Promise<Uint8Array> => await client.requestBytes(`/api/resources/${encodeURIComponent(id)}`, start, end), [client]);
    const resourceAccess = useCallback(async (id: string) => await client.authorizedResource(`/api/resources/${encodeURIComponent(id)}`), [client]);
    const releaseResource = useCallback(async (id: string): Promise<void> => { await client.request(`/api/resources/${encodeURIComponent(id)}`, { method: 'DELETE' }); }, [client]);
    const createAnnotation = useCallback(async (input: { target: DocumentRevisionRef; selector: AnnotationSelector; comment: string }): Promise<Annotation> => await client.request('/api/annotations', { method: 'POST', body: JSON.stringify(input) }), [client]);
    const updateAnnotation = useCallback(async (id: string, patch: { comment?: string; status?: Annotation['status'] }): Promise<Annotation> => await client.request(`/api/annotations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }), [client]);
    const submitAnnotations = useCallback(async (ids: string[]) => await client.request<{ set: unknown; turnId: string }>('/api/annotations/submit', { method: 'POST', body: JSON.stringify({ ids, confirmed: true }) }), [client]);
    const runJob = useCallback(async (spec: Omit<JobSpec, 'origin'>): Promise<JobRecord> => await client.request('/api/jobs', { method: 'POST', body: JSON.stringify({ ...spec, confirmed: true }) }), [client]);
    const cancelJob = useCallback(async (id: string): Promise<JobRecord> => await client.request(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }), [client]);
    const pauseJob = useCallback(async (id: string): Promise<JobRecord> => await client.request(`/api/jobs/${encodeURIComponent(id)}/pause`, { method: 'POST', body: '{}' }), [client]);
    const resumeJob = useCallback(async (id: string): Promise<JobRecord> => await client.request(`/api/jobs/${encodeURIComponent(id)}/resume`, { method: 'POST', body: '{}' }), [client]);
    const jobLog = useCallback(async (id: string, offset = 0): Promise<{ content: string; nextOffset: number }> => await client.request(`/api/jobs/${encodeURIComponent(id)}/log?offset=${offset}`), [client]);
    const createArtifactRevision = useCallback(async (input: { artifactId: string; parentRevisionId?: string; files: Array<Omit<ArtifactRevisionFile, 'sha256' | 'size'> & { ref: WorkspacePathRef }>; jobId?: string; annotationSetIds?: string[]; provenance: Omit<ArtifactProvenance, 'artifactId' | 'createdAt'> }) => await client.request('/api/artifact-revisions', { method: 'POST', body: JSON.stringify(input) }), [client]);
    const archiveArtifactRevision = useCallback(async (id: string, includeLargeFiles = false) => await client.request(`/api/artifact-revisions/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify({ confirmed: true, includeLargeFiles }) }), [client]);
    const registerSourceMap = useCallback(async (map: Omit<SourceMapDescriptor, 'id' | 'projectId' | 'createdAt'>) => await client.request('/api/source-maps', { method: 'POST', body: JSON.stringify(map) }), [client]);
    const installToolchain = useCallback(async () => {
        if (!window.openlab) throw new Error('Desktop bridge unavailable');
        const sourcePath = await window.openlab.chooseToolchain();
        if (!sourcePath) return undefined;
        return await client.request('/api/toolchains/install', { method: 'POST', body: JSON.stringify({ sourcePath, confirmed: true }) });
    }, [client]);
    const agentAction = useCallback(async (id: string, action: 'pause' | 'resume' | 'cancel' | 'takeover') => {
        if (!preview)
            await client.request(`/api/agents/${id}/${action}`, { method: 'POST', body: '{}' });
    }, [client, preview]);
    const messageAgent = useCallback(async (id: string, content: string) => {
        if (!preview)
            await client.request(`/api/agents/${id}/message`, { method: 'POST', body: JSON.stringify({ content }) });
    }, [client, preview]);
    const installExtension = useCallback(async (kind: 'skill' | 'plugin', scope: 'user' | 'project' = 'project') => {
        if (!window.openlab || preview)
            throw new Error(t("copy269"));
        const sourcePath = await window.openlab.chooseExtension(kind);
        if (!sourcePath)
            return;
        if (kind === 'plugin') {
            const inspection = await client.request<{ manifest: PluginManifest; sha256: string; sourceType: 'directory' | 'zip' }>('/api/plugins/inspect', { method: 'POST', body: JSON.stringify({ sourcePath, confirmed: true }) });
            const permissions = inspection.manifest.permissions.join(', ') || t("copy303");
            if (!await confirmInApp(tf("copy304", inspection.manifest.name, inspection.manifest.version, permissions, inspection.sha256.slice(0, 16)), { title: t("copy162") }))
                return;
        }
        const endpoint = kind === 'skill' ? '/api/skills/install' : '/api/plugins/install';
        await client.request(endpoint, { method: 'POST', body: JSON.stringify({ sourcePath, scope, confirmed: true }) });
        await window.openlab.invalidateInactiveRuntimes();
        await refresh();
    }, [client, preview, refresh]);
    const installSkillSource = useCallback(async (sourcePath: string) => {
        if (preview) return;
        await client.request('/api/skills/install', { method: 'POST', body: JSON.stringify({ sourcePath, scope: 'project', confirmed: true }) });
        await refresh();
    }, [client, preview, refresh]);
    const approveSkill = useCallback(async (id: string, sha256: string) => {
        if (preview) return;
        await client.request(`/api/skills/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify({ sha256, confirmed: true }) });
        await refresh();
    }, [client, preview, refresh]);
    const configureMcp = useCallback(async (config: McpServerConfig) => {
        if (preview)
            throw new Error(t("copy270"));
        await client.request('/api/mcp', { method: 'POST', body: JSON.stringify({ config, confirmed: true }) });
        await refresh();
    }, [client, preview, refresh]);
    const mcpAction = useCallback(async (config: McpServerConfig, action: 'enable' | 'disable' | 'remove') => {
        if (preview)
            throw new Error(t("copy270"));
        if (action === 'remove')
            await client.request(`/api/mcp/${encodeURIComponent(config.id)}`, { method: 'DELETE', body: JSON.stringify({ confirmed: true }) });
        else
            await client.request('/api/mcp', { method: 'POST', body: JSON.stringify({ config: { ...config, enabled: action === 'enable' }, confirmed: true }) });
        await refresh();
    }, [client, preview, refresh]);
    const loadPluginPanel = useCallback(async (pluginId: string, panelId: string) => {
        if (preview)
            throw new Error(t("copy271"));
        const ticket = await client.request<{ url: string }>(`/api/plugins/${encodeURIComponent(pluginId)}/panels/${encodeURIComponent(panelId)}/ticket`, { method: 'POST', body: '{}' });
        return ticket.url;
    }, [client, preview]);
    const pluginPanelContext = useCallback(async (pluginId: string, panelId: string, tabId: string, worktable?: { instanceId: string; paneId: string }): Promise<JsonValue> => {
        if (preview)
            throw new Error(t("copy271"));
        const query = new URLSearchParams({ tabId });
        if (worktable) { query.set('worktableInstanceId', worktable.instanceId); query.set('paneId', worktable.paneId); }
        return await client.request(`/api/plugins/${encodeURIComponent(pluginId)}/panels/${encodeURIComponent(panelId)}/context?${query.toString()}`);
    }, [client, preview]);
    const pluginPanelTool = useCallback(async (pluginId: string, panelId: string, tabId: string, tool: string, params: Record<string, JsonValue>, confirmed = false, worktable?: { instanceId: string; paneId: string }) => {
        if (preview)
            throw new Error(t("copy271"));
        return await client.request(`/api/plugins/${encodeURIComponent(pluginId)}/panels/${encodeURIComponent(panelId)}/tool`, { method: 'POST', body: JSON.stringify({ tabId, ...(worktable ? { worktableInstanceId: worktable.instanceId, paneId: worktable.paneId } : {}), tool, params, confirmed }) });
    }, [client, preview]);
    const pluginPanelReveal = useCallback(async (pluginId: string, panelId: string, tabId: string, document: DocumentRevisionRef, selector: AnnotationSelector, worktable?: { instanceId: string; paneId: string }, target?: WorktableRevealTarget) => {
        if (preview)
            throw new Error(t("copy271"));
        return await client.request(`/api/plugins/${encodeURIComponent(pluginId)}/panels/${encodeURIComponent(panelId)}/reveal`, { method: 'POST', body: JSON.stringify({ tabId, ...(worktable ? { worktableInstanceId: worktable.instanceId, paneId: worktable.paneId } : {}), document, selector, ...(target ? { target } : {}) }) });
    }, [client, preview]);
    const pluginPanelResource = useCallback(async (document: DocumentRevisionRef): Promise<{ url: string; expiresAt: string }> => {
        if (preview) throw new Error(t("copy271"));
        const handle = await openResource(document);
        return await client.request(`/api/resources/${encodeURIComponent(handle.id)}/ticket`, { method: 'POST', body: '{}' });
    }, [client, openResource, preview]);
    const pluginAction = useCallback(async (id: string, action: 'enable' | 'disable' | 'reload' | 'uninstall') => {
        if (preview)
            throw new Error(t("copy272"));
        const plugin = snapshot.plugins.find((item) => item.manifest.id === id);
        const permissions = plugin?.manifest.permissions.join(', ') || t("copy303");
        if (action === 'enable') {
            if (!await confirmInApp(tf("copy308", plugin?.manifest.name ?? id, permissions), { title: t("copy157") }))
                return;
            await client.request(`/api/plugins/${encodeURIComponent(id)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: true, confirmed: true }) });
        }
        else if (action === 'disable')
            await client.request(`/api/plugins/${encodeURIComponent(id)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: false }) });
        else if (action === 'reload') {
            if (!await confirmInApp(tf("copy307", plugin?.manifest.name ?? id, permissions), { title: t("copy155") }))
                return;
            await client.request(`/api/plugins/${encodeURIComponent(id)}/reload`, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
        }
        else
            await client.request(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ confirmed: true }) });
        await window.openlab?.invalidateInactiveRuntimes();
        await refresh();
    }, [client, preview, refresh, snapshot.plugins]);
    const updateSettings = useCallback(async (patch: Partial<HarnessSettings>) => {
        if (preview) {
            setSnapshot((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
            return;
        }
        await client.request('/api/settings/harness', { method: 'POST', body: JSON.stringify({ ...patch, ...(patch.developerMode === true ? { confirmed: true } : {}) }) });
        await refresh();
    }, [client, preview, refresh]);
    const configurePrimaryAgent = useCallback(async (update: PrimaryAgentProfileUpdate) => {
        if (preview)
            return;
        await client.request('/api/settings/primary-agent', {
            method: 'POST',
            body: JSON.stringify({ ...update, confirmed: true }),
        });
        await window.openlab?.invalidateInactiveRuntimes();
        await refresh();
    }, [client, preview, refresh]);
    const updatePluginCatalog = useCallback(async () => {
        if (!window.openlab || preview) throw new Error(t("copy269"));
        const path = await window.openlab.choosePluginCatalogIndex();
        if (!path) return;
        await client.request('/api/plugin-catalog/update-file', { method: 'POST', body: JSON.stringify({ path, confirmed: true }) });
        await refresh();
    }, [client, preview, refresh]);
    const installCuratedPlugin = useCallback(async (id: string, scope: 'user' | 'project' = 'project') => {
        if (!window.openlab || preview) throw new Error(t("copy269"));
        const path = await window.openlab.chooseCuratedPluginPackage();
        if (!path) return;
        await client.request(`/api/plugin-catalog/${encodeURIComponent(id)}/install-file`, { method: 'POST', body: JSON.stringify({ path, scope, confirmed: true }) });
        await window.openlab.invalidateInactiveRuntimes();
        await refresh();
    }, [client, preview, refresh]);
    const updateUserProfile = useCallback(async (update: UserProfileUpdate) => {
        if (preview) {
            setSnapshot((current) => {
                const avatar = update.avatar === null
                    ? {}
                    : update.avatar
                        ? { avatar: update.avatar }
                        : current.userProfile?.avatar
                            ? { avatar: current.userProfile.avatar }
                            : {};
                return { ...current, userProfile: { name: update.name.trim() || shellCopy.sidebar.defaultUserName, profile: update.profile.trim(), ...avatar, updatedAt: new Date().toISOString() } };
            });
            return;
        }
        await client.request('/api/settings/user-profile', {
            method: 'POST',
            body: JSON.stringify({ ...update, confirmed: true }),
        });
        await window.openlab?.invalidateInactiveRuntimes();
        await refresh();
    }, [client, preview, refresh]);
    const createAgent = useCallback(async (input: { name: string; avatar?: AgentDefinition['avatar']; templateId?: AgentDefinition['templateId']; identity?: string; instructions?: string; model?: string; reasoningEffort?: ReasoningEffort }) => {
        if (preview) return undefined;
        const created = await client.request<AgentDefinition>('/api/agents', { method: 'POST', body: JSON.stringify({ ...input, confirmed: true }) });
        await refresh();
        return created;
    }, [client, preview, refresh]);
    const updateAgent = useCallback(async (id: string, patch: AgentDefinitionUpdate) => {
        if (preview) return undefined;
        const updated = await client.request<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
        await refresh();
        return updated;
    }, [client, preview, refresh]);
    const archiveAgentDefinition = useCallback(async (id: string, restore = false) => {
        if (preview) return;
        await client.request(`/api/agents/${encodeURIComponent(id)}/${restore ? 'restore' : 'archive'}`, { method: 'POST', body: '{}' });
        await refresh();
    }, [client, preview, refresh]);
    const importAgent = useCallback(async (card: AgentCardExport) => {
        if (preview) return undefined;
        const created = await client.request<AgentDefinition>('/api/agents/import', { method: 'POST', body: JSON.stringify({ card, confirmed: true }) });
        await refresh();
        return created;
    }, [client, preview, refresh]);
    const exportAgent = useCallback(async (id: string): Promise<AgentCardExport | undefined> => {
        if (preview) return undefined;
        return await client.request(`/api/agents/${encodeURIComponent(id)}/export`);
    }, [client, preview]);
    const setSessionAgents = useCallback(async (leadAgentId: string, memberAgentIds: string[]) => {
        if (preview) return;
        await client.request(`/api/sessions/${encodeURIComponent(snapshot.activeSessionId)}/agents`, { method: 'PUT', body: JSON.stringify({ leadAgentId, memberAgentIds }) });
        await refresh();
    }, [client, preview, refresh, snapshot.activeSessionId]);
    const refreshAgentTools = useCallback(async () => {
        if (preview) return;
        await client.request(`/api/sessions/${encodeURIComponent(snapshot.activeSessionId)}/refresh-tools`, { method: 'POST', body: '{}' });
        await refresh();
    }, [client, preview, refresh, snapshot.activeSessionId]);
    const setAgentToolPolicy = useCallback(async (id: string, policy: AgentToolPolicy) => {
        if (preview) return;
        await client.request(`/api/agents/${encodeURIComponent(id)}/tool-policy`, { method: 'PUT', body: JSON.stringify(policy) });
        await refresh();
    }, [client, preview, refresh]);
    const setProjectAgentCapabilities = useCallback(async (id: string, externalCapabilityIds: string[]) => {
        if (preview) return;
        await client.request(`/api/projects/${encodeURIComponent(snapshot.project.id)}/agents/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ enabled: true, externalCapabilityIds }) });
        await refresh();
    }, [client, preview, refresh, snapshot.project.id]);
    const listMemories = useCallback(async (agentId: string, options: { kind?: AgentMemoryItem['kind']; scope?: AgentMemoryItem['scope']; query?: string } = {}): Promise<AgentMemoryItem[]> => {
        if (preview) return [];
        const query = new URLSearchParams(Object.fromEntries(Object.entries(options).filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
        return await client.request(`/api/agents/${encodeURIComponent(agentId)}/memories?${query}`);
    }, [client, preview]);
    const createMemory = useCallback(async (agentId: string, scope: AgentMemoryItem['scope'], content: string) => {
        if (preview) return;
        await client.request(`/api/agents/${encodeURIComponent(agentId)}/memories`, { method: 'POST', body: JSON.stringify({ scope, content }) });
        await refresh();
    }, [client, preview, refresh]);
    const updateMemory = useCallback(async (id: string, patch: { content?: string; confidence?: number }) => {
        if (preview) return;
        await client.request(`/api/memories/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
        await refresh();
    }, [client, preview, refresh]);
    const deleteMemory = useCallback(async (id: string) => {
        if (preview) return;
        await client.request(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await refresh();
    }, [client, preview, refresh]);
    const clearMemories = useCallback(async (agentId: string, options: { kind?: AgentMemoryItem['kind']; scope?: AgentMemoryItem['scope'] } = {}) => {
        if (preview) return;
        await client.request(`/api/agents/${encodeURIComponent(agentId)}/memories/clear`, { method: 'POST', body: JSON.stringify(options) });
        await refresh();
    }, [client, preview, refresh]);
    const createChannel = useCallback(async (input: { name: string; leadAgentId: string; memberAgentIds: string[]; toolAccess?: CollaborationChannel['toolAccess']; minReplies?: number; maxReplies?: number }) => {
        if (preview) return undefined;
        const created = await client.request<CollaborationChannel>('/api/channels', { method: 'POST', body: JSON.stringify(input) });
        await refresh();
        return created;
    }, [client, preview, refresh]);
    const activateChannel = useCallback(async (id: string) => {
        if (preview) return;
        await client.request(`/api/channels/${encodeURIComponent(id)}/activate`, { method: 'POST', body: '{}' });
        await refresh();
    }, [client, preview, refresh]);
    const updateChannel = useCallback(async (id: string, patch: Partial<Pick<CollaborationChannel, 'name' | 'toolAccess' | 'minReplies' | 'maxReplies' | 'status'>>) => {
        if (preview) return;
        await client.request(`/api/channels/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
        await refresh();
    }, [client, preview, refresh]);
    const archiveChannel = useCallback(async (id: string) => {
        if (preview) return;
        await client.request(`/api/channels/${encodeURIComponent(id)}/archive`, { method: 'POST', body: '{}' });
        await refresh();
    }, [client, preview, refresh]);
    const exportChannel = useCallback(async (id: string) => preview ? '' : await client.requestText(`/api/channels/${encodeURIComponent(id)}/export`), [client, preview]);
    const configureProvider = useCallback(async (id: ModelProviderId, patch: Partial<Pick<ModelProviderConfig, 'enabled' | 'credentialId' | 'baseUrl'>>, secret?: string) => {
        if (preview) return;
        let credentialId = patch.credentialId;
        if (secret?.trim()) {
            if (!window.openlab) throw new Error(t("copy269"));
            credentialId = await window.openlab.saveCredential(secret.trim());
        }
        await client.request(`/api/providers/${encodeURIComponent(id)}`, {
            method: 'POST',
            body: JSON.stringify({ ...patch, ...(credentialId ? { credentialId } : {}) }),
        });
        await window.openlab?.invalidateInactiveRuntimes();
        await refresh();
    }, [client, preview, refresh]);
    const refreshProvider = useCallback(async (id: ModelProviderId) => {
        if (preview) return;
        await client.request(`/api/providers/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: '{}' });
        await window.openlab?.invalidateInactiveRuntimes();
        await refresh();
    }, [client, preview, refresh]);
    const startProviderOAuth = useCallback(async (id: Extract<ModelProviderId, 'chatgpt-oauth' | 'grok-oauth'>): Promise<ProviderOAuthStartResult | undefined> => {
        if (preview) return undefined;
        const result = await client.request<ProviderOAuthStartResult>(`/api/providers/${encodeURIComponent(id)}/oauth/start`, { method: 'POST', body: '{}' });
        await window.openlab?.invalidateInactiveRuntimes();
        if (result.authUrl) await window.openlab?.openExternal(result.authUrl);
        for (const delay of [2_000, 5_000, 10_000, 20_000]) {
            window.setTimeout(() => {
                void client.request(`/api/providers/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: '{}' })
                    .then(async () => { await window.openlab?.invalidateInactiveRuntimes(); await refresh(); })
                    .catch(() => undefined);
            }, delay);
        }
        return result;
    }, [client, preview, refresh]);
    const logoutProviderOAuth = useCallback(async (id: Extract<ModelProviderId, 'chatgpt-oauth' | 'grok-oauth'>) => {
        if (preview) return;
        await client.request(`/api/providers/${encodeURIComponent(id)}/oauth/logout`, { method: 'POST', body: '{}' });
        await window.openlab?.invalidateInactiveRuntimes();
        await refresh();
    }, [client, preview, refresh]);
    const updatePluginSettings = useCallback(async (id: string, value: JsonValue) => {
        if (preview)
            throw new Error(t("copy273"));
        await client.request(`/api/plugins/${encodeURIComponent(id)}/settings`, { method: 'POST', body: JSON.stringify({ value, confirmed: true }) });
        await refresh();
    }, [client, preview, refresh]);
    return {
        snapshot, connected, preview, projectFolderSelected, error, capabilityNotice, dismissCapabilityNotice: () => setCapabilityNotice(undefined),
        send, approve, cancel, createSession, startConversation, switchSession, archiveSession, unarchiveSession, forkSession, forkSessionBefore, regenerateTurn, activateTurnVariant,
        listWorkspace, searchWorkspace, previewWorkspace, createWorkspaceAttachment, saveWorkspaceNote, activateWorkspaceRoot, confirmWorkspaceRoot, revokeWorkspaceRoot,
        authorizeWorkspaceRoot, operateWorkspaceFile, undoWorkspaceFile, addConversationFile, removeConversationFile,
        openWorkbench, closeWorkbench, activateWorkbench, setWorkbenchView, maximizeWorkbench,
        createWorktableInstance, activateWorktableInstance, updateWorktableInstance, archiveWorktableInstance, restoreWorktableInstance, setWorktableLayout, proposeWorkbenchLayout, decideWorkbenchLayoutProposal, mountWorktableContent, activateWorktableTab, closeWorktableTab,
        createBrowserProfile, openBrowserSession, browserObserve, browserAction, setBrowserBounds, hideAllBrowsers, closeBrowserSession, terminalAction, previewTerminalAction, scmAction, loadGeneratedApp, proposeGeneratedWorkbench, decideGeneratedWorkbench, previewGeneratedWorkbench, acceptGeneratedWorkbench, runToolchainAdapter, cancelToolchainRun, getWorktableUiState, saveWorktableUiState,
        openDocument, updateDocument, saveDocument, closeDocument, previewWorkspaceEdit, applyWorkspaceEdit, undoWorkspaceEdit,
        openResource, readResource, resourceAccess, releaseResource, createAnnotation, updateAnnotation, submitAnnotations,
        runJob, cancelJob, pauseJob, resumeJob, jobLog, createArtifactRevision, archiveArtifactRevision, registerSourceMap, installToolchain,
        agentAction, messageAgent, installExtension, updatePluginCatalog, installCuratedPlugin, installSkillSource, approveSkill, configureMcp, mcpAction, loadPluginPanel, pluginPanelContext, pluginPanelTool, pluginPanelReveal, pluginPanelResource, pluginAction, updateSettings, updatePluginSettings,
        configurePrimaryAgent, updateUserProfile, createAgent, updateAgent, archiveAgentDefinition, importAgent, exportAgent, setSessionAgents, refreshAgentTools, setAgentToolPolicy, setProjectAgentCapabilities,
        listMemories, createMemory, updateMemory, deleteMemory, clearMemories,
        createChannel, activateChannel, updateChannel, archiveChannel, exportChannel,
        configureProvider, refreshProvider, startProviderOAuth, logoutProviderOAuth, refresh, replaceConnection,
    };
}

export type OpenLabController = ReturnType<typeof useOpenLab>;
