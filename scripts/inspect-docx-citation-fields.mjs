import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';

const require = createRequire(new URL('../packages/runtime/package.json', import.meta.url));
const AdmZip = require('adm-zip');

for (const path of process.argv.slice(2)) {
  const xml = new AdmZip(readFileSync(path)).readAsText('word/document.xml');
  const fields = [];
  let paragraphIndex = 0;
  for (const paragraph of xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gu)) {
    const instruction = [...paragraph[0].matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/gu)].map((match) => match[1]).join(' ');
    if (/ADDIN\s+(?:EN\.|ZOTERO_)/iu.test(instruction)) {
      const visible = [...paragraph[0].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)].map((match) => match[1]).join('');
      const runs = [...paragraph[0].matchAll(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/gu)].map((run) => ({
        field: run[0].match(/<w:fldChar\b[^>]*w:fldCharType="([^"]+)"/u)?.[1],
        instruction: [...run[0].matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/gu)].map((match) => match[1]).join(''),
        text: [...run[0].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)].map((match) => match[1]).join(''),
        superscript: /w:vertAlign\b[^>]*w:val="superscript"/u.test(run[0]),
      })).filter((run) => run.field || run.instruction || run.text);
      fields.push({ paragraphIndex, visible, instruction, runs });
    }
    paragraphIndex += 1;
  }
  process.stdout.write(`${JSON.stringify({ file: basename(path), fields }, null, 2)}\n`);
}
