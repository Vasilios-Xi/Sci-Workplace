import { randomUUID } from 'node:crypto';
import type {
  ArtifactRevision,
  EventActor,
  GeneratedWorktableApp,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { isRecord, toJson } from '../util/json.js';

const HOST_CAPABILITIES = new Set([
  'worktable:read',
  'annotations:read',
  'annotations:write',
  'artifacts:read',
  'research:read',
]);

function normalizeEntry(value: string): string {
  const entry = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!entry || entry.length > 400 || entry.startsWith('/') || entry.split('/').some((part) => !part || part === '.' || part === '..') || /[:\0]/u.test(entry)) throw new Error('Generated app entry is invalid');
  if (!/\.html?$/iu.test(entry)) throw new Error('Generated apps require a static HTML entry');
  return entry;
}

function normalizeDomains(values: string[]): string[] {
  if (values.length > 32) throw new Error('Generated app network domain limit exceeded');
  return [...new Set(values.map((value) => {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Generated app domains must be HTTPS origins without credentials or ports');
    return url.hostname.toLocaleLowerCase();
  }))];
}

function verifyRevision(revision: ArtifactRevision, entry: string): void {
  const candidates = revision.files.filter((file) => file.role === 'output' || file.role === 'source');
  if (!candidates.some((file) => file.name.replaceAll('\\', '/') === entry || file.ref?.path.replaceAll('\\', '/').endsWith(`/${entry}`) || file.ref?.path.replaceAll('\\', '/') === entry)) throw new Error('Generated app entry is not present in the artifact revision');
  if (candidates.some((file) => /\.(?:exe|dll|com|bat|cmd|ps1|msi|node)$/iu.test(file.name))) throw new Error('Generated apps cannot publish executable files');
}

function normalizeStaticPath(value: string): string {
  const path = value.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
  if (!path || path.length > 800 || path.split('/').some((part) => !part || part === '.' || part === '..') || /[:\0]/u.test(path)) throw new Error('Generated app asset path is invalid');
  return path;
}

export interface GeneratedAppStaticFile {
  app: GeneratedWorktableApp;
  revision: ArtifactRevision;
  file: ArtifactRevision['files'][number];
  path: string;
}

export class GeneratedAppService {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #resolveRevision: (id: string) => ArtifactRevision | undefined;
  readonly #apps = new Map<string, GeneratedWorktableApp>();

  constructor(options: {
    projectId: string;
    events: SqliteEventStore;
    resolveRevision(id: string): ArtifactRevision | undefined;
  }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.#resolveRevision = options.resolveRevision;
    this.replay();
  }

  list(): GeneratedWorktableApp[] {
    return [...this.#apps.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map((app) => structuredClone(app));
  }

  get(id: string): GeneratedWorktableApp {
    const app = this.#apps.get(id);
    if (!app) throw new Error('Generated app does not exist');
    return structuredClone(app);
  }

  publish(input: {
    title: string;
    artifactId: string;
    revisionId: string;
    entry: string;
    networkDomains?: string[];
    hostCapabilities?: string[];
  }, actor: EventActor): GeneratedWorktableApp {
    const revision = this.#resolveRevision(input.revisionId);
    if (!revision || revision.artifactId !== input.artifactId) throw new Error('Generated app artifact revision is unavailable');
    const entry = normalizeEntry(input.entry);
    verifyRevision(revision, entry);
    const networkDomains = normalizeDomains(input.networkDomains ?? []);
    const hostCapabilities = [...new Set(input.hostCapabilities ?? [])];
    if (hostCapabilities.some((capability) => !HOST_CAPABILITIES.has(capability))) throw new Error('Generated app requested an unsupported host capability');
    const now = new Date().toISOString();
    const app: GeneratedWorktableApp = {
      id: randomUUID(),
      projectId: this.#projectId,
      title: input.title.trim().slice(0, 200) || 'Generated app',
      artifactId: revision.artifactId,
      activeRevisionId: revision.id,
      entry,
      networkDomains,
      hostCapabilities,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    this.#apps.set(app.id, app);
    this.record('generated-app.published', app, actor, [revision.id, revision.artifactId]);
    return structuredClone(app);
  }

  update(id: string, revisionId: string, actor: EventActor): GeneratedWorktableApp {
    const previous = this.get(id);
    const revision = this.#resolveRevision(revisionId);
    if (!revision || revision.artifactId !== previous.artifactId) throw new Error('Generated app update revision is unavailable');
    verifyRevision(revision, previous.entry);
    const next: GeneratedWorktableApp = { ...previous, activeRevisionId: revision.id, status: 'ready', updatedAt: new Date().toISOString() };
    this.#apps.set(id, next);
    this.record('generated-app.updated', next, actor, [revision.id, previous.activeRevisionId]);
    return structuredClone(next);
  }

  markFailed(id: string, actor: EventActor): GeneratedWorktableApp {
    const previous = this.get(id);
    const next: GeneratedWorktableApp = { ...previous, status: 'failed', updatedAt: new Date().toISOString() };
    this.#apps.set(id, next);
    this.record('generated-app.failed', next, actor, [previous.activeRevisionId]);
    return structuredClone(next);
  }

  archive(id: string, actor: EventActor): GeneratedWorktableApp {
    const previous = this.get(id);
    const next: GeneratedWorktableApp = { ...previous, status: 'archived', updatedAt: new Date().toISOString() };
    this.#apps.set(id, next);
    this.record('generated-app.archived', next, actor, [previous.activeRevisionId]);
    return structuredClone(next);
  }

  resolveStaticFile(appId: string, revisionId: string, requestPath: string): GeneratedAppStaticFile {
    const app = this.get(appId);
    if (app.status !== 'ready' || app.activeRevisionId !== revisionId) throw new Error('Generated app revision is not active');
    const revision = this.#resolveRevision(revisionId);
    if (!revision || revision.artifactId !== app.artifactId) throw new Error('Generated app artifact revision is unavailable');
    verifyRevision(revision, app.entry);
    const path = normalizeStaticPath(requestPath);
    const candidates = revision.files
      .filter((file) => file.role === 'output' || file.role === 'source')
      .filter((file) => normalizeStaticPath(file.name) === path)
      .sort((left, right) => Number(right.role === 'output') - Number(left.role === 'output'));
    const file = candidates[0];
    if (!file) throw new Error('Generated app asset is not part of the published revision');
    if (/\.(?:exe|dll|com|bat|cmd|ps1|msi|node)$/iu.test(file.name)) throw new Error('Generated app asset type is forbidden');
    return { app, revision, file: structuredClone(file), path };
  }

  private record(kind: string, app: GeneratedWorktableApp, actor: EventActor, provenanceRefs: string[]): void {
    this.#events.append({ streamId: `project:${this.#projectId}`, kind, actor, provenanceRefs, payload: toJson(app) });
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (!event.kind.startsWith('generated-app.') || !isRecord(event.payload) || typeof event.payload.id !== 'string') continue;
      this.#apps.set(event.payload.id, structuredClone(event.payload as unknown as GeneratedWorktableApp));
    }
  }
}
