export const PROTOCOL_VERSION = 6 as const;

export type Id = string;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ScopeKind = 'app' | 'project' | 'session' | 'agent';
export type ActorKind = 'user' | 'agent' | 'tool' | 'plugin' | 'system';
export type ProjectRole = 'owner' | 'editor' | 'reviewer' | 'viewer';

export interface EventActor {
  id: Id;
  kind: ActorKind;
  label?: string;
}

export interface RuntimeEventEnvelope<TPayload extends JsonValue = JsonValue> {
  id: Id;
  streamId: Id;
  sequence: number;
  kind: string;
  schemaVersion: number;
  timestamp: string;
  actor: EventActor;
  /** Stable installation identity. It is deliberately distinct from a user
   * identity so a future sync service can distinguish offline devices. */
  deviceId: Id;
  /** Stable command/event key used to collapse retries without comparing
   * wall-clock timestamps. */
  idempotencyKey: Id;
  /** Optimistic entity revision. For stream events this is the stream
   * sequence unless a domain service supplies a narrower entity revision. */
  revision: number;
  agentId?: Id;
  traceId: Id;
  provenanceRefs: Id[];
  payload: TPayload;
}

export type ResearchObjectType = 'source' | 'dataset' | 'experiment' | 'evidence' | 'artifact' | `${string}:${string}`;
export type ResearchObjectStatus = 'draft' | 'active' | 'archived';

export interface ResearchAttachment {
  id: Id;
  name: string;
  rootId?: Id;
  relativePath: string;
  mediaType?: string;
  sha256?: string;
  size?: number;
}

export interface ChatAttachmentRef {
  id: Id;
  name: string;
  rootId?: Id;
  relativePath: string;
  sha256: string;
  size: number;
  mediaType?: string;
}

export interface ResearchObject {
  id: Id;
  projectId: Id;
  type: ResearchObjectType;
  title: string;
  status: ResearchObjectStatus;
  attributes: Record<string, JsonValue>;
  attachments: ResearchAttachment[];
  checksum: string;
  createdBy: EventActor;
  createdAt: string;
  updatedAt: string;
}

export type ResearchRelationPredicate =
  | 'derivedFrom'
  | 'uses'
  | 'produces'
  | 'supports'
  | 'contradicts'
  | 'cites'
  | `${string}:${string}`;

export interface ResearchRelation {
  id: Id;
  projectId: Id;
  fromId: Id;
  predicate: ResearchRelationPredicate;
  toId: Id;
  evidenceIds: Id[];
  traceId: Id;
  createdBy: EventActor;
  createdAt: string;
}

export interface ArtifactProvenance {
  artifactId: Id;
  traceId: Id;
  sessionId: Id;
  taskId?: Id;
  agentId: Id;
  model?: string;
  tool?: string;
  plugin?: { id: string; version: string };
  inputObjectIds: Id[];
  inputFileHashes: Record<string, string>;
  createdAt: string;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextContentPart {
  type: 'text';
  text: string;
  trust?: 'trusted' | 'untrusted';
  sourceRef?: Id;
}

export interface ImageContentPart {
  type: 'image_url';
  imageUrl: string;
}

export type MessageContent = string | Array<TextContentPart | ImageContentPart>;

export interface ToolCall {
  id: Id;
  name: string;
  arguments: string;
}

export interface ModelMessage {
  role: ChatRole;
  content: MessageContent | null;
  name?: string;
  toolCallId?: Id;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
  /** File-backed chat inputs are persisted as hash-verified references. Runtime
   * materializes supported image bytes only for the provider request so event
   * history does not duplicate large base64 payloads. */
  attachmentRefs?: ChatAttachmentRef[];
}

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: JsonPrimitive[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export type ToolRisk = 'read' | 'write' | 'execute' | 'network' | 'delete' | 'external';
export type ToolRenderHint = 'generic' | 'terminal' | 'diff' | 'artifact' | 'form' | 'agent';

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  risk: ToolRisk;
  renderHint: ToolRenderHint;
  source: 'core' | 'mcp' | 'plugin';
  sourceId?: string;
  /** Stable user-facing capability family used by per-Agent tool policies. */
  capabilityId?: string;
  /** Host-enforced execution policy. Long-running tool calls are capped at
   * thirty minutes and receive a cancellable execution context. */
  execution?: {
    mode: 'request' | 'long-running';
    timeoutMs?: number;
  };
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  thinking: 'enabled' | 'disabled';
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
  /** Optional host-enforced structured output contract. Providers that expose
   * a native JSON/schema mode should forward it. */
  responseSchema?: JsonSchema;
  userId?: string;
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelReasoningMode = 'unsupported' | 'toggle' | 'levels' | 'always';

export interface ModelReasoningCapabilities {
  mode: ModelReasoningMode;
  efforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  canDisable: boolean;
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
}

export interface ModelRunMetrics {
  model: string;
  usage: ModelUsage;
  latencyMs: number;
  firstEventLatencyMs: number;
  completedAt: string;
  estimatedCost?: {
    currency: string;
    amount: number;
    pricingVersion: string;
    pricingSource: string;
  };
}

export type ModelEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'done'; finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'resource' | 'unknown' }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export interface ModelProvider {
  readonly id: string;
  listModels(signal?: AbortSignal): Promise<ModelDescriptor[]>;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export interface ModelDescriptor {
  id: string;
  label: string;
  contextWindow: number;
  supportsThinking: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  providerId?: ModelProviderId;
  nativeId?: string;
  reasoning?: ModelReasoningCapabilities;
  isDefault?: boolean;
}

/** A plugin-visible image reference. The host resolves and verifies the file
 * before converting it to provider-native input; plugins never receive model
 * credentials or an unrestricted filesystem path. */
export type PluginModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; ref: WorkspacePathRef; sha256: string; mediaType: string };

export interface ModelGenerationSpec {
  model: string;
  purpose: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | PluginModelContentPart[];
  }>;
  responseSchema?: JsonSchema;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
  /** Stable semantic key supplied by the plugin. The host additionally binds
   * it to plugin/model/schema/input hashes before a cached result is reused. */
  cacheKey: string;
  inputHashes: string[];
  /** Optional provenance for compatibility callers. New model-first plugins
   * should use ModelStructuredRunSpec, where provenance is required. */
  sourceReferences?: ModelSourceReference[];
  disclosure?: ModelDisclosureScope;
}

export interface ModelSourceReference {
  id: string;
  kind: 'document' | 'citation' | 'bibliography' | 'metadata' | 'attachment' | 'user_input';
  label: string;
  sha256?: string;
  revisionId?: string;
  selector?: AnnotationSelector;
  uri?: string;
}

export interface ModelDisclosureScope {
  mode: 'snippet' | 'full_text';
  /** Human-readable, auditable list of fields sent to the provider. */
  fields: string[];
  /** Required for every full-text invocation and issued by an explicit user
   * approval flow. The host never infers this consent from plugin settings. */
  authorizationId?: string;
  authorizedAt?: string;
}

export interface ModelStructuredRunSpec extends ModelGenerationSpec {
  responseSchema: JsonSchema;
  sourceReferences: ModelSourceReference[];
  disclosure: ModelDisclosureScope;
}

export interface ModelGenerationRecord {
  id: Id;
  pluginId: string;
  status: 'completed' | 'failed' | 'cancelled';
  model: string;
  purpose: string;
  text: string;
  json?: JsonValue;
  cacheHit: boolean;
  usage: ModelUsage;
  estimatedCost?: ModelRunMetrics['estimatedCost'];
  attemptCount?: number;
  retryReasons?: string[];
  failureReason?: string;
  sourceReferences?: ModelSourceReference[];
  disclosure?: ModelDisclosureScope;
  error?: string;
  createdAt: string;
  completedAt: string;
}

export type ModelProviderCategory = 'oauth' | 'coding_plan' | 'api';
export type ModelProviderAuth = 'oauth' | 'api_key' | 'none';
export type ModelProviderId =
  | 'chatgpt-oauth'
  | 'grok-oauth'
  | 'minimax-coding-plan'
  | 'kimi-coding-plan'
  | 'glm-coding-plan'
  | 'deepseek'
  | 'ollama'
  | 'lm-studio';

export interface ModelProviderDefinition {
  id: ModelProviderId;
  label: string;
  category: ModelProviderCategory;
  auth: ModelProviderAuth;
  defaultBaseUrl?: string;
  docsUrl: string;
  local: boolean;
  configurableBaseUrl: boolean;
  policyNotice?: string;
}

export interface ModelProviderConfig {
  id: ModelProviderId;
  enabled: boolean;
  credentialId?: Id;
  baseUrl?: string;
  updatedAt: string;
}

export interface OAuthAccountSummary {
  label?: string;
  plan?: string;
}

export interface ModelProviderState {
  definition: ModelProviderDefinition;
  config: ModelProviderConfig;
  status: 'disabled' | 'unconfigured' | 'connecting' | 'connected' | 'offline' | 'failed' | 'unavailable';
  credentialConfigured: boolean;
  commandAvailable?: boolean;
  account?: OAuthAccountSummary;
  models: ModelDescriptor[];
  error?: string;
}

export interface ProviderOAuthStartResult {
  providerId: Extract<ModelProviderId, 'chatgpt-oauth' | 'grok-oauth'>;
  status: 'started' | 'completed';
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
}

