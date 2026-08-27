import { describe, expect, it } from 'vitest';
import type { SecurityApprovalPolicy, ToolDefinition } from '@openlab/protocol';
import {
  ApprovalPolicy,
  DEFAULT_SECURITY_APPROVAL_POLICY,
  normalizeSecurityApprovalPolicy,
} from '../src/security/approval-policy.js';

function tool(input: Partial<ToolDefinition> & Pick<ToolDefinition, 'risk'>): ToolDefinition {
  return {
    name: 'fixture_tool',
    title: 'Fixture',
    description: 'Fixture tool',
    inputSchema: { type: 'object', additionalProperties: false },
    renderHint: 'generic',
    source: 'core',
    ...input,
  };
}

function policy(patch: Partial<SecurityApprovalPolicy>): SecurityApprovalPolicy {
  return { ...DEFAULT_SECURITY_APPROVAL_POLICY, ...patch };
}

describe('approval policy', () => {
  it('normalizes missing and invalid project settings to backwards-compatible defaults', () => {
    expect(normalizeSecurityApprovalPolicy(undefined)).toEqual(DEFAULT_SECURITY_APPROVAL_POLICY);
    expect(normalizeSecurityApprovalPolicy({ projectRead: 'deny', networkAccess: 'sometimes', schemaVersion: 99 })).toEqual({
      ...DEFAULT_SECURITY_APPROVAL_POLICY,
      projectRead: 'deny',
    });
  });

  it('supports explicit allow, ask, and deny for ordinary project capabilities', () => {
    const approvals = new ApprovalPolicy();
    const write = tool({ risk: 'write' });
    expect(approvals.evaluate(write, 'auto', policy({ workspaceWrite: 'allow' }))).toMatchObject({ action: 'allow', required: false, denied: false });
    expect(approvals.evaluate(write, 'auto', policy({ workspaceWrite: 'ask' }))).toMatchObject({ action: 'ask', required: true, denied: false });
    expect(approvals.evaluate(write, 'auto', policy({ workspaceWrite: 'deny' }))).toMatchObject({ action: 'deny', required: false, denied: true });
  });

  it('makes operation-before-prompt mode stricter than automatic review without prompting for ordinary reads', () => {
    const approvals = new ApprovalPolicy();
    expect(approvals.evaluate(tool({ risk: 'read' }), 'ask', policy({ projectRead: 'allow' }))).toMatchObject({ action: 'allow', required: false });
    expect(approvals.evaluate(tool({ risk: 'write' }), 'ask', policy({ workspaceWrite: 'allow' }))).toMatchObject({ action: 'ask', required: true });
    expect(approvals.evaluate(tool({ risk: 'network' }), 'ask', policy({ networkAccess: 'allow' }))).toMatchObject({ action: 'ask', required: true });
    expect(approvals.evaluate(tool({ risk: 'write' }), 'ask', policy({ workspaceWrite: 'deny' }))).toMatchObject({ action: 'deny', denied: true });
  });

  it('uses deny over ask over allow when one call spans multiple categories', () => {
    const approvals = new ApprovalPolicy();
    const terminal = tool({ name: 'run_terminal', risk: 'execute' });
    const result = approvals.evaluate(terminal, 'auto', policy({
      terminalExecution: 'allow',
      networkAccess: 'ask',
      deletion: 'deny',
    }), { command: 'curl https://example.org/a ; Remove-Item result.csv' });
    expect(result).toMatchObject({ action: 'deny', denied: true, required: false });
    expect(result.categories).toEqual(expect.arrayContaining(['terminalExecution', 'networkAccess', 'deletion']));
  });

  it('keeps configured denies and high-risk questions authoritative in trusted mode', () => {
    const approvals = new ApprovalPolicy();
    expect(approvals.evaluate(tool({ risk: 'write' }), 'trusted', policy({ workspaceWrite: 'ask' }))).toMatchObject({ action: 'allow' });
    expect(approvals.evaluate(tool({ risk: 'write' }), 'trusted', policy({ workspaceWrite: 'deny' }))).toMatchObject({ action: 'deny', denied: true });
    expect(approvals.evaluate(tool({ risk: 'network' }), 'trusted', policy({ networkAccess: 'ask' }))).toMatchObject({ action: 'ask', required: true });
  });

  it('makes read-only mode a hard ceiling and keeps directory and extension categories distinct', () => {
    const approvals = new ApprovalPolicy();
    expect(approvals.evaluate(tool({ risk: 'write' }), 'read_only', policy({ workspaceWrite: 'allow' }))).toMatchObject({ action: 'deny', denied: true });
    expect(approvals.evaluate(tool({ risk: 'read' }), 'read_only', policy({ projectRead: 'allow' }), { outsideWorkspace: true }).categories).toEqual(['projectRead', 'outsideWorkspace']);
    expect(approvals.evaluate(tool({ name: 'install_plugin', risk: 'external' }), 'auto', policy({ extensionInstall: 'deny', outsideWorkspace: 'allow' }))).toMatchObject({ action: 'deny', categories: ['extensionInstall'] });
  });

  it('applies the external-tools rule to plugin and MCP calls in addition to declared risk', () => {
    const approvals = new ApprovalPolicy();
    const pluginRead = tool({ risk: 'read', source: 'plugin', sourceId: 'example.plugin' });
    const result = approvals.evaluate(pluginRead, 'auto', policy({ projectRead: 'allow', externalTools: 'ask' }));
    expect(result).toMatchObject({ action: 'ask', required: true, denied: false });
    expect(result.categories).toEqual(['projectRead', 'externalTools']);
  });
});
