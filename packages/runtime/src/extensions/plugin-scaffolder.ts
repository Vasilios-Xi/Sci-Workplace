import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteJson, atomicWriteText } from '../util/files.js';
import { validatePluginDescription } from './plugin-manager.js';
import { readPluginManifest } from './plugin-manifest.js';
import { PluginProcess } from './plugin-process.js';
import { inspectPluginPackage, preparePluginDependencies, runPluginContract, typecheckPlugin, type PluginDependencyInstallOptions } from './plugin-toolchain.js';

export interface ScaffoldedPlugin {
  root: string;
  files: string[];
}

export function scaffoldPlugin(projectRoot: string, input: { id: string; name: string; description: string }): ScaffoldedPlugin {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(input.id)) throw new Error('插件 ID 格式不合法');
  const developmentRoot = join(projectRoot, '.openlab', 'plugin-dev');
  mkdirSync(developmentRoot, { recursive: true });
  const root = join(developmentRoot, input.id);
  mkdirSync(root, { recursive: false });
  atomicWriteJson(join(root, 'manifest.json'), {
    schemaVersion: 4,
    apiVersion: 4,
    id: input.id,
    name: input.name,
    version: '0.1.0',
    engine: '^0.1.0',
    entry: 'src/index.ts',
    permissions: [],
    contributes: { tools: ['describe_research_input'] },
  });
  atomicWriteJson(join(root, 'package.json'), {
    name: input.id,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: { typecheck: 'tsc --noEmit', test: 'node --experimental-transform-types contract.test.mjs' },
  });
  atomicWriteJson(join(root, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true,
      allowImportingTsExtensions: true,
    },
    include: ['src/**/*.ts', 'types/**/*.d.ts'],
  });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'types'), { recursive: true });
  atomicWriteText(join(root, 'types', 'openlab-plugin.d.ts'), `declare module '@openlab/plugin-sdk' {
  export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
  export interface JsonSchema {
    type?: string;
    description?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema;
    enum?: Array<string | number | boolean | null>;
    additionalProperties?: boolean | JsonSchema;
    [key: string]: unknown;
  }
  export type ToolRisk = 'read' | 'write' | 'execute' | 'network' | 'delete' | 'external';
  export type ToolRenderHint = 'generic' | 'terminal' | 'diff' | 'artifact' | 'form' | 'agent';
  export type HarnessPluginPermissionV4 =
    | 'settings:read'
    | 'ui'
    | 'workspace:read'
    | 'workspace:edit'
    | 'resources:read'
    | 'documents:read'
    | 'jobs:run'
    | 'models:invoke'
    | 'annotations:read'
    | 'annotations:write'
    | 'evidence:read'
    | 'evidence:write'
    | 'artifacts:write'
    | 'artifacts:publish'
    | 'research:read'
    | 'research:write'
    | 'plugin-storage'
    | 'workbench:read'
    | 'workbench:write'
    | 'workbench:mount'
    | 'workbench:propose-layout'
    | 'browser:observe'
    | 'browser:interact'
    | 'generated-apps:build'
    | 'toolchains:execute';
  export interface ToolDefinition {
    name: string;
    title: string;
    description: string;
    inputSchema: JsonSchema;
    risk: ToolRisk;
    renderHint: ToolRenderHint;
  }
  export interface ToolExecutionResult {
    callId: string;
    ok: boolean;
    content: string;
    artifactIds: string[];
    changeSetId?: string;
    metadata: Record<string, JsonValue>;
  }
  export interface ContextContribution {
    id: string;
    label: string;
    category: 'policy' | 'project' | 'agent' | 'research' | 'task' | 'conversation' | 'tool' | 'plugin';
    priority: number;
    content: string;
    trust: 'trusted' | 'untrusted';
    sourceRefs: string[];
    cache: 'stable' | 'dynamic';
    projection?: 'system' | 'request-schema';
  }
  export interface DocumentRevisionRef { rootId: string; path: string; sha256: string; size?: number; mediaType?: string; }
  export interface EvidenceAnchorV1 { id: string; projectId: string; target: DocumentRevisionRef; page?: number; blockId?: string; selector: Record<string, JsonValue>; exact?: string; createdAt: string; }
  export interface WorkbenchSlotV1 { id: string; role: string; paneId: string; title: string; accepts: string[]; autoMount: boolean; }
  export interface WorkbenchBlueprintV1 { schemaVersion: 1; id: string; version: string; title: string; description?: string; kind: 'research' | 'generated'; inputSchema: JsonSchema; layout: Record<string, JsonValue>; panes: Array<Record<string, JsonValue>>; slots: WorkbenchSlotV1[]; commands: string[]; }
  export interface WorkbenchInstanceV1 { schemaVersion: 1; id: string; projectId: string; blueprintId: string; blueprintVersion: string; primaryConversationId?: string; title: string; status: 'idle' | 'running' | 'needs_input' | 'completed' | 'failed' | 'archived'; revision: number; slots: WorkbenchSlotV1[]; layout: Record<string, JsonValue>; panes: Array<Record<string, JsonValue>>; }
  export interface MountIntentV1 { schemaVersion: 1; idempotencyKey: string; instanceId: string; targetRole: string; artifact: { artifactId: string; revisionId: string }; title?: string; }
  export interface LayoutProposalV1 { schemaVersion: 1; id: string; instanceId: string; baseRevision: number; title: string; reason: string; status: 'pending' | 'accepted' | 'rejected' | 'stale'; }
  export interface ToolchainAdapterManifestV1 { schemaVersion: 1; id: string; name: string; version: string; kind: string; operations: Array<Record<string, JsonValue>>; }
  export interface ToolRunV1 { schemaVersion: 1; id: string; adapterId: string; operationId: string; status: string; artifactRevisionIds: string[]; }
  export interface PluginHostV4 {
    readonly capabilities: HarnessPluginPermissionV4[];
    workspace: { list(ref: { rootId: string; path: string }): Promise<Array<Record<string, JsonValue>>>; read(ref: { rootId: string; path: string }): Promise<{ content: string; sha256: string; mediaType?: string }> };
    resources: { open(target: DocumentRevisionRef): Promise<{ id: string; size: number; mediaType: string }>; read(handleId: string, start?: number, end?: number): Promise<Uint8Array>; release(handleId: string): Promise<void> };
    evidence: { list(target?: DocumentRevisionRef): Promise<EvidenceAnchorV1[]>; create(input: { target: DocumentRevisionRef; selector: Record<string, JsonValue>; page?: number; blockId?: string; exact?: string; idempotencyKey?: string }): Promise<EvidenceAnchorV1> };
    workbenches: { list(): Promise<WorkbenchInstanceV1[]>; inspect(instanceId: string): Promise<WorkbenchInstanceV1>; create(input: { blueprintId: string; title?: string; primaryConversationId?: string; inputs?: Record<string, JsonValue> }): Promise<WorkbenchInstanceV1>; open(instanceId: string): Promise<WorkbenchInstanceV1>; mount(intent: MountIntentV1): Promise<WorkbenchInstanceV1>; proposeLayout(input: { instanceId: string; baseRevision: number; title: string; reason: string; layout: Record<string, JsonValue>; panes: Array<Record<string, JsonValue>>; slots: WorkbenchSlotV1[] }): Promise<LayoutProposalV1>; reveal(input: { instanceId: string; anchorId: string; targetRole?: string }): Promise<void> };
    toolchains: { adapters(): Promise<ToolchainAdapterManifestV1[]>; run(input: { adapterId: string; operationId: string; values: Record<string, JsonValue>; confirmed: boolean }): Promise<ToolRunV1>; getRun(id: string): Promise<ToolRunV1>; cancelRun(id: string): Promise<ToolRunV1>; runLog(id: string, offset?: number): Promise<{ content: string; nextOffset: number }> };
    generatedApps: { propose(prompt: string): Promise<{ id: string; status: string; workbench: WorkbenchBlueprintV1; networkDomains: string[]; hostCapabilities: string[] }> };
  }
  export interface AgentTemplate {
    id: string;
    name: string;
    summary: string;
    avatar: 'sage' | 'ocean' | 'amber';
    identity: string;
    instructions: string;
    source: 'plugin';
    sourceId?: string;
  }
  export interface PluginExecutionContext {
    projectId: string;
    sessionId: string;
    agentId: string;
    traceId: string;
    settings: Record<string, JsonValue>;
    host: PluginHostV4;
    signal: AbortSignal;
  }
  export interface OpenLabPlugin {
    apiVersion: 4;
    tools?: Array<{
      definition: ToolDefinition;
      execute(input: Record<string, JsonValue>, context: PluginExecutionContext): Promise<ToolExecutionResult>;
    }>;
    context?: (input: { projectId: string; sessionId: string; agentId: string; settings: Record<string, JsonValue>; host: PluginHostV4 }) => Promise<ContextContribution[]> | ContextContribution[];
    agentTemplates?: AgentTemplate[];
    dispose?: () => Promise<void> | void;
  }
}
`);
  atomicWriteText(join(root, 'src', 'index.ts'), `/// <reference path="../types/openlab-plugin.d.ts" />
import type { OpenLabPlugin } from '@openlab/plugin-sdk';

const plugin = {
  apiVersion: 4,
  tools: [{
    definition: {
      name: 'describe_research_input',
      title: '描述科研输入',
      description: ${JSON.stringify(input.description)},
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      risk: 'read',
      renderHint: 'generic',
    },
    async execute(input, context) {
      return { callId: context.traceId, ok: true, content: String(input.text), artifactIds: [], metadata: {} };
    },
  }],
} satisfies OpenLabPlugin;

export default plugin;
`);
  atomicWriteText(join(root, 'README.md'), `# ${input.name}\n\n${input.description}\n\n这是由 Sci Workplace 对话内插件脚手架生成的 TypeScript 开发目录。安装前请检查 manifest 权限和依赖清单、运行受限契约测试并明确批准。依赖安装始终忽略 lifecycle scripts。\n`);
  atomicWriteText(join(root, 'contract.test.mjs'), `import assert from 'node:assert/strict';\nimport plugin from './src/index.ts';\nassert.equal(plugin.apiVersion, 4);\nassert.ok(plugin.tools.length > 0);\nconsole.log('Generated plugin assertions: ok');\n`);
  return {
    root,
    files: ['manifest.json', 'package.json', 'tsconfig.json', 'types/openlab-plugin.d.ts', 'src/index.ts', 'README.md', 'contract.test.mjs'],
  };
}

