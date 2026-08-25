import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageRoot = resolve(import.meta.dirname, '..');
const python = process.env.OPENLAB_READER_PYTHON || (process.platform === 'win32' ? 'python.exe' : 'python3');
const modelSource = process.env.OPENLAB_READER_MODEL_SOURCE
  ? resolve(process.env.OPENLAB_READER_MODEL_SOURCE)
  : resolve(packageRoot, 'python', 'model-artifacts');
const spec = resolve(packageRoot, 'python', 'reader-worker.spec');
const buildRoot = resolve(packageRoot, '.freeze');
const distRoot = resolve(buildRoot, 'dist');
const workRoot = resolve(buildRoot, 'work');
const output = resolve(distRoot, 'reader-worker');

if (!existsSync(modelSource)) {
  throw new Error('Offline Docling model assets are required. Set OPENLAB_READER_MODEL_SOURCE to the model-artifacts directory.');
}
if (!existsSync(spec)) throw new Error(`Missing PyInstaller spec: ${spec}`);

rmSync(buildRoot, { recursive: true, force: true });
mkdirSync(buildRoot, { recursive: true });
const result = spawnSync(python, [
  '-m', 'PyInstaller', '--noconfirm', '--clean',
  '--distpath', distRoot, '--workpath', workRoot, spec,
], {
  cwd: packageRoot,
  env: {
    ...process.env,
    OPENLAB_READER_MODEL_SOURCE: modelSource,
    PATH: `${resolve(python, '..')}${delimiter}${process.env.PATH ?? ''}`,
  },
  encoding: 'utf8',
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`PyInstaller exited with code ${result.status ?? 'unknown'}`);
if (!existsSync(resolve(output, 'reader-worker.exe')) && !existsSync(resolve(output, 'reader-worker'))) {
  throw new Error(`Frozen reader runtime was not created at ${output}`);
}
console.log(output);
