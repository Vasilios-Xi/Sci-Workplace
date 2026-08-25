import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync,
} from 'node:fs';
import AdmZip from 'adm-zip';
import type { EventActor, ToolchainDescriptor } from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { toJson } from '../util/json.js';

interface ToolchainManifest {
  schemaVersion: 1;
  id: string;
  kind: string;
  name: string;
  version: string;
  executables: Record<string, string>;
  expectedSha256?: string;
  payloadSha256?: string;
  workerVersion?: string;
  capabilities?: string[];
  network?: boolean;
  fileCount?: number;
  totalBytes?: number;
  runtimeInventory?: unknown;
}

interface InstalledToolchain {
  descriptor: ToolchainDescriptor;
  root: string;
  manifest: ToolchainManifest;
}

const MAX_TOOLCHAIN_FILES = 100_000;
const MAX_TOOLCHAIN_BYTES = 20 * 1024 * 1024 * 1024;

function readManifest(root: string): ToolchainManifest {
  const path = join(root, 'openlab-toolchain.json');
  if (!existsSync(path)) throw new Error('工具包缺少 openlab-toolchain.json');
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ToolchainManifest>;
  if (value.schemaVersion !== 1 || typeof value.kind !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(value.kind)) throw new Error('仅支持 schemaVersion 1 的 Sci Workplace 工具包');
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(value.id)) throw new Error('工具包 ID 无效');
  if (typeof value.name !== 'string' || !value.name.trim() || typeof value.version !== 'string' || !value.version.trim()) throw new Error('工具包名称或版本无效');
  if (!value.executables || typeof value.executables !== 'object' || Array.isArray(value.executables)) throw new Error('工具包必须声明 executables');
  const executables: Record<string, string> = {};
  for (const [name, pathValue] of Object.entries(value.executables)) {
    if (!/^[a-zA-Z0-9._-]{1,64}$/u.test(name) || typeof pathValue !== 'string' || isAbsolute(pathValue)) throw new Error(`工具包可执行项无效：${name}`);
    const absolute = resolve(root, pathValue);
    const rel = relative(resolve(root), absolute);
    if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(absolute) || !statSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error(`工具包可执行文件不存在或越界：${name}`);
    executables[name] = pathValue.replaceAll('\\', '/');
  }
  if (value.kind === 'texlive' && (!executables.latexmk || !executables.synctex)) throw new Error('TeX Live 工具包必须包含 latexmk 与 synctex');
  return {
    schemaVersion: 1, id: value.id, kind: value.kind, name: value.name.trim(), version: value.version.trim(), executables,
    ...(typeof value.expectedSha256 === 'string' ? { expectedSha256: value.expectedSha256.toLocaleLowerCase() } : {}),
    ...(typeof value.payloadSha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.payloadSha256) ? { payloadSha256: value.payloadSha256 } : {}),
    ...(typeof value.workerVersion === 'string' ? { workerVersion: value.workerVersion } : {}),
    ...(Array.isArray(value.capabilities) && value.capabilities.every((item) => typeof item === 'string') ? { capabilities: [...value.capabilities] } : {}),
    ...(typeof value.network === 'boolean' ? { network: value.network } : {}),
    ...(Number.isInteger(value.fileCount) && Number(value.fileCount) >= 0 ? { fileCount: Number(value.fileCount) } : {}),
    ...(Number.isInteger(value.totalBytes) && Number(value.totalBytes) >= 0 ? { totalBytes: Number(value.totalBytes) } : {}),
    ...(value.runtimeInventory !== undefined ? { runtimeInventory: value.runtimeInventory } : {}),
  };
}

interface IntegrityManifest {
  schemaVersion: 1;
  algorithm: 'sha256';
  payloadSha256: string;
  fileCount: number;
  totalBytes: number;
  files: Array<{ path: string; size: number; sha256: string }>;
}

const REQUIRED_READER_PARSERS = new Set(['docling', 'docling-core', 'docling-parse', 'docling-ibm-models', 'pdfplumber', 'pypdf', 'pypdfium2']);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Reader Runtime ${label}清单无效`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Reader Runtime ${label}清单无效`);
  return value;
}

