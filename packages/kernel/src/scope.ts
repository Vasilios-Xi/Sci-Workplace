import { EventBus } from './event-bus.js';
import {
  MissingServiceError,
  ScopeHierarchyError,
  SealedServiceOverrideError,
  type Disposer,
  type KernelScopeKind,
  type MaybePromise,
  type ModuleContext,
  type ServiceToken,
} from './types.js';

interface ServiceRecord {
  value: unknown;
  sealed: boolean;
}

const CHILD_SCOPE_KINDS: Record<Exclude<KernelScopeKind, 'module'>, readonly Exclude<KernelScopeKind, 'module'>[]> = {
  app: ['project'],
  project: ['session'],
  session: ['agent'],
  agent: [],
};

class ManagedEffect {
  readonly #setupPromise: Promise<void>;
  #cleanup: Disposer | undefined;
  #disposePromise: Promise<void> | undefined;
  #disposeRequested = false;

  constructor(setup: () => MaybePromise<void | Disposer>) {
    this.#setupPromise = Promise.resolve()
      .then(setup)
      .then(async (cleanup) => {
        if (cleanup) this.#cleanup = cleanup;
        if (this.#disposeRequested && this.#cleanup) {
          const release = this.#cleanup;
          this.#cleanup = undefined;
          await release();
        }
      });
  }

  async ready(): Promise<void> {
    await this.#setupPromise;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposeRequested = true;
    this.#disposePromise = this.#setupPromise.then(async () => {
      if (this.#cleanup) {
        const cleanup = this.#cleanup;
        this.#cleanup = undefined;
        await cleanup();
      }
    });
    return this.#disposePromise;
  }
}

export interface ScopeIdentity {
  id: string;
  kind: Exclude<KernelScopeKind, 'module'>;
}

export class KernelScope {
  readonly id: string;
  readonly kind: KernelScopeKind;
  readonly parent: KernelScope | undefined;
  readonly bus: EventBus;
  readonly #services = new Map<string, ServiceRecord>();
  readonly #effects: ManagedEffect[] = [];
  readonly #children = new Set<KernelScope>();
  readonly #moduleScopes = new Map<string, KernelScope>();
  readonly #moduleId: string | undefined;
  #stopped = false;

  constructor(options: { id: string; kind: KernelScopeKind; parent?: KernelScope; bus?: EventBus; moduleId?: string }) {
    this.id = options.id;
    this.kind = options.kind;
    this.parent = options.parent;
    this.#moduleId = options.moduleId;
    this.bus = options.bus ?? options.parent?.bus ?? new EventBus();
    if (options.parent) options.parent.#children.add(this);
  }

  createChild(id: string, kind: Exclude<KernelScopeKind, 'module'>): KernelScope {
    this.assertActive();
    if (this.kind === 'module' || !CHILD_SCOPE_KINDS[this.kind].includes(kind)) throw new ScopeHierarchyError(this.kind, kind);
    return new KernelScope({ id, kind, parent: this });
  }

  createModuleScope(moduleId: string, staged = false): KernelScope {
    this.assertActive();
    const suffix = staged ? ':candidate' : '';
    return new KernelScope({ id: `${this.id}/module:${moduleId}${suffix}`, kind: 'module', parent: this, moduleId });
  }

  activateModuleScope(moduleId: string, moduleScope: KernelScope): KernelScope | undefined {
    const previous = this.#moduleScopes.get(moduleId);
    for (const token of moduleScope.#services.keys()) {
      for (const [otherId, otherScope] of this.#moduleScopes) {
        if (otherId !== moduleId && otherScope.#services.has(token)) {
          throw new Error(`Service ${token} is already provided by module ${otherId} in scope ${this.id}`);
        }
      }
    }
    this.#moduleScopes.set(moduleId, moduleScope);
    return previous;
  }

