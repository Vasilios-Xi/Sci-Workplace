import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'openlab-mcp-fixture', version: '1.0.0' });

server.registerTool('credential_probe', {
  title: 'Credential probe',
  description: 'Returns whether the referenced credential reached the isolated server.',
}, async () => ({
  content: [{ type: 'text', text: process.env.OPENLAB_MCP_TEST_TOKEN === 'fixture-secret' ? 'credential-ok' : 'credential-missing' }],
}));

server.registerResource('fixture-resource', 'fixture://research/evidence', {
  mimeType: 'text/plain',
  description: 'Untrusted MCP fixture resource',
}, async () => ({
  contents: [{ uri: 'fixture://research/evidence', mimeType: 'text/plain', text: 'external evidence payload' }],
}));

await server.connect(new StdioServerTransport());
