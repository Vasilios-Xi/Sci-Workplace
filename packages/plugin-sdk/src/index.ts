import type {
  AgentPreset,
  AgentTemplate,
  Annotation,
  AnnotationSelector,
  ArtifactProvenance,
  ArtifactRevision,
  CreateArtifactRevisionFileInput,
  ContextContribution,
  DocumentBuffer,
  DocumentRevisionRef,
  EvidenceAnchorV1,
  JobRecord,
  JobSpec,
  JsonValue,
  ModelDescriptor,
  ModelGenerationRecord,
  ModelGenerationSpec,
  ModelStructuredRunSpec,
  PluginWorkflowDefinition,
  PluginWorkflowResult,
  PluginStorageEntry,
  ResearchObject,
  ResearchRelation,
  ResourceHandle,
  SourceMapDescriptor,
  ToolchainDescriptor,
  ToolDefinition,
  ToolExecutionResult,
  WorkspaceEditGroup,
  WorkspaceEditPreview,
  WorkspaceEditRequest,
  WorkspaceEntry,
  WorkspacePathRef,
  BrowserObservation,
  BrowserProfileSummary,
  BrowserSessionSummary,
  BibliographicRecordV1,
  BibliographyResolveRequestV1,
  BibliographyResolutionV1,
  BibliographyVerificationV1,
  CitationDocumentInspectionV1,
  CitationDocumentPlanV1,
  CitationMaterializationReceiptV1,
  GeneratedWorktableApp,
  GeneratedAppBlueprintV1,
  HarnessPluginPermissionV4,
  LayoutProposalV1,
  MountIntentV1,
  ToolRunV1,
  ToolchainAdapterManifestV1,
  WorkbenchBlueprintV1,
  WorkbenchDeviceStateV1,
  WorkbenchInstanceV1,
  WorkbenchSlotRole,
  WorktableContextSnapshot,
  WorktableContent,
  WorktableInstance,
  WorktableRevealTarget,
  WorktableState,
  OaAttachmentReceiptV1,
  ZoteroItemV1,
  ZoteroSearchRequestV1,
  ZoteroStatusV1,
  ZoteroSyncPlanRequestV1,
  ZoteroSyncPlanV1,
  ZoteroSyncReceiptV1,
} from '@openlab/protocol';

export type {
  Annotation,
  AnnotationSelector,
  ArtifactProvenance,
  ArtifactRevision,
  CreateArtifactRevisionFileInput,
  DocumentRevisionRef,
  JobOutput,
  JobRecord,
  JobSpec,
  JsonSchema,
  JsonValue,
  ModelDescriptor,
  ModelGenerationRecord,
  ModelGenerationSpec,
  ModelStructuredRunSpec,
  PluginWorkflowDefinition,
  PluginWorkflowResult,
  ReasoningEffort,
  ResearchObject,
  ResearchRelation,
  ResourceHandle,
  ToolchainDescriptor,
  ToolExecutionResult,
  WorkspacePathRef,
  BrowserObservation,
  BrowserProfileSummary,
  BrowserSessionSummary,
  BibliographicCreatorV1,
  BibliographicRecordV1,
  BibliographyCandidateV1,
  BibliographyQueryV1,
  BibliographyResolveRequestV1,
  BibliographyResolutionV1,
  BibliographyVerificationV1,
  CitationDecisionStatusV1,
  CitationDocumentEditV1,
  CitationDocumentInspectionV1,
  CitationDocumentPlanV1,
  CitationDocumentUnitV1,
  CitationIdentifierV1,
  CitationMaterializationReceiptV1,
  CitationRecognizedFormatV1,
  CitationSourceFormatV1,
  CitationStyleFamilyV1,
  CitationSupportedInputFormatV1,
  CitationUnitKindV1,
  GeneratedWorktableApp,
  EvidenceAnchorV1,
  GeneratedAppBlueprintV1,
  HarnessPluginManifestV4,
  HarnessPluginPermissionV4,
  LayoutProposalV1,
  MountIntentV1,
  ResourceRevisionRef,
  ArtifactRevisionRef,
  ReviewRequestV1,
  RunRecordV1,
  ToolRunV1,
  ToolchainAdapterManifestV1,
  WorkbenchBlueprintV1,
  WorkbenchDeviceStateV1,
  WorkbenchInstanceV1,
  WorktableContextSnapshot,
  WorktableInstance,
  WorktableState,
  OaAttachmentReceiptV1,
  ZoteroCollectionTargetV1,
  ZoteroItemV1,
  ZoteroSearchRequestV1,
  ZoteroStatusV1,
  ZoteroSyncItemReceiptV1,
  ZoteroSyncItemV1,
  ZoteroSyncOperationV1,
  ZoteroSyncPlanRequestV1,
  ZoteroSyncPlanV1,
  ZoteroSyncReceiptV1,
} from '@openlab/protocol';