export interface ContextContribution {
  id: Id;
  label: string;
  category: 'policy' | 'project' | 'agent' | 'research' | 'task' | 'conversation' | 'tool' | 'plugin';
  priority: number;
  content: string;
  trust: 'trusted' | 'untrusted';
  sourceRefs: Id[];
  cache: 'stable' | 'dynamic';
  projection?: 'system' | 'request-schema';
}

export interface ContextPlanItem extends ContextContribution {
  estimatedTokens: number;
  included: boolean;
  exclusionReason?: string;
}

export interface ContextPlan {
  budget: number;
  reservedOutputTokens: number;
  usedTokens: number;
  utilization: number;
  cacheStableTokens: number;
  items: ContextPlanItem[];
  compactedRanges: Array<{ fromSequence: number; toSequence: number; summaryEventId: Id }>;
  lastModelRun?: ModelRunMetrics;
}

export type PermissionMode = 'auto' | 'trusted' | 'ask' | 'read_only';

export interface ChatSubmissionInput {
  text: string;
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
}

export interface ConversationStartInput {
  title?: string;
  leadAgentId?: string;
  memberAgentIds?: string[];
  temporary?: boolean;
  message: ChatSubmissionInput;
}

export interface ConversationStartResult {
  session: SessionSummary;
  turnId: string;
}

export type ConversationProjectTarget =
  | { kind: 'detached' }
  | { kind: 'project'; rootPath: string; name: string; additionalRoots?: string[] };

/** A locally known conversation scope used to keep the sidebar stable across Runtime switches. */
export interface ConversationSourceDescriptor {
  kind: 'detached' | 'project';
  projectId: Id;
  rootPath: string;
  name: string;
  /** Additional user-approved folders that belong to the same project. */
  additionalRoots?: string[];
}

export interface ConversationActivateInput {
  sessionId: Id;
  projectId: Id;
  /** False switches only the owning Runtime, for actions such as archive/unarchive. */
  activate?: boolean;
}

export interface RuntimeConnectionDescriptor {
  baseUrl: string;
  token: string;
  projectRoot: string;
  projectFolderSelected: boolean;
}

/** The connection and already-materialized state returned by a desktop Runtime switch. */
export interface DesktopConversationActivateResult {
  connection: RuntimeConnectionDescriptor;
  snapshot: BootstrapSnapshot;
}

export interface DesktopConversationStartInput extends ConversationStartInput {
  target: ConversationProjectTarget;
}

export interface DesktopConversationStartResult extends ConversationStartResult {
  connection: RuntimeConnectionDescriptor;
  snapshot: BootstrapSnapshot;
}
export type WorkspaceAccessMode = Exclude<PermissionMode, 'auto'>;
export type PermissionRule = 'allow' | 'ask' | 'deny';
export type SecurityPermissionCategory =
  | 'projectRead'
  | 'workspaceWrite'
  | 'terminalExecution'
  | 'deletion'
  | 'networkAccess'
  | 'outsideWorkspace'
  | 'extensionInstall'
  | 'externalTools';

export interface SecurityApprovalPolicy {
  schemaVersion: 1;
  projectRead: PermissionRule;
  workspaceWrite: PermissionRule;
  terminalExecution: PermissionRule;
  deletion: PermissionRule;
  networkAccess: PermissionRule;
  outsideWorkspace: PermissionRule;
  extensionInstall: PermissionRule;
  externalTools: PermissionRule;
}
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRequest {
  id: Id;
  sessionId: Id;
  agentId: Id;
  toolCall: ToolCall;
  tool: ToolDefinition;
  rationale: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
}

export interface ToolExecutionResult {
  callId: Id;
  ok: boolean;
  content: string;
  artifactIds: Id[];
  changeSetId?: Id;
  metadata: Record<string, JsonValue>;
}

export type AgentRole = 'lead' | 'member';
export type AgentRunStatus = 'idle' | 'queued' | 'running' | 'waiting_approval' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type TaskStatus = 'backlog' | 'queued' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled';

export type AgentAvatarPreset = 'sage' | 'ocean' | 'amber';
export type AgentAvatarImage = `data:image/${'png' | 'jpeg' | 'webp'};base64,${string}`;
export type AgentAvatar = AgentAvatarPreset | AgentAvatarImage;
export type AgentTemplateId = 'research_lead' | 'rigorous_reviewer' | 'experiment_executor' | 'blank' | `${string}:${string}`;

export interface AgentToolPolicy {
  enabledCapabilityIds: string[];
  disabledToolIds: string[];
  revision: number;
}

export interface AgentMemoryPolicy {
  memoryEnabled: boolean;
  experienceEnabled: boolean;
}

