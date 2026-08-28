import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, safeStorage, session, shell } from 'electron';
import {
  mergeInterfacePreferences,
  normalizeInterfacePreferences,
  type BootstrapSnapshot,
  type ChatAttachmentRef,
  type ConversationActivateInput,
  type ConversationStartInput,
  type ConversationSourceDescriptor,
  type ConversationStartResult,
  type DesktopConversationActivateResult,
  type DesktopConversationStartInput,
  type DesktopConversationStartResult,
  type InterfacePreferences,
  type InterfacePreferencesPatch,
  type InterfacePreferencesUpdateResult,
  type RuntimeConnectionDescriptor,
  type WorktableDeviceUiState,
} from '@openlab/protocol';
import { desktopZhCN as copy } from './i18n/zh-CN.js';
import {
  forgetProjectSourceFolders,
  orderedProjectRootCandidates,
  projectSourceFolders,
  readDesktopSettings,
  rememberRecentProjectRoot,
  rememberProjectSourceFolders,
  writeDesktopSettingsAtomic,
  type DesktopSettings,
} from './settings-store.js';
import { WorktableBrowserManager, type BrowserViewBounds } from './browser-manager.js';
import { BrowserAutomationBroker } from './browser-broker.js';
import { parseBrowserAutomationAction } from './browser-security.js';
import { ensureProjectFolderDescriptor, projectFolderSelection, projectGitBranch, resolveProjectFolder, writeProjectManifest } from './project-manifest.js';

interface RuntimeConnection extends RuntimeConnectionDescriptor {}

interface RuntimeSlot {
  key: string;
  child: ChildProcess;
  ready: Promise<RuntimeConnection>;
  projectRoot: string;
  projectFolderSelected: boolean;
  lastUsed: number;
  leases: number;
}

interface RuntimeReadyMessage {
  type: 'ready';
  port: number;
  url: string;
  authToken: string;
}

interface RuntimeErrorMessage {
  type: 'error';
  message: string;
}

const require = createRequire(import.meta.url);
app.setName('Sci Workplace');
// Harness v1 intentionally starts from a new application-managed state root.
// scripts/reset-app-state.ps1 backs up this managed root before an explicit
// reset; user project directories are never part of this path.
const appDataRoot = process.env.OPENLAB_TEST_USER_DATA_ROOT
  ? resolve(process.env.OPENLAB_TEST_USER_DATA_ROOT)
  : join(app.getPath('appData'), 'SciWorkplace');
app.setPath('userData', appDataRoot);

let mainWindow: BrowserWindow | undefined;
let runtimeChild: ChildProcess | undefined;
let connection: RuntimeConnection | undefined;
let runtimeReady: Promise<RuntimeConnection> | undefined;
let runtimeTransition: Promise<void> = Promise.resolve();
const runtimeChildren = new Set<ChildProcess>();
const runtimeSlots = new Map<string, RuntimeSlot>();
const MAX_RUNTIME_SLOTS = 3;
let runtimeUseSequence = 0;
let runtimePrewarmTimer: NodeJS.Timeout | undefined;
let browserManager: WorktableBrowserManager | undefined;
let browserBroker: BrowserAutomationBroker | undefined;
let browserBrokerConnection: { url: string; token: string } | undefined;

function settingsPath(): string { return join(app.getPath('userData'), 'desktop-settings.json'); }
function credentialsPath(): string { return join(app.getPath('userData'), 'credentials.bin'); }
function mcpCredentialsPath(): string { return join(app.getPath('userData'), 'mcp-credentials.bin'); }

function readSettings(): DesktopSettings {
  return readDesktopSettings(settingsPath());
}

function writeSettings(settings: DesktopSettings): void {
  writeDesktopSettingsAtomic(settingsPath(), settings);
}

function rememberRecentProject(rootPath: string, settings = readSettings()): DesktopSettings {
  const root = resolve(rootPath);
  return rememberRecentProjectRoot(settings, root);
}

function rememberProject(rootPath: string, settings = readSettings()): DesktopSettings {
  const root = resolve(rootPath);
  return { ...rememberRecentProject(root, settings), projectRoot: root };
}

function recentProjects(): Array<ConversationSourceDescriptor & { kind: 'project' }> {
  const settings = readSettings();
  const active = selectedProjectRoot();
  const candidates = orderedProjectRootCandidates(settings, active);
  const seen = new Set<string>();
  const projects: Array<ConversationSourceDescriptor & { kind: 'project' }> = [];
  for (const candidate of candidates) {
    try {
      const project = ensureProjectFolderDescriptor(candidate);
      const key = project.path.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const folders = projectSourceFolders(settings, project.id, project.path);
      projects.push({
        kind: 'project', projectId: project.id, rootPath: project.path, name: project.name,
        ...(folders.length > 1 ? { additionalRoots: folders.slice(1) } : {}),
      });
    } catch { /* Missing recent folders are omitted from the project picker. */ }
  }
  return projects.slice(0, 20);
}

function conversationSources(): ConversationSourceDescriptor[] {
  const detached = ensureProjectFolderDescriptor(unboundProjectRoot());
  return [
    { kind: 'detached', projectId: detached.id, rootPath: detached.path, name: '' },
    ...recentProjects(),
  ];
}

function resolveProjectActionTarget(rawInput: unknown): ConversationSourceDescriptor & { kind: 'project' } {
  const value = typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)
    ? rawInput as { projectId?: unknown; rootPath?: unknown }
    : {};
  if (typeof value.projectId !== 'string') throw new Error(copy.conversationLocationInvalid);
  const project = ensureProjectFolderDescriptor(resolveProjectFolder(value.rootPath));
  if (project.id !== value.projectId) throw new Error(copy.conversationProjectMissing);
  const folders = projectSourceFolders(readSettings(), project.id, project.path);
  return {
    kind: 'project', projectId: project.id, rootPath: project.path, name: project.name,
    ...(folders.length > 1 ? { additionalRoots: folders.slice(1) } : {}),
  };
}

async function withProjectRuntime<T>(rootPath: string, operation: (target: RuntimeConnection) => Promise<T>): Promise<T> {
  const normalized = resolveProjectFolder(rootPath);
  if (connection && runtimeTargetKey(connection.projectRoot, connection.projectFolderSelected) === runtimeTargetKey(normalized, true)) {
    return await operation(connection);
  }
  const slot = acquireRuntime(normalized, true);
  slot.leases++;
  try {
    return await operation(await slot.ready);
  } finally {
    slot.leases--;
    trimRuntimeSlots();
  }
}

const startupInterfacePreferences = normalizeInterfacePreferences(readSettings().interfacePreferences);
const hardwareAccelerationAtLaunch = startupInterfacePreferences.hardwareAcceleration;
if (!hardwareAccelerationAtLaunch) app.disableHardwareAcceleration();

function currentInterfacePreferences(): InterfacePreferences {
  return normalizeInterfacePreferences(readSettings().interfacePreferences);
}

function resolvedDarkTheme(preferences: InterfacePreferences): boolean {
  if (preferences.theme === 'auto') return nativeTheme.shouldUseDarkColors;
  return ['cyan-night', 'ming', 'cyan-night-contrast'].includes(preferences.theme);
}

function windowChrome(preferences: InterfacePreferences): { background: string } {
  if (resolvedDarkTheme(preferences)) return { background: '#182321' };
  if (preferences.theme === 'pure-white') return { background: '#ffffff' };
  if (preferences.theme === 'coral-paper') return { background: '#fff4ef' };
  return { background: '#f7f8f4' };
}

function applyWindowChrome(preferences: InterfacePreferences): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const chrome = windowChrome(preferences);
  mainWindow.setBackgroundColor(chrome.background);
}

function selectedProjectRoot(): string | undefined {
  const override = process.env.OPENLAB_PROJECT_ROOT;
  if (override) return resolve(override);
  const stored = readSettings().projectRoot;
  if (stored && existsSync(stored)) return resolve(stored);
  return undefined;
}

