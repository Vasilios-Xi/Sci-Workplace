import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import type { OpenLabPlugin, PluginHost, PluginHostCapability } from '@openlab/plugin-sdk';
import type { JsonValue } from '@openlab/protocol';

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const root = process.argv[2];
const entry = process.argv[3];
if (!root || !entry) throw new Error('Plugin runner requires root and entry');
const pluginRoot = root;
const pluginEntry = entry;
if (process.env.OPENLAB_PLUGIN_NETWORK !== '1') {
  const denied = () => { throw new Error('插件未获得 network 权限'); };
  globalThis.fetch = denied as typeof globalThis.fetch;
  if ('WebSocket' in globalThis) globalThis.WebSocket = denied as unknown as typeof globalThis.WebSocket;
  const patch = (target: object, names: string[]) => {
    for (const name of names) {
      if (name in target) (target as Record<string, unknown>)[name] = denied;
    }
  };
  patch(http, ['request', 'get']);
  patch(https, ['request', 'get']);
  patch(net, ['connect', 'createConnection']);
  patch(tls, ['connect']);
  patch(dgram, ['createSocket']);
  patch(dns, ['lookup', 'resolve', 'resolve4', 'resolve6']);
  syncBuiltinESMExports();
}

let plugin: OpenLabPlugin | undefined;
let settings: Record<string, JsonValue> = {};
let nextHostId = 1;
const pendingHost = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const invocationControllers = new Map<string, AbortController>();

async function withInvocationSignal<T>(invocationId: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  invocationControllers.set(invocationId, controller);
  try { return await run(controller.signal); }
  finally { invocationControllers.delete(invocationId); }
}

