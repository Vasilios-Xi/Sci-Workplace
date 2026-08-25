import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, session, shell } from 'electron';
import {
  mergeInterfacePreferences,
  normalizeInterfacePreferences,
  type InterfacePreferences,
  type InterfacePreferencesPatch,
  type InterfacePreferencesUpdateResult,
  type WorktableDeviceUiState,
} from '@openlab/protocol';
import { desktopZhCN as copy } from './i18n/zh-CN.js';
import { readDesktopSettings, writeDesktopSettingsAtomic, type DesktopSettings } from './settings-store.js';
import { WorktableBrowserManager, type BrowserViewBounds } from './browser-manager.js';
import { BrowserAutomationBroker } from './browser-broker.js';
import { parseBrowserAutomationAction } from './browser-security.js';
import { projectFolderSelection, projectGitBranch, resolveProjectFolder, writeProjectManifest } from './project-manifest.js';

interface RuntimeConnection {
  baseUrl: string;
  token: string;
  projectRoot: string;
  projectFolderSelected: boolean;
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
// Keep the legacy data directory so the product rename does not strand existing
// conversations, credentials, preferences, or project bindings.
const appDataRoot = process.env.OPENLAB_TEST_USER_DATA_ROOT
  ? resolve(process.env.OPENLAB_TEST_USER_DATA_ROOT)
  : join(app.getPath('appData'), 'OpenLab');
app.setPath('userData', appDataRoot);

let mainWindow: BrowserWindow | undefined;
let runtimeChild: ChildProcess | undefined;
let connection: RuntimeConnection | undefined;
let runtimeReady: Promise<RuntimeConnection> | undefined;
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

async function runtimeRequest(path: string, init?: RequestInit): Promise<Response> {
  const target = connection ?? await startRuntime();
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

async function stopRuntime(): Promise<void> {
  const child = runtimeChild;
  runtimeChild = undefined;
  connection = undefined;
  runtimeReady = undefined;
  if (!child) return;
  child.send?.({ type: 'shutdown' });
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => { child.kill(); resolvePromise(); }, 10_000);
    child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
  });
}

function startRuntime(projectRoot = defaultProjectRoot()): Promise<RuntimeConnection> {
  if (runtimeReady) return runtimeReady;
  runtimeReady = new Promise<RuntimeConnection>((resolvePromise, reject) => {
    const childEntry = require.resolve('@openlab/runtime/child');
    const authToken = randomBytes(32).toString('hex');
    const child = fork(childEntry, [], {
      cwd: projectRoot,
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...(app.isPackaged ? { OPENLAB_BUNDLED_TOOLCHAIN_ROOT: join(process.resourcesPath, 'openlab-toolchain') } : {}),
        OPENLAB_READER_RUNTIME_ROOT: app.isPackaged
          ? join(process.resourcesPath, 'reader-runtime')
          : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'reader-runtime', 'dist', 'reader-worker'),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    runtimeChild = child;
    let startupSettled = false;
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (!app.isPackaged) process.stderr.write(chunk);
    });
    const timer = setTimeout(() => {
      if (startupSettled) return;
      startupSettled = true;
      if (runtimeChild === child) {
        runtimeChild = undefined;
        connection = undefined;
        runtimeReady = undefined;
      }
      child.kill();
      reject(new Error(copy.runtimeStartTimeout));
    }, 90_000);
    child.on('message', (message: RuntimeReadyMessage | RuntimeErrorMessage) => {
      if (message.type === 'error') {
        if (startupSettled) return;
        startupSettled = true;
        clearTimeout(timer);
        child.kill();
        reject(new Error(message.message));
        return;
      }
      if (message.type === 'ready' && !startupSettled) {
        startupSettled = true;
        clearTimeout(timer);
        connection = { baseUrl: message.url, token: message.authToken, projectRoot, projectFolderSelected: selectedProjectRoot() === resolve(projectRoot) };
        resolvePromise(connection);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
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
    child.send({
      type: 'start',
      config: {
        host: '127.0.0.1', port: 0, authToken, projectRoot,
        home: app.getPath('userData'), demo: false,
        credentials: readMcpCredentials(),
        ...(browserBrokerConnection ? { browserBroker: browserBrokerConnection } : {}),
        ...(readDeepSeekKey() ? { deepSeekApiKey: readDeepSeekKey() } : {}),
      },
    });
  });
  return runtimeReady;
}

function rendererEntry(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'renderer', 'index.html');
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'renderer', 'dist', 'index.html');
}