function defaultProjectRoot(): string {
  const selected = selectedProjectRoot();
  if (selected) return selected;
  return unboundProjectRoot();
}

function unboundProjectRoot(): string {
  if (process.env.OPENLAB_TEST_USER_DATA_ROOT) {
    const root = join(app.getPath('userData'), 'unbound-workspace');
    mkdirSync(root, { recursive: true });
    return root;
  }
  const root = join(app.getPath('documents'), 'Sci Workplace Projects', 'Getting Started');
  mkdirSync(root, { recursive: true });
  return root;
}

function mediaType(path: string): string | undefined {
  const extension = extname(path).toLocaleLowerCase();
  return ({
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
    '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.pdf': 'application/pdf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  } as Record<string, string>)[extension];
}

function readDeepSeekKey(): string | undefined {
  if (!safeStorage.isEncryptionAvailable() || !existsSync(credentialsPath())) return undefined;
  try { return safeStorage.decryptString(readFileSync(credentialsPath())); }
  catch { return undefined; }
}

function saveDeepSeekKey(value: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error(copy.safeStorageKeyUnavailable);
  mkdirSync(dirname(credentialsPath()), { recursive: true });
  writeFileSync(credentialsPath(), safeStorage.encryptString(value));
}

function readMcpCredentials(): Record<string, string> {
  if (!safeStorage.isEncryptionAvailable() || !existsSync(mcpCredentialsPath())) return {};
  try {
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(mcpCredentialsPath()))) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => /^cred_[a-f0-9]{24}$/u.test(entry[0]) && typeof entry[1] === 'string'));
  } catch { return {}; }
}

function saveMcpCredential(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error(copy.safeStorageCredentialUnavailable);
  if (!value) throw new Error(copy.credentialEmpty);
  const id = `cred_${randomBytes(12).toString('hex')}`;
  const vault = { ...readMcpCredentials(), [id]: value };
  mkdirSync(dirname(mcpCredentialsPath()), { recursive: true });
  writeFileSync(mcpCredentialsPath(), safeStorage.encryptString(JSON.stringify(vault)));
  return id;
}

async function runtimeRequestAt(target: RuntimeConnection, path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? copy.runtimeRequestFailed(response.status));
  }
  return response;
}

async function runtimeRequest(path: string, init?: RequestInit): Promise<Response> {
  return await runtimeRequestAt(connection ?? await startRuntime(), path, init);
}

async function runtimeSnapshotAt(target: RuntimeConnection): Promise<BootstrapSnapshot> {
  const response = await runtimeRequestAt(target, '/api/bootstrap');
  return await response.json() as BootstrapSnapshot;
}

async function runtimeRequestAll(path: string, init?: RequestInit): Promise<void> {
  const active = connection ?? await startRuntime();
  await runtimeRequestAt(active, path, init);
  const activeKey = runtimeTargetKey(active.projectRoot, active.projectFolderSelected);
  const slots = [...runtimeSlots.values()];
  await Promise.allSettled(slots.map(async (slot) => {
    if (slot.key === activeKey || !runtimeSlotIsAlive(slot)) return;
    await runtimeRequestAt(await slot.ready, path, init);
  }));
}

async function stopRuntimeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const complete = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', complete);
      resolvePromise();
    };
    const kill = () => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      } catch { /* The process may have exited between the liveness check and kill. */ }
    };
    timer = setTimeout(() => { kill(); complete(); }, 10_000);
    child.once('exit', complete);
    if (child.exitCode !== null || child.signalCode !== null) {
      complete();
      return;
    }
    if (!child.connected || !child.send) {
      kill();
      return;
    }
    try {
      child.send({ type: 'shutdown' }, (error) => {
        if (error) kill();
      });
    } catch {
      kill();
    }
  });
}

async function stopRuntime(): Promise<void> {
  const child = runtimeChild;
  runtimeChild = undefined;
  connection = undefined;
  runtimeReady = undefined;
  if (child) {
    removeRuntimeSlot(child);
    await stopRuntimeChild(child);
  }
}

