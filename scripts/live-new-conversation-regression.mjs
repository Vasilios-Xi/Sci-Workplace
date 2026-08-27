import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRequire = createRequire(join(workspaceRoot, 'apps', 'desktop', 'package.json'));
const electronPath = desktopRequire('electron');
const mainEntry = resolve(workspaceRoot, 'apps', 'desktop', 'dist', 'main.js');
const artifactRoot = resolve(workspaceRoot, 'artifacts', 'live-qa');
const modelId = 'chatgpt-oauth::gpt-5.3-codex-spark';
const qaPromptPrefix = '这是新建会话切换实机验收';

const pause = async (milliseconds) => await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function connection(page) {
  return await page.evaluate(async () => await window.openlab.getConnection());
}

async function runtimeJson(page, path, body, method = 'POST') {
  const target = await connection(page);
  const response = await fetch(`${target.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${target.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, `${method} ${path} failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function snapshot(page) {
  return await runtimeJson(page, '/api/bootstrap', undefined, 'GET');
}

async function waitFor(check, timeoutMs = 120_000) {
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

async function selectPickerOption(page, pickerTestId, menuTestId, attribute, value) {
  await page.getByTestId(pickerTestId).click();
  const menu = page.getByTestId(menuTestId);
  await menu.waitFor({ state: 'visible' });
  const option = menu.locator(`[${attribute}="${value}"]`);
  assert.equal(await option.count(), 1, `Missing picker option ${attribute}=${value}`);
  await option.click();
  await menu.waitFor({ state: 'detached' });
}

await mkdir(artifactRoot, { recursive: true });
const application = await electron.launch({
  executablePath: electronPath,
  args: [mainEntry],
  cwd: workspaceRoot,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  timeout: 60_000,
});

let pageError;
let createdSessionId;
let previousSessionId;
let initialConnection;
try {
  const page = await application.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(60_000);
  page.on('pageerror', (error) => { pageError ??= error; });
  await page.getByTestId('new-conversation').waitFor();
  let initial = await snapshot(page);
  if (initial.timeline.some((node) => node.kind === 'user' && node.content.startsWith(qaPromptPrefix))) {
    await runtimeJson(page, `/api/sessions/${encodeURIComponent(initial.activeSessionId)}/archive`, {});
    initial = await snapshot(page);
  }
  previousSessionId = initial.activeSessionId;
  const projects = await page.evaluate(async () => await window.openlab.listProjects());
  const qaProject = projects.find((project) => project.rootPath.trim()) ?? projects[0];
  assert.ok(qaProject?.rootPath, 'Live new-conversation QA requires at least one existing real project folder');
  const projectRoot = qaProject.rootPath;
  const projectName = qaProject.name || basename(projectRoot);
  assert.ok(initial.models.some((model) => model.id === modelId), `${modelId} is unavailable`);
  initialConnection = await connection(page);

  await page.getByTestId('new-conversation').click();
  await page.getByTestId('hana-draft-hero').waitFor();
  await waitFor(async () => /不在项目中工作/u.test((await page.getByTestId('draft-project-selector').innerText()).trim()));
  assert.deepEqual(await connection(page), initialConnection, 'Starting a draft changed the live Runtime connection');
  assert.equal(await page.locator('.session-item.is-active').count(), 0, 'A new unsent conversation selected an old sidebar row');

  await page.getByTestId('draft-project-selector').click();
  const byPath = page.getByTestId('draft-project-option').filter({ has: page.locator(`[title="${projectRoot.replaceAll('"', '\\"')}"]`) });
  const option = await byPath.count()
    ? byPath.first()
    : page.getByTestId('draft-project-option').filter({ hasText: projectName }).first();
  assert.equal(await option.count(), 1, `Project is missing from the draft picker: ${projectRoot}`);
  await option.click();
  assert.deepEqual(await connection(page), initialConnection, 'Selecting a draft project changed the live Runtime before first send');
  assert.equal(await page.locator('.session-item.is-active').count(), 0, 'Selecting a project reselected an old conversation before send');

  await selectPickerOption(page, 'model-picker', 'model-picker-menu', 'data-model-id', modelId);
  await selectPickerOption(page, 'composer-permission', 'permission-picker-menu', 'data-permission-mode', 'read_only');
  const prompt = `${qaPromptPrefix}。本轮只检查左栏切换，收到后无需继续回答。`;
  await page.getByTestId('composer-input').fill(prompt);
  await page.waitForFunction(() => {
    const button = document.querySelector('.app-mode-chat [data-testid="send-message"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });

  await page.evaluate((oldSessionId) => {
    const trace = [];
    const record = () => {
      const active = document.querySelector('.session-item.is-active');
      const state = {
        at: performance.now(),
        draft: Boolean(document.querySelector('.conversation-pane.is-draft-conversation')),
        activeSessionId: active instanceof HTMLElement ? active.dataset.sessionId ?? null : null,
        title: document.querySelector('[data-testid="conversation-header-meta"]')?.textContent?.trim() ?? '',
      };
      const previous = trace.at(-1);
      if (!previous || previous.draft !== state.draft || previous.activeSessionId !== state.activeSessionId || previous.title !== state.title) trace.push(state);
    };
    const observer = new MutationObserver(record);
    observer.observe(document.querySelector('.app-mode-chat') ?? document.body, { attributes: true, childList: true, subtree: true, characterData: true });
    record();
    window.__sciNewConversationProbe = { observer, oldSessionId, trace };
  }, previousSessionId);

  await page.getByTestId('send-message').click();
  await page.locator('.user-message').filter({ hasText: prompt }).last().waitFor();
  const promoted = await waitFor(async () => {
    const state = await snapshot(page);
    return state.activeSessionId !== previousSessionId
      && state.timeline.some((node) => node.kind === 'user' && node.content === prompt)
      ? state
      : undefined;
  });
  createdSessionId = promoted.activeSessionId;
  assert.notEqual(createdSessionId, previousSessionId, 'The first send did not promote to a new session');
  assert.equal(promoted.sessions.find((session) => session.id === createdSessionId)?.model, modelId, 'The real new conversation did not use GPT-5.3 Codex Spark');
  const promotedConnection = await connection(page);
  assert.equal(promotedConnection.projectFolderSelected, true, 'The first send escaped back to the detached workspace');
  assert.equal(promotedConnection.projectRoot.toLocaleLowerCase(), projectRoot.toLocaleLowerCase(), 'The first send used the wrong project Runtime');
  assert.match(await page.getByTestId('model-picker').innerText(), /GPT-5\.3-Codex-Spark/iu, 'The promoted real conversation lost its selected model in the composer');
  await page.locator(`.sidebar-project-sessions .session-item[data-session-id="${createdSessionId}"]`).waitFor();
  assert.equal(await page.locator(`.sidebar-section-sessions .session-item[data-session-id="${createdSessionId}"]`).count(), 0, 'A project conversation was incorrectly grouped under Recent');
  await pause(1_500);

  const probe = await page.evaluate(() => {
    const value = window.__sciNewConversationProbe;
    value?.observer.disconnect();
    delete window.__sciNewConversationProbe;
    return value ? { oldSessionId: value.oldSessionId, trace: value.trace } : undefined;
  });
  assert.ok(probe, 'The real sidebar transition probe was not installed');
  assert.equal(
    probe.trace.some((state) => !state.draft && state.activeSessionId === probe.oldSessionId),
    false,
    `The real UI flashed the previous conversation during promotion: ${JSON.stringify(probe.trace)}`,
  );
  if (await page.getByTestId('cancel-turn').count()) await page.getByTestId('cancel-turn').click();
  await waitFor(async () => {
    const state = await snapshot(page);
    return state.sessions.find((session) => session.id === createdSessionId)?.status !== 'running' ? true : undefined;
  }, 30_000);
  assert.equal(pageError, undefined, pageError?.message);
  await page.screenshot({ path: join(artifactRoot, 'sci-workplace-live-new-conversation.png'), fullPage: true });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    model: modelId,
    previousSessionId,
    createdSessionId,
    requestReachedRuntime: true,
    remainedInSelectedProject: true,
    turnCancelledAfterTransitionCheck: true,
    sidebarTransitionTrace: probe.trace,
    screenshot: join(artifactRoot, 'sci-workplace-live-new-conversation.png'),
  }, null, 2)}\n`);
} finally {
  const pages = application.windows();
  const page = pages[0];
  if (page) {
    if (createdSessionId) await runtimeJson(page, `/api/sessions/${encodeURIComponent(createdSessionId)}/archive`, {}).catch(() => undefined);
    if (initialConnection?.projectFolderSelected) {
      await page.evaluate(async (rootPath) => await window.openlab.activateExistingProject(rootPath), initialConnection.projectRoot).catch(() => undefined);
    } else if (initialConnection) {
      await page.evaluate(async () => await window.openlab.clearProject()).catch(() => undefined);
    }
    if (previousSessionId) await runtimeJson(page, `/api/sessions/${encodeURIComponent(previousSessionId)}/activate`, {}).catch(() => undefined);
  }
  await application.close().catch(() => undefined);
}
