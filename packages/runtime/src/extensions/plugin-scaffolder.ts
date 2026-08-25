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
    schemaVersion: 1,
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
  export interface AgentPreset {
    id: string;
    name: string;
    role: 'lead' | 'member';
    instructions: string;
    model: string;
    thinking: 'enabled' | 'disabled';
    reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    toolNames: string[];
    skillIds: string[];
    permissionMode: 'read_only' | 'ask' | 'trusted';
    contextBudget: number;
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
    projectRoot: string;
    sessionId: string;
    agentId: string;
    traceId: string;
    settings: Record<string, JsonValue>;
  }
  export interface OpenLabPlugin {
    apiVersion: 1;
    tools?: Array<{
      definition: ToolDefinition;
      execute(input: Record<string, JsonValue>, context: PluginExecutionContext): Promise<ToolExecutionResult>;
    }>;
    context?: (input: { projectRoot: string; sessionId: string; agentId: string; settings: Record<string, JsonValue> }) => Promise<ContextContribution[]> | ContextContribution[];
    agentTemplates?: AgentTemplate[];
    /** @deprecated Protocol v3 maps these to templates and never creates an Agent automatically. */
    agentPresets?: AgentPreset[];
    dispose?: () => Promise<void> | void;
  }
}
`);
  atomicWriteText(join(root, 'src', 'index.ts'), `/// <reference path="../types/openlab-plugin.d.ts" />
import type { OpenLabPlugin } from '@openlab/plugin-sdk';

const plugin = {
  apiVersion: 1,
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
  atomicWriteText(join(root, 'contract.test.mjs'), `import assert from 'node:assert/strict';\nimport plugin from './src/index.ts';\nassert.equal(plugin.apiVersion, 1);\nassert.ok(plugin.tools.length > 0);\nconsole.log('Generated plugin assertions: ok');\n`);
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
