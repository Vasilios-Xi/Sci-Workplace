import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { defaultOpenLabHome, type RuntimeConfig } from './config.js';
import { OpenLabRuntime } from './runtime.js';
import { startRuntimeServer, type RuntimeServer } from './server/runtime-server.js';

type ParentMessage =
  | { type: 'start'; config: RuntimeConfig }
  | { type: 'provider-key'; apiKey?: string }
  | { type: 'shutdown' };

let runtime: OpenLabRuntime | undefined;
let server: RuntimeServer | undefined;

async function start(config: RuntimeConfig): Promise<void> {
  if (runtime) throw new Error('Runtime already started');
  runtime = new OpenLabRuntime(config);
  await runtime.initialize();
  server = await startRuntimeServer(runtime, { host: config.host, port: config.port, authToken: config.authToken });
  process.send?.({ type: 'ready', port: server.port, url: server.url, authToken: config.authToken, status: runtime.status() });
}

async function shutdown(): Promise<void> {
  await server?.close().catch(() => undefined);
  await runtime?.stop().catch(() => undefined);
  server = undefined;
  runtime = undefined;
}

process.on('message', (message: ParentMessage) => {
  void (async () => {
    if (message.type === 'start') await start(message.config);
    else if (message.type === 'provider-key') await runtime?.setDeepSeekApiKey(message.apiKey);
    else if (message.type === 'shutdown') { await shutdown(); process.exit(0); }
  })().catch((error) => process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
});

process.on('disconnect', () => { void shutdown().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
process.on('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });

if (!process.send) {
  const config: RuntimeConfig = {
    host: '127.0.0.1',
    port: Number(process.env.OPENLAB_RUNTIME_PORT ?? 0),
    authToken: process.env.OPENLAB_RUNTIME_TOKEN ?? randomBytes(32).toString('hex'),
    projectRoot: resolve(process.env.OPENLAB_PROJECT_ROOT ?? process.cwd()),
    home: resolve(process.env.OPENLAB_HOME ?? defaultOpenLabHome()),
    demo: process.env.OPENLAB_DEMO !== '0',
  };
  await start(config);
  process.stdout.write(`${JSON.stringify({ type: 'ready', port: server?.port, url: server?.url, authToken: config.authToken })}\n`);
}