function isLicensePayloadPath(path: string): boolean {
  const parts = path.toLocaleLowerCase('en-US').split('/');
  const name = parts.at(-1) ?? '';
  return parts.slice(0, -1).some((part) => part === 'license' || part === 'licenses')
    || /^(?:license|licence|copying|notice)(?:[._-].*)?$/iu.test(name);
}

function verifyReaderRuntimeInventory(manifest: ToolchainManifest, integrity: IntegrityManifest): void {
  if (manifest.kind !== 'reader-runtime') return;
  const inventory = record(manifest.runtimeInventory, '语义');
  if (inventory.schemaVersion !== 1) throw new Error('Reader Runtime 语义清单版本无效');
  const filesByPath = new Map(integrity.files.map((file) => [file.path, file]));
  const verifyReference = (input: unknown, label: string) => {
    const reference = record(input, `${label}文件`);
    if (typeof reference.path !== 'string' || typeof reference.sha256 !== 'string' || !Number.isInteger(reference.size)) throw new Error(`Reader Runtime ${label}文件引用无效`);
    const expected = filesByPath.get(reference.path);
    if (!expected || expected.size !== reference.size || expected.sha256 !== reference.sha256) throw new Error(`Reader Runtime ${label}文件引用与完整性清单不一致`);
    return expected;
  };
  const verifyReferences = (input: unknown, label: string) => array(input, label).map((value) => verifyReference(value, label));

  const worker = record(inventory.worker, 'Worker');
  if (typeof worker.version !== 'string' || !worker.version || worker.version !== manifest.workerVersion) throw new Error('Reader Runtime Worker 版本清单不一致');
  const workerExecutable = verifyReference(worker.executable, 'Worker');
  if (workerExecutable.path !== manifest.executables['reader-worker']?.replaceAll('\\', '/')) throw new Error('Reader Runtime Worker 可执行项清单不一致');

  const components = array(inventory.thirdPartyComponents, '第三方组件');
  if (components.length === 0) throw new Error('Reader Runtime 第三方组件清单为空');
  const componentByName = new Map<string, { version: string; metadataPath: string; licenseFiles: string[] }>();
  const componentMetadataPaths = new Set<string>();
  for (const input of components) {
    const component = record(input, '第三方组件');
    if (typeof component.normalizedName !== 'string' || !component.normalizedName || typeof component.version !== 'string' || !component.version || componentByName.has(component.normalizedName)) {
      throw new Error('Reader Runtime 第三方组件名称或版本无效');
    }
    const metadata = verifyReference(component.metadata, `组件 ${component.normalizedName} metadata`);
    if (!/^_internal\/[^/]+\.dist-info\/METADATA$/u.test(metadata.path) || componentMetadataPaths.has(metadata.path)) throw new Error('Reader Runtime 第三方组件 metadata 清单无效');
    componentMetadataPaths.add(metadata.path);
    const licenseFiles = verifyReferences(component.licenseFiles, `组件 ${component.normalizedName}许可证`).map((file) => file.path);
    if (typeof component.licenseExpression !== 'string' || !component.licenseExpression) throw new Error('Reader Runtime 第三方组件许可证声明无效');
    componentByName.set(component.normalizedName, { version: component.version, metadataPath: metadata.path, licenseFiles });
  }
  const actualComponentMetadata = new Set([...filesByPath.keys()].filter((path) => /^_internal\/[^/]+\.dist-info\/METADATA$/u.test(path)));
  if (actualComponentMetadata.size !== componentMetadataPaths.size || [...actualComponentMetadata].some((path) => !componentMetadataPaths.has(path))) {
    throw new Error('Reader Runtime 第三方组件清单不完整');
  }

  const parsers = array(inventory.parsers, '解析器');
  const parserNames = new Set<string>();
  for (const input of parsers) {
    const parser = record(input, '解析器');
    if (typeof parser.normalizedName !== 'string' || !REQUIRED_READER_PARSERS.has(parser.normalizedName) || parserNames.has(parser.normalizedName) || typeof parser.version !== 'string' || !parser.version) {
      throw new Error('Reader Runtime 解析器名称或版本无效');
    }
    parserNames.add(parser.normalizedName);
    const metadata = verifyReference(parser.metadata, `解析器 ${parser.normalizedName} metadata`);
    const component = componentByName.get(parser.normalizedName);
    if (!component || component.version !== parser.version || component.metadataPath !== metadata.path) throw new Error(`Reader Runtime 解析器与组件清单不一致：${parser.normalizedName}`);
    const parserLicenses = verifyReferences(parser.licenseFiles, `解析器 ${parser.normalizedName}许可证`);
    if ((typeof parser.licenseExpression !== 'string' || !parser.licenseExpression || parser.licenseExpression === 'UNKNOWN') && parserLicenses.length === 0) {
      throw new Error(`Reader Runtime 解析器缺少许可证证据：${parser.normalizedName}`);
    }
  }
  if (parserNames.size !== REQUIRED_READER_PARSERS.size || [...REQUIRED_READER_PARSERS].some((name) => !parserNames.has(name))) throw new Error('Reader Runtime 核心解析器清单不完整');

  const modelAssets = array(inventory.modelAssets, '模型资产');
  if (modelAssets.length === 0) throw new Error('Reader Runtime 模型资产清单为空');
  const declaredModelFiles = new Set<string>();
  const modelIds = new Set<string>();
  for (const input of modelAssets) {
    const model = record(input, '模型资产');
    if (typeof model.id !== 'string' || !/^[a-zA-Z0-9._-]+$/u.test(model.id) || modelIds.has(model.id) || model.path !== `_internal/model-artifacts/${model.id}`) {
      throw new Error('Reader Runtime 模型资产 ID 或路径无效');
    }
    modelIds.add(model.id);
    const modelFiles = verifyReferences(model.files, `模型 ${model.id}`);
    if (modelFiles.length === 0 || !modelFiles.some((file) => /\.(?:bin|onnx|pt|pth|safetensors)$/iu.test(file.path))) throw new Error(`Reader Runtime 模型载荷缺失：${model.id}`);
    const aggregate = createHash('sha256');
    let totalBytes = 0;
    for (const file of modelFiles) {
      if (!file.path.startsWith(`${model.path}/`) || declaredModelFiles.has(file.path)) throw new Error(`Reader Runtime 模型文件清单无效：${model.id}`);
      declaredModelFiles.add(file.path);
      aggregate.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
      totalBytes += file.size;
    }
    if (model.fileCount !== modelFiles.length || model.totalBytes !== totalBytes || model.sha256 !== aggregate.digest('hex')) throw new Error(`Reader Runtime 模型聚合哈希不一致：${model.id}`);
    if (typeof model.licenseExpression !== 'string' || !model.licenseExpression || model.licenseExpression === 'UNKNOWN') throw new Error(`Reader Runtime 模型许可证声明无效：${model.id}`);
    verifyReference(model.licenseSource, `模型 ${model.id}许可证`);
  }
  const actualModelFiles = new Set([...filesByPath.keys()].filter((path) => path.startsWith('_internal/model-artifacts/')));
  if (actualModelFiles.size !== declaredModelFiles.size || [...actualModelFiles].some((path) => !declaredModelFiles.has(path))) throw new Error('Reader Runtime 模型资产清单不完整');

  const declaredLicenseFiles = new Set(verifyReferences(inventory.licenseFiles, '第三方许可证').map((file) => file.path));
  const actualLicenseFiles = new Set([...filesByPath.keys()].filter(isLicensePayloadPath));
  if (declaredLicenseFiles.size === 0 || actualLicenseFiles.size !== declaredLicenseFiles.size || [...actualLicenseFiles].some((path) => !declaredLicenseFiles.has(path))) {
    throw new Error('Reader Runtime 第三方许可证清单不完整');
  }
  for (const component of componentByName.values()) {
    if (component.licenseFiles.some((path) => !declaredLicenseFiles.has(path))) throw new Error('Reader Runtime 组件许可证未登记到全局清单');
  }
}

