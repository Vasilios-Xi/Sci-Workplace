import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { EventActor, HarnessSettings, JsonValue, ResearchObjectType, ResearchRelationPredicate, ToolExecutionResult } from '@openlab/protocol';
import type { ContextPins } from '../context/pins.js';
import type { ResearchStore } from '../research/research-store.js';
import { PathGuard } from '../security/path-guard.js';
import { spawnWithResourceLimits } from '../security/windows-job-host.js';
import { toJson } from '../util/json.js';
import type { ChangeSetStore } from './change-set-store.js';
import type { ToolRegistry } from './tool-registry.js';

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const MAX_READ_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_BROWSER_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_BROWSER_DOWNLOAD_BYTES = 500 * 1024 * 1024;

type BrowserBrokerPath = 'open' | 'navigate' | 'observe' | 'act' | 'screenshot' | 'upload' | 'download' | 'close';

function asString(input: Record<string, JsonValue>, name: string): string {
  const value = input[name];
  if (typeof value !== 'string') throw new Error(`参数 ${name} 必须是字符串`);
  return value;
}

function asStringArray(input: Record<string, JsonValue>, name: string): string[] {
  const value = input[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`参数 ${name} 必须是字符串数组`);
  return value as string[];
}

function asJsonObject(value: JsonValue, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value as Record<string, JsonValue>;
}

function browserOpaqueId(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/u.test(value)) throw new Error(`${label}无效`);
  return value;
}

function browserSha256(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/iu.test(value)) throw new Error(`${label}无效`);
  return value.toLocaleLowerCase();
}

