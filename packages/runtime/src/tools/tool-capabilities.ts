import type { ToolCapabilityDescriptor, ToolDefinition } from '@openlab/protocol';

const CORE_CAPABILITIES: Record<string, Omit<ToolCapabilityDescriptor, 'toolIds' | 'available'>> = {
  'workspace.read': { id: 'workspace.read', title: '工作区读取', description: '列举、读取和搜索当前项目及已授权目录。', source: 'core', defaultEnabled: true },
  'workspace.write': { id: 'workspace.write', title: '文件修改与撤销', description: '审阅后写入、删除和撤销工作区文件变更。', source: 'core', defaultEnabled: true },
  terminal: { id: 'terminal', title: '受控终端', description: '在当前工作目录运行经过审批的命令。', source: 'core', defaultEnabled: true },
  research: { id: 'research', title: '科研对象与产物', description: '登记科研对象、关系、Artifact 和 provenance。', source: 'core', defaultEnabled: true },
  context: { id: 'context', title: '上下文管理', description: '固定或解除固定可追溯上下文。', source: 'core', defaultEnabled: true },
  collaboration: { id: 'collaboration', title: '持久 Agent 协作', description: '向用户创建的会话成员委派任务并通过频道收敛结果。', source: 'core', defaultEnabled: true },
  worktable: { id: 'worktable', title: '科研工作台', description: '检查、读取、定位并在确认后挂载工作台内容与批注。', source: 'core', defaultEnabled: true },
  'skills.manage': { id: 'skills.manage', title: 'Skill 管理', description: '创建、校验和安装本地 Skill。', source: 'core', defaultEnabled: false },
  'plugins.manage': { id: 'plugins.manage', title: '插件开发与安装', description: '生成、测试、安装和管理本地插件。', source: 'core', defaultEnabled: false },
  'settings.manage': { id: 'settings.manage', title: '修改设置', description: '向用户提议修改 Sci Workplace 配置。', source: 'core', defaultEnabled: false },
};

const CORE_TOOL_CAPABILITY: Record<string, string> = {
  list_files: 'workspace.read',
  read_file: 'workspace.read',
  search_text: 'workspace.read',
  write_file: 'workspace.write',
  delete_file: 'workspace.write',
  undo_change: 'workspace.write',
  run_terminal: 'terminal',
  create_research_object: 'research',
  link_research_objects: 'research',
  register_artifact: 'research',
  pin_context: 'context',
  unpin_context: 'context',
  delegate_task: 'collaboration',
  send_agent_message: 'collaboration',
  run_channel: 'collaboration',
  wait_for_agent_runs: 'collaboration',
  ask_lead: 'collaboration',
  scaffold_skill: 'skills.manage',
  install_skill: 'skills.manage',
  scaffold_plugin: 'plugins.manage',
  test_plugin: 'plugins.manage',
  install_plugin: 'plugins.manage',
  propose_harness_settings: 'settings.manage',
};

export function capabilityIdForTool(definition: ToolDefinition): string {
  if (definition.capabilityId) return definition.capabilityId;
  if (definition.source === 'mcp') return `mcp:${definition.sourceId ?? 'unknown'}`;
  if (definition.source === 'plugin') return `plugin:${definition.sourceId ?? 'unknown'}`;
  return CORE_TOOL_CAPABILITY[definition.name] ?? 'context';
}

export function toolCapabilities(definitions: ToolDefinition[]): ToolCapabilityDescriptor[] {
  const groups = new Map<string, ToolCapabilityDescriptor>();
  for (const definition of definitions) {
    const id = capabilityIdForTool(definition);
    const known = CORE_CAPABILITIES[id];
    const existing = groups.get(id);
    const descriptor: ToolCapabilityDescriptor = existing ?? {
      id,
      title: known?.title ?? externalTitle(definition),
      description: known?.description ?? externalDescription(definition),
      source: known?.source ?? definition.source,
      ...(definition.sourceId ? { sourceId: definition.sourceId } : {}),
      toolIds: [],
      available: true,
      defaultEnabled: known?.defaultEnabled ?? false,
    };
    if (!descriptor.toolIds.includes(definition.name)) descriptor.toolIds.push(definition.name);
    groups.set(id, descriptor);
  }
  for (const [id, known] of Object.entries(CORE_CAPABILITIES)) {
    if (!groups.has(id)) groups.set(id, { ...known, toolIds: [], available: false });
  }
  return [...groups.values()].sort((left, right) => {
    if (left.source === 'core' && right.source !== 'core') return -1;
    if (left.source !== 'core' && right.source === 'core') return 1;
    return left.title.localeCompare(right.title, 'zh-CN');
  });
}

function externalTitle(definition: ToolDefinition): string {
  if (definition.source === 'mcp') return `MCP · ${definition.sourceId ?? definition.title}`;
  if (definition.source === 'plugin') return `插件 · ${definition.sourceId ?? definition.title}`;
  return definition.title;
}

function externalDescription(definition: ToolDefinition): string {
  if (definition.source === 'mcp') return '允许此 Agent 使用该 MCP Server 当前暴露的工具与资源。';
  if (definition.source === 'plugin') return '允许此 Agent 使用该插件当前贡献的工具。';
  return definition.description;
}
