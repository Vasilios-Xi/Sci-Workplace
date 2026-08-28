import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import AdmZip from 'adm-zip';
import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { AgentPreset, AgentTemplate, ContextContribution, JsonValue, PluginManifest, PluginWorkflowDefinition, PluginWorkflowResult, ToolDefinition, ToolExecutionResult, ToolRenderHint, WorkbenchBlueprintV1, WorkbenchContribution, WorkbenchViewDescriptor, WorktableContent, WorktableTemplateContribution } from '@openlab/protocol';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { atomicWriteJson, readJsonFile } from '../util/files.js';
import { readPluginManifest } from './plugin-manifest.js';
import { PluginProcess, type PluginDescription, type PluginHostCallHandler } from './plugin-process.js';
import { inspectPluginPackage, preparePluginDependencies, type PluginPackageInspection } from './plugin-toolchain.js';
import { namespacedToolName } from './extension-tool-name.js';

export interface InstalledPlugin {
  manifest: PluginManifest;
  root: string;
  scope: 'user' | 'project';
  enabled: boolean;
  trusted: boolean;
  sha256: string;
  integrity: 'verified' | 'unlocked' | 'mismatch';
  error?: string;
}

export interface PluginSourceInspection {
  manifest: PluginManifest;
  sha256: string;
  sourceType: 'directory' | 'zip';
  package: PluginPackageInspection;
}

interface AjvInstance {
  compile(schema: object): ValidateFunction;
  errorsText(errors?: ErrorObject[] | null, options?: { separator?: string }): string;
}

const AjvConstructor = AjvModule as unknown as new (options?: object) => AjvInstance;
const MAX_PLUGIN_FILES = 20_000;
const MAX_PLUGIN_BYTES = 512 * 1024 * 1024;
const MAX_PLUGIN_FILE_BYTES = 128 * 1024 * 1024;

function removePluginTree(path: string): void {
  // Package managers and antivirus scanners can briefly retain handles after a
  // child process exits on Windows. Node retries EPERM/EBUSY only when these
  // options are provided for recursive removal.
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function validatePortableRelativePath(path: string): void {
  if (path.length > 400) throw new Error(`插件路径过长：${path.slice(0, 80)}…`);
  for (const segment of path.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.' || segment === '..' || /[:\0]/u.test(segment) || /[. ]$/u.test(segment)) throw new Error(`插件包含不安全路径：${path}`);
    const stem = segment.split('.')[0]?.toLocaleLowerCase();
    if (stem && /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(stem)) throw new Error(`插件包含 Windows 保留路径：${path}`);
  }
}

function collectPluginFiles(root: string, allowNodeModules: boolean): Array<{ path: string; relative: string; size: number }> {
  const resolvedRoot = resolve(root);
  const files: Array<{ path: string; relative: string; size: number }> = [];
  let totalBytes = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const rel = relative(resolvedRoot, path).replaceAll('\\', '/');
      validatePortableRelativePath(rel);
      if (!allowNodeModules && rel.split('/').includes('node_modules')) throw new Error('插件来源不得携带 node_modules；请在 package.json 中声明依赖，由 Sci Workplace 重新安装');
      if (entry.isSymbolicLink()) throw new Error(`插件不得包含符号链接或目录联接：${rel}`);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`插件包含不支持的文件类型：${rel}`);
      const size = statSync(path).size;
      if (size > MAX_PLUGIN_FILE_BYTES) throw new Error(`插件单文件超过 128 MB：${rel}`);
      totalBytes += size;
      files.push({ path, relative: rel, size });
      if (files.length > MAX_PLUGIN_FILES) throw new Error(`插件文件数量超过上限（${MAX_PLUGIN_FILES}）`);
      if (totalBytes > MAX_PLUGIN_BYTES) throw new Error('插件解压后大小超过 512 MB');
    }
  };
  visit(resolvedRoot);
  return files;
}

function validateZipEntries(zip: AdmZip, destination: string): void {
  const entries = zip.getEntries();
  if (entries.length > MAX_PLUGIN_FILES) throw new Error(`插件压缩包文件数量超过上限（${MAX_PLUGIN_FILES}）`);
  let totalBytes = 0;
  for (const entry of entries) {
    const normalized = entry.entryName.replaceAll('\\', '/').replace(/\/$/u, '');
    if (normalized) validatePortableRelativePath(normalized);
    if (!isWithin(destination, resolve(destination, entry.entryName))) throw new Error(`插件压缩包包含越界路径：${entry.entryName}`);
    const size = Number(entry.header.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PLUGIN_FILE_BYTES) throw new Error(`插件压缩包文件大小异常：${entry.entryName}`);
    totalBytes += size;
    if (totalBytes > MAX_PLUGIN_BYTES) throw new Error('插件压缩包解压后大小超过 512 MB');
  }
}