export { CITATION_SUPPORTED_INPUT_FORMATS_V1 } from '@openlab/protocol';

export const OPENLAB_PLUGIN_API_VERSION = 4 as const;

export type PluginHostCapability =
  | 'workspace:read'
  | 'workspace:edit'
  | 'resources:read'
  | 'jobs:run'
  | 'models:run'
  | 'models:invoke'
  | 'ui'
  | 'annotations:read'
  | 'annotations:write'
  | 'artifacts:write'
  | 'research:read'
  | 'research:write'
  | 'plugin-storage'
  | 'worktable:read'
  | 'worktable:write'
  | 'browser:observe'
  | 'browser:interact'
  | 'generated-apps:publish'
  | 'documents:read'
  | 'evidence:read'
  | 'evidence:write'
  | 'artifacts:publish'
  | 'workbench:read'
  | 'workbench:write'
  | 'workbench:mount'
  | 'workbench:propose-layout'
  | 'generated-apps:build'
  | 'toolchains:execute'
  | 'bibliography:resolve'
  | 'bibliography:attachments'
  | 'zotero:read'
  | 'zotero:write'
  | 'zotero:documents';

export interface WorkspaceHostApi {
  list(ref: WorkspacePathRef): Promise<WorkspaceEntry[]>;
  read(ref: WorkspacePathRef): Promise<{ content: string; sha256: string; mediaType?: string }>;
  openDocument(ref: WorkspacePathRef): Promise<DocumentBuffer>;
  previewEdit(request: WorkspaceEditRequest): Promise<WorkspaceEditPreview>;
  applyEdit(previewId: string, confirmed: boolean): Promise<WorkspaceEditGroup>;
}

export interface ResourceHostApi {
  open(target: DocumentRevisionRef): Promise<ResourceHandle>;
  read(handleId: string, start?: number, end?: number): Promise<Uint8Array>;
  release(handleId: string): Promise<void>;
}

export interface JobHostApi {
  run(spec: JobSpec): Promise<JobRecord>;
  get(id: string): Promise<JobRecord>;
  wait(id: string): Promise<JobRecord>;
  cancel(id: string): Promise<JobRecord>;
  log(id: string, offset?: number): Promise<{ content: string; nextOffset: number }>;
}

export interface ModelHostApi {
  list(): Promise<ModelDescriptor[]>;
  generate(spec: ModelGenerationSpec): Promise<ModelGenerationRecord>;
  runStructured(spec: ModelStructuredRunSpec): Promise<ModelGenerationRecord>;
}

export interface ToolchainHostApi {
  list(kind?: string): Promise<ToolchainDescriptor[]>;
}

export interface ToolchainHostApiV4 extends ToolchainHostApi {
  adapters(): Promise<ToolchainAdapterManifestV1[]>;
  run(input: { adapterId: string; operationId: string; values: Record<string, JsonValue>; confirmed: boolean }): Promise<ToolRunV1>;
  getRun(id: string): Promise<ToolRunV1>;
  cancelRun(id: string): Promise<ToolRunV1>;
  runLog(id: string, offset?: number): Promise<{ content: string; nextOffset: number }>;
}

export interface WorkflowHostApi {
  start(workflowId: string, input: Record<string, JsonValue>, options?: { worktableInstanceId?: string }): Promise<JobRecord>;
  get(id: string): Promise<JobRecord>;
  cancel(id: string): Promise<JobRecord>;
  pause(id: string): Promise<JobRecord>;
  resume(id: string): Promise<JobRecord>;
  report(id: string, update: { progress?: number; stage?: string; metadata?: Record<string, JsonValue> }): Promise<JobRecord>;
}

export interface AnnotationHostApi {
  list(target?: DocumentRevisionRef): Promise<Annotation[]>;
  create(input: { target: DocumentRevisionRef; selector: AnnotationSelector; comment: string }): Promise<Annotation>;
  update(id: string, patch: { comment?: string; status?: Annotation['status'] }): Promise<Annotation>;
}

