import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRequire = createRequire(join(workspaceRoot, 'apps', 'desktop', 'package.json'));
const packaged = process.argv.includes('--packaged');
const packagedExecutable = process.env.OPENLAB_E2E_PACKAGED_EXECUTABLE?.trim();
const electronPath = packaged
  ? resolve(packagedExecutable || join(workspaceRoot, 'apps', 'desktop', 'release', 'win-unpacked', 'Sci Workplace.exe'))
  : desktopRequire('electron');
const mainEntry = join(workspaceRoot, 'apps', 'desktop', 'dist', 'main.js');
const artifactRoot = join(workspaceRoot, 'artifacts', 'e2e');
const screenshotPath = join(artifactRoot, packaged ? 'sci-workplace-packaged-smoke.png' : 'sci-workplace-smoke.png');
if (!existsSync(electronPath)) throw new Error(`Electron executable not found: ${electronPath}`);
const testRoot = mkdtempSync(join(tmpdir(), 'openlab-e2e-'));
const projectRoot = join(testRoot, 'project');
const externalRoot = join(testRoot, 'external-workspace');
const userDataRoot = join(testRoot, 'user-data');

mkdirSync(projectRoot, { recursive: true });
mkdirSync(externalRoot, { recursive: true });
mkdirSync(userDataRoot, { recursive: true });
mkdirSync(artifactRoot, { recursive: true });
writeFileSync(join(externalRoot, 'external-evidence.md'), '# External evidence\ntraceable', 'utf8');

let callSequence = 0;
let persistentMemberIds = [];

const semanticRoles = ['neutral', 'accent', 'success', 'warning', 'danger', 'info'];
const semanticPalettes = {
  'warm-paper': ['#6F7975', '#568D78', '#3B765B', '#98743B', '#A75C52', '#52788E'],
  'cyan-night': ['#AAB9B4', '#8DCEBD', '#79C7A5', '#D5AD69', '#E08B80', '#82B7D1'],
  'pure-white': ['#4F5855', '#244A40', '#2F7456', '#8A681F', '#9D403A', '#3F6F8A'],
  butter: ['#747862', '#6C8145', '#5F7D4F', '#8A6D2F', '#9F554D', '#627A88'],
  ming: ['#B0B6C4', '#B7C2DF', '#84C4A7', '#D9B574', '#E7958D', '#8DBCE0'],
  absolutely: ['#6F7889', '#5E72A1', '#4E806B', '#947238', '#AD584F', '#567DA4'],
  'ready-to-catch': ['#687B7B', '#56868B', '#4E806D', '#8F7137', '#A9574F', '#4F7D96'],
  'angry-whale': ['#687B83', '#47788D', '#4E7F69', '#8E7033', '#C45F55', '#47788D'],
  'new-warm-paper': ['#746E64', '#74644E', '#58755F', '#886C3F', '#A2594F', '#637989'],
  'cyan-night-contrast': ['#D4E6DF', '#9CF4E2', '#7DE6B5', '#F1C678', '#FF9B90', '#8FD5FF'],
  'coral-paper': ['#816C66', '#AD6253', '#4F7C67', '#93703B', '#B14E49', '#5F7F92'],
};

async function assertSemanticPalette(page, expectedTheme) {
  const applied = await page.evaluate((roles) => ({
    resolvedTheme: document.documentElement.dataset.theme,
    colors: roles.map((role) => getComputedStyle(document.documentElement).getPropertyValue(`--semantic-${role}`).trim().toUpperCase()),
  }), semanticRoles);
  const resolved = expectedTheme === 'auto' ? applied.resolvedTheme : expectedTheme;
  assert.deepEqual(applied.colors, semanticPalettes[resolved], `semantic palette mismatch for ${expectedTheme} (${resolved})`);
}

function jsonContent(content) {
  if (typeof content === 'string') return content;
  return JSON.stringify(content ?? '');
}

function lastUserText(messages) {
  return [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}

function toolOutput(messages, toolName) {
  return [...messages].reverse().find((message) => message.role === 'tool' && jsonContent(message.content).includes(`tool="${toolName}"`))?.content;
}

function envelopeMetadata(content) {
  if (typeof content !== 'string') return {};
  for (const line of content.split(/\r?\n/u)) {
    if (!line.startsWith('{"ok"')) continue;
    try { return JSON.parse(line).metadata ?? {}; }
    catch { return {}; }
  }
  return {};
}

function usage() {
  return {
    prompt_tokens: 1_200,
    completion_tokens: 120,
    total_tokens: 1_320,
    prompt_cache_hit_tokens: 800,
    prompt_cache_miss_tokens: 400,
    completion_tokens_details: { reasoning_tokens: 24 },
  };
}

function beginSse(response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

function frame(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function pause(milliseconds = 8) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function sendText(response, text, reasoning = '正在核对可回放状态。') {
  beginSse(response);
  frame(response, { choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }] });
  await pause();
  const midpoint = Math.max(1, Math.floor(text.length / 2));
  frame(response, { choices: [{ delta: { content: text.slice(0, midpoint) }, finish_reason: null }] });
  await pause();
  frame(response, { choices: [{ delta: { content: text.slice(midpoint) }, finish_reason: null }] });
  frame(response, { choices: [{ delta: {}, finish_reason: 'stop' }] });
  frame(response, { choices: [], usage: usage() });
  response.end('data: [DONE]\n\n');
}

async function sendToolCalls(response, calls) {
  beginSse(response);
  frame(response, { choices: [{ delta: { reasoning_content: '需要调用受审计工具完成该步骤。' }, finish_reason: null }] });
  await pause();
  const first = [];
  const second = [];
  calls.forEach((call, index) => {
    const id = `e2e_call_${++callSequence}`;
    const args = JSON.stringify(call.arguments);
    const midpoint = Math.max(1, Math.floor(args.length / 2));
    first.push({ index, id, function: { name: call.name, arguments: args.slice(0, midpoint) } });
    second.push({ index, function: { arguments: args.slice(midpoint) } });
  });
  frame(response, { choices: [{ delta: { tool_calls: first }, finish_reason: null }] });
  await pause();
  frame(response, { choices: [{ delta: { tool_calls: second }, finish_reason: null }] });
  frame(response, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  frame(response, { choices: [], usage: usage() });
  response.end('data: [DONE]\n\n');
}

async function handleCompletion(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const transcript = messages.map((message) => jsonContent(message.content)).join('\n');

  if (tools.length === 0) {
    await sendText(response, transcript.includes('压缩科研会话历史') ? '目标、证据、工具结果与待办均已保留。' : 'E2E 自动化会话', '');
    return;
  }

  if (transcript.includes('持久成员 Agent')) {
    await sendText(response, 'MEMBER_REPORT_DONE');
    return;
  }

  const userText = jsonContent(lastUserText(messages));
  if (userText.includes('E2E_WRITE_UNDO')) {
    const writeResult = toolOutput(messages, 'write_file');
    const undoResult = toolOutput(messages, 'undo_change');
    if (!writeResult) {
      await sendToolCalls(response, [{ name: 'write_file', arguments: { path: 'e2e-change.txt', content: 'temporary e2e content\n' } }]);
      return;
    }
    if (!undoResult) {
      const changeSetId = envelopeMetadata(writeResult).changeSetId
        ?? JSON.parse(writeResult.split(/\r?\n/u).find((line) => line.startsWith('{"ok"'))).changeSetId;
      assert.equal(typeof changeSetId, 'string');
      await sendToolCalls(response, [{ name: 'undo_change', arguments: { changeSetId } }]);
      return;
    }
    await sendText(response, 'E2E_WRITE_UNDO_DONE');
    return;
  }

  if (userText.includes('E2E_MULTI')) {
    const delegationResults = messages.filter((message) => message.role === 'tool' && jsonContent(message.content).includes('tool="delegate_task"'));
    const waitResult = toolOutput(messages, 'wait_for_agent_runs');
    if (delegationResults.length === 0) {
      assert.equal(persistentMemberIds.length, 3, 'three user-created members must be bound before delegation');
      await sendToolCalls(response, persistentMemberIds.map((targetAgentId, index) => ({
        name: 'delegate_task',
        arguments: { targetAgentId, title: `E2E member ${index + 1}`, description: `Return member report ${index + 1}`, inputRefs: [] },
      })));
      return;
    }
    if (!waitResult) {
      const runIds = delegationResults.map((message) => envelopeMetadata(message.content).runId).filter((id) => typeof id === 'string');
      assert.equal(runIds.length, 3);
      await sendToolCalls(response, [{ name: 'wait_for_agent_runs', arguments: { runIds } }]);
      return;
    }
    await sendText(response, 'E2E_MULTI_DONE');
    return;
  }

  await sendText(response, 'E2E_BASIC_DONE');
}

const server = createServer((request, response) => {
  void (async () => {
    if (request.method === 'GET' && request.url === '/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/chat/completions') {
      await handleCompletion(request, response);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'not found' } }));
  })().catch((error) => {
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
  });
});