export function validatePluginDescription(manifest: PluginManifest, description: PluginDescription): void {
  const expectedApiVersion = manifest.apiVersion ?? 1;
  if (description.apiVersion !== expectedApiVersion) throw new Error(`插件 API 版本与 manifest 不一致：${manifest.id}`);
  const names = description.tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) throw new Error(`插件包含重复工具名：${manifest.id}`);
  const declared = manifest.contributes.tools ?? [];
  for (const name of declared) if (!names.includes(name)) throw new Error(`插件未导出 manifest 声明的工具：${name}`);
  for (const tool of description.tools) {
    if (tool.execution) {
      if (!['request', 'long-running'].includes(tool.execution.mode)) throw new Error(`插件工具 ${tool.name} 执行模式无效`);
      const limit = tool.execution.mode === 'long-running' ? 30 * 60_000 : 20_000;
      if (tool.execution.timeoutMs !== undefined && (!Number.isInteger(tool.execution.timeoutMs) || tool.execution.timeoutMs < 1_000 || tool.execution.timeoutMs > limit)) throw new Error(`插件工具 ${tool.name} 超时设置无效`);
    }
    if (tool.risk === 'delete' && !manifest.permissions.includes(expectedApiVersion === 1 ? 'project:write' : 'workspace:edit')) throw new Error(`插件工具 ${tool.name} 缺少文件删除权限`);
    if (tool.risk === 'write') {
      const mutationPermissions: PluginManifest['permissions'] = expectedApiVersion !== 1
        ? ['workspace:edit', 'annotations:write', 'artifacts:write', 'artifacts:publish', 'evidence:write', 'research:write', 'worktable:write', 'workbench:write', 'workbench:mount', 'browser:interact', 'generated-apps:publish', 'generated-apps:build', 'toolchains:execute']
        : ['project:write'];
      if (!mutationPermissions.some((permission) => manifest.permissions.includes(permission))) throw new Error(`插件工具 ${tool.name} 缺少写入能力`);
    }
    if (tool.risk === 'execute' && expectedApiVersion !== 1 && !manifest.permissions.includes('jobs:run')) throw new Error(`插件工具 ${tool.name} 缺少任务执行能力`);
    if (tool.risk === 'network' && !manifest.permissions.includes('network') && !manifest.permissions.includes('browser:observe') && !manifest.permissions.includes('browser:interact')) throw new Error(`插件工具 ${tool.name} 需要 network 或受控浏览器权限`);
  }
  const workflows = description.workflows ?? [];
  if (workflows.length > 32 || new Set(workflows.map((workflow) => workflow.id)).size !== workflows.length) throw new Error(`插件工作流数量或 ID 无效：${manifest.id}`);
  if (workflows.length > 0 && (expectedApiVersion === 1 || !manifest.permissions.includes('jobs:run'))) throw new Error(`插件工作流需要 Plugin API v2/v3 与 jobs:run：${manifest.id}`);
  for (const workflow of workflows) {
    if (!/^[a-z0-9][a-z0-9._-]{1,127}$/u.test(workflow.id) || !workflow.title.trim() || !workflow.description.trim()) throw new Error(`插件工作流定义无效：${manifest.id}`);
    new AjvConstructor({ allErrors: true, strict: false }).compile(workflow.inputSchema as object);
  }
  if ((manifest.contributes.contextProviders?.length ?? 0) > 0 && !description.hasContext) throw new Error(`插件未导出 manifest 声明的上下文提供器：${manifest.id}`);
  const pluginTemplates = description.agentTemplates ?? [];
  const templateIds = pluginTemplates.map((template) => template.id);
  const presetIds = description.agentPresets.map((preset) => preset.id);
  const compatibleIds = [...templateIds, ...presetIds];
  if (new Set(compatibleIds).size !== compatibleIds.length) throw new Error(`插件包含重复 Agent 模板：${manifest.id}`);
  for (const declaredPreset of [...(manifest.contributes.agentTemplates ?? []), ...(manifest.contributes.agentPresets ?? [])]) {
    if (!compatibleIds.includes(declaredPreset)) throw new Error(`插件未导出 manifest 声明的 Agent 模板：${declaredPreset}`);
  }
  for (const template of pluginTemplates) {
    if (!template.id.startsWith(`${manifest.id}:`)) throw new Error(`插件 Agent 模板必须使用插件命名空间：${template.id}`);
    if (!template.name.trim() || !template.summary.trim() || !template.identity.trim() || !template.instructions.trim()) throw new Error(`插件 Agent 模板内容不完整：${template.id}`);
    if (!['sage', 'ocean', 'amber'].includes(template.avatar)) throw new Error(`插件 Agent 模板头像无效：${template.id}`);
  }
  for (const preset of description.agentPresets) {
    if (!preset.id.startsWith(`${manifest.id}:`)) throw new Error(`插件 Agent preset 必须使用插件命名空间：${preset.id}`);
    if (!preset.name.trim() || !preset.instructions.trim()) throw new Error(`插件 Agent preset 内容不完整：${preset.id}`);
    if (preset.toolNames.includes('*')) throw new Error(`插件 Agent preset 不得申请内部全工具通配符：${preset.id}`);
    if (!Number.isFinite(preset.contextBudget) || preset.contextBudget < 32_000 || preset.contextBudget > 1_000_000) throw new Error(`插件 Agent preset 上下文预算无效：${preset.id}`);
  }
  if (manifest.contributes.settingsSchema) new AjvConstructor({ allErrors: true, strict: false }).compile(manifest.contributes.settingsSchema as object);
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function toolTimeout(definition: Pick<ToolDefinition, 'execution'>): number {
  if (definition.execution?.mode !== 'long-running') return definition.execution?.timeoutMs ?? 20_000;
  return Math.min(definition.execution.timeoutMs ?? 30 * 60_000, 30 * 60_000);
}

const LEGACY_WORKTABLE_OPENED_AT = '1970-01-01T00:00:00.000Z';