function verifyBundledIntegrity(root: string, manifest: ToolchainManifest): string {
  const integrityPath = join(root, 'integrity.json');
  if (!existsSync(integrityPath)) throw new Error('内置工具包缺少 integrity.json');
  const integrity = JSON.parse(readFileSync(integrityPath, 'utf8')) as Partial<IntegrityManifest>;
  if (integrity.schemaVersion !== 1 || integrity.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/u.test(integrity.payloadSha256 ?? '') || !Array.isArray(integrity.files)) throw new Error('内置工具包 integrity.json 无效');
  if (manifest.payloadSha256 !== integrity.payloadSha256 || manifest.fileCount !== integrity.fileCount || manifest.totalBytes !== integrity.totalBytes) throw new Error('内置工具包 manifest 与完整性清单不一致');
  const aggregate = createHash('sha256');
  let totalBytes = 0;
  const paths = new Set<string>();
  for (const file of integrity.files) {
    if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256) || !Number.isInteger(file.size) || file.size < 0) throw new Error('内置工具包文件清单无效');
    const portable = file.path.replaceAll('\\', '/');
    if (!portable || portable.startsWith('/') || portable.split('/').includes('..') || paths.has(portable)) throw new Error('内置工具包文件清单包含不安全路径');
    paths.add(portable);
    const absolute = resolve(root, portable);
    const rel = relative(resolve(root), absolute);
    if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) throw new Error(`内置工具包文件缺失：${portable}`);
    if (statSync(absolute).size !== file.size) throw new Error(`内置工具包文件大小不一致：${portable}`);
    const hash = createHash('sha256');
    hashFile(absolute, hash);
    const actual = hash.digest('hex');
    if (actual !== file.sha256) throw new Error(`内置工具包文件哈希不一致：${portable}`);
    aggregate.update(`${portable}\0${file.size}\0${actual}\n`);
    totalBytes += file.size;
  }
  const actualPayloadPaths = new Set<string>();
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (lstatSync(absolute).isSymbolicLink()) throw new Error('内置工具包不得包含符号链接或目录联接');
      const portable = relative(root, absolute).replaceAll('\\', '/');
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        // The two root metadata files authenticate the payload but are not
        // themselves part of the payload aggregate.
        if (portable !== 'openlab-toolchain.json' && portable !== 'integrity.json') actualPayloadPaths.add(portable);
      } else throw new Error('内置工具包包含不支持的文件类型');
    }
  };
  visit(root);
  if (actualPayloadPaths.size !== paths.size || [...actualPayloadPaths].some((portable) => !paths.has(portable))) {
    throw new Error('内置工具包包含完整性清单之外的文件');
  }
  if (paths.size !== integrity.fileCount || totalBytes !== integrity.totalBytes || aggregate.digest('hex') !== integrity.payloadSha256) throw new Error('内置工具包聚合哈希不一致');
  verifyReaderRuntimeInventory(manifest, integrity as IntegrityManifest);
  return integrity.payloadSha256;
}

