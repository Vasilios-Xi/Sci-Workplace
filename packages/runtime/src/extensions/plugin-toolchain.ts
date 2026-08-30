import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@openlab/protocol';
import { spawnWithResourceLimits } from '../security/windows-job-host.js';
import { physicalAsarPath } from '../util/asar.js';
import { atomicWriteJson, atomicWriteText } from '../util/files.js';

export type PluginDependencyKind = 'dependency' | 'optional' | 'development' | 'peer';

export interface PluginDependencyDescriptor {
  name: string;
  specifier: string;
  kind: PluginDependencyKind;
}

export interface PluginPackageInspection {
  dependencies: PluginDependencyDescriptor[];
  lifecycleScriptsIgnored: string[];
  packageManagerConfigurationIgnored: boolean;
}

export interface PluginDependencyInstallOptions {
  cacheRoot?: string;
  registry?: string;
}

const MAX_PACKAGE_JSON_BYTES = 1_000_000;
const MAX_DEPENDENCIES = 128;
const MAX_OUTPUT_BYTES = 128 * 1024;
const IGNORED_PACKAGE_MANAGER_FILES = ['.npmrc', '.pnpmfile.cjs', '.pnpmfile.js', '.yarnrc', '.yarnrc.yml', 'pnpm-workspace.yaml'];
const requireFromRuntime = createRequire(import.meta.url);

function packageRoot(name: string): string {
  return dirname(physicalAsarPath(requireFromRuntime.resolve(name)));
}

function pnpmEntry(): string {
  return join(packageRoot('pnpm'), 'bin', 'pnpm.mjs');
}

function typescriptEntry(): string {
  const bundledRoot = process.env.OPENLAB_BUNDLED_TOOLCHAIN_ROOT;
  if (bundledRoot) {
    const bundledEntry = join(resolve(bundledRoot), 'typescript', 'bin', 'tsc');
    if (!existsSync(bundledEntry)) throw new Error('打包的 TypeScript 工具链不完整');
    return bundledEntry;
  }
  return physicalAsarPath(requireFromRuntime.resolve('typescript/bin/tsc'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dependencyMap(value: unknown, kind: PluginDependencyKind): PluginDependencyDescriptor[] {
  if (value === undefined) return [];
  if (!isRecord(value)) throw new Error(`package.json 的 ${kind} 依赖必须是对象`);
  return Object.entries(value).map(([name, specifier]) => {
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu.test(name)) {
      throw new Error(`插件依赖名称不合法：${name}`);
    }
    if (typeof specifier !== 'string' || !specifier.trim()) throw new Error(`插件依赖版本不能为空：${name}`);
    const normalized = specifier.trim();
    if (/^(?:\.{0,2}[\\/]|[a-z]:[\\/]|[\\/]|file:|link:|workspace:|portal:|git(?:\+[^:]*)?:|https?:|ssh:|github:|gitlab:|bitbucket:)/iu.test(normalized)) {
      throw new Error(`插件依赖 ${name} 使用了不允许的本地路径或非注册表来源：${normalized}`);
    }
    return { name, specifier: normalized, kind };
  });
}

export function inspectPluginPackage(root: string): PluginPackageInspection {
  const packagePath = join(resolve(root), 'package.json');
  if (!existsSync(packagePath)) return {
    dependencies: [], lifecycleScriptsIgnored: [],
    packageManagerConfigurationIgnored: IGNORED_PACKAGE_MANAGER_FILES.some((name) => existsSync(join(resolve(root), name))),
  };
  if (!statSync(packagePath).isFile() || statSync(packagePath).size > MAX_PACKAGE_JSON_BYTES) throw new Error('插件 package.json 无效或超过 1 MB');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as unknown; }
  catch (error) { throw new Error(`插件 package.json 解析失败：${error instanceof Error ? error.message : String(error)}`); }
  if (!isRecord(parsed)) throw new Error('插件 package.json 必须是对象');
  const dependencies = [
    ...dependencyMap(parsed.dependencies, 'dependency'),
    ...dependencyMap(parsed.optionalDependencies, 'optional'),
    ...dependencyMap(parsed.devDependencies, 'development'),
    ...dependencyMap(parsed.peerDependencies, 'peer'),
  ];
  if (dependencies.length > MAX_DEPENDENCIES) throw new Error(`插件依赖数量超过上限（${MAX_DEPENDENCIES}）`);
  const installedNames = new Set<string>();
  for (const dependency of dependencies.filter((item) => item.kind !== 'peer')) {
    if (installedNames.has(dependency.name)) throw new Error(`插件依赖在多个分组中重复声明：${dependency.name}`);
    installedNames.add(dependency.name);
  }
  const scripts = isRecord(parsed.scripts)
    ? Object.entries(parsed.scripts).filter(([, command]) => typeof command === 'string' && command.trim()).map(([name]) => name)
    : [];
  return {
    dependencies,
    lifecycleScriptsIgnored: scripts,
    packageManagerConfigurationIgnored: parsed.pnpm !== undefined || parsed.resolutions !== undefined || parsed.overrides !== undefined
      || IGNORED_PACKAGE_MANAGER_FILES.some((name) => existsSync(join(resolve(root), name))),
  };
}

function minimalEnvironment(toolHome: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    ELECTRON_RUN_AS_NODE: '1',
    CI: '1',
    NO_UPDATE_NOTIFIER: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_USERCONFIG: join(toolHome, 'npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(toolHome, 'global-npmrc'),
    OPENLAB_PLUGIN_TOOLCHAIN: '1',
  };
}

async function runBoundedCommand(options: {
  label: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  memoryMb: number;
  cpuMs: number;
  activeProcesses: number;
  env: NodeJS.ProcessEnv;
  stdin?: string;
}): Promise<string> {
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawnWithResourceLimits(process.execPath, options.args, {
      cwd: options.cwd,
      env: options.env,
      limits: { memoryMb: options.memoryMb, cpuMs: options.cpuMs, activeProcesses: options.activeProcesses },
    });
    let output = '';
    let outputBytes = 0;
    let termination: Error | undefined;
    let settled = false;
    const append = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES && !termination) {
        termination = new Error(`${options.label} 输出超过 ${MAX_OUTPUT_BYTES / 1024} KB 上限`);
        child.kill();
        return;
      }
      if (outputBytes <= MAX_OUTPUT_BYTES) output += chunk.toString('utf8');
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.stdin.end(options.stdin ?? '');
    const timer = setTimeout(() => {
      termination = new Error(`${options.label} 超过 ${Math.round(options.timeoutMs / 1000)} 秒限制`);
      child.kill();
    }, options.timeoutMs);
    const abort = () => {
      termination = options.signal?.reason instanceof Error ? options.signal.reason : new DOMException('Aborted', 'AbortError');
      child.kill();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolvePromise(output.trim());
    };
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (termination) return finish(termination);
      if (code !== 0) return finish(new Error(output.trim() || `${options.label} 失败（退出码 ${code ?? 'terminated'}）`));
      finish();
    });
  });
}

