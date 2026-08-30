import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeRequire = createRequire(`${workspaceRoot}/packages/runtime/package.json`);
const AdmZip = runtimeRequire('adm-zip');
const indexPath = process.argv[2] ?? `${workspaceRoot}/plugin-catalog/index.source.json`;

const allowedPermissions = new Set([
  'project:read', 'project:write', 'process:spawn', 'network', 'settings:read', 'settings:write', 'ui',
  'workspace:read', 'workspace:edit', 'resources:read', 'jobs:run', 'models:invoke', 'annotations:read', 'annotations:write',
  'artifacts:write', 'research:read', 'research:write', 'plugin-storage', 'browser:observe', 'browser:interact',
  'documents:read', 'evidence:read', 'evidence:write', 'artifacts:publish', 'workbench:read', 'workbench:write',
  'workbench:mount', 'workbench:propose-layout', 'generated-apps:build', 'toolchains:execute',
]);
const removedV4Permissions = new Set(['models:run', 'worktable:read', 'worktable:write', 'generated-apps:publish']);
const forbiddenFiles = new Set(['.npmrc', '.pnpmfile.cjs', '.pnpmfile.js', 'pnpm-workspace.yaml', 'package-lock.json', 'yarn.lock']);
const forbiddenExtensions = new Set(['.exe', '.dll', '.com', '.msi', '.bat', '.cmd', '.ps1', '.scr']);

function stableIdentity(entry) { return `${entry.id}@${entry.version}`; }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function normalizedZipPath(value) {
  const name = String(value).replaceAll('\\', '/');
  if (!name || name.startsWith('/') || /^[A-Za-z]:/u.test(name) || name.includes('\0')) throw new Error(`unsafe ZIP path: ${value}`);
  const segments = name.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) throw new Error(`ZIP traversal path: ${value}`);
  for (const segment of segments) {
    const stem = segment.split('.')[0]?.toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem ?? '')) throw new Error(`Windows reserved ZIP path: ${value}`);
  }
  return segments.join('/');
}

