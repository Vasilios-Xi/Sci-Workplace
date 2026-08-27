import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { BrowserWindow, WebContentsView, session, type DownloadItem, type Event as ElectronEvent, type Session, type WebContents } from 'electron';
import type {
  BrowserObservation,
  BrowserProfileSummary,
  BrowserSessionSummary,
} from '@openlab/protocol';
import {
  browserDomain,
  normalizeHttpsUrl,
  parseBrowserAutomationAction,
  profilePartition,
  sanitizeAccessibilityTree,
  type AxNodeLike,
  type BrowserAutomationAction,
  type BrowserElementObservation,
} from './browser-security.js';
import { desktopZhCN as copy } from './i18n/zh-CN.js';

const SCREENSHOT_TTL_MS = 5 * 60 * 1_000;
const UPLOAD_TTL_MS = 10 * 60 * 1_000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1_000;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

interface PersistedBrowserProfiles {
  profiles?: BrowserProfileSummary[];
}

interface LiveSession {
  summary: BrowserSessionSummary;
  view: WebContentsView;
  observation: BrowserObservation | undefined;
  elementMap: Map<string, BrowserElementObservation>;
  sensitiveContext: boolean;
  pendingDownload: PendingDownload | undefined;
}

interface PendingDownload {
  id: string;
  resolve: (result: BrowserDownloadResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  item?: DownloadItem;
}

interface ScreenshotEntry {
  resource: BrowserScreenshotResource;
  path: string;
  expiresAtMs: number;
}

interface UploadEntry {
  selection: BrowserUploadSelection;
  path: string;
  expiresAtMs: number;
}

export interface BrowserScreenshotResource {
  id: string;
  sessionId: string;
  mediaType: 'image/png';
  size: number;
  sha256: string;
  expiresAt: string;
}

export interface BrowserUploadSelection {
  id: string;
  name: string;
  size: number;
  sha256: string;
  expiresAt: string;
}

export interface BrowserDownloadResult {
  quarantineId: string;
  sessionId: string;
  fileName: string;
  mediaType?: string;
  sourceDomain: string;
  size: number;
  sha256: string;
  status: 'quarantined';
  quarantinedAt: string;
}

export interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class WorktableBrowserManager {
  readonly #window: BrowserWindow;
  readonly #statePath: string;
  readonly #quarantineRoot: string;
  readonly #captureRoot: string;
  readonly #profiles = new Map<string, BrowserProfileSummary>();
  readonly #sessions = new Map<string, LiveSession>();
  readonly #partitionListeners = new Map<string, { partition: Session; listener: (event: ElectronEvent, item: DownloadItem, webContents: WebContents) => void }>();
  readonly #screenshots = new Map<string, ScreenshotEntry>();
  readonly #uploads = new Map<string, UploadEntry>();
  readonly #onChanged: ((profiles: BrowserProfileSummary[], sessions: BrowserSessionSummary[]) => void) | undefined;

  constructor(options: {
    window: BrowserWindow;
    userData: string;
    onChanged?: (profiles: BrowserProfileSummary[], sessions: BrowserSessionSummary[]) => void;
  }) {
    this.#window = options.window;
    this.#statePath = join(options.userData, 'browser-profiles.json');
    this.#quarantineRoot = join(options.userData, 'browser-quarantine');
    this.#captureRoot = mkdtempSync(join(tmpdir(), 'openlab-browser-captures-'));
    this.#onChanged = options.onChanged;
    mkdirSync(this.#quarantineRoot, { recursive: true });
    const persisted = readProfileState(this.#statePath);
    for (const profile of persisted.profiles ?? []) {
      if (profile?.id && profile.partitionId === profilePartition(profile.id)) this.#profiles.set(profile.id, structuredClone(profile));
    }
  }

  profiles(): BrowserProfileSummary[] {
    return [...this.#profiles.values()].map((profile) => structuredClone(profile));
  }

  sessions(): BrowserSessionSummary[] {
    return [...this.#sessions.values()].map((entry) => structuredClone(entry.summary));
  }

  createProfile(name: string, projectId: string): BrowserProfileSummary {
    const title = name.trim().slice(0, 100);
    if (!title) throw new Error('Browser profile name is required');
    const id = randomUUID();
    const now = new Date().toISOString();
    const profile: BrowserProfileSummary = {
      id,
      name: title,
      partitionId: profilePartition(id),
      authorizedProjectIds: [projectId],
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    this.#profiles.set(id, profile);
    this.persist();
    this.emit();
    return structuredClone(profile);
  }

  authorizeProfile(profileId: string, projectId: string, confirmed: boolean): BrowserProfileSummary {
    if (!confirmed) throw new Error('Browser profile authorization requires confirmation');
    const current = this.requireProfile(profileId);
    const profile = {
      ...current,
      authorizedProjectIds: [...new Set([...current.authorizedProjectIds, projectId])],
      updatedAt: new Date().toISOString(),
    };
    this.#profiles.set(profileId, profile);
    this.persist();
    this.emit();
    return structuredClone(profile);
  }

  async open(input: {
    profileId: string;
    projectId: string;
    instanceId: string;
    paneId: string;
    surface?: 'worktable' | 'workspace_preview';
    url: string;
    confirmed: boolean;
  }): Promise<BrowserSessionSummary> {
    const profile = this.requireProfile(input.profileId);
    if (!profile.authorizedProjectIds.includes(input.projectId)) throw new Error('Browser profile is not authorized for this project');
    const blank = input.url === 'about:blank';
    const url = blank ? 'about:blank' : normalizeHttpsUrl(input.url);
    if (!input.confirmed) throw new Error('Opening a browser domain requires confirmation');
    const now = new Date().toISOString();
    const id = randomUUID();
    const domain = blank ? '' : browserDomain(url);
    const partition = session.fromPartition(profile.partitionId, { cache: true });
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    this.configurePartition(profile.partitionId, partition);
    const view = new WebContentsView({
      webPreferences: {
        partition: profile.partitionId,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true,
      },
    });
    const summary: BrowserSessionSummary = {
      id,
      profileId: profile.id,
      instanceId: input.instanceId,
      paneId: input.paneId,
      ...(input.surface ? { surface: input.surface } : {}),
      url,
      title: domain || copy.newBrowserTab,
      status: 'loading',
      canGoBack: false,
      canGoForward: false,
      authorizedDomains: domain ? [domain] : [],
      observationRevision: 0,
      createdAt: now,
      updatedAt: now,
    };
    const live: LiveSession = { summary, view, observation: undefined, elementMap: new Map(), sensitiveContext: false, pendingDownload: undefined };
    this.#sessions.set(id, live);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guardNavigation = (event: Electron.Event, target: string) => {
      if (target === 'about:blank') return;
      try {
        const targetDomain = browserDomain(target);
        if (!live.summary.authorizedDomains.includes(targetDomain)) event.preventDefault();
      } catch { event.preventDefault(); }
    };
    view.webContents.on('will-navigate', guardNavigation);
    view.webContents.on('will-redirect', guardNavigation);
    view.webContents.on('did-start-loading', () => this.patchSession(id, { status: 'loading' }));
    view.webContents.on('did-finish-load', () => this.patchSession(id, {
      status: 'ready',
      url: view.webContents.getURL(),
      title: view.webContents.getTitle() || (view.webContents.getURL() === 'about:blank' ? copy.newBrowserTab : browserDomain(view.webContents.getURL())),
      canGoBack: view.webContents.navigationHistory.canGoBack(),
      canGoForward: view.webContents.navigationHistory.canGoForward(),
      observationRevision: live.summary.observationRevision + 1,
    }));
    view.webContents.on('render-process-gone', () => this.patchSession(id, { status: 'crashed' }));
    await view.webContents.loadURL(url);
    this.emit();
    return structuredClone(live.summary);
  }

  setBounds(sessionId: string, bounds: BrowserViewBounds, visible: boolean): void {
    const live = this.#sessions.get(sessionId);
    if (!live) return;
    const safe = {
      x: Math.max(0, Math.floor(bounds.x)),
      y: Math.max(42, Math.floor(bounds.y)),
      width: Math.max(1, Math.floor(bounds.width)),
      height: Math.max(1, Math.floor(bounds.height)),
    };
    if (!this.#window.contentView.children.includes(live.view)) this.#window.contentView.addChildView(live.view);
    live.view.setBounds(safe);
    live.view.setVisible(visible);
  }

  hideAll(): void {
    for (const live of this.#sessions.values()) live.view.setVisible(false);
  }

  async navigate(sessionId: string, rawUrl: string, confirmed: boolean): Promise<BrowserSessionSummary> {
    const live = this.requireSession(sessionId);
    const url = normalizeHttpsUrl(rawUrl);
    const domain = browserDomain(url);
    if (!live.summary.authorizedDomains.includes(domain)) {
      if (!confirmed) throw new Error('Navigating to a new domain requires confirmation');
      live.summary.authorizedDomains = [...live.summary.authorizedDomains, domain];
    }
    live.observation = undefined;
    live.elementMap.clear();
    live.sensitiveContext = false;
    await live.view.webContents.loadURL(url);
    return structuredClone(live.summary);
  }

  async history(sessionId: string, action: 'back' | 'forward' | 'reload'): Promise<BrowserSessionSummary> {
    const live = this.requireSession(sessionId);
    const navigation = live.view.webContents.navigationHistory;
    if (action === 'back' && !navigation.canGoBack()) return structuredClone(live.summary);
    if (action === 'forward' && !navigation.canGoForward()) return structuredClone(live.summary);
    const completed = new Promise<void>((resolve) => {
      const timer = setTimeout(done, 15_000);
      function done() { clearTimeout(timer); live.view.webContents.removeListener('did-stop-loading', done); resolve(); }
      live.view.webContents.once('did-stop-loading', done);
    });
    if (action === 'back') navigation.goBack();
    else if (action === 'forward') navigation.goForward();
    else live.view.webContents.reload();
    await completed;
    return structuredClone(live.summary);
  }

  async observe(sessionId: string): Promise<BrowserObservation> {
    const live = this.requireSession(sessionId);
    const debuggerApi = live.view.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    const result = await debuggerApi.sendCommand('Accessibility.getFullAXTree') as { nodes?: unknown[] };
    const sanitized = sanitizeAccessibilityTree(Array.isArray(result.nodes) ? result.nodes as AxNodeLike[] : []);
    live.elementMap = new Map(sanitized.elements.map((element) => [element.ref, element]));
    live.sensitiveContext = sanitized.sensitive;
    const observation: BrowserObservation = {
      id: randomUUID(),
      sessionId,
      revision: live.summary.observationRevision,
      url: live.view.webContents.getURL(),
      title: live.view.webContents.getTitle(),
      text: sanitized.text,
      elements: sanitized.elements.map(({ backendDOMNodeId: _backend, ...element }) => element),
      sourceEventIds: [],
      createdAt: new Date().toISOString(),
    };
    live.observation = observation;
    return structuredClone(observation);
  }

  async act(input: {
    sessionId: string;
    observationId: string;
    action: BrowserAutomationAction;
    ref?: string;
    value?: string;
    confirmed: boolean;
  }): Promise<BrowserSessionSummary> {
    if (!input.confirmed) throw new Error('Browser interaction requires confirmation');
    const live = this.requireSession(input.sessionId);
    const action = parseBrowserAutomationAction(input.action);
    this.requireObservation(live, input.observationId);
    if (live.sensitiveContext && action !== 'scroll') throw new Error('Passwords, verification, payment, and two-factor flows must be completed by the user');
    const debuggerApi = live.view.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    if (action === 'scroll') {
      const deltaY = Math.max(-2_000, Math.min(2_000, Number(input.value ?? 600) || 600));
      await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY });
    } else if (action === 'press') {
      const key = String(input.value ?? 'Enter').slice(0, 40);
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key });
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key });
    } else {
      const element = input.ref ? live.elementMap.get(input.ref) : undefined;
      if (!element?.backendDOMNodeId) throw new Error('Browser element reference is unavailable');
      if (element.disabled) throw new Error('Browser element is disabled');
      if (element.sensitive) throw new Error('Sensitive fields must be completed by the user');
      if (action === 'click') {
        await this.clickElement(live, element);
      } else {
        await debuggerApi.sendCommand('DOM.focus', { backendNodeId: element.backendDOMNodeId });
        if (action === 'type') await debuggerApi.sendCommand('Input.insertText', { text: String(input.value ?? '').slice(0, 20_000) });
        else {
          const value = String(input.value ?? '').slice(0, 500);
          for (const character of value) await debuggerApi.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: character });
        }
      }
    }
    live.observation = undefined;
    live.elementMap.clear();
    live.sensitiveContext = false;
    this.patchSession(input.sessionId, { observationRevision: live.summary.observationRevision + 1 });
    return structuredClone(live.summary);
  }

  async screenshot(sessionId: string, observationId: string): Promise<BrowserScreenshotResource> {
    const live = this.requireSession(sessionId);
    this.requireObservation(live, observationId);
    const debuggerApi = live.view.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    const result = await debuggerApi.sendCommand('Accessibility.getFullAXTree') as { nodes?: unknown[] };
    const fresh = sanitizeAccessibilityTree(Array.isArray(result.nodes) ? result.nodes as AxNodeLike[] : []);
    if (fresh.sensitive) throw new Error('Screenshots are disabled on password, verification, payment, or two-factor pages');
    const image = await live.view.webContents.capturePage();
    if (image.isEmpty()) throw new Error('Browser screenshot is empty');
    const png = image.toPNG();
    if (png.length === 0 || png.length > MAX_SCREENSHOT_BYTES) throw new Error('Browser screenshot exceeds the safe size limit');
    const id = randomUUID();
    const expiresAtMs = Date.now() + SCREENSHOT_TTL_MS;
    const resource: BrowserScreenshotResource = {
      id,
      sessionId,
      mediaType: 'image/png',
      size: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    const path = join(this.#captureRoot, `${id}.png`);
    writeFileSync(path, png, { flag: 'wx' });
    this.#screenshots.set(id, { resource, path, expiresAtMs });
    const timer = setTimeout(() => this.expireScreenshot(id), SCREENSHOT_TTL_MS);
    timer.unref();
    return structuredClone(resource);
  }

  readScreenshot(resourceId: string): { resource: BrowserScreenshotResource; bytes: Buffer } {
    const entry = this.#screenshots.get(resourceId);
    if (!entry || entry.expiresAtMs <= Date.now() || !existsSync(entry.path)) {
      this.expireScreenshot(resourceId);
      throw new Error('Browser screenshot resource is unavailable or expired');
    }
    return { resource: structuredClone(entry.resource), bytes: readFileSync(entry.path) };
  }

  async prepareUploads(paths: string[]): Promise<BrowserUploadSelection[]> {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 10) throw new Error('Select between one and ten upload files');
    const entries: UploadEntry[] = [];
    let total = 0;
    for (const rawPath of paths) {
      if (typeof rawPath !== 'string' || !rawPath) throw new Error('Upload file selection is invalid');
      const source = realpathSync.native(rawPath);
      const info = lstatSync(source);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Browser uploads only accept regular files selected by the user');
      if (info.size > MAX_UPLOAD_FILE_BYTES) throw new Error('A browser upload file exceeds the 100 MB limit');
      total += info.size;
      if (total > MAX_UPLOAD_TOTAL_BYTES) throw new Error('Browser upload selection exceeds the 500 MB limit');
      const id = randomUUID();
      const expiresAtMs = Date.now() + UPLOAD_TTL_MS;
      const selection: BrowserUploadSelection = {
        id,
        name: basename(source),
        size: info.size,
        sha256: await hashFile(source),
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
      entries.push({ selection, path: source, expiresAtMs });
    }
    for (const entry of entries) this.#uploads.set(entry.selection.id, entry);
    const timer = setTimeout(() => this.expireUploads(), UPLOAD_TTL_MS);
    timer.unref();
    return entries.map((entry) => structuredClone(entry.selection));
  }

  async upload(input: { sessionId: string; observationId: string; ref: string; uploadIds: string[]; confirmed: boolean }): Promise<BrowserSessionSummary> {
    if (!input.confirmed) throw new Error('Browser upload requires confirmation for this action');
    if (!Array.isArray(input.uploadIds) || input.uploadIds.length === 0 || input.uploadIds.length > 10) throw new Error('Browser upload handles are invalid');
    const live = this.requireSession(input.sessionId);
    this.requireObservation(live, input.observationId);
    if (live.sensitiveContext) throw new Error('Uploads are disabled on password, verification, payment, or two-factor pages');
    const element = live.elementMap.get(input.ref);
    if (!element?.backendDOMNodeId || element.disabled || element.sensitive) throw new Error('Browser file input reference is unavailable');
    const paths: string[] = [];
    for (const id of input.uploadIds) {
      const entry = this.#uploads.get(id);
      if (!entry || entry.expiresAtMs <= Date.now()) throw new Error('Browser upload selection is unavailable or expired');
      const info = statSync(entry.path);
      if (!info.isFile() || info.size !== entry.selection.size || await hashFile(entry.path) !== entry.selection.sha256) throw new Error('Browser upload file changed after selection');
      paths.push(entry.path);
    }
    const debuggerApi = live.view.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    const description = await debuggerApi.sendCommand('DOM.describeNode', { backendNodeId: element.backendDOMNodeId, depth: 0 }) as { node?: { nodeName?: string; attributes?: string[] } };
    const node = description.node;
    const attributes = attributePairs(node?.attributes);
    if (node?.nodeName?.toLocaleUpperCase() !== 'INPUT' || attributes.get('type')?.toLocaleLowerCase() !== 'file') {
      throw new Error('Browser upload target is not a file input');
    }
    await debuggerApi.sendCommand('DOM.setFileInputFiles', { files: paths, backendNodeId: element.backendDOMNodeId });
    for (const id of input.uploadIds) this.#uploads.delete(id);
    this.invalidateObservation(input.sessionId, live);
    return structuredClone(live.summary);
  }

  async download(input: { sessionId: string; observationId: string; ref: string; confirmed: boolean }): Promise<BrowserDownloadResult> {
    if (!input.confirmed) throw new Error('Browser download requires confirmation for this action');
    const live = this.requireSession(input.sessionId);
    this.requireObservation(live, input.observationId);
    if (live.sensitiveContext) throw new Error('Downloads are disabled on password, verification, payment, or two-factor pages');
    if (live.pendingDownload) throw new Error('Another browser download is already pending');
    const element = live.elementMap.get(input.ref);
    if (!element?.backendDOMNodeId || element.disabled || element.sensitive || !['button', 'link'].includes(element.role)) {
      throw new Error('Browser download reference is unavailable');
    }
    let pendingDownload!: PendingDownload;
    const result = new Promise<BrowserDownloadResult>((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        const pending = live.pendingDownload;
        if (!pending || pending.id !== id) return;
        pending.item?.cancel();
        live.pendingDownload = undefined;
        reject(new Error('Browser download did not start or finish in time'));
      }, DOWNLOAD_TIMEOUT_MS);
      timeout.unref();
      pendingDownload = { id, resolve, reject, timeout };
      live.pendingDownload = pendingDownload;
    });
    try {
      await this.clickElement(live, element);
      return await result;
    } catch (error) {
      this.cancelPendingDownload(live, pendingDownload);
      throw error;
    } finally {
      live.observation = undefined;
      live.elementMap.clear();
      live.sensitiveContext = false;
    }
  }

  close(sessionId: string): BrowserSessionSummary {
    const live = this.requireSession(sessionId);
    if (live.pendingDownload) {
      clearTimeout(live.pendingDownload.timeout);
      live.pendingDownload.item?.cancel();
      live.pendingDownload.reject(new Error('Browser session was closed'));
      live.pendingDownload = undefined;
    }
    if (!live.view.webContents.isDestroyed()) live.view.webContents.close({ waitForBeforeUnload: false });
    this.#window.contentView.removeChildView(live.view);
    live.summary = { ...live.summary, status: 'closed', updatedAt: new Date().toISOString() };
    this.#sessions.delete(sessionId);
    this.emit();
    return structuredClone(live.summary);
  }

  dispose(): void {
    for (const id of [...this.#sessions.keys()]) this.close(id);
    for (const { partition, listener } of this.#partitionListeners.values()) partition.off('will-download', listener);
    this.#partitionListeners.clear();
    for (const id of [...this.#screenshots.keys()]) this.expireScreenshot(id);
    rmSync(this.#captureRoot, { recursive: true, force: true });
    this.#uploads.clear();
  }

  private configurePartition(partitionId: string, partition: Session): void {
    if (this.#partitionListeners.has(partitionId)) return;
    const listener = (event: ElectronEvent, item: DownloadItem, webContents: WebContents) => {
      const live = [...this.#sessions.values()].find((candidate) => candidate.view.webContents.id === webContents.id);
      const pending = live?.pendingDownload;
      if (!live || !pending || pending.item) {
        event.preventDefault();
        return;
      }
      const announcedSize = item.getTotalBytes();
      if (announcedSize > MAX_DOWNLOAD_BYTES) {
        event.preventDefault();
        this.rejectDownload(live, pending, new Error('Browser download exceeds the 500 MB limit'));
        return;
      }
      pending.item = item;
      const quarantineId = randomUUID();
      const fileName = safeFileName(item.getFilename());
      const target = join(this.#quarantineRoot, `${quarantineId}-${fileName}`);
      item.setSavePath(target);
      item.on('updated', () => {
        if (item.getReceivedBytes() > MAX_DOWNLOAD_BYTES) item.cancel();
      });
      item.once('done', (_doneEvent, state) => {
        void this.finishDownload(live, pending, item, state, quarantineId, fileName, target);
      });
    };
    partition.on('will-download', listener);
    this.#partitionListeners.set(partitionId, { partition, listener });
  }

  private async finishDownload(
    live: LiveSession,
    pending: PendingDownload,
    item: DownloadItem,
    state: 'completed' | 'cancelled' | 'interrupted',
    quarantineId: string,
    fileName: string,
    target: string,
  ): Promise<void> {
    if (live.pendingDownload?.id !== pending.id) {
      if (existsSync(target)) rmSync(target, { force: true });
      return;
    }
    if (state !== 'completed' || !existsSync(target)) {
      if (existsSync(target)) rmSync(target, { force: true });
      this.rejectDownload(live, pending, new Error(`Browser download ${state}`));
      return;
    }
    try {
      const info = statSync(target);
      if (!info.isFile() || info.size > MAX_DOWNLOAD_BYTES) throw new Error('Browser download exceeds the safe size limit');
      let sourceDomain = '';
      try { sourceDomain = browserDomain(item.getURL()); } catch { sourceDomain = 'unknown'; }
      const mediaType = item.getMimeType().trim().slice(0, 200);
      const result: BrowserDownloadResult = {
        quarantineId,
        sessionId: live.summary.id,
        fileName,
        ...(mediaType ? { mediaType } : {}),
        sourceDomain,
        size: info.size,
        sha256: await hashFile(target),
        status: 'quarantined',
        quarantinedAt: new Date().toISOString(),
      };
      clearTimeout(pending.timeout);
      live.pendingDownload = undefined;
      pending.resolve(result);
    } catch (error) {
      if (existsSync(target)) rmSync(target, { force: true });
      this.rejectDownload(live, pending, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rejectDownload(live: LiveSession, pending: PendingDownload, error: Error): void {
    clearTimeout(pending.timeout);
    if (live.pendingDownload?.id === pending.id) live.pendingDownload = undefined;
    pending.reject(error);
  }

  private cancelPendingDownload(live: LiveSession, pending: PendingDownload): void {
    if (live.pendingDownload?.id !== pending.id) return;
    clearTimeout(pending.timeout);
    pending.item?.cancel();
    live.pendingDownload = undefined;
  }

  private requireObservation(live: LiveSession, observationId: string): BrowserObservation {
    const observation = live.observation;
    if (!observation || observation.id !== observationId || observation.revision !== live.summary.observationRevision) {
      throw new Error('Browser observation is stale');
    }
    return observation;
  }

  private async clickElement(live: LiveSession, element: BrowserElementObservation): Promise<void> {
    if (!element.backendDOMNodeId) throw new Error('Browser element reference is unavailable');
    const debuggerApi = live.view.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    const model = await debuggerApi.sendCommand('DOM.getBoxModel', { backendNodeId: element.backendDOMNodeId }) as { model?: { content?: number[] } };
    const quad = model.model?.content;
    if (!quad || quad.length < 8) throw new Error('Browser element is not visible');
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  private invalidateObservation(sessionId: string, live: LiveSession): void {
    live.observation = undefined;
    live.elementMap.clear();
    live.sensitiveContext = false;
    this.patchSession(sessionId, { observationRevision: live.summary.observationRevision + 1 });
  }

  private expireScreenshot(id: string): void {
    const entry = this.#screenshots.get(id);
    this.#screenshots.delete(id);
    if (entry?.path && existsSync(entry.path)) rmSync(entry.path, { force: true });
  }

  private expireUploads(): void {
    const now = Date.now();
    for (const [id, entry] of this.#uploads) if (entry.expiresAtMs <= now) this.#uploads.delete(id);
  }

  private requireProfile(id: string): BrowserProfileSummary {
    const profile = this.#profiles.get(id);
    if (!profile || profile.status !== 'ready') throw new Error('Browser profile is unavailable');
    return profile;
  }

  private requireSession(id: string): LiveSession {
    const live = this.#sessions.get(id);
    if (!live || live.summary.status === 'closed') throw new Error('Browser session is unavailable');
    return live;
  }

  private patchSession(id: string, patch: Partial<BrowserSessionSummary>): void {
    const live = this.#sessions.get(id);
    if (!live) return;
    live.summary = { ...live.summary, ...patch, updatedAt: new Date().toISOString() };
    this.emit();
  }

  private persist(): void {
    writeProfileState(this.#statePath, { profiles: this.profiles() });
  }

  private emit(): void {
    this.#onChanged?.(this.profiles(), this.sessions());
  }
}

function safeFileName(value: string): string {
  const name = basename(value).replace(/[^\p{L}\p{N}._-]/gu, '-').replace(/^\.+/u, '').slice(0, 180);
  return name || 'download.bin';
}

function attributePairs(values: string[] | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(values)) return result;
  for (let index = 0; index + 1 < values.length; index += 2) {
    result.set(values[index]!.toLocaleLowerCase(), values[index + 1]!);
  }
  return result;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function readProfileState(path: string): PersistedBrowserProfiles {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const profiles = (parsed as { profiles?: unknown }).profiles;
    return Array.isArray(profiles) ? { profiles: profiles as BrowserProfileSummary[] } : {};
  } catch { return {}; }
}

function writeProfileState(path: string, state: PersistedBrowserProfiles): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}
