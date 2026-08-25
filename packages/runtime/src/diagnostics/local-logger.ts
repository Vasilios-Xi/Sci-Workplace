import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_KEY = /api.?key|authorization|password|secret|token|credential/iu;
const SECRET_VALUE = /\b(?:sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/giu;
const LOCAL_PATH_KEY = /^(?:absolutePath|displayPath|projectRoot|rootPath|sourcePath|destination)$/u;

export function redactSensitive(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (LOCAL_PATH_KEY.test(key)) return '[LOCAL_PATH]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE, (match) => match.startsWith('Bearer') ? 'Bearer [REDACTED]' : 'sk-[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const nestedRoot = typeof record.root === 'object' && record.root !== null ? record.root as Record<string, unknown> : undefined;
    const rootId = typeof record.rootId === 'string' ? record.rootId : typeof record.id === 'string' ? record.id : typeof nestedRoot?.id === 'string' ? nestedRoot.id : undefined;
    return Object.fromEntries(Object.entries(record).map(([childKey, child]) => [
      childKey,
      LOCAL_PATH_KEY.test(childKey) ? (rootId ? `<root:${rootId}>` : '[LOCAL_PATH]') : redactSensitive(child, childKey),
    ]));
  }
  return value;
}

export interface LocalLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  data: unknown;
}

export class LocalLogger {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
    mkdirSync(root, { recursive: true });
  }

  info(event: string, data: unknown = {}): void { this.write('info', event, data); }
  warn(event: string, data: unknown = {}): void { this.write('warn', event, data); }
  error(event: string, data: unknown = {}): void { this.write('error', event, data); }

  files(): string[] {
    if (!existsSync(this.#root)) return [];
    return readdirSync(this.#root).filter((name) => /^openlab-.*\.jsonl$/u.test(name)).sort();
  }

  tail(limit = 300): LocalLogEntry[] {
    const entries: LocalLogEntry[] = [];
    for (const file of this.files().slice(-7)) {
      const lines = readFileSync(join(this.#root, file), 'utf8').split(/\r?\n/u).filter(Boolean);
      for (const line of lines.slice(-limit)) {
        try { entries.push(JSON.parse(line) as LocalLogEntry); } catch { /* skip partial crash-write */ }
      }
    }
    return entries.slice(-limit);
  }

  private write(level: LocalLogEntry['level'], event: string, data: unknown): void {
    try {
      const day = new Date().toISOString().slice(0, 10);
      let path = join(this.#root, `openlab-${day}.jsonl`);
      if (existsSync(path) && statSync(path).size > 5 * 1024 * 1024) path = join(this.#root, `openlab-${day}-${Date.now()}.jsonl`);
      const entry: LocalLogEntry = { timestamp: new Date().toISOString(), level, event, data: redactSensitive(data) };
      appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch { /* diagnostics must never take down the harness */ }
  }
}
