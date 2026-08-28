export type PluginPanelBridgeMethod = 'context.read' | 'tool.execute' | 'evidence.reveal' | 'resource.open';

export interface PluginPanelBridgeRequest {
  id: string;
  token: string;
  method: PluginPanelBridgeMethod;
  params: Record<string, unknown>;
}

interface PluginPanelMessageTarget {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

const methods = new Set<PluginPanelBridgeMethod>(['context.read', 'tool.execute', 'evidence.reveal', 'resource.open']);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Plugin panels have an opaque origin because the iframe omits allow-same-origin. */
export function connectPluginPanel(target: PluginPanelMessageTarget, token: string, port: MessagePort): void {
  target.postMessage({
    type: 'openlab.plugin-panel.connect',
    token,
    methods: [...methods],
  }, '*', [port]);
}

export function parsePluginPanelRequest(value: unknown, token: string): PluginPanelBridgeRequest | undefined {
  if (!record(value) || value.token !== token || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 128) return undefined;
  if (typeof value.method !== 'string' || !methods.has(value.method as PluginPanelBridgeMethod)) return undefined;
  const params = value.params === undefined ? {} : value.params;
  if (!record(params)) return undefined;
  try {
    if (JSON.stringify(value).length > 128 * 1024) return undefined;
  } catch {
    return undefined;
  }
  return { id: value.id, token, method: value.method as PluginPanelBridgeMethod, params };
}