function hashFile(path: string, hash: ReturnType<typeof createHash>): number {
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  let total = 0;
  try {
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      total += read;
    }
  } finally { closeSync(descriptor); }
  return total;
}

function hashTree(root: string): string {
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = join(directory, entry.name);
      if (lstatSync(target).isSymbolicLink()) throw new Error('工具包不得包含符号链接或目录联接');
      const rel = relative(root, target).replaceAll('\\', '/');
      if (entry.isDirectory()) { hash.update(`d:${rel}\0`); visit(target); continue; }
      if (!entry.isFile()) throw new Error('工具包包含不支持的文件类型');
      files += 1;
      if (files > MAX_TOOLCHAIN_FILES) throw new Error('工具包文件数量超过上限');
      hash.update(`f:${rel}\0`);
      bytes += hashFile(target, hash);
      if (bytes > MAX_TOOLCHAIN_BYTES) throw new Error('工具包体积超过 20 GB 上限');
    }
  };
  visit(root);
  return hash.digest('hex');
}

function extractZip(source: string, destination: string): void {
  const zip = new AdmZip(source);
  const entries = zip.getEntries();
  if (entries.length > MAX_TOOLCHAIN_FILES) throw new Error('工具包 ZIP 文件数量超过上限');
  let bytes = 0;
  for (const entry of entries) {
    const name = entry.entryName.replaceAll('\\', '/');
    if (!name || name.startsWith('/') || /^[a-zA-Z]:/u.test(name) || name.split('/').includes('..')) throw new Error('工具包 ZIP 包含越界路径');
    bytes += Number(entry.header.size ?? 0);
    if (bytes > MAX_TOOLCHAIN_BYTES) throw new Error('工具包 ZIP 解压体积超过 20 GB 上限');
  }
  zip.extractAllTo(destination, false);
}