function assertPortableDependencyTree(root: string): void {
  const nodeModules = join(root, 'node_modules');
  if (!existsSync(nodeModules)) return;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`依赖安装产生了不可移植的符号链接：${relative(root, path)}`);
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(nodeModules);
}

export async function preparePluginDependencies(
  root: string,
  mode: 'test' | 'production',
  signal?: AbortSignal,
  options: PluginDependencyInstallOptions = {},
): Promise<PluginPackageInspection> {
  const resolvedRoot = resolve(root);
  const cacheRoot = options.cacheRoot ?? join(tmpdir(), 'openlab-plugin-package-cache-v1');
  const inspection = inspectPluginPackage(resolvedRoot);
  const nodeModules = join(resolvedRoot, 'node_modules');
  rmSync(nodeModules, { recursive: true, force: true });
  for (const name of IGNORED_PACKAGE_MANAGER_FILES) rmSync(join(resolvedRoot, name), { recursive: true, force: true });
  const selected = inspection.dependencies.filter((dependency) =>
    dependency.kind === 'dependency' || dependency.kind === 'optional' || (mode === 'test' && dependency.kind === 'development'),
  );
  if (selected.length === 0) return inspection;
  const lockPath = join(resolvedRoot, 'pnpm-lock.yaml');
  const groups = (kind: PluginDependencyKind) => Object.fromEntries(selected.filter((item) => item.kind === kind).map((item) => [item.name, item.specifier]));
  const sanitizedPackage = {
    name: 'openlab-plugin-candidate', version: '0.0.0', private: true, type: 'module',
    dependencies: groups('dependency'), optionalDependencies: groups('optional'),
    ...(mode === 'test' ? { devDependencies: groups('development') } : {}),
  };
  const toolHome = mkdtempSync(join(tmpdir(), 'openlab-plugin-dependencies-'));
  const installRoot = join(toolHome, 'workspace');
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });
  atomicWriteText(join(toolHome, 'npmrc'), '');
  atomicWriteText(join(toolHome, 'global-npmrc'), '');
  atomicWriteJson(join(installRoot, 'package.json'), sanitizedPackage);
  rmSync(lockPath, { force: true });
  try {
    await runBoundedCommand({
      label: '插件依赖安装', cwd: installRoot, ...(signal ? { signal } : {}), timeoutMs: 120_000, memoryMb: 1_024, cpuMs: 120_000, activeProcesses: 24,
      env: minimalEnvironment(toolHome),
      args: [
        pnpmEntry(), 'install', '--ignore-scripts', '--ignore-workspace', '--no-frozen-lockfile', '--reporter=append-only',
        '--node-linker=hoisted', '--package-import-method=copy', '--store-dir', cacheRoot,
        ...(options.registry ? ['--registry', options.registry] : []),
        ...(mode === 'production' ? ['--prod'] : []),
      ],
    });
    assertPortableDependencyTree(installRoot);
    cpSync(join(installRoot, 'node_modules'), nodeModules, { recursive: true, errorOnExist: true });
    cpSync(join(installRoot, 'pnpm-lock.yaml'), lockPath, { errorOnExist: true });
    assertPortableDependencyTree(resolvedRoot);
  } catch (error) {
    rmSync(nodeModules, { recursive: true, force: true });
    rmSync(lockPath, { force: true });
    throw error;
  } finally {
    rmSync(toolHome, { recursive: true, force: true });
  }
  return inspection;
}