export interface ArtifactHostApi {
  revisions(artifactId?: string): Promise<ArtifactRevision[]>;
  createRevision(input: {
    artifactId: string;
    parentRevisionId?: string;
    files: CreateArtifactRevisionFileInput[];
    jobId?: string;
    annotationSetIds?: string[];
    provenance: Omit<ArtifactProvenance, 'artifactId' | 'createdAt'>;
  }): Promise<ArtifactRevision>;
  archive(revisionId: string, includeLargeFiles?: boolean): Promise<ArtifactRevision>;
  registerSourceMap(map: Omit<SourceMapDescriptor, 'id' | 'projectId' | 'createdAt'>): Promise<SourceMapDescriptor>;
}

export interface ResearchHostApi {
  objects(): Promise<ResearchObject[]>;
  relations(): Promise<ResearchRelation[]>;
  createObject(input: {
    type: ResearchObject['type'];
    title: string;
    status?: ResearchObject['status'];
    attributes?: Record<string, JsonValue>;
    attachments?: ResearchObject['attachments'];
  }): Promise<ResearchObject>;
  createRelation(input: {
    fromId: string;
    predicate: ResearchRelation['predicate'];
    toId: string;
    evidenceIds?: string[];
  }): Promise<ResearchRelation>;
  /** Concise v2 aliases; legacy v2 names remain available. */
  create(input: {
    type: ResearchObject['type'];
    title: string;
    status?: ResearchObject['status'];
    attributes?: Record<string, JsonValue>;
    attachments?: ResearchObject['attachments'];
  }): Promise<ResearchObject>;
  update(id: string, patch: Partial<Pick<ResearchObject, 'title' | 'status' | 'attributes' | 'attachments'>>): Promise<ResearchObject>;
  relate(input: {
    fromId: string;
    predicate: ResearchRelation['predicate'];
    toId: string;
    evidenceIds?: string[];
  }): Promise<ResearchRelation>;
}

export interface WorkbenchHostApi {
  open(input: {
    title: string;
    workbenchId: string;
    document?: DocumentRevisionRef;
    artifactId?: string;
    artifactRevisionId?: string;
    activeViewId: string;
  }): Promise<{ activeTabId?: string }>;
  reveal(input: { document: DocumentRevisionRef; selector: AnnotationSelector }): Promise<void>;
}

export interface WorktableHostApi {
  list(): Promise<WorktableState>;
  inspect(instanceId: string): Promise<WorktableContextSnapshot>;
  create(input: { templateId?: string; title?: string; boundSessionId?: string; inputs?: Record<string, JsonValue> }): Promise<WorktableInstance>;
  open(instanceId: string): Promise<WorktableInstance>;
  update(instanceId: string, patch: { title?: string; inputs?: Record<string, JsonValue>; activeRunId?: string | null; artifactId?: string | null; artifactRevisionId?: string | null; status?: WorktableInstance['status'] }, ifRevision: number): Promise<WorktableInstance>;
  archive(instanceId: string, ifRevision: number): Promise<WorktableInstance>;
  bindSession(instanceId: string, sessionId?: string): Promise<WorktableInstance>;
  reveal(input: { instanceId: string; document: DocumentRevisionRef; selector: AnnotationSelector; target?: WorktableRevealTarget }): Promise<WorktableState>;
  mountContent(input: {
    instanceId: string;
    paneId: string;
    title: string;
    content: Extract<WorktableContent, { kind: 'document' | 'plugin-panel' }>;
  }): Promise<WorktableInstance>;
  mountArtifact(input: { instanceId: string; paneId: string; artifactId: string; revisionId?: string; role?: string; title?: string }): Promise<WorktableInstance>;
  setStatus(instanceId: string, status: WorktableInstance['status']): Promise<WorktableInstance>;
}

export interface WorkflowHostApiV4 extends Omit<WorkflowHostApi, 'start'> {
  start(workflowId: string, input: Record<string, JsonValue>, options?: { workbenchInstanceId?: string }): Promise<JobRecord>;
}

export interface EvidenceHostApiV4 {
  list(target?: DocumentRevisionRef): Promise<EvidenceAnchorV1[]>;
  create(input: {
    target: DocumentRevisionRef;
    selector: AnnotationSelector;
    page?: number;
    blockId?: string;
    asset?: EvidenceAnchorV1['asset'];
    exact?: string;
    idempotencyKey?: string;
  }): Promise<EvidenceAnchorV1>;
}

/** Harness-owned deterministic metadata resolution and lawful OA retrieval. */
export interface BibliographyHostApiV1 {
  scanDocument(source: DocumentRevisionRef): Promise<CitationDocumentInspectionV1>;
  resolve(request: BibliographyResolveRequestV1): Promise<BibliographyResolutionV1[]>;
  verifyMetadata(record: BibliographicRecordV1): Promise<BibliographyVerificationV1>;
  fetchOpenAccess(record: BibliographicRecordV1): Promise<OaAttachmentReceiptV1>;
}