function browserByteSize(value: JsonValue | undefined, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${label}无效`);
  return value;
}

function browserMediaType(value: JsonValue | undefined): string {
  if (value === undefined) return 'application/octet-stream';
  if (typeof value !== 'string' || !/^[\w.+-]+\/[\w.+-]+(?:;[\x20-\x7e]+)?$/u.test(value) || value.length > 200) throw new Error('浏览器资源 MIME 类型无效');
  return value;
}

function browserScreenshotResource(value: JsonValue, expectedSessionId: string): Record<string, JsonValue> {
  const output = asJsonObject(value, '浏览器截图资源');
  const sessionId = browserOpaqueId(output.sessionId, '浏览器截图会话引用');
  if (sessionId !== expectedSessionId) throw new Error('浏览器截图会话引用不匹配');
  if (output.mediaType !== 'image/png') throw new Error('浏览器截图 MIME 类型无效');
  if (typeof output.expiresAt !== 'string' || !Number.isFinite(Date.parse(output.expiresAt))) throw new Error('浏览器截图过期时间无效');
  return {
    id: browserOpaqueId(output.id, '浏览器截图资源引用'),
    sessionId,
    mediaType: 'image/png',
    size: browserByteSize(output.size, MAX_BROWSER_SCREENSHOT_BYTES, '浏览器截图大小'),
    sha256: browserSha256(output.sha256, '浏览器截图哈希'),
    expiresAt: output.expiresAt,
  };
}

function browserDownloadMetadata(value: JsonValue): Record<string, JsonValue> {
  const output = asJsonObject(value, '浏览器隔离下载');
  const source = output.sourceDomain;
  if (typeof source !== 'string' || !source || source.length > 253 || /[\s@/\\]/u.test(source)) throw new Error('浏览器下载来源别名无效');
  return {
    sha256: browserSha256(output.sha256, '浏览器下载哈希'),
    size: browserByteSize(output.size, MAX_BROWSER_DOWNLOAD_BYTES, '浏览器下载大小'),
    mediaType: browserMediaType(output.mediaType),
    sourceAlias: source.toLocaleLowerCase(),
  };
}

function result(callId: string, content: string, metadata: Record<string, JsonValue> = {}, options: { artifactIds?: string[]; changeSetId?: string } = {}): ToolExecutionResult {
  return {
    callId,
    ok: true,
    content,
    artifactIds: options.artifactIds ?? [],
    metadata,
    ...(options.changeSetId ? { changeSetId: options.changeSetId } : {}),
  };
}

function aliasWorkspacePath(value: string, rootPath: string, rootId: string): string {
  let output = value;
  for (const candidate of new Set([rootPath, rootPath.replaceAll('\\', '/')])) {
    if (!candidate) continue;
    const pattern = new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu');
    output = output.replace(pattern, `<root:${rootId}>`);
  }
  return output;
}

function walk(root: string, prefix: string, maxFiles: number): string[] {
  const output: string[] = [];
  const visit = (directory: string) => {
    if (output.length >= maxFiles) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (output.length >= maxFiles) break;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) output.push(relative(root, absolute).replaceAll('\\', '/'));
    }
  };
  visit(prefix);
  return output;
}

async function runPowerShell(command: string, cwd: string, signal: AbortSignal, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (command.length > 16_000) throw new Error('终端命令超过 16,000 字符限制');
  return await new Promise((resolve, reject) => {
    const child = spawnWithResourceLimits(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
      : ['-lc', command], {
      cwd,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        OPENLAB_TOOL_HOST: '1',
      },
      limits: { memoryMb: 1_024, cpuMs: timeoutMs, activeProcesses: 8 },
    });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer) => `${current}${chunk.toString('utf8')}`.slice(-100_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', reject);
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export interface CoreToolDependencies {
  registry: ToolRegistry;
  projectRoot: string;
  projectId: string;
  changes: ChangeSetStore;
  research: ResearchStore;
  pins: ContextPins;
  resolveRoot?: (rootId: string | undefined, intent: 'read' | 'write') => { rootId: string; rootPath: string };
  delegateTask?: (input: { leadAgentId: string; targetAgentId: string; title: string; description: string; inputRefs: string[] }) => Promise<{ runId: string; taskId: string }>;
  sendAgentMessage?: (input: { fromAgentId: string; toAgentId: string; content: string; taskId?: string }) => Promise<string>;
  runChannel?: (input: { leadAgentId: string; channelId: string; objective: string; inputRefs: string[]; signal: AbortSignal }) => Promise<string>;
  waitForAgentRuns?: (input: { runIds: string[]; signal: AbortSignal }) => Promise<string>;
  askLead?: (input: { agentId: string; question: string; taskId?: string }) => Promise<string> | string;
  scaffoldPlugin?: (input: { id: string; name: string; description: string }) => Promise<{ root: string; files: string[] }> | { root: string; files: string[] };
  testPlugin?: (input: { root: string; signal: AbortSignal }) => Promise<string>;
  installPlugin?: (input: { sourcePath: string; scope: 'user' | 'project'; signal: AbortSignal }) => Promise<{ id: string; version: string }>;
  scaffoldSkill?: (input: { id: string; name: string; description: string; instructions: string }) => Promise<{ id: string; rootPath: string }> | { id: string; rootPath: string };
  installSkill?: (input: { sourcePath: string; scope: 'user' | 'project' }) => Promise<Array<{ id: string; name: string }>>;
  updateSettings?: (patch: Partial<HarnessSettings>) => Promise<HarnessSettings> | HarnessSettings;
  browserRequest?(path: BrowserBrokerPath, input: Record<string, JsonValue>, signal: AbortSignal): Promise<JsonValue>;
  worktableRequest?(action: 'list' | 'inspect' | 'read' | 'open' | 'reveal' | 'mount_artifact' | 'submit_annotations' | 'publish_app', input: Record<string, JsonValue>, context: { agentId: string; traceId: string; signal: AbortSignal }): Promise<{ content: string; metadata?: Record<string, JsonValue>; artifactIds?: string[] }>;
  isResearchObjectTypeAllowed?: (type: string) => boolean;
  isResearchRelationTypeAllowed?: (predicate: string) => boolean;
}

export function registerCoreTools(deps: CoreToolDependencies): () => void {
  const disposers: Array<() => void> = [];
  const actorFor = (agentId: string): EventActor => ({ id: agentId, kind: 'agent', label: 'Sci Workplace Agent' });
  const workspace = (input: Record<string, JsonValue>, intent: 'read' | 'write') => {
    const requested = typeof input.rootId === 'string' ? input.rootId : undefined;
    return deps.resolveRoot?.(requested, intent) ?? { rootId: 'project', rootPath: deps.projectRoot };
  };

  disposers.push(deps.registry.register({
    definition: {
      name: 'list_files', title: '列举工作区文件', description: '列出当前或指定授权工作目录中的文件；路径使用 rootId 与相对路径。',
      inputSchema: { type: 'object', properties: { rootId: { type: 'string' }, path: { type: 'string' }, maxFiles: { type: 'number' } }, additionalProperties: false },
      risk: 'read', renderHint: 'generic', source: 'core',
    },
    async execute(input, context) {
      const path = typeof input.path === 'string' ? input.path : '.';
      const root = workspace(input, 'read');
      const guard = new PathGuard(root.rootPath);
      const absolute = guard.resolveExisting(path);
      if (!statSync(absolute).isDirectory()) throw new Error('目标不是目录');
      const maxFiles = typeof input.maxFiles === 'number' ? Math.min(Math.max(1, Math.trunc(input.maxFiles)), 2_000) : 300;
      const files = walk(root.rootPath, absolute, maxFiles);
      return result(context.callId, files.join('\n') || '目录为空', { rootId: root.rootId, count: files.length, truncated: files.length >= maxFiles });
    },
  }));

  disposers.push(deps.registry.register({
    definition: {
      name: 'unpin_context', title: '解除固定上下文', description: '按 Context Inspector 中显示的 pin ID 解除固定；不会删除原始事件或科研对象。',
      inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
      risk: 'write', renderHint: 'generic', source: 'core',
    },
    async execute(input, context) {
      const supplied = asString(input, 'id');
      const id = supplied.startsWith('pin:') ? supplied.slice('pin:'.length) : supplied;
      const existing = deps.pins.list().find((pin) => pin.id === id);
      if (!existing || !deps.pins.unpin(id, actorFor(context.agentId), context.agentId, context.traceId)) throw new Error(`固定上下文不存在：${supplied}`);
      return result(context.callId, `已解除固定：${existing.label}`, { pinId: id });
    },
  }));

  disposers.push(deps.registry.register({
    definition: {
      name: 'read_file', title: '读取文件', description: '读取当前或指定授权工作目录内的 UTF-8 文本文件；过长内容会截断并提示。',
      inputSchema: { type: 'object', properties: { rootId: { type: 'string' }, path: { type: 'string' }, maxChars: { type: 'number' } }, required: ['path'], additionalProperties: false },
      risk: 'read', renderHint: 'generic', source: 'core',
    },
    async execute(input, context) {
      const relativePath = asString(input, 'path');
      const root = workspace(input, 'read');
      const guard = new PathGuard(root.rootPath);
      const absolute = guard.resolveExisting(relativePath);
      const file = statSync(absolute);
      if (!file.isFile()) throw new Error('目标不是文件');
      if (file.size > MAX_READ_FILE_BYTES) throw new Error('文本文件超过 20 MB 读取上限；请由专用插件流式处理并登记 Artifact');
      const maxChars = typeof input.maxChars === 'number' ? Math.min(Math.max(1_000, Math.trunc(input.maxChars)), 200_000) : 40_000;
      const content = readFileSync(absolute, 'utf8');
      const truncated = content.length > maxChars;
      return result(context.callId, truncated ? `${content.slice(0, maxChars)}\n\n[内容已截断；完整结果应登记为 Artifact]` : content, {
        rootId: root.rootId, path: relativePath, characters: content.length, truncated,
      });
    },
  }));

  disposers.push(deps.registry.register({
    definition: {
      name: 'search_text', title: '搜索工作区文本', description: '在当前或指定授权工作目录的文本文件中按字面量搜索，并返回文件与行号。',
      inputSchema: { type: 'object', properties: { rootId: { type: 'string' }, query: { type: 'string' }, path: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'], additionalProperties: false },
      risk: 'read', renderHint: 'generic', source: 'core',
    },
    async execute(input, context) {
      const query = asString(input, 'query');
      const root = workspace(input, 'read');
      const guard = new PathGuard(root.rootPath);
      const start = guard.resolveExisting(typeof input.path === 'string' ? input.path : '.');
      const maxResults = typeof input.maxResults === 'number' ? Math.min(Math.max(1, Math.trunc(input.maxResults)), 500) : 100;
      const files = statSync(start).isDirectory() ? walk(root.rootPath, start, 4_000) : [relative(root.rootPath, start).replaceAll('\\', '/')];
      const matches: string[] = [];
      const needle = query.toLocaleLowerCase();
      let scannedBytes = 0;
      for (const file of files) {
        if (matches.length >= maxResults) break;
        try {
          const absolute = guard.resolveExisting(file);
          const size = statSync(absolute).size;
          if (size > MAX_SEARCH_FILE_BYTES || scannedBytes + size > MAX_SEARCH_TOTAL_BYTES) continue;
          scannedBytes += size;
          const content = readFileSync(absolute, 'utf8');
          if (content.includes('\0')) continue;
          const lines = content.split(/\r?\n/u);
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? '';
            if (line.toLocaleLowerCase().includes(needle)) matches.push(`${file}:${index + 1}: ${line.slice(0, 300)}`);
            if (matches.length >= maxResults) break;
          }
        } catch { /* binary/unreadable files are ignored */ }
      }
      return result(context.callId, matches.join('\n') || '未找到匹配内容', { rootId: root.rootId, count: matches.length, truncated: matches.length >= maxResults, scannedBytes });
    },
  }));

  disposers.push(deps.registry.register({
    definition: {
      name: 'write_file', title: '审阅并写入文件', description: '把完整内容写入当前或指定授权工作目录，生成统一 diff、快照与可撤销变更集。',
      inputSchema: { type: 'object', properties: { rootId: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
      risk: 'write', renderHint: 'diff', source: 'core',
    },
    async execute(input, context) {
      const root = workspace(input, 'write');
      const change = deps.changes.write(asString(input, 'path'), asString(input, 'content'), actorFor(context.agentId), context.agentId, context.traceId, root.rootId);
      return result(context.callId, change.diff, { rootId: root.rootId, path: change.relativePath, beforeHash: change.beforeHash, afterHash: change.afterHash }, { changeSetId: change.id });
    },
  }));

  disposers.push(deps.registry.register({
    definition: {
      name: 'delete_file', title: '审阅并删除文件', description: '删除当前或指定授权工作目录内普通文件，执行前展示删除 diff，并生成哈希快照与可撤销变更集。',
      inputSchema: { type: 'object', properties: { rootId: { type: 'string' }, path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      risk: 'delete', renderHint: 'diff', source: 'core',
    },
    async execute(input, context) {
      const root = workspace(input, 'write');
      const change = deps.changes.delete(asString(input, 'path'), actorFor(context.agentId), context.agentId, context.traceId, root.rootId);
      return result(context.callId, change.diff, { rootId: root.rootId, path: change.relativePath, beforeHash: change.beforeHash, afterHash: null }, { changeSetId: change.id });
    },
  }));

  disposers.push(deps.registry.register({
    definition: {
      name: 'undo_change', title: '撤销文件变更', description: '按变更集恢复写入前快照；若文件后来又改变则拒绝覆盖。',
      inputSchema: { type: 'object', properties: { changeSetId: { type: 'string' } }, required: ['changeSetId'], additionalProperties: false },
      risk: 'delete', renderHint: 'diff', source: 'core',
    },
    async execute(input, context) {
      const change = deps.changes.undo(asString(input, 'changeSetId'), actorFor(context.agentId), context.agentId, context.traceId);
      return result(context.callId, `已撤销 ${change.relativePath}`, { path: change.relativePath, changeSetId: change.id });
    },
  }));

  disposers.push(deps.registry.register({
    definition: {
      name: 'run_terminal', title: '运行受控终端', description: '在当前或指定授权工作目录的独立进程中运行命令；这是应用层防护，不构成恶意命令隔离。',
      inputSchema: { type: 'object', properties: { rootId: { type: 'string' }, command: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['command'], additionalProperties: false },
      risk: 'execute', renderHint: 'terminal', source: 'core',
    },
    async execute(input, context) {
      const timeoutMs = typeof input.timeoutMs === 'number' ? Math.min(Math.max(1_000, Math.trunc(input.timeoutMs)), 120_000) : 30_000;
      const root = workspace(input, 'write');
      const execution = await runPowerShell(asString(input, 'command'), root.rootPath, context.signal, timeoutMs);
      const stdout = aliasWorkspacePath(execution.stdout, root.rootPath, root.rootId);
      const stderr = aliasWorkspacePath(execution.stderr, root.rootPath, root.rootId);
      const output = [`退出码：${execution.exitCode ?? '被终止'}`, stdout && `标准输出：\n${stdout}`, stderr && `错误输出：\n${stderr}`].filter(Boolean).join('\n\n');
      return { ...result(context.callId, output, { rootId: root.rootId, exitCode: execution.exitCode, protection: 'application-layer' }), ok: execution.exitCode === 0 };
    },
  }));

  disposers.push(deps.registry.register({
    definition: {
      name: 'create_research_object', title: '登记科研对象', description: '登记 Source、Dataset、Experiment、Evidence、Artifact 或插件命名空间对象。',
      inputSchema: {
        type: 'object', properties: {
          type: { type: 'string' }, title: { type: 'string' }, attributes: { type: 'object', additionalProperties: true },
        }, required: ['type', 'title'], additionalProperties: false,
      },
      risk: 'write', renderHint: 'artifact', source: 'core',
    },
    async execute(input, context) {
      const attributes = input.attributes && typeof input.attributes === 'object' && !Array.isArray(input.attributes) ? input.attributes as Record<string, JsonValue> : {};
      const type = asString(input, 'type');
      if (deps.isResearchObjectTypeAllowed && !deps.isResearchObjectTypeAllowed(type)) throw new Error(`科研对象类型未由核心或已启用插件注册：${type}`);
      const object = deps.research.createObject({ type: type as ResearchObjectType, title: asString(input, 'title'), attributes }, actorFor(context.agentId), context.traceId);
      return result(context.callId, `已登记 ${object.type}：${object.title}`, { object: toJson(object) }, { artifactIds: object.type === 'artifact' ? [object.id] : [] });
    },
  }));

  disposers.push(deps.registry.register({
    definition: {
      name: 'link_research_objects', title: '关联科研对象', description: '用核心或插件命名空间关系连接两个科研对象。',
      inputSchema: {
        type: 'object', properties: {
          fromId: { type: 'string' }, predicate: { type: 'string' }, toId: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' } },
        }, required: ['fromId', 'predicate', 'toId'], additionalProperties: false,
      },
      risk: 'write', renderHint: 'artifact', source: 'core',
    },
    async execute(input, context) {
      const predicate = asString(input, 'predicate');
      if (deps.isResearchRelationTypeAllowed && !deps.isResearchRelationTypeAllowed(predicate)) throw new Error(`科研关系类型未由核心或已启用插件注册：${predicate}`);
      const relation = deps.research.createRelation({
        fromId: asString(input, 'fromId'), predicate: predicate as ResearchRelationPredicate,
        toId: asString(input, 'toId'), evidenceIds: asStringArray(input, 'evidenceIds'),
      }, actorFor(context.agentId), context.traceId);
      return result(context.callId, `已建立关系 ${relation.predicate}`, { relation: toJson(relation) });
    },
  }));

  disposers.push(deps.registry.register({
    definition: {
      name: 'register_artifact', title: '登记工作区产物', description: '把当前或指定授权工作目录内已有文件登记为 Artifact，并记录根别名、文件哈希和当前 Agent trace。',
      inputSchema: { type: 'object', properties: { rootId: { type: 'string' }, path: { type: 'string' }, title: { type: 'string' }, inputObjectIds: { type: 'array', items: { type: 'string' } } }, required: ['path'], additionalProperties: false },
      risk: 'write', renderHint: 'artifact', source: 'core',
    },
    async execute(input, context) {
      const path = asString(input, 'path');
      const root = workspace(input, 'read');
      const guard = new PathGuard(root.rootPath);
      if (!existsSync(guard.resolveExisting(path))) throw new Error('待登记产物不存在');
      const registered = deps.research.registerArtifact({
        relativePath: path,
        rootId: root.rootId,
        ...(typeof input.title === 'string' ? { title: input.title } : {}),
        provenance: {
          ...context.provenance,
          inputObjectIds: [...new Set([...context.provenance.inputObjectIds, ...asStringArray(input, 'inputObjectIds')])],
        },
      }, actorFor(context.agentId));
      return result(context.callId, `已登记产物：${registered.object.title}`, { rootId: root.rootId, path, object: toJson(registered.object), provenance: toJson(registered.provenance) }, { artifactIds: [registered.object.id] });
    },
  }));

  disposers.push(deps.registry.register({
    definition: {
      name: 'pin_context', title: '固定上下文', description: '把一段说明或科研对象摘要固定到后续上下文计划中。',
      inputSchema: { type: 'object', properties: { label: { type: 'string' }, content: { type: 'string' }, sourceRefs: { type: 'array', items: { type: 'string' } } }, required: ['label', 'content'], additionalProperties: false },
      risk: 'write', renderHint: 'generic', source: 'core',
    },
    async execute(input, context) {
      const pin = deps.pins.pin({ id: randomUUID(), label: asString(input, 'label'), content: asString(input, 'content'), sourceRefs: asStringArray(input, 'sourceRefs'), createdAt: new Date().toISOString(), trust: 'untrusted' }, actorFor(context.agentId), context.agentId, context.traceId);
      return result(context.callId, `已固定：${pin.label}`, { pin: toJson(pin) });
    },
  }));

  if (deps.delegateTask) disposers.push(deps.registry.register({
    definition: {
      name: 'delegate_task', title: '委派给会话成员', description: '把明确任务委派给当前会话中由用户创建并启用的持久 Agent；不能创建新角色。',
      inputSchema: { type: 'object', properties: { targetAgentId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, inputRefs: { type: 'array', items: { type: 'string' } } }, required: ['targetAgentId', 'title', 'description'], additionalProperties: false },
      risk: 'execute', renderHint: 'agent', source: 'core',
    },
    async execute(input, context) {
      const delegated = await deps.delegateTask!({ leadAgentId: context.agentId, targetAgentId: asString(input, 'targetAgentId'), title: asString(input, 'title'), description: asString(input, 'description'), inputRefs: asStringArray(input, 'inputRefs') });
      return result(context.callId, `任务已委派给会话成员 ${asString(input, 'targetAgentId')}`, { runId: delegated.runId, taskId: delegated.taskId, targetAgentId: asString(input, 'targetAgentId') });
    },
  }));

  if (deps.sendAgentMessage) disposers.push(deps.registry.register({
    definition: {
      name: 'send_agent_message', title: '发送 Agent 消息', description: '通过顺序邮箱向另一个 Agent 发送任务消息或补充信息。',
      inputSchema: { type: 'object', properties: { toAgentId: { type: 'string' }, content: { type: 'string' }, taskId: { type: 'string' } }, required: ['toAgentId', 'content'], additionalProperties: false },
      risk: 'read', renderHint: 'agent', source: 'core',
    },
    async execute(input, context) {
      const id = await deps.sendAgentMessage!({ fromAgentId: context.agentId, toAgentId: asString(input, 'toAgentId'), content: asString(input, 'content'), ...(typeof input.taskId === 'string' ? { taskId: input.taskId } : {}) });
      return result(context.callId, '消息已送达 Agent 邮箱', { messageId: id });
    },
  }));

  if (deps.runChannel) disposers.push(deps.registry.register({
    definition: {
      name: 'run_channel', title: '运行协作频道', description: '让已由用户建立的 Agent 频道围绕目标进行有限轮协作；不会创建 Agent，也不会自行持续运行。',
      inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, objective: { type: 'string' }, inputRefs: { type: 'array', items: { type: 'string' } } }, required: ['channelId', 'objective'], additionalProperties: false },
      risk: 'execute', renderHint: 'agent', source: 'core',
    },
    async execute(input, context) {
      const content = await deps.runChannel!({ leadAgentId: context.agentId, channelId: asString(input, 'channelId'), objective: asString(input, 'objective'), inputRefs: asStringArray(input, 'inputRefs'), signal: context.signal });
      return result(context.callId, content);
    },
  }));

  if (deps.waitForAgentRuns) disposers.push(deps.registry.register({
    definition: {
      name: 'wait_for_agent_runs', title: '等待成员任务收敛', description: '等待指定持久 Agent 运行完成、失败或取消，并读取可追溯的成员报告。',
      inputSchema: { type: 'object', properties: { runIds: { type: 'array', items: { type: 'string' } } }, required: ['runIds'], additionalProperties: false },
      risk: 'read', renderHint: 'agent', source: 'core',
    },
    async execute(input, context) {
      const content = await deps.waitForAgentRuns!({ runIds: asStringArray(input, 'runIds'), signal: context.signal });
      return result(context.callId, content);
    },
  }));

  if (deps.askLead) disposers.push(deps.registry.register({
    definition: {
      name: 'ask_lead', title: '向主管追问', description: '成员 Agent 缺少必要信息时向当前会话主管发送问题，并暂停该次运行等待补充。',
      inputSchema: { type: 'object', properties: { question: { type: 'string' }, taskId: { type: 'string' } }, required: ['question'], additionalProperties: false },
      risk: 'read', renderHint: 'agent', source: 'core',
    },
    async execute(input, context) {
      const messageId = await deps.askLead!({ agentId: context.agentId, question: asString(input, 'question'), ...(typeof input.taskId === 'string' ? { taskId: input.taskId } : {}) });
      return result(context.callId, '问题已发送给会话主管；当前成员运行将暂停等待回复。', { messageId });
    },
  }));

  if (deps.scaffoldPlugin) disposers.push(deps.registry.register({
    definition: {
      name: 'scaffold_plugin', title: '创建插件开发脚手架', description: '在项目开发目录生成 manifest、源码、契约测试和说明；随后可继续用 write_file 定制实现。',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } }, required: ['id', 'name', 'description'], additionalProperties: false },
      risk: 'write', renderHint: 'diff', source: 'core',
    },
    async execute(input, context) {
      const output = await deps.scaffoldPlugin!({ id: asString(input, 'id'), name: asString(input, 'name'), description: asString(input, 'description') });
      return result(context.callId, `插件脚手架已生成：${output.root}\n${output.files.join('\n')}`, { root: output.root, files: output.files });
    },
  }));

  if (deps.testPlugin) disposers.push(deps.registry.register({
    definition: {
      name: 'test_plugin', title: '运行插件构建与契约测试', description: '在临时候选副本中安装依赖（禁用 lifecycle scripts）、执行 TypeScript 类型检查、受限契约测试和运行时健康检查，不会自动安装。',
      inputSchema: { type: 'object', properties: { root: { type: 'string' } }, required: ['root'], additionalProperties: false },
      risk: 'external', renderHint: 'terminal', source: 'core',
    },
    async execute(input, context) {
      const output = await deps.testPlugin!({ root: asString(input, 'root'), signal: context.signal });
      return result(context.callId, output, { tested: true });
    },
  }));

  if (deps.installPlugin) disposers.push(deps.registry.register({
    definition: {
      name: 'install_plugin', title: '安装本地插件', description: '在候选目录中禁用 lifecycle scripts 安装生产依赖、健康检查、锁定 SHA-256 后原子安装并激活；未签名插件会持续显示警告。',
      inputSchema: { type: 'object', properties: { sourcePath: { type: 'string' }, scope: { type: 'string', enum: ['user', 'project'] } }, required: ['sourcePath', 'scope'], additionalProperties: false },
      risk: 'external', renderHint: 'form', source: 'core',
    },
    async execute(input, context) {
      const scope = asString(input, 'scope');
      if (scope !== 'user' && scope !== 'project') throw new Error('插件作用域必须是 user 或 project');
      const installed = await deps.installPlugin!({ sourcePath: asString(input, 'sourcePath'), scope, signal: context.signal });
      return result(context.callId, `插件已安装：${installed.id}@${installed.version}`, { pluginId: installed.id, version: installed.version, unsigned: true });
    },
  }));

  if (deps.scaffoldSkill) disposers.push(deps.registry.register({
    definition: {
      name: 'scaffold_skill', title: '创建项目 Skill', description: '创建带 YAML frontmatter 的项目级 SKILL.md，用于用户自己的科研方向说明。',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' } }, required: ['id', 'name', 'description', 'instructions'], additionalProperties: false },
      risk: 'write', renderHint: 'diff', source: 'core',
    },
    async execute(input, context) {
      const skill = await deps.scaffoldSkill!({ id: asString(input, 'id'), name: asString(input, 'name'), description: asString(input, 'description'), instructions: asString(input, 'instructions') });
      return result(context.callId, `Skill 已创建：${skill.id}\n${skill.rootPath}`, { skillId: skill.id, rootPath: skill.rootPath });
    },
  }));

  if (deps.installSkill) disposers.push(deps.registry.register({
    definition: {
      name: 'install_skill', title: '校验并安装本地 Skill', description: '校验本地目录或 ZIP 中的 SKILL.md、frontmatter 与引用边界，批准后安装到项目或用户作用域。',
      inputSchema: { type: 'object', properties: { sourcePath: { type: 'string' }, scope: { type: 'string', enum: ['user', 'project'] } }, required: ['sourcePath', 'scope'], additionalProperties: false },
      risk: 'external', renderHint: 'form', source: 'core',
    },
    async execute(input, context) {
      const scope = asString(input, 'scope');
      if (scope !== 'user' && scope !== 'project') throw new Error('Skill 作用域必须是 user 或 project');
      const installed = await deps.installSkill!({ sourcePath: asString(input, 'sourcePath'), scope });
      return result(context.callId, `Skill 已安装：${installed.map((skill) => skill.name).join('、')}`, { skills: toJson(installed), scope });
    },
  }));

  if (deps.updateSettings) disposers.push(deps.registry.register({
    definition: {
      name: 'propose_harness_settings', title: '提议修改 Harness 设置', description: '提议修改默认 Agent 模型、小工具模型、并发运行数或上下文预算；必须经用户审批后才保存。',
      inputSchema: {
        type: 'object', properties: {
          defaultAgentModel: { type: 'string' }, utilityModel: { type: 'string' }, maxConcurrentAgentRuns: { type: 'number' },
          defaultAgentContextBudget: { type: 'number' }, delegatedAgentContextBudget: { type: 'number' },
        }, additionalProperties: false,
      },
      risk: 'write', renderHint: 'form', source: 'core',
    },
    async execute(input, context) {
      const patch: Partial<HarnessSettings> = {};
      if (typeof input.defaultAgentModel === 'string') patch.defaultAgentModel = input.defaultAgentModel;
      if (typeof input.utilityModel === 'string') patch.utilityModel = input.utilityModel;
      if (typeof input.maxConcurrentAgentRuns === 'number') patch.maxConcurrentAgentRuns = input.maxConcurrentAgentRuns;
      if (typeof input.defaultAgentContextBudget === 'number') patch.defaultAgentContextBudget = input.defaultAgentContextBudget;
      if (typeof input.delegatedAgentContextBudget === 'number') patch.delegatedAgentContextBudget = input.delegatedAgentContextBudget;
      if (Object.keys(patch).length === 0) throw new Error('至少需要提供一项设置变更');
      const settings = await deps.updateSettings!(patch);
      return result(context.callId, `Harness 设置已更新：\n${JSON.stringify(settings, null, 2)}`, { settings: toJson(settings) });
    },
  }));

  if (deps.worktableRequest) {
    const addWorktableTool = (definition: {
      name: string;
      title: string;
      description: string;
      inputSchema: Record<string, JsonValue>;
      risk: 'read' | 'write' | 'external';
      renderHint?: 'generic' | 'form' | 'artifact';
      action: 'list' | 'inspect' | 'read' | 'open' | 'reveal' | 'mount_artifact' | 'submit_annotations' | 'publish_app';
    }) => disposers.push(deps.registry.register({
      definition: {
        name: definition.name, title: definition.title, description: definition.description,
        inputSchema: definition.inputSchema, risk: definition.risk, renderHint: definition.renderHint ?? 'generic', source: 'core', capabilityId: 'worktable',
      },
      async execute(input, context) {
        const output = await deps.worktableRequest!(definition.action, input, { agentId: context.agentId, traceId: context.traceId, signal: context.signal });
        return result(
          context.callId,
          output.content,
          output.metadata ?? {},
          output.artifactIds ? { artifactIds: output.artifactIds } : {},
        );
      },
    }));
    addWorktableTool({
      name: 'worktable_list', title: '列出科研工作台', description: '列出当前项目的工作台任务、绑定会话、状态和修订元数据；不自动读取正文。', action: 'list', risk: 'read',
      inputSchema: { type: 'object', properties: { includeArchived: { type: 'boolean' } }, additionalProperties: false },
    });
    addWorktableTool({
      name: 'worktable_inspect', title: '检查科研工作台', description: '检查一个工作台实例的窗格、活动内容、任务和开放批注元数据；不返回文档正文。', action: 'inspect', risk: 'read',
      inputSchema: { type: 'object', properties: { instanceId: { type: 'string' } }, required: ['instanceId'], additionalProperties: false },
    });
    addWorktableTool({
      name: 'worktable_read', title: '读取工作台内容', description: '按需读取指定窗格或标签的文本/Artifact 内容。PDF、图片和插件面板只返回可追溯元数据，不把整份二进制资料塞入上下文。', action: 'read', risk: 'read',
      inputSchema: { type: 'object', properties: { instanceId: { type: 'string' }, paneId: { type: 'string' }, tabId: { type: 'string' }, fileName: { type: 'string' }, role: { type: 'string', enum: ['source', 'data', 'environment', 'output', 'log', 'mapping'] }, maxChars: { type: 'number' } }, required: ['instanceId'], additionalProperties: false },
    });
    addWorktableTool({
      name: 'worktable_open', title: '打开科研工作台', description: '在工作台模式中激活一个已有任务实例；不会修改任务内容或修订。', action: 'open', risk: 'read',
      inputSchema: { type: 'object', properties: { instanceId: { type: 'string' } }, required: ['instanceId'], additionalProperties: false },
    });
    addWorktableTool({
      name: 'worktable_reveal', title: '定位工作台证据', description: '在已挂载的文档窗格中定位 PDF 区域、文本或稳定文档锚点。定位只改变设备视图，不增加任务 revision。', action: 'reveal', risk: 'read',
      inputSchema: { type: 'object', properties: { instanceId: { type: 'string' }, paneId: { type: 'string' }, tabId: { type: 'string' }, document: { type: 'object' }, selector: { type: 'object' } }, required: ['instanceId', 'paneId', 'tabId', 'document', 'selector'], additionalProperties: false },
    });
    addWorktableTool({
      name: 'worktable_mount_artifact', title: '挂载 Artifact 到工作台', description: '经用户确认后，把指定不可变 Artifact Revision 挂到当前插件内部窗格。', action: 'mount_artifact', risk: 'write', renderHint: 'artifact',
      inputSchema: { type: 'object', properties: { instanceId: { type: 'string' }, paneId: { type: 'string' }, artifactId: { type: 'string' }, revisionId: { type: 'string' }, role: { type: 'string', enum: ['source', 'data', 'environment', 'output', 'log', 'mapping'] }, title: { type: 'string' } }, required: ['instanceId', 'paneId', 'artifactId', 'revisionId'], additionalProperties: false },
    });
    addWorktableTool({
      name: 'worktable_submit_annotations', title: '提交工作台批注', description: '经用户确认后，把指定开放批注组成不可变批次供当前 Agent 处理。', action: 'submit_annotations', risk: 'external', renderHint: 'form',
      inputSchema: { type: 'object', properties: { instanceId: { type: 'string' }, annotationIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100, uniqueItems: true } }, required: ['instanceId', 'annotationIds'], additionalProperties: false },
    });
    addWorktableTool({
      name: 'worktable_publish_app', title: '发布工作台静态应用', description: '经用户确认后，把已归档 Artifact Revision 发布为受限静态应用，并可挂载到当前工作台。', action: 'publish_app', risk: 'external', renderHint: 'artifact',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, artifactId: { type: 'string' }, revisionId: { type: 'string' }, entry: { type: 'string' }, instanceId: { type: 'string' }, paneId: { type: 'string' }, networkDomains: { type: 'array', items: { type: 'string' } }, hostCapabilities: { type: 'array', items: { type: 'string' } } }, required: ['title', 'artifactId', 'revisionId', 'entry', 'instanceId'], additionalProperties: false },
    });
  }

  if (deps.browserRequest) {
    disposers.push(deps.registry.register({
      definition: {
        name: 'browser_open', title: '打开自动化浏览器', description: '在用户已授权的命名浏览器档案中打开 HTTPS 页面。新域名导航必须确认；密码、验证码、支付和二次认证只能由用户完成。',
        inputSchema: { type: 'object', properties: { profileId: { type: 'string' }, instanceId: { type: 'string' }, paneId: { type: 'string' }, url: { type: 'string' } }, required: ['profileId', 'instanceId', 'paneId', 'url'], additionalProperties: false },
        risk: 'network', renderHint: 'form', source: 'core',
      },
      async execute(input, context) {
        const output = await deps.browserRequest!('open', { profileId: asString(input, 'profileId'), projectId: deps.projectId, instanceId: asString(input, 'instanceId'), paneId: asString(input, 'paneId'), url: asString(input, 'url'), confirmed: true }, context.signal);
        return result(context.callId, '浏览器页面已打开；页面内容仍按不可信外部资料处理。', { browser: output, trust: 'untrusted-external' });
      },
    }));
    disposers.push(deps.registry.register({
      definition: {
        name: 'browser_observe', title: '观察浏览器页面', description: '读取当前浏览器窗格的净化可访问性树和交互引用；不会读取 Cookie、密码、令牌或浏览器存储。',
        inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false },
        risk: 'read', renderHint: 'generic', source: 'core',
      },
      async execute(input, context) {
        const output = await deps.browserRequest!('observe', { sessionId: asString(input, 'sessionId') }, context.signal);
        return result(context.callId, JSON.stringify(output), { observation: output, trust: 'untrusted-external' });
      },
    }));
    disposers.push(deps.registry.register({
      definition: {
        name: 'browser_screenshot', title: '截取浏览器页面', description: '按当前 observationId 生成临时、不可信的 PNG 图片资源元数据；不返回图片字节、base64 或宿主路径，密码、验证码、支付和二次认证页面会被宿主拒绝。',
        inputSchema: {
          type: 'object', properties: { sessionId: { type: 'string' }, observationId: { type: 'string' } },
          required: ['sessionId', 'observationId'], additionalProperties: false,
        },
        risk: 'read', renderHint: 'generic', source: 'core',
      },
      async execute(input, context) {
        const sessionId = asString(input, 'sessionId');
        const output = await deps.browserRequest!('screenshot', { sessionId, observationId: asString(input, 'observationId') }, context.signal);
        const resource = browserScreenshotResource(output, sessionId);
        return result(context.callId, '浏览器截图资源已生成；该图片来自不可信外部页面，仅返回临时资源元数据。', {
          imageResource: resource, trust: 'untrusted-external',
        });
      },
    }));
    disposers.push(deps.registry.register({
      definition: {
        name: 'browser_upload', title: '上传已选择的本地文件', description: '把桌面宿主文件选择器逐次签发的 opaque uploadIds 提交到当前文件输入；不接受路径，并按当前联网安全策略处理。密码、验证码、支付和二次认证页面会被宿主拒绝。',
        inputSchema: {
          type: 'object', properties: {
            sessionId: { type: 'string' }, observationId: { type: 'string' }, ref: { type: 'string' },
            uploadIds: { type: 'array', items: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$', minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 10, uniqueItems: true },
          },
          required: ['sessionId', 'observationId', 'ref', 'uploadIds'], additionalProperties: false,
        },
        risk: 'external', renderHint: 'form', source: 'core',
      },
      async execute(input, context) {
        await deps.browserRequest!('upload', {
          sessionId: asString(input, 'sessionId'), observationId: asString(input, 'observationId'), ref: asString(input, 'ref'),
          uploadIds: asStringArray(input, 'uploadIds'), confirmed: true,
        }, context.signal);
        return result(context.callId, '已上传桌面宿主选定的文件；继续操作前必须重新观察页面。', { observationInvalidated: true });
      },
    }));
    disposers.push(deps.registry.register({
      definition: {
        name: 'browser_download', title: '下载到宿主隔离区', description: '按当前 observationId 和联网安全策略触发下载。文件只进入桌面宿主 quarantine，不自动导入工作区；仅返回哈希、大小、MIME 和来源别名。密码、验证码、支付和二次认证页面会被宿主拒绝。',
        inputSchema: {
          type: 'object', properties: { sessionId: { type: 'string' }, observationId: { type: 'string' }, ref: { type: 'string' } },
          required: ['sessionId', 'observationId', 'ref'], additionalProperties: false,
        },
        risk: 'external', renderHint: 'form', source: 'core',
      },
      async execute(input, context) {
        const output = await deps.browserRequest!('download', {
          sessionId: asString(input, 'sessionId'), observationId: asString(input, 'observationId'), ref: asString(input, 'ref'), confirmed: true,
        }, context.signal);
        const quarantine = browserDownloadMetadata(output);
        return result(context.callId, '下载已完成并保存在桌面宿主隔离区；未导入工作区。', {
          quarantine, trust: 'untrusted-external', observationInvalidated: true,
        });
      },
    }));
    for (const [name, title, description, action] of [
      ['browser_click', '点击浏览器元素', '使用当前 observationId 点击非敏感页面元素；页面变化后旧引用立即失效。密码、验证码、支付和二次认证流程只能由用户完成。', 'click'],
      ['browser_type', '输入浏览器文本', '向非敏感页面字段输入文本；密码、验证码、支付和二次认证字段会被宿主拒绝。', 'type'],
      ['browser_select', '选择浏览器选项', '在当前页面选择非敏感选项；密码、验证码、支付和二次认证流程只能由用户完成。', 'select'],
      ['browser_press', '发送浏览器按键', '向非敏感页面发送一个受限按键；密码、验证码、支付和二次认证流程只能由用户完成。', 'press'],
      ['browser_scroll', '滚动浏览器页面', '按给定距离滚动已净化页面；不得用于处理密码、验证码、支付或二次认证流程。', 'scroll'],
    ] as const) disposers.push(deps.registry.register({
      definition: {
        name, title, description,
        inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, observationId: { type: 'string' }, ref: { type: 'string' }, value: { type: 'string' } }, required: action === 'press' || action === 'scroll' ? ['sessionId', 'observationId', 'value'] : action === 'click' ? ['sessionId', 'observationId', 'ref'] : ['sessionId', 'observationId', 'ref', 'value'], additionalProperties: false },
        risk: 'external', renderHint: 'form', source: 'core',
      },
      async execute(input, context) {
        const output = await deps.browserRequest!('act', {
          sessionId: asString(input, 'sessionId'), observationId: asString(input, 'observationId'), action,
          ...(typeof input.ref === 'string' ? { ref: input.ref } : {}), ...(typeof input.value === 'string' ? { value: input.value } : {}), confirmed: true,
        }, context.signal);
        return result(context.callId, `${title}已执行；继续操作前必须重新观察页面。`, { browser: output, observationInvalidated: true });
      },
    }));
  }

  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
