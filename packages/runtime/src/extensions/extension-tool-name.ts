import { createHash } from 'node:crypto';

function safeComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/gu, '_').replace(/_+/gu, '_').replace(/^_+|_+$/gu, '') || 'unnamed';
}

export function namespacedToolName(kind: 'plugin' | 'mcp', sourceId: string, localName: string): string {
  const source = safeComponent(sourceId);
  const local = safeComponent(localName);
  const readable = `${kind}__${source}__${local}`;
  if (readable.length <= 64) return readable;
  const digest = createHash('sha256').update(`${sourceId}\0${localName}`).digest('hex').slice(0, 10);
  const prefix = `${kind}__${source.slice(0, 14)}_${digest}__`;
  return `${prefix}${local.slice(0, Math.max(1, 64 - prefix.length))}`;
}