export interface AgentDefinition {
  id: Id;
  name: string;
  avatar: AgentAvatar;
  templateId?: AgentTemplateId;
  identity: string;
  instructions: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  toolPolicy: AgentToolPolicy;
  memoryPolicy: AgentMemoryPolicy;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface AgentDefinitionUpdate {
  name?: string;
  avatar?: AgentAvatar;
  templateId?: AgentTemplateId;
  identity?: string;
  instructions?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  toolPolicy?: AgentToolPolicy;
  memoryPolicy?: AgentMemoryPolicy;
}

export interface AgentTemplate {
  id: AgentTemplateId;
  name: string;
  summary: string;
  avatar: AgentAvatar;
  identity: string;
  instructions: string;
  source: 'core' | 'plugin';
  sourceId?: string;
}

export interface AgentCardExport {
  schemaVersion: 1;
  kind: 'openlab-agent';
  name: string;
  avatar: AgentAvatar;
  templateId?: AgentTemplateId;
  identity: string;
  instructions: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ProjectAgentBinding {
  projectId: Id;
  agentId: Id;
  enabled: boolean;
  externalCapabilityIds: string[];
  updatedAt: string;
}

export interface AgentCapabilitySnapshot {
  id: Id;
  sessionId: Id;
  agentId: Id;
  policyRevision: number;
  capabilityIds: string[];
  toolIds: string[];
  createdAt: string;
}

export interface SessionAgentBinding {
  sessionId: Id;
  leadAgentId: Id;
  memberAgentIds: Id[];
  capabilitySnapshotIds: Id[];
  updatedAt: string;
}

export type AgentMemoryKind = 'pinned' | 'current' | 'experience';
export type AgentMemoryScope = 'global' | 'project';

export interface AgentMemoryItem {
  id: Id;
  agentId: Id;
  projectId?: Id;
  scope: AgentMemoryScope;
  kind: AgentMemoryKind;
  content: string;
  confidence?: number;
  sourceEventIds: Id[];
  status: 'active' | 'superseded' | 'deleted';
  createdBy: 'user' | 'agent';
  createdAt: string;
  updatedAt: string;
}

export interface AgentMemorySummary {
  agentId: Id;
  projectId: Id;
  pinnedCount: number;
  currentCount: number;
  experienceCount: number;
  updatedAt?: string;
}

export interface ToolCapabilityDescriptor {
  id: string;
  title: string;
  description: string;
  source: 'core' | 'mcp' | 'plugin';
  sourceId?: string;
  toolIds: string[];
  available: boolean;
  defaultEnabled: boolean;
}

export interface CollaborationChannel {
  id: Id;
  projectId: Id;
  kind: 'private' | 'group';
  name: string;
  leadAgentId: Id;
  memberAgentIds: Id[];
  toolAccess: 'read_only' | 'write';
  minReplies: number;
  maxReplies: number;
  status: 'idle' | 'running' | 'paused' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface ChannelMessage {
  id: Id;
  channelId: Id;
  fromAgentId: Id;
  toAgentIds: Id[];
  sessionId?: Id;
  taskId?: Id;
  content: string;
  sourceEventIds: Id[];
  createdAt: string;
}

export interface AgentPreset {
  id: Id;
  name: string;
  role: AgentRole;
  instructions: string;
  model: string;
  thinking: 'enabled' | 'disabled';
  reasoningEffort: ReasoningEffort;
  toolNames: string[];
  skillIds: string[];
  permissionMode: PermissionMode;
  contextBudget: number;
}

export interface AgentRun {
  id: Id;
  sessionId: Id;
  definitionId: Id;
  name: string;
  role: AgentRole;
  status: AgentRunStatus;
  currentTaskId?: Id;
  startedAt?: string;
  finishedAt?: string;
  usage: ModelUsage;
}

export interface AgentTask {
  id: Id;
  sessionId: Id;
  parentTaskId?: Id;
  title: string;
  description: string;
  status: TaskStatus;
  assignedAgentId?: Id;
  inputRefs: Id[];
  outputRefs: Id[];
  createdAt: string;
  updatedAt: string;
}

export interface MailboxMessage {
  id: Id;
  sessionId: Id;
  fromAgentId: Id;
  toAgentId: Id;
  taskId?: Id;
  content: string;
  createdAt: string;
  readAt?: string;
}

export type PluginPermission =
  | 'project:read'
  | 'project:write'
  | 'process:spawn'
  | 'network'
  | 'settings:read'
  | 'settings:write'
  | 'ui'
  | 'workspace:read'
  | 'workspace:edit'
  | 'resources:read'
  | 'jobs:run'
  | 'models:run'
  /** Plugin API v2 model-host permission. `models:run` remains a backwards-
   * compatible alias for plugins published before structured invocation. */
  | 'models:invoke'
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
  | 'generated-apps:publish';

/** Capabilities exposed by the Harness Plugin API v4. */
export type HarnessPluginPermissionV4 =
  | 'settings:read'
  | 'ui'
  | 'workspace:read'
  | 'workspace:edit'
  | 'resources:read'
  | 'jobs:run'
  | 'models:invoke'
  | 'annotations:read'
  | 'annotations:write'
  | 'artifacts:write'
  | 'research:read'
  | 'research:write'
  | 'plugin-storage'
  | 'browser:observe'
  | 'browser:interact'
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

export type CitationSourceFormatV1 = 'docx' | 'markdown' | 'tex';
export type CitationStyleFamilyV1 = 'numeric' | 'author-date';
export type CitationUnitKindV1 =
  | 'doi'
  | 'pmid'
  | 'arxiv'
  | 'title'
  | 'numeric-cluster'
  | 'author-date'
  | 'endnote-field'
  | 'zotero-field'
  | 'reference-entry'
  | 'placeholder';

export type CitationRecognizedFormatV1 =
  | 'doi'
  | 'pmid'
  | 'arxiv'
  | 'labeled-title'
  | 'structured-reference'
  | 'zotero-field'
  | 'endnote-field'
  | 'mapped-numeric'
  | 'pandoc-zotero-key'
  | 'tex-citation-key'
  | 'unsupported';

export interface CitationSupportedInputFormatV1 {
  id: Exclude<CitationRecognizedFormatV1, 'unsupported' | 'mapped-numeric'> | 'numeric-mapped-reference';
  label: string;
  description: string;
  examples: readonly string[];
}

/**
 * Citation Workbench v1 intentionally uses a small, explicit recognition
 * whitelist. Keep this list shared by the scanner and bundled panel so the UI
 * never promises a format that the deterministic parser does not accept.
 */
export const CITATION_SUPPORTED_INPUT_FORMATS_V1: readonly CitationSupportedInputFormatV1[] = [
  { id: 'doi', label: 'DOI', description: '裸 DOI、DOI: 前缀或 doi.org URL；整行只能对应一篇论文。', examples: ['10.1038/s41467-024-00000-0', 'DOI: 10.1038/s41467-024-00000-0', 'https://doi.org/10.1038/s41467-024-00000-0'] },
  { id: 'pmid', label: 'PMID', description: '必须带 PMID: 前缀。', examples: ['PMID: 12345678'] },
  { id: 'arxiv', label: 'arXiv', description: '必须使用 arXiv: 前缀或 arxiv.org/abs URL。', examples: ['arXiv: 2401.01234', 'https://arxiv.org/abs/2401.01234'] },
  { id: 'labeled-title', label: '完整题名', description: '必须带 Title: 或 题名：标签，并提供完整、逐字准确的论文题名。', examples: ['Title: A complete and exact scholarly article title', '题名：A complete and exact scholarly article title'] },
  { id: 'structured-reference', label: '结构化参考文献行', description: '接受单条 APA、Vancouver 或 GB/T 风格记录；必须能确定题名与年份，建议同时包含 DOI。', examples: ['Smith J. Exact article title. Journal. 2024;12(3):1-9. doi:10.1234/example', 'Smith, J. (2024). Exact article title. Journal, 12(3), 1-9. https://doi.org/10.1234/example'] },
  { id: 'zotero-field', label: 'Zotero Word 字段', description: '识别真实 ADDIN ZOTERO_ITEM CSL_CITATION 动态字段；不把普通显示文本冒充为 Zotero 字段。', examples: ['Word 中由 Zotero 插入的动态引用字段'] },
  { id: 'endnote-field', label: 'EndNote Word 字段', description: '识别真实 ADDIN EN.CITE / EN.CITE.DATA 动态字段。', examples: ['Word 中由 EndNote 插入的动态引用字段'] },
  { id: 'numeric-mapped-reference', label: '已映射数字引用', description: '方括号或上标数字必须完整映射到参考文献表中符合上述格式的条目；引用簇按原子单元处理。', examples: ['[1]', '[1,3-5]', '上标 1–3'] },
  { id: 'pandoc-zotero-key', label: 'Pandoc 引用键', description: 'Markdown 中使用一个或多个显式 @ZoteroKey。', examples: ['[@ABCD1234]', '[@ABCD1234; @EFGH5678]'] },
  { id: 'tex-citation-key', label: 'TeX 引用键', description: '保留 natbib/biblatex 命令，并按显式键查询 Zotero。', examples: ['\\cite{ABCD1234}', '\\parencite{ABCD1234,EFGH5678}'] },
] as const;

export interface BibliographicCreatorV1 {
  family: string;
  given?: string;
  literal?: string;
}

export interface CitationIdentifierV1 {
  manager?: 'endnote' | 'zotero';
  managerKey?: string;
  doi?: string;
  pmid?: string;
  arxivId?: string;
  title?: string;
  year?: number;
  firstAuthor?: string;
}

export interface BibliographicRecordV1 {
  schemaVersion: 1;
  canonicalId: string;
  itemType: 'journalArticle' | 'conferencePaper' | 'book' | 'bookSection' | 'preprint' | 'report' | 'thesis' | 'other';
  title: string;
  creators: BibliographicCreatorV1[];
  issuedYear?: number;
  containerTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  doi?: string;
  pmid?: string;
  arxivId?: string;
  url?: string;
  abstract?: string;
  language?: string;
  retractionStatus: 'clear' | 'retracted' | 'expression_of_concern' | 'corrected' | 'unknown';
  source: 'zotero' | 'crossref' | 'pubmed' | 'datacite' | 'arxiv' | 'publisher';
  sourceUrl?: string;
  retrievedAt: string;
}

export interface CitationDocumentUnitV1 {
  id: string;
  part: string;
  paragraphIndex: number;
  start: number;
  end: number;
  raw: string;
  context: string;
  kind: CitationUnitKindV1;
  referenceOnly: boolean;
  /** Deterministic whitelist result; absent only for older v4 hosts. */
  recognitionStatus?: 'recognized' | 'needs_input';
  /** Exact whitelist branch used for this unit. */
  recognizedFormat?: CitationRecognizedFormatV1;
  /** One member for a simple citation; multiple members for an atomic numeric cluster. */
  identifiers?: CitationIdentifierV1[];
  numericLabels?: number[];
}

export interface CitationDocumentInspectionV1 {
  schemaVersion: 1;
  source: DocumentRevisionRef;
  format: CitationSourceFormatV1;
  detectedStyleFamily: CitationStyleFamilyV1;
  units: CitationDocumentUnitV1[];
  warnings: string[];
  supportedInputFormats?: readonly CitationSupportedInputFormatV1[];
}

export interface BibliographyQueryV1 {
  id: string;
  raw: string;
  manager?: 'endnote' | 'zotero';
  managerKey?: string;
  title?: string;
  doi?: string;
  pmid?: string;
  arxivId?: string;
  year?: number;
  firstAuthor?: string;
}

export interface BibliographyResolveRequestV1 {
  queries: BibliographyQueryV1[];
  maxCandidates?: number;
}

export interface BibliographyCandidateV1 {
  record: BibliographicRecordV1;
  match: 'exact_identifier' | 'exact_title' | 'candidate';
  score: number;
}

export interface BibliographyResolutionV1 {
  queryId: string;
  status: 'resolved' | 'ambiguous' | 'unrecognized';
  match: 'exact_identifier' | 'exact_title' | 'none';
  record?: BibliographicRecordV1;
  candidates: BibliographyCandidateV1[];
  issues: string[];
}

export interface BibliographyVerificationV1 {
  status: 'verified' | 'conflict' | 'incomplete';
  record: BibliographicRecordV1;
  issues: string[];
  verifiedAt: string;
}

export interface OaAttachmentReceiptV1 {
  schemaVersion: 1;
  status: 'available' | 'unavailable' | 'downloaded' | 'rejected';
  attachmentId?: string;
  sourceUrl?: string;
  license?: string;
  mediaType?: string;
  sha256?: string;
  size?: number;
  reason?: string;
}

export interface ZoteroStatusV1 {
  schemaVersion: 1;
  available: boolean;
  version?: string;
  serverId?: string;
  mode: 'native-local-api' | 'companion' | 'read-only' | 'unavailable';
  capabilities: Array<'read' | 'write' | 'collections' | 'attachments' | 'document-fields'>;
  setup?: { required: boolean; message: string; companionPath?: string };
}

export interface ZoteroItemV1 {
  key: string;
  uri?: string;
  libraryId: number;
  title: string;
  creators: BibliographicCreatorV1[];
  issuedYear?: number;
  doi?: string;
  pmid?: string;
  arxivId?: string;
  url?: string;
}

export interface ZoteroSearchRequestV1 {
  key?: string;
  query?: string;
  doi?: string;
  pmid?: string;
  arxivId?: string;
  title?: string;
  limit?: number;
}

export interface ZoteroSyncItemV1 {
  record: BibliographicRecordV1;
  attachmentIds?: string[];
}

export interface ZoteroCollectionTargetV1 {
  libraryId?: number;
  rootName: string;
  childName: string;
  collectionKey?: string;
}

export interface ZoteroSyncPlanRequestV1 {
  schemaVersion: 1;
  operationKey: string;
  sourceSha256: string;
  target: ZoteroCollectionTargetV1;
  items: ZoteroSyncItemV1[];
}

export interface ZoteroSyncOperationV1 {
  canonicalId: string;
  action: 'create' | 'reuse' | 'conflict';
  existingItemKey?: string;
  attachmentCount: number;
  reason?: string;
}

export interface ZoteroSyncPlanV1 {
  schemaVersion: 1;
  id: string;
  operationKey: string;
  sourceSha256: string;
  target: ZoteroCollectionTargetV1;
  operations: ZoteroSyncOperationV1[];
  expiresAt: string;
}

export interface ZoteroSyncItemReceiptV1 {
  canonicalId: string;
  status: 'created' | 'reused' | 'failed';
  itemKey?: string;
  itemUri?: string;
  attachmentKeys?: string[];
  error?: string;
}

export interface ZoteroSyncReceiptV1 {
  schemaVersion: 1;
  operationKey: string;
  collectionKey?: string;
  collectionName: string;
  items: ZoteroSyncItemReceiptV1[];
  committedAt: string;
  mode: ZoteroStatusV1['mode'];
}

export type CitationDecisionStatusV1 =
  | 'applied'
  | 'unrecognized'
  | 'ambiguous'
  | 'insufficient_support'
  | 'contradicted'
  | 'retracted_or_corrected'
  | 'sync_failed';

export interface CitationDocumentEditV1 {
  unitId: string;
  originalText: string;
  displayText: string;
  status: CitationDecisionStatusV1;
  reason: string;
  record?: BibliographicRecordV1;
  records?: BibliographicRecordV1[];
  zoteroItemKey?: string;
  zoteroItemUri?: string;
  zoteroItems?: Array<{ key: string; uri?: string }>;
  supportEvidence?: string;
}

export interface CitationDocumentPlanV1 {
  schemaVersion: 1;
  operationKey: string;
  source: DocumentRevisionRef;
  format: CitationSourceFormatV1;
  styleId: string;
  styleFamily: CitationStyleFamilyV1;
  edits: CitationDocumentEditV1[];
  bibliographyPolicy: 'dynamic-resolved-with-unresolved-review';
}

export interface CitationMaterializationReceiptV1 {
  schemaVersion: 1;
  operationKey: string;
  readiness: 'submission_ready' | 'partial_review_required';
  output: WorkspacePathRef;
  outputSha256: string;
  mediaType: string;
  appliedCount: number;
  skippedCount: number;
  dynamicFieldCount: number;
  bibliographyGenerated: boolean;
  warnings: string[];
}

export type PluginApiVersion = 1 | 2 | 3 | 4;

export interface ResearchObjectSchemaContribution {
  type: `${string}:${string}`;
  attributesSchema: JsonSchema;
  display?: {
    icon?: string;
    titleProperty?: string;
    summaryProperties?: string[];
  };
}

export interface PluginSurfaceContributionV1 {
  id: string;
  title: string;
  entry: string;
  kind: 'pdf-reader' | 'knowledge-graph' | 'drawing-canvas' | 'custom';
  allowedHostCapabilities: string[];
}

export interface ArtifactRendererContributionV1 {
  id: string;
  artifactKinds: string[];
  entry: string;
}

export interface PluginContributionManifest {
  tools?: string[];
  contextProviders?: string[];
  agentTemplates?: string[];
  /** @deprecated v3 treats legacy presets as user-selectable templates. */
  agentPresets?: string[];
  researchObjectTypes?: string[];
  researchRelationTypes?: string[];
  settingsSchema?: JsonSchema;
  toolCards?: Array<{ tool: string; renderHint: ToolRenderHint }>;
  uiPanels?: Array<{ id: string; title: string; entry: string; tools?: string[] }>;
  workbenches?: WorkbenchContribution[];
  worktableTemplates?: WorktableTemplateContribution[];
  workbenchBlueprints?: WorkbenchBlueprintV1[];
  workflows?: PluginWorkflowDefinition[];
  surfaces?: PluginSurfaceContributionV1[];
  artifactRenderers?: ArtifactRendererContributionV1[];
  toolchainAdapters?: ToolchainAdapterManifestV1[];
  researchObjectSchemas?: ResearchObjectSchemaContribution[];
}

export interface PluginManifest {
  schemaVersion: 1 | 2 | 3 | 4;
  /** Missing on legacy manifests and therefore interpreted as Plugin API v1. */
  apiVersion?: PluginApiVersion;
  id: string;
  name: string;
  version: string;
  engine: string;
  entry: string;
  permissions: Array<PluginPermission | HarnessPluginPermissionV4>;
  contributes: PluginContributionManifest;
}

export interface HarnessPluginManifestV4 extends PluginManifest {
  schemaVersion: 4;
  apiVersion: 4;
  permissions: HarnessPluginPermissionV4[];
}

export interface PluginWorkflowDefinition {
  id: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface PluginWorkflowResult {
  artifactIds: Id[];
  metadata: Record<string, JsonValue>;
}

export interface SkillDescriptor {
  id: string;
  name: string;
  description: string;
  rootPath: string;
  scope: 'user' | 'project' | 'workspace';
  rootId?: Id;
  sha256?: string;
  approvedSha256?: string;
  approvalRequired?: boolean;
  allowedTools: string[];
  references: string[];
  enabled: boolean;
}

export type McpServerConfig =
  | { id: string; name: string; transport: 'stdio'; command: string; args: string[]; envCredentialRefs: Record<string, Id>; enabled: boolean }
  | { id: string; name: string; transport: 'http'; url: string; headerCredentialRefs: Record<string, Id>; enabled: boolean };

export interface McpServerState {
  config: McpServerConfig;
  status: 'disconnected' | 'connecting' | 'connected' | 'failed';
  error?: string;
}

export interface ProjectSummary {
  id: Id;
  name: string;
  rootPath: string;
  openedAt: string;
}

export interface HarnessSettings {
  defaultAgentModel: string;
  utilityModel: string;
  maxConcurrentAgentRuns: number;
  defaultAgentContextBudget: number;
  delegatedAgentContextBudget: number;
  /** Allows unsigned local directory/ZIP plugins. Curated signed packages do
   * not require this mode. It is deliberately off by default. */
  developerMode: boolean;
  securityPolicy: SecurityApprovalPolicy;
}

export type InterfaceThemeId =
  | 'warm-paper'
  | 'cyan-night'
  | 'auto'
  | 'pure-white'
  | 'butter'
  | 'ming'
  | 'absolutely'
  | 'ready-to-catch'
  | 'angry-whale'
  | 'new-warm-paper'
  | 'cyan-night-contrast'
  | 'coral-paper';

export type ContentWidth = 640 | 720 | 800 | 'unbounded';
export type ReadingFont = 'serif' | 'sans';
export type EditorFont = 'follow-reading' | 'serif' | 'sans' | 'monospace';
export type ConcreteInterfaceThemeId = Exclude<InterfaceThemeId, 'auto'>;
export type SemanticColorRole = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
export type SemanticHexColor = `#${string}`;
export type SemanticPalette = Record<SemanticColorRole, SemanticHexColor>;
export type SemanticPaletteOverrides = Partial<Record<ConcreteInterfaceThemeId, Partial<SemanticPalette>>>;

export interface MarkdownAppearance {
  font: EditorFont;
  bodySize: number;
  contentWidth: ContentWidth;
  heading1Size: number;
  heading2Size: number;
  heading3Size: number;
  lineHeight: number;
  contentPadding: number;
}

/** Device-local rendering preferences. These are never part of model context. */
export interface InterfacePreferences {
  schemaVersion: 6;
  theme: InterfaceThemeId;
  semanticPaletteOverrides: SemanticPaletteOverrides;
  readingFont: ReadingFont;
  readingSizeDelta: -2 | -1 | 0 | 1 | 2;
  chatWidth: ContentWidth;
  paperTexture: boolean;
  sunnyMode: boolean;
  hardwareAcceleration: boolean;
  singleLineSessions: boolean;
  markdown: MarkdownAppearance;
  locale: 'zh-CN';
  timeZone: string;
}

export type InterfacePreferencesPatch =
  Partial<Omit<InterfacePreferences, 'schemaVersion' | 'markdown'>>
  & { markdown?: Partial<MarkdownAppearance> };

export interface InterfacePreferencesUpdateResult {
  preferences: InterfacePreferences;
  restartRequired: boolean;
}

export const INTERFACE_THEME_IDS: readonly InterfaceThemeId[] = [
  'warm-paper', 'cyan-night', 'auto', 'pure-white', 'butter', 'ming',
  'absolutely', 'ready-to-catch', 'angry-whale', 'new-warm-paper',
  'cyan-night-contrast', 'coral-paper',
] as const;
export const CONCRETE_INTERFACE_THEME_IDS: readonly ConcreteInterfaceThemeId[] = INTERFACE_THEME_IDS.filter(
  (theme): theme is ConcreteInterfaceThemeId => theme !== 'auto',
);
export const SEMANTIC_COLOR_ROLES: readonly SemanticColorRole[] = [
  'neutral', 'accent', 'success', 'warning', 'danger', 'info',
] as const;

const CONTENT_WIDTHS: readonly ContentWidth[] = [640, 720, 800, 'unbounded'];
const READING_FONTS: readonly ReadingFont[] = ['serif', 'sans'];
const EDITOR_FONTS: readonly EditorFont[] = ['follow-reading', 'serif', 'sans', 'monospace'];
const READING_DELTAS: readonly InterfacePreferences['readingSizeDelta'][] = [-2, -1, 0, 1, 2];
export const READING_BODY_BASE_SIZE = 11.5;
export const MARKDOWN_BODY_SIZE_MIN = 10;
export const MARKDOWN_BODY_SIZE_MAX = 20;

export function systemTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: value }).format(0);
    return true;
  } catch { return false; }
}

