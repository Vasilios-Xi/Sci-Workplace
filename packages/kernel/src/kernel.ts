import { KernelScope } from './scope.js';
import {
  ModuleDependencyError,
  type Disposer,
  type KernelModule,
  type ModuleState,
  type ModuleStatus,
} from './types.js';

interface MountedModule {
  module: KernelModule<unknown>;
  state: ModuleState;
  scope: KernelScope;
  start: Promise<void>;
  stop?: Promise<void>;
  error?: Error;
}

export interface ModuleEntry<TConfig = unknown> {
  module: KernelModule<TConfig>;
  config: TConfig;
}

function validateModuleGraph(entries: readonly ModuleEntry[], availableModules: ReadonlySet<string> = new Set()): string[] {
  const ids = new Set(entries.map((entry) => entry.module.id));
  const details: string[] = [];
  if (ids.size !== entries.length) {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.module.id)) details.push(`duplicate module ${entry.module.id}`);
      seen.add(entry.module.id);
    }
  }
  for (const entry of entries) {
    for (const dependency of entry.module.dependencies?.modules ?? []) {
      if (!ids.has(dependency) && !availableModules.has(dependency)) details.push(`${entry.module.id} requires missing module ${dependency}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(entries.map((entry) => [entry.module.id, entry]));
  const visit = (id: string, path: string[]) => {
    if (visiting.has(id)) {
      details.push(`cycle ${[...path, id].join(' -> ')}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.module.dependencies?.modules ?? []) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id, []);
  return details;
}

function topological(entries: readonly ModuleEntry[]): ModuleEntry[] {
  const byId = new Map(entries.map((entry) => [entry.module.id, entry]));
  const result: ModuleEntry[] = [];
  const visited = new Set<string>();
  const visit = (entry: ModuleEntry) => {
    if (visited.has(entry.module.id)) return;
    for (const dependency of entry.module.dependencies?.modules ?? []) {
      const target = byId.get(dependency);
      if (target) visit(target);
    }
    visited.add(entry.module.id);
    result.push(entry);
  };
  for (const entry of entries) visit(entry);
  return result;
}

export class Kernel {
  readonly root: KernelScope;
  readonly #records = new WeakMap<KernelScope, Map<string, MountedModule>>();
  readonly #operations = new WeakMap<KernelScope, Map<string, Promise<void>>>();

  constructor(rootId = 'openlab') {
    this.root = new KernelScope({ id: rootId, kind: 'app' });
  }

  async mount<TConfig>(parent: KernelScope, module: KernelModule<TConfig>, config: TConfig): Promise<void> {
    await this.exclusive(parent, module.id, async () => await this.mountUnlocked(parent, module, config));
  }

  private async mountUnlocked<TConfig>(parent: KernelScope, module: KernelModule<TConfig>, config: TConfig): Promise<void> {
    const records = this.records(parent);
    if (records.has(module.id)) throw new Error(`Module ${module.id} already mounted in ${parent.id}`);
    if (module.scopeKinds && parent.kind !== 'module' && !module.scopeKinds.includes(parent.kind)) {
      throw new Error(`Module ${module.id} cannot mount in ${parent.kind} scope`);
    }
    const missingModules = (module.dependencies?.modules ?? []).filter((id) => !records.has(id));
    const missingServices = (module.dependencies?.services ?? []).filter((token) => parent.optional(token) === undefined);
    if (missingModules.length > 0 || missingServices.length > 0) {
      const details = [
        ...missingModules.map((id) => `module ${id}`),
        ...missingServices.map((token) => `service ${token.key}`),
      ];
      throw new ModuleDependencyError(`Module ${module.id} is waiting for dependencies`, details);
    }

    const moduleScope = parent.createModuleScope(module.id);
    const record: MountedModule = {
      module: module as KernelModule<unknown>,
      state: 'starting',
      scope: moduleScope,
      start: Promise.resolve(),
    };
    records.set(module.id, record);
    const publicKind = parent.kind === 'module' ? 'app' : parent.kind;
    const context = moduleScope.context(module.id, { id: parent.id, kind: publicKind });
    record.start = Promise.resolve()
      .then(() => module.apply(context, config))
      .then(async (cleanup) => {
        if (cleanup) await moduleScope.effect(() => cleanup);
        await module.healthCheck?.(context);
        parent.activateModuleScope(module.id, moduleScope);
        record.state = 'active';
      })
      .catch(async (error: unknown) => {
        record.state = 'failed';
        record.error = error instanceof Error ? error : new Error(String(error));
        await moduleScope.stop().catch(() => undefined);
        records.delete(module.id);
        throw record.error;
      });
    await record.start;
  }

