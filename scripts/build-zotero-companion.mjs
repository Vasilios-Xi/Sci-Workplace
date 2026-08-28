import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromRuntime = createRequire(join(repositoryRoot, 'packages', 'runtime', 'package.json'));
const AdmZip = requireFromRuntime('adm-zip');
const sourceRoot = join(repositoryRoot, 'integrations', 'zotero-companion');
const outputRoot = join(sourceRoot, 'dist');
const output = join(outputRoot, 'sci-workplace-zotero-companion.xpi');

mkdirSync(outputRoot, { recursive: true });
if (existsSync(output)) rmSync(output, { force: true });
const zip = new AdmZip();
for (const name of ['manifest.json', 'bootstrap.js', 'README.md']) zip.addFile(name, readFileSync(join(sourceRoot, name)));
zip.writeZip(output);
writeFileSync(join(outputRoot, 'README.md'), readFileSync(join(sourceRoot, 'README.md')));
process.stdout.write(`${output}\n`);