async function createWindow(): Promise<void> {
  await startRuntime();
  const preload = join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs');
  const preferences = currentInterfacePreferences();
  const chrome = windowChrome(preferences);
  mainWindow = new BrowserWindow({
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
  browserManager = new WorktableBrowserManager({
    window: mainWindow,
    userData: app.getPath('userData'),
    onChanged: (profiles, sessions) => {
      void runtimeRequest('/api/browser/state', {
        method: 'POST',
        body: JSON.stringify({ profiles, sessions }),
      }).catch(() => undefined);
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//u.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.OPENLAB_RENDERER_URL;
    if ((allowed && url.startsWith(allowed)) || url.startsWith('file:')) return;
    event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    const capturePath = process.env.OPENLAB_CAPTURE_PATH;
    if (capturePath) {
      setTimeout(() => {
        void mainWindow?.webContents.capturePage().then((image) => {
          mkdirSync(dirname(resolve(capturePath)), { recursive: true });
          writeFileSync(resolve(capturePath), image.toPNG());
          app.quit();
        });
      }, 1_500);
    }
  });
  const developmentUrl = process.env.OPENLAB_RENDERER_URL;
  if (developmentUrl) await mainWindow.loadURL(developmentUrl);
  else await mainWindow.loadFile(rendererEntry());
}

function registerIpc(): void {
  ipcMain.handle('runtime:get-connection', async () => connection ?? await startRuntime());
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
    return { configured: true, protected: true };
  });
  ipcMain.handle('credential:save', async (_event, raw: unknown) => {
    if (typeof raw !== 'string' || !raw) throw new Error(copy.credentialEmpty);
    const id = saveMcpCredential(raw);
    await runtimeRequest('/api/credentials', { method: 'POST', body: JSON.stringify({ id, value: raw }) });
    return id;
  });
  ipcMain.handle('project:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: copy.chooseProject, properties: ['openDirectory', 'createDirectory'] });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return undefined;
    writeSettings({ ...readSettings(), projectRoot: selected });
    await stopRuntime();
    const next = await startRuntime(selected);
    return next;
  });
  ipcMain.handle('project:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: copy.chooseProjectSource, properties: ['openDirectory', 'createDirectory'] });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return undefined;
    return projectFolderSelection(selected);
  });
  ipcMain.handle('project:activate', async (_event, input: unknown) => {
    const value = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const requestedFolders = Array.isArray(value.sourceFolders) ? value.sourceFolders : [value.rootPath];
    const folders = [...new Map(requestedFolders.slice(0, 12).map((candidate) => {
      const path = resolveProjectFolder(candidate);
      return [path.toLocaleLowerCase(), path] as const;
    })).values()];
    const selected = folders[0];
    if (!selected) throw new Error(copy.projectSourceRequired);
    writeProjectManifest(selected, typeof value.name === 'string' ? value.name : '');
    writeSettings({ ...readSettings(), projectRoot: selected });
    await stopRuntime();
    const next = await startRuntime(selected);
    for (const path of folders.slice(1)) {
      await runtimeRequest('/api/workspace/roots', {
        method: 'POST', body: JSON.stringify({ path, access: 'trusted', confirmed: true }),
      });
    }
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
    const { projectRoot: _projectRoot, ...settings } = readSettings();
    writeSettings(settings);
    await stopRuntime();
    return await startRuntime(defaultProjectRoot());
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
        id: randomUUID(), name: basename(source),
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
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
  ipcMain.on('window:close', () => mainWindow?.close());
}

app.whenReady().then(async () => {
  browserBroker = new BrowserAutomationBroker(() => browserManager);
  browserBrokerConnection = await browserBroker.start();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    const pluginPanel = details.resourceType === 'subFrame' && /^http:\/\/127\.0\.0\.1:\d+\/plugin-panels\//u.test(details.url);
    headers['Content-Security-Policy'] = [pluginPanel
      ? "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; media-src data:; form-action 'none'; base-uri 'none'; frame-ancestors file: http://127.0.0.1:*"
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
  if (!runtimeChild) {
    void browserBroker?.close();
    return;
  }
  event.preventDefault();
  void stopRuntime().finally(async () => {
    await browserBroker?.close();
    browserBroker = undefined;
    browserBrokerConnection = undefined;
    app.exit(0);
  });
});
