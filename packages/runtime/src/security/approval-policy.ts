import type {
  PermissionMode,
  PermissionRule,
  SecurityApprovalPolicy,
  SecurityPermissionCategory,
  ToolDefinition,
} from '@openlab/protocol';

export const DEFAULT_SECURITY_APPROVAL_POLICY: SecurityApprovalPolicy = Object.freeze({
  schemaVersion: 1,
  projectRead: 'allow',
  workspaceWrite: 'ask',
  terminalExecution: 'ask',
  deletion: 'ask',
  networkAccess: 'ask',
  outsideWorkspace: 'ask',
  extensionInstall: 'ask',
  externalTools: 'ask',
});

const PERMISSION_RULES = new Set<PermissionRule>(['allow', 'ask', 'deny']);
const EXTENSION_TOOLS = new Set(['install_plugin', 'test_plugin', 'install_skill']);

export interface ApprovalContext {
  outsideWorkspace?: boolean;
  trustedWorkspace?: boolean;
  command?: string;
}

export interface ApprovalDecision {
  action: PermissionRule;
  required: boolean;
  denied: boolean;
  rationale: string;
  categories: SecurityPermissionCategory[];
}

export function normalizeSecurityApprovalPolicy(value: unknown): SecurityApprovalPolicy {
  const source = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Partial<Record<keyof SecurityApprovalPolicy, unknown>>
    : {};
  const normalizeRule = (key: SecurityPermissionCategory): PermissionRule => {
    const candidate = source[key];
    return typeof candidate === 'string' && PERMISSION_RULES.has(candidate as PermissionRule)
      ? candidate as PermissionRule
      : DEFAULT_SECURITY_APPROVAL_POLICY[key];
  };
  return {
    schemaVersion: 1,
    projectRead: normalizeRule('projectRead'),
    workspaceWrite: normalizeRule('workspaceWrite'),
    terminalExecution: normalizeRule('terminalExecution'),
    deletion: normalizeRule('deletion'),
    networkAccess: normalizeRule('networkAccess'),
    outsideWorkspace: normalizeRule('outsideWorkspace'),
    extensionInstall: normalizeRule('extensionInstall'),
    externalTools: normalizeRule('externalTools'),
  };
}

export class ApprovalPolicy {
  evaluate(
    tool: ToolDefinition,
    mode: PermissionMode,
    policy: SecurityApprovalPolicy = DEFAULT_SECURITY_APPROVAL_POLICY,
    context: ApprovalContext = {},
  ): ApprovalDecision {
    const normalizedPolicy = normalizeSecurityApprovalPolicy(policy);
    const categories = this.categories(tool, context);
    if (mode === 'read_only' && tool.risk !== 'read') {
      return {
        action: 'deny', required: false, denied: true, categories,
        rationale: '当前会话为只读模式，此操作已被阻止。',
      };
    }

    const rules = categories.map((category) => {
      const configured = normalizedPolicy[category];
      if (mode === 'trusted' && configured === 'ask' && this.isOrdinaryCategory(category)) return 'allow';
      if (context.trustedWorkspace && configured === 'ask' && category === 'outsideWorkspace') return 'allow';
      return configured;
    });
    const action: PermissionRule = rules.includes('deny') ? 'deny' : rules.includes('ask') ? 'ask' : 'allow';
    if (action === 'deny') {
      return {
        action, required: false, denied: true, categories,
        rationale: '用户设置的安全策略禁止此类操作。',
      };
    }
    if (action === 'ask') {
      return {
        action, required: true, denied: false, categories,
        rationale: '用户设置的安全策略要求在执行此类操作前确认。',
      };
    }
    return {
      action, required: false, denied: false, categories,
      rationale: '用户设置的安全策略允许此类操作。',
    };
  }

  private categories(tool: ToolDefinition, context: ApprovalContext): SecurityPermissionCategory[] {
    const categories = new Set<SecurityPermissionCategory>();
    if (EXTENSION_TOOLS.has(tool.name)) categories.add('extensionInstall');
    else if (tool.risk === 'read') categories.add('projectRead');
    else if (tool.risk === 'write') categories.add('workspaceWrite');
    else if (tool.risk === 'execute') categories.add('terminalExecution');
    else if (tool.risk === 'delete') categories.add('deletion');
    else if (tool.risk === 'network') categories.add('networkAccess');
    else if (tool.risk === 'external') {
      if (tool.name.startsWith('browser_')) categories.add('networkAccess');
      else categories.add('outsideWorkspace');
    }
    if (tool.source === 'plugin' || tool.source === 'mcp') categories.add('externalTools');
    if (context.outsideWorkspace) categories.add('outsideWorkspace');
    const command = context.command?.toLocaleLowerCase() ?? '';
    if (/\b(curl|wget|invoke-webrequest|irm|npm\s+install|pnpm\s+(?:add|install)|git\s+(?:clone|pull|push))\b/u.test(command)) {
      categories.add('networkAccess');
    }
    if (/\b(remove-item|del|erase|rmdir|rd|rm)\b/u.test(command)) categories.add('deletion');
    if (categories.size === 0) categories.add('projectRead');
    return [...categories];
  }

  private isOrdinaryCategory(category: SecurityPermissionCategory): boolean {
    return category === 'projectRead' || category === 'workspaceWrite' || category === 'terminalExecution';
  }
}