  async mountAll(parent: KernelScope, entries: readonly ModuleEntry[]): Promise<void> {
    const details = validateModuleGraph(entries, new Set(this.records(parent).keys()));
    if (details.length > 0) throw new ModuleDependencyError('Invalid module graph', details);
    const mounted: string[] = [];
    try {
      for (const entry of topological(entries)) {
        await this.mount(parent, entry.module, entry.config);
        mounted.push(entry.module.id);
      }
    } catch (error) {
      for (const id of mounted.reverse()) await this.unmount(parent, id).catch(() => undefined);
      throw error;
    }
  }

  async unmount(parent: KernelScope, moduleId: string): Promise<void> {
    await this.exclusive(parent, moduleId, async () => await this.unmountUnlocked(parent, moduleId));
  }

  private async unmountUnlocked(parent: KernelScope, moduleId: string): Promise<void> {
    const records = this.records(parent);
    const record = records.get(moduleId);
    if (!record) return;
    if (record.stop) return record.stop;
    record.stop = (async () => {
      await record.start.catch(() => undefined);
      if (record.state !== 'failed') record.state = 'stopping';
      parent.deactivateModuleScope(moduleId, record.scope);
      try {
        await record.scope.stop();
        record.state = 'stopped';
      } catch (error) {
        record.state = 'failed';
        record.error = error instanceof Error ? error : new Error(String(error));
        throw record.error;
      } finally {
        records.delete(moduleId);
      }
    })();
    return record.stop;
  }

  async hotSwap<TConfig>(parent: KernelScope, module: KernelModule<TConfig>, config: TConfig): Promise<void> {
    await this.exclusive(parent, module.id, async () => await this.hotSwapUnlocked(parent, module, config));
  }

  private async hotSwapUnlocked<TConfig>(parent: KernelScope, module: KernelModule<TConfig>, config: TConfig): Promise<void> {
    const records = this.records(parent);
    const previous = records.get(module.id);
    if (!previous) {
      await this.mountUnlocked(parent, module, config);
      return;
    }
    if (module.scopeKinds && parent.kind !== 'module' && !module.scopeKinds.includes(parent.kind)) {
      throw new Error(`Module ${module.id} cannot mount in ${parent.kind} scope`);
    }
    const missingModules = (module.dependencies?.modules ?? []).filter((id) => id !== module.id && !records.has(id));
    const missingServices = (module.dependencies?.services ?? []).filter((token) => parent.optional(token) === undefined);
    if (missingModules.length > 0 || missingServices.length > 0) {
      throw new ModuleDependencyError(`Module ${module.id} is waiting for dependencies`, [
        ...missingModules.map((id) => `module ${id}`),
        ...missingServices.map((token) => `service ${token.key}`),
      ]);
    }
    const candidateScope = parent.createModuleScope(module.id, true);
    const publicKind = parent.kind === 'module' ? 'app' : parent.kind;
    const context = candidateScope.context(module.id, { id: parent.id, kind: publicKind });
    try {
      const cleanup = await module.apply(context, config);
      if (cleanup) await candidateScope.effect(() => cleanup);
      await module.healthCheck?.(context);
      parent.activateModuleScope(module.id, candidateScope);
    } catch (error) {
      await candidateScope.stop().catch(() => undefined);
      throw error;
    }
    const replacement: MountedModule = {
      module: module as KernelModule<unknown>,
      state: 'active',
      scope: candidateScope,
      start: Promise.resolve(),
    };
    records.set(module.id, replacement);
    await previous.scope.stop().catch(async (error) => {
      await parent.bus.publish('kernel/hot-swap-cleanup-failed', { moduleId: module.id, error });
    });
  }

  status(parent: KernelScope): ModuleStatus[] {
    return [...this.records(parent).values()].map((record) => {
      const base: ModuleStatus = { id: record.module.id, version: record.module.version, state: record.state };
      return record.error ? { ...base, error: record.error } : base;
    });
  }

  async stop(): Promise<void> {
    await this.root.stop();
  }

  private records(scope: KernelScope): Map<string, MountedModule> {
    let records = this.#records.get(scope);
    if (!records) {
      records = new Map();
      this.#records.set(scope, records);
    }
    return records;
  }

  private async exclusive(scope: KernelScope, moduleId: string, operation: () => Promise<void>): Promise<void> {
    let operations = this.#operations.get(scope);
    if (!operations) {
      operations = new Map();
      this.#operations.set(scope, operations);
    }
    const previous = operations.get(moduleId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    operations.set(moduleId, current);
    try {
      await current;
    } finally {
      if (operations.get(moduleId) === current) operations.delete(moduleId);
    }
  }
}
