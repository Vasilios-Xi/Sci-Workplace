import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { buildIntegrity, buildRuntimeInventory, portableRelative, verifyRuntimeInventory } from '../scripts/runtime-manifest.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const parserPackages = ['docling', 'docling-core', 'docling-parse', 'docling-ibm-models', 'pdfplumber', 'pypdf', 'pypdfium2'];

function runtimeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'openlab-reader-runtime-'));
  roots.push(root);
  writeFileSync(join(root, 'reader-worker.exe'), 'worker');
  for (const name of parserPackages) {
    const directory = join(root, '_internal', `${name.replaceAll('-', '_')}-1.2.3.dist-info`);
    mkdirSync(join(directory, 'licenses'), { recursive: true });
    writeFileSync(join(directory, 'METADATA'), `Name: ${name}\nVersion: 1.2.3\nLicense-Expression: MIT\n\nfixture\n`);
    writeFileSync(join(directory, 'licenses', 'LICENSE'), `${name} fixture license`);
  }
  const layout = join(root, '_internal', 'model-artifacts', 'docling-project--docling-layout-heron');
  mkdirSync(layout, { recursive: true });
  writeFileSync(join(layout, 'README.md'), '---\nlicense: apache-2.0\n---\n# Fixture model\n');
  writeFileSync(join(layout, 'model.safetensors'), 'layout-model');
  const table = join(root, '_internal', 'model-artifacts', 'docling-project--docling-models');
  mkdirSync(table, { recursive: true });
  writeFileSync(join(table, 'tm_config.json'), '{}');
  writeFileSync(join(table, 'tableformer.safetensors'), 'table-model');
  return root;
}

describe('reader runtime integrity manifest', () => {
  test('is deterministic and excludes generated manifests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openlab-reader-runtime-'));
    roots.push(root);
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'reader-worker.exe'), 'worker');
    writeFileSync(join(root, 'assets', 'model.bin'), 'model');
    writeFileSync(join(root, 'integrity.json'), 'ignored');
    const first = await buildIntegrity(root);
    writeFileSync(join(root, 'openlab-toolchain.json'), 'also ignored');
    const second = await buildIntegrity(root);
    expect(second).toEqual(first);
    expect(first.files.map((file) => file.path)).toEqual(['assets/model.bin', 'reader-worker.exe']);
  });

  test('rejects paths outside the runtime root', () => {
    const root = mkdtempSync(join(tmpdir(), 'openlab-reader-runtime-'));
    roots.push(root);
    expect(() => portableRelative(root, join(root, '..', 'escape.bin'))).toThrow(/escapes/u);
  });

  test('records deterministic worker, parser, model, component, and license inventories', async () => {
    const root = runtimeFixture();
    const integrity = await buildIntegrity(root);
    const first = buildRuntimeInventory(root, integrity, { workerVersion: '9.8.7' });
    const second = buildRuntimeInventory(root, integrity, { workerVersion: '9.8.7' });
    expect(second).toEqual(first);
    expect(first.worker).toMatchObject({ version: '9.8.7', executable: { path: 'reader-worker.exe', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
    expect(first.parsers.map((parser) => parser.normalizedName)).toEqual(parserPackages);
    expect(first.modelAssets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'docling-project--docling-layout-heron', licenseExpression: 'apache-2.0', fileCount: 2 }),
      expect.objectContaining({ id: 'docling-project--docling-models', licenseExpression: 'MIT', fileCount: 2 }),
    ]));
    expect(first.thirdPartyComponents).toHaveLength(parserPackages.length);
    expect(first.licenseFiles).toHaveLength(parserPackages.length);
    expect(verifyRuntimeInventory(root, integrity, first)).toEqual(first);
  });

  test('rejects missing parser and model license evidence', async () => {
    const missingParser = runtimeFixture();
    rmSync(join(missingParser, '_internal', 'pypdfium2-1.2.3.dist-info'), { recursive: true });
    await expect(buildIntegrity(missingParser).then((integrity) => buildRuntimeInventory(missingParser, integrity, { workerVersion: '1.0.0' }))).rejects.toThrow(/parser component is missing: pypdfium2/u);

    const missingModelLicense = runtimeFixture();
    writeFileSync(join(missingModelLicense, '_internal', 'model-artifacts', 'docling-project--docling-layout-heron', 'README.md'), '# No license declaration\n');
    await expect(buildIntegrity(missingModelLicense).then((integrity) => buildRuntimeInventory(missingModelLicense, integrity, { workerVersion: '1.0.0' }))).rejects.toThrow(/model asset has no license evidence/u);
  });
});
