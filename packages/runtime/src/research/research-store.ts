import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join, relative } from 'node:path';
import type {
  ArtifactProvenance,
  EventActor,
  JsonValue,
  ResearchObject,
  ResearchObjectStatus,
  ResearchObjectType,
  ResearchRelation,
  ResearchRelationPredicate,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { PathGuard } from '../security/path-guard.js';
import { atomicWriteJson, readJsonProjection } from '../util/files.js';
import { isRecord, toJson } from '../util/json.js';

interface ResearchState {
  schemaVersion: 1;
  objects: ResearchObject[];
  relations: ResearchRelation[];
}

export interface CreateResearchObjectInput {
  type: ResearchObjectType;
  title: string;
  status?: ResearchObjectStatus;
  attributes?: Record<string, JsonValue>;
  attachments?: ResearchObject['attachments'];
}

export interface CreateResearchRelationInput {
  fromId: string;
  predicate: ResearchRelationPredicate;
  toId: string;
  evidenceIds?: string[];
}

export interface RegisterArtifactInput {
  title?: string;
  relativePath: string;
  rootId?: string;
  attributes?: Record<string, JsonValue>;
  provenance: Omit<ArtifactProvenance, 'artifactId' | 'createdAt'>;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function researchObjectChecksum(object: Pick<ResearchObject, 'type' | 'title' | 'status' | 'attributes' | 'attachments'>): string {
  return createHash('sha256').update(canonicalJson({
    type: object.type,
    title: object.title,
    status: object.status,
    attributes: object.attributes,
    attachments: object.attachments,
  })).digest('hex');
}

function replayResearchState(events: ReturnType<SqliteEventStore['list']>): { state: ResearchState; replayed: boolean } {
  const objects = new Map<string, ResearchObject>();
  const relations = new Map<string, ResearchRelation>();
  let replayed = false;
  for (const event of events) {
    if ((event.kind === 'research_object.created' || event.kind === 'research_object.imported' || event.kind === 'research_object.recovered') && typeof event.payload === 'object' && event.payload !== null) {
      const object = event.payload as unknown as ResearchObject;
      if (typeof object.id === 'string') { objects.set(object.id, structuredClone(object)); replayed = true; }
    } else if (event.kind === 'research_object.updated' && typeof event.payload === 'object' && event.payload !== null) {
      const after = (event.payload as Record<string, unknown>).after as ResearchObject | undefined;
      if (after && typeof after.id === 'string') { objects.set(after.id, structuredClone(after)); replayed = true; }
    } else if ((event.kind === 'research_object.related' || event.kind === 'research_object.relation_imported') && typeof event.payload === 'object' && event.payload !== null) {
      const relation = event.payload as unknown as ResearchRelation;
      if (typeof relation.id === 'string') { relations.set(relation.id, structuredClone(relation)); replayed = true; }
    }
  }
  return { state: { schemaVersion: 1, objects: [...objects.values()], relations: [...relations.values()] }, replayed };
}

function provenanceKey(provenance: ArtifactProvenance): string {
  return `${provenance.artifactId}\u0000${provenance.traceId}\u0000${provenance.createdAt}`;
}

function isEventActor(value: unknown): value is EventActor {
  return isRecord(value) && typeof value.id === 'string' && typeof value.kind === 'string';
}

function isResearchObject(value: unknown): value is ResearchObject {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.projectId === 'string'
    && typeof value.type === 'string'
    && typeof value.title === 'string'
    && typeof value.status === 'string'
    && isRecord(value.attributes)
    && Array.isArray(value.attachments)
    && isEventActor(value.createdBy)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isResearchRelation(value: unknown): value is ResearchRelation {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.projectId === 'string'
    && typeof value.fromId === 'string'
    && typeof value.predicate === 'string'
    && typeof value.toId === 'string'
    && Array.isArray(value.evidenceIds)
    && value.evidenceIds.every((item) => typeof item === 'string')
    && typeof value.traceId === 'string'
    && isEventActor(value.createdBy)
    && typeof value.createdAt === 'string';
}

function isArtifactProvenance(value: unknown): value is ArtifactProvenance {
  return isRecord(value)
    && typeof value.artifactId === 'string'
    && typeof value.traceId === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.agentId === 'string'
    && Array.isArray(value.inputObjectIds)
    && value.inputObjectIds.every((item) => typeof item === 'string')
    && isRecord(value.inputFileHashes)
    && typeof value.createdAt === 'string';
}

function readProvenanceProjection(path: string): ArtifactProvenance[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as ArtifactProvenance]; }
    catch { return []; }
  });
}

export class ResearchStore {
  readonly #projectId: string;
  readonly #root: string;
  readonly #metadataRoot: string;
  readonly #statePath: string;
  readonly #provenancePath: string;
  readonly #events: SqliteEventStore;
  readonly #guard: PathGuard;
  readonly #resolveRoot: ((rootId: string) => string) | undefined;
  #state: ResearchState;

