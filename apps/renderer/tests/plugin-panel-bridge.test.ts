import { describe, expect, it } from 'vitest';
import { connectPluginPanel, parsePluginPanelRequest } from '../src/lib/plugin-panel-bridge.js';

describe('plugin panel host bridge', () => {
  it('transfers a one-time MessagePort into the opaque-origin sandbox', () => {
    const calls: unknown[][] = [];
    const target = { postMessage: (...args: unknown[]) => calls.push(args) };
    const channel = new MessageChannel();
    connectPluginPanel(target, 'panel-token', channel.port2);
    expect(calls).toEqual([[
      { type: 'openlab.plugin-panel.connect', token: 'panel-token', methods: ['context.read', 'tool.execute', 'evidence.reveal'] },
      '*',
      [channel.port2],
    ]]);
    channel.port1.close();
    channel.port2.close();
  });

  it('accepts only bounded, token-bound structured methods', () => {
    expect(parsePluginPanelRequest({ id: '1', token: 'panel-token', method: 'context.read', params: {} }, 'panel-token')).toMatchObject({ id: '1', method: 'context.read' });
    expect(parsePluginPanelRequest({ id: '1', token: 'forged', method: 'context.read', params: {} }, 'panel-token')).toBeUndefined();
    expect(parsePluginPanelRequest({ id: '1', token: 'panel-token', method: 'filesystem.read', params: {} }, 'panel-token')).toBeUndefined();
    expect(parsePluginPanelRequest({ id: '1', token: 'panel-token', method: 'tool.execute', params: [] }, 'panel-token')).toBeUndefined();
    expect(parsePluginPanelRequest({ id: '1', token: 'panel-token', method: 'tool.execute', params: { value: 'x'.repeat(129 * 1024) } }, 'panel-token')).toBeUndefined();
  });
});
