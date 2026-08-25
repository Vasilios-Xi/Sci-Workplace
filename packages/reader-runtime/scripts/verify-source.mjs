import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const worker = resolve(packageRoot, 'python', 'reader_worker', 'main.py');
const requirements = resolve(packageRoot, 'python', 'requirements.txt');
for (const path of [worker, requirements]) {
  if (!existsSync(path)) throw new Error(`Reader runtime source is missing: ${path}`);
}
const source = readFileSync(worker, 'utf8');
for (const marker of ['def capabilities()', 'def inspect_pdf(', 'def parse_pdf(', 'def render_page(', 'def dispatch(']) {
  if (!source.includes(marker)) throw new Error(`Reader runtime source contract is missing ${marker}`);
}
console.log('Reader runtime source contract: ok');