  constructor(options: { projectId: string; projectRoot: string; events: SqliteEventStore; resolveRoot?: (rootId: string) => string }) {
    this.#projectId = options.projectId;
    this.#root = options.projectRoot;
    this.#events = options.events;
    this.#guard = new PathGuard(options.projectRoot);
    this.#resolveRoot = options.resolveRoot;
    this.#metadataRoot = join(options.projectRoot, '.openlab');
    this.#statePath = join(this.#metadataRoot, 'research.json');
    this.#provenancePath = join(this.#metadataRoot, 'provenance.jsonl');
    mkdirSync(this.#metadataRoot, { recursive: true });
    const emptyState: ResearchState = { schemaVersion: 1, objects: [], relations: [] };
    const loadedValue = readJsonProjection<ResearchState>(this.#statePath, emptyState);
    const loaded: ResearchState = {
      schemaVersion: 1,
      objects: Array.isArray(loadedValue?.objects) ? loadedValue.objects.filter(isResearchObject) : [],
      relations: Array.isArray(loadedValue?.relations) ? loadedValue.relations.filter(isResearchRelation) : [],
    };
    const streamId = `project:${this.#projectId}`;
    const replay = replayResearchState(this.#events.list(streamId));
    const objects = new Map<string, ResearchObject>();
    for (const candidate of replay.state.objects) {
      const object = typeof candidate.checksum === 'string' && /^[a-f0-9]{64}$/u.test(candidate.checksum)
        ? candidate
        : { ...candidate, checksum: researchObjectChecksum(candidate) };
      objects.set(object.id, object);
      if (object !== candidate) this.#events.append({
        streamId, kind: 'research_object.recovered', actor: candidate.createdBy,
        timestamp: candidate.updatedAt, payload: toJson(object),
      });
    }
    for (const candidate of loaded.objects) {
      if (!candidate || typeof candidate.id !== 'string') continue;
      const object = typeof candidate.checksum === 'string' && /^[a-f0-9]{64}$/u.test(candidate.checksum)
        ? candidate
        : { ...candidate, checksum: researchObjectChecksum(candidate) };
      const current = objects.get(object.id);
      if (current && current.updatedAt >= object.updatedAt) continue;
      objects.set(object.id, object);
      this.#events.append({
        streamId, kind: current ? 'research_object.recovered' : 'research_object.imported', actor: object.createdBy,
        timestamp: object.updatedAt, payload: toJson(object),
      });
    }
    const relations = new Map(replay.state.relations.map((relation) => [relation.id, relation]));
    for (const relation of loaded.relations) {
      if (!relation || typeof relation.id !== 'string' || relations.has(relation.id)) continue;
      relations.set(relation.id, relation);
      this.#events.append({
        streamId, kind: 'research_object.relation_imported', actor: relation.createdBy,
        traceId: relation.traceId, timestamp: relation.createdAt, payload: toJson(relation),
      });
    }
    this.#state = { schemaVersion: 1, objects: [...objects.values()], relations: [...relations.values()] };
    this.persist();

    const provenanceEvents = this.#events.list(streamId)
      .filter((event) => (event.kind === 'artifact.provenance_recorded' || event.kind === 'artifact.provenance_imported') && typeof event.payload === 'object' && event.payload !== null);
    const knownProvenance = new Set(provenanceEvents.map((event) => provenanceKey(event.payload as unknown as ArtifactProvenance)));
    for (const provenance of readProvenanceProjection(this.#provenancePath)) {
      if (!isArtifactProvenance(provenance)) continue;
      const key = provenanceKey(provenance);
      if (knownProvenance.has(key)) continue;
      knownProvenance.add(key);
      this.#events.append({
        streamId: `project:${this.#projectId}`, kind: 'artifact.provenance_imported', actor: { id: provenance.agentId, kind: 'agent' },
        agentId: provenance.agentId, traceId: provenance.traceId, timestamp: provenance.createdAt,
        provenanceRefs: [provenance.artifactId, ...provenance.inputObjectIds], payload: toJson(provenance),
      });
    }
  }

  listObjects(): ResearchObject[] {
    return structuredClone(this.#state.objects);
  }

  listRelations(): ResearchRelation[] {
    return structuredClone(this.#state.relations);
  }

  getObject(id: string): ResearchObject | undefined {
    const object = this.#state.objects.find((item) => item.id === id);
    return object ? structuredClone(object) : undefined;
  }

  createObject(input: CreateResearchObjectInput, actor: EventActor, traceId: string = randomUUID()): ResearchObject {
    if (!input.title.trim()) throw new Error('科研对象标题不能为空');
    const now = new Date().toISOString();
    const base = {
      id: randomUUID(),
      projectId: this.#projectId,
      type: input.type,
      title: input.title.trim(),
      status: input.status ?? 'active',
      attributes: input.attributes ?? {},
      attachments: input.attachments ?? [],
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    };
    const object: ResearchObject = { ...base, checksum: researchObjectChecksum(base) };
    this.#state.objects.push(object);
    this.persist();
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'research_object.created',
      actor,
      traceId,
      payload: toJson(object),
    });
    return structuredClone(object);
  }

  updateObject(id: string, patch: Partial<Pick<ResearchObject, 'title' | 'status' | 'attributes' | 'attachments'>>, actor: EventActor, traceId: string = randomUUID()): ResearchObject {
    const index = this.#state.objects.findIndex((item) => item.id === id);
    const previous = this.#state.objects[index];
    if (index < 0 || !previous) throw new Error(`科研对象不存在：${id}`);
    const base = {
      ...previous,
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.attributes !== undefined ? { attributes: patch.attributes } : {}),
      ...(patch.attachments !== undefined ? { attachments: patch.attachments } : {}),
      updatedAt: new Date().toISOString(),
    };
    const updated: ResearchObject = { ...base, checksum: researchObjectChecksum(base) };
    this.#state.objects[index] = updated;
    this.persist();
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'research_object.updated',
      actor,
      traceId,
      payload: toJson({ before: previous, after: updated }),
    });
    return structuredClone(updated);
  }

  createRelation(input: CreateResearchRelationInput, actor: EventActor, traceId: string = randomUUID()): ResearchRelation {
    if (!this.#state.objects.some((item) => item.id === input.fromId)) throw new Error(`起点对象不存在：${input.fromId}`);
    if (!this.#state.objects.some((item) => item.id === input.toId)) throw new Error(`终点对象不存在：${input.toId}`);
    const relation: ResearchRelation = {
      id: randomUUID(),
      projectId: this.#projectId,
      fromId: input.fromId,
      predicate: input.predicate,
      toId: input.toId,
      evidenceIds: input.evidenceIds ?? [],
      traceId,
      createdBy: actor,
      createdAt: new Date().toISOString(),
    };
    this.#state.relations.push(relation);
    this.persist();
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'research_object.related',
      actor,
      traceId,
      payload: toJson(relation),
    });
    return structuredClone(relation);
  }

  registerArtifact(input: RegisterArtifactInput, actor: EventActor): { object: ResearchObject; provenance: ArtifactProvenance } {
    const rootId = input.rootId ?? 'project';
    const root = this.#resolveRoot ? this.#resolveRoot(rootId) : this.#root;
    const absolute = rootId === 'project' && !this.#resolveRoot ? this.#guard.resolveExisting(input.relativePath) : new PathGuard(root).resolveExisting(input.relativePath);
    if (!statSync(absolute).isFile()) throw new Error('只能把文件登记为产物');
    const relativePath = relative(root, absolute).replaceAll('\\', '/');
    const sha256 = sha256File(absolute);
    const object = this.createObject({
      type: 'artifact',
      title: input.title?.trim() || basename(absolute),
      attributes: { ...(input.attributes ?? {}), sha256, size: statSync(absolute).size },
      attachments: [{ id: randomUUID(), name: basename(absolute), ...(rootId !== 'project' ? { rootId } : {}), relativePath, sha256, size: statSync(absolute).size }],
    }, actor, input.provenance.traceId);
    const provenance: ArtifactProvenance = {
      ...input.provenance,
      artifactId: object.id,
      createdAt: new Date().toISOString(),
    };
    mkdirSync(this.#metadataRoot, { recursive: true });
    appendFileSync(this.#provenancePath, `${JSON.stringify(provenance)}\n`, 'utf8');
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind: 'artifact.provenance_recorded',
      actor,
      agentId: provenance.agentId,
      traceId: provenance.traceId,
      provenanceRefs: [object.id, ...provenance.inputObjectIds],
      payload: toJson(provenance),
    });
    return { object, provenance };
  }

  listProvenance(): ArtifactProvenance[] {
    const replayed = this.#events.list(`project:${this.#projectId}`)
      .filter((event) => (event.kind === 'artifact.provenance_recorded' || event.kind === 'artifact.provenance_imported') && typeof event.payload === 'object' && event.payload !== null)
      .flatMap((event) => {
        const provenance = event.payload as unknown as ArtifactProvenance;
        return typeof provenance.artifactId === 'string' && typeof provenance.traceId === 'string' ? [structuredClone(provenance)] : [];
      });
    return replayed.length > 0 ? replayed : readProvenanceProjection(this.#provenancePath);
  }

  private persist(): void {
    atomicWriteJson(this.#statePath, this.#state);
  }
}