await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const address = server.address();
assert.ok(address && typeof address === 'object');
const fakeDeepSeekUrl = `http://127.0.0.1:${address.port}`;

async function launch() {
  const application = await electron.launch({
    executablePath: electronPath,
    args: packaged ? [] : [mainEntry],
    cwd: packaged ? dirname(electronPath) : workspaceRoot,
    env: {
      ...process.env,
      OPENLAB_PROJECT_ROOT: projectRoot,
      OPENLAB_TEST_USER_DATA_ROOT: userDataRoot,
      OPENLAB_DEEPSEEK_BASE_URL: fakeDeepSeekUrl,
      ELECTRON_ENABLE_LOGGING: '1',
    },
    timeout: 60_000,
  });
  const page = await application.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(30_000);
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location();
    const source = location.url ? ` (${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0})` : '';
    process.stderr.write(`[renderer console] ${message.text()}${source}\n`);
  });
  page.on('pageerror', (error) => process.stderr.write(`[renderer pageerror] ${error.message}\n`));
  await page.locator('.app-mode-chat [data-testid="composer-input"]').waitFor();
  return { application, page };
}

async function connection(page) {
  return await page.evaluate(async () => await window.openlab.getConnection());
}

async function snapshot(page) {
  const target = await connection(page);
  const response = await fetch(`${target.baseUrl}/api/bootstrap`, { headers: { Authorization: `Bearer ${target.token}` } });
  assert.equal(response.status, 200);
  return await response.json();
}