/** Harness-owned Zotero bridge. Plugins never receive ports, tokens, or process access. */
export interface ZoteroHostApiV1 {
  status(): Promise<ZoteroStatusV1>;
  search(request: ZoteroSearchRequestV1): Promise<ZoteroItemV1[]>;
  planSync(request: ZoteroSyncPlanRequestV1): Promise<ZoteroSyncPlanV1>;
  commitSync(planId: string, confirmed: boolean): Promise<ZoteroSyncReceiptV1>;
  materializeCitationDocument(plan: CitationDocumentPlanV1): Promise<CitationMaterializationReceiptV1>;
}

/** Public v4 API. `WorktableHostApi` is retained only for installed v3 code. */
export interface WorkbenchHostApiV4 {
  list(): Promise<WorkbenchInstanceV1[]>;
  inspect(instanceId: string): Promise<WorkbenchInstanceV1>;
  create(input: { blueprintId: string; title?: string; primaryConversationId?: string; inputs?: Record<string, JsonValue> }): Promise<WorkbenchInstanceV1>;
  open(instanceId: string): Promise<WorkbenchInstanceV1>;
  mount(intent: MountIntentV1): Promise<WorkbenchInstanceV1>;
  proposeLayout(input: {
    instanceId: string;
    baseRevision: number;
    title: string;
    reason: string;
    layout: WorkbenchBlueprintV1['layout'];
    panes: WorkbenchBlueprintV1['panes'];
    slots: WorkbenchBlueprintV1['slots'];
  }): Promise<LayoutProposalV1>;
  reveal(input: { instanceId: string; anchorId: string; targetRole?: WorkbenchSlotRole }): Promise<void>;
}

export interface BrowserHostApi {
  profiles(): Promise<BrowserProfileSummary[]>;
  sessions(): Promise<BrowserSessionSummary[]>;
  observe(sessionId: string): Promise<BrowserObservation>;
  open(input: { instanceId: string; paneId: string; profileId: string; url: string; confirmed: boolean }): Promise<BrowserSessionSummary>;
  act(input: { sessionId: string; observationId: string; action: 'click' | 'type' | 'select' | 'press' | 'scroll'; ref?: string; value?: string; confirmed: boolean }): Promise<BrowserSessionSummary>;
}

export interface GeneratedAppHostApi {
  list(): Promise<GeneratedWorktableApp[]>;
  publish(input: { title: string; source: WorkspacePathRef; entry: string; networkDomains?: string[]; hostCapabilities?: string[]; confirmed: boolean }): Promise<GeneratedWorktableApp>;
}

export interface GeneratedAppHostApiV4 {
  list(): Promise<GeneratedWorktableApp[]>;
  propose(prompt: string): Promise<GeneratedAppBlueprintV1>;
}

export interface PluginStorageApi {
  get(scope: PluginStorageEntry['scope'], key: string): Promise<PluginStorageEntry | undefined>;
  put(scope: PluginStorageEntry['scope'], key: string, value: JsonValue, ifRevision?: number): Promise<PluginStorageEntry>;
  delete(scope: PluginStorageEntry['scope'], key: string, ifRevision?: number): Promise<void>;
  list(scope: PluginStorageEntry['scope'], prefix?: string): Promise<PluginStorageEntry[]>;
}

export interface PluginHost {
  readonly capabilities: PluginHostCapability[];
  workspace: WorkspaceHostApi;
  resources: ResourceHostApi;
  jobs: JobHostApi;
  models: ModelHostApi;
  toolchains: ToolchainHostApi;
  workflows: WorkflowHostApi;
  annotations: AnnotationHostApi;
  artifacts: ArtifactHostApi;
  research: ResearchHostApi;
  storage: PluginStorageApi;
  workbench: WorkbenchHostApi;
  worktable: WorktableHostApi;
  browser: BrowserHostApi;
  generatedApps: GeneratedAppHostApi;
}

export type PluginHostV4 = Omit<PluginHost, 'capabilities' | 'toolchains' | 'workflows' | 'workbench' | 'worktable' | 'generatedApps'> & {
  readonly capabilities: HarnessPluginPermissionV4[];
  toolchains: ToolchainHostApiV4;
  workflows: WorkflowHostApiV4;
  evidence: EvidenceHostApiV4;
  workbenches: WorkbenchHostApiV4;
  generatedApps: GeneratedAppHostApiV4;
  bibliography: BibliographyHostApiV1;
  zotero: ZoteroHostApiV1;
};

