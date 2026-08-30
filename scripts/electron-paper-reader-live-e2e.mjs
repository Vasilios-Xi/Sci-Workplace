#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(workspace, 'artifacts', 'paper-reader-app-live-e2e');
const userDataRoot = join(outputRoot, `.tmp-user-data-${process.pid}-${randomUUID()}`);
const projectRoot = mkdtempSync(join(tmpdir(), 'sci-workplace-paper-live-'));
const executable = resolve(process.env.OPENLAB_E2E_PACKAGED_EXECUTABLE
  || join(workspace, 'apps', 'desktop', 'release', 'win-unpacked', 'Sci Workplace.exe'));
const sourceDirectory = resolve(process.env.PAPER_READER_SOURCE_ROOT || 'D:\\Study\\zotero\\storage\\9Y2ILIWX');
const sourcePath = resolve(process.env.PAPER_READER_SOURCE_PDF || join(sourceDirectory, 'Cen 等 - 2025 - Adaptive interphase enabled pressure-free all-solid-state lithium metal batteries.pdf'));
const expectedSha256 = process.env.PAPER_READER_EXPECTED_SHA256 || '8288d72d70a4ae387c8ca296ec2498a6001db25bf701d49bfd9b3ba44daf80bc';
const textModel = process.env.PAPER_READER_TEXT_MODEL || 'chatgpt-oauth::gpt-5.6-luna';
const visionModel = process.env.PAPER_READER_VISION_MODEL || 'chatgpt-oauth::gpt-5.6-luna';
const minimumFreeBytes = 8 * 1024 * 1024 * 1024;
const summaryPath = join(outputRoot, 'latest.json');
const previewScreenshotPath = join(outputRoot, 'token-confirmation.png');
const completedScreenshotPath = join(outputRoot, 'completed.png');
const restoredScreenshotPath = join(outputRoot, 'restored.png');
const diagnosticScreenshotPath = join(outputRoot, 'pdf-diagnostic.png');
const diagnosticOnly = process.env.PAPER_READER_DIAGNOSTIC_ONLY === '1';
const offlineAudit = process.env.PAPER_READER_OFFLINE_AUDIT === '1';
const offlineAuditScreenshotPath = join(outputRoot, 'offline-source-audit.png');
const offlineAuditSummaryPath = join(outputRoot, 'offline-source-audit.json');
let activeApplication;
let cleaning = false;