function manifestRoot(root: string): string {
  if (existsSync(join(root, 'openlab-toolchain.json'))) return root;
  const children = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (children.length === 1 && children[0] && existsSync(join(root, children[0].name, 'openlab-toolchain.json'))) return join(root, children[0].name);
  throw new Error('工具包根目录不明确');
}

export class ToolchainService {
  readonly #root: string;
  readonly #events: SqliteEventStore;
  readonly #toolchains = new Map<string, InstalledToolchain>();

  constructor(options: { root: string; events: SqliteEventStore; bundledRoots?: string[] }) {
    this.#root = options.root;
    this.#events = options.events;
    mkdirSync(this.#root, { recursive: true });
    this.scan();
    for (const bundledRoot of options.bundledRoots ?? []) this.scanBundled(bundledRoot);
  }

  list(): ToolchainDescriptor[] {
    return [...this.#toolchains.values()].map((value) => structuredClone(value.descriptor));
  }

  install(sourcePath: string, actor: EventActor): ToolchainDescriptor {
    const source = resolve(sourcePath);
    if (!existsSync(source)) throw new Error('离线工具包来源不存在');
    const staging = join(this.#root, `.install-${randomUUID()}`);
    mkdirSync(staging, { recursive: false });
    try {
      if (statSync(source).isDirectory()) {
        hashTree(source);
        cpSync(source, staging, { recursive: true, errorOnExist: true });
      } else if (source.toLocaleLowerCase().endsWith('.zip')) extractZip(source, staging);
      else throw new Error('离线工具包必须是目录或 ZIP');
      const candidateRoot = manifestRoot(staging);
      const manifest = readManifest(candidateRoot);
      const actualHash = hashTree(candidateRoot);
      if (manifest.expectedSha256 && manifest.expectedSha256 !== actualHash) throw new Error('工具包 SHA-256 与 manifest 不一致');
      const destination = join(this.#root, manifest.id);
      if (existsSync(destination)) throw new Error(`工具包已经安装：${manifest.id}`);
      if (candidateRoot === staging) renameSync(staging, destination);
      else renameSync(candidateRoot, destination);
      const installedManifest = readManifest(destination);
      const descriptor: ToolchainDescriptor = {
        id: installedManifest.id, kind: installedManifest.kind, name: installedManifest.name, version: installedManifest.version,
        rootName: basename(destination), executableNames: Object.keys(installedManifest.executables).sort(), sha256: actualHash,
        status: 'available', source: 'user', installedAt: new Date().toISOString(),
        ...(installedManifest.capabilities ? { capabilities: installedManifest.capabilities } : {}),
        ...(installedManifest.workerVersion ? { workerVersion: installedManifest.workerVersion } : {}),
      };
      this.#toolchains.set(descriptor.id, { descriptor, root: destination, manifest: installedManifest });
      this.#events.append({ streamId: 'app:toolchains', kind: 'toolchain.installed', actor, provenanceRefs: [actualHash], payload: toJson(descriptor) });
      return structuredClone(descriptor);
    } catch (error) {
      this.#events.append({ streamId: 'app:toolchains', kind: 'toolchain.verification_failed', actor, payload: toJson({ sourceName: basename(source), error: error instanceof Error ? error.message : String(error) }) });
      throw error;
    } finally {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    }
  }

  resolveExecutable(toolchainId: string, name: string): string {
    const installed = this.#toolchains.get(toolchainId);
    if (!installed || installed.descriptor.status !== 'available') throw new Error(`工具包不可用：${toolchainId}`);
    const relativePath = installed.manifest.executables[name];
    if (!relativePath) throw new Error(`工具包未提供可执行项：${name}`);
    const absolute = resolve(installed.root, relativePath);
    const realRoot = realpathSync(installed.root);
    const realExecutable = existsSync(absolute) ? realpathSync(absolute) : absolute;
    const rel = relative(realRoot, realExecutable);
    if (!existsSync(absolute) || !statSync(absolute).isFile() || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`工具包可执行项完整性失效：${name}`);
    }
    return absolute;
  }

  private scan(): void {
    for (const entry of readdirSync(this.#root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const root = join(this.#root, entry.name);
      try {
        const manifest = readManifest(root);
        const hash = hashTree(root);
        const descriptor: ToolchainDescriptor = {
          id: manifest.id, kind: manifest.kind, name: manifest.name, version: manifest.version, rootName: entry.name,
          executableNames: Object.keys(manifest.executables).sort(), sha256: hash,
          status: manifest.expectedSha256 && manifest.expectedSha256 !== hash ? 'invalid' : 'available', source: 'user', installedAt: statSync(root).birthtime.toISOString(),
          ...(manifest.capabilities ? { capabilities: manifest.capabilities } : {}),
          ...(manifest.workerVersion ? { workerVersion: manifest.workerVersion } : {}),
          ...(manifest.expectedSha256 && manifest.expectedSha256 !== hash ? { error: 'SHA-256 与 manifest 不一致' } : {}),
        };
        this.#toolchains.set(descriptor.id, { descriptor, root, manifest });
      } catch { /* invalid directories remain inert */ }
    }
  }

  private scanBundled(inputRoot: string): void {
    const root = resolve(inputRoot);
    if (!existsSync(root) || !statSync(root).isDirectory()) return;
    let manifest: ToolchainManifest | undefined;
    try {
      manifest = readManifest(root);
      if (manifest.network !== false) throw new Error('内置 Reader Runtime 必须声明 network=false');
      const payloadSha256 = verifyBundledIntegrity(root, manifest);
      const descriptor: ToolchainDescriptor = {
        id: manifest.id,
        kind: manifest.kind,
        name: manifest.name,
        version: manifest.version,
        rootName: basename(root),
        executableNames: Object.keys(manifest.executables).sort(),
        sha256: payloadSha256,
        status: 'available',
        source: 'bundled',
        ...(manifest.capabilities ? { capabilities: manifest.capabilities } : {}),
        ...(manifest.workerVersion ? { workerVersion: manifest.workerVersion } : {}),
      };
      this.#toolchains.set(descriptor.id, { descriptor, root, manifest });
    } catch (error) {
      const id = manifest?.id ?? `bundled.invalid.${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
      this.#toolchains.set(id, {
        descriptor: {
          id,
          kind: manifest?.kind ?? 'unknown',
          name: manifest?.name ?? 'Bundled toolchain',
          version: manifest?.version ?? 'unknown',
          rootName: basename(root),
          executableNames: manifest ? Object.keys(manifest.executables).sort() : [],
          sha256: manifest?.payloadSha256 ?? '0'.repeat(64),
          status: 'invalid',
          source: 'bundled',
          error: error instanceof Error ? error.message : String(error),
        },
        root,
        manifest: manifest ?? { schemaVersion: 1, id, kind: 'unknown', name: 'Bundled toolchain', version: 'unknown', executables: {} },
      });
      this.#events.append({ streamId: 'app:toolchains', kind: 'toolchain.verification_failed', actor: { id: 'openlab', kind: 'system' }, payload: toJson({ sourceName: basename(root), error: error instanceof Error ? error.message : String(error) }) });
    }
  }
}
