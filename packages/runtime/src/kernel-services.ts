import {
  Kernel,
  ServiceToken,
  type KernelModule,
  type ModuleEntry,
} from '@openlab/kernel';
import type { ContextPins } from './context/pins.js';
import type { TeamManager } from './agent/team-manager.js';
import type { AgentRun } from '@openlab/protocol';
import type { SqliteEventStore } from './events/event-store.js';
import type { McpManager } from './extensions/mcp-manager.js';
import type { PluginManager } from './extensions/plugin-manager.js';
import type { SkillManager } from './extensions/skills.js';
import type { ResearchStore } from './research/research-store.js';
import type { ApprovalPolicy } from './security/approval-policy.js';
import type { ChangeSetStore } from './tools/change-set-store.js';
import type { ToolRegistry } from './tools/tool-registry.js';

export const RuntimeEvents = new ServiceToken<SqliteEventStore>('openlab.runtime.events', { sealed: true });
export const RuntimeTools = new ServiceToken<ToolRegistry>('openlab.runtime.tools', { sealed: true });
export const RuntimeApprovals = new ServiceToken<ApprovalPolicy>('openlab.runtime.approvals', { sealed: true });
export const RuntimeResearch = new ServiceToken<ResearchStore>('openlab.runtime.research', { sealed: true });
export const RuntimeChanges = new ServiceToken<ChangeSetStore>('openlab.runtime.changes', { sealed: true });
export const RuntimePins = new ServiceToken<ContextPins>('openlab.runtime.context-pins', { sealed: true });
export const RuntimeSkills = new ServiceToken<SkillManager>('openlab.runtime.skills', { sealed: true });
export const RuntimePlugins = new ServiceToken<PluginManager>('openlab.runtime.plugins', { sealed: true });
export const RuntimeMcp = new ServiceToken<McpManager>('openlab.runtime.mcp', { sealed: true });
export const RuntimeTeam = new ServiceToken<TeamManager>('openlab.runtime.team');
export const RuntimeAgent = new ServiceToken<AgentRun>('openlab.runtime.agent');

export interface RuntimeKernelServices {
  events: SqliteEventStore;
  tools: ToolRegistry;
  approvals: ApprovalPolicy;
  research: ResearchStore;
  changes: ChangeSetStore;
  pins: ContextPins;
  skills: SkillManager;
  plugins: PluginManager;
  mcp: McpManager;
}

function providerModule<T>(options: {
  id: string;
  token: ServiceToken<T>;
  value: T;
  dependencies?: KernelModule['dependencies'];
  dispose?: () => Promise<void> | void;
}): KernelModule {
  return {
    id: options.id,
    version: '1.0.0',
    scopeKinds: ['project'],
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    apply(context) {
      context.provide(options.token, options.value);
      return options.dispose;
    },
  };
}

/**
 * The runtime is deliberately assembled through the microkernel even though
 * its public facade remains OpenLabRuntime. This keeps core replacement out of
 * the plugin API while making startup rollback and reverse-order disposal real.
 */
export function createRuntimeKernelEntries(services: RuntimeKernelServices): ModuleEntry[] {
  let eventsClosed = false;
  return [
    {
      module: providerModule({
        id: 'runtime.events', token: RuntimeEvents, value: services.events,
        dispose: () => {
          if (eventsClosed) return;
          eventsClosed = true;
          services.events.close();
        },
      }),
      config: undefined,
    },
    { module: providerModule({ id: 'runtime.tools', token: RuntimeTools, value: services.tools }), config: undefined },
    { module: providerModule({ id: 'runtime.approvals', token: RuntimeApprovals, value: services.approvals }), config: undefined },
    {
      module: providerModule({
        id: 'runtime.research', token: RuntimeResearch, value: services.research,
        dependencies: { modules: ['runtime.events'], services: [RuntimeEvents] },
      }),
      config: undefined,
    },
    {
      module: providerModule({
        id: 'runtime.changes', token: RuntimeChanges, value: services.changes,
        dependencies: { modules: ['runtime.events'], services: [RuntimeEvents] },
      }),
      config: undefined,
    },
    { module: providerModule({ id: 'runtime.context-pins', token: RuntimePins, value: services.pins }), config: undefined },
    { module: providerModule({ id: 'runtime.skills', token: RuntimeSkills, value: services.skills }), config: undefined },
    {
      module: providerModule({
        id: 'runtime.plugins', token: RuntimePlugins, value: services.plugins,
        dependencies: { modules: ['runtime.tools'], services: [RuntimeTools] },
        dispose: async () => await services.plugins.stop(),
      }),
      config: undefined,
    },
    {
      module: providerModule({
        id: 'runtime.mcp', token: RuntimeMcp, value: services.mcp,
        dependencies: { modules: ['runtime.tools'], services: [RuntimeTools] },
        dispose: async () => await services.mcp.stop(),
      }),
      config: undefined,
    },
  ];
}

export function createRuntimeKernel(): Kernel {
  return new Kernel('openlab-runtime');
}