async function loadPlugin(): Promise<OpenLabPlugin> {
  if (plugin) return plugin;
  const imported = await import(pathToFileURL(resolve(pluginRoot, pluginEntry)).href);
  const exported = imported.default ?? imported.plugin;
  if (!exported || typeof exported !== 'object') throw new Error('插件未导出兼容的 Sci Workplace plugin');
  // Before Plugin API versions were explicit, OpenLab plugins exported the same
  // shape as v1 without an apiVersion field. Keep that channel executable while
  // ensuring every later RPC observes an explicit, immutable API version.
  const raw = exported as Record<string, unknown>;
  const candidate = (raw.apiVersion === undefined ? { ...raw, apiVersion: 1 } : raw) as unknown as OpenLabPlugin;
  if (candidate.apiVersion !== 1 && candidate.apiVersion !== 2 && candidate.apiVersion !== 3) throw new Error('插件未导出兼容的 Sci Workplace plugin');
  plugin = candidate;
  return candidate;
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function hostCall(invocationId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = `host:${nextHostId++}`;
  const response = new Promise<unknown>((resolvePromise, reject) => pendingHost.set(id, { resolve: resolvePromise, reject }));
  send({ jsonrpc: '2.0', id, method: 'host.call', params: { invocationId, method, params } });
  return await response;
}

function createHost(invocationId: string, capabilities: PluginHostCapability[]): PluginHost {
  const call = async <T>(method: string, params: Record<string, unknown> = {}) => await hostCall(invocationId, method, params) as T;
  return {
    capabilities: [...capabilities],
    workspace: {
      list: async (ref) => await call('workspace.list', { ref }),
      read: async (ref) => await call('workspace.read', { ref }),
      openDocument: async (ref) => await call('workspace.openDocument', { ref }),
      previewEdit: async (request) => await call('workspace.previewEdit', { request }),
      applyEdit: async (previewId, confirmed) => await call('workspace.applyEdit', { previewId, confirmed }),
    },
    resources: {
      open: async (target) => await call('resources.open', { target }),
      read: async (handleId, start, end) => {
        const result = await call<{ base64: string }>('resources.read', { handleId, start, end });
        return Uint8Array.from(Buffer.from(result.base64, 'base64'));
      },
      release: async (handleId) => { await call('resources.release', { handleId }); },
    },
    jobs: {
      run: async (spec) => await call('jobs.run', { spec }),
      get: async (id) => await call('jobs.get', { id }),
      wait: async (id) => await call('jobs.wait', { id }),
      cancel: async (id) => await call('jobs.cancel', { id }),
      log: async (id, offset) => await call('jobs.log', { id, offset }),
    },
    models: {
      list: async () => await call('models.list'),
      generate: async (spec) => await call('models.generate', { spec }),
      runStructured: async (spec) => await call('models.runStructured', { spec }),
    },
    toolchains: {
      list: async (kind) => await call('toolchains.list', { kind }),
    },
    workflows: {
      start: async (workflowId, input, options) => await call('workflows.start', { workflowId, input, options }),
      get: async (id) => await call('workflows.get', { id }),
      cancel: async (id) => await call('workflows.cancel', { id }),
      pause: async (id) => await call('workflows.pause', { id }),
      resume: async (id) => await call('workflows.resume', { id }),
      report: async (id, update) => await call('workflows.report', { id, update }),
    },
    annotations: {
      list: async (target) => await call('annotations.list', { target }),
      create: async (input) => await call('annotations.create', { input }),
      update: async (id, patch) => await call('annotations.update', { id, patch }),
    },
    artifacts: {
      revisions: async (artifactId) => await call('artifacts.revisions', { artifactId }),
      createRevision: async (input) => await call('artifacts.createRevision', { input }),
      archive: async (revisionId, includeLargeFiles) => await call('artifacts.archive', { revisionId, includeLargeFiles }),
      registerSourceMap: async (map) => await call('artifacts.registerSourceMap', { map }),
    },
    research: {
      objects: async () => await call('research.objects'),
      relations: async () => await call('research.relations'),
      createObject: async (input) => await call('research.createObject', { input }),
      createRelation: async (input) => await call('research.createRelation', { input }),
      create: async (input) => await call('research.create', { input }),
      update: async (id, patch) => await call('research.update', { id, patch }),
      relate: async (input) => await call('research.relate', { input }),
    },
    storage: {
      get: async (scope, key) => await call('storage.get', { scope, key }),
      put: async (scope, key, value, ifRevision) => await call('storage.put', { scope, key, value, ifRevision }),
      delete: async (scope, key, ifRevision) => { await call('storage.delete', { scope, key, ifRevision }); },
      list: async (scope, prefix) => await call('storage.list', { scope, prefix }),
    },
    workbench: {
      open: async (input) => await call('workbench.open', { input }),
      reveal: async (input) => { await call('workbench.reveal', { input }); },
    },
    worktable: {
      list: async () => await call('worktable.list'),
      inspect: async (instanceId) => await call('worktable.inspect', { instanceId }),
      create: async (input) => await call('worktable.create', { input }),
      open: async (instanceId) => await call('worktable.open', { instanceId }),
      update: async (instanceId, patch, ifRevision) => await call('worktable.update', { instanceId, patch, ifRevision }),
      archive: async (instanceId, ifRevision) => await call('worktable.archive', { instanceId, ifRevision }),
      bindSession: async (instanceId, sessionId) => await call('worktable.bindSession', { instanceId, sessionId }),
      reveal: async (input) => await call('worktable.reveal', { input }),
      mountContent: async (input) => await call('worktable.mountContent', { input }),
      mountArtifact: async (input) => await call('worktable.mountArtifact', { input }),
      setStatus: async (instanceId, status) => await call('worktable.setStatus', { instanceId, status }),
    },
    browser: {
      profiles: async () => await call('browser.profiles'),
      sessions: async () => await call('browser.sessions'),
      observe: async (sessionId) => await call('browser.observe', { sessionId }),
      open: async (input) => await call('browser.open', { input }),
      act: async (input) => await call('browser.act', { input }),
    },
    generatedApps: {
      list: async () => await call('generatedApps.list'),
      publish: async (input) => await call('generatedApps.publish', { input }),
    },
  };
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (line) => {
  void (async () => {
    let value: RpcRequest | RpcResponse;
    try { value = JSON.parse(line) as RpcRequest | RpcResponse; } catch { return; }
    if ('method' in value && value.method === 'invocation.cancel') {
      const invocationId = String(value.params?.invocationId ?? '');
      invocationControllers.get(invocationId)?.abort(new DOMException(String(value.params?.reason ?? 'Cancelled'), 'AbortError'));
      return;
    }
    if (!('method' in value)) {
      const pending = pendingHost.get(String(value.id));
      if (!pending) return;
      pendingHost.delete(String(value.id));
      if (value.error) pending.reject(new Error(value.error.message ?? 'Sci Workplace host call failed'));
      else pending.resolve(value.result);
      return;
    }
    const request = value;
    try {
      let result: unknown;
      if (request.method === 'settings.initialize') {
        const valueSettings = request.params?.settings;
        settings = typeof valueSettings === 'object' && valueSettings !== null && !Array.isArray(valueSettings) ? valueSettings as Record<string, JsonValue> : {};
        await loadPlugin();
        result = true;
      } else if (request.method === 'describe') {
        const active = await loadPlugin();
        result = {
          apiVersion: active.apiVersion,
          tools: (active.tools ?? []).map((tool) => tool.definition),
          workflows: active.apiVersion !== 1 ? (active.workflows ?? []).map((workflow) => workflow.definition) : [],
          agentTemplates: active.agentTemplates ?? [],
          agentPresets: active.apiVersion === 1 ? active.agentPresets ?? [] : [],
          hasContext: Boolean(active.context),
        };
      } else if (request.method === 'tool.execute') {
        const active = await loadPlugin();
        const name = String(request.params?.name ?? '');
        const tool = active.tools?.find((candidate) => candidate.definition.name === name);
        if (!tool) throw new Error(`插件工具不存在：${name}`);
        const context = (request.params?.context ?? {}) as Record<string, unknown>;
        if (active.apiVersion !== 1) {
          const invocationId = String(context.invocationId ?? '');
          const capabilities = Array.isArray(context.capabilities) ? context.capabilities.filter((item): item is PluginHostCapability => typeof item === 'string') : [];
          result = await withInvocationSignal(invocationId, async (signal) => await tool.execute((request.params?.input ?? {}) as never, {
            projectId: String(context.projectId ?? ''), sessionId: String(context.sessionId ?? ''), agentId: String(context.agentId ?? ''),
            traceId: String(context.traceId ?? ''), settings, host: createHost(invocationId, capabilities), signal,
          } as never));
        } else {
          result = await tool.execute((request.params?.input ?? {}) as never, { ...context, settings } as never);
        }
      } else if (request.method === 'context.collect') {
        const active = await loadPlugin();
        if (!active.context) result = [];
        else if (active.apiVersion !== 1) {
          const invocationId = String(request.params?.invocationId ?? '');
          const capabilities = Array.isArray(request.params?.capabilities) ? request.params.capabilities.filter((item): item is PluginHostCapability => typeof item === 'string') : [];
          result = await active.context({
            projectId: String(request.params?.projectId ?? ''), sessionId: String(request.params?.sessionId ?? ''), agentId: String(request.params?.agentId ?? ''),
            settings, host: createHost(invocationId, capabilities),
          });
        } else result = await active.context({
          projectRoot: String(request.params?.projectRoot ?? ''),
          sessionId: String(request.params?.sessionId ?? ''),
          agentId: String(request.params?.agentId ?? ''),
          settings,
        });
      } else if (request.method === 'workflow.run') {
        const active = await loadPlugin();
        if (active.apiVersion === 1) throw new Error('Plugin API v1 不支持持久化工作流');
        const workflowId = String(request.params?.workflowId ?? '');
        const workflow = active.workflows?.find((candidate) => candidate.definition.id === workflowId);
        if (!workflow) throw new Error(`插件工作流不存在：${workflowId}`);
        const context = (request.params?.context ?? {}) as Record<string, unknown>;
        const invocationId = String(context.invocationId ?? '');
        const capabilities = Array.isArray(context.capabilities) ? context.capabilities.filter((item): item is PluginHostCapability => typeof item === 'string') : [];
        result = await withInvocationSignal(invocationId, async (signal) => await workflow.run((request.params?.input ?? {}) as Record<string, JsonValue>, {
          projectId: String(context.projectId ?? ''), sessionId: String(context.sessionId ?? ''), agentId: String(context.agentId ?? ''),
          traceId: String(context.traceId ?? ''), jobId: String(context.jobId ?? ''), resume: context.resume === true,
          ...(typeof context.worktableInstanceId === 'string' ? { worktableInstanceId: context.worktableInstanceId } : {}),
          settings, host: createHost(invocationId, capabilities), signal,
        }));
      } else if (request.method === 'dispose') {
        await plugin?.dispose?.();
        result = true;
        send({ jsonrpc: '2.0', id: request.id, result });
        process.exitCode = 0;
        reader.close();
        return;
      } else throw new Error(`未知 RPC 方法：${request.method}`);
      send({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32_000, message: error instanceof Error ? error.message : String(error) } });
    }
  })();
});