function spawnRuntime(projectRoot: string, projectFolderSelectedOverride?: boolean): { child: ChildProcess; ready: Promise<RuntimeConnection> } {
  let child!: ChildProcess;
  const ready = new Promise<RuntimeConnection>((resolvePromise, reject) => {
    const project = ensureProjectFolderDescriptor(projectRoot);
    const additionalProjectRoots = projectSourceFolders(readSettings(), project.id, project.path).slice(1);
    const childEntry = require.resolve('@openlab/runtime/child');
    const authToken = randomBytes(32).toString('hex');
    child = fork(childEntry, [], {
      cwd: projectRoot,
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...(app.isPackaged ? { OPENLAB_BUNDLED_TOOLCHAIN_ROOT: join(process.resourcesPath, 'openlab-toolchain') } : {}),
        OPENLAB_READER_RUNTIME_ROOT: app.isPackaged
          ? join(process.resourcesPath, 'reader-runtime')
          : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'reader-runtime', 'dist', 'reader-worker'),
        OPENLAB_FEATURE_CITATION_WORKBENCH_V1: process.env.OPENLAB_FEATURE_CITATION_WORKBENCH_V1 ?? '1',
        OPENLAB_BUNDLED_PLUGIN_ROOT: app.isPackaged
          ? join(process.resourcesPath, 'bundled-plugins')
          : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'citation-plugin'),
        OPENLAB_ZOTERO_COMPANION_PATH: app.isPackaged
          ? join(process.resourcesPath, 'zotero-companion', 'sci-workplace-zotero-companion.xpi')
          : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'integrations', 'zotero-companion', 'dist', 'sci-workplace-zotero-companion.xpi'),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    runtimeChildren.add(child);
    let startupSettled = false;
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (!app.isPackaged) process.stderr.write(chunk);
    });
    let timer: NodeJS.Timeout | undefined;
    const failStartup = (error: Error) => {
      if (startupSettled) return;
      startupSettled = true;
      if (timer) clearTimeout(timer);
      try { child.kill(); } catch { /* The child may already have exited. */ }
      reject(error);
    };
    timer = setTimeout(() => failStartup(new Error(copy.runtimeStartTimeout)), 90_000);
    child.once('error', (error) => failStartup(error));
    child.on('message', (message: RuntimeReadyMessage | RuntimeErrorMessage) => {
      if (message.type === 'error') {
        failStartup(new Error(message.message));
        return;
      }
      if (message.type === 'ready' && !startupSettled) {
        startupSettled = true;
        if (timer) clearTimeout(timer);
        resolvePromise({ baseUrl: message.url, token: message.authToken, projectRoot, projectFolderSelected: projectFolderSelectedOverride ?? selectedProjectRoot() === resolve(projectRoot) });
      }
    });
    child.once('exit', (code) => {
      if (timer) clearTimeout(timer);
      runtimeChildren.delete(child);
      removeRuntimeSlot(child);
      if (!startupSettled) {
        startupSettled = true;
        reject(new Error(`${copy.runtimeStoppedMessage}${code === null ? '' : ` (${copy.exitCode(code)})`}`));
      }
      if (runtimeChild === child) {
        runtimeChild = undefined;
        connection = undefined;
        runtimeReady = undefined;
        if (code && !mainWindow?.isDestroyed()) void dialog.showMessageBox({ type: 'error', title: copy.runtimeStoppedTitle, message: copy.runtimeStoppedMessage, detail: copy.exitCode(code) });
      }
    });
    const startMessage = {
      type: 'start',
      config: {
        host: '127.0.0.1', port: 0, authToken, projectRoot,
        ...(additionalProjectRoots.length ? { projectRoots: additionalProjectRoots } : {}),
        home: app.getPath('userData'), demo: false, deferInitialSession: true,
        credentials: readMcpCredentials(),
        ...(browserBrokerConnection ? { browserBroker: browserBrokerConnection } : {}),
        ...(readDeepSeekKey() ? { deepSeekApiKey: readDeepSeekKey() } : {}),
      },
    };
    try {
      child.send(startMessage, (error) => {
        if (error) failStartup(error);
      });
    } catch (error) {
      failStartup(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return { child, ready };
}

function runtimeTargetKey(projectRoot: string, projectFolderSelected: boolean): string {
  return `${resolve(projectRoot).toLocaleLowerCase()}\u0000${projectFolderSelected ? 'project' : 'detached'}`;
}

function runtimeSlotForChild(child: ChildProcess): RuntimeSlot | undefined {
  return [...runtimeSlots.values()].find((slot) => slot.child === child);
}

function removeRuntimeSlot(child: ChildProcess): void {
  const slot = runtimeSlotForChild(child);
  if (slot && runtimeSlots.get(slot.key) === slot) runtimeSlots.delete(slot.key);
}

function touchRuntimeSlot(slot: RuntimeSlot): void {
  slot.lastUsed = ++runtimeUseSequence;
}

function runtimeSlotIsAlive(slot: RuntimeSlot): boolean {
  return !slot.child.killed && slot.child.exitCode === null && slot.child.signalCode === null;
}

function acquireRuntime(projectRoot: string, projectFolderSelected: boolean): RuntimeSlot {
  const targetRoot = resolve(projectRoot);
  const key = runtimeTargetKey(targetRoot, projectFolderSelected);
  const existing = runtimeSlots.get(key);
  if (existing && runtimeSlotIsAlive(existing)) {
    touchRuntimeSlot(existing);
    return existing;
  }
  if (existing) runtimeSlots.delete(key);
  const launch = spawnRuntime(targetRoot, projectFolderSelected);
  const slot: RuntimeSlot = {
    key,
    child: launch.child,
    ready: launch.ready,
    projectRoot: targetRoot,
    projectFolderSelected,
    lastUsed: ++runtimeUseSequence,
    leases: 0,
  };
  runtimeSlots.set(key, slot);
  void slot.ready.catch(() => {
    if (runtimeSlots.get(key) === slot) runtimeSlots.delete(key);
  });
  return slot;
}

function trimRuntimeSlots(): void {
  if (runtimeSlots.size <= MAX_RUNTIME_SLOTS) return;
  const removable = [...runtimeSlots.values()]
    .filter((slot) => slot.child !== runtimeChild && slot.leases === 0)
    .sort((left, right) => left.lastUsed - right.lastUsed);
  while (runtimeSlots.size > MAX_RUNTIME_SLOTS && removable.length > 0) {
    const slot = removable.shift()!;
    if (runtimeSlots.get(slot.key) !== slot) continue;
    runtimeSlots.delete(slot.key);
    void stopRuntimeChild(slot.child).catch(() => undefined);
  }
}

function invalidateInactiveRuntimes(): void {
  for (const slot of [...runtimeSlots.values()]) {
    if (slot.child === runtimeChild) continue;
    if (runtimeSlots.get(slot.key) === slot) runtimeSlots.delete(slot.key);
    void stopRuntimeChild(slot.child).catch(() => undefined);
  }
}

function invalidateRuntimeTarget(projectRoot: string, projectFolderSelected: boolean): void {
  const slot = runtimeSlots.get(runtimeTargetKey(projectRoot, projectFolderSelected));
  if (!slot || slot.child === runtimeChild) return;
  runtimeSlots.delete(slot.key);
  void stopRuntimeChild(slot.child).catch(() => undefined);
}

function prepareRuntime(projectRoot: string, projectFolderSelected: boolean): void {
  const targetRoot = resolve(projectRoot);
  const key = runtimeTargetKey(targetRoot, projectFolderSelected);
  if (connection && runtimeTargetKey(connection.projectRoot, connection.projectFolderSelected) === key) return;
  const slot = acquireRuntime(targetRoot, projectFolderSelected);
  slot.leases++;
  trimRuntimeSlots();
  void slot.ready.catch(() => undefined).finally(() => {
    slot.leases--;
    trimRuntimeSlots();
  });
}

function scheduleRuntimePrewarm(sources: ConversationSourceDescriptor[]): void {
  if (runtimePrewarmTimer) clearTimeout(runtimePrewarmTimer);
  const activeKey = connection ? runtimeTargetKey(connection.projectRoot, connection.projectFolderSelected) : undefined;
  const targets = sources
    .filter((source) => runtimeTargetKey(source.rootPath, source.kind === 'project') !== activeKey)
    .slice(0, Math.max(0, MAX_RUNTIME_SLOTS - 1));
  runtimePrewarmTimer = setTimeout(() => {
    runtimePrewarmTimer = undefined;
    void (async () => {
      for (const source of targets) {
        const slot = acquireRuntime(source.rootPath, source.kind === 'project');
        slot.leases++;
        try { await slot.ready; }
        catch { /* A failed warm-up is retried on the real switch. */ }
        finally {
          slot.leases--;
          trimRuntimeSlots();
        }
      }
    })();
  }, 600);
  runtimePrewarmTimer.unref();
}

function startRuntime(projectRoot = defaultProjectRoot(), projectFolderSelectedOverride?: boolean): Promise<RuntimeConnection> {
  if (runtimeReady) return runtimeReady;
  const targetRoot = resolve(projectRoot);
  const selected = projectFolderSelectedOverride ?? selectedProjectRoot() === targetRoot;
  const slot = acquireRuntime(targetRoot, selected);
  runtimeChild = slot.child;
  runtimeReady = slot.ready.then((next) => {
    if (runtimeChild === slot.child) {
      connection = next;
      touchRuntimeSlot(slot);
    }
    return next;
  });
  return runtimeReady;
}

function runRuntimeTransition<T>(operation: () => Promise<T>): Promise<T> {
  const transaction = runtimeTransition.then(operation, operation);
  runtimeTransition = transaction.then(() => undefined, () => undefined);
  return transaction;
}

async function switchRuntimeUnlocked(projectRoot: string, projectFolderSelected: boolean): Promise<RuntimeConnection> {
  const targetRoot = resolve(projectRoot);
  const key = runtimeTargetKey(targetRoot, projectFolderSelected);
  if (connection && runtimeTargetKey(connection.projectRoot, connection.projectFolderSelected) === key) return connection;

  const slot = acquireRuntime(targetRoot, projectFolderSelected);
  slot.leases++;
  try {
    const next = await slot.ready;
    runtimeChild = slot.child;
    connection = next;
    runtimeReady = slot.ready;
    touchRuntimeSlot(slot);
    return next;
  } finally {
    slot.leases--;
    trimRuntimeSlots();
  }
}

function switchRuntime(projectRoot: string, projectFolderSelected: boolean): Promise<RuntimeConnection> {
  return runRuntimeTransition(() => switchRuntimeUnlocked(projectRoot, projectFolderSelected));
}

function detachedSettings(settings: DesktopSettings): DesktopSettings {
  const remembered = settings.projectRoot ? rememberRecentProject(settings.projectRoot, settings) : settings;
  const { projectRoot: _projectRoot, ...detached } = remembered;
  return detached;
}

function projectTarget(value: unknown): { rootPath: string; name: string; additionalRoots: string[]; selected: boolean } {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (record.kind === 'detached') {
    return { rootPath: unboundProjectRoot(), name: '', additionalRoots: [], selected: false };
  }
  if (record.kind !== 'project') throw new Error(copy.projectSourceRequired);
  const project = ensureProjectFolderDescriptor(record.rootPath as string);
  const folders = projectSourceFolders(readSettings(), project.id, project.path);
  return { rootPath: project.path, name: project.name, additionalRoots: folders.slice(1), selected: true };
}

function selectedProjectFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Map(value.slice(0, 12).map((candidate) => {
    const path = resolveProjectFolder(candidate);
    return [path.toLocaleLowerCase(), path] as const;
  })).values()];
}