function legacyViewContent(pluginId: string, view: WorkbenchViewDescriptor): WorktableContent {
  if (view.kind === 'custom' && view.panelId) return { kind: 'plugin-panel', pluginId, panelId: view.panelId };
  if (view.kind === 'jobs' || view.kind === 'environment') return { kind: 'builtin', type: 'tasks' };
  return { kind: 'builtin', type: 'explorer' };
}

/** Project legacy Workbench contributions into safe, top-level templates. */
export function legacyWorkbenchTemplate(pluginId: string, workbench: WorkbenchContribution): WorktableTemplateContribution {
  const paneId = 'legacy-pane';
  const tabs = workbench.views.map((view) => ({
    id: view.id,
    title: view.title,
    content: legacyViewContent(pluginId, view),
    pinned: true,
    openedAt: LEGACY_WORKTABLE_OPENED_AT,
  }));
  return {
    id: workbench.id,
    version: '0.0.0-legacy',
    title: workbench.title,
    description: '由旧版 Plugin API v2 工作台兼容映射。',
    icon: 'panels-top-left',
    pluginId,
    kind: 'research',
    inputSchema: { type: 'object', additionalProperties: false },
    layout: { kind: 'pane', paneId },
    panes: [{ id: paneId, title: workbench.title, tabs, activeTabId: tabs[0]!.id }],
    commands: [...workbench.commands],
  };
}

function hashDirectory(root: string): string {
  const hash = createHash('sha256');
  for (const file of collectPluginFiles(root, true)) {
    hash.update(file.relative);
    hash.update(String(file.size));
    hash.update(readFileSync(file.path));
  }
  return hash.digest('hex');
}

function readBooleanRecord(path: string): Record<string, boolean> {
  const value = readJsonFile<unknown>(path, {});
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, enabled]) => /^[a-z0-9][a-z0-9._-]{1,63}$/u.test(id) && typeof enabled === 'boolean'));
}

function readShaRecord(path: string): Record<string, string> {
  const value = readJsonFile<unknown>(path, {});
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, sha256]) => /^[a-z0-9][a-z0-9._-]{1,63}$/u.test(id) && typeof sha256 === 'string' && /^[a-f0-9]{64}$/u.test(sha256)));
}

function readSettingsRecord(path: string): Record<string, JsonValue> {
  const value = readJsonFile<unknown>(path, {});
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id]) => /^[a-z0-9][a-z0-9._-]{1,63}$/u.test(id))) as Record<string, JsonValue>;
}

export class PluginManager {
  readonly #userRoot: string;
  readonly #projectRoot: string;
  readonly #projectPath: string;
  readonly #registry: ToolRegistry;
  readonly #projectId: string;
  readonly #statePath: string;
  readonly #settingsPath: string;
  readonly #userLocksPath: string;
  readonly #projectLocksPath: string;
  readonly #projectLocksProjectionPath: string;
  readonly #dependencyCache: string;
  readonly #ajv = new AjvConstructor({ allErrors: true, strict: false });
  readonly #processes = new Map<string, PluginProcess>();
  readonly #descriptions = new Map<string, PluginDescription>();
  readonly #toolDisposers = new Map<string, Array<() => void>>();
  #enabled: Record<string, boolean>;
  #settings: Record<string, JsonValue>;
  #userLocks: Record<string, string>;
  #projectLocks: Record<string, string>;
  #plugins: InstalledPlugin[] = [];
  #hostHandler: PluginHostCallHandler | undefined;