export interface PluginExecutionContext {
  projectId: string;
  sessionId: string;
  agentId: string;
  traceId: string;
  settings: Record<string, JsonValue>;
  host: PluginHost;
  /** Aborted when the user cancels this invocation, the timeout expires, or
   * the host shuts down. Cancellation does not disable the plugin process. */
  signal: AbortSignal;
}

export interface PluginExecutionContextV4 extends Omit<PluginExecutionContext, 'host'> {
  host: PluginHostV4;
}

export interface LegacyPluginExecutionContext {
  projectRoot: string;
  sessionId: string;
  agentId: string;
  traceId: string;
  settings: Record<string, JsonValue>;
}

export interface OpenLabPluginTool<TContext = PluginExecutionContext> {
  definition: Omit<ToolDefinition, 'source' | 'sourceId'>;
  execute(input: Record<string, JsonValue>, context: TContext): Promise<ToolExecutionResult>;
}

export interface PluginWorkflowContext extends PluginExecutionContext {
  jobId: string;
  resume: boolean;
  /** Stable top-level worktable task instance bound to this workflow run. */
  worktableInstanceId?: string;
}

export interface PluginWorkflowContextV4 extends Omit<PluginWorkflowContext, 'host' | 'worktableInstanceId'> {
  host: PluginHostV4;
  /** Stable Workbench v1 instance bound to this workflow run. */
  workbenchInstanceId?: string;
}

export interface OpenLabPluginWorkflow<TContext = PluginWorkflowContext> {
  definition: PluginWorkflowDefinition;
  run(input: Record<string, JsonValue>, context: TContext): Promise<PluginWorkflowResult>;
}

export interface OpenLabPluginV2 {
  apiVersion: 2;
  tools?: Array<OpenLabPluginTool<PluginExecutionContext>>;
  workflows?: OpenLabPluginWorkflow[];
  context?: (input: { projectId: string; sessionId: string; agentId: string; settings: Record<string, JsonValue>; host: PluginHost }) => Promise<ContextContribution[]> | ContextContribution[];
  agentTemplates?: AgentTemplate[];
  dispose?: () => Promise<void> | void;
}

export interface OpenLabPluginV3 {
  apiVersion: 3;
  tools?: Array<OpenLabPluginTool<PluginExecutionContext>>;
  workflows?: OpenLabPluginWorkflow[];
  context?: (input: { projectId: string; sessionId: string; agentId: string; settings: Record<string, JsonValue>; host: PluginHost }) => Promise<ContextContribution[]> | ContextContribution[];
  agentTemplates?: AgentTemplate[];
  dispose?: () => Promise<void> | void;
}

export interface OpenLabPluginV4 {
  apiVersion: 4;
  tools?: Array<OpenLabPluginTool<PluginExecutionContextV4>>;
  workflows?: Array<OpenLabPluginWorkflow<PluginWorkflowContextV4>>;
  context?: (input: { projectId: string; sessionId: string; agentId: string; settings: Record<string, JsonValue>; host: PluginHostV4 }) => Promise<ContextContribution[]> | ContextContribution[];
  agentTemplates?: AgentTemplate[];
  dispose?: () => Promise<void> | void;
}

export interface OpenLabPluginV1 {
  apiVersion: 1;
  tools?: Array<OpenLabPluginTool<LegacyPluginExecutionContext>>;
  context?: (input: { projectRoot: string; sessionId: string; agentId: string; settings: Record<string, JsonValue> }) => Promise<ContextContribution[]> | ContextContribution[];
  agentTemplates?: AgentTemplate[];
  /** @deprecated Protocol v3 maps these to templates and never instantiates an Agent automatically. */
  agentPresets?: AgentPreset[];
  dispose?: () => Promise<void> | void;
}

/** Formal Plugin API v4 authoring surface. Legacy shapes are parsed only by the
 * isolated runtime for dormant local installations and are not an authoring
 * contract. */
export type OpenLabPlugin = OpenLabPluginV4;
export type LegacyOpenLabPlugin = OpenLabPluginV1 | OpenLabPluginV2 | OpenLabPluginV3;
export type AnyOpenLabPlugin = LegacyOpenLabPlugin | OpenLabPluginV4;

export function definePlugin<TPlugin extends OpenLabPlugin>(plugin: TPlugin): TPlugin {
  if (plugin.apiVersion !== OPENLAB_PLUGIN_API_VERSION) {
    throw new Error(`不支持的 OpenLab Plugin API：${String((plugin as { apiVersion?: unknown }).apiVersion)}`);
  }
  return plugin;
}