export function defaultInterfacePreferences(timeZone = systemTimeZone()): InterfacePreferences {
  return {
    schemaVersion: 6,
    theme: 'warm-paper',
    semanticPaletteOverrides: {},
    readingFont: 'sans',
    readingSizeDelta: 0,
    chatWidth: 800,
    paperTexture: true,
    sunnyMode: false,
    hardwareAcceleration: true,
    singleLineSessions: false,
    markdown: {
      font: 'follow-reading',
      bodySize: 12,
      contentWidth: 800,
      heading1Size: 21,
      heading2Size: 17,
      heading3Size: 14,
      lineHeight: 1.5,
      contentPadding: 24,
    },
    locale: 'zh-CN',
    timeZone: isValidTimeZone(timeZone) ? timeZone : 'UTC',
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number, integer = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const bounded = Math.min(maximum, Math.max(minimum, value));
  return integer ? Math.round(bounded) : Math.round(bounded * 10) / 10;
}

export function isSemanticHexColor(value: unknown): value is SemanticHexColor {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value);
}

function normalizeSemanticPaletteOverrides(value: unknown): SemanticPaletteOverrides {
  const input = recordValue(value);
  const normalized: SemanticPaletteOverrides = {};
  for (const theme of CONCRETE_INTERFACE_THEME_IDS) {
    const candidate = recordValue(input[theme]);
    const palette: Partial<SemanticPalette> = {};
    for (const role of SEMANTIC_COLOR_ROLES) {
      const color = candidate[role];
      if (isSemanticHexColor(color)) palette[role] = color.toUpperCase() as SemanticHexColor;
    }
    if (Object.keys(palette).length > 0) normalized[theme] = palette;
  }
  return normalized;
}

