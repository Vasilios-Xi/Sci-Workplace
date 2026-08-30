import { randomUUID } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AgentCardExport, AgentDefinition, AgentDefinitionUpdate, AgentMemoryKind, AgentMemoryScope, AgentToolPolicy, Annotation, AnnotationSelector, ArtifactProvenance, ArtifactRevisionFile, ChatAttachmentRef, CollaborationChannel, ConversationStartInput, DocumentRevisionRef, HarnessSettings, JobSpec, JsonValue, McpServerConfig, ModelProviderConfig, ModelProviderId, PermissionMode, PrimaryAgentProfileUpdate, ReasoningEffort, ServerPushMessage, SourceMapDescriptor, UserProfileUpdate, WorkspaceAccessMode, WorkspaceEditRequest, WorkspacePathRef, WorktableRevealTarget } from '@openlab/protocol';
import { PROTOCOL_VERSION } from '@openlab/protocol';
import type { WorkspaceFileOperation } from '../workspace/session-workspace-store.js';
import type { OpenLabRuntime } from '../runtime.js';

export interface RuntimeServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

function jsonError(error: unknown): { error: { message: string } } {
  return { error: { message: error instanceof Error ? error.message : String(error) } };
}

const PROVIDER_IDS = new Set<ModelProviderId>(['chatgpt-oauth', 'grok-oauth', 'minimax-coding-plan', 'kimi-coding-plan', 'glm-coding-plan', 'deepseek', 'ollama', 'lm-studio']);

// Chromium rejects requests to these legacy service ports before they reach a
// loopback server. An ephemeral OS allocation can still land on one (Windows
// has configurable dynamic ranges), so Runtime must validate the resolved port.
const CHROMIUM_RESTRICTED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
]);

export function isBrowserSafeLoopbackPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535 && !CHROMIUM_RESTRICTED_PORTS.has(port);
}

function providerId(value: string): ModelProviderId {
  if (!PROVIDER_IDS.has(value as ModelProviderId)) throw new Error('未知模型供应商');
  return value as ModelProviderId;
}