export function inspectScaffoldedPlugin(root: string) {
  return { manifest: readPluginManifest(root), package: inspectPluginPackage(root) };
}

export async function testScaffoldedPlugin(root: string, signal: AbortSignal, dependencyOptions?: PluginDependencyInstallOptions): Promise<string> {
  const temporary = mkdtempSync(join(tmpdir(), 'openlab-plugin-test-'));
  const candidate = join(temporary, 'candidate');
  cpSync(root, candidate, { recursive: true, errorOnExist: true });
  let process: PluginProcess | undefined;
  try {
    const manifest = readPluginManifest(candidate);
    const packageInspection = await preparePluginDependencies(candidate, 'test', signal, dependencyOptions);
    const typecheck = await typecheckPlugin(candidate, manifest, signal);
    const contract = await runPluginContract(candidate, manifest, signal);
    process = new PluginProcess({ manifest, root: candidate, projectRoot: candidate });
    const description = await process.start(signal);
    validatePluginDescription(manifest, description);
    return [
      `manifest: ${manifest.id}@${manifest.version}`,
      `dependencies: ${packageInspection.dependencies.filter((item) => item.kind !== 'peer').length}`,
      typecheck,
      contract,
      'runtime contract: ok',
    ].join('\n');
  } finally {
    await process?.stop().catch(() => undefined);
    rmSync(temporary, { recursive: true, force: true });
  }
}