/** Sanitizes old, partial, or externally edited desktop preferences. */
export function normalizeInterfacePreferences(value: unknown, timeZone = systemTimeZone()): InterfacePreferences {
  const defaults = defaultInterfacePreferences(timeZone);
  const input = recordValue(value);
  const markdown = recordValue(input.markdown);
  const sourceSchemaVersion = typeof input.schemaVersion === 'number' && Number.isFinite(input.schemaVersion) ? input.schemaVersion : 0;
  const theme = INTERFACE_THEME_IDS.includes(input.theme as InterfaceThemeId) ? input.theme as InterfaceThemeId : defaults.theme;
  const readingFont = sourceSchemaVersion >= 3 && READING_FONTS.includes(input.readingFont as ReadingFont)
    ? input.readingFont as ReadingFont
    : defaults.readingFont;
  const readingSizeDelta = READING_DELTAS.includes(input.readingSizeDelta as InterfacePreferences['readingSizeDelta'])
    ? input.readingSizeDelta as InterfacePreferences['readingSizeDelta']
    : defaults.readingSizeDelta;
  const chatWidth = CONTENT_WIDTHS.includes(input.chatWidth as ContentWidth) ? input.chatWidth as ContentWidth : defaults.chatWidth;
  const editorFont = EDITOR_FONTS.includes(markdown.font as EditorFont) ? markdown.font as EditorFont : defaults.markdown.font;
  const editorWidth = CONTENT_WIDTHS.includes(markdown.contentWidth as ContentWidth) ? markdown.contentWidth as ContentWidth : defaults.markdown.contentWidth;
  const markdownBodySize = typeof markdown.bodySize !== 'number' || sourceSchemaVersion >= 5 || sourceSchemaVersion === 0
    ? markdown.bodySize
    : sourceSchemaVersion === 4 ? markdown.bodySize + 0.5 : markdown.bodySize - 4;
  const heading1Size = sourceSchemaVersion > 0 && sourceSchemaVersion < 6 && typeof markdown.heading1Size === 'number'
    ? markdown.heading1Size - (sourceSchemaVersion === 5 ? 1 : 7)
    : markdown.heading1Size;
  const heading2Size = sourceSchemaVersion > 0 && sourceSchemaVersion < 6 && typeof markdown.heading2Size === 'number'
    ? markdown.heading2Size - (sourceSchemaVersion === 5 ? 1 : 4)
    : markdown.heading2Size;
  const heading3Size = sourceSchemaVersion > 0 && sourceSchemaVersion < 6 && typeof markdown.heading3Size === 'number'
    ? markdown.heading3Size - (sourceSchemaVersion === 5 ? 1 : 4)
    : markdown.heading3Size;
  return {
    schemaVersion: 6,
    theme,
    semanticPaletteOverrides: normalizeSemanticPaletteOverrides(input.semanticPaletteOverrides),
    readingFont,
    readingSizeDelta,
    chatWidth,
    paperTexture: typeof input.paperTexture === 'boolean' ? input.paperTexture : defaults.paperTexture,
    sunnyMode: typeof input.sunnyMode === 'boolean' ? input.sunnyMode : defaults.sunnyMode,
    hardwareAcceleration: typeof input.hardwareAcceleration === 'boolean' ? input.hardwareAcceleration : defaults.hardwareAcceleration,
    singleLineSessions: typeof input.singleLineSessions === 'boolean' ? input.singleLineSessions : defaults.singleLineSessions,
    markdown: {
      font: editorFont,
      bodySize: boundedNumber(markdownBodySize, defaults.markdown.bodySize, MARKDOWN_BODY_SIZE_MIN, MARKDOWN_BODY_SIZE_MAX, false),
      contentWidth: editorWidth,
      heading1Size: boundedNumber(heading1Size, defaults.markdown.heading1Size, 16, 36),
      heading2Size: boundedNumber(heading2Size, defaults.markdown.heading2Size, 14, 30),
      heading3Size: boundedNumber(heading3Size, defaults.markdown.heading3Size, 12, 24),
      lineHeight: boundedNumber(markdown.lineHeight, defaults.markdown.lineHeight, 1.2, 2.2, false),
      contentPadding: boundedNumber(markdown.contentPadding, defaults.markdown.contentPadding, 0, 64),
    },
    locale: 'zh-CN',
    timeZone: isValidTimeZone(input.timeZone) ? input.timeZone : defaults.timeZone,
  };
}

export function mergeInterfacePreferences(current: InterfacePreferences, patch: InterfacePreferencesPatch): InterfacePreferences {
  return normalizeInterfacePreferences({
    ...current,
    ...patch,
    schemaVersion: 6,
    markdown: { ...current.markdown, ...patch.markdown },
  }, current.timeZone);
}

export type PrimaryAgentAvatar = AgentAvatar;
export type PrimaryAgentRole = 'research_partner' | 'rigorous_scholar' | 'creative_explorer' | 'custom';

export interface PrimaryAgentProfile {
  configured: boolean;
  name: string;
  avatar: PrimaryAgentAvatar;
  role: PrimaryAgentRole;
  identity: string;
  instructions: string;
  configuredAt?: string;
  updatedAt?: string;
}

export interface PrimaryAgentProfileUpdate {
  name: string;
  avatar?: PrimaryAgentAvatar;
  role?: PrimaryAgentRole;
  identity?: string;
  instructions?: string;
}

export interface UserProfile {
  name: string;
  profile: string;
  avatar?: string;
  updatedAt?: string;
}

export interface UserProfileUpdate {
  name: string;
  profile: string;
  avatar?: string | null;
}

export interface SessionSummary {
  id: Id;
  projectId: Id;
  title: string;
  status: 'idle' | 'running' | 'interrupted' | 'archived';
  updatedAt: string;
  model: string;
  /** Lead Agent assigned to this conversation. Older persisted sessions may not contain it. */
  leadAgentId?: Id;
  /** Temporary chats live only in the current Runtime process and never enter history. */
  temporary?: boolean;
}

export interface TimelineNode {
  id: Id;
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'approval' | 'agent' | 'artifact' | 'notice';
  title?: string;
  content: string;
  status?: string;
  timestamp: string;
  agentId?: Id;
  metadata: Record<string, JsonValue>;
}

export interface WorkspacePathRef {
  rootId: Id;
  path: string;
}

export type WorkspaceRootKind = 'project' | 'authorized';
export type WorkspaceRootStatus = 'online' | 'offline' | 'pending_confirmation';

export interface WorkspaceRootSummary {
  id: Id;
  name: string;
  displayPath: string;
  kind: WorkspaceRootKind;
  access: WorkspaceAccessMode;
  status: WorkspaceRootStatus;
}

export interface WorkspaceEntry extends WorkspacePathRef {
  name: string;
  kind: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  mediaType?: string;
}

export interface SessionWorkspace {
  sessionId: Id;
  activeRootId: Id;
  roots: WorkspaceRootSummary[];
  note: string;
  model: string;
  conversationFileCount: number;
}

export type ConversationFileOrigin = 'upload' | 'reference' | 'agent' | 'artifact';

export interface ConversationFile {
  id: Id;
  ref: WorkspacePathRef;
  name: string;
  origin: ConversationFileOrigin;
  size: number;
  mediaType?: string;
  createdAt: string;
  artifactId?: Id;
  sourceEventIds: Id[];
}

export interface TurnVariant {
  id: Id;
  turnId: Id;
  assistantNodeIds: Id[];
  createdAt: string;
  status: 'streaming' | 'completed' | 'interrupted' | 'failed';
}

export interface TurnVariantGroup {
  turnId: Id;
  activeVariantId: Id;
  variants: TurnVariant[];
  locked: boolean;
}

export interface WorkspacePreview {
  ref: WorkspacePathRef;
  name: string;
  mediaType?: string;
  size: number;
  kind: 'text' | 'image' | 'pdf' | 'word' | 'metadata';
  content?: string;
  dataUrl?: string;
  truncated?: boolean;
}

