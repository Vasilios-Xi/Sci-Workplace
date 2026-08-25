import type { Disposer, MaybePromise } from './types.js';

type PublishListener = (payload: unknown) => MaybePromise<void>;
type SerialListener = (payload: unknown) => MaybePromise<unknown | undefined>;
type PipelineListener = (value: unknown, payload: unknown) => MaybePromise<unknown>;

function addListener<T>(map: Map<string, T[]>, event: string, listener: T): Disposer {
  const list = map.get(event) ?? [];
  list.push(listener);
  map.set(event, list);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = map.get(event);
    if (!current) return;
    const index = current.indexOf(listener);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) map.delete(event);
  };
}
export class EventBus {
  readonly #publishListeners = new Map<string, PublishListener[]>();
  readonly #serialListeners = new Map<string, SerialListener[]>();
  readonly #pipelineListeners = new Map<string, PipelineListener[]>();

  on<T>(event: string, listener: (payload: T) => MaybePromise<void>): Disposer {
    return addListener(this.#publishListeners, event, listener as PublishListener);
  }

  onSerial<T, TResult>(event: string, listener: (payload: T) => MaybePromise<TResult | undefined>): Disposer {
    return addListener(this.#serialListeners, event, listener as SerialListener);
  }

  onPipeline<TPayload, TValue>(
    event: string,
    listener: (value: TValue, payload: TPayload) => MaybePromise<TValue>,
  ): Disposer {
    return addListener(this.#pipelineListeners, event, listener as PipelineListener);
  }

  async publish<T>(event: string, payload: T): Promise<void> {
    const listeners = [...(this.#publishListeners.get(event) ?? [])];
    const results = await Promise.allSettled(listeners.map((listener) => listener(payload)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(failures.map((failure) => failure.reason), `Event ${event} failed in ${failures.length} listener(s)`);
    }
  }

  async serial<T, TResult>(event: string, payload: T): Promise<TResult | undefined> {
    const listeners = [...(this.#serialListeners.get(event) ?? [])];
    let result: TResult | undefined;
    for (const listener of listeners) {
      const next = await listener(payload);
      if (next !== undefined) result = next as TResult;
    }
    return result;
  }

  async pipeline<TPayload, TValue>(event: string, value: TValue, payload: TPayload): Promise<TValue> {
    const listeners = [...(this.#pipelineListeners.get(event) ?? [])];
    let current: unknown = value;
    for (const listener of listeners) current = await listener(current, payload);
    return current as TValue;
  }

  listenerCount(event?: string): number {
    if (event) {
      return (this.#publishListeners.get(event)?.length ?? 0)
        + (this.#serialListeners.get(event)?.length ?? 0)
        + (this.#pipelineListeners.get(event)?.length ?? 0);
    }
    const count = (map: Map<string, unknown[]>) => [...map.values()].reduce((sum, list) => sum + list.length, 0);
    return count(this.#publishListeners) + count(this.#serialListeners) + count(this.#pipelineListeners);
  }
}