async function runtimeJson(page, path, body, method = 'POST') {
  const target = await connection(page);
  const response = await fetch(`${target.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${target.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, `${method} ${path} failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitFor(check, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await pause(100);
  }
  throw lastError ?? new Error(`Condition timed out after ${timeoutMs}ms`);
}

async function waitTurnIdle(page) {
  await page.waitForFunction(() => {
    const button = document.querySelector('.app-mode-chat [data-testid="send-message"]');
    return button instanceof HTMLButtonElement;
  }, undefined, { timeout: 60_000 });
}

async function sendScenario(page, input) {
  await waitTurnIdle(page);
  await page.locator('.app-mode-chat [data-testid="composer-input"]').fill(input);
  await page.waitForFunction(() => {
    const button = document.querySelector('.app-mode-chat [data-testid="send-message"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await page.locator('.app-mode-chat [data-testid="send-message"]').click();
  await page.locator('.user-message').filter({ hasText: input }).last().waitFor();
}

async function approveNext(page) {
  const button = page.getByTestId('approve-tool').first();
  await button.waitFor({ state: 'visible', timeout: 60_000 });
  await button.click();
}

async function switchAppMode(page, label) {
  await page.getByTestId('titlebar-view-menu-trigger').click();
  const mode = page.locator('.titlebar-mode-switch').getByRole('menuitemradio', { name: label });
  await mode.waitFor();
  await mode.click();
}

let firstApplication;
let secondApplication;
try {
  const first = await launch();
  firstApplication = first.application;
  const { page } = first;

  const onboarding = page.getByTestId('primary-agent-onboarding');
  await onboarding.waitFor();
  const freshSnapshot = await snapshot(page);
  assert.equal(freshSnapshot.primaryAgent.configured, false);
  assert.equal(freshSnapshot.primaryAgent.role, 'research_partner');
  assert.equal(freshSnapshot.agentDefinitions.length, 0, 'fresh install must not create an Agent before user confirmation');
  assert.equal(freshSnapshot.agentRuns.length, 0, 'fresh install must not create an Agent run before user confirmation');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'primary-agent-onboarding-packaged.png' : 'primary-agent-onboarding.png') });
  await page.getByTestId('primary-agent-name').fill('E2E 研究搭档');
  await page.getByTestId('primary-agent-start').click();
  await onboarding.waitFor({ state: 'detached' });
  const namedSnapshot = await snapshot(page);
  assert.equal(namedSnapshot.primaryAgent.configured, true);
  assert.equal(namedSnapshot.primaryAgent.name, 'E2E 研究搭档');
  assert.equal(namedSnapshot.primaryAgent.avatar, 'sage');
  assert.equal(namedSnapshot.primaryAgent.role, 'research_partner');
  assert.ok(namedSnapshot.primaryAgent.identity.includes('{{agentName}}'));
  assert.ok(namedSnapshot.primaryAgent.instructions.includes('研究搭档'));
  assert.equal(namedSnapshot.agentDefinitions.length, 1);
  assert.equal(namedSnapshot.agentDefinitions[0].name, 'E2E 研究搭档');
  assert.equal(namedSnapshot.agentRuns.length, 1);
  assert.equal(namedSnapshot.agentRuns[0].role, 'lead');

  await page.getByTestId('sidebar-profile-trigger').click();
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-modal').waitFor();
  await page.getByTestId('deepseek-key').fill('sk-e2e-test');
  await page.getByTestId('deepseek-key-save').click();
  await waitFor(async () => (await snapshot(page)).mode === 'connected' ? true : undefined);
  const providerSemanticVisuals = await page.evaluate(() => ({
    headingIcon: getComputedStyle(document.querySelector('.provider-heading .settings-heading__icon')).backgroundColor,
    statusDot: getComputedStyle(document.querySelector('.provider-status i')).backgroundColor,
    primaryButton: getComputedStyle(document.querySelector('.provider-config-actions .button.primary')).backgroundColor,
  }));
  assert.equal(providerSemanticVisuals.headingIcon, 'rgba(0, 0, 0, 0)', 'provider heading icon must be transparent');
  assert.notEqual(providerSemanticVisuals.statusDot, 'rgba(0, 0, 0, 0)', 'provider status point must retain its fill');
  assert.notEqual(providerSemanticVisuals.primaryButton, 'rgba(0, 0, 0, 0)', 'primary actions must retain their background');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'provider-settings-packaged.png' : 'provider-settings.png') });
  await page.getByTestId('settings-page-agents').click();
  await page.getByTestId('settings-agent-page').waitFor();
  await page.getByTestId('agent-avatar-upload').setInputFiles({
    name: 'e2e-avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  });
  await page.locator('.agent-profile-hero [data-avatar="custom"] img').waitFor();
  await page.screenshot({ path: join(artifactRoot, packaged ? 'agent-custom-avatar-packaged.png' : 'agent-custom-avatar.png') });
  await page.getByTestId('primary-agent-identity').fill('# {{agentName}}\n\nE2E_CUSTOM_IDENTITY for {{userName}}.');
  await page.getByTestId('primary-agent-instructions').fill('# E2E_CUSTOM_ROLE\n- Keep every claim traceable.');
  await page.getByTestId('primary-agent-settings-save').click();
  const customizedAgent = await waitFor(async () => {
    const state = await snapshot(page);
    return state.agentDefinitions[0]?.identity.includes('E2E_CUSTOM_IDENTITY') ? state : undefined;
  });
  assert.equal(customizedAgent.agentDefinitions.length, 1);
  assert.ok(customizedAgent.agentDefinitions[0].instructions.includes('E2E_CUSTOM_ROLE'));
  assert.ok(customizedAgent.agentDefinitions[0].avatar.startsWith('data:image/webp;base64,'), 'custom Agent avatar must be normalized and persisted');

  for (const [name, templateId] of [['E2E 审校员', 'rigorous_reviewer'], ['E2E 实验员', 'experiment_executor'], ['E2E 分析员', 'blank']]) {
    await page.getByTestId('create-agent').click();
    await page.getByTestId('new-agent-name').fill(name);
    await page.getByTestId(`agent-template-${templateId}`).click();
    await page.getByTestId('confirm-create-agent').click();
  }
  const roleLibrary = await waitFor(async () => {
    const state = await snapshot(page);
    return state.agentDefinitions.length === 4 ? state : undefined;
  });
  persistentMemberIds = roleLibrary.agentDefinitions.slice(1).map((agent) => agent.id);
  assert.equal(new Set(persistentMemberIds).size, 3);
  await page.screenshot({ path: join(artifactRoot, packaged ? 'agent-settings-packaged.png' : 'agent-settings.png') });

  await page.getByTestId('settings-page-interface').click();
  const interfacePage = page.getByTestId('settings-interface-page');
  await interfacePage.waitFor();
  assert.equal(await interfacePage.locator('.theme-card').count(), 12, 'interface settings must expose all twelve theme cards');
  for (const themeId of ['warm-paper', 'cyan-night', 'auto', 'pure-white', 'butter', 'ming', 'absolutely', 'ready-to-catch', 'angry-whale', 'new-warm-paper', 'cyan-night-contrast', 'coral-paper']) {
    await page.getByTestId(`theme-card-${themeId}`).click();
    await page.waitForFunction((selected) => document.documentElement.dataset.themeSelection === selected, themeId);
    await assertSemanticPalette(page, themeId);
  }
  await page.getByTestId('theme-card-auto').click();
  await page.getByTestId('semantic-palette-auto-dark').click();
  assert.equal(await page.getByTestId('semantic-palette-auto-dark').getAttribute('aria-selected'), 'true');
  await page.getByTestId('semantic-palette-auto-light').click();
  assert.equal(await page.getByTestId('semantic-palette-auto-light').getAttribute('aria-selected'), 'true');

  await page.getByTestId('theme-card-coral-paper').click();
  await interfacePage.getByLabel('强调 HEX').fill('#123456');
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--semantic-accent').trim().toUpperCase() === '#123456');
  await page.getByTestId('theme-card-warm-paper').click();
  await assertSemanticPalette(page, 'warm-paper');
  await page.getByTestId('theme-card-coral-paper').click();
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--semantic-accent').trim().toUpperCase()), '#123456', 'theme override must remain isolated');
  await page.getByTestId('semantic-palette-reset-accent').click();
  await assertSemanticPalette(page, 'coral-paper');
  await interfacePage.getByLabel('警告 HEX').fill('#FFFFFF');
  await interfacePage.locator('.semantic-palette-field[data-role="warning"] .semantic-contrast-warning').waitFor();
  await page.getByTestId('semantic-palette-reset-warning').click();
  await assertSemanticPalette(page, 'coral-paper');
  await interfacePage.getByLabel('强调 HEX').fill('#123456');
  await page.getByTestId('semantic-palette-reset-theme').click();
  await assertSemanticPalette(page, 'coral-paper');
  await page.getByTestId('theme-card-warm-paper').click();
  await interfacePage.getByLabel('普通 HEX').fill('#123456');
  await page.getByTestId('theme-card-coral-paper').click();
  await interfacePage.getByLabel('成功 HEX').fill('#234567');
  await page.getByTestId('semantic-palette-reset-all').click();
  const appDialog = page.getByTestId('app-dialog');
  await appDialog.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'app-dialog-confirm');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'app-dialog-confirm', 'application dialogs focus their primary action');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'app-dialog-packaged.png' : 'app-dialog.png') });
  await page.keyboard.press('Escape');
  await appDialog.waitFor({ state: 'detached' });
  assert.equal(await interfacePage.getByLabel('成功 HEX').inputValue(), '#234567', 'Escape cancels an application dialog');
  await page.getByTestId('semantic-palette-reset-all').click();
  await appDialog.waitFor();
  await page.getByTestId('app-dialog-confirm').click();
  await assertSemanticPalette(page, 'coral-paper');
  await interfacePage.getByLabel('成功 HEX').fill('#336699');
  await page.waitForFunction(async () => (await window.openlab.getInterfacePreferences()).semanticPaletteOverrides?.['coral-paper']?.success === '#336699');
  await page.getByTestId('theme-card-warm-paper').click();
  await page.screenshot({ path: join(artifactRoot, packaged ? 'interface-settings-packaged.png' : 'interface-settings.png') });
  await page.getByTestId('theme-card-cyan-night').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'cyan-night');
  assert.equal(await page.evaluate(() => document.documentElement.style.colorScheme), 'dark');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'interface-settings-dark-packaged.png' : 'interface-settings-dark.png') });
  await interfacePage.getByRole('switch', { name: '会话列表单行显示' }).click();
  await interfacePage.getByRole('switch', { name: '硬件加速' }).click();
  await interfacePage.locator('.timezone-select').selectOption('Asia/Tokyo');
  await page.getByTestId('theme-card-coral-paper').click();
  await interfacePage.locator('.interface-save-status.saved').waitFor();
  const savedDesktopSettings = JSON.parse(readFileSync(join(userDataRoot, 'desktop-settings.json'), 'utf8'));
  assert.deepEqual(savedDesktopSettings.interfacePreferences, {
    schemaVersion: 2,
    theme: 'coral-paper',
    semanticPaletteOverrides: { 'coral-paper': { success: '#336699' } },
    readingFont: 'serif',
    readingSizeDelta: 0,
    chatWidth: 800,
    paperTexture: true,
    sunnyMode: false,
    hardwareAcceleration: false,
    singleLineSessions: true,
    markdown: { font: 'follow-reading', bodySize: 16, contentWidth: 800, heading1Size: 28, heading2Size: 21, heading3Size: 18, lineHeight: 1.5, contentPadding: 24 },
    locale: 'zh-CN',
    timeZone: 'Asia/Tokyo',
  });
  assert.equal(await firstApplication.evaluate(({ app }) => app.isHardwareAccelerationEnabled()), true, 'hardware acceleration change must wait for restart');
  assert.equal(await interfacePage.locator('.interface-restart-note').count(), 1);
  await page.screenshot({ path: join(artifactRoot, packaged ? 'interface-settings-coral-packaged.png' : 'interface-settings-coral.png') });
  await page.setViewportSize({ width: 920, height: 700 });
  await page.screenshot({ path: join(artifactRoot, packaged ? 'interface-settings-compact-packaged.png' : 'interface-settings-compact.png') });
  await page.setViewportSize({ width: 1480, height: 940 });

  await page.getByTestId('settings-page-security').click();
  for (const category of ['projectRead', 'workspaceWrite', 'terminalExecution', 'deletion', 'networkAccess', 'outsideWorkspace', 'extensionInstall', 'externalTools']) {
    const selector = page.getByTestId(`security-policy-${category}`);
    await selector.waitFor();
    assert.deepEqual(await selector.locator('option').allTextContents(), ['允许', '每次询问', '禁止']);
  }
  await page.getByTestId('security-policy-workspaceWrite').selectOption('deny');
  await waitFor(async () => (await snapshot(page)).settings.securityPolicy.workspaceWrite === 'deny');
  await page.getByTestId('security-policy-workspaceWrite').selectOption('allow');
  await waitFor(async () => (await snapshot(page)).settings.securityPolicy.workspaceWrite === 'allow');
  await page.getByTestId('security-policy-networkAccess').selectOption('allow');
  await appDialog.waitFor();
  await page.getByTestId('app-dialog-confirm').click();
  await waitFor(async () => (await snapshot(page)).settings.securityPolicy.networkAccess === 'allow');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'security-settings-packaged.png' : 'security-settings.png') });
  await page.getByTestId('security-policy-reset').click();
  await appDialog.waitFor();
  await page.getByTestId('app-dialog-confirm').click();
  const resetSecurityPolicy = await waitFor(async () => {
    const value = (await snapshot(page)).settings.securityPolicy;
    return value.workspaceWrite === 'ask' && value.networkAccess === 'ask' ? value : undefined;
  });
  assert.deepEqual(resetSecurityPolicy, {
    schemaVersion: 1, projectRead: 'allow', workspaceWrite: 'ask', terminalExecution: 'ask', deletion: 'ask',
    networkAccess: 'ask', outsideWorkspace: 'ask', extensionInstall: 'ask', externalTools: 'ask',
  });
  await page.getByTestId('settings-close').click();

  assert.equal(await page.getByTestId('titlebar-left-toggle').count(), 1, 'conversation sidebar must have one top-level toggle');
  assert.equal(await page.getByTestId('titlebar-workspace-toggle').count(), 1, 'workspace must have one top-level toggle');
  assert.equal(await page.locator('.titlebar-center-switch').count(), 0, 'top center mode switch is removed');
  assert.equal(await page.locator('.titlebar [data-testid="titlebar-workspace-toggle"]').count(), 0, 'workspace toggle no longer occupies the system titlebar');
  assert.equal(await page.locator('[data-testid="conversation-header-actions"] [data-testid="titlebar-workspace-toggle"]').count(), 0, 'workspace toggle is independent from conversation actions');
  assert.equal(await page.locator('[data-testid="chat-workspace-controls"] [data-testid="titlebar-workspace-toggle"]').count(), 1, 'workspace toggle stays at the top-right edge of the chat canvas');
  assert.equal(await page.locator('[data-testid="conversation-header-actions"] button').count(), 3, 'conversation header keeps only branch, open and refresh actions');
  const projectRow = page.getByTestId('sidebar-project-row');
  assert.equal(await projectRow.getAttribute('aria-expanded'), 'true');
  await projectRow.click();
  assert.equal(await projectRow.getAttribute('aria-expanded'), 'false', 'clicking the project row collapses its conversations');
  await projectRow.click({ button: 'right' });
  const projectContextMenu = page.getByTestId('project-context-menu');
  await projectContextMenu.waitFor();
  assert.deepEqual(await projectContextMenu.locator(':scope > button').allTextContents(), ['新对话', '展开对话', '打开项目文件夹', '设置']);
  await projectContextMenu.getByRole('menuitem', { name: '展开对话', exact: true }).click();
  assert.equal(await projectRow.getAttribute('aria-expanded'), 'true', 'project context menu can expand conversations again');
  const composerProjectContext = page.getByTestId('composer-project-context');
  await composerProjectContext.waitFor();
  assert.equal((await composerProjectContext.innerText()).includes('本地'), true, 'project-bound composer shows its local environment context');
  const composerProjectTrigger = composerProjectContext.locator(':scope > button').first();
  await composerProjectTrigger.click();
  const composerProjectMenu = page.getByTestId('composer-project-menu');
  await composerProjectMenu.waitFor();
  const projectMenuText = await composerProjectMenu.innerText();
  assert.equal(projectMenuText.includes('当前项目'), true, 'project context opens the GPT-like current-project picker');
  assert.equal(projectMenuText.includes('新建项目'), true, 'project picker exposes project creation');
  assert.equal(projectMenuText.includes('不在项目中工作'), true, 'project picker allows a conversation without a project');
  await page.keyboard.press('Escape');
  await composerProjectMenu.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.app-mode-chat .composer-hint').count(), 0, 'composer shortcut helper line is removed');
  const activeSessionActions = await page.locator('.session-item.is-active .session-item__actions button').evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { left: rect.left, right: rect.right, opacity: Number(getComputedStyle(button).opacity) };
  }));
  assert.equal(activeSessionActions.length, 2, 'active Hana-style session exposes pin and archive actions');
  assert.ok(activeSessionActions[0].right <= activeSessionActions[1].left, 'session actions do not overlap');
  assert.equal(activeSessionActions.every((button) => button.opacity === 1), true, 'active session actions remain visible');
  await page.locator('.session-item.is-active').click({ button: 'right' });
  const sessionContextMenu = page.getByTestId('session-context-menu');
  await sessionContextMenu.waitFor();
  assert.deepEqual(await sessionContextMenu.locator(':scope > button').allTextContents(), ['摘要', '复制 Session ID', '置顶', '重命名', '归档']);
  const activeSessionMetadata = page.locator('.session-item.is-active .session-item__copy small');
  assert.equal(await activeSessionMetadata.evaluate((element) => getComputedStyle(element).display), 'block', 'Hana-style Agent, folder, and relative-time metadata remains visible in compact preferences');
  const sidebarState = await snapshot(page);
  const sidebarMetadataParts = (await activeSessionMetadata.innerText()).split(' · ');
  assert.equal(sidebarMetadataParts[0], sidebarState.primaryAgent.name, 'session metadata starts with the Agent name');
  assert.equal(sidebarMetadataParts[1], sidebarState.project.rootPath.replace(/[\\/]+$/u, '').split(/[\\/]/u).filter(Boolean).at(-1) || sidebarState.project.name, 'session metadata shows the working folder instead of repeating the Agent name');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'chat-session-context-menu-packaged.png' : 'chat-session-context-menu.png') });
  await sessionContextMenu.getByRole('menuitem', { name: '置顶', exact: true }).click();
  await waitFor(async () => await page.locator('.session-item.is-active').evaluate((element) => element.classList.contains('is-pinned') ? true : undefined));
  await page.locator('.session-item.is-active').click({ button: 'right' });
  await page.getByTestId('session-context-menu').getByRole('menuitem', { name: '取消置顶', exact: true }).click();
  await waitFor(async () => await page.locator('.session-item.is-active').evaluate((element) => !element.classList.contains('is-pinned') ? true : undefined));
  await page.getByTestId('titlebar-left-toggle').click();
  await page.locator('#chat-sidebar').waitFor({ state: 'hidden' });
  assert.equal(await page.getByTestId('titlebar-left-toggle').getAttribute('aria-pressed'), 'false');
  await page.getByTestId('titlebar-left-toggle').click();
  await page.locator('#chat-sidebar').waitFor();
  await page.getByTestId('titlebar-workspace-toggle').click();
  await page.locator('#conversation-workspace').waitFor({ state: 'hidden' });
  assert.equal(await page.getByTestId('titlebar-workspace-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.getByTestId('workspace-maximize-toggle').count(), 0, 'maximize action is hidden with the workspace');
  await page.getByTestId('titlebar-workspace-toggle').click();
  await page.locator('#conversation-workspace').waitFor();
  await page.getByTestId('sidebar-worktable').click();
  await page.getByTestId('worktable-placeholder').waitFor();
  assert.equal(await page.getByTestId('worktable-shell').count(), 0, 'legacy worktable renderer must stay removed');
  assert.equal(await page.locator('.workbench-sandbox-host, iframe.workbench-sandbox').count(), 0, 'legacy plugin panels must not mount');
  await page.getByTestId('worktable-return-chat').waitFor();
  await page.getByTestId('worktable-return-chat').click();
  await page.locator('.conversation-pane').waitFor();
  assert.equal(await page.getByTestId('titlebar-workspace-toggle').count(), 1, 'worktable left drawer returns directly to chat mode');
  await switchAppMode(page, '频道');
  assert.equal(await page.getByTestId('titlebar-left-toggle').count(), 0, 'channels mode must not show an inert conversation toggle');
  assert.equal(await page.getByTestId('titlebar-workspace-toggle').isHidden(), true, 'channels mode must not show an inert workspace toggle');
  await page.getByTestId('channels-return-chat').click();
  await page.locator('.conversation-pane').waitFor();
  await page.getByTestId('titlebar-workspace-toggle').waitFor();

  await page.setViewportSize({ width: 1100, height: 800 });
  const narrowWorkspace = await page.locator('#conversation-workspace').evaluate((element) => ({
    position: getComputedStyle(element).position,
    closeDisplay: getComputedStyle(element.querySelector('.workspace-mobile-close')).display,
    borderRadius: getComputedStyle(element).borderRadius,
    boxShadow: getComputedStyle(element).boxShadow,
  }));
  assert.equal(narrowWorkspace.position, 'fixed');
  assert.notEqual(narrowWorkspace.closeDisplay, 'none');
  assert.notEqual(narrowWorkspace.borderRadius, '0px', 'overlay workbench keeps a contained drawer shape');
  assert.notEqual(narrowWorkspace.boxShadow, 'none', 'overlay workbench remains visually elevated');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '1100px layout must not overflow horizontally');
  await page.locator('#conversation-workspace .workspace-mobile-close').click();
  await page.locator('#conversation-workspace').waitFor({ state: 'hidden' });
  await page.getByTestId('titlebar-workspace-toggle').click();
  await page.locator('#conversation-workspace').waitFor();

  await page.setViewportSize({ width: 920, height: 700 });
  await page.locator('#conversation-workspace').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#chat-sidebar').count(), 1, 'compact layout initially keeps one drawer open');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '920px layout must not overflow horizontally');
  await page.getByTestId('chat-drawer-backdrop').click({ position: { x: 500, y: 400 } });
  await page.locator('#chat-sidebar').waitFor({ state: 'hidden' });
  await page.getByTestId('titlebar-workspace-toggle').click();
  await page.locator('#conversation-workspace').waitFor();
  await page.locator('#chat-sidebar').waitFor({ state: 'hidden' });
  await page.getByTestId('chat-drawer-backdrop').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#conversation-workspace').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'titlebar-workspace-toggle', 'Escape restores focus to the workspace toggle');
  await page.getByTestId('titlebar-left-toggle').click();
  await page.locator('#chat-sidebar').waitFor();
  await page.getByTestId('chat-drawer-backdrop').click({ position: { x: 500, y: 400 } });
  await page.locator('#chat-sidebar').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'titlebar-left-toggle', 'backdrop close restores focus to the conversation toggle');
  await page.getByTestId('titlebar-left-toggle').click();
  await page.locator('#chat-sidebar').waitFor();
  await page.setViewportSize({ width: 1480, height: 940 });
  await waitFor(async () => await page.locator('.chat-workspace').evaluate((element) => element.classList.contains('is-wide-layout') ? true : undefined));
  await page.getByTestId('titlebar-workspace-toggle').click();
  await page.locator('#conversation-workspace').waitFor();
  await page.getByTestId('workspace-panel-launcher').waitFor();
  assert.equal(await page.locator('.workspace-panel-launcher__options > button').count(), 3, 'workspace opens on the GPT-like panel chooser');
  assert.equal(await page.getByTestId('workspace-active-panel').count(), 0, 'no workspace status tab renders before a panel is selected');
  assert.equal(await page.getByTestId('conversation-open-project').count(), 1, 'a conversation with an explicit project folder keeps the single Open action');
  assert.equal(await page.getByTestId('conversation-open-project').getAttribute('title'), '使用系统文件管理器打开项目');
  assert.equal(await page.locator('#conversation-workspace .workspace-open-project').count(), 0, 'workspace panel does not repeat the Open action');
  await page.getByTestId('workspace-maximize-toggle').waitFor();
  await page.getByTestId('workspace-maximize-toggle').click();
  const maximizedWorkspace = await waitFor(async () => await page.evaluate(() => {
    const sidebar = document.querySelector('#chat-sidebar');
    const conversation = document.querySelector('.conversation-pane');
    const workspace = document.querySelector('#conversation-workspace');
    if (!(sidebar instanceof HTMLElement) || !(conversation instanceof HTMLElement) || !(workspace instanceof HTMLElement)) return undefined;
    const sidebarRect = sidebar.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    const result = {
      conversationVisibility: getComputedStyle(conversation).visibility,
      workspaceLeft: workspaceRect.left,
      workspaceRight: workspaceRect.right,
      sidebarRight: sidebarRect.right,
      viewportRight: window.innerWidth,
    };
    return result.conversationVisibility === 'hidden'
      && Math.abs(result.workspaceLeft - result.sidebarRight) <= 1
      && Math.abs(result.workspaceRight - result.viewportRight) <= 1
      ? result
      : undefined;
  }));
  assert.equal(maximizedWorkspace.conversationVisibility, 'hidden', 'maximized workspace replaces the conversation canvas');
  assert.ok(Math.abs(maximizedWorkspace.workspaceLeft - maximizedWorkspace.sidebarRight) <= 1, 'maximized workspace starts beside the left rail');
  assert.ok(Math.abs(maximizedWorkspace.workspaceRight - maximizedWorkspace.viewportRight) <= 1, 'maximized workspace reaches the right window edge');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'chat-workspace-maximized-packaged.png' : 'chat-workspace-maximized.png') });
  await page.getByTestId('workspace-maximize-toggle').click();
  await waitFor(async () => await page.locator('.chat-workspace').evaluate((element) => !element.classList.contains('is-workspace-maximized') ? true : undefined));
  await page.locator('.conversation-pane').waitFor();
  const launcherAlignment = await page.evaluate(() => {
    const workspace = document.querySelector('#conversation-workspace');
    const options = document.querySelector('.workspace-panel-launcher__options');
    if (!(workspace instanceof HTMLElement) || !(options instanceof HTMLElement)) throw new Error('missing workspace launcher');
    const panel = workspace.getBoundingClientRect();
    const group = options.getBoundingClientRect();
    return { panelCenter: panel.top + panel.height / 2, groupCenter: group.top + group.height / 2 };
  });
  assert.ok(Math.abs(launcherAlignment.panelCenter - launcherAlignment.groupCenter) <= 2, 'workspace choices stay at the geometric center of the rail');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'chat-workspace-launcher-packaged.png' : 'chat-workspace-launcher.png') });
  await page.getByTestId('workspace-panel-option-workspace').click();
  await page.getByTestId('workspace-active-panel').waitFor();
  assert.equal((await page.getByTestId('workspace-active-panel').innerText()).includes('工作区'), true, '右侧文件面板使用“工作区”名称，不与独立工作台混淆');
  await page.locator('.workspace-browser').waitFor();
  assert.equal(await page.getByTestId('workspace-panel-launcher').count(), 0, 'choosing a panel replaces the launcher with its status view');
  await waitFor(async () => await page.evaluate(() => {
    const conversation = document.querySelector('.conversation-pane');
    const workspace = document.querySelector('#conversation-workspace');
    if (!(conversation instanceof HTMLElement) || !(workspace instanceof HTMLElement)) return undefined;
    return Math.abs(conversation.getBoundingClientRect().right - workspace.getBoundingClientRect().left) <= 1 ? true : undefined;
  }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '1480px layout must not overflow horizontally');
  const dockedChatShell = await page.evaluate(() => {
    const conversation = document.querySelector('.conversation-pane');
    const workspace = document.querySelector('#conversation-workspace');
    if (!(conversation instanceof HTMLElement) || !(workspace instanceof HTMLElement)) throw new Error('missing docked chat surfaces');
    const conversationRect = conversation.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    const conversationStyle = getComputedStyle(conversation);
    const workspaceStyle = getComputedStyle(workspace);
    const seamStyle = getComputedStyle(workspace, '::before');
    const workspaceHeader = workspace.querySelector('.conversation-workspace__header');
    const workspaceToolbar = workspace.querySelector('.workspace-file-toolbar');
    const workspaceRoots = workspace.querySelector('.workspace-root-strip');
    if (!(workspaceHeader instanceof HTMLElement) || !(workspaceToolbar instanceof HTMLElement) || !(workspaceRoots instanceof HTMLElement)) throw new Error('missing workspace chrome');
    return {
      conversation: { top: conversationRect.top, right: conversationRect.right, bottom: conversationRect.bottom },
      workspace: { top: workspaceRect.top, left: workspaceRect.left, bottom: workspaceRect.bottom },
      conversationRadius: conversationStyle.borderTopLeftRadius,
      conversationBorder: conversationStyle.borderTopWidth,
      workspaceBorderLeft: workspaceStyle.borderLeftWidth,
      workspaceBorderTop: workspaceStyle.borderTopWidth,
      workspaceRadius: workspaceStyle.borderTopRightRadius,
      workspaceShadow: workspaceStyle.boxShadow,
      conversationBackground: conversationStyle.backgroundColor,
      workspaceBackground: workspaceStyle.backgroundColor,
      seamBackground: seamStyle.backgroundImage,
      workspaceHeaderBorder: getComputedStyle(workspaceHeader).borderBottomWidth,
      workspaceTabs: workspace.querySelector('.workspace-tabs') !== null,
      workspaceToolbarBorder: getComputedStyle(workspaceToolbar).borderBottomWidth,
      workspaceRootsBorder: getComputedStyle(workspaceRoots).borderBottomWidth,
      viewport: { height: window.innerHeight, width: window.innerWidth },
      workspaceRight: workspaceRect.right,
    };
  });
  assert.notEqual(dockedChatShell.conversationRadius, '0px', 'main conversation keeps a Codex-like content-sheet radius');
  assert.equal(dockedChatShell.conversationBorder, '0px', 'main conversation must not use an outer card border');
  assert.equal(dockedChatShell.workspaceBorderLeft, '0px', 'docked workbench must not use a hard left border');
  assert.equal(dockedChatShell.workspaceBorderTop, '0px', 'docked workbench must not use an outer border');
  assert.equal(dockedChatShell.workspaceRadius, '0px', 'docked workbench must not use an outer card radius');
  assert.equal(dockedChatShell.workspaceShadow, 'none', 'docked workbench must not look like a floating card');
  assert.equal(dockedChatShell.workspaceBackground, dockedChatShell.conversationBackground, 'conversation and docked workbench share one canvas color');
  assert.deepEqual({ header: dockedChatShell.workspaceHeaderBorder, tabs: dockedChatShell.workspaceTabs, toolbar: dockedChatShell.workspaceToolbarBorder, roots: dockedChatShell.workspaceRootsBorder }, { header: '0px', tabs: false, toolbar: '0px', roots: '0px' }, 'workspace chrome uses whitespace instead of horizontal rules');
  assert.match(dockedChatShell.seamBackground, /linear-gradient/u, 'docked workbench uses a faded seam');
  assert.ok(Math.abs(dockedChatShell.conversation.top - dockedChatShell.workspace.top) <= 1, 'docked surfaces align at the top');
  assert.ok(Math.abs(dockedChatShell.conversation.bottom - dockedChatShell.workspace.bottom) <= 1, 'docked surfaces align at the bottom');
  assert.ok(Math.abs(dockedChatShell.conversation.right - dockedChatShell.workspace.left) <= 1, 'docked surfaces share one continuous edge');
  assert.ok(Math.abs(dockedChatShell.workspace.bottom - dockedChatShell.viewport.height) <= 1, 'docked surfaces reach the bottom edge without an outer gap');
  assert.ok(Math.abs(dockedChatShell.workspaceRight - dockedChatShell.viewport.width) <= 1, 'docked workbench reaches the window edge without an outer gap');
  const readingWidth = await page.evaluate(() => {
    const pane = document.querySelector('.conversation-pane');
    const timeline = document.querySelector('.app-mode-chat .timeline');
    const composer = document.querySelector('.app-mode-chat .composer');
    if (!(pane instanceof HTMLElement) || !(timeline instanceof HTMLElement) || !(composer instanceof HTMLElement)) throw new Error('missing conversation reading surfaces');
    const paneRect = pane.getBoundingClientRect();
    const timelineRect = timeline.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    return {
      timelineLeftGap: timelineRect.left - paneRect.left,
      timelineRightGap: paneRect.right - timelineRect.right,
      composerLeftGap: composerRect.left - paneRect.left,
      composerRightGap: paneRect.right - composerRect.right,
    };
  });
  assert.ok(Math.max(readingWidth.timelineLeftGap, readingWidth.timelineRightGap, readingWidth.composerLeftGap, readingWidth.composerRightGap) <= 32, 'timeline and composer stay wide and close to the conversation edges');
  const note = page.locator('.workspace-note');
  if (await note.evaluate((element) => element.classList.contains('is-open'))) await note.locator('.workspace-note__toggle').click();
  const collapsedGoalArrow = await note.locator('.workspace-note__heading svg').evaluate((element) => getComputedStyle(element).transform);
  await note.locator('.workspace-note__heading').click();
  const expandedGoalLayout = await note.evaluate((element) => {
    const toggle = element.querySelector('.workspace-note__toggle');
    const heading = element.querySelector('.workspace-note__heading');
    if (!(toggle instanceof HTMLElement) || !(heading instanceof HTMLElement)) throw new Error('missing expanded goal controls');
    const panel = element.getBoundingClientRect();
    const button = toggle.getBoundingClientRect();
    const title = heading.getBoundingClientRect();
    return { buttonBottomGap: panel.bottom - button.bottom, titleTopGap: title.top - panel.top, arrow: getComputedStyle(toggle.querySelector('svg')).transform };
  });
  assert.ok(expandedGoalLayout.buttonBottomGap <= 9, 'expanded goal collapse button stays pinned to the bottom');
  assert.ok(expandedGoalLayout.titleTopGap <= 1, 'expanded goal title stays at the top');
  assert.notEqual(collapsedGoalArrow, expandedGoalLayout.arrow, 'goal arrow reverses between collapsed and expanded states');
  await note.locator('.workspace-note__toggle').click();
  const conversationSummary = page.locator('.conversation-summary');
  const collapsedSummaryArrow = await conversationSummary.locator('header button:last-child svg').evaluate((element) => getComputedStyle(element).transform);
  await conversationSummary.locator('header button:last-child').click();
  const expandedSummaryArrow = await waitFor(async () => {
    const toggle = conversationSummary.locator('header button:last-child');
    if (await toggle.getAttribute('aria-expanded') !== 'true') return undefined;
    const transform = await toggle.locator('svg').evaluate((element) => getComputedStyle(element).transform);
    return transform !== collapsedSummaryArrow ? transform : undefined;
  });
  assert.notEqual(collapsedSummaryArrow, expandedSummaryArrow, 'conversation summary arrow reverses while its control remains in the top header');
  await conversationSummary.locator('header button:last-child').click();
  await page.screenshot({ path: join(artifactRoot, packaged ? 'chat-docked-workspace-packaged.png' : 'chat-docked-workspace.png') });

  await runtimeJson(page, `/api/sessions/${encodeURIComponent(roleLibrary.activeSessionId)}/agents`, {
    leadAgentId: roleLibrary.agentDefinitions[0].id,
    memberAgentIds: persistentMemberIds,
  }, 'PUT');
  assert.equal(await page.getByTestId('session-team-trigger').count(), 0, 'the redundant conversation-header Agent configuration entry is removed');
  assert.equal(await page.locator('.session-agent-popover').count(), 0, 'the redundant session-member popover is removed');
  const topRail = await page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`missing top rail element: ${selector}`);
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    return {
      header: box('[data-testid="conversation-header"]'),
      meta: box('[data-testid="conversation-header-meta"]'),
      actions: box('[data-testid="conversation-header-actions"]'),
    };
  });
  const overlaps = (left, right) => left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
  assert.equal(overlaps(topRail.meta, topRail.actions), false, 'conversation title/status must not overlap header actions');
  assert.ok(topRail.header.height <= 48, 'the combined top rail must remain compact');
  await page.getByTestId('conversation-header').screenshot({ path: join(artifactRoot, packaged ? 'conversation-header-packaged.png' : 'conversation-header.png') });
  const pinnedMemory = await runtimeJson(page, `/api/agents/${encodeURIComponent(roleLibrary.agentDefinitions[0].id)}/memories`, {
    scope: 'project', content: 'E2E pinned memory keeps provenance explicit.', sourceEventIds: [],
  });
  assert.equal(pinnedMemory.kind, 'pinned');
  await runtimeJson(page, `/api/agents/${encodeURIComponent(roleLibrary.agentDefinitions[0].id)}`, {
    memoryPolicy: { memoryEnabled: true, experienceEnabled: true },
  }, 'PATCH');
  await runtimeJson(page, `/api/agents/${encodeURIComponent(roleLibrary.agentDefinitions[0].id)}/tool-policy`, {
    ...roleLibrary.agentDefinitions[0].toolPolicy,
    enabledCapabilityIds: roleLibrary.agentDefinitions[0].toolPolicy.enabledCapabilityIds,
    revision: roleLibrary.agentDefinitions[0].toolPolicy.revision + 1,
  }, 'PUT');
  await runtimeJson(page, `/api/sessions/${encodeURIComponent(roleLibrary.activeSessionId)}/refresh-tools`, {});

  const dragRegions = await page.evaluate(() => {
    const appRegion = (selector) => getComputedStyle(document.querySelector(selector)).webkitAppRegion;
    return {
      bar: appRegion('.titlebar'),
      center: appRegion('.titlebar__drag-region'),
      menus: appRegion('.titlebar__menus'),
      leftButton: appRegion('.titlebar-left-toggle'),
      workspaceButton: appRegion('.conversation-workspace-toggle'),
      windowButton: appRegion('.window-controls button'),
    };
  });
  assert.deepEqual(dragRegions, {
    bar: 'drag', center: 'drag', menus: 'no-drag', leftButton: 'no-drag', workspaceButton: 'no-drag', windowButton: 'no-drag',
  });
  const windowControlColors = await page.locator('.window-controls button').evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).color));
  assert.equal(new Set(windowControlColors).size, 1, 'window controls use one resting foreground color');
  const windowControlGeometry = await page.evaluate(() => {
    const titlebar = document.querySelector('.titlebar');
    const buttons = [...document.querySelectorAll('.window-controls button')];
    if (!(titlebar instanceof HTMLElement) || buttons.some((button) => !(button instanceof HTMLElement))) throw new Error('missing custom window controls');
    const titlebarBox = titlebar.getBoundingClientRect();
    return {
      titlebarHeight: titlebarBox.height,
      buttons: buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { width: box.width, height: box.height, centerOffset: Math.abs((box.top + box.height / 2) - (titlebarBox.top + titlebarBox.height / 2)) };
      }),
    };
  });
  assert.equal(Math.abs(windowControlGeometry.titlebarHeight - 42) < .01, true, 'custom titlebar retains the GPT-like 42px height');
  assert.equal(windowControlGeometry.buttons.every((button) => Math.abs(button.width - 54) < .01), true, 'all three GPT-like window buttons use equal hit areas');
  assert.equal(windowControlGeometry.buttons.every((button) => Math.abs(button.height - 42) < .01 && button.centerOffset < .5), true, 'all window buttons share the titlebar height and optical center');
  const windowControlChrome = await page.evaluate(() => {
    const titlebar = document.querySelector('.titlebar');
    const controls = document.querySelector('.window-controls');
    if (!(titlebar instanceof HTMLElement) || !(controls instanceof HTMLElement)) throw new Error('missing window chrome');
    return { titlebar: getComputedStyle(titlebar).backgroundColor, controls: getComputedStyle(controls).backgroundColor };
  });
  assert.equal(windowControlChrome.controls, windowControlChrome.titlebar, 'window controls share the titlebar background color');

  const modelPicker = page.getByTestId('model-picker');
  await modelPicker.click();
  const modelMenu = page.getByTestId('model-picker-menu');
  await modelMenu.waitFor();
  assert.equal(await modelMenu.getByRole('group', { name: 'DEEPSEEK' }).count(), 1);
  assert.equal(await modelMenu.getByRole('option').count(), 2);
  assert.equal(await modelMenu.getByRole('option', { selected: true }).getAttribute('data-model-id'), 'deepseek::deepseek-v4-pro');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'model-picker-packaged.png' : 'model-picker.png') });
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-model-id')), 'deepseek::deepseek-v4-flash');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-model-id')), 'deepseek::deepseek-v4-pro');
  await page.keyboard.press('Escape');
  await modelMenu.waitFor({ state: 'detached' });
  assert.equal(await modelPicker.getAttribute('aria-expanded'), 'false');

  const reasoningPicker = page.getByTestId('reasoning-picker');
  const reasoningBounds = await reasoningPicker.boundingBox();
  const modelBounds = await modelPicker.boundingBox();
  assert.ok(reasoningBounds && modelBounds && reasoningBounds.x < modelBounds.x, 'reasoning control must sit immediately before the model picker');
  await reasoningPicker.click();
  const reasoningMenu = page.getByTestId('reasoning-picker-menu');
  await reasoningMenu.waitFor();
  assert.deepEqual(await reasoningMenu.getByRole('option').evaluateAll((options) => options.map((option) => option.getAttribute('data-effort'))), ['none', 'high', 'max']);
  assert.equal(await reasoningMenu.getByRole('option', { selected: true }).getAttribute('data-effort'), 'high');
  const reasoningMenuBounds = await reasoningMenu.boundingBox();
  assert.ok(reasoningMenuBounds && reasoningBounds && reasoningMenuBounds.y + reasoningMenuBounds.height <= reasoningBounds.y, 'reasoning menu must open above its trigger');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'reasoning-picker-packaged.png' : 'reasoning-picker.png') });
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-effort')), 'max');
  await page.keyboard.press('Escape');
  await reasoningMenu.waitFor({ state: 'detached' });
  assert.equal(await reasoningPicker.getAttribute('aria-expanded'), 'false');

  const beforeLazyConversation = await snapshot(page);
  await page.getByTestId('new-conversation').click();
  await page.locator('.app-mode-chat .empty-timeline').waitFor();
  await page.getByTestId('hana-draft-hero').waitFor();
  assert.equal(await page.getByTestId('draft-agent-selector').count(), 1, 'new conversation uses the HanaAgent-style Agent selector');
  const draftAgentOptions = page.getByTestId('draft-agent-option');
  assert.ok(await draftAgentOptions.count() >= 2, 'HanaAgent-style Agent choices are shown inline instead of in a dropdown');
  assert.equal(await page.getByTestId('draft-agent-menu').count(), 0, 'the Agent selector has no secondary dropdown');
  assert.equal(await page.locator('[data-testid="draft-agent-option"][aria-checked="true"]').count(), 1, 'exactly one inline Agent choice is active');
  const originalAgentName = (await page.locator('[data-testid="draft-agent-option"][aria-checked="true"]').innerText()).trim();
  const replacementAgent = page.locator('[data-testid="draft-agent-option"][aria-checked="false"]').first();
  const replacementAgentName = (await replacementAgent.innerText()).trim();
  await replacementAgent.click();
  assert.equal((await page.getByTestId('hana-draft-hero').getByRole('heading').innerText()).includes(replacementAgentName), true, 'clicking an inline Agent pill switches the draft Agent immediately');
  await draftAgentOptions.filter({ hasText: originalAgentName }).first().click();
  assert.equal((await page.getByTestId('draft-memory-status').innerText()).includes('记忆'), true, 'new conversation displays the active Agent memory policy');
  assert.equal(await page.locator('.conversation-pane.is-draft-conversation').count(), 1, 'new conversation activates the elevated HanaAgent composer layout');
  assert.equal(await page.getByTestId('composer-project-context').count(), 1, 'the GPT-like context rail remains above the draft composer');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'hana-draft-packaged.png' : 'hana-draft.png') });
  const draftProjectSelector = page.getByTestId('draft-project-selector');
  await draftProjectSelector.waitFor();
  assert.equal((await draftProjectSelector.innerText()).includes('在哪个项目中工作'), true, 'new-conversation project selector uses the requested wording');
  const expectedDraftFolder = beforeLazyConversation.project.rootPath.replace(/[\\/]+$/u, '').split(/[\\/]/u).filter(Boolean).at(-1) || beforeLazyConversation.project.name;
  assert.equal((await draftProjectSelector.innerText()).includes(expectedDraftFolder), true, 'new-conversation project selector identifies the current working folder');
  await draftProjectSelector.click();
  const createProjectDialog = page.getByTestId('create-project-dialog');
  await createProjectDialog.waitFor();
  assert.equal(await createProjectDialog.getByRole('heading', { name: '创建项目' }).count(), 1, 'project selection opens the ChatGPT-like create-project dialog');
  assert.equal(await page.getByTestId('create-project-name').getAttribute('placeholder'), '项目名称');
  assert.equal((await page.getByTestId('create-project-folder').innerText()).includes('添加 Sci Workplace 可读取和编辑的文件夹'), true);
  assert.equal(await page.getByTestId('create-project-confirm').isDisabled(), true, 'create remains disabled until a source folder is selected');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'create-project-packaged.png' : 'create-project.png') });
  await page.keyboard.press('Escape');
  await createProjectDialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.session-item.is-active').count(), 0, 'unsent draft conversation must not select or add a sidebar session');
  const unsentDraftSnapshot = await snapshot(page);
  assert.equal(unsentDraftSnapshot.sessions.length, beforeLazyConversation.sessions.length, 'clicking New conversation must not create runtime data');
  assert.equal(unsentDraftSnapshot.activeSessionId, beforeLazyConversation.activeSessionId, 'an unsent draft leaves the runtime session untouched');
  assert.equal(await page.getByTestId('fork-session').isDisabled(), true, 'draft conversation cannot be forked before its first message');

  await sendScenario(page, 'E2E_BASIC');
  await page.getByText('E2E_BASIC_DONE', { exact: true }).waitFor();
  await waitTurnIdle(page);

  const basicSnapshot = await snapshot(page);
  assert.equal(basicSnapshot.sessions.length, beforeLazyConversation.sessions.length + 1, 'the first sent message creates exactly one session');
  assert.notEqual(basicSnapshot.activeSessionId, beforeLazyConversation.activeSessionId, 'the newly created session becomes active after first send');
  const basicVariants = basicSnapshot.turnVariants.at(-1);
  assert.ok(basicVariants, 'the first completed answer must have a variant group');
  const originalBasicVariantId = basicVariants.activeVariantId;
  await runtimeJson(page, '/api/chat/regenerate', { turnId: basicVariants.turnId });
  const regeneratedSnapshot = await waitFor(async () => {
    const state = await snapshot(page);
    const group = state.turnVariants.find((item) => item.turnId === basicVariants.turnId);
    const session = state.sessions.find((item) => item.id === state.activeSessionId);
    return group?.variants.length === 2 && session?.status !== 'running' ? state : undefined;
  });
  const regeneratedGroup = regeneratedSnapshot.turnVariants.find((item) => item.turnId === basicVariants.turnId);
  assert.equal(regeneratedGroup.variants.length, 2);
  assert.equal(await page.locator('.assistant-message', { hasText: 'E2E_BASIC_DONE' }).count(), 1, 'only the active answer variant should render');
  await runtimeJson(page, `/api/turns/${encodeURIComponent(basicVariants.turnId)}/variants/${encodeURIComponent(originalBasicVariantId)}/activate`, {});

  const authorizedRoot = await runtimeJson(page, '/api/workspace/roots', { path: externalRoot, access: 'ask', confirmed: true });
  assert.equal(authorizedRoot.kind, 'authorized');
  await runtimeJson(page, '/api/workspace/note', { note: 'E2E session note: keep provenance explicit.' });
  const createdWorkspaceFile = await runtimeJson(page, '/api/workspace/files/operate', {
    operation: { type: 'create_file', target: { rootId: authorizedRoot.id, path: 'workspace-e2e.md' }, content: '# Workspace E2E\nrestorable' },
  });
  const preview = await runtimeJson(page, '/api/workspace/preview', { rootId: authorizedRoot.id, path: 'workspace-e2e.md' });
  assert.equal(preview.kind, 'text');
  await runtimeJson(page, '/api/workspace/conversation-files', { ref: { rootId: authorizedRoot.id, path: 'workspace-e2e.md' }, origin: 'reference' });
  const deletedWorkspaceFile = await runtimeJson(page, '/api/workspace/files/operate', {
    operation: { type: 'delete', target: { rootId: authorizedRoot.id, path: 'workspace-e2e.md' }, confirmed: true }, confirmed: true,
  });
  assert.equal(existsSync(join(externalRoot, 'workspace-e2e.md')), false);
  await runtimeJson(page, `/api/workspace/files/${encodeURIComponent(deletedWorkspaceFile.id)}/undo`, {});
  assert.equal(readFileSync(join(externalRoot, 'workspace-e2e.md'), 'utf8'), '# Workspace E2E\nrestorable');
  assert.equal(typeof createdWorkspaceFile.id, 'string');
  const workspaceState = await snapshot(page);
  assert.equal(workspaceState.workspace.note, 'E2E session note: keep provenance explicit.');
  assert.equal(workspaceState.conversationFiles.some((item) => item.ref.rootId === authorizedRoot.id && item.ref.path === 'workspace-e2e.md'), true);

  await sendScenario(page, 'E2E_WRITE_UNDO');
  await approveNext(page);
  await approveNext(page);
  await page.getByText('E2E_WRITE_UNDO_DONE', { exact: true }).waitFor();
  await waitTurnIdle(page);
  assert.equal(existsSync(join(projectRoot, 'e2e-change.txt')), false, 'undo must restore the pre-write state');

  await sendScenario(page, 'E2E_MULTI');
  await approveNext(page);
  await approveNext(page);
  await approveNext(page);
  await page.getByText('E2E_MULTI_DONE', { exact: true }).waitFor({ timeout: 60_000 });
  await waitTurnIdle(page);
  await waitFor(async () => {
    const state = await snapshot(page);
    return state.tasks.length === 3 && state.tasks.every((task) => task.status === 'completed') && state.channels.filter((channel) => channel.kind === 'private').length >= 3;
  }, 60_000);

  const beforeFork = await snapshot(page);
  assert.equal(beforeFork.plugins.length, 0, 'retired plugins must not be loaded');
  assert.equal(beforeFork.contextPlan.lastModelRun?.usage.cacheHitTokens, 800);
  assert.equal(beforeFork.sessions.find((session) => session.id === beforeFork.activeSessionId)?.model, 'deepseek::deepseek-v4-pro');

  const semanticVisuals = await page.evaluate(() => {
    const background = (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`missing semantic visual: ${selector}`);
      return getComputedStyle(element).backgroundColor;
    };
    return {
      toolIcon: background('.compact-card-icon'),
      readOnlyStatus: background('.node-status'),
      sessionIconCount: document.querySelectorAll('.session-item__icon').length,
      avatar: (() => {
        const element = document.querySelector('.agent-avatar-visual:not([data-avatar="custom"])');
        if (!element) throw new Error('missing built-in Agent avatar');
        const style = getComputedStyle(element);
        return `${style.backgroundColor}|${style.backgroundImage}`;
      })(),
    };
  });
  assert.equal(semanticVisuals.sessionIconCount, 0, 'ChatGPT-like session rows stay flat and text-first');
  for (const [name, background] of Object.entries(semanticVisuals).filter(([name]) => !['avatar', 'sessionIconCount'].includes(name))) {
    assert.equal(background, 'rgba(0, 0, 0, 0)', `${name} must use a transparent background`);
  }
  assert.notEqual(semanticVisuals.avatar, 'rgba(0, 0, 0, 0)|none', 'Agent avatars must retain their background');

  for (const themeId of ['warm-paper', 'cyan-night', 'cyan-night-contrast', 'coral-paper']) {
    await page.getByTestId('sidebar-profile-trigger').click();
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-modal').waitFor();
    await page.getByTestId('settings-page-interface').click();
    await page.getByTestId(`theme-card-${themeId}`).click();
    await page.waitForFunction((selected) => document.documentElement.dataset.themeSelection === selected, themeId);
    await page.getByTestId('settings-close').click();
    await page.screenshot({ path: join(artifactRoot, `semantic-${themeId}${packaged ? '-packaged' : ''}.png`), fullPage: true });
  }

  await switchAppMode(page, '对话');
  await page.locator('.app-mode-chat [data-testid="composer-input"]').waitFor();

  await switchAppMode(page, '对话');
  await page.locator('.app-mode-chat [data-testid="fork-session"]').waitFor();

  await page.locator('.app-mode-chat [data-testid="fork-session"]').click();
  const forked = await waitFor(async () => {
    const state = await snapshot(page);
    return state.sessions.length >= 2 ? state : undefined;
  });
  const forkId = forked.activeSessionId;
  const forkTitle = forked.sessions.find((session) => session.id === forkId)?.title;
  assert.ok(forkTitle?.includes('分支'));
  assert.equal(forked.workspace.note, 'E2E session note: keep provenance explicit.');
  assert.equal(forked.workspace.roots.some((root) => root.id === authorizedRoot.id && root.status === 'pending_confirmation'), true, 'forked external roots must require confirmation');

  await page.locator('.session-item.is-active').getByTestId(`session-archive-${forkId}`).click();
  await waitFor(async () => (await snapshot(page)).sessions.find((session) => session.id === forkId)?.status === 'archived');
  await page.getByTestId('toggle-archived').click();
  await page.getByText(forkTitle, { exact: true }).waitFor();
  await page.locator('.session-item', { hasText: forkTitle }).locator('.session-item__main').click();
  await waitFor(async () => (await snapshot(page)).sessions.find((session) => session.id === forkId)?.status !== 'archived');
  await page.getByTestId('toggle-archived').click();

  const layoutBeforeRestart = await page.evaluate((projectId) => JSON.parse(localStorage.getItem(`openlab.chat-layout.v1:${encodeURIComponent(projectId)}`)), (await snapshot(page)).project.id);
  assert.equal(layoutBeforeRestart.rightWorkspaceOpen, true, 'workspace preference is committed before the application closes');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await firstApplication.close();
  firstApplication = undefined;

  const second = await launch();
  secondApplication = second.application;
  assert.equal(await secondApplication.evaluate(({ app }) => app.isHardwareAccelerationEnabled()), false, 'saved hardware acceleration setting must apply before Electron is ready');
  const restoredInterfacePreferences = await second.page.evaluate(async () => await window.openlab.getInterfacePreferences());
  assert.equal(restoredInterfacePreferences.theme, 'coral-paper');
  assert.equal(restoredInterfacePreferences.singleLineSessions, true);
  assert.equal(restoredInterfacePreferences.hardwareAcceleration, false);
  assert.equal(restoredInterfacePreferences.timeZone, 'Asia/Tokyo');
  assert.deepEqual(restoredInterfacePreferences.semanticPaletteOverrides, { 'coral-paper': { success: '#336699' } });
  assert.equal(await second.page.evaluate(() => document.documentElement.dataset.theme), 'coral-paper');
  assert.equal(await second.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--semantic-success').trim().toUpperCase()), '#336699');
  assert.equal(await second.page.evaluate(() => document.documentElement.dataset.sessionDensity), 'single');
  assert.equal(await second.page.getByTestId('primary-agent-onboarding').count(), 0, 'onboarding must not reappear after restart');
  await waitFor(async () => (await snapshot(second.page)).mode === 'connected' ? true : undefined);
  await second.page.getByText('E2E_MULTI_DONE', { exact: true }).waitFor();
  const restored = await snapshot(second.page);
  const restoredLayout = await second.page.evaluate((projectId) => JSON.parse(localStorage.getItem(`openlab.chat-layout.v1:${encodeURIComponent(projectId)}`)), restored.project.id);
  assert.equal(restoredLayout.schemaVersion, 1);
  assert.equal(restoredLayout.leftSidebarOpen, true);
  assert.equal(restoredLayout.rightWorkspaceOpen, true);
  assert.equal(restored.primaryAgent.configured, true);
  assert.equal(restored.primaryAgent.name, 'E2E 研究搭档');
  assert.ok(restored.primaryAgent.identity.includes('E2E_CUSTOM_IDENTITY'));
  assert.ok(restored.primaryAgent.instructions.includes('E2E_CUSTOM_ROLE'));
  assert.ok(restored.primaryAgent.avatar.startsWith('data:image/webp;base64,'));
  assert.ok(restored.agentDefinitions[0].avatar.startsWith('data:image/webp;base64,'));
  assert.equal(restored.agentDefinitions.length, 4);
  assert.equal(restored.agentDefinitions.filter((agent) => agent.status === 'active').length, 4);
  assert.equal(restored.sessionAgentBinding.memberAgentIds.length, 3);
  assert.equal(restored.sessions.length >= 2, true);
  assert.equal(restored.tasks.length, 3);
  assert.equal(restored.tasks.every((task) => task.status === 'completed'), true);
  assert.equal(restored.channels.filter((channel) => channel.kind === 'private').length >= 3, true);
  assert.equal(restored.memorySummaries.find((summary) => summary.agentId === restored.agentDefinitions[0].id)?.pinnedCount, 1);
  assert.equal(restored.plugins.length, 0, 'retired plugins must remain absent after restart');
  assert.equal(restored.timeline.some((node) => node.content === 'E2E_MULTI_DONE'), true);
  assert.equal(restored.workspace.note, 'E2E session note: keep provenance explicit.');
  assert.equal(restored.workspace.roots.some((root) => root.id === authorizedRoot.id && root.status === 'online'), true, 'the original session authorization must survive restart');
  assert.equal(restored.conversationFiles.some((item) => item.ref.rootId === authorizedRoot.id && item.ref.path === 'workspace-e2e.md'), true);

  await secondApplication.close();
  secondApplication = undefined;
  process.stdout.write(`Electron E2E passed. Screenshot: ${screenshotPath}\n`);
} catch (error) {
  const application = secondApplication ?? firstApplication;
  if (application) {
    try {
      const pages = application.windows();
      if (pages[0]) await pages[0].screenshot({ path: join(artifactRoot, 'sci-workplace-smoke-failure.png'), fullPage: true });
    } catch { /* preserve the original failure */ }
  }
  throw error;
} finally {
  await secondApplication?.close().catch(() => undefined);
  await firstApplication?.close().catch(() => undefined);
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (testRoot.startsWith(resolve(tmpdir()))) {
    // Electron, SQLite and Windows Defender can retain a just-closed handle for a
    // short interval. Let Node's Windows-aware recursive remover retry instead of
    // turning an otherwise successful desktop run into a cleanup-only failure.
    try { rmSync(testRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); }
    catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error;
      process.stderr.write(`[e2e cleanup] retained temporary directory: ${testRoot}\n`);
    }
  }
}