export interface WorkspaceSearchResult {
  entry: WorkspaceEntry;
  matches?: Array<{ line: number; preview: string }>;
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentRevisionRef {
  ref: WorkspacePathRef;
  sha256: string;
  mediaType?: string;
  artifactId?: Id;
  artifactRevisionId?: Id;
}

export interface DocumentDescriptor extends DocumentRevisionRef {
  id: Id;
  name: string;
  size: number;
  languageId: string;
  readOnly: boolean;
  modifiedAt: string;
}

export interface DocumentBuffer {
  id: Id;
  document: DocumentDescriptor;
  baseSha256: string;
  content: string;
  dirty: boolean;
  recovered: boolean;
  openedAt: string;
  updatedAt: string;
}

export interface WorkspaceTextEdit {
  ref: WorkspacePathRef;
  baseSha256: string | null;
  content: string;
}

export interface WorkspaceEditRequest {
  label: string;
  edits: WorkspaceTextEdit[];
  origin: 'user' | 'agent' | 'plugin';
  traceId?: Id;
  agentId?: Id;
  pluginId?: string;
}

export interface WorkspaceEditFilePreview {
  ref: WorkspacePathRef;
  beforeSha256: string | null;
  afterSha256: string;
  diff: string;
}

export interface WorkspaceEditPreview {
  id: Id;
  label: string;
  origin: WorkspaceEditRequest['origin'];
  files: WorkspaceEditFilePreview[];
  createdAt: string;
  expiresAt: string;
}

export interface WorkspaceEditGroup extends WorkspaceEditPreview {
  changeSetIds: Id[];
  appliedAt: string;
  revertedAt?: string;
}

export interface ResourceHandle {
  id: Id;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  etag: string;
  expiresAt: string;
  source: DocumentRevisionRef;
}

export type JobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ArtifactFileRole = 'source' | 'data' | 'environment' | 'output' | 'log' | 'mapping';

export interface JobInput {
  ref: WorkspacePathRef;
  destination?: string;
  role?: ArtifactFileRole;
}

export interface JobOutputSpec {
  /** Exact relative output path. Exactly one of path or glob is required. */
  path?: string;
  /** Safe relative glob. Supported syntax is *, ?, and ** path segments. */
  glob?: string;
  /** Root, relative to the job workspace, used when publishing glob matches. */
  base?: string;
  role: ArtifactFileRole;
  mediaType?: string;
  required?: boolean;
}

export interface JobSpec {
  title: string;
  executable: string;
  args: string[];
  cwd?: WorkspacePathRef;
  inputs: JobInput[];
  outputs: JobOutputSpec[];
  environment?: Record<string, string>;
  toolchainId?: Id;
  timeoutMs?: number;
  network?: boolean;
  origin: 'user' | 'agent' | 'plugin';
  traceId?: Id;
  agentId?: Id;
  pluginId?: string;
  worktableInstanceId?: Id;
}

export interface JobOutput {
  role: ArtifactFileRole;
  path: string;
  ref: WorkspacePathRef;
  mediaType?: string;
  size: number;
  sha256: string;
}

export interface JobRecord {
  id: Id;
  projectId: Id;
  spec: JobSpec;
  status: JobStatus;
  progress?: number;
  stage?: string;
  logBytes: number;
  outputs: JobOutput[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
  /** Present for host-managed persistent plugin workflows. */
  workflow?: { id: string; resumeCount: number };
  artifactIds?: Id[];
  metadata?: Record<string, JsonValue>;
}

export type AnnotationSelector =
  | { kind: 'image-point'; x: number; y: number }
  | { kind: 'image-rect'; x: number; y: number; width: number; height: number }
  | { kind: 'pdf-rect'; page: number; rects: NormalizedRect[] }
  | { kind: 'pdf-text'; page: number; rects: NormalizedRect[]; exact: string }
  /** Stable plugin-defined anchor for structured documents such as DOCX. */
  | { kind: 'document-anchor'; scheme: string; anchor: string; start?: number; end?: number; exact?: string };

export interface AnnotationComment {
  id: Id;
  actor: EventActor;
  content: string;
  createdAt: string;
}

export interface Annotation {
  id: Id;
  projectId: Id;
  target: DocumentRevisionRef;
  selector: AnnotationSelector;
  comments: AnnotationComment[];
  status: 'open' | 'submitted' | 'resolved' | 'dismissed' | 'stale';
  sourceEventIds: Id[];
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationSet {
  id: Id;
  projectId: Id;
  annotationIds: Id[];
  status: 'draft' | 'submitted' | 'resolved';
  submittedTurnId?: Id;
  createdAt: string;
  submittedAt?: string;
}

export interface SourceSpan {
  ref: WorkspacePathRef;
  startLine: number;
  startColumn?: number;
  endLine: number;
  endColumn?: number;
  semanticId?: string;
}

export interface SourceMapRegion {
  selector: AnnotationSelector;
  sources: SourceSpan[];
}

export interface SourceMapDescriptor {
  id: Id;
  projectId: Id;
  target: DocumentRevisionRef;
  regions: SourceMapRegion[];
  pluginId?: string;
  createdAt: string;
}

export interface ArtifactRevisionFile {
  role: ArtifactFileRole;
  ref?: WorkspacePathRef;
  name: string;
  mediaType?: string;
  sha256: string;
  size: number;
  archivedPath?: string;
  external?: boolean;
}

export interface CreateArtifactRevisionFileInput {
  role: ArtifactFileRole;
  ref?: WorkspacePathRef;
  /** UTF-8 inline content is atomically archived by the host. */
  content?: string;
  name: string;
  mediaType?: string;
}

export interface ArtifactRevision {
  id: Id;
  artifactId: Id;
  parentRevisionId?: Id;
  files: ArtifactRevisionFile[];
  jobId?: Id;
  annotationSetIds: Id[];
  provenance: ArtifactProvenance;
  status: 'active' | 'archived';
  createdAt: string;
  archivedAt?: string;
}

export type WorkbenchViewKind = 'files' | 'editor' | 'image' | 'pdf' | 'annotations' | 'jobs' | 'environment' | 'custom';

export interface WorkbenchViewDescriptor {
  id: string;
  title: string;
  kind: WorkbenchViewKind;
  role?: ArtifactFileRole;
  panelId?: string;
}

export interface WorkbenchContribution {
  id: string;
  title: string;
  pluginId?: string;
  accepts: { mediaTypes?: string[]; objectTypes?: string[] };
  views: WorkbenchViewDescriptor[];
  commands: string[];
}

export interface WorkbenchTab {
  id: Id;
  title: string;
  workbenchId: string;
  pluginId?: string;
  document?: DocumentRevisionRef;
  artifactId?: Id;
  artifactRevisionId?: Id;
  activeViewId: string;
  openedAt: string;
}

export interface WorkbenchState {
  tabs: WorkbenchTab[];
  activeTabId?: Id;
  maximized: boolean;
  reveal?: {
    id: Id;
    tabId: Id;
    document: DocumentRevisionRef;
    selector: Extract<AnnotationSelector, { kind: 'pdf-rect' | 'pdf-text' }>;
    requestedAt: string;
  };
}

/** Top-level renderer mode. `worktable` is a private route token; Plugin API v4
 * exposes only Workbench-named contracts. */
export type AppMode = 'chat' | 'worktable' | 'channels';

export type WorktableBuiltinKind =
  | 'explorer'
  | 'terminal'
  | 'browser'
  | 'scm'
  | 'tasks'
  | 'control-room';

export type WorktableContent =
  | { kind: 'builtin'; type: WorktableBuiltinKind }
  | { kind: 'plugin-panel'; pluginId: string; panelId: string }
  | { kind: 'document'; target: DocumentRevisionRef }
  | { kind: 'artifact'; artifactId: Id; revisionId?: Id; role?: ArtifactFileRole }
  | { kind: 'generated-app'; appId: Id; revisionId: Id };

export interface WorktableTab {
  id: Id;
  title: string;
  content: WorktableContent;
  pinned?: boolean;
  openedAt: string;
}

export interface WorktablePane {
  id: Id;
  title?: string;
  tabs: WorktableTab[];
  activeTabId?: Id;
}

export type WorktableSplitNode =
  | { kind: 'split'; direction: 'horizontal' | 'vertical'; ratio: number; first: WorktableSplitNode; second: WorktableSplitNode }
  | { kind: 'pane'; paneId: Id };

export type WorktableInputUiControl =
  | { kind: 'file'; field: string; label: string; accept?: string[]; multiple?: boolean; required?: boolean }
  | { kind: 'text'; field: string; label: string; placeholder?: string; required?: boolean }
  | { kind: 'select'; field: string; label: string; options: Array<{ value: JsonPrimitive; label: string }>; required?: boolean };

export interface WorktableInputUi {
  controls: WorktableInputUiControl[];
  /** When true, the user may create an unconfigured task even if the workflow normally expects a file. */
  allowDefer?: boolean;
}

export interface WorkbenchPanelAppearance {
  theme: Exclude<InterfaceThemeId, 'auto'>;
  colorScheme: 'light' | 'dark';
  semantic: SemanticPalette;
  surface: { background: string; panel: string; raised: string; line: string; text: string; muted: string };
}

export interface WorktableTemplateContribution {
  id: string;
  /** Immutable template contract version copied onto every created instance. */
  version: string;
  title: string;
  description?: string;
  icon?: string;
  pluginId?: string;
  kind?: 'research' | 'generated';
  /** JSON object schema used to validate the task inputs that seed an instance. */
  inputSchema: JsonSchema;
  /** Declarative first-party creation form. Plugins never render the file picker themselves. */
  inputUi?: WorktableInputUi;
  layout: WorktableSplitNode;
  panes: WorktablePane[];
  commands?: string[];
}

export interface WorktableInstance {
  id: Id;
  projectId: Id;
  templateId?: string;
  templateVersion?: string;
  title: string;
  icon: string;
  kind: 'research' | 'generated';
  status: 'idle' | 'running' | 'needs_input' | 'completed' | 'failed' | 'archived';
  boundSessionId?: Id;
  revision: number;
  inputs: Record<string, JsonValue>;
  activeRunId?: Id;
  artifactId?: Id;
  artifactRevisionId?: Id;
  layout: WorktableSplitNode;
  panes: WorktablePane[];
  activePaneId?: Id;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface WorktableState {
  instances: WorktableInstance[];
  activeInstanceId?: Id;
  reveal?: {
    id: Id;
    instanceId: Id;
    document: DocumentRevisionRef;
    selector: AnnotationSelector;
    targetPaneId: Id;
    targetTabId: Id;
    requestedAt: string;
  };
}

export interface WorktableRevealTarget {
  paneId?: Id;
  tabId?: Id;
  /** Resolves to a plugin-panel tab owned by the calling plugin. */
  panelId?: string;
}

/** Device-local geometry. This state is never included in model context or provenance. */
export interface WorktableDeviceUiState {
  drawerWidth: number;
  chatWidth: number;
  chatHeight: number;
  drawerCollapsed: boolean;
  chatCollapsed: boolean;
  paneRatios: Record<string, number>;
  /** Device-local navigation; changing these values never mutates a task revision. */
  focusedPaneId?: Id;
  activeTabIds?: Record<Id, Id>;
  maximizedPaneId?: Id | null;
  openInstanceIds?: Id[];
}

/** Public Harness Workbench v1 contracts. The current Worktable engine is an
 * implementation detail; plugins and generated applications use these names. */
export const WORKBENCH_BLUEPRINT_VERSION = 1 as const;

export interface ResourceRevisionRef {
  id: Id;
  projectId: Id;
  document: DocumentRevisionRef;
  createdAt: string;
}

export interface ArtifactRevisionRef {
  artifactId: Id;
  revisionId: Id;
}

export interface EvidenceAnchorV1 {
  id: Id;
  projectId: Id;
  target: DocumentRevisionRef;
  /** One-based PDF page when the source has stable pages. */
  page?: number;
  /** Stable extractor block identity. */
  blockId?: string;
  selector: AnnotationSelector;
  asset?: { kind: 'figure' | 'table' | 'formula'; id: string };
  exact?: string;
  createdAt: string;
}

export interface AnnotationV1 extends Annotation {
  schemaVersion: 1;
  revision: number;
  evidenceAnchorIds: Id[];
}

export type WorkbenchSlotRole =
  | 'primary'
  | 'source'
  | 'analysis'
  | 'evidence'
  | 'tasks'
  | 'review'
  | 'output'
  | `${string}:${string}`;

export interface WorkbenchSlotV1 {
  id: string;
  role: WorkbenchSlotRole;
  paneId: string;
  title: string;
  accepts: Array<WorktableContent['kind']>;
  /** Only declared automatic slots may receive a MountIntent without a layout
   * confirmation. */
  autoMount: boolean;
}

export interface WorkbenchBlueprintV1 {
  schemaVersion: typeof WORKBENCH_BLUEPRINT_VERSION;
  id: string;
  version: string;
  title: string;
  description?: string;
  icon?: string;
  pluginId?: string;
  kind: 'research' | 'generated';
  inputSchema: JsonSchema;
  inputUi?: WorktableInputUi;
  layout: WorktableSplitNode;
  panes: WorktablePane[];
  slots: WorkbenchSlotV1[];
  commands: string[];
}

export interface WorkbenchInstanceV1 extends WorktableInstance {
  schemaVersion: 1;
  blueprintId: string;
  blueprintVersion: string;
  primaryConversationId?: Id;
  slots: WorkbenchSlotV1[];
}

export interface WorkbenchDeviceStateV1 extends WorktableDeviceUiState {
  schemaVersion: 1;
  instanceId: Id;
  deviceId: Id;
}

export interface MountIntentV1 {
  schemaVersion: 1;
  idempotencyKey: Id;
  instanceId: Id;
  targetRole: WorkbenchSlotRole;
  artifact: ArtifactRevisionRef;
  title?: string;
  presentation?: { rendererId?: string; role?: ArtifactFileRole };
}

export interface LayoutProposalV1 {
  schemaVersion: 1;
  id: Id;
  instanceId: Id;
  baseRevision: number;
  title: string;
  reason: string;
  layout: WorktableSplitNode;
  panes: WorktablePane[];
  slots: WorkbenchSlotV1[];
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
  createdAt: string;
  decidedAt?: string;
}

export interface RunRecordV1 {
  id: Id;
  projectId: Id;
  instanceId: Id;
  primaryConversationId?: Id;
  kind: 'agent' | 'model' | 'workflow' | 'toolchain';
  status: JobStatus | AgentRunStatus;
  progress?: number;
  stage?: string;
  inputRefs: Id[];
  outputRefs: Id[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewRequestV1 {
  id: Id;
  projectId: Id;
  instanceId: Id;
  runId?: Id;
  title: string;
  description: string;
  artifact?: ArtifactRevisionRef;
  evidenceAnchorIds: Id[];
  requiredRole: Extract<ProjectRole, 'owner' | 'editor' | 'reviewer'>;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requestedBy: EventActor;
  decidedBy?: EventActor;
  createdAt: string;
  decidedAt?: string;
}

export interface GeneratedAppBlueprintV1 {
  schemaVersion: 1;
  id: Id;
  projectId: Id;
  title: string;
  prompt: string;
  workbench: WorkbenchBlueprintV1;
  entry: string;
  hostCapabilities: string[];
  networkDomains: string[];
  artifact?: ArtifactRevisionRef;
  buildLog?: string;
  error?: string;
  status: 'draft' | 'awaiting_confirmation' | 'building' | 'preview' | 'accepted' | 'rejected' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface ToolchainAdapterOperationV1 {
  id: string;
  title: string;
  inputSchema: JsonSchema;
  outputs: JobOutputSpec[];
  requiresConfirmation: boolean;
}

export interface ToolchainAdapterManifestV1 {
  schemaVersion: 1;
  id: string;
  version: string;
  title: string;
  platforms: Array<'win32'>;
  executableNames: string[];
  versionArgs: string[];
  operations: ToolchainAdapterOperationV1[];
}

export interface ToolRunV1 {
  id: Id;
  projectId: Id;
  adapterId: string;
  operationId: string;
  jobId: Id;
  status: JobStatus;
  artifactRevisionIds: Id[];
  createdAt: string;
  updatedAt: string;
}

export type PaperReaderStatusV1 =
  | 'unconfigured'
  | 'ready'
  | 'inspecting'
  | 'parsing'
  | 'analyzing'
  | 'completed'
  | 'unsupported_scanned'
  | 'interrupted'
  | 'failed';

export interface PaperReaderBatchAuthorizationV1 {
  schemaVersion: 1;
  id: Id;
  instanceId: Id;
  documentSha256: string;
  model: string;
  scope: 'full_text_translation_and_analysis';
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  maximumTotalTokens: number;
  modelCallLimit: number;
  completedModelCalls: number;
  consumedTokens: number;
  status: 'active' | 'completed' | 'revoked' | 'exhausted';
  actorId: Id;
  authorizedAt: string;
  updatedAt: string;
}

/** Small, replayable state kept in the shared event log. Parsed page content is
 * revision-bound job output and is loaded only by the sandbox panel that needs
 * it, instead of being duplicated into every bootstrap snapshot. */
export interface PaperReaderInstanceV1 {
  schemaVersion: 1;
  instanceId: Id;
  projectId: Id;
  mainDocument?: DocumentRevisionRef;
  supportingDocument?: DocumentRevisionRef;
  status: PaperReaderStatusV1;
  stage: string;
  progress: number;
  inspectionJobId?: Id;
  parseJobId?: Id;
  supportingParseJobId?: Id;
  runId?: Id;
  parsedDocument?: WorkspacePathRef;
  supportingParsedDocument?: WorkspacePathRef;
  reportArtifact?: ArtifactRevisionRef;
  blockCount: number;
  figureCount: number;
  evidenceAnchorIds: Id[];
  conclusionCount: number;
  termCount: number;
  generationVersion: number;
  /** The one explicit, revision-scoped approval that covers every model call
   * in this full-paper run. It cannot be reused for another PDF revision. */
  batchAuthorization?: PaperReaderBatchAuthorizationV1;
  inspectedTextCharacters?: number;
  inspectedPageCount?: number;
  translationBlockCount?: number;
  translatedBlockCount?: number;
  modelGenerationIds?: Id[];
  autoFollow: boolean;
  activeBlockId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CuratedPluginCatalogEntryV1 {
  id: string;
  version: string;
  name: string;
  description: string;
  packageUrl: string;
  sha256: string;
  permissions: HarnessPluginPermissionV4[];
  publishedAt: string;
}

export interface CuratedPluginRevocationV1 {
  id: string;
  version?: string;
  reason: string;
  revokedAt: string;
}

export interface CuratedPluginCatalogIndexV1 {
  schemaVersion: 1;
  sequence: number;
  generatedAt: string;
  entries: CuratedPluginCatalogEntryV1[];
  revocations: CuratedPluginRevocationV1[];
}

export interface SignedPluginCatalogV1 {
  keyId: string;
  algorithm: 'Ed25519';
  index: CuratedPluginCatalogIndexV1;
  signature: string;
}

export interface WorktableContextSnapshot {
  instanceId: Id;
  title: string;
  boundSessionId?: Id;
  activePaneId?: Id;
  panes: Array<{
    id: Id;
    title: string;
    activeTab?: {
      kind: WorktableContent['kind'];
      title: string;
      document?: DocumentRevisionRef;
      artifactRevisionId?: Id;
      trust: 'trusted-user' | 'untrusted-external' | 'untrusted-plugin';
    };
  }>;
  pendingJobs: Id[];
  openAnnotationIds: Id[];
  reveal?: NonNullable<WorktableState['reveal']>;
  revision: number;
}

export interface BrowserProfileSummary {
  id: Id;
  name: string;
  partitionId: string;
  authorizedProjectIds: Id[];
  status: 'ready' | 'locked' | 'unavailable';
  createdAt: string;
  updatedAt: string;
}

export interface BrowserSessionSummary {
  id: Id;
  profileId: Id;
  instanceId: Id;
  paneId: Id;
  surface?: 'worktable' | 'workspace_preview';
  url: string;
  title: string;
  status: 'idle' | 'loading' | 'ready' | 'crashed' | 'closed';
  canGoBack?: boolean;
  canGoForward?: boolean;
  authorizedDomains: string[];
  observationRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserObservation {
  id: Id;
  sessionId: Id;
  revision: number;
  url: string;
  title: string;
  text: string;
  elements: Array<{ ref: string; role: string; name: string; disabled?: boolean; sensitive?: boolean }>;
  screenshotArtifactId?: Id;
  sourceEventIds: Id[];
  createdAt: string;
}

export interface GeneratedWorktableApp {
  id: Id;
  projectId: Id;
  title: string;
  artifactId: Id;
  activeRevisionId: Id;
  entry: string;
  networkDomains: string[];
  hostCapabilities: string[];
  status: 'building' | 'ready' | 'failed' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface PluginStorageEntry {
  pluginId: string;
  scope: 'user' | 'project' | 'session';
  key: string;
  value: JsonValue;
  revision: number;
  updatedAt: string;
}

export interface ToolchainDescriptor {
  id: Id;
  kind: string;
  name: string;
  version: string;
  rootName: string;
  executableNames: string[];
  sha256: string;
  status: 'available' | 'invalid' | 'missing';
  source: 'bundled' | 'user';
  installedAt?: string;
  capabilities?: string[];
  workerVersion?: string;
  error?: string;
}

export interface BootstrapSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  mode: 'demo' | 'connected';
  project: ProjectSummary;
  /** Compatibility projection for pre-v3 onboarding consumers. */
  primaryAgent: PrimaryAgentProfile;
  userProfile?: UserProfile;
  settings: HarnessSettings;
  sessions: SessionSummary[];
  /** All persisted conversations in the local event store, across project scopes. */
  sessionCatalog?: SessionSummary[];
  activeSessionId: Id;
  timeline: TimelineNode[];
  workspace: SessionWorkspace;
  conversationFiles: ConversationFile[];
  turnVariants: TurnVariantGroup[];
  workspaceEditPreviews: WorkspaceEditPreview[];
  workspaceEditGroups: WorkspaceEditGroup[];
  workbench: WorkbenchState;
  workbenchContributions: WorkbenchContribution[];
  worktable: WorktableState;
  worktableTemplates: WorktableTemplateContribution[];
  workbenchBlueprints: WorkbenchBlueprintV1[];
  workbenchInstances: WorkbenchInstanceV1[];
  layoutProposals: LayoutProposalV1[];
  evidenceAnchors: EvidenceAnchorV1[];
  runRecords: RunRecordV1[];
  reviewRequests: ReviewRequestV1[];
  browserProfiles: BrowserProfileSummary[];
  browserSessions: BrowserSessionSummary[];
  generatedApps: GeneratedWorktableApp[];
  generatedAppBlueprints: GeneratedAppBlueprintV1[];
  annotations: Annotation[];
  annotationSets: AnnotationSet[];
  artifactRevisions: ArtifactRevision[];
  sourceMaps: SourceMapDescriptor[];
  jobs: JobRecord[];
  toolchains: ToolchainDescriptor[];
  toolchainAdapters: ToolchainAdapterManifestV1[];
  toolRuns: ToolRunV1[];
  paperReaders: PaperReaderInstanceV1[];
  agentDefinitions: AgentDefinition[];
  agentTemplates: AgentTemplate[];
  projectAgents: ProjectAgentBinding[];
  sessionAgentBinding: SessionAgentBinding;
  capabilitySnapshots: AgentCapabilitySnapshot[];
  agentRuns: AgentRun[];
  toolCapabilities: ToolCapabilityDescriptor[];
  memorySummaries: AgentMemorySummary[];
  channels: CollaborationChannel[];
  activeChannelId?: Id;
  activeChannelMessages: ChannelMessage[];
  tasks: AgentTask[];
  researchObjects: ResearchObject[];
  relations: ResearchRelation[];
  provenance: ArtifactProvenance[];
  contextPlan: ContextPlan;
  skills: SkillDescriptor[];
  mcpServers: McpServerState[];
  plugins: Array<{ manifest: PluginManifest; enabled: boolean; trusted: boolean; integrity: 'verified' | 'unlocked' | 'mismatch'; error?: string; settings: JsonValue }>;
  pluginCatalog: {
    status: { source: 'cache' | 'empty'; sequence: number; generatedAt?: string; error?: string };
    entries: CuratedPluginCatalogEntryV1[];
  };
  pendingApprovals: ApprovalRequest[];
  providers: ModelProviderState[];
  models: ModelDescriptor[];
}

export type ServerPushMessage =
  | { type: 'snapshot'; snapshot: BootstrapSnapshot }
  | { type: 'profile.changed'; profile: PrimaryAgentProfile }
  | { type: 'user-profile.changed'; profile: UserProfile }
  | { type: 'sessions.changed'; sessions: SessionSummary[]; activeSessionId: Id }
  | { type: 'timeline.append'; node: TimelineNode }
  | { type: 'timeline.patch'; id: Id; patch: Partial<TimelineNode> }
  | { type: 'workspace.changed'; workspace: SessionWorkspace }
  | { type: 'conversation-files.changed'; files: ConversationFile[] }
  | { type: 'turn-variants.changed'; variants: TurnVariantGroup[] }
  | { type: 'workspace-edits.changed'; previews: WorkspaceEditPreview[]; groups: WorkspaceEditGroup[] }
  | { type: 'workbench.changed'; workbench: WorkbenchState; contributions: WorkbenchContribution[] }
  | { type: 'worktable.changed'; worktable: WorktableState; templates: WorktableTemplateContribution[] }
  | { type: 'workbench-v1.changed'; blueprints: WorkbenchBlueprintV1[]; instances: WorkbenchInstanceV1[]; proposals: LayoutProposalV1[] }
  | { type: 'scientific-kernel.changed'; evidenceAnchors: EvidenceAnchorV1[]; runs: RunRecordV1[]; reviews: ReviewRequestV1[] }
  | { type: 'browser.changed'; profiles: BrowserProfileSummary[]; sessions: BrowserSessionSummary[] }
  | { type: 'terminal.changed'; instanceId: Id; paneId: Id; status: 'idle' | 'running' | 'interrupted' | 'closed' }
  | { type: 'scm.changed'; instanceId: Id; revision: number }
  | { type: 'generated-app.changed'; apps: GeneratedWorktableApp[] }
  | { type: 'generated-blueprints.changed'; blueprints: GeneratedAppBlueprintV1[] }
  | { type: 'annotations.changed'; annotations: Annotation[]; annotationSets: AnnotationSet[] }
  | { type: 'artifact-revisions.changed'; revisions: ArtifactRevision[] }
  | { type: 'source-maps.changed'; sourceMaps: SourceMapDescriptor[] }
  | { type: 'jobs.changed'; jobs: JobRecord[] }
  | { type: 'toolchains.changed'; toolchains: ToolchainDescriptor[] }
  | { type: 'tool-runs.changed'; adapters: ToolchainAdapterManifestV1[]; runs: ToolRunV1[] }
  | { type: 'paper-readers.changed'; readers: PaperReaderInstanceV1[] }
  | { type: 'capabilities.changed'; revision: number; reason: string }
  | { type: 'providers.changed'; providers: ModelProviderState[]; models: ModelDescriptor[] }
  | { type: 'agent-definitions.changed'; definitions: AgentDefinition[]; projectAgents: ProjectAgentBinding[] }
  | { type: 'session-agents.changed'; binding: SessionAgentBinding; runs: AgentRun[]; tasks: AgentTask[] }
  | { type: 'agent-memory.changed'; summaries: AgentMemorySummary[]; agentId?: Id }
  | { type: 'agent-tools.changed'; capabilities: ToolCapabilityDescriptor[]; agentId?: Id }
  | { type: 'channels.changed'; channels: CollaborationChannel[]; activeChannelId?: Id }
  | { type: 'channel-messages.changed'; channelId: Id; messages: ChannelMessage[] }
  | { type: 'context.changed'; plan: ContextPlan }
  | { type: 'research.changed'; objects: ResearchObject[]; relations: ResearchRelation[]; provenance: ArtifactProvenance[] }
  | { type: 'approval.changed'; approvals: ApprovalRequest[] }
  | { type: 'status'; connected: boolean; label: string };
