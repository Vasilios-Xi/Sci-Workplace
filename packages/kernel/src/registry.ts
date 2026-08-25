import type { Disposer } from './types.js';

export class Registry<T> {
  readonly #items = new Map<string, T>();

  register(id: string, value: T): Disposer {
    if (this.#items.has(id)) throw new Error(`Registry entry already exists: ${id}`);
    this.#items.set(id, value);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.#items.get(id) === value) this.#items.delete(id);
    };
  }

  replace(id: string, value: T): Disposer {
    const previous = this.#items.get(id);
    this.#items.set(id, value);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.#items.get(id) !== value) return;
      if (previous === undefined) this.#items.delete(id);
      else this.#items.set(id, previous);
    };
  }

  get(id: string): T | undefined {
    return this.#items.get(id);
  }

  require(id: string): T {
    const value = this.#items.get(id);
    if (value === undefined) throw new Error(`Unknown registry entry: ${id}`);
    return value;
  }

  has(id: string): boolean {
    return this.#items.has(id);
  }

  entries(): Array<[string, T]> {
    return [...this.#items.entries()];
  }

  values(): T[] {
    return [...this.#items.values()];
  }

  get size(): number {
    return this.#items.size;
  }
}
