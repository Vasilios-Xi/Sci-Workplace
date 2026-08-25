import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

const IGNORED = new Set(['integrity.json', 'openlab-toolchain.json']);
const REQUIRED_PARSERS = [
  'docling',
  'docling-core',
  'docling-parse',
  'docling-ibm-models',
  'pdfplumber',
  'pypdf',
  'pypdfium2',
];
const MODEL_LICENSE_COMPONENTS = new Map([
  ['docling-project--docling-models', 'docling-ibm-models'],
]);

export function portableRelative(root, target) {
  const value = relative(resolve(root), resolve(target)).replaceAll('\\', '/');
  if (!value || value.startsWith('../') || value === '..' || value.startsWith('/') || value.split('/').includes('..')) {
    throw new Error(`Reader runtime path escapes its root: ${target}`);
  }
  return value;
}

export function listPayloadFiles(root) {
  const output = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = resolve(directory, entry.name);
      const stats = lstatSync(target);
      if (stats.isSymbolicLink()) throw new Error(`Reader runtime contains a symbolic link: ${portableRelative(root, target)}`);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) {
        const path = portableRelative(root, target);
        if (!IGNORED.has(path)) output.push({ path, absolutePath: target, size: stats.size });
      } else throw new Error(`Reader runtime contains an unsupported entry: ${portableRelative(root, target)}`);
    }
  };
  visit(resolve(root));
  return output;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolvePromise);
  });
  return hash.digest('hex');
}

export async function buildIntegrity(root) {
  const files = [];
  let totalBytes = 0;
  for (const entry of listPayloadFiles(root)) {
    const sha256 = await sha256File(entry.absolutePath);
    files.push({ path: entry.path, size: entry.size, sha256 });
    totalBytes += entry.size;
  }
  const aggregate = createHash('sha256');
  for (const file of files) aggregate.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  return {
    schemaVersion: 1,
    algorithm: 'sha256',
    payloadSha256: aggregate.digest('hex'),
    fileCount: files.length,
    totalBytes,
    files,
  };
}

function normalizePackageName(value) {
  return value.trim().toLocaleLowerCase('en-US').replaceAll('_', '-').replaceAll('.', '-');
}

function metadataField(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = text.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'imu'));
  return match?.[1]?.trim() || undefined;
}

function isLicensePath(path) {
  const parts = path.toLocaleLowerCase('en-US').split('/');
  const name = parts.at(-1) ?? '';
  return parts.slice(0, -1).some((part) => part === 'license' || part === 'licenses')
    || /^(?:license|licence|copying|notice)(?:[._-].*)?$/iu.test(name);
}

function aggregateReferences(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  return hash.digest('hex');
}

function inventoryReference(filesByPath, path) {
  const value = filesByPath.get(path);
  if (!value) throw new Error(`Reader runtime inventory references a missing payload file: ${path}`);
  return { path: value.path, size: value.size, sha256: value.sha256 };
}

function readThirdPartyComponents(root, integrity, filesByPath) {
  const internalRoot = resolve(root, '_internal');
  const components = [];
  for (const entry of readdirSync(internalRoot, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !entry.name.toLocaleLowerCase('en-US').endsWith('.dist-info')) continue;
    const metadataPath = `_internal/${entry.name}/METADATA`;
    const metadata = inventoryReference(filesByPath, metadataPath);
    const text = readFileSync(resolve(root, metadataPath), 'utf8');
    const name = metadataField(text, 'Name');
    const version = metadataField(text, 'Version');
    if (!name || !version) throw new Error(`Reader runtime component metadata is incomplete: ${metadataPath}`);
    const prefix = `_internal/${entry.name}/`;
    const licenseFiles = integrity.files
      .filter((file) => file.path.startsWith(prefix) && isLicensePath(file.path))
      .map((file) => inventoryReference(filesByPath, file.path));
    components.push({
      name,
      normalizedName: normalizePackageName(name),
      version,
      licenseExpression: metadataField(text, 'License-Expression') ?? metadataField(text, 'License') ?? 'UNKNOWN',
      metadata,
      licenseFiles,
    });
  }
  return components;
}

function modelLicense(root, id, files, components) {
  const readme = files.find((file) => basename(file.path).toLocaleLowerCase('en-US') === 'readme.md');
  if (readme) {
    const text = readFileSync(resolve(root, readme.path), 'utf8');
    const expression = text.match(/^license:\s*['"]?([^'"\r\n]+)['"]?\s*$/imu)?.[1]?.trim();
    if (expression) return { expression, source: readme };
  }
  const componentName = MODEL_LICENSE_COMPONENTS.get(id);
  const component = componentName ? components.find((value) => value.normalizedName === componentName) : undefined;
  if (component && component.licenseExpression !== 'UNKNOWN') return { expression: component.licenseExpression, source: component.metadata };
  throw new Error(`Reader runtime model asset has no license evidence: ${id}`);
}

