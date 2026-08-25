import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { isAbsolute, relative, resolve } from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const root = process.argv[2];
const contract = process.argv[3];
if (!root || !contract) throw new Error('Plugin contract runner requires root and contract path');
const resolvedRoot = resolve(root);
const resolvedContract = resolve(contract);
const rel = relative(resolvedRoot, resolvedContract);
if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('插件契约测试越过候选目录');

if (process.env.OPENLAB_PLUGIN_NETWORK !== '1') {
  const denied = () => { throw new Error('插件未获得 network 权限'); };
  globalThis.fetch = denied as typeof globalThis.fetch;
  if ('WebSocket' in globalThis) globalThis.WebSocket = denied as unknown as typeof globalThis.WebSocket;
  const patch = (target: object, names: string[]) => {
    for (const name of names) if (name in target) (target as Record<string, unknown>)[name] = denied;
  };
  patch(http, ['request', 'get']);
  patch(https, ['request', 'get']);
  patch(net, ['connect', 'createConnection']);
  patch(tls, ['connect']);
  patch(dgram, ['createSocket']);
  patch(dns, ['lookup', 'resolve', 'resolve4', 'resolve6']);
  syncBuiltinESMExports();
}

const gate = createInterface({ input: process.stdin, crlfDelay: Infinity });
await new Promise<void>((resolvePromise, reject) => {
  gate.once('line', (line) => line === 'START' ? resolvePromise() : reject(new Error('插件契约启动握手无效')));
  gate.once('close', () => reject(new Error('插件契约启动握手缺失')));
});
gate.close();
await import(pathToFileURL(resolvedContract).href);
process.stdout.write('Sci Workplace plugin contract: ok\n');