function validateIndex(index) {
  assert.equal(index?.schemaVersion, 1, 'catalog schemaVersion must be 1');
  assert.ok(Number.isSafeInteger(index.sequence) && index.sequence >= 1, 'catalog sequence must be a positive safe integer');
  assert.ok(Number.isFinite(Date.parse(index.generatedAt)), 'catalog generatedAt must be ISO-compatible');
  assert.ok(Array.isArray(index.entries) && index.entries.length <= 10_000, 'catalog entries are invalid');
  assert.ok(Array.isArray(index.revocations) && index.revocations.length <= 10_000, 'catalog revocations are invalid');
  const identities = new Set();
  for (const entry of index.entries) {
    const identity = stableIdentity(entry);
    assert.match(entry.id, /^[a-z0-9][a-z0-9._-]{1,63}$/u, `invalid plugin id: ${identity}`);
    assert.match(entry.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, `invalid plugin version: ${identity}`);
    assert.equal(identities.has(identity), false, `duplicate plugin: ${identity}`);
    identities.add(identity);
    assert.ok(entry.name?.trim() && entry.description?.trim(), `missing plugin metadata: ${identity}`);
    assert.match(entry.packageUrl, /^https:\/\//u, `package URL must use HTTPS: ${identity}`);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u, `invalid package SHA-256: ${identity}`);
    assert.ok(Number.isFinite(Date.parse(entry.publishedAt)), `invalid publishedAt: ${identity}`);
    assert.ok(Array.isArray(entry.permissions) && new Set(entry.permissions).size === entry.permissions.length, `invalid permissions: ${identity}`);
    for (const permission of entry.permissions) {
      assert.ok(allowedPermissions.has(permission), `unknown v4 permission ${permission}: ${identity}`);
      assert.equal(removedV4Permissions.has(permission), false, `removed v3 permission ${permission}: ${identity}`);
    }
  }
  for (const revocation of index.revocations) {
    assert.match(revocation.id, /^[a-z0-9][a-z0-9._-]{1,63}$/u, 'invalid revocation id');
    assert.ok(revocation.reason?.trim() && Number.isFinite(Date.parse(revocation.revokedAt)), `invalid revocation: ${revocation.id}`);
  }
}

function validatePackage(bytes, entry) {
  const identity = stableIdentity(entry);
  assert.equal(sha256(bytes), entry.sha256, `package SHA-256 mismatch: ${identity}`);
  assert.ok(bytes.length <= 512 * 1024 * 1024, `package exceeds 512 MiB: ${identity}`);
  const zip = new AdmZip(bytes);
  const files = zip.getEntries();
  assert.ok(files.length > 0 && files.length <= 20_000, `invalid ZIP file count: ${identity}`);
  let total = 0;
  const byPath = new Map();
  for (const file of files) {
    const path = normalizedZipPath(file.entryName);
    if (!path || file.isDirectory) continue;
    const mode = Number(file.header?.attr ?? 0) >>> 16;
    assert.notEqual(mode & 0o170000, 0o120000, `symbolic link is forbidden: ${path}`);
    const size = Number(file.header?.size ?? 0);
    assert.ok(Number.isSafeInteger(size) && size <= 128 * 1024 * 1024, `oversized ZIP member: ${path}`);
    total += size;
    assert.ok(total <= 512 * 1024 * 1024, `expanded package exceeds 512 MiB: ${identity}`);
    const lower = path.toLowerCase();
    assert.equal(lower.split('/').includes('node_modules'), false, `source package contains node_modules: ${path}`);
    assert.equal(forbiddenFiles.has(posix.basename(lower)), false, `package-manager control file is forbidden: ${path}`);
    const extension = posix.extname(lower);
    assert.equal(forbiddenExtensions.has(extension), false, `embedded executable is forbidden: ${path}`);
    assert.equal(byPath.has(path), false, `duplicate ZIP path: ${path}`);
    byPath.set(path, file);
  }
  const manifests = [...byPath].filter(([path]) => posix.basename(path) === 'manifest.json').sort(([left], [right]) => left.length - right.length);
  assert.equal(manifests.length, 1, `package must contain exactly one manifest.json: ${identity}`);
  const [manifestPath, manifestEntry] = manifests[0];
  const prefix = manifestPath.slice(0, -'manifest.json'.length);
  const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  assert.equal(manifest.schemaVersion, 4, `curated package must use manifest schema v4: ${identity}`);
  assert.equal(manifest.apiVersion, 4, `curated package must use Plugin API v4: ${identity}`);
  assert.equal(manifest.id, entry.id, `manifest/catalog id mismatch: ${identity}`);
  assert.equal(manifest.version, entry.version, `manifest/catalog version mismatch: ${identity}`);
  assert.deepEqual([...(manifest.permissions ?? [])].sort(), [...entry.permissions].sort(), `manifest/catalog permission mismatch: ${identity}`);
  assert.ok(manifest.contributes && typeof manifest.contributes === 'object' && !Array.isArray(manifest.contributes), `manifest contributes is invalid: ${identity}`);
  const entryPath = normalizedZipPath(`${prefix}${manifest.entry}`);
  assert.ok(byPath.has(entryPath), `plugin entry is missing: ${entryPath}`);
  const packageEntry = byPath.get(`${prefix}package.json`);
  if (packageEntry) {
    const packageJson = JSON.parse(packageEntry.getData().toString('utf8'));
    const scripts = packageJson.scripts ?? {};
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(typeof scripts[name], 'undefined', `lifecycle script ${name} is forbidden: ${identity}`);
  }
}

const index = JSON.parse(readFileSync(indexPath, 'utf8'));
validateIndex(index);
for (const entry of index.entries) {
  const response = await fetch(entry.packageUrl, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  assert.equal(response.ok, true, `failed to download ${stableIdentity(entry)}: HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  assert.ok(!declaredLength || declaredLength <= 512 * 1024 * 1024, `declared package size is too large: ${stableIdentity(entry)}`);
  validatePackage(Buffer.from(await response.arrayBuffer()), entry);
}
process.stdout.write(`Curated plugin catalog verified: ${index.entries.length} entries, ${index.revocations.length} revocations.\n`);
