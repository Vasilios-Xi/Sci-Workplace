import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import AjvModule, { type ValidateFunction } from 'ajv';
import type { PluginManifest, ToolchainAdapterManifestV1, WorkbenchBlueprintV1, WorktableTemplateContribution } from '@openlab/protocol';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/u;
const LOCAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const OPENLAB_VERSION = [0, 1, 0] as const;

interface AjvInstance {
  compile(schema: object): ValidateFunction;
}

const AjvConstructor = AjvModule as unknown as new (options?: object) => AjvInstance;
const schemaValidator = new AjvConstructor({ allErrors: true, strict: false });

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function supportsCurrentEngine(range: string): boolean {
  if (range.trim() === '*') return true;
  const versions = [...range.matchAll(/(\d+)\.(\d+)\.(\d+)/gu)].map((match) => [Number(match[1]), Number(match[2]), Number(match[3])] as const);
  if (versions.length === 0) return false;
  const trimmed = range.trim();
  if (VERSION_PATTERN.test(trimmed)) return compareVersion(OPENLAB_VERSION, versions[0]!) === 0;
  if (trimmed.startsWith('^')) {
    const minimum = versions[0]!;
    return minimum[0] === 0 && minimum[1] === OPENLAB_VERSION[1] && compareVersion(OPENLAB_VERSION, minimum) >= 0;
  }
  if (trimmed.startsWith('~')) {
    const minimum = versions[0]!;
    return minimum[0] === OPENLAB_VERSION[0] && minimum[1] === OPENLAB_VERSION[1] && compareVersion(OPENLAB_VERSION, minimum) >= 0;
  }
  const minimumMatch = range.match(/>=\s*(\d+)\.(\d+)\.(\d+)/u);
  const maximumMatch = range.match(/<\s*(\d+)\.(\d+)\.(\d+)/u);
  const minimum = minimumMatch ? minimumMatch.slice(1).map(Number) : undefined;
  const maximum = maximumMatch ? maximumMatch.slice(1).map(Number) : undefined;
  return (!minimum || compareVersion(OPENLAB_VERSION, minimum) >= 0) && (!maximum || compareVersion(OPENLAB_VERSION, maximum) < 0);
}

function validateStringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${label} 必须是非空字符串数组`);
  if (new Set(value).size !== value.length) throw new Error(`${label} 包含重复项`);
  return value as string[];
}

function containsSecretSetting(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const record = schema as Record<string, unknown>;
  if (record.format === 'password' || record.format === 'secret' || record['x-secret'] === true) return true;
  return Object.values(record).some((value) => containsSecretSetting(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateDocumentRevision(value: unknown, label: string): void {
  if (!isRecord(value) || !isRecord(value.ref) || !isNonEmptyString(value.ref.rootId) || !isNonEmptyString(value.ref.path)) throw new Error(`${label} 的文档引用无效`);
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new Error(`${label} 的文档 SHA-256 无效`);
  if (value.mediaType !== undefined && !isNonEmptyString(value.mediaType)) throw new Error(`${label} 的文档媒体类型无效`);
}

function validateWorktableContent(value: unknown, label: string, pluginId: string, panelIds: ReadonlySet<string>): void {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) throw new Error(`${label} 的内容无效`);
  if (value.kind === 'builtin') {
    if (!['explorer', 'terminal', 'browser', 'scm', 'tasks', 'control-room'].includes(String(value.type))) throw new Error(`${label} 的内置窗格类型无效`);
    return;
  }
  if (value.kind === 'plugin-panel') {
    if (value.pluginId !== pluginId || !isNonEmptyString(value.panelId) || !panelIds.has(value.panelId)) throw new Error(`${label} 只能引用本插件 uiPanel`);
    return;
  }
  if (value.kind === 'document') {
    validateDocumentRevision(value.target, label);
    return;
  }
  if (value.kind === 'artifact') {
    if (!isNonEmptyString(value.artifactId)) throw new Error(`${label} 的 Artifact ID 无效`);
    if (value.revisionId !== undefined && !isNonEmptyString(value.revisionId)) throw new Error(`${label} 的 Artifact revision 无效`);
    if (value.role !== undefined && !['source', 'data', 'environment', 'output', 'log', 'mapping'].includes(String(value.role))) throw new Error(`${label} 的 Artifact role 无效`);
    return;
  }
  if (value.kind === 'generated-app') {
    if (!isNonEmptyString(value.appId) || !isNonEmptyString(value.revisionId)) throw new Error(`${label} 的生成应用引用无效`);
    return;
  }
  throw new Error(`${label} 的内容类型无效`);
}

function validateWorktableTemplates(value: unknown, pluginId: string, panelIds: ReadonlySet<string>): WorktableTemplateContribution[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('worktableTemplates 必须是最多 16 项的数组');
  const templateIds = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate) || !isNonEmptyString(candidate.id) || !candidate.id.startsWith(`${pluginId}:`) || !LOCAL_ID_PATTERN.test(candidate.id.slice(pluginId.length + 1)) || templateIds.has(candidate.id)) throw new Error('工作台模板 ID 必须唯一并使用插件命名空间');
    templateIds.add(candidate.id);
    if (!isNonEmptyString(candidate.version) || !VERSION_PATTERN.test(candidate.version)) throw new Error(`工作台模板 version 必须是语义化版本：${candidate.id}`);
    if (!isNonEmptyString(candidate.title)) throw new Error(`工作台模板标题不能为空：${candidate.id}`);
    if (candidate.description !== undefined && typeof candidate.description !== 'string') throw new Error(`工作台模板说明无效：${candidate.id}`);
    if (candidate.icon !== undefined && !isNonEmptyString(candidate.icon)) throw new Error(`工作台模板图标无效：${candidate.id}`);
    if (candidate.pluginId !== undefined && candidate.pluginId !== pluginId) throw new Error(`工作台模板不得伪造 pluginId：${candidate.id}`);
    if (candidate.kind !== undefined && candidate.kind !== 'research' && candidate.kind !== 'generated') throw new Error(`工作台模板 kind 无效：${candidate.id}`);
    if (!isRecord(candidate.inputSchema) || candidate.inputSchema.type !== 'object') throw new Error(`工作台模板 inputSchema 必须描述 JSON 对象：${candidate.id}`);
    try {
      schemaValidator.compile(candidate.inputSchema);
    } catch (error) {
      throw new Error(`工作台模板 inputSchema 无效：${candidate.id}：${error instanceof Error ? error.message : String(error)}`);
    }
    if (candidate.inputUi !== undefined) {
      if (!isRecord(candidate.inputUi) || !Array.isArray(candidate.inputUi.controls) || candidate.inputUi.controls.length > 20) throw new Error(`工作台模板 inputUi 无效：${candidate.id}`);
      if (candidate.inputUi.allowDefer !== undefined && typeof candidate.inputUi.allowDefer !== 'boolean') throw new Error(`工作台模板 inputUi.allowDefer 无效：${candidate.id}`);
      const fields = new Set<string>();
      for (const control of candidate.inputUi.controls) {
        if (!isRecord(control) || !['file', 'text', 'select'].includes(String(control.kind)) || !isNonEmptyString(control.field) || fields.has(control.field) || !isNonEmptyString(control.label)) throw new Error(`工作台模板 inputUi 控件无效：${candidate.id}`);
        fields.add(control.field);
        if (!isRecord(candidate.inputSchema.properties) || !(control.field in candidate.inputSchema.properties)) throw new Error(`工作台模板 inputUi 字段不在 inputSchema 中：${candidate.id}/${control.field}`);
        if (control.required !== undefined && typeof control.required !== 'boolean') throw new Error(`工作台模板 inputUi.required 无效：${candidate.id}/${control.field}`);
        if (control.kind === 'file') {
          if (control.multiple !== undefined && typeof control.multiple !== 'boolean') throw new Error(`工作台模板 inputUi.multiple 无效：${candidate.id}/${control.field}`);
          if (control.accept !== undefined && (!Array.isArray(control.accept) || control.accept.some((item) => !isNonEmptyString(item)))) throw new Error(`工作台模板 inputUi.accept 无效：${candidate.id}/${control.field}`);
        }
        if (control.kind === 'select' && (!Array.isArray(control.options) || control.options.length === 0 || control.options.some((option) => !isRecord(option) || !isNonEmptyString(option.label) || !('value' in option)))) throw new Error(`工作台模板 inputUi.options 无效：${candidate.id}/${control.field}`);
      }
    }
    if (!Array.isArray(candidate.panes) || candidate.panes.length === 0 || candidate.panes.length > 6) throw new Error(`工作台模板必须包含 1–6 个窗格：${candidate.id}`);

    const paneIds = new Set<string>();
    const tabIds = new Set<string>();
    let tabCount = 0;
    for (const [paneIndex, paneCandidate] of candidate.panes.entries()) {
      if (!isRecord(paneCandidate) || !isNonEmptyString(paneCandidate.id) || !LOCAL_ID_PATTERN.test(paneCandidate.id) || paneIds.has(paneCandidate.id)) throw new Error(`工作台模板窗格 ID 无效：${candidate.id}/${paneIndex}`);
      paneIds.add(paneCandidate.id);
      if (paneCandidate.title !== undefined && typeof paneCandidate.title !== 'string') throw new Error(`工作台模板窗格标题无效：${candidate.id}/${paneCandidate.id}`);
      if (!Array.isArray(paneCandidate.tabs) || paneCandidate.tabs.length === 0) throw new Error(`工作台模板窗格至少需要一个标签：${candidate.id}/${paneCandidate.id}`);
      tabCount += paneCandidate.tabs.length;
      if (tabCount > 20) throw new Error(`工作台模板标签总数不得超过 20：${candidate.id}`);
      const paneTabIds = new Set<string>();
      for (const [tabIndex, tabCandidate] of paneCandidate.tabs.entries()) {
        if (!isRecord(tabCandidate) || !isNonEmptyString(tabCandidate.id) || !LOCAL_ID_PATTERN.test(tabCandidate.id) || tabIds.has(tabCandidate.id)) throw new Error(`工作台模板标签 ID 无效：${candidate.id}/${paneCandidate.id}/${tabIndex}`);
        tabIds.add(tabCandidate.id);
        paneTabIds.add(tabCandidate.id);
        if (!isNonEmptyString(tabCandidate.title)) throw new Error(`工作台模板标签标题不能为空：${candidate.id}/${tabCandidate.id}`);
        if (tabCandidate.pinned !== undefined && typeof tabCandidate.pinned !== 'boolean') throw new Error(`工作台模板标签 pinned 无效：${candidate.id}/${tabCandidate.id}`);
        if (!isNonEmptyString(tabCandidate.openedAt) || !Number.isFinite(Date.parse(tabCandidate.openedAt))) throw new Error(`工作台模板标签 openedAt 无效：${candidate.id}/${tabCandidate.id}`);
        validateWorktableContent(tabCandidate.content, `工作台模板标签 ${candidate.id}/${tabCandidate.id}`, pluginId, panelIds);
      }
      if (paneCandidate.activeTabId !== undefined && (!isNonEmptyString(paneCandidate.activeTabId) || !paneTabIds.has(paneCandidate.activeTabId))) throw new Error(`工作台模板活动标签未引用本窗格标签：${candidate.id}/${paneCandidate.id}`);
    }

    const layoutPaneIds = new Set<string>();
    const visitLayout = (node: unknown, depth: number): void => {
      if (!isRecord(node) || depth > 12) throw new Error(`工作台模板布局树无效：${candidate.id}`);
      if (node.kind === 'pane') {
        if (!isNonEmptyString(node.paneId) || !paneIds.has(node.paneId) || layoutPaneIds.has(node.paneId)) throw new Error(`工作台模板布局窗格引用无效或重复：${candidate.id}`);
        layoutPaneIds.add(node.paneId);
        return;
      }
      if (node.kind !== 'split' || !['horizontal', 'vertical'].includes(String(node.direction)) || typeof node.ratio !== 'number' || !Number.isFinite(node.ratio) || node.ratio < 0.1 || node.ratio > 0.9) throw new Error(`工作台模板分割节点无效：${candidate.id}`);
      visitLayout(node.first, depth + 1);
      visitLayout(node.second, depth + 1);
    };
    visitLayout(candidate.layout, 0);
    if (layoutPaneIds.size !== paneIds.size) throw new Error(`工作台模板布局必须引用全部窗格且只能引用一次：${candidate.id}`);
    const commands = validateStringList(candidate.commands, `worktableTemplates.${candidate.id}.commands`);
    if (commands.length > 32) throw new Error(`工作台模板 commands 不得超过 32 项：${candidate.id}`);
    return structuredClone(candidate) as unknown as WorktableTemplateContribution;
  });
}

function validateWorkbenchBlueprints(value: unknown, pluginId: string, panelIds: ReadonlySet<string>): WorkbenchBlueprintV1[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('workbenchBlueprints 必须是最多 16 项的数组');
  const blueprints = value as unknown[];
  const templates = blueprints.map((candidate) => {
    if (!isRecord(candidate) || candidate.schemaVersion !== 1) throw new Error('WorkbenchBlueprint 必须声明 schemaVersion 1');
    return {
      id: candidate.id,
      version: candidate.version,
      title: candidate.title,
      description: candidate.description,
      icon: candidate.icon,
      pluginId,
      kind: candidate.kind,
      inputSchema: candidate.inputSchema,
      inputUi: candidate.inputUi,
      layout: candidate.layout,
      panes: candidate.panes,
      commands: candidate.commands,
    };
  });
  validateWorktableTemplates(templates, pluginId, panelIds);
  for (const candidate of blueprints) {
    const blueprint = candidate as Record<string, unknown>;
    const panes = new Set((blueprint.panes as Array<{ id: string }>).map((pane) => pane.id));
    if (!Array.isArray(blueprint.slots) || blueprint.slots.length === 0 || blueprint.slots.length > 32) throw new Error(`WorkbenchBlueprint slots 无效：${String(blueprint.id)}`);
    const ids = new Set<string>();
    const roles = new Set<string>();
    for (const slot of blueprint.slots) {
      if (!isRecord(slot) || !isNonEmptyString(slot.id) || ids.has(slot.id) || !LOCAL_ID_PATTERN.test(slot.id)) throw new Error(`WorkbenchBlueprint slot ID 无效：${String(blueprint.id)}`);
      ids.add(slot.id);
      if (!isNonEmptyString(slot.role) || roles.has(slot.role)) throw new Error(`WorkbenchBlueprint slot role 必须唯一：${String(blueprint.id)}`);
      roles.add(slot.role);
      if (!isNonEmptyString(slot.paneId) || !panes.has(slot.paneId) || !isNonEmptyString(slot.title)) throw new Error(`WorkbenchBlueprint slot 引用无效：${String(blueprint.id)}/${slot.id}`);
      if (!Array.isArray(slot.accepts) || slot.accepts.length === 0 || slot.accepts.some((kind) => !['builtin', 'document', 'artifact', 'plugin-panel', 'generated-app'].includes(String(kind)))) throw new Error(`WorkbenchBlueprint slot accepts 无效：${String(blueprint.id)}/${slot.id}`);
      if (typeof slot.autoMount !== 'boolean') throw new Error(`WorkbenchBlueprint slot autoMount 无效：${String(blueprint.id)}/${slot.id}`);
    }
  }
  return structuredClone(blueprints) as WorkbenchBlueprintV1[];
}

function validateToolchainAdapters(value: unknown, pluginId: string): ToolchainAdapterManifestV1[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('toolchainAdapters 必须是最多 8 项的数组');
  const ids = new Set<string>();
  for (const adapter of value) {
    if (!isRecord(adapter) || adapter.schemaVersion !== 1 || !isNonEmptyString(adapter.id) || !adapter.id.startsWith(`${pluginId}:`) || ids.has(adapter.id)) throw new Error('工具链适配器 ID 必须唯一并使用插件命名空间');
    ids.add(adapter.id);
    if (!isNonEmptyString(adapter.version) || !VERSION_PATTERN.test(adapter.version) || !isNonEmptyString(adapter.title)) throw new Error(`工具链适配器元数据无效：${adapter.id}`);
    if (!Array.isArray(adapter.platforms) || adapter.platforms.length !== 1 || adapter.platforms[0] !== 'win32') throw new Error(`v1 工具链适配器仅支持 win32：${adapter.id}`);
    validateStringList(adapter.executableNames, `toolchainAdapters.${adapter.id}.executableNames`);
    validateStringList(adapter.versionArgs, `toolchainAdapters.${adapter.id}.versionArgs`);
    if (!Array.isArray(adapter.operations) || adapter.operations.length === 0 || adapter.operations.some((operation) => !isRecord(operation) || !isNonEmptyString(operation.id) || !isNonEmptyString(operation.title) || !isRecord(operation.inputSchema) || !Array.isArray(operation.outputs) || typeof operation.requiresConfirmation !== 'boolean')) throw new Error(`工具链适配器 operations 无效：${adapter.id}`);
  }
  return structuredClone(value) as ToolchainAdapterManifestV1[];
}

export function validatePluginManifest(value: unknown, root: string): PluginManifest {
  if (typeof value !== 'object' || value === null) throw new Error('manifest.json 必须是对象');
  const manifest = value as Partial<PluginManifest>;
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2 && manifest.schemaVersion !== 3 && manifest.schemaVersion !== 4) throw new Error('仅支持 plugin manifest schemaVersion 1、2、3 或 4');
  if (manifest.schemaVersion === 2 && manifest.apiVersion !== 2) throw new Error('plugin manifest schemaVersion 2 必须声明 apiVersion 2');
  if (manifest.schemaVersion === 3 && manifest.apiVersion !== 3) throw new Error('plugin manifest schemaVersion 3 必须声明 apiVersion 3');
  if (manifest.schemaVersion === 4 && manifest.apiVersion !== 4) throw new Error('plugin manifest schemaVersion 4 必须声明 apiVersion 4');
  if (manifest.schemaVersion === 1 && manifest.apiVersion !== undefined && manifest.apiVersion !== 1) throw new Error('旧 manifest 只能使用 Plugin API v1');
  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) throw new Error('插件 ID 必须是 2–64 位小写字母、数字、点、下划线或连字符');
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('插件名称不能为空');
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) throw new Error('插件版本必须是语义化版本');
  if (typeof manifest.engine !== 'string' || !manifest.engine.trim()) throw new Error('插件必须声明 Sci Workplace engine 范围');
  if (!supportsCurrentEngine(manifest.engine)) throw new Error(`插件 engine 范围与 Sci Workplace 0.1.0 不兼容：${manifest.engine}`);
  if (typeof manifest.entry !== 'string' || !manifest.entry.trim() || isAbsolute(manifest.entry)) throw new Error('插件入口必须是相对路径');
  const entry = resolve(root, manifest.entry);
  const rel = relative(resolve(root), entry);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('插件入口越过插件目录');
  if (!existsSync(entry)) throw new Error(`插件入口不存在：${manifest.entry}`);
  const allowed = new Set([
    'project:read', 'project:write', 'process:spawn', 'network', 'settings:read', 'settings:write', 'ui',
    'workspace:read', 'workspace:edit', 'resources:read', 'jobs:run', 'annotations:read', 'annotations:write',
    'models:run', 'models:invoke', 'artifacts:write', 'research:read', 'research:write', 'plugin-storage',
    'worktable:read', 'worktable:write', 'browser:observe', 'browser:interact', 'generated-apps:publish',
    'documents:read', 'evidence:read', 'evidence:write', 'artifacts:publish',
    'workbench:read', 'workbench:write', 'workbench:mount', 'workbench:propose-layout',
    'generated-apps:build', 'toolchains:execute',
  ]);
  if (!Array.isArray(manifest.permissions) || manifest.permissions.some((permission) => !allowed.has(permission))) throw new Error('插件权限列表包含未知权限');
  if (new Set(manifest.permissions).size !== manifest.permissions.length) throw new Error('插件权限列表包含重复项');
  const v3Permissions = new Set(['worktable:read', 'worktable:write', 'browser:observe', 'browser:interact', 'generated-apps:publish']);
  if (![3, 4].includes(manifest.apiVersion ?? 0) && manifest.permissions.some((permission) => v3Permissions.has(permission))) throw new Error('旧工作台、浏览器与生成应用权限仅支持 Plugin API v3 或 v4');
  const removedV4Permissions = new Set(['worktable:read', 'worktable:write', 'generated-apps:publish']);
  if (manifest.apiVersion === 4 && manifest.permissions.some((permission) => removedV4Permissions.has(permission))) throw new Error('Plugin API v4 必须使用 workbench:* 与 generated-apps:build 权限');
  const directV4Permissions = new Set(['project:read', 'project:write', 'process:spawn', 'network', 'settings:write']);
  if (manifest.apiVersion === 4 && manifest.permissions.some((permission) => directV4Permissions.has(permission))) throw new Error('Plugin API v4 禁止直接项目文件、子进程、裸网络或设置写入权限；请使用宿主代理');
  if (manifest.apiVersion === 4 && manifest.permissions.includes('models:run')) throw new Error('Plugin API v4 必须使用 models:invoke 权限');
  const v4Permissions = new Set(['documents:read', 'evidence:read', 'evidence:write', 'artifacts:publish', 'workbench:read', 'workbench:write', 'workbench:mount', 'workbench:propose-layout', 'generated-apps:build', 'toolchains:execute']);
  if (manifest.apiVersion !== 4 && manifest.permissions.some((permission) => v4Permissions.has(permission))) throw new Error('Harness 细粒度权限仅支持 Plugin API v4');
  if (typeof manifest.contributes !== 'object' || manifest.contributes === null) throw new Error('插件必须声明 contributes 对象');
  const tools = validateStringList(manifest.contributes.tools, 'contributes.tools');
  const contextProviders = validateStringList(manifest.contributes.contextProviders, 'contributes.contextProviders');
  const templates = validateStringList(manifest.contributes.agentTemplates, 'contributes.agentTemplates');
  const presets = validateStringList(manifest.contributes.agentPresets, 'contributes.agentPresets');
  const objectTypes = validateStringList(manifest.contributes.researchObjectTypes, 'contributes.researchObjectTypes');
  const relationTypes = validateStringList(manifest.contributes.researchRelationTypes, 'contributes.researchRelationTypes');
  for (const value of [...templates, ...presets, ...objectTypes, ...relationTypes]) {
    if (!value.startsWith(`${manifest.id}:`)) throw new Error(`插件贡献必须使用插件命名空间：${value}`);
  }
  if (manifest.contributes.settingsSchema !== undefined) {
    if (!manifest.permissions.includes('settings:read')) throw new Error('声明 settingsSchema 的插件必须申请 settings:read 权限');
    if (typeof manifest.contributes.settingsSchema !== 'object' || manifest.contributes.settingsSchema === null) throw new Error('settingsSchema 必须是 JSON Schema 对象');
    if (containsSecretSetting(manifest.contributes.settingsSchema)) throw new Error('插件 settingsSchema 不得保存密钥；敏感凭据必须引用安全存储');
  }
  const cards = manifest.contributes.toolCards;
  if (cards !== undefined) {
    if (!Array.isArray(cards)) throw new Error('toolCards 必须是数组');
    const cardTools = new Set<string>();
    const renderHints = new Set(['generic', 'terminal', 'diff', 'artifact', 'form', 'agent']);
    for (const card of cards) {
      if (!card || typeof card.tool !== 'string' || !tools.includes(card.tool)) throw new Error('toolCard 必须引用 contributes.tools 中的工具');
      if (cardTools.has(card.tool)) throw new Error(`工具卡片重复：${card.tool}`);
      cardTools.add(card.tool);
      if (!renderHints.has(card.renderHint)) throw new Error(`工具卡片 renderHint 无效：${card.tool}`);
    }
  }
  const panels = manifest.contributes.uiPanels;
  if (panels !== undefined) {
    if (!manifest.permissions.includes('ui')) throw new Error('声明 UI 面板的插件必须申请 ui 权限');
    if (!Array.isArray(panels)) throw new Error('uiPanels 必须是数组');
    const ids = new Set<string>();
    for (const panel of panels) {
      if (!panel || typeof panel.id !== 'string' || !ID_PATTERN.test(panel.id)) throw new Error('插件面板 ID 无效');
      if (ids.has(panel.id)) throw new Error(`插件面板 ID 重复：${panel.id}`);
      ids.add(panel.id);
      if (typeof panel.title !== 'string' || !panel.title.trim()) throw new Error(`插件面板标题不能为空：${panel.id}`);
      if (typeof panel.entry !== 'string' || !panel.entry || isAbsolute(panel.entry)) throw new Error(`插件面板入口无效：${panel.id}`);
      const panelTools = validateStringList(panel.tools, `uiPanels.${panel.id}.tools`);
      if (panelTools.some((tool) => !tools.includes(tool))) throw new Error(`插件面板工具必须引用 contributes.tools：${panel.id}`);
      const panelEntry = resolve(root, panel.entry);
      const panelRelative = relative(resolve(root), panelEntry);
      if (panelRelative.startsWith('..') || isAbsolute(panelRelative) || !existsSync(panelEntry)) throw new Error(`插件面板入口不存在或越过插件目录：${panel.entry}`);
    }
  }
  const workbenches = manifest.contributes.workbenches;
  if (workbenches !== undefined) {
    if (manifest.schemaVersion !== 2 || manifest.apiVersion !== 2) throw new Error('workbenches contribution 仅支持 Plugin API v2');
    if (!manifest.permissions.includes('ui')) throw new Error('声明工作台的插件必须申请 ui 权限');
    if (!Array.isArray(workbenches) || workbenches.length > 16) throw new Error('workbenches 必须是最多 16 项的数组');
    const ids = new Set<string>();
    const viewKinds = new Set(['files', 'editor', 'image', 'pdf', 'annotations', 'jobs', 'environment', 'custom']);
    for (const workbench of workbenches) {
      if (!workbench || typeof workbench.id !== 'string' || !workbench.id.startsWith(`${manifest.id}:`) || ids.has(workbench.id)) throw new Error('插件工作台 ID 必须唯一并使用插件命名空间');
      ids.add(workbench.id);
      if (typeof workbench.title !== 'string' || !workbench.title.trim()) throw new Error(`插件工作台标题不能为空：${workbench.id}`);
      if (!workbench.accepts || typeof workbench.accepts !== 'object') throw new Error(`插件工作台 accepts 无效：${workbench.id}`);
      for (const values of [workbench.accepts.mediaTypes, workbench.accepts.objectTypes]) {
        if (values !== undefined && (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim()))) throw new Error(`插件工作台 accepts 必须为字符串数组：${workbench.id}`);
      }
      if (!Array.isArray(workbench.views) || workbench.views.length === 0 || workbench.views.length > 16) throw new Error(`插件工作台必须包含 1–16 个视图：${workbench.id}`);
      const viewIds = new Set<string>();
      for (const view of workbench.views) {
        if (!view || typeof view.id !== 'string' || !ID_PATTERN.test(view.id) || viewIds.has(view.id) || typeof view.title !== 'string' || !view.title.trim() || !viewKinds.has(view.kind)) throw new Error(`插件工作台视图无效：${workbench.id}`);
        viewIds.add(view.id);
        if (view.kind === 'custom' && (!view.panelId || !panels?.some((panel) => panel.id === view.panelId))) throw new Error(`自定义工作台视图必须引用 uiPanels：${workbench.id}/${view.id}`);
      }
      if (!Array.isArray(workbench.commands) || workbench.commands.length > 32 || workbench.commands.some((command) => typeof command !== 'string' || !command.trim())) throw new Error(`插件工作台 commands 无效：${workbench.id}`);
    }
  }
  const worktableTemplates = manifest.contributes.worktableTemplates;
  let validatedWorktableTemplates: WorktableTemplateContribution[] | undefined;
  if (worktableTemplates !== undefined) {
    if (manifest.schemaVersion !== 3 || manifest.apiVersion !== 3) throw new Error('worktableTemplates contribution 仅支持 Plugin API v3');
    if (!manifest.permissions.includes('ui')) throw new Error('声明工作台模板的插件必须申请 ui 权限');
    validatedWorktableTemplates = validateWorktableTemplates(worktableTemplates, manifest.id, new Set(panels?.map((panel) => panel.id) ?? []));
  }
  const workbenchBlueprints = manifest.contributes.workbenchBlueprints;
  let validatedWorkbenchBlueprints: WorkbenchBlueprintV1[] | undefined;
  if (workbenchBlueprints !== undefined) {
    if (manifest.schemaVersion !== 4 || manifest.apiVersion !== 4) throw new Error('workbenchBlueprints contribution 仅支持 Plugin API v4');
    if (!manifest.permissions.includes('workbench:read')) throw new Error('声明 WorkbenchBlueprint 的插件必须申请 workbench:read 权限');
    validatedWorkbenchBlueprints = validateWorkbenchBlueprints(workbenchBlueprints, manifest.id, new Set(panels?.map((panel) => panel.id) ?? []));
  }
  const workflows = manifest.contributes.workflows;
  if (workflows !== undefined) {
    if (manifest.apiVersion !== 4 || !Array.isArray(workflows) || workflows.length > 32) throw new Error('workflows contribution 仅支持 Plugin API v4 且最多 32 项');
    const ids = new Set<string>();
    for (const workflow of workflows) {
      if (!workflow || !isNonEmptyString(workflow.id) || !workflow.id.startsWith(`${manifest.id}:`) || ids.has(workflow.id) || !isNonEmptyString(workflow.title) || !isNonEmptyString(workflow.description) || !isRecord(workflow.inputSchema)) throw new Error('插件 workflow 必须完整、唯一并使用插件命名空间');
      ids.add(workflow.id);
    }
  }
  const surfaces = manifest.contributes.surfaces;
  if (surfaces !== undefined) {
    if (manifest.apiVersion !== 4 || !manifest.permissions.includes('ui') || !Array.isArray(surfaces) || surfaces.length > 16) throw new Error('surfaces contribution 需要 Plugin API v4 与 ui 权限');
    const ids = new Set<string>();
    for (const surface of surfaces) {
      if (!surface || !isNonEmptyString(surface.id) || !surface.id.startsWith(`${manifest.id}:`) || ids.has(surface.id) || !isNonEmptyString(surface.title) || !['pdf-reader', 'knowledge-graph', 'drawing-canvas', 'custom'].includes(surface.kind) || !Array.isArray(surface.allowedHostCapabilities)) throw new Error('插件 surface 无效');
      ids.add(surface.id);
      const surfaceEntry = resolve(root, surface.entry);
      const surfaceRelative = relative(resolve(root), surfaceEntry);
      if (!isNonEmptyString(surface.entry) || isAbsolute(surface.entry) || surfaceRelative.startsWith('..') || isAbsolute(surfaceRelative) || !existsSync(surfaceEntry)) throw new Error(`插件 surface 入口不存在或越过插件目录：${surface.entry}`);
    }
  }
  const artifactRenderers = manifest.contributes.artifactRenderers;
  if (artifactRenderers !== undefined) {
    if (manifest.apiVersion !== 4 || !manifest.permissions.includes('ui') || !Array.isArray(artifactRenderers) || artifactRenderers.length > 16) throw new Error('artifactRenderers contribution 需要 Plugin API v4 与 ui 权限');
    for (const renderer of artifactRenderers) {
      if (!renderer || !isNonEmptyString(renderer.id) || !renderer.id.startsWith(`${manifest.id}:`) || !Array.isArray(renderer.artifactKinds) || renderer.artifactKinds.length === 0 || !isNonEmptyString(renderer.entry)) throw new Error('插件 Artifact renderer 无效');
      const rendererEntry = resolve(root, renderer.entry);
      const rendererRelative = relative(resolve(root), rendererEntry);
      if (isAbsolute(renderer.entry) || rendererRelative.startsWith('..') || isAbsolute(rendererRelative) || !existsSync(rendererEntry)) throw new Error(`Artifact renderer 入口不存在或越过插件目录：${renderer.entry}`);
    }
  }
  const toolchainAdapters = manifest.contributes.toolchainAdapters;
  const validatedToolchainAdapters = toolchainAdapters === undefined ? undefined : validateToolchainAdapters(toolchainAdapters, manifest.id);
  if (validatedToolchainAdapters && (manifest.apiVersion !== 4 || !manifest.permissions.includes('toolchains:execute'))) throw new Error('toolchainAdapters contribution 需要 Plugin API v4 与 toolchains:execute 权限');
  const researchObjectSchemas = manifest.contributes.researchObjectSchemas;
  if (researchObjectSchemas !== undefined) {
    if (![2, 3, 4].includes(manifest.schemaVersion) || ![2, 3, 4].includes(manifest.apiVersion ?? 0)) throw new Error('researchObjectSchemas 仅支持 Plugin API v2、v3 或 v4');
    if (!Array.isArray(researchObjectSchemas) || researchObjectSchemas.length > 64) throw new Error('researchObjectSchemas 必须是最多 64 项的数组');
    for (const schema of researchObjectSchemas) {
      if (!schema || typeof schema.type !== 'string' || !schema.type.startsWith(`${manifest.id}:`) || !objectTypes.includes(schema.type)) throw new Error('科研对象 schema 必须引用已声明的命名空间类型');
      if (!schema.attributesSchema || typeof schema.attributesSchema !== 'object') throw new Error(`科研对象 attributesSchema 无效：${schema.type}`);
    }
  }
  return {
    schemaVersion: manifest.schemaVersion,
    ...(manifest.apiVersion ? { apiVersion: manifest.apiVersion } : {}),
    id: manifest.id,
    name: manifest.name.trim(),
    version: manifest.version,
    engine: manifest.engine,
    entry: manifest.entry,
    permissions: [...manifest.permissions],
    contributes: {
      tools,
      contextProviders,
      agentTemplates: templates,
      agentPresets: presets,
      researchObjectTypes: objectTypes,
      researchRelationTypes: relationTypes,
      ...(manifest.contributes.settingsSchema ? { settingsSchema: structuredClone(manifest.contributes.settingsSchema) } : {}),
      ...(cards ? { toolCards: cards.map((card) => ({ tool: card.tool, renderHint: card.renderHint })) } : {}),
      ...(panels ? { uiPanels: panels.map((panel) => ({ id: panel.id, title: panel.title, entry: panel.entry, tools: [...(panel.tools ?? [])] })) } : {}),
      ...(workbenches ? { workbenches: structuredClone(workbenches) } : {}),
      ...(validatedWorktableTemplates ? { worktableTemplates: validatedWorktableTemplates } : {}),
      ...(validatedWorkbenchBlueprints ? { workbenchBlueprints: validatedWorkbenchBlueprints } : {}),
      ...(workflows ? { workflows: structuredClone(workflows) } : {}),
      ...(surfaces ? { surfaces: structuredClone(surfaces) } : {}),
      ...(artifactRenderers ? { artifactRenderers: structuredClone(artifactRenderers) } : {}),
      ...(validatedToolchainAdapters ? { toolchainAdapters: validatedToolchainAdapters } : {}),
      ...(researchObjectSchemas ? { researchObjectSchemas: structuredClone(researchObjectSchemas) } : {}),
    },
  } as PluginManifest;
}

export function readPluginManifest(root: string): PluginManifest {
  return validatePluginManifest(JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as unknown, root);
}
