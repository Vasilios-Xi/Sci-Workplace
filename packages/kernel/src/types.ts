export type MaybePromise<T> = T | Promise<T>;
export type Disposer = () => MaybePromise<void>;
export type KernelScopeKind = 'app' | 'project' | 'session' | 'agent' | 'module';
export type ModuleState = 'declared' | 'waiting_dependencies' | 'starting' | 'active' | 'stopping' | 'stopped' | 'failed';

export interface ServiceTokenOptions {
  /** A sealed service cannot be shadowed by descendant project/session/agent scopes. */
  sealed?: boolean;
}

export class ServiceToken<T> {
  readonly key: string;
  readonly sealed: boolean;

  constructor(key: string, options: ServiceTokenOptions = {}) {
    if (!key.trim()) throw new Error('Service token key must not be empty');
    this.key = key;
    this.sealed = options.sealed === true;
  }

  toString(): string {
    return `ServiceToken(${this.key})`;
  }
}

export interface KernelEventMap {
  [event: string]: unknown;
}

export interface KernelModuleDependencies {
  modules?: readonly string[];
  services?: readonly ServiceToken<unknown>[];
}

export interface KernelModule<TConfig = undefined> {
  id: string;
  version: string;
  dependencies?: KernelModuleDependencies;
  scopeKinds?: readonly Exclude<KernelScopeKind, 'module'>[];
  apply(context: ModuleContext, config: TConfig): MaybePromise<void | Disposer>;
  healthCheck?(context: ModuleContext): MaybePromise<void>;
}

export interface ModuleContext {
  readonly moduleId: string;
  readonly scopeId: string;
  readonly scopeKind: Exclude<KernelScopeKind, 'module'>;
  get<T>(token: ServiceToken<T>): T;
  optional<T>(token: ServiceToken<T>): T | undefined;
  provide<T>(token: ServiceToken<T>, value: T): Disposer;
  effect(setup: () => MaybePromise<void | Disposer>): Promise<Disposer>;
  on<T>(event: string, listener: (payload: T) => MaybePromise<void>): Disposer;
  onSerial<T, TResult>(event: string, listener: (payload: T) => MaybePromise<TResult | undefined>): Disposer;
  onPipeline<TPayload, TValue>(event: string, listener: (value: TValue, payload: TPayload) => MaybePromise<TValue>): Disposer;
  publish<T>(event: string, payload: T): Promise<void>;
  serial<T, TResult>(event: string, payload: T): Promise<TResult | undefined>;
  pipeline<TPayload, TValue>(event: string, value: TValue, payload: TPayload): Promise<TValue>;
}

export interface ModuleStatus {
  id: string;
  version: string;
  state: ModuleState;
  error?: Error;
}

export class MissingServiceError extends Error {
  constructor(token: ServiceToken<unknown>, scopeId: string) {
    super(`Missing service ${token.key} in scope ${scopeId}`);
    this.name = 'MissingServiceError';
  }
}

export class ModuleDependencyError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[]) {
    super(`${message}: ${details.join('; ')}`);
    this.name = 'ModuleDependencyError';
    this.details = details;
  }
}

export class SealedServiceOverrideError extends Error {
  constructor(token: ServiceToken<unknown>, providerScopeId: string, targetScopeId: string) {
    super(`Sealed service ${token.key} from scope ${providerScopeId} cannot be overridden in ${targetScopeId}`);
    this.name = 'SealedServiceOverrideError';
  }
}

export class ScopeHierarchyError extends Error {
  constructor(parentKind: KernelScopeKind, childKind: Exclude<KernelScopeKind, 'module'>) {
    super(`Invalid kernel scope hierarchy: ${parentKind} cannot create ${childKind}`);
    this.name = 'ScopeHierarchyError';
  }
}
