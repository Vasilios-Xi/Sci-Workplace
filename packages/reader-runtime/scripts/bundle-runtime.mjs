import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertRuntimeShape, buildIntegrity, buildRuntimeInventory, readTemplate } from './runtime-manifest.mjs';

const packageRoot = resolve(import.meta.dirname, '..');
const destination = resolve(packageRoot, 'dist', 'reader-worker');
const refresh = process.argv.includes('--refresh');
const explicitIndex = process.argv.indexOf('--source');
const explicit = explicitIndex >= 0 ? process.argv[explicitIndex + 1] : undefined;
const candidates = [
  explicit,
  process.env.OPENLAB_READER_RUNTIME_SOURCE,
  resolve(packageRoot, '..', '..', '..', 'OpenScientific', 'dist-python', 'reader-worker'),
  resolve(packageRoot, '..', '..', '..', 'OpenScientific', 'release', 'win-unpacked', 'resources', 'python-worker'),
].filter(Boolean).map((value) => resolve(value));

if (!refresh && existsSync(resolve(destination, 'reader-worker.exe'))) {
  console.log(`Reader runtime bundle already exists: ${destination}`);
} else {
  const source = candidates.find((candidate) => existsSync(resolve(candidate, 'reader-worker.exe')));
  if (!source) throw new Error(`No prebuilt reader runtime found. Set OPENLAB_READER_RUNTIME_SOURCE. Checked:\n${candidates.join('\n')}`);
  const expectedParent = resolve(packageRoot, 'dist');
  if (!destination.startsWith(`${expectedParent}\\`) && destination !== expectedParent) throw new Error('Refusing to replace a reader runtime outside the package dist directory');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true, errorOnExist: true });
  console.log(`Imported reader runtime from ${source}`);
}

assertRuntimeShape(destination);
const integrity = await buildIntegrity(destination);
const template = readTemplate(packageRoot);
const runtimeInventory = buildRuntimeInventory(destination, integrity, {
  workerVersion: template.workerVersion,
  executablePath: template.executables?.['reader-worker'],
});
const toolchain = {
  ...template,
  payloadSha256: integrity.payloadSha256,
  fileCount: integrity.fileCount,
  totalBytes: integrity.totalBytes,
  runtimeInventory,
  builtAt: new Date().toISOString(),
};
writeFileSync(resolve(destination, 'integrity.json'), `${JSON.stringify(integrity, null, 2)}\n`, 'utf8');
writeFileSync(resolve(destination, 'openlab-toolchain.json'), `${JSON.stringify(toolchain, null, 2)}\n`, 'utf8');
console.log(`Reader runtime bundle: ${integrity.fileCount} files, ${integrity.totalBytes} bytes, ${integrity.payloadSha256}`);
