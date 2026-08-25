import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WorktableBrowserManager } from './browser-manager.js';
import { parseBrowserAutomationAction } from './browser-security.js';

const MAX_BODY_BYTES = 1024 * 1024;

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function body(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Browser broker request is too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Browser broker request must be an object');
  return parsed as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string, maximum = 4_096): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new Error(`Browser broker field ${key} is invalid`);
  return value;
}

function confirmed(input: Record<string, unknown>, action: 'upload' | 'download'): true {
  if (input.confirmed !== true) throw new Error(`Browser ${action} requires confirmation for this action`);
  return true;
}

function stringArray(input: Record<string, unknown>, key: string, maximum: number): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum || value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 200)) {
    throw new Error(`Browser broker field ${key} is invalid`);
  }
  return value as string[];
}

export class BrowserAutomationBroker {
  readonly token = randomBytes(32).toString('hex');
  readonly #manager: () => WorktableBrowserManager | undefined;
  #server: Server | undefined;
  #url = '';

  constructor(manager: () => WorktableBrowserManager | undefined) {
    this.#manager = manager;
  }

  async start(): Promise<{ url: string; token: string }> {
    if (this.#server) return { url: this.#url, token: this.token };
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    this.#server = server;
    this.#url = `http://127.0.0.1:${address.port}`;
    return { url: this.#url, token: this.token };
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (!authorized(request.headers.authorization, this.token)) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const manager = this.#manager();
    if (!manager) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: 'Browser host is unavailable' }));
      return;
    }
    try {
      const method = request.method ?? 'GET';
      const path = new URL(request.url ?? '/', this.#url).pathname;
      const screenshotResource = /^\/screenshots\/([a-zA-Z0-9_-]{1,128})$/u.exec(path);
      if (method === 'GET' && screenshotResource) {
        const result = manager.readScreenshot(screenshotResource[1]!);
        response.statusCode = 200;
        response.setHeader('Content-Type', result.resource.mediaType);
        response.setHeader('Content-Length', String(result.bytes.length));
        response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.end(result.bytes);
        return;
      }
      const input = await body(request);
      let output: unknown;
      if (method === 'GET' && path === '/state') output = { profiles: manager.profiles(), sessions: manager.sessions() };
      else if (method === 'POST' && path === '/open') output = await manager.open({
        profileId: requiredString(input, 'profileId', 200), projectId: requiredString(input, 'projectId', 200), instanceId: requiredString(input, 'instanceId', 200), paneId: requiredString(input, 'paneId', 200), url: requiredString(input, 'url'), confirmed: input.confirmed === true,
      });
      else if (method === 'POST' && path === '/navigate') output = await manager.navigate(requiredString(input, 'sessionId', 200), requiredString(input, 'url'), input.confirmed === true);
      else if (method === 'POST' && path === '/observe') output = await manager.observe(requiredString(input, 'sessionId', 200));
      else if (method === 'POST' && path === '/act') output = await manager.act({
        sessionId: requiredString(input, 'sessionId', 200), observationId: requiredString(input, 'observationId', 200),
        action: parseBrowserAutomationAction(input.action),
        ...(typeof input.ref === 'string' ? { ref: input.ref } : {}),
        ...(typeof input.value === 'string' ? { value: input.value } : {}),
        confirmed: input.confirmed === true,
      });
      else if (method === 'POST' && path === '/screenshot') output = await manager.screenshot(
        requiredString(input, 'sessionId', 200),
        requiredString(input, 'observationId', 200),
      );
      else if (method === 'POST' && path === '/upload') output = await manager.upload({
        sessionId: requiredString(input, 'sessionId', 200),
        observationId: requiredString(input, 'observationId', 200),
        ref: requiredString(input, 'ref', 200),
        uploadIds: stringArray(input, 'uploadIds', 10),
        confirmed: confirmed(input, 'upload'),
      });
      else if (method === 'POST' && path === '/download') output = await manager.download({
        sessionId: requiredString(input, 'sessionId', 200),
        observationId: requiredString(input, 'observationId', 200),
        ref: requiredString(input, 'ref', 200),
        confirmed: confirmed(input, 'download'),
      });
      else if (method === 'POST' && path === '/close') output = manager.close(requiredString(input, 'sessionId', 200));
      else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      response.statusCode = 200;
      response.end(JSON.stringify(output));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }
}
