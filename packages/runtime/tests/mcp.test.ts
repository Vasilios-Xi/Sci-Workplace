import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpManager } from '../src/extensions/mcp-manager.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';

describe('MCP integration', () => {
  it('registers stdio tools and resources through the unified registry and removes them on disconnect', async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager({
      registry,
      resolveCredential: (id) => id === 'credential-id' ? 'fixture-secret' : undefined,
    });
    const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
    await manager.connect({
      id: 'fixture',
      name: 'Fixture MCP',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      envCredentialRefs: { OPENLAB_MCP_TEST_TOKEN: 'credential-id' },
      enabled: true,
    });

    expect(manager.isConnected('fixture')).toBe(true);
    const probe = registry.require('mcp__fixture__credential_probe');
    expect(probe.definition).toMatchObject({ source: 'mcp', sourceId: 'fixture', risk: 'external' });
    const context = {
      projectRoot: process.cwd(), sessionId: 'session', agentId: 'agent', traceId: 'trace', callId: 'call',
      signal: new AbortController().signal,
      provenance: { traceId: 'trace', sessionId: 'session', agentId: 'agent', inputObjectIds: [], inputFileHashes: {} },
    };
    await expect(probe.execute({}, context)).resolves.toMatchObject({ ok: true, content: 'credential-ok' });
    await expect(registry.require('mcp__fixture__list_resources').execute({}, context)).resolves.toMatchObject({ ok: true, metadata: { count: 1 } });
    await expect(registry.require('mcp__fixture__read_resource').execute({ uri: 'fixture://research/evidence' }, context)).resolves.toMatchObject({
      ok: true,
      content: 'external evidence payload',
    });
    await expect(manager.listResources('fixture')).resolves.toEqual([{ uri: 'fixture://research/evidence', name: 'fixture-resource' }]);
    await expect(manager.readResource('fixture', 'fixture://research/evidence')).resolves.toEqual({
      uri: 'fixture://research/evidence',
      content: 'external evidence payload',
      parts: 1,
      truncated: false,
    });

    await manager.disconnect('fixture');
    expect(manager.isConnected('fixture')).toBe(false);
    expect(() => registry.require('mcp__fixture__credential_probe')).toThrow();
  }, 20_000);

  it('closes a connected transport when capability discovery fails', async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager({ registry, resolveCredential: () => undefined });
    const fixture = fileURLToPath(new URL('./fixtures/mcp-list-tools-failure.mjs', import.meta.url));
    await expect(manager.connect({
      id: 'failure-fixture', name: 'Failure fixture', transport: 'stdio',
      command: process.execPath, args: [fixture], envCredentialRefs: {}, enabled: true,
    })).rejects.toThrow(/intentional listTools failure/u);
    expect(manager.isConnected('failure-fixture')).toBe(false);
    expect(registry.definitions()).toHaveLength(0);
    await manager.stop();
  }, 20_000);

  it('connects to Streamable HTTP with credential references and exposes its tools', async () => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
    const server = new McpServer({ name: 'openlab-http-fixture', version: '1.0.0' });
    server.registerTool('http_probe', { description: 'HTTP transport probe' }, async () => ({
      content: [{ type: 'text', text: 'http-ok' }],
    }));
    await server.connect(transport);
    const serverErrors: string[] = [];
    transport.onerror = (error) => { serverErrors.push(error.message); };
    const seenRequests: string[] = [];
    const http = createServer(async (request, response) => {
      const requestIndex = seenRequests.push(`${request.method ?? '?'} ${request.url ?? '?'} auth=${request.headers.authorization ?? 'missing'}`) - 1;
      response.once('finish', () => { seenRequests[requestIndex] += ` status=${response.statusCode}`; });
      if (request.headers.authorization !== 'Bearer fixture-secret') {
        response.writeHead(401).end();
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString('utf8');
        seenRequests[requestIndex] += ` body=${raw}`;
        await transport.handleRequest(request, response, raw ? JSON.parse(raw) : undefined);
      } catch (error) {
        serverErrors.push(error instanceof Error ? error.message : String(error));
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    });
    await new Promise<void>((resolvePromise) => http.listen(0, '127.0.0.1', resolvePromise));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('HTTP MCP fixture did not bind');

    const registry = new ToolRegistry();
    const manager = new McpManager({
      registry,
      resolveCredential: (id) => id === 'http-credential' ? 'Bearer fixture-secret' : undefined,
    });
    try {
      try {
        await manager.connect({
          id: 'http-fixture', name: 'HTTP fixture', transport: 'http',
          url: `http://127.0.0.1:${address.port}/mcp`,
          headerCredentialRefs: { Authorization: 'http-credential' }, enabled: true,
        });
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; server=${serverErrors.join(' | ')}; requests=${seenRequests.join(' | ')}`);
      }
      await expect(registry.require('mcp__http_fixture__http_probe').execute({}, {
        projectRoot: process.cwd(), sessionId: 'session', agentId: 'agent', traceId: 'trace', callId: 'call',
        signal: new AbortController().signal,
      })).resolves.toMatchObject({ content: 'http-ok', ok: true });
    } finally {
      await manager.stop();
      await transport.close();
      await new Promise<void>((resolvePromise, reject) => http.close((error) => error ? reject(error) : resolvePromise()));
    }
  }, 20_000);
});
