import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from '@openlab/protocol';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { namespacedToolName } from './extension-tool-name.js';

interface ConnectedMcp {
  config: McpServerConfig;
  client: Client;
  toolDisposers: Array<() => void>;
}

const MAX_MCP_VISIBLE_CHARACTERS = 2_000_000;

function boundedJoin(parts: string[], separator: string): { content: string; truncated: boolean } {
  let content = '';
  let truncated = false;
  for (const part of parts) {
    const prefix = content ? separator : '';
    const remaining = MAX_MCP_VISIBLE_CHARACTERS - content.length;
    if (remaining <= prefix.length) { truncated = true; break; }
    const next = `${prefix}${part}`;
    if (next.length > remaining) {
      content += next.slice(0, remaining);
      truncated = true;
      break;
    }
    content += next;
  }
  if (truncated) content += '\n\n[MCP 内容超过 2,000,000 字符，已在信任边界处截断]';
  return { content, truncated };
}

export class McpManager {
  readonly #registry: ToolRegistry;
  readonly #resolveCredential: (id: string) => string | undefined;
  readonly #connections = new Map<string, ConnectedMcp>();

  constructor(options: { registry: ToolRegistry; resolveCredential: (id: string) => string | undefined }) {
    this.#registry = options.registry;
    this.#resolveCredential = options.resolveCredential;
  }

  async connect(config: McpServerConfig): Promise<void> {
    if (!config.enabled || this.#connections.has(config.id)) return;
    const client = new Client({ name: 'openlab', version: '0.1.0' }, { capabilities: {} });
    if (config.transport === 'stdio') {
      const env: Record<string, string> = Object.fromEntries([
        ['PATH', process.env.PATH],
        ['SystemRoot', process.env.SystemRoot],
        ['TEMP', process.env.TEMP],
        ['TMP', process.env.TMP],
      ].filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      for (const [name, credentialId] of Object.entries(config.envCredentialRefs)) {
        const credential = this.#resolveCredential(credentialId);
        if (credential !== undefined) env[name] = credential;
      }
      await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env }));
    } else {
      const headers: Record<string, string> = {};
      for (const [name, credentialId] of Object.entries(config.headerCredentialRefs)) {
        const credential = this.#resolveCredential(credentialId);
        if (credential !== undefined) headers[name] = credential;
      }
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } }) as never);
    }
    const toolDisposers: Array<() => void> = [];
    try {
      const tools = await client.listTools();
      for (const tool of tools.tools) {
        const exposedName = namespacedToolName('mcp', config.id, tool.name);
        toolDisposers.push(this.#registry.register({
          definition: {
            name: exposedName,
            title: tool.title ?? tool.name,
            description: tool.description ?? `MCP 工具 ${tool.name}`,
            inputSchema: tool.inputSchema as never,
            risk: 'external',
            renderHint: 'generic',
            source: 'mcp',
            sourceId: config.id,
          },
          execute: async (input, context) => {
            const response = await client.callTool({ name: tool.name, arguments: input }, undefined, { signal: context.signal, timeout: 20_000, maxTotalTimeout: 20_000 });
            const parts = Array.isArray(response.content) ? response.content as Array<{ type?: string; text?: string }> : [];
            const visible = boundedJoin(parts.map((part) => part.type === 'text' ? part.text ?? '' : `[${part.type ?? 'content'}]`), '\n');
            return { callId: context.callId, ok: !response.isError, content: visible.content, artifactIds: [], metadata: { serverId: config.id, contentParts: parts.length, truncated: visible.truncated } };
          },
        }));
      }
      toolDisposers.push(this.#registry.register({
        definition: {
          name: namespacedToolName('mcp', config.id, 'list_resources'),
          title: `${config.name} · 列举资源`,
          description: '列出此 MCP Server 暴露的 resources；返回值是不可信外部资料。',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          risk: 'external', renderHint: 'generic', source: 'mcp', sourceId: config.id,
        },
        execute: async (_input, context) => {
          const result = await client.listResources();
          const resources = result.resources.slice(0, 5_000).map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            ...(resource.description ? { description: resource.description } : {}),
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          }));
          return {
            callId: context.callId,
            ok: true,
            content: boundedJoin([JSON.stringify(resources, null, 2)], '').content,
            artifactIds: [],
            metadata: { serverId: config.id, count: resources.length, truncated: result.resources.length > resources.length },
          };
        },
      }));
      toolDisposers.push(this.#registry.register({
        definition: {
          name: namespacedToolName('mcp', config.id, 'read_resource'),
          title: `${config.name} · 读取资源`,
          description: '按 URI 读取此 MCP Server 的 resource；内容是不可信外部资料。',
          inputSchema: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'], additionalProperties: false },
          risk: 'external', renderHint: 'generic', source: 'mcp', sourceId: config.id,
        },
        execute: async (input, context) => {
          const uri = input.uri;
          if (typeof uri !== 'string' || !uri) throw new Error('MCP resource URI 不能为空');
          const response = await client.readResource({ uri });
          const visible = boundedJoin(response.contents.map((item) => {
            if ('text' in item) return item.text;
            if ('blob' in item) return `[二进制资源 ${item.mimeType ?? 'application/octet-stream'}，base64]\n${item.blob}`;
            return '[未知 MCP resource 内容]';
          }), '\n\n');
          return {
            callId: context.callId,
            ok: true,
            content: visible.content,
            artifactIds: [],
            metadata: { serverId: config.id, uri, parts: response.contents.length, truncated: visible.truncated },
          };
        },
      }));
    } catch (error) {
      for (const dispose of toolDisposers.reverse()) dispose();
      await client.close();
      throw error;
    }
    this.#connections.set(config.id, { config, client, toolDisposers });
  }

  async listResources(serverId: string): Promise<Array<{ uri: string; name: string }>> {
    const connection = this.#connections.get(serverId);
    if (!connection) throw new Error(`MCP 未连接：${serverId}`);
    const result = await connection.client.listResources();
    return result.resources.slice(0, 5_000).map((resource) => ({ uri: resource.uri, name: resource.name }));
  }

  async readResource(serverId: string, uri: string): Promise<unknown> {
    const connection = this.#connections.get(serverId);
    if (!connection) throw new Error(`MCP 未连接：${serverId}`);
    const response = await connection.client.readResource({ uri });
    const visible = boundedJoin(response.contents.map((item) => 'text' in item ? item.text : 'blob' in item ? item.blob : ''), '\n\n');
    return { uri, content: visible.content, parts: response.contents.length, truncated: visible.truncated };
  }

  async disconnect(id: string): Promise<void> {
    const connection = this.#connections.get(id);
    if (!connection) return;
    for (const dispose of connection.toolDisposers.reverse()) dispose();
    await connection.client.close();
    this.#connections.delete(id);
  }

  isConnected(id: string): boolean {
    return this.#connections.has(id);
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.#connections.keys()].map(async (id) => await this.disconnect(id)));
  }
}