  deactivateModuleScope(moduleId: string, expected?: KernelScope): void {
    if (expected && this.#moduleScopes.get(moduleId) !== expected) return;
    this.#moduleScopes.delete(moduleId);
  }

  getModuleScope(moduleId: string): KernelScope | undefined {
    return this.#moduleScopes.get(moduleId);
  }

  get<T>(token: ServiceToken<T>): T {
    const value = this.optional(token);
    if (value === undefined) throw new MissingServiceError(token as ServiceToken<unknown>, this.id);
    return value;
  }

  optional<T>(token: ServiceToken<T>): T | undefined {
    const local = this.#services.get(token.key);
    if (local) return local.value as T;
    for (const moduleScope of this.#moduleScopes.values()) {
      const provided = moduleScope.#services.get(token.key);
      if (provided) return provided.value as T;
    }
    if (!this.parent) return undefined;
    return this.kind === 'module' && this.#moduleId
      ? this.parent.optionalExcludingModule(token, this.#moduleId)
      : this.parent.optional(token);
  }

  hasLocalService(token: ServiceToken<unknown>): boolean {
    return this.#services.has(token.key);
  }

  provide<T>(token: ServiceToken<T>, value: T): Disposer {
    this.assertActive();
    if (this.#services.has(token.key)) throw new Error(`Service ${token.key} already exists in scope ${this.id}`);
    const sealedProvider = this.findInheritedSealedService(token.key);
    if (sealedProvider) throw new SealedServiceOverrideError(token as ServiceToken<unknown>, sealedProvider, this.id);
    const record: ServiceRecord = { value, sealed: token.sealed };
    this.#services.set(token.key, record);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.#services.get(token.key) === record) this.#services.delete(token.key);
    };
  }

  async effect(setup: () => MaybePromise<void | Disposer>): Promise<Disposer> {
    this.assertActive();
    const managed = new ManagedEffect(setup);
    this.#effects.push(managed);
    try {
      await managed.ready();
    } catch (error) {
      const index = this.#effects.indexOf(managed);
      if (index >= 0) this.#effects.splice(index, 1);
      await managed.dispose().catch(() => undefined);
      throw error;
    }
    return () => managed.dispose();
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const errors: unknown[] = [];
    const moduleScopes = [...this.#moduleScopes.values()].reverse();
    this.#moduleScopes.clear();
    for (const moduleScope of moduleScopes) {
      try { await moduleScope.stop(); } catch (error) { errors.push(error); }
    }
    const children = [...this.#children].filter((child) => child.kind !== 'module').reverse();
    for (const child of children) {
      try { await child.stop(); } catch (error) { errors.push(error); }
    }
    for (const effect of [...this.#effects].reverse()) {
      try { await effect.dispose(); } catch (error) { errors.push(error); }
    }
    this.#effects.length = 0;
    this.#services.clear();
    if (this.parent) this.parent.#children.delete(this);
    if (errors.length > 0) throw new AggregateError(errors, `Scope ${this.id} failed to stop cleanly`);
  }

  context(moduleId: string, publicScope: ScopeIdentity): ModuleContext {
    const scope = this;
    const registerDisposer = (disposer: Disposer): Disposer => {
      let registered: Promise<Disposer> | undefined;
      const ensure = () => {
        registered ??= scope.effect(() => disposer);
        return registered;
      };
      void ensure();
      return () => ensure().then((release) => release());
    };
    return {
      moduleId,
      scopeId: publicScope.id,
      scopeKind: publicScope.kind,
      get: <T>(token: ServiceToken<T>) => scope.get(token),
      optional: <T>(token: ServiceToken<T>) => scope.optional(token),
      provide: <T>(token: ServiceToken<T>, value: T) => registerDisposer(scope.provide(token, value)),
      effect: (setup) => scope.effect(setup),
      on: <T>(event: string, listener: (payload: T) => MaybePromise<void>) => registerDisposer(scope.bus.on(event, listener)),
      onSerial: <T, TResult>(event: string, listener: (payload: T) => MaybePromise<TResult | undefined>) => registerDisposer(scope.bus.onSerial(event, listener)),
      onPipeline: <TPayload, TValue>(event: string, listener: (value: TValue, payload: TPayload) => MaybePromise<TValue>) => registerDisposer(scope.bus.onPipeline(event, listener)),
      publish: <T>(event: string, payload: T) => scope.bus.publish(event, payload),
      serial: <T, TResult>(event: string, payload: T) => scope.bus.serial<T, TResult>(event, payload),
      pipeline: <TPayload, TValue>(event: string, value: TValue, payload: TPayload) => scope.bus.pipeline(event, value, payload),
    };
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  private assertActive(): void {
    if (this.#stopped) throw new Error(`Scope ${this.id} is stopped`);
  }

  private optionalExcludingModule<T>(token: ServiceToken<T>, excludedModuleId: string): T | undefined {
    const local = this.#services.get(token.key);
    if (local) return local.value as T;
    for (const [moduleId, moduleScope] of this.#moduleScopes) {
      if (moduleId === excludedModuleId) continue;
      const provided = moduleScope.#services.get(token.key);
      if (provided) return provided.value as T;
    }
    return this.parent?.optional(token);
  }

  private findInheritedSealedService(key: string): string | undefined {
    let current = this.parent;
    let immediateParent = true;
    while (current) {
      if (current.#services.get(key)?.sealed) return current.id;
      // A staged module may replace the active version of the same logical
      // module. Other modules are still rejected by activateModuleScope.
      if (!(this.kind === 'module' && immediateParent)) {
        for (const moduleScope of current.#moduleScopes.values()) {
          if (moduleScope.#services.get(key)?.sealed) return current.id;
        }
      }
      immediateParent = false;
      current = current.parent;
    }
    return undefined;
  }
}