/**
 * Builds the deterministic, human-auditable inventory embedded in
 * openlab-toolchain.json. integrity.json remains the canonical full payload
 * list; this inventory assigns the security-relevant files to their semantic
 * Worker, parser, model, and license roles.
 */
export function buildRuntimeInventory(root, integrity, options = {}) {
  if (!integrity || !Array.isArray(integrity.files)) throw new Error('Reader runtime integrity manifest is required');
  const filesByPath = new Map(integrity.files.map((file) => [file.path, file]));
  const executablePath = String(options.executablePath ?? 'reader-worker.exe').replaceAll('\\', '/');
  const worker = {
    version: String(options.workerVersion ?? '').trim(),
    executable: inventoryReference(filesByPath, executablePath),
  };
  if (!worker.version) throw new Error('Reader runtime worker version is missing');

  const thirdPartyComponents = readThirdPartyComponents(root, integrity, filesByPath);
  const parsers = REQUIRED_PARSERS.map((required) => {
    const component = thirdPartyComponents.find((value) => value.normalizedName === required);
    if (!component) throw new Error(`Reader runtime parser component is missing: ${required}`);
    if (component.licenseExpression === 'UNKNOWN' && component.licenseFiles.length === 0) {
      throw new Error(`Reader runtime parser license evidence is missing: ${required}`);
    }
    return {
      name: component.name,
      normalizedName: component.normalizedName,
      version: component.version,
      metadata: component.metadata,
      licenseExpression: component.licenseExpression,
      licenseFiles: component.licenseFiles,
    };
  });

  const modelRoot = resolve(root, '_internal', 'model-artifacts');
  const modelAssets = readdirSync(modelRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const path = `_internal/model-artifacts/${entry.name}`;
      const files = integrity.files
        .filter((file) => file.path.startsWith(`${path}/`))
        .map((file) => inventoryReference(filesByPath, file.path));
      if (files.length === 0 || !files.some((file) => /\.(?:bin|onnx|pt|pth|safetensors)$/iu.test(file.path))) {
        throw new Error(`Reader runtime model payload is missing: ${entry.name}`);
      }
      const license = modelLicense(root, entry.name, files, thirdPartyComponents);
      return {
        id: entry.name,
        path,
        sha256: aggregateReferences(files),
        fileCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        licenseExpression: license.expression,
        licenseSource: license.source,
        files,
      };
    });
  if (modelAssets.length === 0) throw new Error('Reader runtime model asset inventory is empty');

  const licenseFiles = integrity.files
    .filter((file) => isLicensePath(file.path))
    .map((file) => inventoryReference(filesByPath, file.path));
  if (licenseFiles.length === 0) throw new Error('Reader runtime third-party license inventory is empty');

  return {
    schemaVersion: 1,
    worker,
    parsers,
    modelAssets,
    thirdPartyComponents,
    licenseFiles,
  };
}

export function verifyRuntimeInventory(root, integrity, inventory) {
  if (!inventory || typeof inventory !== 'object' || inventory.schemaVersion !== 1) throw new Error('Reader runtime inventory is missing or invalid');
  const worker = inventory.worker;
  if (!worker || typeof worker !== 'object' || typeof worker.version !== 'string' || typeof worker.executable?.path !== 'string') {
    throw new Error('Reader runtime Worker inventory is invalid');
  }
  const actual = buildRuntimeInventory(root, integrity, {
    workerVersion: worker.version,
    executablePath: worker.executable.path,
  });
  if (JSON.stringify(actual) !== JSON.stringify(inventory)) throw new Error('Reader runtime semantic inventory does not match its payload');
  return actual;
}

export function readTemplate(packageRoot) {
  const path = resolve(packageRoot, 'reader-runtime.template.json');
  if (!existsSync(path)) throw new Error('Reader runtime template is missing');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function assertRuntimeShape(root) {
  const executable = resolve(root, 'reader-worker.exe');
  if (!existsSync(executable) || !lstatSync(executable).isFile()) throw new Error('Reader runtime executable is missing');
  const modelRoot = resolve(root, '_internal', 'model-artifacts');
  if (!existsSync(modelRoot) || !lstatSync(modelRoot).isDirectory()) throw new Error('Reader runtime Docling model artifacts are missing');
}