function migrateConversationAttachments(
  attachments: ChatAttachmentRef[] | undefined,
  sourceRoot: string,
  targetRoot: string,
): ChatAttachmentRef[] | undefined {
  if (!attachments?.length || resolve(sourceRoot) === resolve(targetRoot)) return attachments;
  const sourceBase = resolve(sourceRoot);
  const destinationRoot = join(resolve(targetRoot), '.openlab', 'attachments');
  mkdirSync(destinationRoot, { recursive: true });
  return attachments.map((attachment) => {
    if (attachment.rootId && attachment.rootId !== 'project') return attachment;
    const source = resolve(sourceBase, attachment.relativePath);
    const sourceRelative = relative(sourceBase, source);
    if (!sourceRelative || sourceRelative === '..' || sourceRelative.startsWith(`..${sep}`) || isAbsolute(sourceRelative)) {
      throw new Error(copy.projectSourceMissing);
    }
    if (!existsSync(source) || !statSync(source).isFile()) throw new Error(copy.projectSourceMissing);
    const safeName = basename(attachment.name).replace(/[^\p{L}\p{N}._-]/gu, '-');
    const destination = join(destinationRoot, `${randomUUID()}-${safeName}`);
    copyFileSync(source, destination);
    return {
      ...attachment,
      rootId: 'project',
      relativePath: relative(resolve(targetRoot), destination).replaceAll('\\', '/'),
    };
  });
}

async function startConversationTransaction(rawInput: unknown): Promise<DesktopConversationStartResult> {
  const value = typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)
    ? rawInput as Record<string, unknown>
    : {};
  const message = typeof value.message === 'object' && value.message !== null && !Array.isArray(value.message)
    ? value.message as ConversationStartInput['message']
    : undefined;
  if (!message) throw new Error(copy.conversationFirstMessageRequired);
  const target = projectTarget(value.target);

  return await runRuntimeTransition(async () => {
    const previousConnection = connection ?? await startRuntime();
    const sameRuntime = resolve(previousConnection.projectRoot) === resolve(target.rootPath)
      && previousConnection.projectFolderSelected === target.selected;
    const staged = sameRuntime ? undefined : acquireRuntime(target.rootPath, target.selected);
    if (staged) staged.leases++;
    let targetConnection = previousConnection;
    try {
      if (staged) targetConnection = await staged.ready;
      const migratedAttachments = migrateConversationAttachments(message.attachments, previousConnection.projectRoot, target.rootPath);
      const conversationInput: ConversationStartInput = {
        ...(typeof value.title === 'string' ? { title: value.title } : {}),
        ...(typeof value.leadAgentId === 'string' ? { leadAgentId: value.leadAgentId } : {}),
        ...(Array.isArray(value.memberAgentIds) ? { memberAgentIds: value.memberAgentIds as string[] } : {}),
        ...(value.temporary === true ? { temporary: true } : {}),
        message: {
          ...message,
          ...(migratedAttachments ? { attachments: migratedAttachments } : {}),
        },
      };
      const response = await runtimeRequestAt(targetConnection, '/api/conversations/start', {
        method: 'POST',
        body: JSON.stringify(conversationInput),
      });
      const started = await response.json() as ConversationStartResult;
      const snapshot = await runtimeSnapshotAt(targetConnection);

      const settings = readSettings();
      writeSettings(target.selected ? rememberProject(target.rootPath, settings) : detachedSettings(settings));
      if (staged) {
        runtimeChild = staged.child;
        connection = targetConnection;
        runtimeReady = staged.ready;
        touchRuntimeSlot(staged);
      }
      return { ...started, connection: targetConnection, snapshot };
    } finally {
      if (staged) {
        staged.leases--;
        trimRuntimeSlots();
      }
    }
  });
}

async function activateConversationTransaction(rawInput: unknown): Promise<DesktopConversationActivateResult> {
  const value = typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)
    ? rawInput as Partial<ConversationActivateInput>
    : {};
  if (typeof value.sessionId !== 'string' || typeof value.projectId !== 'string') throw new Error(copy.conversationLocationInvalid);
  const source = conversationSources().find((candidate) => candidate.projectId === value.projectId);
  if (!source) throw new Error(copy.conversationProjectMissing);
  return await runRuntimeTransition(async () => {
    const next = await switchRuntimeUnlocked(source.rootPath, source.kind === 'project');
    let snapshot: BootstrapSnapshot;
    if (value.activate !== false) {
      const response = await runtimeRequestAt(next, `/api/sessions/${encodeURIComponent(value.sessionId!)}/activate`, { method: 'POST', body: '{}' });
      snapshot = await response.json() as BootstrapSnapshot;
    } else snapshot = await runtimeSnapshotAt(next);
    const settings = readSettings();
    writeSettings(source.kind === 'project' ? rememberProject(source.rootPath, settings) : detachedSettings(settings));
    return { connection: next, snapshot };
  });
}

function rendererEntry(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'renderer', 'index.html');
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'renderer', 'dist', 'index.html');
}

function attachBrowserManager(window: BrowserWindow): void {
  browserManager?.dispose();
  browserManager = new WorktableBrowserManager({
    window,
    userData: app.getPath('userData'),
    onChanged: (profiles, sessions) => {
      void runtimeRequestAll('/api/browser/state', {
        method: 'POST',
        body: JSON.stringify({ profiles, sessions }),
      });
    },
  });
}

async function createWindow(): Promise<void> {
  await startRuntime();
  const preload = join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs');
  const preferences = currentInterfacePreferences();
  const chrome = windowChrome(preferences);
  const appWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 920,
    minHeight: 640,
    show: false,
    backgroundColor: chrome.background,
    title: 'Sci Workplace',
    titleBarStyle: 'hidden',
    // The renderer owns all three window buttons. Disabling the native overlay keeps
    // them in the same composited titlebar layer and prevents an OS-colored duplicate.
    titleBarOverlay: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = appWindow;
    attachBrowserManager(appWindow);
  }
  appWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//u.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  appWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.OPENLAB_RENDERER_URL;
    if ((allowed && url.startsWith(allowed)) || url.startsWith('file:')) return;
    event.preventDefault();
  });
  appWindow.once('ready-to-show', () => {
    appWindow.show();
    const capturePath = process.env.OPENLAB_CAPTURE_PATH;
    if (capturePath && appWindow === mainWindow) {
      setTimeout(() => {
        void appWindow.webContents.capturePage().then((image) => {
          mkdirSync(dirname(resolve(capturePath)), { recursive: true });
          writeFileSync(resolve(capturePath), image.toPNG());
          app.quit();
        });
      }, 1_500);
    }
  });
  appWindow.on('closed', () => {
    if (mainWindow !== appWindow) return;
    mainWindow = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (mainWindow) attachBrowserManager(mainWindow);
    else {
      browserManager?.dispose();
      browserManager = undefined;
    }
  });
  const developmentUrl = process.env.OPENLAB_RENDERER_URL;
  if (developmentUrl) await appWindow.loadURL(developmentUrl);
  else await appWindow.loadFile(rendererEntry());
}

