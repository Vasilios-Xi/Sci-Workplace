import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRequire = createRequire(join(workspaceRoot, 'apps', 'desktop', 'package.json'));
const electronPath = desktopRequire('electron');
const mainEntry = resolve(workspaceRoot, 'apps', 'desktop', 'dist', 'main.js');
const artifactRoot = resolve(workspaceRoot, 'artifacts', 'live-qa');

const pause = async (milliseconds) => await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function connection(page) {
  return await page.evaluate(async () => await window.openlab.getConnection());
}

async function snapshot(page) {
  const target = await connection(page);
  const response = await fetch(`${target.baseUrl}/api/bootstrap`, {
    headers: { Authorization: `Bearer ${target.token}` },
  });
  const payload = await response.json();
  assert.equal(response.ok, true, `GET /api/bootstrap failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitFor(check, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await pause(120);
  }
  throw lastError ?? new Error(`Condition timed out after ${timeoutMs}ms`);
}

await mkdir(artifactRoot, { recursive: true });
const application = await electron.launch({
  executablePath: electronPath,
  args: [mainEntry],
  cwd: workspaceRoot,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  timeout: 60_000,
});

try {
  const page = await application.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(60_000);
  await page.getByTestId('new-conversation').waitFor();
  const initial = await snapshot(page);
  const projectRoot = initial.project.rootPath;
  assert.ok(projectRoot, 'The live UI regression requires the current real project folder');
  const expectedRootName = basename(projectRoot.replace(/[\\/]+$/u, ''));
  const marker = await page.evaluate(() => {
    const value = crypto.randomUUID();
    globalThis.__sciWorkplaceLiveDocumentMarker = value;
    return value;
  });

  await page.getByTestId('new-conversation').click();
  await page.getByTestId('hana-draft-hero').waitFor();
  assert.match((await page.getByTestId('draft-project-selector').innerText()).trim(), /不在项目中工作/u);
  assert.equal(await page.evaluate(() => globalThis.__sciWorkplaceLiveDocumentMarker), marker, 'New conversation replaced the renderer document');

  await page.getByTestId('draft-project-selector').click();
  const projectOption = page.getByTestId('draft-project-option').filter({ has: page.locator(`[title="${projectRoot.replaceAll('"', '\\"')}"]`) });
  const exactOption = page.getByTestId('draft-project-option').filter({ hasText: initial.project.name }).first();
  const option = await projectOption.count() ? projectOption.first() : exactOption;
  assert.equal(await option.count(), 1, `The active project is missing from the real project picker: ${projectRoot}`);
  await option.click();
  await waitFor(async () => {
    const state = await snapshot(page);
    return state.project.rootPath.toLocaleLowerCase() === projectRoot.toLocaleLowerCase() ? state : undefined;
  });
  assert.equal(await page.evaluate(() => globalThis.__sciWorkplaceLiveDocumentMarker), marker, 'Project selection reloaded the renderer document');
  assert.equal(await page.locator('.session-item.is-active').count(), 0, 'Selecting a project should keep an unsent new conversation as a draft');

  const workspace = page.locator('#conversation-workspace');
  if (!await workspace.isVisible()) await page.getByTestId('titlebar-workspace-toggle').click();
  const launcher = page.getByTestId('workspace-panel-option-workspace');
  if (await launcher.isVisible()) await launcher.click();
  await page.getByTestId('workspace-tab-workspace').click();
  const rootButton = page.locator('.workspace-tree__root').first().locator(':scope > .workspace-tree__row .workspace-tree__main');
  await rootButton.waitFor();
  assert.equal((await rootButton.innerText()).trim(), expectedRootName, 'The live project tree does not use the actual folder name');
  const visibleRootEntries = (await readdir(projectRoot, { withFileTypes: true }))
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.'));
  assert.ok(visibleRootEntries.length > 0, 'The real project contains no visible entries for tree verification');
  await page.locator('.workspace-tree__root').first().getByText(visibleRootEntries[0], { exact: true }).waitFor();

  const session = page.locator('.session-item').first();
  await session.waitFor();
  await session.click();
  const originalTitle = (await page.getByTestId('conversation-title-rename').innerText()).trim();
  await page.getByTestId('conversation-title-rename').click();
  const titleInput = page.getByTestId('conversation-title-input');
  await titleInput.waitFor();
  assert.equal(await page.getByTestId('app-dialog-input').count(), 0, 'Live title rename opened a modal instead of inline editing');
  await titleInput.press('Escape');
  assert.equal((await page.getByTestId('conversation-title-rename').innerText()).trim(), originalTitle, 'Escape did not cancel live inline rename');

  const locatorTrigger = page.getByTestId('conversation-locator-trigger');
  await locatorTrigger.waitFor();
  assert.ok(Number(await locatorTrigger.evaluate((element) => getComputedStyle(element).opacity)) < .05, 'The live conversation locator was visible before hover');
  await page.getByTestId('conversation-locator').hover();
  await page.waitForFunction(() => document.querySelector('[data-testid="conversation-locator-trigger"]')?.getAttribute('data-state') === 'open');
  await page.waitForFunction(() => {
    const rail = document.querySelector('[data-testid="conversation-locator-trigger"]');
    return rail instanceof HTMLElement && Number(getComputedStyle(rail).opacity) > .95;
  });
  assert.ok(Number(await locatorTrigger.evaluate((element) => getComputedStyle(element).opacity)) > .95, 'The live conversation locator did not reveal at the conversation edge');
  const locatorTicks = page.getByTestId('conversation-locator-tick');
  assert.ok(await locatorTicks.count() > 1, 'The live conversation locator did not expose clickable positions');
  await locatorTicks.last().hover();
  assert.ok((await locatorTicks.last().getAttribute('class'))?.includes('is-active'), 'The live locator highlight did not follow the pointer');
  const locatorItems = page.getByTestId('conversation-locator-item');
  const locatorItemCount = await locatorItems.count();
  assert.ok(locatorItemCount > 1, 'The live conversation locator did not index the real user messages');
  await locatorTicks.first().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="conversation-locator-item"]')?.getAttribute('aria-current') === 'location');
  assert.ok(await page.locator('.user-message').first().isVisible(), 'Clicking a live locator position did not reveal the corresponding message');
  await locatorItems.last().hover();
  assert.ok((await locatorItems.last().getAttribute('class'))?.includes('is-active'), 'The live outline highlight did not follow the pointer');

  await page.screenshot({ path: join(artifactRoot, 'sci-workplace-live-ui.png'), fullPage: true });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectRoot,
    rootName: expectedRootName,
    recognizedEntry: visibleRootEntries[0],
    rendererDocumentPreserved: true,
    draftStayedUnsaved: true,
    inlineRenameVerified: true,
    locatorItemCount,
    screenshot: join(artifactRoot, 'sci-workplace-live-ui.png'),
  }, null, 2)}\n`);
} finally {
  await application.close().catch(() => undefined);
}
