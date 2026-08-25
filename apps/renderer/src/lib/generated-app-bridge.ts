import type {
  Annotation,
  AnnotationSelector,
  ArtifactRevision,
  BootstrapSnapshot,
  DocumentRevisionRef,
  GeneratedWorktableApp,
  JsonValue,
  WorktableInstance,
  WorktablePane,
  WorktableTab,
} from '@openlab/protocol';

export type GeneratedAppHostCapability =
  | 'worktable:read'
  | 'artifacts:read'
  | 'annotations:read'
  | 'annotations:write'
  | 'research:read';

export interface GeneratedAppBridgeRequest {
  id: string;
  token: string;
  method: string;
  params: Record<string, unknown>;
}

interface GeneratedAppMessageTarget {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

const METHOD_CAPABILITY: Readonly<Record<string, GeneratedAppHostCapability>> = {
  'worktable.read': 'worktable:read',
  'artifacts.read': 'artifacts:read',
  'annotations.read': 'annotations:read',
  'annotations.create': 'annotations:write',
  'research.read': 'research:read',
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalized(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
}

function safeString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim().length > 0);
}

function safeRect(value: unknown): { x: number; y: number; width: number; height: number } {
  if (!record(value) || !normalized(value.x) || !normalized(value.y) || !normalized(value.width) || !normalized(value.height) || value.x + value.width > 1.000001 || value.y + value.height > 1.000001) throw new Error('Invalid normalized annotation rectangle');
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function safeSelector(value: unknown): AnnotationSelector {
  if (!record(value) || typeof value.kind !== 'string') throw new Error('Invalid annotation selector');
  if (value.kind === 'image-point') {
    if (!normalized(value.x) || !normalized(value.y)) throw new Error('Invalid image point');
    return { kind: value.kind, x: value.x, y: value.y };
  }
  if (value.kind === 'image-rect') return { kind: value.kind, ...safeRect(value) };
  if (value.kind === 'pdf-rect' || value.kind === 'pdf-text') {
    if (!Number.isSafeInteger(value.page) || (value.page as number) < 1 || !Array.isArray(value.rects) || value.rects.length === 0 || value.rects.length > 128) throw new Error('Invalid PDF selector');
    const rects = value.rects.map(safeRect);
    if (value.kind === 'pdf-text') {
      if (!safeString(value.exact, 20_000)) throw new Error('Invalid PDF text selector');
      return { kind: value.kind, page: value.page as number, rects, exact: value.exact };
    }
    return { kind: value.kind, page: value.page as number, rects };
  }
  if (value.kind === 'document-anchor') {
    if (!safeString(value.scheme, 128) || !safeString(value.anchor, 4_096)) throw new Error('Invalid document anchor');
    if (value.start !== undefined && (!Number.isSafeInteger(value.start) || (value.start as number) < 0)) throw new Error('Invalid document anchor start');
    if (value.end !== undefined && (!Number.isSafeInteger(value.end) || (value.end as number) < 0)) throw new Error('Invalid document anchor end');
    if (value.exact !== undefined && !safeString(value.exact, 20_000, true)) throw new Error('Invalid document anchor text');
    return {
      kind: value.kind,
      scheme: value.scheme,
      anchor: value.anchor,
      ...(value.start !== undefined ? { start: value.start as number } : {}),
      ...(value.end !== undefined ? { end: value.end as number } : {}),
      ...(value.exact !== undefined ? { exact: value.exact } : {}),
    };
  }
  throw new Error('Unsupported annotation selector');
}

function targetKey(target: Pick<DocumentRevisionRef, 'ref' | 'sha256'>): string {
  return `${target.ref.rootId}:${target.ref.path.replaceAll('\\', '/')}:${target.sha256}`;
}

/** Only Runtime ticket URLs may receive a MessagePort. */
export function loopbackGeneratedAppOrigin(sourceUrl: string): string | undefined {
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) return undefined;
    if (url.username || url.password || !url.pathname.startsWith('/generated-apps/')) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function generatedAppCapabilityForMethod(method: string): GeneratedAppHostCapability | undefined {
  return METHOD_CAPABILITY[method];
}

export function parseGeneratedAppRequest(value: unknown, token: string): GeneratedAppBridgeRequest | undefined {
  if (!record(value) || value.token !== token || !safeString(value.id, 128) || !safeString(value.method, 128)) return undefined;
  const params = value.params === undefined ? {} : value.params;
  if (!record(params)) return undefined;
  try {
    if (JSON.stringify(value).length > 128 * 1024) return undefined;
  } catch {
    return undefined;
  }
  return { id: value.id, token, method: value.method, params };
}

export function generatedAppCapabilities(app: GeneratedWorktableApp): Set<GeneratedAppHostCapability> {
  return new Set(app.hostCapabilities.filter((value): value is GeneratedAppHostCapability => Object.values(METHOD_CAPABILITY).includes(value as GeneratedAppHostCapability)));
}

export function connectGeneratedApp(target: GeneratedAppMessageTarget, origin: string, token: string, capabilities: Iterable<GeneratedAppHostCapability>, port: MessagePort): void {
  target.postMessage({ type: 'openlab.generated-app.connect', token, capabilities: [...capabilities] }, origin, [port]);
}

export function generatedAppWorktableView(app: GeneratedWorktableApp, instance: WorktableInstance, pane: WorktablePane, tab: WorktableTab): JsonValue {
  return {
    app: { id: app.id, title: app.title, artifactId: app.artifactId, revisionId: app.activeRevisionId, status: app.status },
    instance: { id: instance.id, title: instance.title, status: instance.status, revision: instance.revision, activePaneId: instance.activePaneId ?? null },
    pane: { id: pane.id, activeTabId: pane.activeTabId ?? null },
    tab: { id: tab.id, title: tab.title, kind: tab.content.kind },
  };
}

export function generatedAppArtifactView(revision: ArtifactRevision): JsonValue {
  return {
    id: revision.id,
    artifactId: revision.artifactId,
    parentRevisionId: revision.parentRevisionId ?? null,
    status: revision.status,
    createdAt: revision.createdAt,
    files: revision.files.map((file) => ({ name: file.name, role: file.role, mediaType: file.mediaType ?? null, sha256: file.sha256, size: file.size })),
  };
}

export function generatedAppAnnotationView(annotation: Annotation, revision: ArtifactRevision): JsonValue {
  const file = revision.files.find((candidate) => candidate.ref && targetKey({ ref: candidate.ref, sha256: candidate.sha256 }) === targetKey(annotation.target));
  if (!file?.ref) throw new Error('Annotation target is outside the current artifact revision');
  return {
    id: annotation.id,
    file: file.name,
    sha256: annotation.target.sha256,
    selector: JSON.parse(JSON.stringify(annotation.selector)) as JsonValue,
    comments: annotation.comments.map((comment) => ({ content: comment.content, createdAt: comment.createdAt })),
    status: annotation.status,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
  };
}

export function generatedAppAnnotationsView(snapshot: BootstrapSnapshot, revision: ArtifactRevision): JsonValue {
  const keys = new Set(revision.files.flatMap((file) => file.ref ? [targetKey({ ref: file.ref, sha256: file.sha256 })] : []));
  return snapshot.annotations.filter((annotation) => keys.has(targetKey(annotation.target))).map((annotation) => generatedAppAnnotationView(annotation, revision));
}

export function generatedAppResearchView(snapshot: BootstrapSnapshot, app: GeneratedWorktableApp): JsonValue {
  const object = snapshot.researchObjects.find((candidate) => candidate.id === app.artifactId);
  return {
    object: object ? {
      id: object.id,
      type: object.type,
      title: object.title,
      status: object.status,
      // Arbitrary research attributes may contain user paths or credentials.
      // Generated apps receive the schema surface, not those unbounded values.
      attributeKeys: Object.keys(object.attributes).sort(),
      checksum: object.checksum,
      attachments: object.attachments.map((attachment) => ({ name: attachment.name, mediaType: attachment.mediaType ?? null, sha256: attachment.sha256 ?? null, size: attachment.size ?? null })),
      createdAt: object.createdAt,
      updatedAt: object.updatedAt,
    } : null,
    relations: snapshot.relations.filter((relation) => relation.fromId === app.artifactId || relation.toId === app.artifactId).map((relation) => ({ id: relation.id, fromId: relation.fromId, predicate: relation.predicate, toId: relation.toId, evidenceIds: relation.evidenceIds, createdAt: relation.createdAt })),
  };
}

/** Rebuilds a canonical target from the immutable revision instead of trusting iframe paths. */
export function generatedAppAnnotationInput(params: Record<string, unknown>, revision: ArtifactRevision): { target: DocumentRevisionRef; selector: AnnotationSelector; comment: string } {
  if (!record(params.target)) throw new Error('Annotation target is required');
  const proposed = params.target;
  if (!record(proposed.ref) || !safeString(proposed.ref.rootId, 200) || !safeString(proposed.ref.path, 2_000) || !safeString(proposed.sha256, 256)) throw new Error('Invalid annotation target');
  const key = targetKey({ ref: { rootId: proposed.ref.rootId, path: proposed.ref.path }, sha256: proposed.sha256 });
  const file = revision.files.find((candidate) => candidate.ref && targetKey({ ref: candidate.ref, sha256: candidate.sha256 }) === key);
  if (!file?.ref) throw new Error('Annotation target is outside the current artifact revision');
  if (!safeString(params.comment, 20_000)) throw new Error('Annotation comment is required');
  return {
    target: {
      ref: { rootId: file.ref.rootId, path: file.ref.path },
      sha256: file.sha256,
      ...(file.mediaType ? { mediaType: file.mediaType } : {}),
      artifactId: revision.artifactId,
      artifactRevisionId: revision.id,
    },
    selector: safeSelector(params.selector),
    comment: params.comment.trim(),
  };
}