  constructor(options: { userRoot: string; projectRoot: string; projectId: string; registry: ToolRegistry; hostHandler?: PluginHostCallHandler }) {
    this.#userRoot = options.userRoot;
    this.#projectPath = options.projectRoot;
    this.#projectRoot = join(options.projectRoot, '.openlab', 'plugins');
    this.#registry = options.registry;
    this.#projectId = options.projectId;
    this.#hostHandler = options.hostHandler;
    this.#statePath = join(options.projectRoot, '.openlab', 'plugin-state.json');
    this.#settingsPath = join(options.projectRoot, '.openlab', 'plugin-settings.json');
    this.#userLocksPath = join(options.userRoot, '.openlab-locks.json');
    const projectTrustId = createHash('sha256').update(resolve(options.projectRoot).toLocaleLowerCase()).digest('hex');
    this.#projectLocksPath = join(options.userRoot, '.project-locks', `${projectTrustId}.json`);
    this.#projectLocksProjectionPath = join(options.projectRoot, '.openlab', 'plugin-lock.json');
    this.#dependencyCache = join(dirname(this.#userRoot), 'cache', 'plugin-packages');
    mkdirSync(this.#userRoot, { recursive: true });
    mkdirSync(this.#projectRoot, { recursive: true });
    this.#enabled = readBooleanRecord(this.#statePath);
    this.#settings = readSettingsRecord(this.#settingsPath);
    this.#userLocks = readShaRecord(this.#userLocksPath);
    this.#projectLocks = readShaRecord(this.#projectLocksPath);
    this.refresh();
  }

  refresh(): InstalledPlugin[] {
    const plugins: InstalledPlugin[] = [];
    this.scan(this.#userRoot, 'user', plugins);
    this.scan(this.#projectRoot, 'project', plugins);
    const merged = new Map<string, InstalledPlugin>();
    for (const plugin of plugins) merged.set(plugin.manifest.id, plugin);
    this.#plugins = [...merged.values()];
    return this.list();
  }

  list(): InstalledPlugin[] {
    return structuredClone(this.#plugins);
  }

  setHostHandler(handler: PluginHostCallHandler): void {
    this.#hostHandler = handler;
    for (const process of this.#processes.values()) process.setHostHandler(handler);
  }

  workbenches(): WorkbenchContribution[] {
    return [...this.#processes.keys()].flatMap((id) => (this.require(id).manifest.contributes.workbenches ?? []).map((value) => ({ ...structuredClone(value), pluginId: id })));
  }

  worktableTemplates(): WorktableTemplateContribution[] {
    return [...this.#processes.keys()].flatMap((id) => {
      const contributions = this.require(id).manifest.contributes;
      const declared = (contributions.worktableTemplates ?? []).map((value) => ({ ...structuredClone(value), pluginId: id }));
      const declaredIds = new Set(declared.map((value) => value.id));
      const compatible = (contributions.workbenches ?? [])
        .filter((value) => !declaredIds.has(value.id))
        .map((value) => legacyWorkbenchTemplate(id, value));
      return [...declared, ...compatible];
    });
  }

  workbenchBlueprints(): WorkbenchBlueprintV1[] {
    return [...this.#processes.keys()].flatMap((id) => (this.require(id).manifest.contributes.workbenchBlueprints ?? [])
      .map((blueprint) => ({ ...structuredClone(blueprint), pluginId: id })));
  }

  workflows(id?: string): Array<{ pluginId: string; definition: PluginWorkflowDefinition }> {
    const entries: Array<{ pluginId: string; definition: PluginWorkflowDefinition }> = [];
    for (const [pluginId, description] of this.#descriptions) {
      if (id && pluginId !== id) continue;
      for (const definition of description.workflows ?? []) entries.push({ pluginId, definition: structuredClone(definition) });
    }
    return entries;
  }

  workflow(pluginId: string, workflowId: string): PluginWorkflowDefinition {
    const definition = this.#descriptions.get(pluginId)?.workflows?.find((candidate) => candidate.id === workflowId);
    if (!definition) throw new Error(`插件工作流不存在：${pluginId}/${workflowId}`);
    return structuredClone(definition);
  }

  toolDefinition(pluginId: string, name: string) {
    const definition = this.#descriptions.get(pluginId)?.tools.find((candidate) => candidate.name === name);
    if (!definition) throw new Error(`插件工具不存在：${pluginId}/${name}`);
    return structuredClone(definition);
  }

  async executePanelTool(
    pluginId: string,
    name: string,
    input: Record<string, JsonValue>,
    context: { projectId: string; sessionId: string; agentId: string; traceId: string },
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const plugin = this.require(pluginId);
    const process = this.#processes.get(pluginId);
    if (!plugin.enabled || !process) throw new Error(`插件未启用：${pluginId}`);
    const definition = this.toolDefinition(pluginId, name);
    return await process.execute(name, input, { ...context, capabilities: this.hostCapabilities(plugin.manifest, false) }, signal, toolTimeout(definition));
  }

  async executeWorkflow(
    pluginId: string,
    workflowId: string,
    input: Record<string, JsonValue>,
    context: { projectId: string; sessionId: string; agentId?: string; traceId?: string; capabilities: PluginManifest['permissions']; worktableInstanceId?: string },
    jobId: string,
    resume: boolean,
    signal?: AbortSignal,
  ): Promise<PluginWorkflowResult> {
    const plugin = this.require(pluginId);
    if (!plugin.enabled || !this.#processes.has(pluginId)) throw new Error(`插件未启用：${pluginId}`);
    const definition = this.workflow(pluginId, workflowId);
    const validate = this.#ajv.compile(definition.inputSchema as object);
    if (!validate(input)) throw new Error(`插件工作流输入不合法：${this.#ajv.errorsText(validate.errors, { separator: '; ' })}`);
    // Long-lived workflows use a dedicated restricted process. Cancelling or
    // crashing one workflow therefore cannot disable the plugin's normal tool
    // process or unrelated workflow jobs.
    const process = this.createProcess(plugin.manifest, plugin.root, this.settingsForProcess(plugin));
    try {
      const description = await process.start(signal);
      this.validateDescription(plugin.manifest, description);
      if (!description.workflows.some((candidate) => candidate.id === workflowId)) throw new Error(`插件工作流不存在：${workflowId}`);
      return await process.runWorkflow(workflowId, input, context, jobId, resume, signal);
    } finally {
      await process.stop().catch(() => undefined);
    }
  }

  versionOf(id: string): string | undefined {
    return this.#plugins.find((plugin) => plugin.manifest.id === id)?.manifest.version;
  }

  settings(id: string): JsonValue {
    this.require(id);
    return structuredClone(this.#settings[id] ?? {});
  }

  async updateSettings(id: string, value: JsonValue): Promise<JsonValue> {
    const plugin = this.require(id);
    const schema = plugin.manifest.contributes.settingsSchema;
    if (!schema) throw new Error(`插件未声明设置 schema：${id}`);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('插件设置必须是 JSON 对象');
    const validate = this.#ajv.compile(schema as object);
    if (!validate(value)) throw new Error(`插件设置不合法：${this.#ajv.errorsText(validate.errors, { separator: '; ' })}`);
    const previous = this.#settings[id];
    this.#settings[id] = structuredClone(value);
    this.persistSettings();
    if (this.#processes.has(id)) {
      try { await this.reload(id); }
      catch (error) {
        if (previous === undefined) delete this.#settings[id];
        else this.#settings[id] = previous;
        this.persistSettings();
        throw error;
      }
    }
    return structuredClone(value);
  }

  agentPresets(): AgentPreset[] {
    const presets: AgentPreset[] = [];
    for (const [id, description] of this.#descriptions) {
      const localTools = new Set(description.tools.map((tool) => tool.name));
      for (const preset of description.agentPresets) presets.push({
        ...structuredClone(preset),
        toolNames: preset.toolNames.map((name) => localTools.has(name) ? namespacedToolName('plugin', id, name) : name),
      });
    }
    return presets;
  }

  agentTemplates(): AgentTemplate[] {
    const templates: AgentTemplate[] = [];
    for (const [id, description] of this.#descriptions) {
      for (const template of description.agentTemplates ?? []) templates.push({
        ...structuredClone(template), source: 'plugin', sourceId: id,
      });
      const localTools = new Set(description.tools.map((tool) => tool.name));
      for (const preset of description.agentPresets) {
        const toolSummary = preset.toolNames.filter((name) => localTools.has(name)).join(', ');
        templates.push({
          id: preset.id as `${string}:${string}`,
          name: preset.name,
          summary: toolSummary ? `由已启用插件贡献；建议工具：${toolSummary}` : '由已启用插件贡献；选择后仍需用户确认创建持久 Agent。',
          avatar: 'sage',
          identity: `# {{agentName}}\n\n{{agentName}} 是基于插件模板「${preset.name}」创建的科研 Agent。`,
          instructions: preset.instructions,
          source: 'plugin',
          sourceId: id,
        });
      }
    }
    return templates;
  }

  researchObjectTypes(): string[] {
    return [...this.#processes.keys()].flatMap((id) => this.require(id).manifest.contributes.researchObjectTypes ?? []);
  }

  researchRelationTypes(): string[] {
    return [...this.#processes.keys()].flatMap((id) => this.require(id).manifest.contributes.researchRelationTypes ?? []);
  }

  researchObjectSchemas() {
    return [...this.#processes.keys()].flatMap((id) => structuredClone(this.require(id).manifest.contributes.researchObjectSchemas ?? []));
  }

  validateResearchObject(pluginId: string, type: string, attributes: JsonValue): void {
    const plugin = this.require(pluginId);
    const contribution = plugin.manifest.contributes.researchObjectSchemas?.find((candidate) => candidate.type === type);
    if (!contribution || !type.startsWith(`${pluginId}:`)) throw new Error(`插件未声明科研对象类型：${type}`);
    const validate = this.#ajv.compile(contribution.attributesSchema as object);
    if (!validate(attributes)) throw new Error(`科研对象属性不符合插件 schema：${this.#ajv.errorsText(validate.errors, { separator: '; ' })}`);
  }

  validateResearchRelation(pluginId: string, predicate: string): void {
    const plugin = this.require(pluginId);
    if (!predicate.startsWith(`${pluginId}:`) || !(plugin.manifest.contributes.researchRelationTypes ?? []).includes(predicate)) throw new Error(`插件未声明科研关系类型：${predicate}`);
  }

  async activateEnabled(): Promise<void> {
    for (const plugin of this.#plugins.filter((item) => item.enabled)) {
      await this.activate(plugin.manifest.id).catch((error) => {
        plugin.error = error instanceof Error ? error.message : String(error);
      });
    }
  }

  async activate(id: string): Promise<void> {
    const plugin = this.require(id);
    if (plugin.integrity === 'mismatch') throw new Error(`插件完整性校验失败，请检查来源后显式热重载：${id}`);
    if (this.#processes.has(id)) return;
    const currentHash = hashDirectory(plugin.root);
    const currentManifest = readPluginManifest(plugin.root);
    if (currentHash !== plugin.sha256 || JSON.stringify(currentManifest) !== JSON.stringify(plugin.manifest)) {
      this.refresh();
      throw new Error(`插件在预检后发生变化，需要重新检查并确认：${id}`);
    }
    const process = this.createProcess(plugin.manifest, plugin.root, this.settingsForProcess(plugin));
    const description = await process.start();
    let disposers: Array<() => void> = [];
    try {
      this.validateDescription(plugin.manifest, description);
      if (plugin.integrity === 'unlocked') {
        plugin.sha256 = currentHash;
        plugin.integrity = 'verified';
        this.setLock(plugin.scope, id, plugin.sha256);
      }
      disposers = this.registerProcessTools(id, process, description);
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose();
      await process.stop();
      throw error;
    }
    this.#processes.set(id, process);
    this.#descriptions.set(id, description);
    this.#toolDisposers.set(id, disposers);
    process.setCrashHandler((error) => this.handleProcessCrash(id, process, error));
    plugin.enabled = true;
    delete plugin.error;
    this.#enabled[id] = true;
    this.persistState();
  }

  async deactivate(id: string): Promise<void> {
    for (const dispose of this.#toolDisposers.get(id)?.reverse() ?? []) dispose();
    this.#toolDisposers.delete(id);
    await this.#processes.get(id)?.stop();
    this.#processes.delete(id);
    this.#descriptions.delete(id);
    const plugin = this.#plugins.find((item) => item.manifest.id === id);
    if (plugin) plugin.enabled = false;
    this.#enabled[id] = false;
    this.persistState();
  }

  async collectContext(sessionId: string, agentId: string, signal?: AbortSignal): Promise<ContextContribution[]> {
    const contributions: ContextContribution[] = [];
    for (const process of this.#processes.values()) {
      const values = await process.collectContext({
        projectId: this.#projectId, sessionId, agentId,
        capabilities: this.hostCapabilities(process.manifest, true),
      }, signal).catch(() => []);
      for (const value of values) contributions.push({ ...value, trust: 'untrusted', category: 'plugin' });
    }
    return contributions;
  }

  inspectSource(sourcePath: string): PluginSourceInspection {
    const source = resolve(sourcePath);
    if (!existsSync(source)) throw new Error(`插件来源不存在：${sourcePath}`);
    if (statSync(source).isDirectory()) {
      collectPluginFiles(source, false);
      return { manifest: readPluginManifest(source), sha256: hashDirectory(source), sourceType: 'directory', package: inspectPluginPackage(source) };
    }
    if (!source.toLocaleLowerCase().endsWith('.zip')) throw new Error('插件仅支持目录或 ZIP 压缩包');
    const temporary = mkdtempSync(join(tmpdir(), 'openlab-plugin-inspect-'));
    try {
      const zip = new AdmZip(source);
      validateZipEntries(zip, temporary);
      zip.extractAllTo(temporary, false);
      collectPluginFiles(temporary, false);
      let manifestRoot = temporary;
      if (!existsSync(join(manifestRoot, 'manifest.json'))) {
        const children = readdirSync(temporary, { withFileTypes: true }).filter((entry) => entry.isDirectory());
        if (children.length === 1 && children[0]) manifestRoot = join(temporary, children[0].name);
      }
      return {
        manifest: readPluginManifest(manifestRoot),
        sha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
        sourceType: 'zip',
        package: inspectPluginPackage(manifestRoot),
      };
    } finally {
      removePluginTree(temporary);
    }
  }

  async reload(id: string): Promise<void> {
    const plugin = this.require(id);
    const oldProcess = this.#processes.get(id);
    const oldDescription = this.#descriptions.get(id);
    const manifest = readPluginManifest(plugin.root);
    const candidate = this.createProcess(manifest, plugin.root, this.settingsForProcess(plugin));
    let candidateDescription: PluginDescription;
    try {
      candidateDescription = await candidate.start();
      this.validateDescription(manifest, candidateDescription);
    } catch (error) {
      await candidate.stop().catch(() => undefined);
      throw error;
    }

    if (!oldProcess || !oldDescription) {
      let candidateDisposers: Array<() => void> = [];
      try {
        candidateDisposers = this.registerProcessTools(id, candidate, candidateDescription, manifest);
      } catch (error) {
        for (const dispose of candidateDisposers.reverse()) dispose();
        await candidate.stop();
        throw error;
      }
      this.#processes.set(id, candidate);
      this.#descriptions.set(id, candidateDescription);
      this.#toolDisposers.set(id, candidateDisposers);
      candidate.setCrashHandler((error) => this.handleProcessCrash(id, candidate, error));
      plugin.manifest = manifest;
      plugin.sha256 = hashDirectory(plugin.root);
      plugin.integrity = 'verified';
      plugin.enabled = true;
      delete plugin.error;
      this.#enabled[id] = true;
      this.persistState();
      this.setLock(plugin.scope, id, plugin.sha256);
      return;
    }

    const oldDisposers = this.#toolDisposers.get(id) ?? [];
    for (const dispose of [...oldDisposers].reverse()) dispose();
    let candidateDisposers: Array<() => void> = [];
    try {
      candidateDisposers = this.registerProcessTools(id, candidate, candidateDescription, manifest);
    } catch (error) {
      for (const dispose of candidateDisposers.reverse()) dispose();
      const restored = this.registerProcessTools(id, oldProcess, oldDescription);
      this.#toolDisposers.set(id, restored);
      await candidate.stop();
      throw error;
    }

    this.#processes.set(id, candidate);
    this.#descriptions.set(id, candidateDescription);
    this.#toolDisposers.set(id, candidateDisposers);
    candidate.setCrashHandler((error) => this.handleProcessCrash(id, candidate, error));
    plugin.manifest = manifest;
    plugin.sha256 = hashDirectory(plugin.root);
    plugin.integrity = 'verified';
    this.setLock(plugin.scope, id, plugin.sha256);
    delete plugin.error;
    await oldProcess.stop();
  }

  readUiPanel(id: string, panelId: string): string {
    const plugin = this.require(id);
    if (!plugin.enabled) throw new Error(`插件尚未启用：${id}`);
    if (!plugin.manifest.permissions.includes('ui')) throw new Error(`插件未获 UI 权限：${id}`);
    const panel = plugin.manifest.contributes.uiPanels?.find((candidate) => candidate.id === panelId);
    if (!panel) throw new Error(`插件面板不存在：${panelId}`);
    const entry = resolve(plugin.root, panel.entry);
    if (!isWithin(plugin.root, entry) || !existsSync(entry) || !statSync(entry).isFile() || !isWithin(realpathSync(plugin.root), realpathSync(entry))) throw new Error('插件面板入口无效');
    const source = readFileSync(entry, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > 1_000_000) throw new Error('插件面板 HTML 超过 1 MB 限制');
    const policy = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; media-src data:; form-action 'none'; base-uri 'none'";
    const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
    return /<head(?:\s[^>]*)?>/iu.test(source) ? source.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${meta}`) : `${meta}${source}`;
  }

  async install(sourcePath: string, scope: 'user' | 'project', signal?: AbortSignal): Promise<InstalledPlugin> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const targetRoot = scope === 'user' ? this.#userRoot : this.#projectRoot;
    const source = resolve(sourcePath);
    const staging = join(targetRoot, `.install-${Date.now()}-${basename(source).replace(/[^a-zA-Z0-9._-]/gu, '-')}`);
    try {
      if (!existsSync(source)) throw new Error(`插件来源不存在：${sourcePath}`);
      if (statSync(source).isDirectory()) {
        collectPluginFiles(source, false);
        cpSync(source, staging, { recursive: true, errorOnExist: true });
      }
      else if (source.toLocaleLowerCase().endsWith('.zip')) {
        const zip = new AdmZip(source);
        mkdirSync(staging, { recursive: true });
        validateZipEntries(zip, staging);
        zip.extractAllTo(staging, false);
        collectPluginFiles(staging, false);
      } else throw new Error('插件仅支持目录或 ZIP 压缩包');
      let manifestRoot = staging;
      if (!existsSync(join(manifestRoot, 'manifest.json'))) {
        const children = readdirSync(staging, { withFileTypes: true }).filter((entry) => entry.isDirectory());
        if (children.length === 1 && children[0]) manifestRoot = join(staging, children[0].name);
      }
      const manifest = readPluginManifest(manifestRoot);
      await preparePluginDependencies(manifestRoot, 'production', signal, { cacheRoot: this.#dependencyCache });
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const destination = join(targetRoot, manifest.id);
      const otherScope = this.#plugins.find((plugin) => plugin.manifest.id === manifest.id && plugin.scope !== scope);
      if (otherScope) throw new Error(`插件 ${manifest.id} 已安装在 ${otherScope.scope} 作用域；请先卸载后再切换作用域`);
      const stagedPlugin: InstalledPlugin = {
        manifest, root: manifestRoot, scope, enabled: false, trusted: false,
        sha256: hashDirectory(manifestRoot), integrity: 'verified',
      };
      const healthProcess = this.createProcess(manifest, manifestRoot, this.settingsForProcess(stagedPlugin));
      try {
        const description = await healthProcess.start(signal);
        this.validateDescription(manifest, description);
      } finally {
        await healthProcess.stop().catch(() => undefined);
      }

      const backup = join(targetRoot, `.rollback-${manifest.id}-${Date.now()}`);
      const hadPrevious = existsSync(destination);
      const previousEnabled = this.#enabled[manifest.id] ?? false;
      const previousLock = (scope === 'user' ? this.#userLocks : this.#projectLocks)[manifest.id];
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (hadPrevious && this.#processes.has(manifest.id)) await this.deactivate(manifest.id);
      try {
        if (hadPrevious) renameSync(destination, backup);
        cpSync(manifestRoot, destination, { recursive: true, errorOnExist: true });
        this.setLock(scope, manifest.id, hashDirectory(destination));
        this.refresh();
        await this.activate(manifest.id);
        if (hadPrevious && existsSync(backup) && isWithin(targetRoot, backup)) removePluginTree(backup);
      } catch (error) {
        await this.deactivate(manifest.id).catch(() => undefined);
        if (existsSync(destination) && isWithin(targetRoot, destination)) removePluginTree(destination);
        if (hadPrevious && existsSync(backup) && isWithin(targetRoot, backup)) renameSync(backup, destination);
        if (hadPrevious) {
          if (previousLock === undefined) this.deleteLock(scope, manifest.id);
          else this.setLock(scope, manifest.id, previousLock);
          this.refresh();
          this.#enabled[manifest.id] = previousEnabled;
          this.persistState();
          if (previousEnabled) await this.activate(manifest.id).catch(() => undefined);
        } else {
          delete this.#enabled[manifest.id];
          this.deleteLock(scope, manifest.id);
          this.persistState();
          this.refresh();
        }
        throw error;
      }
      removePluginTree(staging);
      this.refresh();
      return this.require(manifest.id);
    } catch (error) {
      if (existsSync(staging) && isWithin(targetRoot, staging)) removePluginTree(staging);
      throw error;
    }
  }

  async uninstall(id: string): Promise<void> {
    const plugin = this.require(id);
    await this.deactivate(id);
    const allowedRoot = plugin.scope === 'user' ? this.#userRoot : this.#projectRoot;
    if (!isWithin(allowedRoot, plugin.root) || resolve(plugin.root) === resolve(allowedRoot)) throw new Error('拒绝删除未验证的插件路径');
    removePluginTree(plugin.root);
    delete this.#enabled[id];
    delete this.#settings[id];
    this.deleteLock(plugin.scope, id);
    this.persistState();
    this.persistSettings();
    this.refresh();
  }

  export(id: string, destination: string): void {
    const plugin = this.require(id);
    if (!destination.toLocaleLowerCase().endsWith('.zip')) throw new Error('插件导出目标必须是 ZIP 文件');
    const zip = new AdmZip();
    for (const file of collectPluginFiles(plugin.root, true)) {
      if (file.relative.split('/').includes('node_modules')) continue;
      zip.addFile(`${plugin.manifest.id}/${file.relative}`, readFileSync(file.path));
    }
    zip.writeZip(resolve(destination));
  }

  async stop(): Promise<void> {
    const stopping: Promise<void>[] = [];
    for (const id of [...this.#processes.keys()]) {
      for (const dispose of this.#toolDisposers.get(id)?.reverse() ?? []) dispose();
      this.#toolDisposers.delete(id);
      const process = this.#processes.get(id);
      if (process) stopping.push(process.stop());
      this.#processes.delete(id);
      this.#descriptions.delete(id);
    }
    await Promise.allSettled(stopping);
  }

  private require(id: string): InstalledPlugin {
    const plugin = this.#plugins.find((item) => item.manifest.id === id);
    if (!plugin) throw new Error(`插件不存在：${id}`);
    return plugin;
  }

  private validateDescription(manifest: PluginManifest, description: PluginDescription): void {
    validatePluginDescription(manifest, description);
  }

  private registerProcessTools(id: string, process: PluginProcess, description: PluginDescription, manifest: PluginManifest = this.require(id).manifest): Array<() => void> {
    const disposers: Array<() => void> = [];
    try {
      for (const definition of description.tools) {
        const toolName = namespacedToolName('plugin', id, definition.name);
        const card = manifest.contributes.toolCards?.find((candidate) => candidate.tool === definition.name);
        disposers.push(this.#registry.register({
          definition: { ...definition, name: toolName, renderHint: (card?.renderHint ?? definition.renderHint) as ToolRenderHint, source: 'plugin', sourceId: id },
          execute: async (input, context) => await process.execute(definition.name, input, {
            projectId: this.#projectId, sessionId: context.sessionId, agentId: context.agentId, traceId: context.traceId,
            capabilities: this.hostCapabilities(manifest, false),
          }, context.signal, toolTimeout(definition)),
        }));
      }
      return disposers;
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose();
      throw error;
    }
  }

  private handleProcessCrash(id: string, process: PluginProcess, error: Error): void {
    if (this.#processes.get(id) !== process) return;
    for (const dispose of this.#toolDisposers.get(id)?.reverse() ?? []) dispose();
    this.#toolDisposers.delete(id);
    this.#processes.delete(id);
    this.#descriptions.delete(id);
    const plugin = this.#plugins.find((item) => item.manifest.id === id);
    if (plugin) {
      plugin.enabled = false;
      plugin.error = error.message;
    }
    this.#enabled[id] = false;
    this.persistState();
  }

  private createProcess(manifest: PluginManifest, root: string, settings: Record<string, JsonValue>): PluginProcess {
    return new PluginProcess({
      manifest, root, projectRoot: this.#projectPath, settings,
      ...(this.#hostHandler ? { hostHandler: this.#hostHandler } : {}),
    });
  }

  private hostCapabilities(manifest: PluginManifest, contextOnly: boolean): PluginManifest['permissions'] {
    if ((manifest.apiVersion ?? 1) === 1) return [];
    const allowed = new Set<PluginManifest['permissions'][number]>(contextOnly
      ? ['workspace:read', 'resources:read', 'documents:read', 'annotations:read', 'evidence:read', 'research:read', 'plugin-storage', 'worktable:read', 'workbench:read', 'browser:observe']
      : ['workspace:read', 'workspace:edit', 'resources:read', 'documents:read', 'jobs:run', 'models:run', 'models:invoke', 'annotations:read', 'annotations:write', 'evidence:read', 'evidence:write', 'artifacts:write', 'artifacts:publish', 'research:read', 'research:write', 'plugin-storage', 'ui', 'worktable:read', 'worktable:write', 'workbench:read', 'workbench:write', 'workbench:mount', 'workbench:propose-layout', 'browser:observe', 'browser:interact', 'generated-apps:publish', 'generated-apps:build', 'toolchains:execute']);
    return manifest.permissions.filter((permission) => allowed.has(permission));
  }

  private scan(root: string, scope: 'user' | 'project', output: InstalledPlugin[]): void {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const pluginRoot = join(root, entry.name);
      if (!existsSync(join(pluginRoot, 'manifest.json'))) continue;
      try {
        const manifest = readPluginManifest(pluginRoot);
        const sha256 = hashDirectory(pluginRoot);
        const expected = (scope === 'user' ? this.#userLocks : this.#projectLocks)[manifest.id];
        const integrity = expected === undefined ? 'unlocked' : expected === sha256 ? 'verified' : 'mismatch';
        output.push({
          manifest, root: pluginRoot, scope,
          enabled: integrity === 'verified' && this.#enabled[manifest.id] === true,
          trusted: false, sha256, integrity,
          ...(integrity === 'mismatch' ? { error: 'SHA-256 与安装锁不一致' } : {}),
        });
      } catch { /* invalid plugins remain inactive and are reported during explicit import */ }
    }
  }

  private persistState(): void {
    atomicWriteJson(this.#statePath, this.#enabled as Record<string, JsonValue>);
  }

  private persistSettings(): void {
    atomicWriteJson(this.#settingsPath, this.#settings);
  }

  private settingsForProcess(plugin: InstalledPlugin): Record<string, JsonValue> {
    if (!plugin.manifest.permissions.includes('settings:read')) return {};
    const value = this.#settings[plugin.manifest.id];
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? structuredClone(value) as Record<string, JsonValue> : {};
  }

  private setLock(scope: 'user' | 'project', id: string, sha256: string): void {
    if (scope === 'user') this.#userLocks[id] = sha256;
    else this.#projectLocks[id] = sha256;
    this.persistLocks(scope);
  }

  private deleteLock(scope: 'user' | 'project', id: string): void {
    if (scope === 'user') delete this.#userLocks[id];
    else delete this.#projectLocks[id];
    this.persistLocks(scope);
  }

  private persistLocks(scope: 'user' | 'project'): void {
    if (scope === 'user') atomicWriteJson(this.#userLocksPath, this.#userLocks);
    else {
      atomicWriteJson(this.#projectLocksPath, this.#projectLocks);
      atomicWriteJson(this.#projectLocksProjectionPath, this.#projectLocks);
    }
  }
}
