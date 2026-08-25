import { describe, expect, it } from 'vitest';
import { EventBus, Kernel, Registry, ServiceToken, type KernelModule } from '../src/index.js';

describe('OpenLab microkernel', () => {
  it('mounts modules in dependency order and exposes services', async () => {
    const kernel = new Kernel('test');
    const order: string[] = [];
    const greeting = new ServiceToken<string>('test.greeting');
    const provider: KernelModule = {
      id: 'provider', version: '1.0.0',
      apply(ctx) { order.push('provider'); ctx.provide(greeting, 'hello'); },
    };
    const consumer: KernelModule = {
      id: 'consumer', version: '1.0.0',
      dependencies: { modules: ['provider'], services: [greeting] },
      apply(ctx) { order.push(ctx.get(greeting)); },
    };
    await kernel.mountAll(kernel.root, [
      { module: consumer, config: undefined },
      { module: provider, config: undefined },
    ]);
    expect(order).toEqual(['provider', 'hello']);
    expect(kernel.root.get(greeting)).toBe('hello');
    await kernel.stop();
  });

  it('rejects missing modules and cycles before applying anything', async () => {
    const kernel = new Kernel('test');
    let applied = false;
    const first: KernelModule = {
      id: 'first', version: '1', dependencies: { modules: ['second'] },
      apply() { applied = true; },
    };
    const second: KernelModule = {
      id: 'second', version: '1', dependencies: { modules: ['first'] },
      apply() { applied = true; },
    };
    await expect(kernel.mountAll(kernel.root, [
      { module: first, config: undefined },
      { module: second, config: undefined },
    ])).rejects.toThrow(/cycle/);
    expect(applied).toBe(false);
  });

  it('rolls back mounted modules in reverse order on startup failure', async () => {
    const kernel = new Kernel('test');
    const calls: string[] = [];
    const good: KernelModule = {
      id: 'good', version: '1',
      apply: async (ctx) => {
        await ctx.effect(() => { calls.push('start'); return () => { calls.push('stop'); }; });
      },
    };
    const bad: KernelModule = {
      id: 'bad', version: '1', dependencies: { modules: ['good'] },
      apply() { throw new Error('boom'); },
    };
    await expect(kernel.mountAll(kernel.root, [
      { module: good, config: undefined },
      { module: bad, config: undefined },
    ])).rejects.toThrow('boom');
    expect(calls).toEqual(['start', 'stop']);
    expect(kernel.status(kernel.root)).toEqual([]);
  });

  it('keeps parent services isolated from child overrides', async () => {
    const token = new ServiceToken<string>('theme');
    const kernel = new Kernel('test');
    const rootModule: KernelModule = { id: 'root', version: '1', apply: (ctx) => { ctx.provide(token, 'root'); } };
    await kernel.mount(kernel.root, rootModule, undefined);
    const child = kernel.root.createChild('project', 'project');
    const childModule: KernelModule = { id: 'child', version: '1', apply: (ctx) => { ctx.provide(token, 'child'); } };
    await kernel.mount(child, childModule, undefined);
    expect(child.get(token)).toBe('child');
    expect(kernel.root.get(token)).toBe('root');
  });

  it('prevents descendant scopes from shadowing sealed services even with a token alias', async () => {
    const privileged = new ServiceToken<string>('security.approvals', { sealed: true });
    const alias = new ServiceToken<string>('security.approvals');
    const kernel = new Kernel('test');
    await kernel.mount(kernel.root, {
      id: 'security', version: '1', apply: (ctx) => { ctx.provide(privileged, 'trusted'); },
    }, undefined);
    const project = kernel.root.createChild('project', 'project');
    expect(project.get(alias)).toBe('trusted');
    expect(() => project.provide(alias, 'spoofed')).toThrow(/Sealed service security\.approvals/u);
    expect(project.get(privileged)).toBe('trusted');
  });

  it('enforces the app to project to session to agent scope hierarchy', () => {
    const kernel = new Kernel('test');
    expect(() => kernel.root.createChild('bad-session', 'session')).toThrow(/Invalid kernel scope hierarchy/u);
    const project = kernel.root.createChild('project', 'project');
    const session = project.createChild('session', 'session');
    const agent = session.createChild('agent', 'agent');
    expect(agent.kind).toBe('agent');
    expect(() => agent.createChild('nested-agent', 'agent')).toThrow(/Invalid kernel scope hierarchy/u);
  });

  it('allows later module batches to depend on modules already active in the scope', async () => {
    const kernel = new Kernel('test');
    const token = new ServiceToken<string>('incremental.service');
    await kernel.mount(kernel.root, {
      id: 'provider', version: '1', apply: (ctx) => { ctx.provide(token, 'ready'); },
    }, undefined);
    let observed = '';
    await kernel.mountAll(kernel.root, [{
      module: {
        id: 'consumer', version: '1', dependencies: { modules: ['provider'], services: [token] },
        apply: (ctx) => { observed = ctx.get(token); },
      },
      config: undefined,
    }]);
    expect(observed).toBe('ready');
  });

  it('disposes asynchronous effects once and in reverse order', async () => {
    const kernel = new Kernel('test');
    const calls: number[] = [];
    const module: KernelModule = {
      id: 'effects', version: '1',
      apply: async (ctx) => {
        await ctx.effect(() => () => { calls.push(1); });
        await ctx.effect(async () => {
          await Promise.resolve();
          return async () => { await Promise.resolve(); calls.push(2); };
        });
      },
    };
    await kernel.mount(kernel.root, module, undefined);
    await Promise.all([kernel.unmount(kernel.root, 'effects'), kernel.unmount(kernel.root, 'effects')]);
    expect(calls).toEqual([2, 1]);
  });

  it('honors dispose requested while a module is still starting', async () => {
    const kernel = new Kernel('test');
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => { releaseStart = resolve; });
    const calls: string[] = [];
    const module: KernelModule = {
      id: 'slow', version: '1',
      async apply(ctx) {
        await ctx.effect(async () => {
          calls.push('setup');
          await started;
          return () => { calls.push('cleanup'); };
        });
      },
    };
    const mounting = kernel.mount(kernel.root, module, undefined);
    await Promise.resolve();
    const unmounting = kernel.unmount(kernel.root, 'slow');
    releaseStart();
    await Promise.all([mounting, unmounting]);
    expect(calls).toEqual(['setup', 'cleanup']);
    expect(kernel.status(kernel.root)).toEqual([]);
  });

  it('commits a healthy hot swap and preserves the old module on failure', async () => {
    const kernel = new Kernel('test');
    const token = new ServiceToken<string>('version');
    const makeModule = (value: string, fail = false): KernelModule => ({
      id: 'replaceable', version: value,
      apply(ctx) { ctx.provide(token, value); },
      healthCheck() { if (fail) throw new Error('unhealthy'); },
    });
    await kernel.mount(kernel.root, makeModule('one'), undefined);
    await expect(kernel.hotSwap(kernel.root, makeModule('bad', true), undefined)).rejects.toThrow('unhealthy');
    expect(kernel.root.get(token)).toBe('one');
    await kernel.hotSwap(kernel.root, makeModule('two'), undefined);
    expect(kernel.root.get(token)).toBe('two');
  });

  it('hot swaps sealed services but never lets candidate health checks read the old version', async () => {
    const kernel = new Kernel('test');
    const token = new ServiceToken<string>('sealed-version', { sealed: true });
    const module = (value: string, provide = true): KernelModule => ({
      id: 'replaceable', version: value,
      apply(ctx) { if (provide) ctx.provide(token, value); },
      healthCheck(ctx) { expect(ctx.get(token)).toBe(value); },
    });
    await kernel.mount(kernel.root, module('one'), undefined);
    await expect(kernel.hotSwap(kernel.root, module('missing', false), undefined)).rejects.toThrow(/Missing service sealed-version/u);
    expect(kernel.root.get(token)).toBe('one');
    await kernel.hotSwap(kernel.root, module('two'), undefined);
    expect(kernel.root.get(token)).toBe('two');
  });

  it('serializes concurrent hot swaps without leaking an intermediate candidate', async () => {
    const kernel = new Kernel('test');
    const token = new ServiceToken<string>('concurrent-version');
    const disposed: string[] = [];
    const makeModule = (value: string): KernelModule => ({
      id: 'replaceable', version: value,
      apply(ctx) {
        ctx.provide(token, value);
        return () => { disposed.push(value); };
      },
    });
    await kernel.mount(kernel.root, makeModule('one'), undefined);
    await Promise.all([
      kernel.hotSwap(kernel.root, makeModule('two'), undefined),
      kernel.hotSwap(kernel.root, makeModule('three'), undefined),
    ]);
    expect(kernel.root.get(token)).toBe('three');
    expect(disposed).toEqual(['one', 'two']);
    await kernel.stop();
    expect(disposed).toEqual(['one', 'two', 'three']);
  });
});

describe('kernel primitives', () => {
  it('supports publish, serial and pipeline event modes', async () => {
    const bus = new EventBus();
    const observed: number[] = [];
    bus.on<number>('seen', (value) => { observed.push(value); });
    bus.onSerial<number, string>('choose', (value) => value > 1 ? 'large' : undefined);
    bus.onPipeline<{ suffix: string }, string>('format', (value, payload) => value + payload.suffix);
    await bus.publish('seen', 2);
    expect(observed).toEqual([2]);
    expect(await bus.serial<number, string>('choose', 2)).toBe('large');
    expect(await bus.pipeline('format', 'open', { suffix: 'lab' })).toBe('openlab');
  });

  it('registers and restores registry entries', () => {
    const registry = new Registry<number>();
    const dispose = registry.register('item', 1);
    const restore = registry.replace('item', 2);
    expect(registry.require('item')).toBe(2);
    restore();
    expect(registry.require('item')).toBe(1);
    dispose();
    expect(registry.get('item')).toBeUndefined();
  });
});
