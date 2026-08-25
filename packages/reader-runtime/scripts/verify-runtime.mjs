import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertRuntimeShape, buildIntegrity, verifyRuntimeInventory } from './runtime-manifest.mjs';

const packageRoot = resolve(import.meta.dirname, '..');
const root = resolve(packageRoot, 'dist', 'reader-worker');
assertRuntimeShape(root);
for (const name of ['integrity.json', 'openlab-toolchain.json']) {
  if (!existsSync(resolve(root, name))) throw new Error(`Reader runtime ${name} is missing`);
}
const expected = JSON.parse(readFileSync(resolve(root, 'integrity.json'), 'utf8'));
const toolchain = JSON.parse(readFileSync(resolve(root, 'openlab-toolchain.json'), 'utf8'));
const actual = await buildIntegrity(root);
if (expected.payloadSha256 !== actual.payloadSha256 || expected.fileCount !== actual.fileCount || expected.totalBytes !== actual.totalBytes) {
  throw new Error('Reader runtime integrity verification failed');
}
if (toolchain.payloadSha256 !== actual.payloadSha256 || toolchain.fileCount !== actual.fileCount || toolchain.totalBytes !== actual.totalBytes) {
  throw new Error('Reader runtime toolchain manifest does not match its integrity manifest');
}
verifyRuntimeInventory(root, actual, toolchain.runtimeInventory);
console.log(`Reader runtime integrity: ok (${actual.fileCount} files, ${actual.payloadSha256})`);