export async function startRuntimeServer(runtime: OpenLabRuntime, options: { host: '127.0.0.1'; port: number; authToken: string; generatedAppTicketTtlMs?: number }): Promise<RuntimeServer> {
  const app = new Hono();
  const panelTickets = new Map<string, { html: string; expiresAt: number }>();
  const generatedAppTickets = new Map<string, { appId: string; revisionId: string; expiresAt: number; requests: number }>();
  const generatedBlueprintTickets = new Map<string, { blueprintId: string; expiresAt: number; requests: number }>();
  const resourceTickets = new Map<string, { resourceId: string; expiresAt: number; requests: number }>();
  app.use('*', async (context, next) => {
    const origin = context.req.header('origin');
    const loopbackOrigin = origin === 'null' || origin === 'file://' || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(origin ?? '');
    if (origin && !loopbackOrigin) return context.json({ error: { message: 'Origin not allowed' } }, 403);
    if (origin) {
      context.header('Access-Control-Allow-Origin', origin);
      context.header('Vary', 'Origin');
    }
    context.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    context.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    context.header('Cache-Control', 'no-store');
    if (context.req.method === 'OPTIONS') return context.body(null, 204);
    await next();
  });
  app.use('/api/*', async (context, next) => {
    const authorization = context.req.header('authorization');
    if (authorization !== `Bearer ${options.authToken}`) return context.json({ error: { message: 'Unauthorized' } }, 401);
    await next();
  });
  app.use('/api/*', bodyLimit({
    maxSize: 24 * 1024 * 1024,
    onError: (context) => context.json({ error: { message: '请求正文超过 24 MB 上限' } }, 413),
  }));

  app.get('/plugin-panels/:ticket', (context) => {
    const now = Date.now();
    for (const [ticket, value] of panelTickets) if (value.expiresAt <= now) panelTickets.delete(ticket);
    const value = panelTickets.get(context.req.param('ticket'));
    if (!value || value.expiresAt <= now) return context.text('Panel ticket expired', 404);
    const runtimeOrigin = new URL(context.req.url).origin;
    return context.body(value.html, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; media-src data:; frame-src ${runtimeOrigin}; object-src ${runtimeOrigin}; form-action 'none'; base-uri 'none'; frame-ancestors file: http://127.0.0.1:*`,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  app.get('/generated-apps/:ticket/*', (context) => {
    const now = Date.now();
    for (const [ticket, value] of generatedAppTickets) if (value.expiresAt <= now || value.requests >= 512) generatedAppTickets.delete(ticket);
    const ticketId = context.req.param('ticket');
    const ticket = generatedAppTickets.get(ticketId);
    if (!ticket || ticket.expiresAt <= now || ticket.requests >= 512) return context.text('Generated app ticket expired', 404);
    try {
      const requestUrl = new URL(context.req.url);
      const marker = `/generated-apps/${encodeURIComponent(ticketId)}/`;
      if (!requestUrl.pathname.startsWith(marker)) throw new Error('Generated app ticket path is invalid');
      const path = requestUrl.pathname.slice(marker.length).split('/').map((segment) => decodeURIComponent(segment)).join('/');
      const asset = runtime.readGeneratedAppAsset(ticket.appId, ticket.revisionId, path);
      ticket.requests += 1;
      const origin = requestUrl.origin;
      const network = asset.app.networkDomains.map((domain) => `https://${domain}`).join(' ');
      const csp = [
        "default-src 'none'",
        `script-src 'unsafe-inline' ${origin}`,
        `style-src 'unsafe-inline' ${origin}`,
        `img-src ${origin} data: blob:`,
        `font-src ${origin} data:`,
        `media-src ${origin} data: blob:`,
        `connect-src ${origin}${network ? ` ${network}` : ''}`,
        `worker-src ${origin} blob:`,
        `manifest-src ${origin}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-src 'none'",
        'frame-ancestors file: http://127.0.0.1:* http://localhost:*',
        // The generated app lives on the Runtime's random loopback origin,
        // while the Electron renderer is a different origin. Keeping the
        // generated document's origin lets the renderer transfer a
        // MessagePort with an exact targetOrigin instead of using "*".
        // Runtime APIs still require the bearer token, which is never exposed
        // to the generated document.
        'sandbox allow-scripts allow-forms allow-same-origin',
      ].join('; ');
      const headers = {
        'Content-Type': asset.mediaType,
        'Content-Length': String(asset.bytes.length),
        'Content-Security-Policy': csp,
        'Cache-Control': 'private, no-store, max-age=0',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Access-Control-Allow-Origin': '*',
        ETag: asset.etag,
      };
      if (context.req.header('if-none-match') === asset.etag) return context.body(null, 304, headers);
      return context.body(asset.bytes as unknown as ArrayBuffer, 200, headers);
    } catch (error) { return context.json(jsonError(error), 404); }
  });

  app.get('/health', (context) => context.json({ ok: true, protocol: PROTOCOL_VERSION }));
  app.get('/api/bootstrap', async (context) => context.json(await runtime.snapshot()));
  app.get('/api/status', (context) => context.json(runtime.status()));
  app.get('/api/diagnostics', (context) => context.body(JSON.stringify(runtime.diagnostics()), 200, { 'Content-Type': 'application/json' }));
  app.post('/api/conversations/start', async (context) => {
    try {
      const body = await context.req.json<ConversationStartInput>();
      return context.json(await runtime.startConversation(body), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });

  app.get('/generated-blueprints/:ticket/*', (context) => {
    const now = Date.now();
    for (const [id, value] of generatedBlueprintTickets) if (value.expiresAt <= now || value.requests >= 512) generatedBlueprintTickets.delete(id);
    const ticketId = context.req.param('ticket');
    const ticket = generatedBlueprintTickets.get(ticketId);
    if (!ticket || ticket.expiresAt <= now || ticket.requests >= 512) return context.text('Generated blueprint preview expired', 404);
    try {
      const requestUrl = new URL(context.req.url);
      const marker = `/generated-blueprints/${encodeURIComponent(ticketId)}/`;
      if (!requestUrl.pathname.startsWith(marker)) throw new Error('生成应用预览路径无效');
      const path = requestUrl.pathname.slice(marker.length).split('/').map((segment) => decodeURIComponent(segment)).join('/');
      const asset = runtime.readGeneratedBlueprintAsset(ticket.blueprintId, path);
      ticket.requests += 1;
      const origin = requestUrl.origin;
      const csp = [
        "default-src 'none'", `script-src 'unsafe-inline' ${origin}`, `style-src 'unsafe-inline' ${origin}`,
        `img-src ${origin} data: blob:`, `font-src ${origin} data:`, `media-src ${origin} data: blob:`,
        `connect-src ${origin}`, `worker-src ${origin} blob:`, "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'",
        'frame-ancestors file: http://127.0.0.1:* http://localhost:*',
        'sandbox allow-scripts allow-same-origin',
      ].join('; ');
      const headers = {
        'Content-Type': asset.mediaType, 'Content-Length': String(asset.bytes.length), 'Content-Security-Policy': csp,
        'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*', ETag: asset.etag,
      };
      if (context.req.header('if-none-match') === asset.etag) return context.body(null, 304, headers);
      return context.body(asset.bytes as unknown as ArrayBuffer, 200, headers);
    } catch (error) { return context.json(jsonError(error), 404); }
  });

  app.get('/resource-files/:ticket', (context) => {
    const now = Date.now();
    for (const [id, value] of resourceTickets) {
      if (value.expiresAt > now && value.requests < 2_048) continue;
      resourceTickets.delete(id);
      runtime.releaseResource(value.resourceId);
    }
    const ticket = resourceTickets.get(context.req.param('ticket'));
    if (!ticket || ticket.expiresAt <= now || ticket.requests >= 2_048) return context.text('Resource ticket expired', 404);
    try {
      const handle = runtime.resources.describe(ticket.resourceId);
      const rangeHeader = context.req.header('range');
      const match = rangeHeader?.match(/^bytes=(\d+)-(\d*)$/u);
      if (rangeHeader && !match) return context.text('Unsupported range', 416);
      const start = match ? Number(match[1]) : 0;
      const requestedEnd = match?.[2] ? Number(match[2]) : Math.min(handle.size - 1, start + 1024 * 1024 - 1);
      const end = Math.min(handle.size - 1, requestedEnd);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= handle.size || end - start + 1 > 1024 * 1024) return context.text('Invalid range', 416);
      const bytes = runtime.resources.read(handle.id, start, end + 1);
      ticket.requests += 1;
      const partial = start !== 0 || end !== handle.size - 1;
      return context.body(bytes as unknown as ArrayBuffer, partial ? 206 : 200, {
        'Content-Type': handle.mediaType,
        'Content-Length': String(bytes.length),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(handle.name)}`,
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Referrer-Policy': 'no-referrer',
        ETag: handle.etag,
        ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${handle.size}` } : {}),
      });
    } catch (error) { return context.json(jsonError(error), 404); }
  });
  app.post('/api/chat', async (context) => {
    try {
      const body = await context.req.json<{
        text?: string;
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
      }>();
      return context.json(runtime.submitChat({
        text: body.text ?? '',
        ...(body.model ? { model: body.model } : {}),
        ...(body.thinking ? { thinking: body.thinking } : {}),
        ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
        ...(body.permissionMode ? { permissionMode: body.permissionMode } : {}),
        ...(body.interfaceLocale ? { interfaceLocale: body.interfaceLocale } : {}),
        ...(body.skillIds ? { skillIds: body.skillIds } : {}),
        ...(body.attachments ? { attachments: body.attachments } : {}),
        ...(body.researchObjectIds ? { researchObjectIds: body.researchObjectIds } : {}),
        ...(body.mentionedAgentIds ? { mentionedAgentIds: body.mentionedAgentIds } : {}),
        ...(body.quotedNodeIds ? { quotedNodeIds: body.quotedNodeIds } : {}),
      }), 202);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/chat/cancel', (context) => context.json({ cancelled: runtime.cancelCurrentTurn() }));
  app.post('/api/chat/regenerate', async (context) => {
    try {
      const body = await context.req.json<{ turnId?: string }>();
      return context.json(runtime.regenerateTurn(body.turnId ?? ''), 202);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/turns/:id/variants/:variantId/activate', (context) => {
    try { return context.json(runtime.activateTurnVariant(context.req.param('id'), context.req.param('variantId'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/approvals/:id', async (context) => {
    try {
      const body = await context.req.json<{ approved?: boolean }>();
      return context.json(runtime.resolveApproval(context.req.param('id'), body.approved === true));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/sessions', async (context) => {
    try {
      const body: { title?: string; leadAgentId?: string; memberAgentIds?: string[]; temporary?: boolean } = await context.req.json<{ title?: string; leadAgentId?: string; memberAgentIds?: string[]; temporary?: boolean }>().catch(() => ({}));
      return context.json(runtime.createSession(body.title ?? (body.temporary ? '临时聊天' : '新研究对话'), body.leadAgentId, body.memberAgentIds ?? [], body.temporary === true), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/sessions/:id/activate', async (context) => {
    try {
      runtime.switchSession(context.req.param('id'));
      return context.json(await runtime.snapshot());
    }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/sessions/:id/archive', (context) => {
    try { return context.json(runtime.archiveSession(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/sessions/archive-project', (context) => {
    try { return context.json(runtime.archiveProjectSessions()); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/sessions/:id/unarchive', (context) => {
    try { return context.json(runtime.unarchiveSession(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/sessions/:id/fork', async (context) => {
    try {
      const body: { title?: string; throughNodeId?: string; beforeNodeId?: string } = await context.req.json<{ title?: string; throughNodeId?: string; beforeNodeId?: string }>().catch(() => ({}));
      return context.json(runtime.forkSession(context.req.param('id'), body.title, body.throughNodeId, body.beforeNodeId), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });

  app.get('/api/workspace/entries', (context) => {
    try {
      return context.json(runtime.listWorkspaceDirectory({ rootId: context.req.query('rootId') ?? 'project', path: context.req.query('path') ?? '.' }, {
        showHidden: context.req.query('showHidden') === 'true',
        sort: context.req.query('sort') === 'modified' ? 'modified' : 'name',
        order: context.req.query('order') === 'desc' ? 'desc' : 'asc',
      }));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/workspace/search', (context) => {
    try {
      return context.json(runtime.searchWorkspace(context.req.query('rootId') ?? 'project', context.req.query('query') ?? '', {
        showHidden: context.req.query('showHidden') === 'true', includeContent: context.req.query('includeContent') === 'true',
      }));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/workspace/preview', async (context) => {
    try { return context.json(runtime.previewWorkspaceFile(await context.req.json<WorkspacePathRef>())); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/workspace/attachment-ref', async (context) => {
    try { return context.json(runtime.createWorkspaceAttachment(await context.req.json<WorkspacePathRef>())); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/workspace/note', async (context) => {
    try {
      const body = await context.req.json<{ note?: string }>();
      return context.json(runtime.setWorkspaceNote(body.note ?? ''));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.put('/api/project/source-folders', async (context) => {
    try {
      const body = await context.req.json<{ paths?: string[] }>();
      if (!Array.isArray(body.paths) || !body.paths.every((path) => typeof path === 'string')) throw new Error('项目文件夹列表无效');
      return context.json(runtime.setProjectRoots(body.paths));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/workspace/roots', async (context) => {
    try {
      const body = await context.req.json<{ path?: string; access?: WorkspaceAccessMode; confirmed?: boolean }>();
      if (!body.confirmed || !body.path) throw new Error('目录授权需要用户通过本地选择器逐次确认');
      return context.json(runtime.authorizeWorkspaceRoot(body.path, body.access ?? 'ask'), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/workspace/roots/:id/confirm', async (context) => {
    try {
      const body = await context.req.json<{ confirmed?: boolean }>();
      if (!body.confirmed) throw new Error('分支目录需要重新确认');
      return context.json(runtime.confirmWorkspaceRoot(context.req.param('id')));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/workspace/roots/:id/revoke', async (context) => {
    try {
      const body = await context.req.json<{ confirmed?: boolean }>();
      if (!body.confirmed) throw new Error('撤销目录授权需要明确确认');
      runtime.revokeWorkspaceRoot(context.req.param('id'));
      return context.json({ ok: true });
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/workspace/roots/:id/activate', (context) => {
    try { return context.json(runtime.setActiveWorkspaceRoot(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/workspace/files/operate', async (context) => {
    try {
      const body = await context.req.json<{ operation?: WorkspaceFileOperation; confirmed?: boolean }>();
      if (!body.operation) throw new Error('缺少文件操作');
      const crossRootMove = (body.operation.type === 'move' || body.operation.type === 'rename') && body.operation.source.rootId !== body.operation.target.rootId;
      if ((body.operation.type === 'delete' || body.operation.type === 'import' || crossRootMove) && !body.confirmed) throw new Error('删除、外部导入或跨根移动需要逐次明确确认');
      return context.json(runtime.operateWorkspaceFile(body.operation), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/workspace/files/:id/undo', (context) => {
    try { return context.json(runtime.undoWorkspaceFile(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/workspace/conversation-files', async (context) => {
    try {
      const body = await context.req.json<{ ref?: WorkspacePathRef; origin?: 'upload' | 'reference' | 'agent' | 'artifact'; artifactId?: string; sourceEventIds?: string[] }>();
      if (!body.ref) throw new Error('缺少文件引用');
      return context.json(runtime.addConversationFile(body.ref, body.origin ?? 'reference', { ...(body.artifactId ? { artifactId: body.artifactId } : {}), ...(body.sourceEventIds ? { sourceEventIds: body.sourceEventIds } : {}) }), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/project/rename', async (context) => {
    try {
      const body = await context.req.json<{ name?: string }>();
      return context.json(runtime.renameProject(body.name ?? ''));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.delete('/api/workspace/conversation-files/:id', (context) => {
    try { return context.json(runtime.removeConversationFile(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/workspace/shell-path', async (context) => {
    try { return context.json({ path: runtime.resolveWorkspacePathForShell(await context.req.json<WorkspacePathRef>()) }); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/documents/open', async (context) => {
    try { return context.json(runtime.openDocument(await context.req.json<WorkspacePathRef>())); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.patch('/api/documents/:id', async (context) => {
    try { const body = await context.req.json<{ content?: string }>(); return context.json(runtime.updateDocument(context.req.param('id'), body.content ?? '')); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/documents/:id/save', (context) => {
    try { return context.json(runtime.saveDocument(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 409); }
  });
  app.delete('/api/documents/:id', (context) => {
    try { runtime.closeDocument(context.req.param('id'), context.req.query('discard') === 'true'); return context.json({ ok: true }); }
    catch (error) { return context.json(jsonError(error), 409); }
  });
  app.post('/api/workspace-edits/preview', async (context) => {
    try {
      const body = await context.req.json<Omit<WorkspaceEditRequest, 'origin'>>();
      return context.json(runtime.previewWorkspaceEdit(body), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/workspace-edits/:id/apply', async (context) => {
    try {
      const body = await context.req.json<{ confirmed?: boolean }>();
      if (!body.confirmed) throw new Error('应用多文件 diff 需要用户明确确认');
      return context.json(runtime.applyWorkspaceEdit(context.req.param('id')));
    } catch (error) { return context.json(jsonError(error), 409); }
  });
  app.post('/api/workspace-edits/:id/undo', async (context) => {
    try {
      const body = await context.req.json<{ confirmed?: boolean }>();
      if (!body.confirmed) throw new Error('撤销多文件变更需要用户明确确认');
      return context.json(runtime.undoWorkspaceEdit(context.req.param('id')));
    } catch (error) { return context.json(jsonError(error), 409); }
  });
  app.post('/api/resources', async (context) => {
    try { return context.json(runtime.openResource(await context.req.json<DocumentRevisionRef>()), 201); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/resources/:id', (context) => {
    try {
      const handle = runtime.resources.describe(context.req.param('id'));
      if (context.req.header('if-none-match') === handle.etag) return context.body(null, 304, { ETag: handle.etag });
      const rangeHeader = context.req.header('range');
      const match = rangeHeader?.match(/^bytes=(\d+)-(\d*)$/u);
      if (rangeHeader && !match) return context.json({ error: { message: '仅支持单段字节 Range' } }, 416);
      const start = match ? Number(match[1]) : 0;
      const requestedEnd = match?.[2] ? Number(match[2]) : Math.min(handle.size - 1, start + 1024 * 1024 - 1);
      const end = Math.min(handle.size - 1, requestedEnd);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= handle.size || end - start + 1 > 1024 * 1024) {
        return context.json({ error: { message: 'Range 无效或单段超过 1 MB' } }, 416);
      }
      const bytes = runtime.resources.read(handle.id, start, end + 1);
      const partial = start !== 0 || end !== handle.size - 1;
      return context.body(bytes as unknown as ArrayBuffer, partial ? 206 : 200, {
        'Content-Type': handle.mediaType,
        'Content-Length': String(bytes.length),
        'Accept-Ranges': 'bytes',
        ETag: handle.etag,
        ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${handle.size}` } : {}),
      });
    } catch (error) { return context.json(jsonError(error), 404); }
  });
  app.delete('/api/resources/:id', (context) => { runtime.releaseResource(context.req.param('id')); return context.json({ ok: true }); });
  app.post('/api/resources/:id/ticket', (context) => {
    try {
      const resource = runtime.resources.describe(context.req.param('id'));
      const ticket = randomUUID();
      const expiresAt = Math.min(Date.parse(resource.expiresAt), Date.now() + 10 * 60_000);
      resourceTickets.set(ticket, { resourceId: resource.id, expiresAt, requests: 0 });
      const requestUrl = new URL(context.req.url);
      return context.json({ url: `${requestUrl.origin}/resource-files/${encodeURIComponent(ticket)}`, expiresAt: new Date(expiresAt).toISOString() }, 201);
    } catch (error) { return context.json(jsonError(error), 404); }
  });
  app.get('/api/jobs', (context) => context.json(runtime.listJobs()));
  app.post('/api/jobs', async (context) => {
    try {
      const body = await context.req.json<Omit<JobSpec, 'origin'> & { confirmed?: boolean }>();
      if (!body.confirmed) throw new Error('执行任务需要用户确认已展示的 JobSpec');
      const { confirmed: _confirmed, ...spec } = body;
      return context.json(runtime.runJob(spec), 202);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/jobs/:id', (context) => {
    try { return context.json(runtime.getJob(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 404); }
  });
  app.get('/api/jobs/:id/log', (context) => {
    try { return context.json(runtime.jobLog(context.req.param('id'), Number(context.req.query('offset') ?? 0))); }
    catch (error) { return context.json(jsonError(error), 404); }
  });
  app.post('/api/jobs/:id/cancel', (context) => {
    try { return context.json(runtime.cancelJob(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/jobs/:id/pause', (context) => {
    try { return context.json(runtime.pauseJob(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/jobs/:id/resume', (context) => {
    try { return context.json(runtime.resumeJob(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/annotations', (context) => context.json(runtime.annotations.list()));
  app.post('/api/annotations', async (context) => {
    try { return context.json(runtime.createAnnotation(await context.req.json<{ target: DocumentRevisionRef; selector: AnnotationSelector; comment: string }>()), 201); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.patch('/api/annotations/:id', async (context) => {
    try { return context.json(runtime.updateAnnotation(context.req.param('id'), await context.req.json<{ comment?: string; status?: Annotation['status'] }>())); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/annotations/submit', async (context) => {
    try {
      const body = await context.req.json<{ ids?: string[]; confirmed?: boolean }>();
      if (!body.confirmed) throw new Error('提交批注给 Agent 需要用户明确确认');
      return context.json(runtime.submitAnnotations(body.ids ?? []), 202);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/artifact-revisions', (context) => context.json(runtime.artifactRevisions.list(context.req.query('artifactId'))));
  app.post('/api/artifact-revisions', async (context) => {
    try {
      const body = await context.req.json<{ artifactId: string; parentRevisionId?: string; files: Array<Omit<ArtifactRevisionFile, 'sha256' | 'size'> & { ref: WorkspacePathRef }>; jobId?: string; annotationSetIds?: string[]; provenance: Omit<ArtifactProvenance, 'artifactId' | 'createdAt'> }>();
      return context.json(runtime.createArtifactRevision(body), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/artifact-revisions/:id/archive', async (context) => {
    try {
      const body = await context.req.json<{ confirmed?: boolean; includeLargeFiles?: boolean }>();
      if (!body.confirmed) throw new Error('版本存档需要用户明确确认');
      return context.json(runtime.archiveArtifactRevision(context.req.param('id'), body.includeLargeFiles === true));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/artifact-revisions/:id/restore', async (context) => {
    try {
      const body = await context.req.json<{ confirmed?: boolean; target?: WorkspacePathRef }>();
      if (!body.confirmed || !body.target) throw new Error('恢复版本需要选择并确认新的目标目录');
      return context.json(runtime.restoreArtifactRevision(context.req.param('id'), body.target));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/source-maps', async (context) => {
    try { return context.json(runtime.registerSourceMap(await context.req.json<Omit<SourceMapDescriptor, 'id' | 'projectId' | 'createdAt'>>()), 201); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/workbench', (context) => context.json(runtime.workbenches.snapshot()));
  app.post('/api/workbench/open', async (context) => {
    try { return context.json(runtime.openWorkbench(await context.req.json<Parameters<OpenLabRuntime['openWorkbench']>[0]>())); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/workbench/:id/activate', (context) => { try { return context.json(runtime.activateWorkbench(context.req.param('id'))); } catch (error) { return context.json(jsonError(error), 400); } });
  app.post('/api/workbench/:id/view', async (context) => { try { const body = await context.req.json<{ viewId?: string }>(); return context.json(runtime.setWorkbenchView(context.req.param('id'), body.viewId ?? '')); } catch (error) { return context.json(jsonError(error), 400); } });
  app.delete('/api/workbench/:id', (context) => { try { return context.json(runtime.closeWorkbench(context.req.param('id'))); } catch (error) { return context.json(jsonError(error), 400); } });
  app.post('/api/workbench/maximized', async (context) => { try { const body = await context.req.json<{ maximized?: boolean }>(); return context.json(runtime.maximizeWorkbench(body.maximized === true)); } catch (error) { return context.json(jsonError(error), 400); } });
  app.get('/api/worktable', (context) => context.json(runtime.worktableSnapshot()));
  app.post('/api/worktable/instances', async (context) => {
    try {
      const body = await context.req.json<Parameters<OpenLabRuntime['createWorktable']>[0]>().catch(() => ({}));
      const instance = runtime.createWorktable(body);
      return context.json({ worktable: runtime.worktables.snapshot(), instance }, 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/worktable/instances/:id/activate', (context) => {
    try { return context.json(runtime.activateWorktable(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.patch('/api/worktable/instances/:id', async (context) => {
    try {
      const body = await context.req.json<Parameters<OpenLabRuntime['patchWorktable']>[1]>();
      return context.json(runtime.patchWorktable(context.req.param('id'), body));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/worktable/instances/:id/archive', (context) => {
    try { return context.json(runtime.archiveWorktable(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/toolchain-adapters', (context) => context.json({ adapters: runtime.toolchainAdapters.manifests(), runs: runtime.toolchainAdapters.runs() }));
  app.post('/api/toolchain-adapters/:adapterId/operations/:operationId/run', async (context) => {
    try {
      const body = await context.req.json<{ values?: Record<string, JsonValue>; instanceId?: string; confirmed?: boolean }>();
      return context.json(runtime.runToolchainAdapter({
        adapterId: context.req.param('adapterId'), operationId: context.req.param('operationId'), values: body.values ?? {},
        ...(body.instanceId ? { instanceId: body.instanceId } : {}), confirmed: body.confirmed === true,
      }), 202);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/toolchain-runs/:id/cancel', (context) => {
    try { return context.json(runtime.cancelToolchainRun(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/toolchain-runs/:id/log', (context) => {
    try { return context.json(runtime.toolchainRunLog(context.req.param('id'), Number(context.req.query('offset') ?? 0))); }
    catch (error) { return context.json(jsonError(error), 404); }
  });
  app.post('/api/worktable/instances/:id/restore', (context) => {
    try { return context.json(runtime.restoreWorktable(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/worktable/instances/:id/layout', async (context) => {
    try {
      const body = await context.req.json<Parameters<OpenLabRuntime['setWorktableLayout']>[1]>();
      return context.json(runtime.setWorktableLayout(context.req.param('id'), body));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/workbench-v1/layout-proposals/:id/decision', async (context) => {
    try {
      const body = await context.req.json<{ accepted?: boolean; confirmed?: boolean }>();
      if (!body.confirmed) throw new Error('布局新增、删除或重排必须在差异预览后由用户明确确认');
      return context.json(runtime.decideWorkbenchLayoutProposal(context.req.param('id'), body.accepted === true));
    } catch (error) { return context.json(jsonError(error), 409); }
  });
  app.post('/api/workbench-v1/instances/:id/layout-proposals', async (context) => {
    try {
      const body = await context.req.json<Omit<Parameters<OpenLabRuntime['proposeWorkbenchLayout']>[0], 'instanceId'>>();
      return context.json(runtime.proposeWorkbenchLayout({ ...body, instanceId: context.req.param('id') }), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/worktable/instances/:id/panes/:paneId/tabs', async (context) => {
    try {
      const body = await context.req.json<Parameters<OpenLabRuntime['mountWorktableTab']>[2]>();
      return context.json(runtime.mountWorktableTab(context.req.param('id'), context.req.param('paneId'), body), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/worktable/instances/:id/panes/:paneId/activate', async (context) => {
    try {
      const body = await context.req.json<{ tabId?: string }>();
      if (!body.tabId) throw new Error('缺少活动标签 ID');
      return context.json(runtime.activateWorktableTab(context.req.param('id'), context.req.param('paneId'), body.tabId));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.delete('/api/worktable/instances/:id/panes/:paneId/tabs/:tabId', (context) => {
    try { return context.json(runtime.closeWorktableTab(context.req.param('id'), context.req.param('paneId'), context.req.param('tabId'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/worktable/instances/:id/context', (context) => {
    try { return context.json(runtime.worktableContext(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 404); }
  });
  app.post('/api/worktable/instances/:id/panes/:paneId/terminal', async (context) => {
    try {
      const body = await context.req.json<unknown>();
      const result = await runtime.worktableTerminalAction(context.req.param('id'), context.req.param('paneId'), body);
      return context.json(result as never);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/worktable/instances/:id/scm', async (context) => {
    try {
      const body = await context.req.json<unknown>();
      const result = await runtime.worktableScmAction(context.req.param('id'), body);
      return context.json(result as never);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/browser/state', async (context) => {
    try { return context.json(runtime.syncBrowserState(await context.req.json<unknown>())); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/generated-blueprints', (context) => context.json(runtime.generatedAppBlueprints.list()));
  app.post('/api/generated-blueprints', async (context) => {
    try {
      const body = await context.req.json<{ prompt?: string }>();
      return context.json(runtime.proposeGeneratedWorkbench(body.prompt ?? ''), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/generated-blueprints/:id/decision', async (context) => {
    try {
      const body = await context.req.json<{ accepted?: boolean; confirmed?: boolean }>();
      if (!body.confirmed) throw new Error('生成应用的布局与能力声明需要用户明确确认');
      return context.json(await runtime.decideGeneratedWorkbench(context.req.param('id'), body.accepted === true));
    } catch (error) { return context.json(jsonError(error), 409); }
  });
  app.post('/api/generated-blueprints/:id/preview-ticket', (context) => {
    try {
      const blueprint = runtime.generatedAppBlueprints.get(context.req.param('id'));
      if (blueprint.status !== 'preview') throw new Error('生成应用尚未通过构建检查');
      const ticket = randomUUID();
      const expiresAt = Date.now() + (options.generatedAppTicketTtlMs ?? 5 * 60_000);
      generatedBlueprintTickets.set(ticket, { blueprintId: blueprint.id, expiresAt, requests: 0 });
      const requestUrl = new URL(context.req.url);
      return context.json({ url: `${requestUrl.origin}/generated-blueprints/${encodeURIComponent(ticket)}/${blueprint.entry}`, expiresAt: new Date(expiresAt).toISOString() }, 201);
    } catch (error) { return context.json(jsonError(error), 404); }
  });
  app.post('/api/generated-blueprints/:id/accept', async (context) => {
    try {
      const body = await context.req.json<{ confirmed?: boolean }>();
      if (!body.confirmed) throw new Error('接受并挂载生成应用需要用户明确确认');
      return context.json(runtime.acceptGeneratedWorkbench(context.req.param('id'), true), 201);
    } catch (error) { return context.json(jsonError(error), 409); }
  });
  app.get('/api/generated-apps', (context) => context.json(runtime.generatedApps.list()));
  app.post('/api/generated-apps', async (context) => {
    try {
      const body = await context.req.json<Parameters<OpenLabRuntime['publishGeneratedApp']>[0] & { confirmed?: boolean }>();
      if (body.confirmed !== true) throw new Error('发布生成应用需要用户明确确认');
      const { confirmed: _confirmed, ...input } = body;
      return context.json(runtime.publishGeneratedApp(input), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/generated-apps/:appId/revisions/:revisionId/activate', async (context) => {
    try {
      const body: { confirmed?: boolean } = await context.req.json<{ confirmed?: boolean }>().catch(() => ({}));
      if (body.confirmed !== true) throw new Error('切换生成应用修订需要用户明确确认');
      return context.json(runtime.updateGeneratedApp(context.req.param('appId'), context.req.param('revisionId')));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/generated-apps/:appId/archive', async (context) => {
    try {
      const body: { confirmed?: boolean } = await context.req.json<{ confirmed?: boolean }>().catch(() => ({}));
      if (body.confirmed !== true) throw new Error('归档生成应用需要用户明确确认');
      return context.json(runtime.archiveGeneratedApp(context.req.param('appId')));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/generated-apps/:appId/revisions/:revisionId/ticket', (context) => {
    try {
      const appRecord = runtime.generatedApps.get(context.req.param('appId'));
      const revisionId = context.req.param('revisionId');
      if (appRecord.status !== 'ready' || appRecord.activeRevisionId !== revisionId) throw new Error('生成应用修订未激活或不可用');
      // Verify the immutable entry bytes before issuing an unauthenticated,
      // narrowly scoped bearer ticket for iframe resource loading.
      runtime.readGeneratedAppAsset(appRecord.id, revisionId, appRecord.entry);
      const ticket = randomUUID();
      const expiresAt = Date.now() + Math.max(25, Math.min(options.generatedAppTicketTtlMs ?? 5 * 60_000, 10 * 60_000));
      generatedAppTickets.set(ticket, { appId: appRecord.id, revisionId, expiresAt, requests: 0 });
      const requestUrl = new URL(context.req.url);
      const entry = appRecord.entry.split('/').map((segment) => encodeURIComponent(segment)).join('/');
      return context.json({
        url: `${requestUrl.origin}/generated-apps/${encodeURIComponent(ticket)}/${entry}`,
        expiresAt: new Date(expiresAt).toISOString(),
      }, 201);
    } catch (error) { return context.json(jsonError(error), 404); }
  });
  app.post('/api/toolchains/install', async (context) => {
    try {
      const body = await context.req.json<{ sourcePath?: string; confirmed?: boolean }>();
      if (!body.confirmed || !body.sourcePath) throw new Error('安装离线工具包需要本地文件选择与明确确认');
      return context.json(runtime.installToolchain(body.sourcePath), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/provider/deepseek', async (context) => {
    try {
      const body = await context.req.json<{ apiKey?: string }>();
      return context.json(await runtime.setDeepSeekApiKey(body.apiKey));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/providers/:id', async (context) => {
    try {
      const body = await context.req.json<Partial<Pick<ModelProviderConfig, 'enabled' | 'credentialId' | 'baseUrl'>>>();
      await runtime.configureProvider(providerId(context.req.param('id')), body);
      return context.json({ ok: true });
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/providers/:id/refresh', async (context) => {
    try {
      await runtime.refreshProviders(providerId(context.req.param('id')));
      return context.json({ ok: true });
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/providers/:id/oauth/start', async (context) => {
    try {
      const id = providerId(context.req.param('id'));
      if (id !== 'chatgpt-oauth' && id !== 'grok-oauth') throw new Error('此供应商不使用 OAuth');
      return context.json(await runtime.startProviderOAuth(id));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/providers/:id/oauth/logout', async (context) => {
    try {
      const id = providerId(context.req.param('id'));
      if (id !== 'chatgpt-oauth' && id !== 'grok-oauth') throw new Error('此供应商不使用 OAuth');
      await runtime.logoutProviderOAuth(id);
      return context.json({ ok: true });
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/credentials', async (context) => {
    try {
      const body = await context.req.json<{ id?: string; value?: string }>();
      runtime.setCredential(body.id ?? '', body.value ?? '');
      return context.json({ ok: true });
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/settings/harness', async (context) => {
    try {
      const body = await context.req.json<Partial<HarnessSettings> & { confirmed?: boolean }>();
      if (body.developerMode === true && body.confirmed !== true) throw new Error('开启开发者模式需要用户明确确认');
      const { confirmed: _confirmed, ...patch } = body;
      return context.json(await runtime.setHarnessSettings(patch));
    }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/terminal/previews/:id', async (context) => {
    try {
      const body = await context.req.json<unknown>();
      return context.json(await runtime.previewTerminalAction(context.req.param('id'), body) as never);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/settings/user-profile', async (context) => {
    try {
      const body = await context.req.json<UserProfileUpdate & { confirmed?: boolean }>();
      if (body.confirmed !== true) throw new Error('需要用户明确确认个人资料');
      return context.json(runtime.configureUserProfile(body));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/settings/primary-agent', async (context) => {
    try {
      const body = await context.req.json<PrimaryAgentProfileUpdate & { confirmed?: boolean }>();
      if (body.confirmed !== true) throw new Error('需要用户明确确认 Agent 配置');
      return context.json(runtime.configurePrimaryAgent(body));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/agents', async (context) => {
    try {
      const body = await context.req.json<{ confirmed?: boolean; name?: string; avatar?: AgentDefinition['avatar']; templateId?: AgentDefinitionUpdate['templateId']; identity?: string; instructions?: string; model?: string; reasoningEffort?: ReasoningEffort }>();
      if (body.confirmed !== true) throw new Error('创建 Agent 需要用户明确确认');
      return context.json(runtime.createAgent({
        name: body.name ?? '',
        ...(body.avatar ? { avatar: body.avatar } : {}),
        ...(body.templateId ? { templateId: body.templateId } : {}),
        ...(body.identity !== undefined ? { identity: body.identity } : {}),
        ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
        ...(body.model ? { model: body.model } : {}),
        ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
      }), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.patch('/api/agents/:id', async (context) => {
    try { return context.json(runtime.updateAgent(context.req.param('id'), await context.req.json<AgentDefinitionUpdate>())); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/agents/import', async (context) => {
    try {
      const body = await context.req.json<{ confirmed?: boolean; card?: AgentCardExport }>();
      if (!body.confirmed || !body.card) throw new Error('导入 Agent 角色卡需要用户明确确认');
      return context.json(runtime.importAgent(body.card), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/agents/:id/export', (context) => {
    try { return context.json(runtime.exportAgent(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/agents/:id/archive', (context) => {
    try { return context.json(runtime.archiveAgent(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/agents/:id/restore', (context) => {
    try { return context.json(runtime.restoreAgent(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.put('/api/projects/:projectId/agents/:agentId', async (context) => {
    try {
      const body = await context.req.json<{ enabled?: boolean; externalCapabilityIds?: string[] }>();
      return context.json(runtime.setProjectAgent(context.req.param('agentId'), body.enabled === true, body.externalCapabilityIds));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.put('/api/agents/:id/tool-policy', async (context) => {
    try { return context.json(runtime.updateAgent(context.req.param('id'), { toolPolicy: await context.req.json<AgentToolPolicy>() })); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/agents/:id/memories', (context) => {
    try {
      const kind = context.req.query('kind') as AgentMemoryKind | undefined;
      const scope = context.req.query('scope') as AgentMemoryScope | undefined;
      return context.json(runtime.listAgentMemories(context.req.param('id'), {
        ...(kind ? { kind } : {}), ...(scope ? { scope } : {}), ...(context.req.query('query') ? { query: context.req.query('query')! } : {}),
      }));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/agents/:id/memories', async (context) => {
    try {
      const body = await context.req.json<{ scope?: AgentMemoryScope; content?: string; sourceEventIds?: string[] }>();
      return context.json(runtime.createPinnedMemory(context.req.param('id'), body.scope ?? 'project', body.content ?? '', body.sourceEventIds ?? []), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.patch('/api/memories/:id', async (context) => {
    try { return context.json(runtime.updateMemory(context.req.param('id'), await context.req.json<{ content?: string; confidence?: number; sourceEventIds?: string[] }>())); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.delete('/api/memories/:id', (context) => {
    try { return context.json(runtime.deleteMemory(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/agents/:id/memories/clear', async (context) => {
    try {
      const body = await context.req.json<{ kind?: AgentMemoryKind; scope?: AgentMemoryScope }>().catch(() => ({}));
      return context.json({ count: runtime.clearMemories(context.req.param('id'), body) });
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.put('/api/sessions/:id/agents', async (context) => {
    try {
      if (runtime.status().activeSessionId !== context.req.param('id')) throw new Error('请先切换到目标会话');
      const body = await context.req.json<{ leadAgentId?: string; memberAgentIds?: string[] }>();
      return context.json(runtime.setSessionAgents(body.leadAgentId ?? '', body.memberAgentIds ?? []));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/sessions/:id/refresh-tools', (context) => {
    try {
      if (runtime.status().activeSessionId !== context.req.param('id')) throw new Error('请先切换到目标会话');
      return context.json(runtime.refreshSessionAgentTools());
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/channels', async (context) => {
    try {
      const body = await context.req.json<{ name?: string; leadAgentId?: string; memberAgentIds?: string[]; toolAccess?: CollaborationChannel['toolAccess']; minReplies?: number; maxReplies?: number }>();
      return context.json(runtime.createChannel({
        name: body.name ?? '', leadAgentId: body.leadAgentId ?? '', memberAgentIds: body.memberAgentIds ?? [],
        ...(body.toolAccess ? { toolAccess: body.toolAccess } : {}), ...(body.minReplies !== undefined ? { minReplies: body.minReplies } : {}), ...(body.maxReplies !== undefined ? { maxReplies: body.maxReplies } : {}),
      }), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.patch('/api/channels/:id', async (context) => {
    try { return context.json(runtime.updateChannel(context.req.param('id'), await context.req.json<Partial<Pick<CollaborationChannel, 'name' | 'leadAgentId' | 'memberAgentIds' | 'toolAccess' | 'minReplies' | 'maxReplies' | 'status'>>>())); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/channels/:id/activate', (context) => {
    try { return context.json(runtime.setActiveChannel(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/channels/:id/archive', (context) => {
    try { return context.json(runtime.archiveChannel(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/channels/:id/messages', (context) => {
    try { return context.json(runtime.channelMessages(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/channels/:id/export', (context) => {
    try { return context.text(runtime.exportChannel(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/agents/:id/message', async (context) => {
    try {
      const body = await context.req.json<{ content?: string }>();
      return context.json({ messageId: runtime.messageAgent(context.req.param('id'), body.content ?? '') });
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/agents/:id/:action', (context) => {
    try {
      const id = context.req.param('id');
      const action = context.req.param('action');
      if (action === 'pause') runtime.pauseAgent(id);
      else if (action === 'resume') runtime.resumeAgent(id);
      else if (action === 'cancel') runtime.cancelAgent(id);
      else if (action === 'takeover') runtime.takeOverAgent(id);
      else throw new Error(`未知 Agent 操作：${action}`);
      return context.json({ ok: true });
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/plugins/scaffold', async (context) => {
    try {
      const body = await context.req.json<{ id?: string; name?: string; description?: string }>();
      return context.json(runtime.scaffoldPlugin({ id: body.id ?? '', name: body.name ?? '', description: body.description ?? '' }), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/plugins/install', async (context) => {
    try {
      const body = await context.req.json<{ sourcePath?: string; scope?: 'user' | 'project'; confirmed?: boolean }>();
      if (!body.confirmed) throw new Error('插件安装需要用户逐次明确确认');
      return context.json(await runtime.installPlugin(body.sourcePath ?? '', body.scope ?? 'project'), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/plugins/inspect', async (context) => {
    try {
      const body = await context.req.json<{ sourcePath?: string; confirmed?: boolean }>();
      if (!body.confirmed || !body.sourcePath) throw new Error('读取外部插件清单需要本地文件选择确认');
      return context.json(runtime.inspectPluginSource(body.sourcePath));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/plugin-catalog', (context) => context.json({ status: runtime.pluginMarketplace.status(), entries: runtime.pluginMarketplace.entries() }));
  app.post('/api/plugin-catalog/update-file', async (context) => {
    try {
      const body = await context.req.json<{ path?: string; confirmed?: boolean }>();
      if (!body.confirmed || !body.path) throw new Error('更新离线策展目录需要用户选择并确认签名索引文件');
      return context.json(await runtime.updatePluginCatalogFromFile(body.path));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/plugin-catalog/:id/install-file', async (context) => {
    try {
      const body = await context.req.json<{ path?: string; scope?: 'user' | 'project'; confirmed?: boolean }>();
      if (!body.confirmed || !body.path) throw new Error('安装策展插件需要用户选择并确认离线包');
      return context.json(await runtime.installCuratedPluginPackage(context.req.param('id'), body.path, body.scope ?? 'project'), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/plugins/:id/enabled', async (context) => {
    try {
      const body = await context.req.json<{ enabled?: boolean; confirmed?: boolean }>();
      if (body.enabled === true && !body.confirmed) throw new Error('启用外部插件需要逐次明确确认');
      await runtime.setPluginEnabled(context.req.param('id'), body.enabled === true);
      return context.json({ ok: true });
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/plugins/:id/reload', async (context) => {
    try {
      const body = await context.req.json<{ confirmed?: boolean }>();
      if (!body.confirmed) throw new Error('热重载外部插件需要重新确认当前权限');
      await runtime.reloadPlugin(context.req.param('id'));
      return context.json({ ok: true });
    }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/plugins/:id/settings', async (context) => {
    try {
      const body = await context.req.json<{ value?: unknown; confirmed?: boolean }>();
      if (!body.confirmed || body.value === undefined) throw new Error('修改插件设置需要用户明确确认');
      const updated = await runtime.updatePluginSettings(context.req.param('id'), body.value as never);
      return context.body(JSON.stringify(updated), 200, { 'Content-Type': 'application/json' });
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.delete('/api/plugins/:id', async (context) => {
    try {
      const body: { confirmed?: boolean } = await context.req.json<{ confirmed?: boolean }>().catch(() => ({}));
      if (!body.confirmed) throw new Error('卸载插件需要用户逐次明确确认');
      await runtime.uninstallPlugin(context.req.param('id'));
      return context.json({ ok: true });
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/plugins/:id/export', async (context) => {
    try {
      const body = await context.req.json<{ destination?: string; confirmed?: boolean }>();
      if (!body.confirmed || !body.destination) throw new Error('导出插件需要本地文件选择确认');
      runtime.exportPlugin(context.req.param('id'), body.destination);
      return context.json({ ok: true });
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/plugins/:id/panels/:panelId', (context) => {
    try {
      return context.body(runtime.readPluginPanel(context.req.param('id'), context.req.param('panelId')), 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self' file:",
        'X-Content-Type-Options': 'nosniff',
      });
    } catch (error) { return context.json(jsonError(error), 404); }
  });
  app.post('/api/plugins/:id/panels/:panelId/ticket', (context) => {
    try {
      const ticket = randomUUID();
      panelTickets.set(ticket, {
        html: runtime.readPluginPanel(context.req.param('id'), context.req.param('panelId')),
        expiresAt: Date.now() + 60_000,
      });
      const requestUrl = new URL(context.req.url);
      return context.json({ url: `${requestUrl.origin}/plugin-panels/${encodeURIComponent(ticket)}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }, 201);
    } catch (error) { return context.json(jsonError(error), 404); }
  });
  app.get('/api/plugins/:id/panels/:panelId/context', (context) => {
    try {
      const payload = runtime.pluginPanelContext(
        context.req.param('id'), context.req.param('panelId'), context.req.query('tabId') ?? '',
        context.req.query('worktableInstanceId'), context.req.query('paneId'),
      );
      return context.body(JSON.stringify(payload), 200, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    catch (error) { return context.json(jsonError(error), 403); }
  });
  app.post('/api/plugins/:id/panels/:panelId/tool', async (context) => {
    try {
      const body = await context.req.json<{ tabId?: string; worktableInstanceId?: string; paneId?: string; tool?: string; params?: Record<string, JsonValue>; confirmed?: boolean }>();
      return context.json(await runtime.executePluginPanelTool({
        pluginId: context.req.param('id'), panelId: context.req.param('panelId'), tabId: body.tabId ?? '',
        ...(body.worktableInstanceId ? { worktableInstanceId: body.worktableInstanceId } : {}),
        ...(body.paneId ? { paneId: body.paneId } : {}),
        tool: body.tool ?? '', params: body.params ?? {}, confirmed: body.confirmed === true,
      }));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/plugins/:id/panels/:panelId/reveal', async (context) => {
    try {
      const body = await context.req.json<{ tabId?: string; worktableInstanceId?: string; paneId?: string; document?: DocumentRevisionRef; selector?: AnnotationSelector; target?: WorktableRevealTarget }>();
      if (!body.document || !body.selector) throw new Error('证据跳转参数不完整');
      return context.json(runtime.revealWorkbenchEvidence({
        pluginId: context.req.param('id'), panelId: context.req.param('panelId'), tabId: body.tabId ?? '',
        ...(body.worktableInstanceId ? { worktableInstanceId: body.worktableInstanceId } : {}),
        ...(body.paneId ? { paneId: body.paneId } : {}),
        document: body.document, selector: body.selector,
        ...(body.target ? { target: body.target } : {}),
      }));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/skills/install', async (context) => {
    try {
      const body = await context.req.json<{ sourcePath?: string; scope?: 'user' | 'project'; confirmed?: boolean }>();
      if (!body.confirmed) throw new Error('Skill 安装需要用户明确确认本地来源');
      return context.json(runtime.installSkill(body.sourcePath ?? '', body.scope ?? 'project'), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/skills/:id/approve', async (context) => {
    try {
      const body = await context.req.json<{ sha256?: string; confirmed?: boolean }>();
      if (!body.confirmed || !body.sha256) throw new Error('启用工作目录 Skill 需要确认其 SHA-256');
      return context.json(runtime.approveSkill(context.req.param('id'), body.sha256));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/mcp', async (context) => {
    try {
      const body = await context.req.json<{ config?: McpServerConfig; confirmed?: boolean }>();
      if (!body.confirmed || !body.config) throw new Error('连接外部 MCP Server 需要明确确认');
      return context.json(await runtime.configureMcp(body.config), 201);
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.delete('/api/mcp/:id', async (context) => {
    try {
      const body = await context.req.json<{ confirmed?: boolean }>();
      if (!body.confirmed) throw new Error('移除 MCP Server 需要明确确认');
      await runtime.removeMcp(context.req.param('id'));
      return context.json({ ok: true });
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.get('/api/mcp/:id/resources', async (context) => {
    try { return context.json(await runtime.listMcpResources(context.req.param('id'))); }
    catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/mcp/:id/resources/read', async (context) => {
    try {
      const body = await context.req.json<{ uri?: string; confirmed?: boolean }>();
      if (!body.confirmed || !body.uri) throw new Error('读取外部 MCP resource 需要逐次明确确认');
      return context.json(await runtime.readMcpResource(context.req.param('id'), body.uri));
    } catch (error) { return context.json(jsonError(error), 400); }
  });
  app.post('/api/data/backup', async (context) => {
    try {
      const body = await context.req.json<{ destination?: string; confirmed?: boolean }>();
      if (!body.confirmed || !body.destination) throw new Error('数据库备份需要本地文件选择确认');
      runtime.backupDatabase(body.destination);
      return context.json({ ok: true });
    } catch (error) { return context.json(jsonError(error), 400); }
  });

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  app.use('/ws', async (context, next) => {
    if (context.req.query('token') !== options.authToken) return context.json({ error: { message: 'Unauthorized' } }, 401);
    await next();
  });
  app.get('/ws', upgradeWebSocket(() => {
    let unsubscribe: (() => void) | undefined;
    return {
      async onOpen(_event, ws) {
        ws.send(JSON.stringify({ type: 'snapshot', snapshot: await runtime.snapshot() } satisfies ServerPushMessage));
        unsubscribe = runtime.subscribe((message) => {
          try { ws.send(JSON.stringify(message)); } catch { unsubscribe?.(); }
        });
      },
      onClose() { unsubscribe?.(); },
      onError() { unsubscribe?.(); },
    };
  }));

  if (options.port !== 0 && !isBrowserSafeLoopbackPort(options.port)) throw new Error(`Runtime port ${options.port} is blocked by Chromium`);
  let server!: ServerType;
  let port = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listening = await new Promise<{ server: ServerType; port: number }>((resolvePromise, reject) => {
      try {
        let candidate!: ServerType;
        candidate = serve({ fetch: app.fetch, hostname: options.host, port: options.port }, (info) => resolvePromise({ server: candidate, port: info.port }));
        candidate.once('error', reject);
      } catch (error) { reject(error); }
    });
    if (isBrowserSafeLoopbackPort(listening.port)) {
      server = listening.server;
      port = listening.port;
      break;
    }
    await new Promise<void>((resolvePromise, reject) => listening.server.close((error) => error ? reject(error) : resolvePromise()));
  }
  if (!server || port === 0) throw new Error('Unable to allocate a browser-safe Runtime port');
  injectWebSocket(server);
  return {
    port,
    url: `http://${options.host}:${port}`,
    close: async () => await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
  };
}