export async function typecheckPlugin(root: string, manifest: PluginManifest, signal?: AbortSignal): Promise<string> {
  const extension = extname(manifest.entry).toLocaleLowerCase();
  if (!['.ts', '.mts', '.cts'].includes(extension)) return 'typecheck: skipped (JavaScript entry)';
  const resolvedRoot = resolve(root);
  const tsc = typescriptEntry();
  const typescriptRoot = dirname(dirname(tsc));
  const toolHome = join(resolvedRoot, '.openlab-typecheck');
  mkdirSync(toolHome, { recursive: true });
  atomicWriteText(join(toolHome, 'npmrc'), '');
  try {
    await runBoundedCommand({
      label: '插件 TypeScript 类型检查', cwd: resolvedRoot, ...(signal ? { signal } : {}), timeoutMs: 45_000, memoryMb: 768, cpuMs: 45_000, activeProcesses: 2,
      env: minimalEnvironment(toolHome),
      args: [
        '--permission', `--allow-fs-read=${resolvedRoot}`, `--allow-fs-read=${typescriptRoot}`,
        tsc, '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
        '--skipLibCheck', '--allowImportingTsExtensions', '--verbatimModuleSyntax', '--noUncheckedIndexedAccess', resolve(resolvedRoot, manifest.entry),
      ],
    });
    return 'typecheck: ok';
  } finally {
    rmSync(toolHome, { recursive: true, force: true });
  }
}

export async function runPluginContract(root: string, manifest: PluginManifest, signal?: AbortSignal): Promise<string> {
  const resolvedRoot = resolve(root);
  const contract = join(resolvedRoot, 'contract.test.mjs');
  if (!existsSync(contract) || !statSync(contract).isFile()) throw new Error('插件缺少 contract.test.mjs');
  const compiledRunner = physicalAsarPath(fileURLToPath(new URL('./plugin-contract-runner.js', import.meta.url)));
  const runner = existsSync(compiledRunner) ? compiledRunner : physicalAsarPath(fileURLToPath(new URL('./plugin-contract-runner.ts', import.meta.url)));
  const toolHome = join(resolvedRoot, '.openlab-contract');
  const allowLegacyDirectCapabilities = (manifest.apiVersion ?? 1) !== 4;
  mkdirSync(toolHome, { recursive: true });
  atomicWriteText(join(toolHome, 'npmrc'), '');
  try {
    const output = await runBoundedCommand({
      label: '插件契约测试', cwd: resolvedRoot, ...(signal ? { signal } : {}), timeoutMs: 30_000, memoryMb: 768, cpuMs: 30_000,
      activeProcesses: allowLegacyDirectCapabilities && manifest.permissions.includes('process:spawn') ? 8 : 2,
      env: {
        ...minimalEnvironment(toolHome),
        OPENLAB_PLUGIN_NETWORK: allowLegacyDirectCapabilities && manifest.permissions.includes('network') ? '1' : '0',
      },
      stdin: 'START\n',
      args: [
        '--experimental-transform-types', '--permission',
        `--allow-fs-read=${resolvedRoot}`, `--allow-fs-read=${dirname(runner)}`, `--allow-fs-write=${resolvedRoot}`,
        ...(allowLegacyDirectCapabilities && manifest.permissions.includes('process:spawn') ? ['--allow-child-process'] : []),
        runner, resolvedRoot, contract,
      ],
    });
    return output || 'Sci Workplace plugin contract: ok';
  } finally {
    rmSync(toolHome, { recursive: true, force: true });
  }
}