function within(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${sep}`);
}

function safeRemoveUserData(target) {
  if (!within(outputRoot, target) || !basename(target).startsWith('.tmp-user-data-')) {
    throw new Error(`Refusing to clean outside the live E2E user-data sandbox: ${target}`);
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function safeRemoveProject(target) {
  const temporary = resolve(tmpdir());
  if (!within(temporary, target) || !basename(target).startsWith('sci-workplace-paper-live-')) {
    throw new Error(`Refusing to clean outside the live E2E project sandbox: ${target}`);
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function cleanStaleRoots() {
  mkdirSync(outputRoot, { recursive: true });
  for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.tmp-user-data-')) continue;
    const target = join(outputRoot, entry.name);
    if (resolve(target) !== resolve(userDataRoot)) safeRemoveUserData(target);
  }
  for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('sci-workplace-paper-live-')) continue;
    const target = join(tmpdir(), entry.name);
    if (resolve(target) !== resolve(projectRoot)) safeRemoveProject(target);
  }
}

function cleanup() {
  if (cleaning) return;
  cleaning = true;
  try {
    if (existsSync(userDataRoot)) safeRemoveUserData(userDataRoot);
    if (existsSync(projectRoot)) safeRemoveProject(projectRoot);
  } finally {
    cleaning = false;
  }
}

function freeBytes(path) {
  const value = statfsSync(path);
  return Number(value.bavail) * Number(value.bsize);
}

function requireDiskHeadroom(path, label) {
  const free = freeBytes(path);
  if (free < minimumFreeBytes) throw new Error(`${label} requires 8 GiB free; only ${(free / 1024 ** 3).toFixed(2)} GiB remains`);
  return free;
}

async function sha256(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolvePromise);
  });
  return hash.digest('hex');
}

function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function findNamedFiles(root, name, maximum = 20_000) {
  if (!existsSync(root)) return [];
  const found = [];
  const pending = [root];
  let inspected = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      inspected += 1;
      if (inspected > maximum) throw new Error(`Live E2E file scan exceeded ${maximum} entries`);
      const target = join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name === name) found.push(target);
    }
  }
  return found;
}

async function launch() {
  const application = await electron.launch({
    executablePath: executable,
    cwd: dirname(executable),
    env: {
      ...process.env,
      OPENLAB_PROJECT_ROOT: projectRoot,
      OPENLAB_TEST_USER_DATA_ROOT: userDataRoot,
      ELECTRON_ENABLE_LOGGING: '1',
    },
    timeout: 60_000,
  });
  activeApplication = application;
  const page = await application.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(60_000);
  const networkAudit = { failures: [], resourceResponses: [], requestFailures: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') process.stderr.write(`[renderer console] ${message.text()}\n`);
  });
  page.on('pageerror', (error) => process.stderr.write(`[renderer pageerror] ${error.message}\n`));
  page.on('response', (response) => {
    const record = {
      url: response.url(),
      status: response.status(),
      method: response.request().method(),
      resourceType: response.request().resourceType(),
      headers: response.headers(),
    };
    if (record.url.includes('/resource-files/') || record.url.includes('/api/resources')) networkAudit.resourceResponses.push(record);
    if (record.status >= 400) {
      networkAudit.failures.push(record);
      process.stderr.write(`[renderer response] ${record.status} ${record.url}\n`);
    }
  });
  page.on('requestfailed', (request) => {
    const record = { url: request.url(), error: request.failure()?.errorText ?? 'unknown' };
    networkAudit.requestFailures.push(record);
    process.stderr.write(`[renderer requestfailed] ${record.error} ${record.url}\n`);
  });
  await page.locator('body').waitFor();
  return { application, page, networkAudit };
}

async function connection(page) {
  return await page.evaluate(async () => await window.openlab.getConnection());
}

async function runtimeRequest(page, path, body, options = {}) {
  const target = await connection(page);
  const method = options.method || (body === undefined ? 'GET' : 'POST');
  const response = await fetch(`${target.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${target.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (options.expectedFailure) {
    assert.equal(response.ok, false, `${method} ${path} unexpectedly succeeded`);
    return { status: response.status, payload };
  }
  assert.equal(response.ok, true, `${method} ${path} failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function bootstrap(page) {
  return await runtimeRequest(page, '/api/bootstrap');
}

async function waitFor(check, timeoutMs, intervalMs = 500) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw lastError ?? new Error(`Condition timed out after ${timeoutMs}ms`);
}

function paperReader(snapshot, instanceId) {
  return snapshot.paperReaders.find((candidate) => candidate.instanceId === instanceId);
}

async function panelContext(page, instance, pane, tab) {
  const query = new URLSearchParams({ tabId: tab.id, worktableInstanceId: instance.id, paneId: pane.id });
  return await runtimeRequest(page, `/api/plugins/sci.paper-reader/panels/analysis/context?${query}`);
}

async function closeApplication(application) {
  if (!application) return;
  activeApplication = undefined;
  await application.close().catch(() => undefined);
}

function installDialogAudit(page) {
  return page.evaluate(() => {
    globalThis.__paperReaderDialogAudit = [];
    const seen = new WeakSet();
    const capture = () => {
      for (const dialog of document.querySelectorAll('[data-testid="app-dialog"]')) {
        if (seen.has(dialog)) continue;
        seen.add(dialog);
        globalThis.__paperReaderDialogAudit.push(dialog.textContent || '');
      }
    };
    new MutationObserver(capture).observe(document.documentElement, { childList: true, subtree: true });
    capture();
  });
}

async function main() {
  if (!offlineAudit && process.env.PAPER_READER_LIVE_USER_CONFIRMED !== '1') {
    throw new Error('Packaged live-model E2E is locked until the user confirms its displayed V2 token budget');
  }
  if (!existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) throw new Error(`Zotero source PDF not found: ${sourcePath}`);
  mkdirSync(outputRoot, { recursive: true });
  cleanStaleRoots();
  mkdirSync(userDataRoot, { recursive: true });
  const initialFreeF = requireDiskHeadroom(outputRoot, 'F drive live E2E');
  const initialFreeC = requireDiskHeadroom(projectRoot, 'C drive live E2E');
  const sourceHash = await sha256(sourcePath);
  assert.equal(sourceHash, expectedSha256, 'The selected Zotero revision is not the original failure document');
  assert.notEqual(parse(userDataRoot).root.toLocaleLowerCase(), parse(projectRoot).root.toLocaleLowerCase(), 'The live E2E must exercise cross-volume archival');
  if (offlineAudit) process.stdout.write(`${JSON.stringify({ type: 'offline-audit-stage', stage: 'launch', sourcePath })}\n`);

  const first = await launch();
  const { application, page } = first;
  const onboarding = page.getByTestId('primary-agent-onboarding');
  await onboarding.waitFor();
  await page.getByTestId('primary-agent-name').fill('论文精读验收 Agent');
  await page.getByTestId('primary-agent-start').click();
  await onboarding.waitFor({ state: 'detached' });
  if (offlineAudit) process.stdout.write(`${JSON.stringify({ type: 'offline-audit-stage', stage: 'onboarding-complete' })}\n`);

  await runtimeRequest(page, '/api/providers/chatgpt-oauth', { enabled: true });
  await runtimeRequest(page, '/api/settings/harness', {
    utilityModel: textModel,
    paperReaderTextModel: textModel,
    paperReaderVisionModel: visionModel,
  });
  const configured = await bootstrap(page);
  const provider = configured.providers.find((candidate) => candidate.definition?.id === 'chatgpt-oauth');
  assert.equal(provider?.status, 'connected', `ChatGPT OAuth provider is not connected: ${provider?.error ?? provider?.status}`);
  assert.equal(configured.models.some((candidate) => candidate.id === textModel), true, `Text model is unavailable: ${textModel}`);
  assert.equal(configured.models.some((candidate) => candidate.id === visionModel && candidate.supportsVision), true, `Vision model is unavailable: ${visionModel}`);
  if (offlineAudit) process.stdout.write(`${JSON.stringify({ type: 'offline-audit-stage', stage: 'models-configured' })}\n`);

  const sourceRoot = await runtimeRequest(page, '/api/workspace/roots', { path: sourceDirectory, access: 'read_only', confirmed: true });
  assert.equal(typeof sourceRoot.id, 'string');
  const created = await runtimeRequest(page, '/api/worktable/instances', {
    templateId: 'sci.paper-reader:deep-read',
    title: 'Adaptive interphase 真实精读验收',
    inputs: {
      mainPdf: {
        rootId: sourceRoot.id,
        path: relative(sourceDirectory, sourcePath).replaceAll('\\', '/'),
        name: basename(sourcePath),
        sha256: sourceHash,
        size: statSync(sourcePath).size,
        mediaType: 'application/pdf',
      },
      language: 'zh-CN',
    },
  });
  const instance = created.instance;
  assert.equal(instance.templateId, 'sci.paper-reader:deep-read');
  await runtimeRequest(page, `/api/worktable/instances/${encodeURIComponent(instance.id)}/activate`, {});
  const pane = instance.panes.find((candidate) => candidate.tabs.some((tab) => tab.content?.kind === 'plugin-panel' && tab.content.panelId === 'analysis'));
  const tab = pane?.tabs.find((candidate) => candidate.content?.kind === 'plugin-panel' && candidate.content.panelId === 'analysis');
  assert.ok(pane && tab, 'Paper reader analysis panel was not mounted');
  if (offlineAudit) process.stdout.write(`${JSON.stringify({ type: 'offline-audit-stage', stage: 'instance-created', instanceId: instance.id })}\n`);

  await page.getByTestId('sidebar-worktable').click();
  try {
    await page.getByTestId('worktable-pdf-viewer').waitFor();
  } catch (error) {
    await page.screenshot({ path: diagnosticScreenshotPath, fullPage: true }).catch(() => undefined);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    process.stderr.write(`${JSON.stringify({ type: 'pdf-load-failure', bodyText: bodyText.slice(0, 8_000), networkAudit: first.networkAudit })}\n`);
    throw error;
  }
  const pdfCanvas = page.getByTestId('worktable-pdf-canvas');
  await waitFor(async () => await pdfCanvas.evaluate((canvas) => canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0), 60_000);
  const initialPdfResponse = await waitFor(() => first.networkAudit.resourceResponses.find((response) =>
    response.method === 'GET' && /\/api\/resources\/[^/]+$/u.test(new URL(response.url).pathname) && [200, 206].includes(response.status),
  ), 60_000);
  assert.equal(first.networkAudit.requestFailures.some((failure) => failure.url.includes('/api/resources/')), false, 'Native PDF Range request was blocked');
  if (diagnosticOnly) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
    await page.screenshot({ path: diagnosticScreenshotPath, fullPage: true });
    process.stdout.write(`${JSON.stringify({ type: 'pdf-diagnostic', initialPdfResponse, networkAudit: first.networkAudit })}\n`);
    await closeApplication(application);
    return;
  }
  const analysisFrame = page.frameLocator('iframe[title="章节、图表、复现与全局报告"]');
  await analysisFrame.locator('[data-action="prepare"]').waitFor();
  if (offlineAudit) process.stdout.write(`${JSON.stringify({ type: 'offline-audit-stage', stage: 'prepare-start' })}\n`);
  await analysisFrame.locator('[data-action="prepare"]').click();
  await analysisFrame.locator('[data-action="start"]').waitFor({ timeout: 10 * 60_000 });
  if (offlineAudit) process.stdout.write(`${JSON.stringify({ type: 'offline-audit-stage', stage: 'prepare-complete', iframeTitles: await page.locator('iframe').evaluateAll((frames) => frames.map((frame) => frame.title)) })}\n`);
  const preview = await panelContext(page, instance, pane, tab);
  assert.equal(preview.callPreview.ready, true);
  assert.equal(preview.callPreview.textModel, textModel);
  assert.equal(preview.callPreview.visionModel, visionModel);
  assert.ok(preview.callPreview.modelCalls > 1);
  assert.ok(preview.callPreview.estimatedTotalTokens > 0);
  assert.ok(preview.callPreview.maximumTotalTokens >= preview.callPreview.estimatedTotalTokens);

  if (offlineAudit) {
    const sourceTabButton = page.locator('.worktable-pane-tabs button').filter({ hasText: '深度精读 / 双语 / PDF' }).first();
    await sourceTabButton.waitFor({ timeout: 60_000 });
    await sourceTabButton.click();
    const sourceFrame = page.frameLocator('iframe[title="深度精读 / 双语 / PDF"]');
    await sourceFrame.locator('.source-block').first().waitFor({ timeout: 60_000 });
    const sourceBodyText = await sourceFrame.locator('body').innerText();
    const visibleTexts = (await sourceFrame.locator('.source-grid > p:first-child').allTextContents())
      .map((value) => value.replace(/\s+/gu, ' ').trim()).filter(Boolean);
    const visibleTextSet = new Set(visibleTexts);
    const parsed = preview.documents.find((item) => item.document.role === 'main')?.parsed;
    assert.ok(parsed?.paper?.profileImagePath, 'Offline parse did not produce the full title-page visual source');
    assert.ok(Number(parsed.paper.profilePage) >= 1, 'Offline parse did not bind the title-page visual to a real page');
    const hiddenTypes = new Set(['running_matter', 'reference', 'front_matter', 'figure_text', 'formula']);
    const expectedVisible = parsed.blocks.filter((block) => !hiddenTypes.has(block.type)
      && !/^Nature(?:Communications|Sustainability)\|.*\d$/iu.test(String(block.originalText || '').replace(/\s+/gu, '')));
    assert.equal(visibleTexts.length, expectedVisible.length, 'The packaged source panel did not render exactly the filtered source blocks');
    assert.equal(/\b(?:S|C|F)\d{3}\b/u.test(sourceBodyText), false, 'An internal block or figure identifier leaked into visible UI text');
    assert.equal(/\bp\.\s*\d+\b/iu.test(sourceBodyText), false, 'An internal p.N page marker leaked into visible UI text');
    assert.equal(/\b(?:front_matter|figure_text|running_matter)\b/u.test(sourceBodyText), false, 'An internal parser type leaked into visible UI text');
    const knownFragments = ['1234567890():,;', ')iL/+iL', 'a f g', '1.5', 'Li', '.sv'];
    assert.deepEqual(knownFragments.filter((value) => visibleTextSet.has(value)), [], 'Known title/figure micro-fragments leaked into the source panel');
    const internalFigureTexts = parsed.blocks.filter((block) => block.type === 'figure_text')
      .map((block) => String(block.originalText || '').replace(/\s+/gu, ' ').trim()).filter((value) => value.length > 0 && value.length <= 24);
    assert.ok(internalFigureTexts.length > 0, 'The regression PDF no longer exercises internal figure-text filtering');
    assert.deepEqual([...new Set(internalFigureTexts.filter((value) => visibleTextSet.has(value)))], [], 'An internal figure-text fragment leaked into the packaged source panel');
    assert.ok(await sourceFrame.locator('.chemical-formula sub').count() > 0, 'Chemical stoichiometry was not rendered with numeric subscripts');
    const pages = new Map(parsed.pages.map((page) => [page.page, page]));
    const visualRegions = parsed.figures.filter((figure) => figure.kind !== 'formula');
    assert.ok(visualRegions.length > 0, 'The regression PDF did not produce scientific visual regions');
    for (const figure of visualRegions) {
      const pageInfo = pages.get(figure.page);
      assert.ok(pageInfo?.width > 0 && pageInfo?.height > 0, `Visual ${figure.id} has no page geometry`);
      const [left, top, right, bottom] = figure.bbox;
      const width = right - left; const height = bottom - top;
      assert.ok(width >= 96 && height >= 42, `Visual ${figure.id} is a forbidden micro-region (${width} x ${height})`);
      assert.ok((width * height) / (pageInfo.width * pageInfo.height) >= 0.012, `Visual ${figure.id} occupies less than 1.2% of its page`);
    }
    await page.screenshot({ path: offlineAuditScreenshotPath, fullPage: true });
    assert.equal(await sha256(sourcePath), sourceHash, 'Zotero source PDF changed during the offline packaged audit');
    const result = {
      schemaVersion: 2,
      completedAt: new Date().toISOString(),
      source: { path: sourcePath, sha256: sourceHash, unchanged: true },
      parserVersion: parsed.parserVersion,
      rawBlockCount: parsed.blocks.length,
      visibleBlockCount: visibleTexts.length,
      hiddenFigureTextCount: parsed.blocks.filter((block) => block.type === 'figure_text').length,
      visualRegionCount: visualRegions.length,
      formulaSubscriptNodes: await sourceFrame.locator('.chemical-formula sub').count(),
      modelCallsConsumed: 0,
      screenshot: offlineAuditScreenshotPath,
      temporaryRootsRetained: 0,
    };
    atomicJson(offlineAuditSummaryPath, result);
    process.stdout.write(`${JSON.stringify({ type: 'offline-source-audit', ...result })}\n`);
    await closeApplication(application);
    return;
  }

  const rejected = await runtimeRequest(page, '/api/plugins/sci.paper-reader/panels/analysis/tool', {
    tabId: tab.id,
    worktableInstanceId: instance.id,
    paneId: pane.id,
    tool: 'paper.start',
    params: {},
    confirmed: false,
  }, { expectedFailure: true });
  assert.match(JSON.stringify(rejected.payload), /确认/u, 'The runtime did not enforce the one-time upfront confirmation');

  await installDialogAudit(page);
  await analysisFrame.locator('[data-action="start"]').click();
  const dialog = page.getByTestId('app-dialog');
  await dialog.waitFor();
  const disclosure = await dialog.textContent();
  assert.match(disclosure, /确认全文模型处理/u);
  assert.ok(disclosure.includes(textModel));
  assert.ok(disclosure.includes(visionModel));
  assert.ok(disclosure.includes(String(preview.callPreview.modelCalls)));
  assert.ok(disclosure.includes(String(preview.callPreview.estimatedTotalTokens)));
  assert.ok(disclosure.includes(String(preview.callPreview.maximumTotalTokens)));
  assert.match(disclosure, /任务内不再逐次询问/u);
  await page.screenshot({ path: previewScreenshotPath, fullPage: true });
  await page.getByTestId('app-dialog-confirm').click();
  await dialog.waitFor({ state: 'detached' });

  let lastProgress = '';
  let resumeCount = 0;
  const completedReader = await waitFor(async () => {
    const snapshot = await bootstrap(page);
    const reader = paperReader(snapshot, instance.id);
    assert.ok(reader, 'Paper reader disappeared while running');
    const progress = `${reader.status}:${reader.stage}:${reader.translatedBlockCount ?? 0}/${reader.translationBlockCount ?? 0}`;
    if (progress !== lastProgress) {
      lastProgress = progress;
      process.stdout.write(`${JSON.stringify({ type: 'paper-progress', progress, calls: reader.batchAuthorization?.consumed?.modelCalls ?? 0, tokens: reader.batchAuthorization?.consumed?.totalTokens ?? 0 })}\n`);
    }
    if (reader.status === 'completed') return reader;
    if (['unsupported_scanned'].includes(reader.status)) throw new Error(reader.error ?? reader.stage);
    if (['failed', 'interrupted'].includes(reader.status)) {
      if (resumeCount >= 3 || reader.batchAuthorization?.status !== 'active') throw new Error(reader.error ?? reader.stage);
      resumeCount += 1;
      await analysisFrame.locator('[data-action="resume"]').waitFor({ timeout: 60_000 });
      await analysisFrame.locator('[data-action="resume"]').click();
    }
    return undefined;
  }, 40 * 60_000, 1_500);

  const context = await panelContext(page, instance, pane, tab);
  assert.equal(completedReader.translatedBlockCount, completedReader.translationBlockCount);
  assert.ok(completedReader.translationBlockCount > 0);
  assert.equal(completedReader.quality?.status, 'complete');
  assert.equal(completedReader.batchAuthorization?.status, 'completed');
  assert.equal(context.analysis.report?.schema, 'openscientific.fine-reading-report/2');
  assert.equal(context.analysis.report?.quality?.status, 'complete');
  assert.equal(Object.keys(context.analysis.translations).length, completedReader.translationBlockCount);
  assert.ok(completedReader.evidenceAnchorIds.length > 0);
  assert.ok(completedReader.reportArtifact?.revisionId);

  const dialogAudit = await page.evaluate(() => globalThis.__paperReaderDialogAudit ?? []);
  assert.equal(dialogAudit.length, 1, `Expected one confirmation dialog, saw ${dialogAudit.length}: ${JSON.stringify(dialogAudit)}`);
  const completedSnapshot = await bootstrap(page);
  const revision = completedSnapshot.artifactRevisions.find((candidate) => candidate.id === completedReader.reportArtifact.revisionId);
  assert.equal(revision?.status, 'archived');
  assert.ok((revision?.files.length ?? 0) >= 9);
  assert.ok(revision.files.every((file) => file.external === false && typeof file.archivedPath === 'string'));
  for (const name of ['paper.md', 'source_map.json', 'translation_notes.md', 'deep_reading.json', 'figure_analyses.json', 'formula_analyses.json', 'deep_reading_quality.json', 'generation_manifest.json']) {
    assert.ok(revision.files.some((file) => file.name === name), `V2 atomic artifact is missing ${name}`);
  }
  const mapping = revision.files.find((file) => file.name.endsWith('/reader_document.json'));
  assert.ok(mapping?.archivedPath, 'Parsed document was not archived');
  const archivedMapping = resolve(projectRoot, mapping.archivedPath);
  assert.equal(existsSync(archivedMapping), true, 'Archived parsed document is missing');
  assert.equal(await sha256(archivedMapping), mapping.sha256);
  assert.equal(parse(archivedMapping).root.toLocaleLowerCase(), parse(projectRoot).root.toLocaleLowerCase());
  const stagedMappings = findNamedFiles(join(userDataRoot, 'jobs'), 'reader_document.json');
  assert.ok(stagedMappings.length > 0, 'The F-drive Reader Runtime output was not found');
  assert.ok(stagedMappings.every((path) => parse(path).root.toLocaleLowerCase() === parse(userDataRoot).root.toLocaleLowerCase()));
  const mounted = completedSnapshot.worktable.instances.find((candidate) => candidate.id === instance.id);
  assert.ok(mounted?.panes.flatMap((candidate) => candidate.tabs).some((candidate) => candidate.content?.kind === 'artifact'
    && candidate.content.revisionId === completedReader.reportArtifact.revisionId), 'Report artifact was not mounted into the analysis slot');
  assert.equal(await sha256(sourcePath), sourceHash, 'Zotero source PDF changed during the packaged app task');

  const analysisTabButton = page.locator('.worktable-pane-tabs button').filter({ hasText: '章节、图表、复现与全局报告' }).first();
  if (await analysisTabButton.count()) await analysisTabButton.click();
  await analysisFrame.locator('.status-card.status-completed').waitFor({ timeout: 60_000 });
  await analysisFrame.locator('[data-reveal]').first().click();
  await analysisFrame.locator('#evidence-drawer.open').waitFor({ timeout: 60_000 });
  await page.getByTestId('worktable-pdf-evidence-highlight').waitFor({ timeout: 60_000 });
  const evidenceDrawer = await analysisFrame.locator('#evidence-drawer').innerText();
  assert.match(evidenceDrawer, /证据抽屉[\s\S]*译文[\s\S]*文档修订[\s\S]*坐标[\s\S]*批注/u, 'evidence drawer does not expose the complete source-grounded trace');
  await analysisFrame.locator('#annotation-form textarea').fill('真实打包验收批注');
  await analysisFrame.locator('#annotation-form button').click();
  await waitFor(async () => {
    const updated = await panelContext(page, instance, pane, tab);
    return updated.annotations.some((annotation) => annotation.comments.some((comment) => comment.content === '真实打包验收批注')) ? true : undefined;
  }, 60_000);
  await page.screenshot({ path: completedScreenshotPath, fullPage: true });
  await closeApplication(application);

  const second = await launch();
  const restored = await waitFor(async () => {
    const snapshot = await bootstrap(second.page);
    const reader = paperReader(snapshot, instance.id);
    return reader?.status === 'completed' ? { snapshot, reader } : undefined;
  }, 90_000);
  assert.equal(await second.page.getByTestId('primary-agent-onboarding').count(), 0, 'Onboarding reappeared after restart');
  assert.equal(restored.reader.reportArtifact?.revisionId, completedReader.reportArtifact.revisionId);
  assert.ok(restored.snapshot.worktable.instances.find((candidate) => candidate.id === instance.id)?.panes
    .flatMap((candidate) => candidate.tabs).some((candidate) => candidate.content?.kind === 'artifact'
      && candidate.content.revisionId === completedReader.reportArtifact.revisionId), 'Report mount did not survive restart');
  await second.page.getByTestId('worktable-shell').waitFor();
  assert.equal(await second.page.getByTestId('worktable-return-chat').isVisible(), true, 'configured paper reader restarts into the Workbench default entry');
  await second.page.getByTestId('worktable-title').filter({ hasText: 'Adaptive interphase 真实精读验收' }).waitFor();
  await second.page.getByTestId('worktable-pdf-viewer').waitFor();
  const restoredCanvas = second.page.getByTestId('worktable-pdf-canvas');
  await waitFor(async () => await restoredCanvas.evaluate((canvas) => canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0), 60_000);
  const restoredAnalysis = second.page.frameLocator('iframe[title="章节、图表、复现与全局报告"]');
  await restoredAnalysis.locator('.status-card.status-completed').waitFor({ timeout: 60_000 });
  const restoredContext = await panelContext(second.page, instance, pane, tab);
  assert.ok(restoredContext.annotations.some((annotation) => annotation.comments.some((comment) => comment.content === '真实打包验收批注')), 'Evidence annotation did not survive restart');
  assert.equal(await second.page.locator('[role="alert"]').filter({ hasText: /会话不存在|已归档/u }).count(), 0, 'Restarted Workbench has a dangling conversation binding');
  const restoredPdfResponse = await waitFor(() => second.networkAudit.resourceResponses.find((response) =>
    response.method === 'GET' && /\/api\/resources\/[^/]+$/u.test(new URL(response.url).pathname) && [200, 206].includes(response.status),
  ), 60_000);
  assert.equal(second.networkAudit.requestFailures.some((failure) => failure.url.includes('/api/resources/')), false, 'Restarted native PDF Range request was blocked');
  await second.page.screenshot({ path: restoredScreenshotPath, fullPage: true });
  await closeApplication(second.application);

  const result = {
    schemaVersion: 2,
    completedAt: new Date().toISOString(),
    textModel,
    visionModel,
    source: { key: '9Y2ILIWX', sha256: sourceHash, unchanged: await sha256(sourcePath) === sourceHash },
    crossVolume: {
      readerRuntimeDrive: parse(userDataRoot).root,
      projectArchiveDrive: parse(projectRoot).root,
      mappingSha256: mapping.sha256,
      archived: true,
    },
    reader: {
      status: completedReader.status,
      sourceBlockCount: completedReader.translationBlockCount,
      translatedBlockCount: completedReader.translatedBlockCount,
      conclusionCount: completedReader.conclusionCount,
      qualityStatus: completedReader.quality.status,
      modelCalls: completedReader.batchAuthorization.consumed.modelCalls,
      consumedTokens: completedReader.batchAuthorization.consumed.totalTokens,
      confirmationDialogs: dialogAudit.length,
      automaticResumes: resumeCount,
      authorizationStatus: completedReader.batchAuthorization.status,
      reportRevisionId: completedReader.reportArtifact.revisionId,
    },
    restartRestored: true,
    pdfRendered: {
      initialStatus: initialPdfResponse.status,
      restoredStatus: restoredPdfResponse.status,
      renderer: 'host-pdfjs-range',
      evidenceHighlight: true,
    },
    evidence: { drawerOpened: true, annotationPersisted: true },
    temporaryRootsRetained: 0,
    disk: {
      initialFreeF,
      finalFreeF: freeBytes(outputRoot),
      initialFreeC,
      finalFreeC: freeBytes(tmpdir()),
    },
    screenshots: [previewScreenshotPath, completedScreenshotPath, restoredScreenshotPath],
  };
  atomicJson(summaryPath, result);
  process.stdout.write(`${JSON.stringify({ type: 'summary', ...result.reader, restartRestored: true, temporaryRootsRetained: 0 })}\n`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void activeApplication?.close().catch(() => undefined).finally(() => {
      cleanup();
      process.exit(130);
    });
  });
}

process.once('exit', cleanup);

try {
  await main();
} finally {
  await activeApplication?.close().catch(() => undefined);
  cleanup();
}