function registerIpc(): void {
  ipcMain.handle('runtime:get-connection', async () => connection ?? await startRuntime());
  ipcMain.handle('runtime:invalidate-inactive', () => {
    invalidateInactiveRuntimes();
    return true;
  });
  ipcMain.handle('interface:get-preferences', () => currentInterfacePreferences());
  ipcMain.handle('interface:update-preferences', (_event, raw: unknown): InterfacePreferencesUpdateResult => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(copy.invalidInterfacePreferences);
    const settings = readSettings();
    const current = normalizeInterfacePreferences(settings.interfacePreferences);
    const preferences = mergeInterfacePreferences(current, raw as InterfacePreferencesPatch);
    writeSettings({ ...settings, interfacePreferences: preferences });
    applyWindowChrome(preferences);
    return { preferences, restartRequired: preferences.hardwareAcceleration !== hardwareAccelerationAtLaunch };
  });
  ipcMain.handle('worktable-ui:get', (_event, instanceId: unknown): WorktableDeviceUiState => {
    if (typeof instanceId !== 'string' || !instanceId || instanceId.length > 200) throw new Error('Worktable instance ID is invalid');
    return readSettings().worktableUi?.[instanceId] ?? { drawerWidth: 236, chatWidth: 460, chatHeight: 620, drawerCollapsed: false, chatCollapsed: true, paneRatios: {} };
  });
  ipcMain.handle('worktable-ui:update', (_event, instanceId: unknown, patch: unknown): WorktableDeviceUiState => {
    if (typeof instanceId !== 'string' || !instanceId || instanceId.length > 200 || !patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Worktable UI state is invalid');
    const settings = readSettings();
    const previous = settings.worktableUi?.[instanceId] ?? { drawerWidth: 236, chatWidth: 460, chatHeight: 620, drawerCollapsed: false, chatCollapsed: true, paneRatios: {} };
    const raw = patch as Partial<WorktableDeviceUiState>;
    const next: WorktableDeviceUiState = {
      drawerWidth: typeof raw.drawerWidth === 'number' && Number.isFinite(raw.drawerWidth) ? Math.min(420, Math.max(180, Math.round(raw.drawerWidth))) : previous.drawerWidth,
      chatWidth: typeof raw.chatWidth === 'number' && Number.isFinite(raw.chatWidth) ? Math.min(760, Math.max(360, Math.round(raw.chatWidth))) : previous.chatWidth,
      chatHeight: typeof raw.chatHeight === 'number' && Number.isFinite(raw.chatHeight) ? Math.min(900, Math.max(360, Math.round(raw.chatHeight))) : previous.chatHeight,
      drawerCollapsed: typeof raw.drawerCollapsed === 'boolean' ? raw.drawerCollapsed : previous.drawerCollapsed,
      chatCollapsed: typeof raw.chatCollapsed === 'boolean' ? raw.chatCollapsed : previous.chatCollapsed,
      paneRatios: raw.paneRatios && typeof raw.paneRatios === 'object' ? Object.fromEntries(Object.entries(raw.paneRatios).filter(([, ratio]) => typeof ratio === 'number' && Number.isFinite(ratio)).slice(0, 100).map(([key, ratio]) => [key, Math.min(.85, Math.max(.15, ratio))])) : previous.paneRatios,
      ...(typeof raw.focusedPaneId === 'string' && raw.focusedPaneId.length <= 200 ? { focusedPaneId: raw.focusedPaneId } : previous.focusedPaneId ? { focusedPaneId: previous.focusedPaneId } : {}),
      ...(raw.maximizedPaneId === undefined ? previous.maximizedPaneId ? { maximizedPaneId: previous.maximizedPaneId } : {} : typeof raw.maximizedPaneId === 'string' && raw.maximizedPaneId.length <= 200 ? { maximizedPaneId: raw.maximizedPaneId } : {}),
      activeTabIds: raw.activeTabIds && typeof raw.activeTabIds === 'object' ? Object.fromEntries(Object.entries(raw.activeTabIds).filter(([paneId, tabId]) => paneId.length <= 200 && typeof tabId === 'string' && tabId.length <= 200).slice(0, 100)) : previous.activeTabIds ?? {},
      openInstanceIds: Array.isArray(raw.openInstanceIds) ? raw.openInstanceIds.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length <= 200).slice(0, 20) : previous.openInstanceIds ?? [],
    };
    writeSettings({ ...settings, worktableUi: { ...(settings.worktableUi ?? {}), [instanceId]: next } });
    return next;
  });
  ipcMain.handle('deepseek:key-status', () => ({ configured: Boolean(readDeepSeekKey()), protected: safeStorage.isEncryptionAvailable() }));
  ipcMain.handle('deepseek:set-key', async (_event, raw: unknown) => {
    if (typeof raw !== 'string' || raw.trim().length < 12) throw new Error(copy.invalidDeepSeekKey);
    const value = raw.trim();
    saveDeepSeekKey(value);
    runtimeChild?.send?.({ type: 'provider-key', apiKey: value });
    invalidateInactiveRuntimes();
    return { configured: true, protected: true };
  });
  ipcMain.handle('credential:save', async (_event, raw: unknown) => {
    if (typeof raw !== 'string' || !raw) throw new Error(copy.credentialEmpty);
    const id = saveMcpCredential(raw);
    await runtimeRequest('/api/credentials', { method: 'POST', body: JSON.stringify({ id, value: raw }) });
    invalidateInactiveRuntimes();
    return id;
  });
  ipcMain.handle('project:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: copy.chooseProject, properties: ['openDirectory', 'createDirectory'] });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return undefined;
    const next = await switchRuntime(selected, true);
    writeSettings(rememberProject(selected));
    return next;
  });
  ipcMain.handle('project:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: copy.chooseProjectSource, properties: ['openDirectory', 'createDirectory'] });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return undefined;
    return projectFolderSelection(selected);
  });
  ipcMain.handle('project:create-draft', (_event, input: unknown) => {
    const value = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const folders = selectedProjectFolders(value.sourceFolders);
    const selected = folders[0];
    if (!selected) throw new Error(copy.projectSourceRequired);
    const manifest = writeProjectManifest(selected, typeof value.name === 'string' ? value.name : '');
    writeSettings(rememberProjectSourceFolders(rememberRecentProject(selected), manifest.id, selected, folders));
    prepareRuntime(selected, true);
    return {
      kind: 'project',
      rootPath: selected,
      name: manifest.name,
      ...(folders.length > 1 ? { additionalRoots: folders.slice(1) } : {}),
    } satisfies DesktopConversationStartInput['target'];
  });
  ipcMain.handle('project:activate', async (_event, input: unknown) => {
    const value = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const folders = selectedProjectFolders(Array.isArray(value.sourceFolders) ? value.sourceFolders : [value.rootPath]);
    const selected = folders[0];
    if (!selected) throw new Error(copy.projectSourceRequired);
    const manifest = writeProjectManifest(selected, typeof value.name === 'string' ? value.name : '');
    writeSettings(rememberProjectSourceFolders(rememberProject(selected), manifest.id, selected, folders));
    const active = connection && runtimeTargetKey(connection.projectRoot, connection.projectFolderSelected) === runtimeTargetKey(selected, true);
    if (active) {
      await runtimeRequest('/api/project/source-folders', {
        method: 'PUT', body: JSON.stringify({ paths: folders.slice(1) }),
      });
    } else invalidateRuntimeTarget(selected, true);
    const next = await switchRuntime(selected, true);
    return next;
  });
  ipcMain.handle('project:list', () => recentProjects());
  ipcMain.handle('project:rename', async (_event, rawInput: unknown) => {
    const target = resolveProjectActionTarget(rawInput);
    const value = rawInput as { name?: unknown };
    const manifest = writeProjectManifest(target.rootPath, value.name as string);
    if (connection && resolve(connection.projectRoot).toLocaleLowerCase() === target.rootPath.toLocaleLowerCase()) {
      await runtimeRequest('/api/project/rename', { method: 'POST', body: JSON.stringify({ name: manifest.name }) });
    } else invalidateRuntimeTarget(target.rootPath, true);
    return { ...target, name: manifest.name } satisfies ConversationSourceDescriptor;
  });
  ipcMain.handle('project:update-folders', async (_event, rawInput: unknown) => {
    const target = resolveProjectActionTarget(rawInput);
    const value = rawInput as { sourceFolders?: unknown };
    const requested = selectedProjectFolders(value.sourceFolders);
    const folders = [target.rootPath, ...requested.filter((path) => path.toLocaleLowerCase() !== target.rootPath.toLocaleLowerCase())].slice(0, 12);
    const settings = rememberProjectSourceFolders(readSettings(), target.projectId, target.rootPath, folders);
    writeSettings(settings);
    const active = connection && runtimeTargetKey(connection.projectRoot, connection.projectFolderSelected) === runtimeTargetKey(target.rootPath, true);
    if (active) {
      await runtimeRequest('/api/project/source-folders', {
        method: 'PUT', body: JSON.stringify({ paths: folders.slice(1) }),
      });
    } else invalidateRuntimeTarget(target.rootPath, true);
    return {
      kind: 'project', projectId: target.projectId, rootPath: target.rootPath, name: target.name,
      ...(folders.length > 1 ? { additionalRoots: folders.slice(1) } : {}),
    } satisfies ConversationSourceDescriptor;
  });
  ipcMain.handle('project:archive-conversations', async (_event, rawInput: unknown) => {
    const target = resolveProjectActionTarget(rawInput);
    return await withProjectRuntime(target.rootPath, async (runtimeTarget) => {
      const response = await runtimeRequestAt(runtimeTarget, '/api/sessions/archive-project', { method: 'POST', body: '{}' });
      return await response.json() as { archivedSessionIds: string[] };
    });
  });
  ipcMain.handle('project:remove', async (_event, rawInput: unknown) => {
    const target = resolveProjectActionTarget(rawInput);
    const settings = readSettings();
    const targetKey = target.rootPath.toLocaleLowerCase();
    const recentProjectRoots = (settings.recentProjectRoots ?? []).filter((candidate) => resolve(candidate).toLocaleLowerCase() !== targetKey);
    const active = connection && resolve(connection.projectRoot).toLocaleLowerCase() === targetKey;
    const projectRoot = settings.projectRoot && resolve(settings.projectRoot).toLocaleLowerCase() !== targetKey ? settings.projectRoot : undefined;
    const nextSettings: DesktopSettings = { ...forgetProjectSourceFolders(settings, target.projectId), recentProjectRoots, ...(projectRoot ? { projectRoot } : {}) };
    if (!projectRoot) delete nextSettings.projectRoot;
    if (!active) {
      invalidateRuntimeTarget(target.rootPath, true);
      writeSettings(nextSettings);
      return { removed: true };
    }
    const next = await switchRuntime(unboundProjectRoot(), false);
    invalidateRuntimeTarget(target.rootPath, true);
    writeSettings(nextSettings);
    return { removed: true, connection: next };
  });
  ipcMain.handle('conversation:sources', () => {
    const sources = conversationSources();
    scheduleRuntimePrewarm(sources);
    return sources;
  });
  ipcMain.handle('conversation:prepare-target', (_event, rawTarget: unknown) => {
    const target = projectTarget(rawTarget);
    prepareRuntime(target.rootPath, target.selected);
    return true;
  });
  ipcMain.handle('project:activate-existing', async (_event, rawRootPath: unknown) => {
    const selected = resolveProjectFolder(rawRootPath);
    const next = await switchRuntime(selected, true);
    writeSettings(rememberProject(selected));
    return next;
  });
  ipcMain.handle('project:context', async () => {
    const target = connection ?? await startRuntime();
    return {
      rootPath: target.projectRoot,
      folderName: basename(target.projectRoot) || 'Sci Workplace Project',
      location: copy.localEnvironment,
      gitBranch: projectGitBranch(target.projectRoot),
    };
  });
  ipcMain.handle('project:clear', async () => {
    const currentSettings = readSettings();
    const selected = selectedProjectRoot();
    const remembered = selected ? rememberProject(selected, currentSettings) : currentSettings;
    const { projectRoot: _projectRoot, ...settings } = remembered;
    const next = await switchRuntime(unboundProjectRoot(), false);
    writeSettings(settings);
    return next;
  });
  ipcMain.handle('project:open-folder', async () => {
    const target = connection ?? await startRuntime();
    const error = await shell.openPath(target.projectRoot);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle('extension:choose', async (_event, kind: 'skill' | 'plugin') => {
    const choice = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      title: kind === 'skill' ? copy.importSkill : copy.importPlugin,
      message: copy.chooseLocalSource,
      detail: copy.localSourceDetail,
      buttons: [copy.chooseDirectory, copy.chooseZip, copy.cancel],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice.response === 2) return undefined;
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: kind === 'skill' ? copy.chooseSkillSource : copy.choosePluginSource,
      properties: choice.response === 0 ? ['openDirectory'] : ['openFile'],
      ...(choice.response === 1 ? { filters: [{ name: copy.archive, extensions: ['zip'] }] } : {}),
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle('plugin-catalog:choose-index', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: copy.choosePluginCatalogIndex,
      properties: ['openFile'],
      filters: [{ name: copy.signedCatalog, extensions: ['json'] }],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle('plugin-catalog:choose-package', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: copy.chooseCuratedPluginPackage,
      properties: ['openFile'],
      filters: [{ name: copy.zipArchive, extensions: ['zip'] }],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle('toolchain:choose', async () => {
    const choice = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      title: copy.importToolchain,
      message: copy.chooseToolchainSource,
      detail: copy.toolchainSourceDetail,
      buttons: [copy.chooseDirectory, copy.chooseZip, copy.cancel],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice.response === 2) return undefined;
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: copy.chooseToolchainSource,
      properties: choice.response === 0 ? ['openDirectory'] : ['openFile'],
      ...(choice.response === 1 ? { filters: [{ name: copy.archive, extensions: ['zip'] }] } : {}),
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle('attachment:choose', async () => {
    const target = connection ?? await startRuntime();
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: copy.chooseAttachments,
      properties: ['openFile', 'multiSelections'],
    });
    if (selection.canceled) return [];
    if (selection.filePaths.length > 10) throw new Error(copy.attachmentLimit);
    const destinationRoot = join(target.projectRoot, '.openlab', 'attachments');
    mkdirSync(destinationRoot, { recursive: true });
    return selection.filePaths.map((source) => {
      const size = statSync(source).size;
      if (size > 100 * 1024 * 1024) throw new Error(copy.attachmentTooLarge(basename(source)));
      const safeName = basename(source).replace(/[^\p{L}\p{N}._-]/gu, '-');
      const destination = join(destinationRoot, `${randomUUID()}-${safeName}`);
      copyFileSync(source, destination);
      const sha256 = createHash('sha256').update(readFileSync(destination)).digest('hex');
      return {
        id: randomUUID(), name: basename(source), rootId: 'project',
        relativePath: relative(target.projectRoot, destination).replaceAll('\\', '/'),
        sha256, size, ...(mediaType(source) ? { mediaType: mediaType(source) } : {}),
      };
    });
  });
  ipcMain.handle('attachment:import-paths', async (_event, rawPaths: unknown) => {
    if (!Array.isArray(rawPaths) || rawPaths.length > 10 || rawPaths.some((path) => typeof path !== 'string')) throw new Error(copy.attachmentLimit);
    const target = connection ?? await startRuntime();
    const destinationRoot = join(target.projectRoot, '.openlab', 'attachments');
    mkdirSync(destinationRoot, { recursive: true });
    return (rawPaths as string[]).map((source) => {
      const size = statSync(source).size;
      if (size > 100 * 1024 * 1024) throw new Error(copy.attachmentTooLarge(basename(source)));
      const safeName = basename(source).replace(/[^\p{L}\p{N}._-]/gu, '-');
      const destination = join(destinationRoot, `${randomUUID()}-${safeName}`);
      copyFileSync(source, destination);
      const sha256 = createHash('sha256').update(readFileSync(destination)).digest('hex');
      return { id: randomUUID(), name: basename(source), rootId: 'project', relativePath: relative(target.projectRoot, destination).replaceAll('\\', '/'), sha256, size, ...(mediaType(source) ? { mediaType: mediaType(source) } : {}) };
    });
  });
  ipcMain.handle('workspace:authorize-root', async (_event, access: unknown) => {
    if (!['read_only', 'ask', 'trusted'].includes(String(access))) throw new Error(copy.invalidWorkspaceAccess);
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: copy.authorizeWorkspace,
      message: copy.authorizeWorkspaceDetail,
      properties: ['openDirectory', 'createDirectory'],
    });
    const selected = selection.filePaths[0];
    if (selection.canceled || !selected) return undefined;
    const response = await runtimeRequest('/api/workspace/roots', {
      method: 'POST', body: JSON.stringify({ path: selected, access, confirmed: true }),
    });
    return await response.json();
  });
  ipcMain.handle('workspace:open-path', async (_event, ref: unknown) => {
    if (typeof ref !== 'object' || ref === null) throw new Error(copy.invalidWorkspaceRef);
    const response = await runtimeRequest('/api/workspace/shell-path', { method: 'POST', body: JSON.stringify(ref) });
    const body = await response.json() as { path?: string };
    if (!body.path) throw new Error(copy.unresolvedWorkspaceFile);
    const error = await shell.openPath(body.path);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle('workspace:import-files', async (_event, directory: unknown) => {
    if (typeof directory !== 'object' || directory === null) throw new Error(copy.invalidWorkspaceTarget);
    const target = directory as { rootId?: unknown; path?: unknown };
    if (typeof target.rootId !== 'string' || typeof target.path !== 'string') throw new Error(copy.invalidWorkspaceTarget);
    const selection = await dialog.showOpenDialog(mainWindow!, { title: copy.importToWorkspace, properties: ['openFile', 'multiSelections'] });
    if (selection.canceled) return [];
    const changes: string[] = [];
    for (const sourcePath of selection.filePaths.slice(0, 100)) {
      const targetPath = `${target.path === '.' ? '' : `${target.path.replaceAll('\\', '/')}/`}${basename(sourcePath)}`;
      const response = await runtimeRequest('/api/workspace/files/operate', {
        method: 'POST', body: JSON.stringify({ operation: { type: 'import', sourcePath, target: { rootId: target.rootId, path: targetPath } }, confirmed: true }),
      });
      const change = await response.json() as { id?: string };
      if (change.id) changes.push(change.id);
    }
    return changes;
  });
  ipcMain.handle('message:save-png', async (_event, dataUrl: unknown, suggestedName: unknown) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) throw new Error(copy.invalidMessageImage);
    const encoded = dataUrl.slice('data:image/png;base64,'.length);
    const binary = Buffer.from(encoded, 'base64');
    if (binary.length === 0 || binary.length > 20 * 1024 * 1024) throw new Error(copy.messageImageTooLarge);
    const safeName = typeof suggestedName === 'string' ? suggestedName.replace(/[^\p{L}\p{N}._-]/gu, '-').slice(0, 120) : 'openlab-message';
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: copy.saveMessageImage, defaultPath: `${safeName || 'openlab-message'}.png`, filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return false;
    writeFileSync(result.filePath, binary);
    return true;
  });
  ipcMain.handle('project:open-root', async (_event, rawRootPath: unknown) => {
    const rootPath = resolveProjectFolder(rawRootPath);
    const error = await shell.openPath(rootPath);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle('conversation:start', async (_event, input: unknown) => await startConversationTransaction(input));
  ipcMain.handle('conversation:activate', async (_event, input: unknown) => await activateConversationTransaction(input));
  ipcMain.handle('clipboard:write-text', (_event, value: unknown) => {
    if (typeof value !== 'string' || value.length > 2_000_000) throw new Error('Invalid clipboard text');
    clipboard.writeText(value);
    return true;
  });
  ipcMain.handle('shell:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string' || !/^https:\/\//u.test(url) || url.length > 4_096) throw new Error(copy.httpsOnly);
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle('extension:export-plugin', async (_event, id: unknown, name: unknown) => {
    if (typeof id !== 'string' || typeof name !== 'string') throw new Error(copy.invalidPluginExport);
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: copy.exportPlugin,
      defaultPath: `${name.replace(/[^a-zA-Z0-9._-]/gu, '-')}.zip`,
      filters: [{ name: copy.zipArchive, extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await runtimeRequest(`/api/plugins/${encodeURIComponent(id)}/export`, { method: 'POST', body: JSON.stringify({ destination: result.filePath, confirmed: true }) });
    return true;
  });
  ipcMain.handle('data:export-diagnostics', async () => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: copy.exportDiagnostics,
      defaultPath: `openlab-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return false;
    const diagnostics = await runtimeRequest('/api/diagnostics');
    writeFileSync(result.filePath, `${JSON.stringify(await diagnostics.json(), null, 2)}\n`, 'utf8');
    return true;
  });
  ipcMain.handle('data:backup', async () => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: copy.backupDatabase,
      defaultPath: `openlab-backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await runtimeRequest('/api/data/backup', { method: 'POST', body: JSON.stringify({ destination: result.filePath, confirmed: true }) });
    return true;
  });
  ipcMain.handle('browser:list', () => ({ profiles: browserManager?.profiles() ?? [], sessions: browserManager?.sessions() ?? [] }));
  ipcMain.handle('browser:create-profile', (_event, raw: unknown) => {
    if (!browserManager || !raw || typeof raw !== 'object') throw new Error('Browser host is unavailable');
    const input = raw as { name?: unknown; projectId?: unknown };
    if (typeof input.name !== 'string' || typeof input.projectId !== 'string') throw new Error('Browser profile input is invalid');
    return browserManager.createProfile(input.name, input.projectId);
  });
  ipcMain.handle('browser:authorize-profile', (_event, raw: unknown) => {
    if (!browserManager || !raw || typeof raw !== 'object') throw new Error('Browser host is unavailable');
    const input = raw as { profileId?: unknown; projectId?: unknown; confirmed?: unknown };
    if (typeof input.profileId !== 'string' || typeof input.projectId !== 'string') throw new Error('Browser profile authorization is invalid');
    return browserManager.authorizeProfile(input.profileId, input.projectId, input.confirmed === true);
  });
  ipcMain.handle('browser:open', async (_event, raw: unknown) => {
    if (!browserManager || !raw || typeof raw !== 'object') throw new Error('Browser host is unavailable');
    const input = raw as Record<string, unknown>;
    for (const key of ['profileId', 'projectId', 'instanceId', 'paneId', 'url']) if (typeof input[key] !== 'string') throw new Error('Browser session input is invalid');
    return await browserManager.open({
      profileId: input.profileId as string,
      projectId: input.projectId as string,
      instanceId: input.instanceId as string,
      paneId: input.paneId as string,
      ...(input.surface === 'workspace_preview' || input.surface === 'worktable' ? { surface: input.surface } : {}),
      url: input.url as string,
      confirmed: input.confirmed === true,
    });
  });
  ipcMain.handle('browser:navigate', async (_event, raw: unknown) => {
    if (!browserManager || !raw || typeof raw !== 'object') throw new Error('Browser host is unavailable');
    const input = raw as { sessionId?: unknown; url?: unknown; confirmed?: unknown };
    if (typeof input.sessionId !== 'string' || typeof input.url !== 'string') throw new Error('Browser navigation input is invalid');
    return await browserManager.navigate(input.sessionId, input.url, input.confirmed === true);
  });
  ipcMain.handle('browser:history', async (_event, raw: unknown) => {
    if (!browserManager || !raw || typeof raw !== 'object') throw new Error('Browser host is unavailable');
    const input = raw as { sessionId?: unknown; action?: unknown };
    if (typeof input.sessionId !== 'string' || !['back', 'forward', 'reload'].includes(String(input.action))) throw new Error('Browser history input is invalid');
    return await browserManager.history(input.sessionId, input.action as 'back' | 'forward' | 'reload');
  });
  ipcMain.handle('browser:observe', async (_event, sessionId: unknown) => {
    if (!browserManager || typeof sessionId !== 'string') throw new Error('Browser session is invalid');
    return await browserManager.observe(sessionId);
  });
  ipcMain.handle('browser:act', async (_event, raw: unknown) => {
    if (!browserManager || !raw || typeof raw !== 'object') throw new Error('Browser host is unavailable');
    const input = raw as Record<string, unknown>;
    if (typeof input.sessionId !== 'string' || typeof input.observationId !== 'string') throw new Error('Browser action input is invalid');
    return await browserManager.act({
      sessionId: input.sessionId,
      observationId: input.observationId,
      action: parseBrowserAutomationAction(input.action),
      ...(typeof input.ref === 'string' ? { ref: input.ref } : {}),
      ...(typeof input.value === 'string' ? { value: input.value } : {}),
      confirmed: input.confirmed === true,
    });
  });
  ipcMain.handle('browser:screenshot', async (_event, raw: unknown) => {
    if (!browserManager || !raw || typeof raw !== 'object') throw new Error('Browser host is unavailable');
    const input = raw as { sessionId?: unknown; observationId?: unknown };
    if (typeof input.sessionId !== 'string' || typeof input.observationId !== 'string') throw new Error('Browser screenshot input is invalid');
    return await browserManager.screenshot(input.sessionId, input.observationId);
  });
  ipcMain.handle('browser:read-screenshot', (_event, resourceId: unknown) => {
    if (!browserManager || typeof resourceId !== 'string') throw new Error('Browser screenshot resource is invalid');
    const result = browserManager.readScreenshot(resourceId);
    return `data:${result.resource.mediaType};base64,${result.bytes.toString('base64')}`;
  });
  ipcMain.handle('browser:choose-upload', async () => {
    if (!browserManager) throw new Error('Browser host is unavailable');
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: copy.chooseBrowserUpload,
      properties: ['openFile', 'multiSelections'],
    });
    if (selection.canceled) return [];
    return await browserManager.prepareUploads(selection.filePaths);
  });
  ipcMain.handle('browser:upload', async (_event, raw: unknown) => {
    if (!browserManager || !raw || typeof raw !== 'object') throw new Error('Browser host is unavailable');
    const input = raw as Record<string, unknown>;
    if (typeof input.sessionId !== 'string' || typeof input.observationId !== 'string' || typeof input.ref !== 'string' || !Array.isArray(input.uploadIds) || input.uploadIds.some((id) => typeof id !== 'string')) throw new Error('Browser upload input is invalid');
    return await browserManager.upload({
      sessionId: input.sessionId,
      observationId: input.observationId,
      ref: input.ref,
      uploadIds: input.uploadIds as string[],
      confirmed: input.confirmed === true,
    });
  });
  ipcMain.handle('browser:download', async (_event, raw: unknown) => {
    if (!browserManager || !raw || typeof raw !== 'object') throw new Error('Browser host is unavailable');
    const input = raw as Record<string, unknown>;
    if (typeof input.sessionId !== 'string' || typeof input.observationId !== 'string' || typeof input.ref !== 'string') throw new Error('Browser download input is invalid');
    return await browserManager.download({
      sessionId: input.sessionId,
      observationId: input.observationId,
      ref: input.ref,
      confirmed: input.confirmed === true,
    });
  });
  ipcMain.handle('browser:set-bounds', (_event, raw: unknown) => {
    if (!browserManager || !raw || typeof raw !== 'object') throw new Error('Browser host is unavailable');
    const input = raw as { sessionId?: unknown; bounds?: Partial<BrowserViewBounds>; visible?: unknown };
    if (typeof input.sessionId !== 'string' || !input.bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(input.bounds?.[key as keyof BrowserViewBounds]))) throw new Error('Browser bounds are invalid');
    browserManager.setBounds(input.sessionId, input.bounds as BrowserViewBounds, input.visible === true);
    return true;
  });
  ipcMain.handle('browser:hide-all', () => { browserManager?.hideAll(); return true; });
  ipcMain.handle('browser:close', (_event, sessionId: unknown) => {
    if (!browserManager || typeof sessionId !== 'string') throw new Error('Browser session is invalid');
    return browserManager.close(sessionId);
  });
  ipcMain.handle('window:new', async () => { await createWindow(); return true; });
  ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.on('window:maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window?.isMaximized()) window.unmaximize(); else window?.maximize();
  });
  ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.on('edit:command', (event, raw: unknown) => {
    if (typeof raw !== 'string' || !['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll'].includes(raw)) return;
    const contents = event.sender;
    if (raw === 'undo') contents.undo();
    else if (raw === 'redo') contents.redo();
    else if (raw === 'cut') contents.cut();
    else if (raw === 'copy') contents.copy();
    else if (raw === 'paste') contents.paste();
    else if (raw === 'delete') contents.delete();
    else contents.selectAll();
  });
  ipcMain.on('view:command', (event, raw: unknown) => {
    if (typeof raw !== 'string' || !['zoom-in', 'zoom-out', 'reset-zoom', 'toggle-fullscreen', 'reload'].includes(raw)) return;
    const contents = event.sender;
    if (raw === 'reload') {
      contents.reload();
      return;
    }
    if (raw === 'toggle-fullscreen') {
      const window = BrowserWindow.fromWebContents(contents);
      if (window) window.setFullScreen(!window.isFullScreen());
      return;
    }
    const next = raw === 'reset-zoom'
      ? 1
      : Math.min(3, Math.max(.5, Math.round((contents.getZoomFactor() + (raw === 'zoom-in' ? .1 : -.1)) * 10) / 10));
    contents.setZoomFactor(next);
  });
  ipcMain.on('view:find-in-page', (event, raw: unknown) => {
    const query = typeof raw === 'string' ? raw.trim().slice(0, 500) : '';
    if (query) event.sender.findInPage(query);
    else event.sender.stopFindInPage('clearSelection');
  });
  ipcMain.handle('view:open-terminal', () => {
    const target = selectedProjectRoot() ?? process.cwd();
    const terminal = spawn('powershell.exe', ['-NoLogo', '-NoExit'], {
      cwd: target,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    terminal.unref();
    return true;
  });
}

const ownsSingleInstance = app.requestSingleInstanceLock();

if (!ownsSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

app.whenReady().then(async () => {
  browserBroker = new BrowserAutomationBroker(() => browserManager);
  browserBrokerConnection = await browserBroker.start();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    // Generated-app assets carry a per-app CSP assembled by Runtime from the
    // user-approved network domain list. Replacing it with the renderer CSP
    // would silently disable that policy (and its sandbox directive).
    const generatedApp = /^http:\/\/127\.0\.0\.1:\d+\/generated-apps\//u.test(details.url);
    if (generatedApp) {
      callback({ responseHeaders: headers });
      return;
    }
    const pluginPanel = details.resourceType === 'subFrame' && /^http:\/\/127\.0\.0\.1:\d+\/plugin-panels\//u.test(details.url);
    headers['Content-Security-Policy'] = [pluginPanel
      ? "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; media-src data:; frame-src http://127.0.0.1:*; object-src http://127.0.0.1:*; form-action 'none'; base-uri 'none'; frame-ancestors file: http://127.0.0.1:*"
      : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
        "frame-src 'self' http://127.0.0.1:*",
        "object-src 'none'",
        "base-uri 'self'",
      ].join('; ')];
    callback({ responseHeaders: headers });
  });
  registerIpc();
  await createWindow();
  nativeTheme.on('updated', () => {
    const preferences = currentInterfacePreferences();
    if (preferences.theme === 'auto') applyWindowChrome(preferences);
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch((error) => {
  void dialog.showErrorBox(copy.startupFailed, error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  browserManager?.dispose();
  browserManager = undefined;
  if (runtimePrewarmTimer) {
    clearTimeout(runtimePrewarmTimer);
    runtimePrewarmTimer = undefined;
  }
  if (runtimeChildren.size === 0) {
    void browserBroker?.close();
    return;
  }
  event.preventDefault();
  const children = [...runtimeChildren];
  runtimeChild = undefined;
  connection = undefined;
  runtimeReady = undefined;
  runtimeSlots.clear();
  void Promise.all(children.map((child) => stopRuntimeChild(child))).finally(async () => {
    await browserBroker?.close();
    browserBroker = undefined;
    browserBrokerConnection = undefined;
    app.exit(0);
  });
});
}
