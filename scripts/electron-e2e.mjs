import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
const additionalProjectRoot = join(testRoot, 'project-datasets');
const externalRoot = join(testRoot, 'external-workspace');
const userDataRoot = join(testRoot, 'user-data');

function createPdfFixture() {
  const stream = 'BT /F1 18 Tf 40 140 Td (PDF Preview) Tj 0 -28 Td /F1 11 Tf (Local rendering works.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}

mkdirSync(projectRoot, { recursive: true });
mkdirSync(join(projectRoot, 'research-notes'), { recursive: true });
mkdirSync(additionalProjectRoot, { recursive: true });
mkdirSync(externalRoot, { recursive: true });
mkdirSync(userDataRoot, { recursive: true });
mkdirSync(artifactRoot, { recursive: true });
writeFileSync(join(externalRoot, 'external-evidence.md'), '# External evidence\ntraceable', 'utf8');
writeFileSync(join(externalRoot, 'preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAwMDAxMDAwMAAAAQAAf8CBt0AAAAASUVORK5CYII=', 'base64'));
const pdfFixture = createPdfFixture();
writeFileSync(join(externalRoot, 'preview.pdf'), pdfFixture);
writeFileSync(join(projectRoot, 'e2e-paper.pdf'), pdfFixture);
writeFileSync(join(externalRoot, 'preview.docx'), Buffer.from('UEsDBBQAAAAIAJy7G133S4B1xgAAAHYBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QTU7DQAyFrxLNFnVcsWCBmm6ALbDgAtbESUaM7dHYLeH2KKV0gQrr9/M9vd3bZyXrFi5ifZjd6z2ApZkYLWolWbiM2hjdorYJKqZ3nAhut9s7SCpO4htfO8J+90gjHop3T4uTWFbpQ6NioXv4Nq6sPmCtJSf0rAJHGX5RNmdCbFROHptztZuFS4CrhFX5G3DOvRyptTxQ94rNn5GpD/ChbYBB04FJPP5fc2WnjmNOdMmvbbVpIrMsE5d4URiz/OyH0937L1BLAwQUAAAACACcuxtdYXsvQ4oAAADyAAAACwAAAF9yZWxzLy5yZWxzjc8xDgIhEAXQq5A5wM5qYWGAymZbsxcgMLsQgSGAcb29jcVqLGx/ft7Pl1eKpgfOzYfSxJZibgp87+WM2KynZNrAhfKW4sI1md4GrisWY29mJTyO4wnr3gAt96aYnII6uQOI+VnoH5uXJVi6sL0nyv3HxFcDxGzqSl3Bg6tD946HLUVALfHjon4BUEsDBBQAAAAIAJy7G11xvzBytAAAABABAAARAAAAd29yZC9kb2N1bWVudC54bWxtkDEPgjAQhf9Kww+g6ODQAIsODiaSOOha2xMb2x65Vgr/3gAGF5f3hvvu3cuVSWhUbwc+ssFZH0SqsmeMneA8qCc4GXLswA/OPpCcjCFHanlC0h2hghCMb53l26LYcSeNz+oyiTvqcfJuloZmu8TRAkuil7bKjiC18e0m43XJV2aWWF+RNGsIegNpmsaZoYVcc7/wCZW07HDe3xiB10DGtywhvUL+dzeAig0tZ5ee/PeD+gNQSwECFAAUAAAACACcuxtd90uAdcYAAAB2AQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAIAJy7G11hey9DigAAAPIAAAALAAAAAAAAAAAAAACAAfcAAABfcmVscy8ucmVsc1BLAQIUABQAAAAIAJy7G11xvzBytAAAABABAAARAAAAAAAAAAAAAACAAaoBAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAACNAgAAAAA=', 'base64'));
writeFileSync(join(additionalProjectRoot, 'dataset-notes.md'), '# Bound dataset folder\nproject-wide', 'utf8');
writeFileSync(join(projectRoot, 'research-notes', 'overview.md'), '# Recognized project note\nvisible in the workspace tree', 'utf8');

let callSequence = 0;
let persistentMemberIds = [];
const rendererConsoleErrors = [];

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

async function sendText(response, text, reasoning = '正在核对可回放状态。', reasoningPauseMs = 8) {
  beginSse(response);
  frame(response, { choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }] });
  await pause(reasoningPauseMs);
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
  if (userText.includes('E2E_PERMISSION_READ_ONLY')) {
    assert.equal(tools.some((tool) => tool.function?.name === 'read_file'), true, 'read-only requests retain read tools');
    assert.equal(tools.some((tool) => ['write_file', 'run_terminal', 'install_plugin', 'install_skill'].includes(tool.function?.name)), false, 'read-only requests do not expose mutating tools');
    await sendText(response, 'E2E_BASIC_DONE');
    return;
  }
  if (userText.includes('E2E_THINKING_UI')) {
    await sendText(response, 'E2E_THINKING_UI_DONE', '正在验证思考区视觉层级。', 1_200);
    return;
  }
  if (userText.includes('E2E_TOOL_BATCH')) {
    const batchResults = messages.filter((message) => message.role === 'tool' && jsonContent(message.content).includes('tool="list_files"'));
    if (batchResults.length < 2) {
      await sendToolCalls(response, [
        { name: 'list_files', arguments: { path: '.' } },
        { name: 'list_files', arguments: { path: '.' } },
      ]);
      return;
    }
    await sendText(response, 'E2E_TOOL_BATCH_DONE');
    return;
  }
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
    rendererConsoleErrors.push(message.text());
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
  if (label === '频道') {
    await page.getByTestId('sidebar-channels').click();
    return;
  }
  if (label === '工作台') {
    await page.getByTestId('sidebar-worktable').click();
    return;
  }
  if (label === '对话') {
    const channelsReturn = page.getByTestId('channels-return-chat');
    if (await channelsReturn.isVisible().catch(() => false)) await channelsReturn.click();
    const worktableReturn = page.getByTestId('worktable-return-chat');
    if (await worktableReturn.isVisible().catch(() => false)) await worktableReturn.click();
  }
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
  if (packaged) {
    const readerRuntime = freshSnapshot.toolchains.find((toolchain) => toolchain.id === 'openlab.reader-runtime');
    assert.ok(readerRuntime, 'packaged app must register the bundled offline Reader Runtime');
    assert.equal(readerRuntime.status, 'available');
    assert.equal(readerRuntime.source, 'bundled');
    assert.equal(readerRuntime.workerVersion, '0.2.19');
    assert.equal(readerRuntime.capabilities.includes('pdf-inspect'), true);
    assert.equal(readerRuntime.capabilities.includes('docling-structure'), true);
  }
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
  assert.equal(namedSnapshot.sessionCatalog.length, 0, 'first Agent setup must not persist an automatic conversation');
  assert.equal(namedSnapshot.sessions.filter((session) => !session.temporary).length, 0, 'the runtime may keep only a transient internal session before the user creates a conversation');
  await page.locator('.conversation-pane.is-draft-conversation').waitFor();
  assert.equal(await page.locator('.session-item').count(), 0, 'the sidebar stays empty after first Agent setup');
  await page.getByTestId('new-conversation').click();
  assert.equal((await snapshot(page)).sessionCatalog.length, 0, 'opening the composer draft alone must not create a persisted conversation');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'first-agent-empty-draft-packaged.png' : 'first-agent-empty-draft.png') });

  // Seed one explicitly-created empty conversation for the rest of the broad UI
  // suite. The first-run assertions above have already verified the production UX.
  const seededSession = await runtimeJson(page, '/api/sessions', {
    title: 'E2E 用户创建会话',
    leadAgentId: namedSnapshot.agentDefinitions[0].id,
    memberAgentIds: [],
    temporary: false,
  });
  await page.getByTestId('refresh-snapshot').click();
  const seededSessionItem = page.locator(`[data-session-id="${seededSession.id}"] .session-item__main`);
  await seededSessionItem.waitFor();
  await seededSessionItem.click();
  await page.locator('.conversation-pane.is-draft-conversation').waitFor({ state: 'detached' });

  await page.getByTestId('sidebar-profile-trigger').click();
  assert.equal((await page.getByTestId('sidebar-profile-trigger').locator('.sidebar-profile-name').innerText()).trim(), '用户', 'left profile strip shows only the user name');
  assert.equal(await page.locator('.sidebar-help-button').count(), 0, 'the unused help icon is removed from the profile strip');
  assert.equal(await page.locator('.sidebar-profile-runtime, .titlebar-runtime-row').count(), 0, 'local Runtime connection status stays in the background');
  assert.deepEqual(await page.getByTestId('sidebar-profile-menu').getByRole('menuitem').allTextContents(), ['设置Ctrl+,'], 'the compact profile popup temporarily contains Settings only');
  const footerProfileGeometry = await page.getByTestId('sidebar-profile-trigger').evaluate((trigger) => {
    const avatar = trigger.querySelector('.sidebar-profile-avatar');
    const name = trigger.querySelector('.sidebar-profile-name');
    if (!(avatar instanceof HTMLElement) || !(name instanceof HTMLElement)) throw new Error('missing user footer profile');
    const avatarBox = avatar.getBoundingClientRect();
    const nameStyle = getComputedStyle(name);
    return { triggerHeight: Math.round(trigger.getBoundingClientRect().height), footerHeight: Math.round(trigger.closest('footer')?.getBoundingClientRect().height ?? 0), avatarSize: Math.round(avatarBox.width), fontSize: Number.parseFloat(nameStyle.fontSize), fontWeight: Number.parseInt(nameStyle.fontWeight, 10) };
  });
  assert.deepEqual(footerProfileGeometry, { triggerHeight: 34, footerHeight: 40, avatarSize: 26, fontSize: 13, fontWeight: 400 }, 'footer uses the smaller ChatGPT-like avatar, name, and strip');
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-modal').waitFor();
  await page.getByTestId('settings-page-user').click();
  await page.getByTestId('settings-user-page').waitFor();
  assert.equal(await page.getByTestId('user-profile-name').inputValue(), '用户');
  await page.getByTestId('user-profile-name').fill('E2E 用户');
  await page.getByTestId('user-profile-text').fill('偏好先看结论与证据，请使用中文回答。');
  await page.getByTestId('user-profile-avatar-upload').setInputFiles({
    name: 'e2e-user-avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  });
  await page.locator('.user-settings__avatar img').waitFor();
  await page.getByTestId('user-profile-save').click();
  const userProfileSnapshot = await waitFor(async () => {
    const state = await snapshot(page);
    return state.userProfile?.name === 'E2E 用户' ? state : undefined;
  });
  assert.equal(userProfileSnapshot.userProfile.profile, '偏好先看结论与证据，请使用中文回答。');
  assert.ok(userProfileSnapshot.userProfile.avatar.startsWith('data:image/webp;base64,'), 'custom user avatar must be normalized and persisted');
  await page.waitForFunction(() => document.querySelector('[data-testid="sidebar-profile-trigger"] .sidebar-profile-name')?.textContent?.trim() === 'E2E 用户');
  assert.equal((await page.getByTestId('sidebar-profile-trigger').locator('.sidebar-profile-name').innerText()).trim(), 'E2E 用户', 'saved user name updates the footer immediately');
  assert.equal(await page.getByTestId('sidebar-profile-trigger').locator('img').count(), 1, 'saved user avatar updates the footer immediately');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'user-settings-packaged.png' : 'user-settings.png') });
  await page.getByTestId('settings-page-providers').click();
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
  const readingSizeControl = page.getByTestId('reading-size-control');
  await readingSizeControl.getByRole('button', { name: '-2', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--reading-body-size') === '9.5px');
  await readingSizeControl.getByRole('button', { name: '+2', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--reading-body-size') === '13.5px');
  await readingSizeControl.getByRole('button', { name: '0', exact: true }).click();
  const zeroFontAlignment = await page.evaluate(() => {
    const sessionTitle = document.querySelector('.session-item__copy strong');
    if (!(sessionTitle instanceof HTMLElement)) throw new Error('missing sidebar conversation title');
    return {
      readingSize: document.documentElement.style.getPropertyValue('--reading-body-size'),
      markdownSize: document.documentElement.style.getPropertyValue('--markdown-body-size'),
      markdownHeading1: document.documentElement.style.getPropertyValue('--markdown-h1-size'),
      markdownHeading2: document.documentElement.style.getPropertyValue('--markdown-h2-size'),
      markdownHeading3: document.documentElement.style.getPropertyValue('--markdown-h3-size'),
      sessionTitleSize: getComputedStyle(sessionTitle).fontSize,
    };
  });
  assert.deepEqual(zeroFontAlignment, {
    readingSize: '11.5px',
    markdownSize: '12px',
    markdownHeading1: '21px',
    markdownHeading2: '17px',
    markdownHeading3: '14px',
    sessionTitleSize: '11.5px',
  }, 'font size option 0 keeps sidebar alignment while Markdown body copy grows slightly and headings remain compact');
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

  await page.getByTestId('settings-page-providers').click();
  const darkProviderSurfaces = await page.evaluate(() => {
    const background = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor;
    const token = (name) => {
      const probe = document.createElement('i');
      probe.style.backgroundColor = `var(${name})`;
      document.body.append(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    };
    return {
      card: token('--card-bg'), soft: token('--card-soft'), input: token('--input-bg'),
      main: background('.provider-console > main'), list: background('.provider-list'),
      providerInput: background('.provider-input'), modelField: background('.provider-routing .model-picker--field'),
    };
  });
  assert.equal(darkProviderSurfaces.main, darkProviderSurfaces.card, 'provider detail follows the active card theme');
  assert.equal(darkProviderSurfaces.list, darkProviderSurfaces.soft, 'provider list follows the active soft-card theme');
  assert.equal(darkProviderSurfaces.providerInput, darkProviderSurfaces.input, 'provider inputs follow the active input theme');
  assert.equal(darkProviderSurfaces.modelField, darkProviderSurfaces.input, 'provider model pickers follow the active input theme');
  const providerModelArrow = await page.getByTestId('provider-agent-model-picker').evaluate((trigger) => {
    const field = trigger.parentElement;
    const arrow = trigger.querySelector('svg');
    if (!(field instanceof HTMLElement) || !(arrow instanceof SVGElement)) throw new Error('missing provider model arrow');
    return { fieldRight: field.getBoundingClientRect().right, arrowRight: arrow.getBoundingClientRect().right };
  });
  assert.ok(providerModelArrow.fieldRight - providerModelArrow.arrowRight <= 12, 'provider model arrow stays at the field right edge');
  await page.getByTestId('provider-agent-model-picker').click();
  const providerModelMenu = page.getByTestId('provider-agent-model-picker-menu');
  await providerModelMenu.waitFor();
  assert.equal(await providerModelMenu.getByRole('group', { name: 'DEEPSEEK' }).count(), 1, 'provider routing reuses the grouped main model picker');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'provider-settings-dark-packaged.png' : 'provider-settings-dark.png') });
  await page.keyboard.press('Escape');

  await page.getByTestId('settings-page-agents').click();
  const darkAgentSurfaces = await page.evaluate(() => {
    const background = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor;
    const token = (name) => {
      const probe = document.createElement('i');
      probe.style.backgroundColor = `var(${name})`;
      document.body.append(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    };
    return {
      card: token('--card-bg'), soft: token('--card-soft'), input: token('--input-bg'),
      roster: background('.agent-roster-card'), tabs: background('.agent-editor-tabs'),
      textarea: background('.agent-profile-editor textarea'), modelField: background('.agent-profile-grid .model-picker--field'),
    };
  });
  assert.equal(darkAgentSurfaces.roster, darkAgentSurfaces.card, 'Agent roster follows the active card theme');
  assert.equal(darkAgentSurfaces.tabs, darkAgentSurfaces.soft, 'Agent tabs follow the active soft-card theme');
  assert.equal(darkAgentSurfaces.textarea, darkAgentSurfaces.input, 'Agent inputs follow the active input theme');
  assert.equal(darkAgentSurfaces.modelField, darkAgentSurfaces.input, 'Agent model picker follows the active input theme');
  assert.equal(await page.locator('.agent-model-field > select').count(), 0, 'Agent model selection no longer uses a native select');
  const agentModelArrow = await page.getByTestId('agent-model-picker').evaluate((trigger) => {
    const field = trigger.parentElement;
    const arrow = trigger.querySelector('svg');
    if (!(field instanceof HTMLElement) || !(arrow instanceof SVGElement)) throw new Error('missing Agent model arrow');
    return { fieldRight: field.getBoundingClientRect().right, arrowRight: arrow.getBoundingClientRect().right };
  });
  assert.ok(agentModelArrow.fieldRight - agentModelArrow.arrowRight <= 12, 'Agent model arrow stays at the field right edge');
  await page.getByTestId('agent-model-picker').click();
  const agentModelMenu = page.getByTestId('agent-model-picker-menu');
  await agentModelMenu.waitFor();
  assert.equal(await agentModelMenu.getByRole('group', { name: 'DEEPSEEK' }).count(), 1, 'Agent editing reuses the grouped main model picker');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'agent-settings-dark-packaged.png' : 'agent-settings-dark.png') });
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-page-interface').click();
  await page.getByTestId('theme-card-coral-paper').click();
  await interfacePage.locator('.interface-save-status.saved').waitFor();
  const savedDesktopSettings = JSON.parse(readFileSync(join(userDataRoot, 'desktop-settings.json'), 'utf8'));
  assert.deepEqual(savedDesktopSettings.interfacePreferences, {
    schemaVersion: 6,
    theme: 'coral-paper',
    semanticPaletteOverrides: { 'coral-paper': { success: '#336699' } },
    readingFont: 'sans',
    readingSizeDelta: 0,
    chatWidth: 800,
    paperTexture: true,
    sunnyMode: false,
    hardwareAcceleration: false,
    singleLineSessions: true,
    markdown: { font: 'follow-reading', bodySize: 12, contentWidth: 800, heading1Size: 21, heading2Size: 17, heading3Size: 14, lineHeight: 1.5, contentPadding: 24 },
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

  const typography = await page.evaluate(() => ({
    fontFamily: getComputedStyle(document.querySelector('.app-shell')).fontFamily,
    readingFont: document.documentElement.dataset.readingFont,
    weights: [...document.querySelectorAll('.app-shell strong')].slice(0, 20).map((element) => getComputedStyle(element).fontWeight),
  }));
  assert.match(typography.fontFamily, /Segoe UI/u, 'the application uses the compact system UI font stack');
  assert.equal(typography.readingFont, 'sans', 'legacy typography migrates to the GPT-like sans reading default');
  assert.equal(typography.weights.every((weight) => Number.parseInt(weight, 10) === 400), true, 'existing strong elements render at regular weight');

  await page.getByTestId('titlebar-file-menu-trigger').click();
  const fileMenu = page.locator('.titlebar-file-menu');
  assert.deepEqual(await fileMenu.locator(':scope > button').allTextContents(), ['新建窗口', '新聊天Ctrl+N', '新建临时聊天Ctrl+Shift+N', '打开文件夹Ctrl+O', '关闭Ctrl+W'], 'File menu contains only the requested functional commands');
  const horizontalFileLabels = await fileMenu.locator(':scope > button > span:first-child').evaluateAll((labels) => labels.map((label) => {
    const rect = label.getBoundingClientRect();
    const style = getComputedStyle(label);
    return { width: rect.width, height: rect.height, whiteSpace: style.whiteSpace, writingMode: style.writingMode };
  }));
  assert.equal(horizontalFileLabels.every((label) => label.whiteSpace === 'nowrap' && label.writingMode === 'horizontal-tb' && label.width > label.height), true, 'titlebar menu labels remain horizontal and do not wrap one character per line');
  const newWindowPromise = firstApplication.waitForEvent('window');
  await page.getByTestId('file-new-window').click();
  const additionalWindow = await newWindowPromise;
  await additionalWindow.locator('.app-shell').waitFor();
  assert.equal(firstApplication.windows().length, 2, 'New Window creates a functional second application window');
  await additionalWindow.close();
  await waitFor(async () => firstApplication.windows().length === 1 ? true : undefined);

  const composerInput = page.locator('.app-mode-chat [data-testid="composer-input"]');
  await composerInput.fill('编辑菜单功能测试');
  await composerInput.focus();
  await page.keyboard.press('Control+A');
  await page.locator('.titlebar-menu > button', { hasText: '编辑' }).click();
  const horizontalEditLabels = await page.locator('.titlebar-edit-menu > button > span:first-child').evaluateAll((labels) => labels.map((label) => {
    const rect = label.getBoundingClientRect();
    return { width: rect.width, height: rect.height, whiteSpace: getComputedStyle(label).whiteSpace };
  }));
  assert.equal(horizontalEditLabels.every((label) => label.whiteSpace === 'nowrap' && label.width > label.height), true, 'Edit menu labels remain on one horizontal line');
  await page.locator('.titlebar-edit-menu > button', { hasText: '剪切' }).click();
  await waitFor(async () => await composerInput.inputValue() === '' ? true : undefined);
  await page.locator('.titlebar-menu > button', { hasText: '编辑' }).click();
  await page.locator('.titlebar-edit-menu > button', { hasText: '撤销' }).click();
  await waitFor(async () => await composerInput.inputValue() === '编辑菜单功能测试' ? true : undefined);
  await composerInput.fill('');

  await page.getByTestId('titlebar-view-menu-trigger').click();
  const viewMenu = page.locator('.titlebar-view-menu');
  for (const label of ['切换边栏', '切换底部面板', '切换置顶摘要', '打开终端', '切换文件树', '切换审阅面板', '浏览器', '查找', '上一个聊天', '下一个聊天', '放大', '缩小', '实际大小', '切换全屏']) {
    assert.equal(await viewMenu.getByText(label, { exact: true }).count() > 0, true, `View menu includes ${label}`);
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+J');
  await page.locator('.app-mode-chat .composer-wrap').waitFor({ state: 'hidden' });
  await page.keyboard.press('Control+J');
  await page.locator('.app-mode-chat .composer-wrap').waitFor({ state: 'visible' });
  await page.keyboard.press('Control+/');
  const shortcutsDialog = page.locator('.keyboard-shortcuts-dialog');
  await shortcutsDialog.waitFor();
  await shortcutsDialog.locator('input').fill('终端');
  assert.equal(await shortcutsDialog.getByText('打开终端', { exact: true }).count(), 1, 'shortcut dialog filters existing commands');
  await page.keyboard.press('Escape');

  await page.locator('.titlebar-menu > button', { hasText: '帮助' }).click();
  assert.deepEqual(await page.locator('.titlebar-help-menu > button').allTextContents(), ['显示键盘快捷键Ctrl+/', '新功能', '故障排除', '系统状态', '反馈', '检查更新…', '关于 Sci Workplace'], 'Help menu contains only the requested commands');
  await page.keyboard.press('Escape');

  assert.equal(await page.getByTestId('titlebar-left-toggle').count(), 1, 'conversation sidebar must have one top-level toggle');
  assert.equal(await page.getByTestId('titlebar-workspace-toggle').count(), 1, 'workspace must have one top-level toggle');
  assert.equal(await page.locator('.titlebar-center-switch').count(), 0, 'top center mode switch is removed');
  assert.equal(await page.locator('.titlebar [data-testid="titlebar-workspace-toggle"]').count(), 0, 'workspace toggle no longer occupies the system titlebar');
  assert.equal(await page.locator('[data-testid="conversation-header-actions"] [data-testid="titlebar-workspace-toggle"]').count(), 0, 'workspace toggle is independent from conversation actions');
  assert.equal(await page.locator('[data-testid="chat-workspace-controls"] [data-testid="titlebar-workspace-toggle"]').count(), 1, 'workspace toggle stays at the top-right edge of the chat canvas');
  assert.equal(await page.locator('[data-testid="conversation-header-actions"] button').count(), 2, 'conversation header keeps only branch and refresh on the right');
  assert.equal(await page.locator('[data-testid="conversation-header-meta"] [data-testid="conversation-open-project"]').count(), 1, 'opening the project folder is integrated into the leading folder icon');
  const originalConversationTitle = (await page.getByTestId('conversation-title-rename').innerText()).trim();
  await page.getByTestId('conversation-title-rename').click();
  const conversationTitleInput = page.getByTestId('conversation-title-input');
  await conversationTitleInput.waitFor();
  assert.equal(await page.getByTestId('app-dialog-input').count(), 0, 'header title rename is inline and does not open a dialog');
  assert.deepEqual(await conversationTitleInput.evaluate((input) => ({ start: input.selectionStart, end: input.selectionEnd, length: input.value.length })), { start: 0, end: originalConversationTitle.length, length: originalConversationTitle.length }, 'inline rename selects the existing title for immediate typing');
  await conversationTitleInput.fill('E2E 标题重命名');
  await conversationTitleInput.press('Enter');
  await page.getByTestId('conversation-title-rename').getByText('E2E 标题重命名', { exact: true }).waitFor();
  assert.equal((await page.locator('.session-item.is-active .session-item__copy strong').innerText()).trim(), 'E2E 标题重命名', 'renaming from the conversation header updates the sidebar title');
  await page.getByTestId('conversation-title-rename').click();
  await page.getByTestId('conversation-title-input').fill(originalConversationTitle);
  await page.getByTestId('conversation-title-input').press('Enter');
  await page.getByTestId('conversation-title-rename').getByText(originalConversationTitle, { exact: true }).waitFor();
  const projectRow = page.getByTestId('sidebar-project-row');
  const projectSectionToggle = page.getByTestId('sidebar-project-section').getByRole('button', { name: '项目', exact: true });
  assert.equal(await projectSectionToggle.getAttribute('aria-expanded'), 'true');
  const [projectRowBounds, projectSessionBounds] = await Promise.all([projectRow.boundingBox(), page.locator('.sidebar-project-sessions .session-item').first().boundingBox()]);
  assert.ok(projectRowBounds && projectSessionBounds && Math.abs(projectSessionBounds.x - projectRowBounds.x) <= 2, 'project conversations no longer carry an oversized left indent');
  assert.equal(await projectRow.getAttribute('aria-expanded'), 'true');
  await projectRow.click();
  assert.equal(await projectRow.getAttribute('aria-expanded'), 'false', 'clicking the project row itself collapses only that project');
  assert.equal(await projectSectionToggle.getAttribute('aria-expanded'), 'true', 'collapsing a project does not collapse the whole Project section');
  assert.equal(await page.locator('.sidebar-project-session-body[aria-hidden="true"]').count(), 1, 'collapsed project conversations are hidden from interaction');
  await projectRow.click();
  assert.equal(await projectRow.getAttribute('aria-expanded'), 'true', 'clicking the project name again expands its conversations');
  await projectRow.click({ button: 'right' });
  const projectContextMenu = page.getByTestId('project-context-menu');
  await projectContextMenu.waitFor();
  assert.deepEqual(await projectContextMenu.locator(':scope > button').allTextContents(), ['编辑', '管理文件夹', '置顶', '全部标记为已读', '归档聊天', '移除项目']);
  assert.equal(await projectContextMenu.getByRole('menuitem', { name: '打开项目文件夹', exact: true }).count(), 0, 'the project row no longer opens the folder from its click or context menu');
  await projectContextMenu.getByRole('menuitem', { name: '管理文件夹', exact: true }).click();
  const manageProjectFoldersDialog = page.getByTestId('create-project-dialog');
  await manageProjectFoldersDialog.waitFor();
  await manageProjectFoldersDialog.locator('.create-project-folder-row').first().waitFor();
  assert.equal(await manageProjectFoldersDialog.locator('.create-project-folder-row').count(), 1, 'an existing project starts with its primary folder in the folder manager');
  assert.equal(await manageProjectFoldersDialog.locator('.create-project-folder-row').first().getByRole('button').count(), 0, 'the primary project folder cannot be removed');
  await page.keyboard.press('Escape');
  await manageProjectFoldersDialog.waitFor({ state: 'detached' });

  const activeProjectSource = await page.evaluate(async () => {
    const sources = await window.openlab.listConversationSources();
    return sources.find((source) => source.kind === 'project' && source.projectId === document.querySelector('[data-testid="sidebar-project-row"]')?.getAttribute('data-project-id'))
      ?? sources.find((source) => source.kind === 'project');
  });
  assert.ok(activeProjectSource, 'active project source is available for folder binding');
  await page.evaluate(async ({ source, folder }) => {
    await window.openlab.updateProjectFolders({
      projectId: source.projectId,
      rootPath: source.rootPath,
      sourceFolders: [source.rootPath, folder],
    });
  }, { source: activeProjectSource, folder: additionalProjectRoot });
  const multiRootSnapshot = await waitFor(async () => {
    const state = await snapshot(page);
    return state.workspace.roots.some((root) => root.displayPath.toLocaleLowerCase() === additionalProjectRoot.toLocaleLowerCase()) ? state : undefined;
  });
  assert.equal(multiRootSnapshot.workspace.roots.find((root) => root.displayPath.toLocaleLowerCase() === additionalProjectRoot.toLocaleLowerCase())?.kind, 'project', 'a bound folder is a first-class project root for the active conversation');
  const persistedProjectSource = await page.evaluate(async () => (await window.openlab.listConversationSources()).find((source) => source.kind === 'project' && source.additionalRoots?.length));
  assert.equal(persistedProjectSource?.additionalRoots?.some((path) => path.toLocaleLowerCase() === additionalProjectRoot.toLocaleLowerCase()), true, 'the extra project folder is persisted in the desktop project catalog');

  await projectRow.click({ button: 'right' });
  await projectContextMenu.waitFor();
  await projectContextMenu.getByRole('menuitem', { name: '置顶', exact: true }).click();
  await page.getByTestId('sidebar-pinned-section').getByTestId('sidebar-project-row').waitFor();
  await page.getByTestId('sidebar-pinned-section').getByTestId('sidebar-project-row').click({ button: 'right' });
  await page.getByTestId('project-context-menu').getByRole('menuitem', { name: '取消置顶', exact: true }).click();
  await page.getByTestId('sidebar-project-section').getByTestId('sidebar-project-row').waitFor();
  assert.equal(await page.getByTestId('composer-project-context').count(), 0, 'the redundant project context rail is removed from the composer');
  assert.equal(await page.getByTestId('composer-project-menu').count(), 0, 'the removed context rail leaves no secondary project menu');
  assert.equal(await page.locator('.app-mode-chat .composer-hint').count(), 0, 'composer shortcut helper line is removed');
  const activeSessionActions = await page.locator('.session-item.is-active .session-item__actions button').evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { left: rect.left, right: rect.right, opacity: Number(getComputedStyle(button).opacity) };
  }));
  assert.equal(activeSessionActions.length, 2, 'active Hana-style session exposes pin and archive actions');
  assert.ok(activeSessionActions[0].right <= activeSessionActions[1].left, 'session actions do not overlap');
  assert.equal(activeSessionActions.every((button) => button.opacity === 1), true, 'active session actions remain visible');
  assert.equal(await page.locator('.session-item.is-active .agent-avatar-visual').count(), 1, 'compact session rows include the assigned Agent avatar');
  const activeSessionVisual = await page.locator('.session-item.is-active').evaluate((element) => {
    const title = element.querySelector('.session-item__copy strong');
    const metadata = element.querySelector('.session-item__copy small');
    const avatar = element.querySelector('.agent-avatar-visual');
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent-strong)';
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    if (!(title instanceof HTMLElement) || !(metadata instanceof HTMLElement) || !(avatar instanceof HTMLElement)) throw new Error('missing active session visuals');
    return {
      titleColor: getComputedStyle(title).color,
      metadataColor: getComputedStyle(metadata).color,
      accent,
      avatarOutlineWidth: Number.parseFloat(getComputedStyle(avatar).outlineWidth),
      rowBackground: getComputedStyle(element).backgroundColor,
    };
  });
  assert.equal(activeSessionVisual.titleColor, activeSessionVisual.accent, 'the active conversation uses the theme accent only on its title');
  assert.notEqual(activeSessionVisual.metadataColor, activeSessionVisual.accent, 'secondary session metadata stays neutral instead of turning into a full-row highlight');
  assert.ok(activeSessionVisual.avatarOutlineWidth > 0, 'the active Agent avatar receives a restrained accent ring');
  assert.notEqual(activeSessionVisual.rowBackground, 'rgba(0, 0, 0, 0)', 'the active session keeps the neutral selected surface');
  assert.equal(await page.locator('.session-item.is-active .session-item__unread').count(), 0, 'the active conversation is always read');
  assert.equal(await page.locator('.session-item .running-dot').count(), 0, 'running status is not misrepresented as an unread marker');
  await page.locator('.session-item.is-active').click({ button: 'right' });
  const sessionContextMenu = page.getByTestId('session-context-menu');
  await sessionContextMenu.waitFor();
  assert.deepEqual(await sessionContextMenu.locator(':scope > button').allTextContents(), ['摘要', '复制 Session ID', '置顶', '重命名', '归档']);
  const activeSessionMetadata = page.locator('.session-item.is-active .session-item__copy small');
  assert.equal(await activeSessionMetadata.evaluate((element) => getComputedStyle(element).display), 'block', 'Hana-style Agent, project, and relative-time metadata remains visible in compact preferences');
  const sidebarState = await snapshot(page);
  const sidebarMetadataParts = (await activeSessionMetadata.innerText()).split(' · ');
  assert.equal(sidebarMetadataParts[0], sidebarState.primaryAgent.name, 'session metadata starts with the Agent name');
  assert.equal(sidebarMetadataParts[1], sidebarState.project.name, 'project conversations show the project display name instead of the folder basename');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'chat-session-context-menu-packaged.png' : 'chat-session-context-menu.png') });
  await sessionContextMenu.getByRole('menuitem', { name: '置顶', exact: true }).click();
  await waitFor(async () => await page.locator('.session-item.is-active').evaluate((element) => element.classList.contains('is-pinned') ? true : undefined));
  const selectedPin = page.locator('.session-item.is-active .session-item__pin');
  assert.equal(await selectedPin.getAttribute('aria-pressed'), 'true');
  assert.notEqual(await selectedPin.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'selected pin receives a theme-native selected color');
  await selectedPin.click();
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
  await page.getByTestId('workspace-panel-launcher').waitFor();
  assert.deepEqual(await page.locator('.workspace-panel-launcher__options > button').allTextContents(), ['项目技能', '终端', '浏览器', '工作区', '对话文件'], 'the blank right sidebar uses GPT-style rows for every available local surface');
  const workspaceLauncherGeometry = await page.getByTestId('workspace-panel-option-workspace').evaluate((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, fontWeight: Number.parseInt(getComputedStyle(element.querySelector('strong')).fontWeight, 10) }));
  assert.ok(workspaceLauncherGeometry.width <= 470 && workspaceLauncherGeometry.height <= 50, 'the GPT-style launcher row stays compact within the sidebar');
  assert.ok(workspaceLauncherGeometry.fontWeight <= 500, 'the Workspace launcher uses regular text');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'workspace-launcher-packaged.png' : 'workspace-launcher.png') });
  assert.equal(await page.locator('.hana-workspace-tabs').count(), 0, 'workspace content stays hidden until a launcher option is chosen');
  assert.equal((await page.getByTestId('sidebar-harness-title').innerText()).trim(), 'Sci Workplace', 'Sci Workplace remains the Harness title');
  assert.equal((await page.getByTestId('new-conversation').innerText()).trim(), '新对话', 'New conversation is a dedicated action below the Harness title');
  const harnessBox = await page.getByTestId('sidebar-harness-title').boundingBox();
  const sidebarHeaderBox = await page.locator('.sidebar-chatgpt-header').boundingBox();
  const sidebarSearchBox = await page.getByTestId('sidebar-search-toggle').boundingBox();
  const newConversationBox = await page.getByTestId('new-conversation').boundingBox();
  assert.ok(sidebarHeaderBox && sidebarSearchBox && sidebarHeaderBox.x + sidebarHeaderBox.width - (sidebarSearchBox.x + sidebarSearchBox.width) <= 8, 'search is the sole control at the far right of the sidebar header');
  assert.equal(await page.getByTestId('toggle-archived').count(), 0, 'the sidebar header omits the redundant archive icon');
  assert.ok(harnessBox && newConversationBox && newConversationBox.y >= harnessBox.y + harnessBox.height, 'New conversation is positioned below the Harness title');
  assert.equal(await page.locator('.session-list').getByTestId('new-conversation').count(), 0, 'Harness name and New conversation remain outside the scrolling region');
  assert.equal(await page.locator('.session-list').getByTestId('sidebar-worktable').count(), 1, 'secondary navigation starts inside the scrolling region');
  assert.deepEqual(await page.locator('.sidebar-chatgpt-nav > button').allTextContents(), ['工作台', '频道'], 'the requested navigation actions remain below New conversation');
  assert.equal(await page.getByTestId('sidebar-project-skills').count(), 0, 'Project Skills is removed from the left sidebar');
  assert.deepEqual(await page.locator('.session-list > .sidebar-section > .sidebar-section-heading').allTextContents(), ['置顶', '项目', '最近'], 'sidebar sections follow GPT order');
  const firstNavBox = await page.getByTestId('sidebar-worktable').boundingBox();
  assert.ok(newConversationBox && firstNavBox && firstNavBox.y >= newConversationBox.y + newConversationBox.height, 'the original navigation actions are positioned below New conversation');
  assert.ok(newConversationBox && firstNavBox && firstNavBox.y - (newConversationBox.y + newConversationBox.height) <= 2, 'New conversation and Worktable use a compact vertical gap');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('sidebar-worktable').click();
  await page.getByTestId('worktable-shell').waitFor();
  assert.equal(await page.locator('.worktable-drawer').count(), 1, 'Workbench v1 exposes the project/instance drawer');
  assert.equal(await page.locator('.worktable-stage').count(), 1, 'Workbench v1 exposes a dockable canvas');
  assert.equal(await page.locator('.worktable-chat-dock').count(), 1, 'Workbench v1 exposes the bound primary Agent conversation');
  await page.getByTestId('worktable-welcome-create').click();
  await page.getByTestId('worktable-create-dialog').waitFor();
  await page.getByTestId('worktable-template-sci.core:research').click();
  await page.getByTestId('worktable-create-title-input').fill('E2E 科研控制台');
  await page.getByTestId('worktable-create-confirm').click();
  await page.getByTestId('worktable-title').filter({ hasText: 'E2E 科研控制台' }).waitFor();
  await page.getByTestId('workbench-studio').waitFor();
  assert.match(await page.getByTestId('workbench-studio').innerText(), /提示词生成应用[\s\S]*外部工具链代理[\s\S]*策展插件目录/u, 'the control room exposes generated apps, toolchains, and the curated catalog without a model call');

  const workbenchSessionId = (await snapshot(page)).activeSessionId;
  const paperConsoleErrorStart = rendererConsoleErrors.length;
  const paperSha256 = createHash('sha256').update(pdfFixture).digest('hex');
  const paperCreated = await runtimeJson(page, '/api/worktable/instances', {
    templateId: 'sci.paper-reader:deep-read',
    title: 'E2E 论文精读',
    boundSessionId: workbenchSessionId,
    inputs: {
      mainPdf: { rootId: 'project', path: 'e2e-paper.pdf', name: 'e2e-paper.pdf', sha256: paperSha256, size: pdfFixture.length, mediaType: 'application/pdf' },
      supplements: [],
      language: 'zh-CN',
    },
  });
  assert.equal(paperCreated.instance.templateId, 'sci.paper-reader:deep-read');
  await runtimeJson(page, `/api/worktable/instances/${encodeURIComponent(paperCreated.instance.id)}/activate`, {});
  await page.getByTestId('worktable-title').filter({ hasText: 'E2E 论文精读' }).waitFor();
  const sourcePanel = page.frameLocator('iframe[title="原文 / 双语"]');
  await sourcePanel.getByText('PDF 原版', { exact: true }).waitFor();
  const pdfTicketFrame = sourcePanel.locator('iframe[title="原始 PDF"]');
  await pdfTicketFrame.waitFor();
  assert.match(await pdfTicketFrame.getAttribute('src'), /^http:\/\/127\.0\.0\.1:\d+\/resource-files\//u, 'paper source uses a short-lived host resource ticket');
  assert.equal(rendererConsoleErrors.slice(paperConsoleErrorStart).some((message) => message.includes('Content Security Policy') || message.includes('violates the following')), false, 'paper PDF framing satisfies the loopback-only CSP');
  const workbenchState = await snapshot(page);
  assert.equal(workbenchState.workbenchInstances.length, 2, 'one project can own multiple Workbench v1 instances');
  assert.equal(workbenchState.workbenchInstances.every((instance) => instance.primaryConversationId === workbenchSessionId), true, 'each instance binds the primary conversation explicitly');
  const paperInstance = workbenchState.workbenchInstances.find((instance) => instance.id === paperCreated.instance.id);
  assert.equal(paperInstance?.layout.kind, 'split');
  assert.equal(paperInstance?.layout.ratio, 0.58, 'paper reader starts with the declared 58/42 source-analysis split');

  await page.getByTestId('worktable-chat-expand').waitFor();
  const expandGeometry = await page.getByTestId('worktable-chat-expand').evaluate((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height }));
  assert.ok(Math.abs(expandGeometry.width - expandGeometry.height) <= 1 && expandGeometry.width >= 30, 'the collapsed Agent dock leaves only the requested square expand arrow');
  const stageWidthCollapsed = (await page.locator('.worktable-stage').boundingBox())?.width ?? 0;
  await page.getByTestId('worktable-chat-expand').click();
  await page.getByTestId('worktable-chat-collapse').waitFor();
  const stageWidthWithChat = await waitFor(async () => {
    const width = (await page.locator('.worktable-stage').boundingBox())?.width ?? 0;
    return stageWidthCollapsed > width + 200 ? width : undefined;
  });
  assert.ok(stageWidthCollapsed > stageWidthWithChat + 200, 'on wide screens the open Agent dock squeezes the canvas');

  await page.setViewportSize({ width: 1100, height: 800 });
  const narrowChat = await page.locator('.worktable-chat-dock').evaluate((element) => ({ position: getComputedStyle(element).position, right: getComputedStyle(element).right }));
  assert.equal(narrowChat.position, 'absolute', 'on narrow screens the Agent conversation becomes a canvas overlay');
  assert.equal(narrowChat.right, '0px');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'workbench-v1-packaged.png' : 'workbench-v1.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await waitFor(async () => await page.locator('#conversation-workspace').evaluate((element) => getComputedStyle(element).position) === 'fixed' ? true : undefined);
  const narrowWorkspace = await page.locator('#conversation-workspace').evaluate((element) => ({
    position: getComputedStyle(element).position,
    internalCloseCount: element.querySelectorAll('.workspace-mobile-close').length,
    borderRadius: getComputedStyle(element).borderRadius,
    boxShadow: getComputedStyle(element).boxShadow,
  }));
  assert.equal(narrowWorkspace.position, 'fixed');
  assert.equal(narrowWorkspace.internalCloseCount, 0, 'the responsive workspace does not duplicate the global close control');
  assert.notEqual(narrowWorkspace.borderRadius, '0px', 'overlay workbench keeps a contained drawer shape');
  assert.notEqual(narrowWorkspace.boxShadow, 'none', 'overlay workbench remains visually elevated');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '1100px layout must not overflow horizontally');
  await page.getByTestId('titlebar-workspace-toggle').click();
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
  await page.getByTestId('workspace-panel-option-workspace').click();
  await page.locator('.hana-workspace-tabs').waitFor();
  assert.equal(await page.locator('.hana-workspace-tabs > button').count(), 2, 'Hana-style workspace always exposes the conversation files and workbench views');
  await page.locator('.workspace-tree__row').filter({ hasText: basename(additionalProjectRoot) }).waitFor();
  assert.equal(await page.locator('.workspace-tree__row').filter({ hasText: basename(additionalProjectRoot) }).count(), 1, 'every folder bound to the project is visible in the workspace tree');
  assert.equal((await page.locator('.hana-workspace-identity').innerText()).trim(), '工作区', 'workspace header uses the fixed workspace name instead of an Agent name');
  const workspaceIdentityTheme = await page.locator('.hana-workspace-identity').evaluate((button) => {
    const label = button.querySelector('strong');
    if (!(label instanceof HTMLElement)) throw new Error('missing workspace identity label');
    return { background: getComputedStyle(button).backgroundColor, color: getComputedStyle(button).color, labelColor: getComputedStyle(label).color };
  });
  assert.notEqual(workspaceIdentityTheme.background, 'rgb(253, 254, 251)', 'workspace identity does not inherit the legacy white button background');
  assert.equal(workspaceIdentityTheme.labelColor, workspaceIdentityTheme.color, 'workspace identity text follows the active theme color');
  assert.equal((await page.getByTestId('workspace-skills-trigger').innerText()).trim(), '项目技能');
  assert.equal(await page.getByTestId('workspace-panel-launcher').count(), 0, 'choosing 工作区 opens the functional file surface');
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
  const hanaWorkspaceAlignment = await page.evaluate(() => {
    const workspace = document.querySelector('#conversation-workspace');
    const header = workspace?.querySelector('.conversation-workspace__header');
    const identity = document.querySelector('.hana-workspace-identity');
    const skills = document.querySelector('.workspace-skills-trigger');
    const cornerControls = document.querySelector('.chat-workspace-controls');
    const tabs = document.querySelector('.hana-workspace-tabs');
    const note = document.querySelector('.workspace-note');
    if (!(workspace instanceof HTMLElement) || !(header instanceof HTMLElement) || !(identity instanceof HTMLElement) || !(skills instanceof HTMLElement) || !(cornerControls instanceof HTMLElement) || !(tabs instanceof HTMLElement) || !(note instanceof HTMLElement)) throw new Error('missing Hana workspace structure');
    const panel = workspace.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const identityRect = identity.getBoundingClientRect();
    const skillsRect = skills.getBoundingClientRect();
    const controlsRect = cornerControls.getBoundingClientRect();
    const tabsRect = tabs.getBoundingClientRect();
    const noteRect = note.getBoundingClientRect();
    return {
      headerHeight: headerRect.height,
      identityTop: identityRect.top - panel.top,
      tabsTop: tabsRect.top - panel.top,
      identitySkillsCenterDelta: Math.abs((identityRect.top + identityRect.height / 2) - (skillsRect.top + skillsRect.height / 2)),
      identityControlsCenterDelta: Math.abs((identityRect.top + identityRect.height / 2) - (controlsRect.top + controlsRect.height / 2)),
      noteBottom: panel.bottom - noteRect.bottom,
      noteHeight: noteRect.height,
      noteText: note.textContent ?? '',
    };
  });
  assert.ok(hanaWorkspaceAlignment.headerHeight <= 45, 'the workspace header stays compact');
  assert.ok(hanaWorkspaceAlignment.identityTop < hanaWorkspaceAlignment.tabsTop, 'Agent identity stays above the workspace tabs');
  assert.ok(hanaWorkspaceAlignment.identitySkillsCenterDelta <= 1, 'workspace title and Project Skills align on one horizontal centerline');
  assert.ok(hanaWorkspaceAlignment.identityControlsCenterDelta <= 1, 'workspace title and corner controls align on one horizontal centerline');
  assert.ok(hanaWorkspaceAlignment.noteBottom <= 12 && hanaWorkspaceAlignment.noteHeight >= 180, 'the Hana note stays pinned at the bottom at a useful writing height');
  assert.equal(hanaWorkspaceAlignment.noteText.includes('项目目标'), false, 'the journal omits the redundant 项目目标 label');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'chat-workspace-hana-packaged.png' : 'chat-workspace-hana.png') });
  await page.getByTestId('workspace-tab-workspace').click();
  await page.getByTestId('workspace-browser-panel').waitFor();
  assert.equal((await page.getByTestId('workspace-tab-workspace').innerText()).trim(), '项目文件', 'the right file view is named 项目文件');
  await waitFor(async () => await page.evaluate(() => {
    const conversation = document.querySelector('.conversation-pane');
    const workspace = document.querySelector('#conversation-workspace');
    if (!(conversation instanceof HTMLElement) || !(workspace instanceof HTMLElement)) return undefined;
    return Math.abs(conversation.getBoundingClientRect().right - workspace.getBoundingClientRect().left) <= 1 ? true : undefined;
  }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '1480px layout must not overflow horizontally');
  const resizer = page.getByTestId('workspace-resizer');
  await resizer.waitFor();
  const resizeBefore = await page.evaluate(() => ({
    workspace: document.querySelector('#conversation-workspace').getBoundingClientRect().width,
    conversation: document.querySelector('.conversation-pane').getBoundingClientRect().width,
  }));
  const resizerBox = await resizer.boundingBox();
  if (!resizerBox) throw new Error('missing workspace resize handle bounds');
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + 180);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x + resizerBox.width / 2 - 40, resizerBox.y + 180);
  const resizeDuringDrag = await page.evaluate(() => {
    const shell = document.querySelector('.chat-workspace');
    const workspace = document.querySelector('#conversation-workspace');
    if (!(shell instanceof HTMLElement) || !(workspace instanceof HTMLElement)) throw new Error('missing live workspace resize surface');
    return {
      workspaceWidth: workspace.getBoundingClientRect().width,
      inlineWidth: shell.style.getPropertyValue('--chat-workspace-width'),
      transitionDuration: getComputedStyle(shell).transitionDuration,
    };
  });
  assert.ok(Math.abs(resizeDuringDrag.workspaceWidth - (resizeBefore.workspace + 40)) <= 2, 'the workspace edge follows the pointer during drag');
  assert.ok(Math.abs(Number.parseFloat(resizeDuringDrag.inlineWidth) - (resizeBefore.workspace + 40)) <= 2, 'dragging updates the grid width directly without a React render delay');
  assert.equal(resizeDuringDrag.transitionDuration, '0s', 'layout animation is disabled while dragging');
  await page.mouse.move(resizerBox.x + resizerBox.width / 2 - 82, resizerBox.y + 180, { steps: 3 });
  await page.mouse.up();
  const resizeAfter = await waitFor(async () => await page.evaluate((before) => {
    const workspace = document.querySelector('#conversation-workspace');
    const conversation = document.querySelector('.conversation-pane');
    if (!(workspace instanceof HTMLElement) || !(conversation instanceof HTMLElement)) return undefined;
    const value = { workspace: workspace.getBoundingClientRect().width, conversation: conversation.getBoundingClientRect().width };
    return value.workspace >= before.workspace + 60 ? value : undefined;
  }, resizeBefore));
  assert.ok(resizeAfter.conversation <= resizeBefore.conversation - 60, 'dragging the divider resizes the conversation and workspace together');
  assert.equal(await page.locator('.timeline-scroll').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'conversation content reflows without a horizontal scrollbar');
  await resizer.press('Home');
  await waitFor(async () => await page.locator('#conversation-workspace').evaluate((element) => Math.abs(element.getBoundingClientRect().width - 400) <= 1 ? true : undefined));
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
    const workspaceRoot = workspace.querySelector('.workspace-tree__root');
    if (!(workspaceHeader instanceof HTMLElement) || !(workspaceToolbar instanceof HTMLElement) || !(workspaceRoot instanceof HTMLElement)) throw new Error('missing workspace chrome');
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
      seamDisplay: seamStyle.display,
      workspaceHeaderBorder: getComputedStyle(workspaceHeader).borderBottomWidth,
      workspaceTabs: workspace.querySelector('.hana-workspace-tabs') !== null,
      workspaceToolbarBorder: getComputedStyle(workspaceToolbar).borderBottomWidth,
      workspaceRootVisible: workspaceRoot instanceof HTMLElement && workspaceRoot.getBoundingClientRect().height > 0,
      viewport: { height: window.innerHeight, width: window.innerWidth },
      workspaceRight: workspaceRect.right,
    };
  });
  assert.notEqual(dockedChatShell.conversationRadius, '0px', 'main conversation keeps a Codex-like content-sheet radius');
  assert.equal(dockedChatShell.conversationBorder, '0px', 'main conversation must not use an outer card border');
  assert.ok(Number.parseFloat(dockedChatShell.workspaceBorderLeft) > 0 && Number.parseFloat(dockedChatShell.workspaceBorderLeft) <= 1.1, 'Hana workspace uses a quiet one-device-pixel divider');
  assert.equal(dockedChatShell.workspaceBorderTop, '0px', 'docked workbench must not use an outer border');
  assert.equal(dockedChatShell.workspaceRadius, '0px', 'docked workbench must not use an outer card radius');
  assert.equal(dockedChatShell.workspaceShadow, 'none', 'docked workbench must not look like a floating card');
  assert.deepEqual({ header: dockedChatShell.workspaceHeaderBorder, tabs: dockedChatShell.workspaceTabs, toolbar: dockedChatShell.workspaceToolbarBorder, root: dockedChatShell.workspaceRootVisible }, { header: '0px', tabs: true, toolbar: '0px', root: true }, 'workspace chrome matches the Hana fixed-tabs and tree structure');
  assert.equal(dockedChatShell.seamDisplay, 'none', 'the former gradient seam is removed');
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
      composerShadow: getComputedStyle(composer).boxShadow,
    };
  });
  assert.ok(Math.max(readingWidth.timelineLeftGap, readingWidth.timelineRightGap, readingWidth.composerLeftGap, readingWidth.composerRightGap) <= 32, 'timeline and composer stay wide and close to the conversation edges');
  assert.equal(readingWidth.composerShadow, 'none', 'the composer has no surrounding shadow');
  const floatingComposerLayout = await page.evaluate(() => {
    const pane = document.querySelector('.conversation-pane');
    const scroll = document.querySelector('.timeline-scroll');
    const timeline = document.querySelector('.timeline');
    const wrap = document.querySelector('.composer-wrap');
    const composer = document.querySelector('.composer');
    const toolbar = document.querySelector('.composer__toolbar');
    const sendButton = document.querySelector('.app-mode-chat [data-testid="send-message"]');
    if (![pane, scroll, timeline, wrap, composer, toolbar, sendButton].every((element) => element instanceof HTMLElement)) throw new Error('missing floating composer layout');
    const scrollRect = scroll.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const toolbarButtons = [...toolbar.querySelectorAll('button')].map((button) => button.getBoundingClientRect());
    const toolbarIcons = [...toolbar.querySelectorAll('button svg')].map((icon) => icon.getBoundingClientRect());
    return {
      wrapPosition: getComputedStyle(wrap).position,
      scrollBottom: scrollRect.bottom,
      wrapTop: wrapRect.top,
      composerBottom: composerRect.bottom,
      timelinePaddingBottom: Number.parseFloat(getComputedStyle(timeline).paddingBottom),
      composerHeight: composerRect.height,
      composerBorder: getComputedStyle(composer).borderTopWidth,
      toolbarDivider: getComputedStyle(toolbar).borderTopWidth,
      maxToolbarControlHeight: Math.max(...toolbarButtons.map((rect) => rect.height)),
      toolbarBottomDelta: Math.max(...toolbarButtons.map((rect) => rect.bottom)) - Math.min(...toolbarButtons.map((rect) => rect.bottom)),
      maxToolbarIconSize: Math.max(...toolbarIcons.flatMap((rect) => [rect.width, rect.height])),
      sendBackground: getComputedStyle(sendButton).backgroundColor,
      sendColor: getComputedStyle(sendButton).color,
      sendRadius: getComputedStyle(sendButton).borderRadius,
      sendUsesArrow: sendButton.querySelector('svg')?.classList.contains('lucide-arrow-up') ?? false,
    };
  });
  assert.equal(floatingComposerLayout.wrapPosition, 'relative', 'the composer participates in normal layout without a transparent overlay boundary');
  assert.ok(floatingComposerLayout.scrollBottom <= floatingComposerLayout.wrapTop + 1, 'the scroll surface ends before the composer instead of extending behind it');
  assert.ok(floatingComposerLayout.timelinePaddingBottom <= 20, 'the timeline has no oversized invisible composer reserve');
  assert.equal(floatingComposerLayout.composerBorder, '0px', 'the composer has no barely-visible outer frame');
  assert.equal(floatingComposerLayout.toolbarDivider, '0px', 'the composer toolbar divider is removed');
  assert.ok(floatingComposerLayout.maxToolbarControlHeight <= 26, `composer controls use the requested compact height (actual ${floatingComposerLayout.maxToolbarControlHeight}px)`);
  assert.ok(floatingComposerLayout.toolbarBottomDelta <= 1, 'composer controls share one bottom edge');
  assert.ok(floatingComposerLayout.maxToolbarIconSize <= 13.1, `composer toolbar icons stay visually compact (actual ${floatingComposerLayout.maxToolbarIconSize}px)`);
  assert.equal(floatingComposerLayout.sendBackground, 'rgb(255, 255, 255)', 'the send control uses the GPT-like white circular surface');
  assert.equal(floatingComposerLayout.sendColor, 'rgb(17, 24, 20)', 'the send glyph uses the quieter dark treatment instead of a bright accent');
  assert.equal(floatingComposerLayout.sendRadius, '50%', 'the send control is circular');
  assert.equal(floatingComposerLayout.sendUsesArrow, true, 'the idle send state uses an upward arrow');
  const note = page.locator('.workspace-note');
  const hanaNoteLayout = await note.evaluate((element) => {
    const heading = element.querySelector('.workspace-note__heading');
    const textarea = element.querySelector('textarea');
    if (!(heading instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement)) throw new Error('missing Hana note controls');
    const panel = element.getBoundingClientRect();
    const title = heading.getBoundingClientRect();
    const editor = textarea.getBoundingClientRect();
    return { title: heading.innerText.replace(/\s+/gu, ''), titleTopGap: title.top - panel.top, editorTop: editor.top - panel.top, height: panel.height };
  });
  assert.deepEqual({ title: hanaNoteLayout.title, titleTopGap: hanaNoteLayout.titleTopGap <= 1, editorBelowTitle: hanaNoteLayout.editorTop >= 40, usefulHeight: hanaNoteLayout.height >= 180 }, { title: '手账', titleTopGap: true, editorBelowTitle: true, usefulHeight: true }, 'the project journal stays open with its concise title and editor');
  assert.equal(await note.getByRole('button', { name: '收起目标' }).count(), 1, 'the reference collapse control is available at the bottom-right');
  await note.getByRole('button', { name: '收起目标' }).click();
  await waitFor(async () => await note.evaluate((element) => !element.classList.contains('is-open') && element.getBoundingClientRect().height <= 45 ? true : undefined));
  await note.getByRole('button', { name: '展开目标' }).click();
  await waitFor(async () => await note.evaluate((element) => element.classList.contains('is-open') && element.getBoundingClientRect().height >= 180 ? true : undefined));
  assert.equal(await page.locator('.conversation-summary').count(), 0, 'the redundant conversation summary is removed');
  const rootBranch = page.locator('.workspace-tree__root').first();
  const rootButton = rootBranch.locator(':scope > .workspace-tree__row .workspace-tree__main');
  assert.equal((await rootButton.innerText()).trim(), basename(projectRoot), 'the workspace root uses the actual folder name instead of the project display name');
  await rootBranch.getByText('research-notes', { exact: true }).waitFor();
  assert.equal(await rootBranch.getByText('research-notes', { exact: true }).count(), 1, 'the expanded project root lists recognized child content');
  const recognizedFolderRow = rootBranch.locator('.workspace-tree__row').filter({ hasText: 'research-notes' }).first();
  await recognizedFolderRow.locator('.workspace-tree__main').click();
  assert.equal(await recognizedFolderRow.evaluate((element) => element.classList.contains('is-selected')), true, 'the selected project entry receives a theme-native locator row');
  assert.equal(await rootBranch.locator(':scope > div:nth-child(2)').count(), 1, 'the active project root opens as a real expandable tree');
  await rootButton.click();
  assert.equal(await rootBranch.locator(':scope > div:nth-child(2)').count(), 0, 'clicking the root collapses its children');
  await rootButton.click();
  await waitFor(async () => await rootBranch.locator(':scope > div:nth-child(2)').count() === 1 ? true : undefined);
  await page.getByTestId('workspace-tab-files').click();
  await page.getByTestId('conversation-files-panel').waitFor();
  await page.getByTestId('workspace-tab-workspace').click();
  await page.getByTestId('workspace-filter-trigger').click();
  assert.deepEqual(await page.getByTestId('workspace-filter-menu').getByRole('menuitemradio').allTextContents(), ['图片', '文本', '视频'], 'file filtering uses the Hana type menu');
  await page.getByTestId('workspace-filter-menu').getByRole('menuitemradio', { name: '图片' }).click();
  assert.equal((await page.getByTestId('workspace-filter-trigger').innerText()).trim(), '图片');
  await page.getByTestId('workspace-filter-trigger').click();
  await page.getByTestId('workspace-filter-menu').getByRole('menuitem', { name: '清除过滤' }).click();
  await page.getByTestId('workspace-sort-trigger').click();
  assert.deepEqual(await page.getByTestId('workspace-sort-menu').getByRole('menuitemradio').allTextContents(), ['修改时间', '名称 A→Z', '名称 Z→A', '文件大小', '文件类型'], 'file sorting exposes the complete Hana menu');
  await page.getByTestId('workspace-sort-menu').getByRole('menuitemradio', { name: '文件类型' }).click();
  assert.equal((await page.getByTestId('workspace-sort-trigger').innerText()).trim(), '类型');
  await page.getByTestId('workspace-skills-trigger').click();
  const projectSkillsPanel = page.getByTestId('project-skills-panel');
  await projectSkillsPanel.waitFor();
  assert.equal(await projectSkillsPanel.getAttribute('role'), 'dialog', 'project skills opens as a popup dialog');
  assert.equal(await page.getByTestId('workspace-browser-panel').isVisible(), true, 'project skills keeps the project-file canvas mounted beneath the popup');
  assert.equal(await page.locator('.workspace-note').count(), 1, 'project skills keeps the project journal mounted beneath the popup');
  await projectSkillsPanel.getByRole('button', { name: '关闭' }).click();
  await projectSkillsPanel.waitFor({ state: 'detached' });
  await page.getByTestId('workspace-browser-panel').waitFor();
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

  const composerPlusTrigger = page.getByTestId('composer-plus-trigger');
  const composerPermission = page.getByTestId('composer-permission');
  const composerControlGeometry = await page.evaluate(() => {
    const box = (testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!(element instanceof HTMLElement)) throw new Error(`missing composer control: ${testId}`);
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    };
    return { plus: box('composer-plus-trigger'), permission: box('composer-permission'), options: box('composer-options') };
  });
  assert.ok(composerControlGeometry.plus.right <= composerControlGeometry.permission.left, 'permission mode moves beside the add button on the left');
  assert.ok(composerControlGeometry.permission.right <= composerControlGeometry.options.left, 'permission mode no longer occupies the model/send cluster');
  assert.equal(await page.locator('.composer-control.skill').count(), 0, 'the standalone Skill selector is removed');
  await composerPlusTrigger.click();
  const composerPlusMenu = page.getByTestId('composer-plus-menu');
  await composerPlusMenu.waitFor();
  assert.equal((await composerPlusMenu.innerText()).includes('技能'), true, 'Skills are integrated into the add menu');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'composer-plus-menu-packaged.png' : 'composer-plus-menu.png') });
  await page.keyboard.press('Escape');
  await composerPlusMenu.waitFor({ state: 'detached' });
  assert.equal(await composerPermission.count(), 1);
  await composerPermission.click();
  const permissionMenu = page.getByTestId('permission-picker-menu');
  await permissionMenu.waitFor();
  assert.deepEqual(await permissionMenu.getByRole('option').evaluateAll((options) => options.map((option) => option.getAttribute('data-permission-mode'))), ['auto', 'trusted', 'ask', 'read_only']);
  assert.equal(await permissionMenu.getByRole('option', { selected: true }).getAttribute('data-permission-mode'), 'auto');
  assert.deepEqual(await permissionMenu.getByRole('option').allTextContents(), ['自动审核', '完整权限', '操作前询问', '只读模式']);
  const permissionOpticalAlignment = await permissionMenu.getByRole('option').first().evaluate((option) => {
    const icon = option.querySelector('.permission-picker__option-icon');
    const label = option.querySelector('.permission-picker__option-label');
    if (!(icon instanceof HTMLElement) || !(label instanceof HTMLElement)) throw new Error('missing permission option alignment targets');
    const iconBox = icon.getBoundingClientRect();
    const labelBox = label.getBoundingClientRect();
    return (iconBox.top + iconBox.height / 2) - (labelBox.top + labelBox.height / 2);
  });
  assert.ok(permissionOpticalAlignment >= .5 && permissionOpticalAlignment <= 1.5, 'permission icons receive a 1px downward optical correction');
  const permissionMenuBounds = await permissionMenu.boundingBox();
  const permissionTriggerBounds = await composerPermission.boundingBox();
  assert.ok(permissionMenuBounds && permissionTriggerBounds && permissionMenuBounds.y + permissionMenuBounds.height <= permissionTriggerBounds.y, 'permission menu opens above its trigger');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'permission-picker-packaged.png' : 'permission-picker.png') });
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-permission-mode')), 'read_only');
  await page.keyboard.press('Escape');
  await permissionMenu.waitFor({ state: 'detached' });

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
  const beforeDraftConnection = await connection(page);
  const draftDocumentMarker = await page.evaluate(() => {
    const marker = crypto.randomUUID();
    globalThis.__sciWorkplaceDocumentMarker = marker;
    return marker;
  });
  await page.getByTestId('new-conversation').click();
  await page.locator('.app-mode-chat .empty-timeline').waitFor();
  await page.getByTestId('hana-draft-hero').waitFor();
  const defaultDraftProjectSelector = page.getByTestId('draft-project-selector');
  await defaultDraftProjectSelector.waitFor();
  assert.equal((await defaultDraftProjectSelector.innerText()).trim(), '不在项目中工作', 'every New conversation starts outside a project');
  assert.equal(await page.evaluate(() => globalThis.__sciWorkplaceDocumentMarker), draftDocumentMarker, 'starting an unbound draft keeps the renderer document mounted');
  assert.deepEqual(await connection(page), beforeDraftConnection, 'starting an unsent draft must not switch or disconnect the Runtime');
  assert.equal(await page.getByTestId('conversation-open-project').count(), 0, 'the unbound draft has no project-folder action');
  await defaultDraftProjectSelector.click();
  const defaultDraftProjectMenu = page.getByTestId('draft-project-menu');
  await defaultDraftProjectMenu.waitFor();
  assert.equal((await defaultDraftProjectMenu.getByRole('menuitem').first().innerText()).trim(), '新建项目', 'project dropdown starts with New project');
  const detachedProjectOption = defaultDraftProjectMenu.getByTestId('draft-project-detached');
  assert.equal(await detachedProjectOption.getAttribute('aria-checked'), 'true', 'the detached option is selected for a fresh conversation');
  const detachedActiveVisual = await detachedProjectOption.evaluate((element) => {
    const create = element.parentElement?.querySelector('[data-testid="draft-project-create"]');
    const check = element.querySelector('svg:last-child');
    const box = element.getBoundingClientRect();
    const checkBox = check?.getBoundingClientRect();
    const createBox = create?.getBoundingClientRect();
    return {
      background: getComputedStyle(element).backgroundColor,
      height: box.height,
      width: box.width,
      createHeight: createBox?.height,
      createWidth: createBox?.width,
      checkNearRight: checkBox ? box.right - checkBox.right <= 9 : false,
    };
  });
  assert.equal(detachedActiveVisual.height, detachedActiveVisual.createHeight, 'the selected detached option matches the New project row height');
  assert.equal(detachedActiveVisual.width, detachedActiveVisual.createWidth, 'the selected detached option matches the New project row width');
  assert.equal(detachedActiveVisual.checkNearRight, true, 'the selected detached option places its check at the far right');
  const detachedMenuLayering = await defaultDraftProjectMenu.evaluate((element) => {
    const composer = document.querySelector('.composer');
    if (!(composer instanceof HTMLElement)) throw new Error('missing composer for project-menu layering check');
    const menuBox = element.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    const probeY = Math.min(menuBox.bottom - 3, composerBox.top + 3);
    const topElement = document.elementFromPoint(menuBox.left + menuBox.width / 2, probeY);
    return {
      portalled: element.parentElement === document.body,
      overlapsComposer: menuBox.bottom > composerBox.top,
      ownsOverlap: topElement ? element.contains(topElement) : false,
    };
  });
  assert.equal(detachedMenuLayering.portalled, true, 'the project menu is portalled outside the scrolling conversation');
  assert.equal(detachedMenuLayering.overlapsComposer, true, 'the E2E fixture exercises the project menu across the composer boundary');
  assert.equal(detachedMenuLayering.ownsOverlap, true, 'the project menu remains above the composer in their overlap');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'draft-project-detached-selected-packaged.png' : 'draft-project-detached-selected.png') });
  assert.ok(await defaultDraftProjectMenu.getByTestId('draft-project-option').count() >= 1, 'recent projects remain available after entering the unbound draft');
  const originalProjectOption = defaultDraftProjectMenu.getByTitle(beforeLazyConversation.project.rootPath, { exact: true });
  const selectedDraftProjectName = (await originalProjectOption.locator('strong').innerText()).trim();
  await originalProjectOption.click();
  await page.getByTestId('hana-draft-hero').waitFor();
  await page.waitForFunction((projectName) => document.querySelector('[data-testid="draft-project-selector"]')?.textContent?.trim() === projectName, selectedDraftProjectName);
  await page.waitForFunction(() => !document.querySelector('.conversation-header__meta .mode-chip.offline') && !document.querySelector('.conversation-header__meta .preview-chip'));
  assert.equal(await page.evaluate(() => globalThis.__sciWorkplaceDocumentMarker), draftDocumentMarker, 'selecting a project keeps the renderer document mounted');
  assert.deepEqual(await connection(page), beforeDraftConnection, 'project selection is draft-local until the atomic first send');
  assert.equal((await page.getByTestId('draft-project-selector').innerText()).trim(), selectedDraftProjectName, 'selecting a project replaces the unbound label with its project name');
  assert.equal(await page.locator('.conversation-header__meta .mode-chip.offline').count(), 0, 'project selection reconnects before the restored draft is shown');
  assert.equal(await page.getByTestId('conversation-open-project').count(), 1, 'selecting a project restores its folder action');
  assert.equal(await page.getByTestId('draft-agent-selector').count(), 1, 'new conversation uses the HanaAgent-style Agent selector');
  const draftAgentOptions = page.getByTestId('draft-agent-option');
  assert.ok(await draftAgentOptions.count() >= 2, 'HanaAgent-style Agent choices are shown inline instead of in a dropdown');
  assert.equal(await page.getByTestId('draft-agent-menu').count(), 0, 'the Agent selector has no secondary dropdown');
  assert.equal(await page.locator('[data-testid="draft-agent-option"][aria-checked="true"]').count(), 1, 'exactly one inline Agent choice is active');
  const activeAgentOption = page.locator('[data-testid="draft-agent-option"][aria-checked="true"]');
  const inactiveAgentOption = page.locator('[data-testid="draft-agent-option"][aria-checked="false"]').first();
  const agentOptionStyles = await Promise.all([activeAgentOption, inactiveAgentOption].map((option) => option.evaluate((element) => {
    const style = getComputedStyle(element);
    return { height: element.getBoundingClientRect().height, color: style.color, borderColor: style.borderTopColor, background: style.backgroundColor, shadow: style.boxShadow };
  })));
  assert.ok(agentOptionStyles[0].height <= 28, 'draft Agent pills use the flatter requested height');
  assert.deepEqual(agentOptionStyles[0], agentOptionStyles[1], 'the selected Agent pill has no visual highlight');
  const originalAgentName = (await page.locator('[data-testid="draft-agent-option"][aria-checked="true"]').innerText()).trim();
  const replacementAgent = page.locator('[data-testid="draft-agent-option"][aria-checked="false"]').first();
  const replacementAgentName = (await replacementAgent.innerText()).trim();
  await replacementAgent.click();
  assert.equal((await page.getByTestId('hana-draft-hero').getByRole('heading').innerText()).includes(replacementAgentName), true, 'clicking an inline Agent pill switches the draft Agent immediately');
  await draftAgentOptions.filter({ hasText: originalAgentName }).first().click();
  const draftMemoryStatus = page.getByTestId('draft-memory-status');
  assert.equal((await draftMemoryStatus.innerText()).trim(), '记忆启用', 'new conversation displays the concise enabled-memory label');
  assert.equal(await draftMemoryStatus.getAttribute('aria-pressed'), 'true', 'the selected Agent starts with its own enabled memory policy');
  await draftMemoryStatus.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="draft-memory-status"]')?.getAttribute('aria-pressed') === 'false');
  assert.equal((await draftMemoryStatus.innerText()).trim(), '记忆停用', 'disabled memory uses the requested concise label');
  const memoryDisabledSnapshot = await snapshot(page);
  assert.equal(memoryDisabledSnapshot.agentDefinitions.find((agent) => agent.name === originalAgentName)?.memoryPolicy.memoryEnabled, false, 'the draft memory control updates the selected Agent, not a generic memory setting');
  await draftMemoryStatus.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="draft-memory-status"]')?.getAttribute('aria-pressed') === 'true');
  assert.equal(await page.locator('.conversation-pane.is-draft-conversation').count(), 1, 'new conversation activates the elevated HanaAgent composer layout');
  assert.equal(await page.getByTestId('composer-project-context').count(), 0, 'the draft composer also omits the redundant project context rail');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'hana-draft-packaged.png' : 'hana-draft.png') });
  const draftProjectSelector = page.getByTestId('draft-project-selector');
  await draftProjectSelector.waitFor();
  assert.equal((await draftProjectSelector.innerText()).trim(), selectedDraftProjectName, 'a bound draft displays the selected project name');
  await draftProjectSelector.click();
  const draftProjectMenu = page.getByTestId('draft-project-menu');
  await draftProjectMenu.waitFor();
  assert.equal((await draftProjectMenu.getByRole('menuitem').first().innerText()).trim(), '新建项目', 'project dropdown starts with New project');
  assert.ok(await draftProjectMenu.getByTestId('draft-project-option').count() >= 1, 'existing projects are listed below New project');
  const detachedInactiveVisual = await draftProjectMenu.evaluate((menu) => {
    const create = menu.querySelector('[data-testid="draft-project-create"]');
    const detached = menu.querySelector('[data-testid="draft-project-detached"]');
    const activeProject = menu.querySelector('[data-testid="draft-project-option"][aria-checked="true"]');
    const contentLeft = (element) => {
      const icon = element?.querySelector('svg:first-child');
      const label = element?.querySelector('span');
      return icon && label ? { icon: icon.getBoundingClientRect().left, label: label.getBoundingClientRect().left } : undefined;
    };
    if (!(create instanceof HTMLElement) || !(detached instanceof HTMLElement) || !(activeProject instanceof HTMLElement)) throw new Error('missing project menu rows');
    return {
      createHeight: create.getBoundingClientRect().height,
      detachedHeight: detached.getBoundingClientRect().height,
      createLeft: contentLeft(create),
      detachedLeft: contentLeft(detached),
      activeProjectBackground: getComputedStyle(activeProject).backgroundColor,
    };
  });
  assert.equal(detachedInactiveVisual.detachedHeight, detachedInactiveVisual.createHeight, 'the unselected detached option matches the New project row height');
  assert.ok(Math.abs(detachedInactiveVisual.detachedLeft.icon - detachedInactiveVisual.createLeft.icon) <= 1, 'detached and New project icons align');
  assert.ok(Math.abs(detachedInactiveVisual.detachedLeft.label - detachedInactiveVisual.createLeft.label) <= 1, 'detached and New project labels align');
  assert.equal(detachedInactiveVisual.activeProjectBackground, detachedActiveVisual.background, 'detached and existing project selections use the same theme highlight');
  const projectTriggerStyle = await draftProjectSelector.evaluate((element) => ({ border: getComputedStyle(element).borderTopWidth, shadow: getComputedStyle(element).boxShadow }));
  assert.equal(projectTriggerStyle.border, '0px', 'draft project status has no surrounding frame');
  assert.equal(projectTriggerStyle.shadow, 'none', 'draft project status has no card shadow');
  await draftProjectMenu.getByTestId('draft-project-create').click();
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

  await page.getByTestId('composer-permission').click();
  const draftPermissionMenu = page.getByTestId('permission-picker-menu');
  await draftPermissionMenu.waitFor();
  await draftPermissionMenu.getByRole('option', { name: '只读模式', exact: true }).click();
  await modelPicker.click();
  const draftModelMenu = page.getByTestId('model-picker-menu');
  await draftModelMenu.waitFor();
  await draftModelMenu.locator('[data-model-id="deepseek::deepseek-v4-flash"]').click();
  await page.evaluate((previousSessionId) => {
    const trace = [];
    const record = () => {
      const active = document.querySelector('.session-item.is-active');
      const state = {
        draft: Boolean(document.querySelector('.conversation-pane.is-draft-conversation')),
        activeSessionId: active instanceof HTMLElement ? active.dataset.sessionId ?? null : null,
        title: document.querySelector('[data-testid="conversation-header-meta"]')?.textContent?.trim() ?? '',
      };
      const prior = trace.at(-1);
      if (!prior || JSON.stringify(prior) !== JSON.stringify(state)) trace.push(state);
    };
    const observer = new MutationObserver(record);
    observer.observe(document.querySelector('.app-mode-chat') ?? document.body, { attributes: true, childList: true, subtree: true, characterData: true });
    record();
    window.__openlabDraftPromotionProbe = { observer, previousSessionId, trace };
  }, beforeLazyConversation.activeSessionId);
  await sendScenario(page, 'E2E_BASIC E2E_PERMISSION_READ_ONLY');
  await page.getByText('E2E_BASIC_DONE', { exact: true }).waitFor();
  await waitTurnIdle(page);

  const draftPromotionTrace = await page.evaluate(() => {
    const probe = window.__openlabDraftPromotionProbe;
    probe?.observer.disconnect();
    delete window.__openlabDraftPromotionProbe;
    return probe ? { previousSessionId: probe.previousSessionId, trace: probe.trace } : undefined;
  });
  assert.ok(draftPromotionTrace, 'draft promotion probe is installed');
  assert.equal(
    draftPromotionTrace.trace.some((state) => !state.draft && state.activeSessionId === draftPromotionTrace.previousSessionId),
    false,
    `first send must never flash or reselect the previous conversation: ${JSON.stringify(draftPromotionTrace.trace)}`,
  );

  const basicSnapshot = await snapshot(page);
  const permissionUserNode = basicSnapshot.timeline.findLast((node) => node.kind === 'user' && node.content.includes('E2E_PERMISSION_READ_ONLY'));
  assert.equal(permissionUserNode?.metadata.permissionMode, 'read_only', 'the selected permission mode reaches Runtime on the promoted draft turn');
  assert.equal((await page.getByTestId('composer-permission').getAttribute('title')).startsWith('只读模式'), true, 'permission selection survives draft-to-session promotion');
  await page.getByTestId('composer-permission').click();
  await page.getByTestId('permission-picker-menu').getByRole('option', { name: '自动审核', exact: true }).click();
  assert.equal(basicSnapshot.sessions.length, beforeLazyConversation.sessions.length + 1, 'the first sent message creates exactly one session');
  assert.notEqual(basicSnapshot.activeSessionId, beforeLazyConversation.activeSessionId, 'the newly created session becomes active after first send');
  const promotedConnection = await connection(page);
  assert.equal(promotedConnection.projectRoot.toLocaleLowerCase(), beforeLazyConversation.project.rootPath.toLocaleLowerCase(), 'the atomic first send commits the selected project Runtime');
  assert.equal(promotedConnection.projectFolderSelected, true, 'the promoted session is bound to the selected project');
  assert.equal(basicSnapshot.sessions.find((session) => session.id === basicSnapshot.activeSessionId)?.model, 'deepseek::deepseek-v4-flash', 'draft promotion persists the selected non-default model on the session');
  const promotedComposerModel = await page.getByTestId('model-picker').innerText();
  assert.match(promotedComposerModel, /DeepSeek V4 Flash/iu, `draft promotion preserves the selected model in the composer; rendered ${JSON.stringify(promotedComposerModel)}, models ${JSON.stringify(basicSnapshot.models.map((model) => model.id))}`);

  const projectCatalogSessionId = basicSnapshot.activeSessionId;
  await page.getByTestId('new-conversation').click();
  await page.getByTestId('hana-draft-hero').waitFor();
  assert.equal((await page.getByTestId('draft-project-selector').innerText()).trim(), '不在项目中工作');
  await page.getByTestId('model-picker').click();
  await page.getByTestId('model-picker-menu').locator('[data-model-id="deepseek::deepseek-v4-flash"]').click();
  const detachedPromotionStartedAt = Date.now();
  await sendScenario(page, 'E2E_CATALOG_DETACHED');
  await page.getByText('E2E_BASIC_DONE', { exact: true }).last().waitFor();
  await waitTurnIdle(page);
  const detachedSnapshot = await snapshot(page);
  const detachedCatalogSessionId = detachedSnapshot.activeSessionId;
  assert.equal(detachedSnapshot.project.id === basicSnapshot.project.id, false, 'detached and project conversations use separate Runtime projects');
  assert.ok(detachedSnapshot.sessionCatalog?.some((session) => session.id === projectCatalogSessionId), 'switching to a detached conversation must retain project conversations in the global catalog');
  assert.ok(detachedSnapshot.sessionCatalog?.some((session) => session.id === detachedCatalogSessionId), 'the detached conversation is added to the global catalog');
  await page.locator(`.sidebar-project-sessions .session-item[data-session-id="${projectCatalogSessionId}"]`).waitFor();
  const detachedSessionRow = page.locator(`.sidebar-section-sessions .session-item[data-session-id="${detachedCatalogSessionId}"]`);
  await detachedSessionRow.waitFor();
  const detachedMetadataParts = (await detachedSessionRow.locator('.session-item__copy small').innerText()).split(' · ');
  assert.deepEqual(detachedMetadataParts.length, 2, 'detached conversation metadata contains only Agent and relative time');
  assert.equal(detachedMetadataParts[0], detachedSnapshot.primaryAgent.name, 'detached conversation metadata still starts with its Agent name');
  assert.equal(detachedMetadataParts.includes('不在项目中工作'), false, 'detached conversation rows omit the redundant no-project label');
  assert.ok(Date.now() - detachedPromotionStartedAt < 20_000, 'a prewarmed conversation target should not incur a long Runtime cold-start delay');

  const warmProjectSwitchStartedAt = Date.now();
  await page.locator(`.sidebar-project-sessions .session-item[data-session-id="${projectCatalogSessionId}"] .session-item__main`).click();
  const restoredProjectSnapshot = await waitFor(async () => {
    const state = await snapshot(page);
    return state.activeSessionId === projectCatalogSessionId ? state : undefined;
  });
  assert.ok(Date.now() - warmProjectSwitchStartedAt < 4_000, 'returning to a cached project Runtime should complete without a cold child-process restart');
  assert.ok(restoredProjectSnapshot.sessionCatalog?.some((session) => session.id === detachedCatalogSessionId), 'switching back to a project conversation must retain detached conversations');
  assert.equal((await connection(page)).projectFolderSelected, true, 'cross-project sidebar navigation restores the owning project Runtime');
  await page.locator(`.sidebar-section-sessions .session-item[data-session-id="${detachedCatalogSessionId}"]`).waitFor();

  const warmDetachedSwitchStartedAt = Date.now();
  await page.locator(`.sidebar-section-sessions .session-item[data-session-id="${detachedCatalogSessionId}"] .session-item__main`).click();
  let lastDetachedSwitchObservation;
  try {
    await waitFor(async () => {
      const target = await connection(page);
      const state = await snapshot(page);
      lastDetachedSwitchObservation = { target, activeSessionId: state.activeSessionId, projectId: state.project.id };
      return state.activeSessionId === detachedCatalogSessionId ? true : undefined;
    });
  } catch (cause) {
    throw new Error(`cached detached switch did not settle: expected ${detachedCatalogSessionId}, observed ${JSON.stringify(lastDetachedSwitchObservation)}`, { cause });
  }
  assert.ok(Date.now() - warmDetachedSwitchStartedAt < 4_000, 'returning to the cached detached Runtime should complete without a cold child-process restart');
  await page.locator(`.sidebar-project-sessions .session-item[data-session-id="${projectCatalogSessionId}"] .session-item__main`).click();
  let lastProjectSwitchObservation;
  try {
    await waitFor(async () => {
      const target = await connection(page);
      const state = await snapshot(page);
      lastProjectSwitchObservation = { target, activeSessionId: state.activeSessionId, projectId: state.project.id };
      return state.activeSessionId === projectCatalogSessionId ? true : undefined;
    });
  } catch (cause) {
    throw new Error(`cached project switch did not settle: expected ${projectCatalogSessionId}, observed ${JSON.stringify(lastProjectSwitchObservation)}`, { cause });
  }

  const explicitlyBoundTeam = await runtimeJson(page, `/api/sessions/${encodeURIComponent(basicSnapshot.activeSessionId)}/agents`, {
    leadAgentId: basicSnapshot.sessionAgentBinding.leadAgentId,
    memberAgentIds: persistentMemberIds,
  }, 'PUT');
  assert.equal(explicitlyBoundTeam.memberAgentIds.length, 3, 'multi-Agent delegation requires explicit membership in each independent conversation');
  const basicVariants = basicSnapshot.turnVariants.at(-1);
  assert.ok(basicVariants, 'the first completed answer must have a variant group');
  const originalBasicVariantId = basicVariants.activeVariantId;
  const basicUserMessage = page.locator('.user-message').filter({ hasText: 'E2E_PERMISSION_READ_ONLY' }).last();
  const basicUserActions = basicUserMessage.getByTestId('user-message-actions');
  assert.equal(await basicUserActions.evaluate((element) => getComputedStyle(element).opacity), '0', 'user message actions remain hidden before hover');
  assert.deepEqual(await basicUserActions.getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))), ['复制', '编辑消息', '重新生成']);
  const userActionGeometry = await basicUserMessage.evaluate((message) => {
    const bubble = message.querySelector('.user-message__bubble');
    const actions = message.querySelector('.user-message__meta');
    if (!(bubble instanceof HTMLElement) || !(actions instanceof HTMLElement)) throw new Error('missing user message action row');
    return { bubbleBottom: bubble.getBoundingClientRect().bottom, actionsTop: actions.getBoundingClientRect().top };
  });
  assert.ok(userActionGeometry.actionsTop >= userActionGeometry.bubbleBottom, 'user actions render below the message bubble');
  await basicUserMessage.hover();
  await waitFor(async () => await basicUserActions.evaluate((element) => getComputedStyle(element).opacity) === '1' ? true : undefined);
  assert.equal(await basicUserActions.evaluate((element) => getComputedStyle(element).opacity), '1', 'hover reveals user message actions');
  const userMessageVisual = await basicUserMessage.evaluate((message) => {
    const bubble = message.querySelector('.user-message__bubble');
    const actions = message.querySelector('.user-message__meta');
    if (!(bubble instanceof HTMLElement) || !(actions instanceof HTMLElement)) throw new Error('missing user message visual elements');
    const bubbleStyle = getComputedStyle(bubble);
    const actionStyle = getComputedStyle(actions);
    return {
      actionTag: actions.tagName,
      actionHeight: actions.getBoundingClientRect().height,
      actionBackground: actionStyle.backgroundColor,
      actionBorder: actionStyle.borderTopWidth,
      actionShadow: actionStyle.boxShadow,
      bubbleBorder: bubbleStyle.borderTopWidth,
      bubbleShadow: bubbleStyle.boxShadow,
      bubbleFontWeight: bubbleStyle.fontWeight,
    };
  });
  assert.equal(userMessageVisual.actionTag, 'FOOTER', 'the action row avoids legacy message-bubble selectors');
  assert.ok(userMessageVisual.actionHeight <= 22, 'the action row stays compact');
  assert.ok(['rgba(0, 0, 0, 0)', 'transparent'].includes(userMessageVisual.actionBackground), 'the action row has no background panel');
  assert.equal(userMessageVisual.actionBorder, '0px', 'the action row has no frame');
  assert.equal(userMessageVisual.actionShadow, 'none', 'the action row has no shadow');
  assert.equal(userMessageVisual.bubbleBorder, '0px', 'the user bubble is borderless');
  assert.equal(userMessageVisual.bubbleShadow, 'none', 'the user bubble has no shadow');
  assert.equal(userMessageVisual.bubbleFontWeight, '400', 'the user message uses regular font weight');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'user-message-actions-packaged.png' : 'user-message-actions.png') });
  assert.equal(await page.evaluate(() => window.openlab.writeClipboardText('E2E_CLIPBOARD_PROBE')), true, 'desktop clipboard bridge accepts writes');
  await basicUserActions.getByTestId('user-message-copy').click();
  await page.waitForTimeout(50);
  assert.equal(await page.getByRole('alert').filter({ hasText: 'Invalid clipboard text' }).count(), 0, 'copy action reaches the desktop clipboard bridge without an application error');
  await basicUserActions.getByTestId('user-message-regenerate').click();
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

  await basicUserMessage.hover();
  await basicUserActions.getByTestId('user-message-edit').click();
  const composerInputAfterEdit = page.locator('.app-mode-chat [data-testid="composer-input"]');
  await page.waitForFunction(() => document.querySelector('.app-mode-chat [data-testid="composer-input"]')?.value === 'E2E_BASIC E2E_PERMISSION_READ_ONLY');
  assert.equal(await composerInputAfterEdit.inputValue(), 'E2E_BASIC E2E_PERMISSION_READ_ONLY', 'edit action restores the original user text in the composer');
  await page.getByTestId('composer-editing-message').waitFor();
  await composerInputAfterEdit.fill('E2E_BASIC_EDITED');
  await page.getByTestId('send-message').click();
  await page.locator('.user-message').filter({ hasText: 'E2E_BASIC_EDITED' }).last().waitFor();
  await page.getByText('E2E_BASIC_DONE', { exact: true }).last().waitFor();
  await waitTurnIdle(page);
  const editedSnapshot = await snapshot(page);
  assert.notEqual(editedSnapshot.activeSessionId, basicSnapshot.activeSessionId, 'editing creates a causal conversation branch');
  assert.equal(editedSnapshot.timeline.some((node) => node.kind === 'user' && node.content === 'E2E_BASIC_EDITED'), true, 'edited text is submitted in the new branch');
  assert.equal(editedSnapshot.timeline.some((node) => node.kind === 'user' && node.content.includes('E2E_PERMISSION_READ_ONLY')), false, 'the replaced user message is excluded from the edit branch');
  assert.equal(await page.getByTestId('composer-editing-message').count(), 0, 'editing state clears after a successful send');

  await sendScenario(page, 'E2E_THINKING_UI');
  const thinkingDots = page.getByTestId('reasoning-generation-dots').last();
  await thinkingDots.waitFor({ state: 'visible' });
  const stopButtonVisual = await page.getByTestId('cancel-turn').evaluate((button) => ({
    background: getComputedStyle(button).backgroundColor,
    color: getComputedStyle(button).color,
    radius: getComputedStyle(button).borderRadius,
    usesSquare: button.querySelector('svg')?.classList.contains('lucide-square') ?? false,
  }));
  assert.equal(stopButtonVisual.background, 'rgb(255, 255, 255)', 'the running stop control keeps the GPT-like white circular surface');
  assert.equal(stopButtonVisual.color, 'rgb(17, 24, 20)', 'the stop glyph keeps the same quiet dark treatment as send');
  assert.equal(stopButtonVisual.radius, '50%', 'the stop control is circular');
  assert.equal(stopButtonVisual.usesSquare, true, 'the running state uses a square stop glyph');
  const liveThought = thinkingDots.locator('xpath=ancestor::details[1]');
  assert.equal((await liveThought.locator('summary').innerText()).includes('思考中'), true, 'active reasoning uses the 思考中 label');
  assert.equal(await liveThought.getAttribute('open'), '', 'active reasoning opens automatically so live content is visible');
  assert.equal((await thinkingDots.innerText()).trim(), '', 'the ellipsis itself is rendered as animated dots rather than text');
  assert.equal(await thinkingDots.locator('i').count(), 3, 'active thinking uses a three-dot generation indicator');
  await liveThought.getByText('正在验证思考区视觉层级。', { exact: true }).waitFor();
  await liveThought.locator('summary').click();
  assert.equal(await liveThought.getAttribute('open'), null, 'active reasoning can be collapsed while generation continues');
  await liveThought.locator('summary').click();
  assert.equal(await liveThought.getAttribute('open'), '', 'active reasoning can be expanded again while generation continues');
  const liveThoughtLayout = await thinkingDots.evaluate((dots) => {
    const message = dots.closest('.assistant-message--reasoning');
    const header = message?.querySelector(':scope > header');
    if (!(header instanceof HTMLElement) || !(dots instanceof HTMLElement)) throw new Error('missing Hana-style thought layout');
    return { headerBottom: header.getBoundingClientRect().bottom, dotsTop: dots.getBoundingClientRect().top };
  });
  assert.ok(liveThoughtLayout.dotsTop >= liveThoughtLayout.headerBottom, 'thinking dots render below the Agent avatar and name');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'thinking-dots-packaged.png' : 'thinking-dots.png') });
  await page.getByText('E2E_THINKING_UI_DONE', { exact: true }).waitFor();
  await waitTurnIdle(page);
  const completedThought = page.locator('.assistant-message--reasoning').filter({ has: page.locator('.reasoning-block') }).last();
  assert.equal((await completedThought.locator('.reasoning-block summary').innerText()).includes('思考完成'), true, 'completed thought remains below its Agent header');
  assert.equal(await completedThought.locator('.reasoning-block').getAttribute('open'), '', 'completed reasoning keeps the expansion state from generation');
  const completedThoughtLayout = await completedThought.evaluate((message) => {
    const header = message.querySelector(':scope > header');
    const reasoning = message.querySelector(':scope > .reasoning-block');
    if (!(header instanceof HTMLElement) || !(reasoning instanceof HTMLElement)) throw new Error('missing completed thought layout');
    return { headerBottom: header.getBoundingClientRect().bottom, reasoningTop: reasoning.getBoundingClientRect().top };
  });
  assert.ok(completedThoughtLayout.reasoningTop >= completedThoughtLayout.headerBottom, 'completed thought remains below the Agent avatar and name');

  const conversationLocator = page.getByTestId('conversation-locator');
  await conversationLocator.waitFor({ state: 'visible' });
  const locatorTrigger = page.getByTestId('conversation-locator-trigger');
  assert.equal(await locatorTrigger.getAttribute('data-state'), 'closed', 'the conversation locator starts closed');
  assert.ok(Number(await locatorTrigger.evaluate((element) => getComputedStyle(element).opacity)) < .05, 'the locator rail is invisible while the pointer is away');
  await conversationLocator.hover();
  await page.waitForFunction(() => document.querySelector('[data-testid="conversation-locator-trigger"]')?.getAttribute('data-state') === 'open');
  await page.waitForFunction(() => {
    const rail = document.querySelector('[data-testid="conversation-locator-trigger"]');
    return rail instanceof HTMLElement && Number(getComputedStyle(rail).opacity) > .95;
  });
  assert.ok(Number(await locatorTrigger.evaluate((element) => getComputedStyle(element).opacity)) > .95, 'moving to the conversation edge reveals the locator');
  const locatorTicks = page.getByTestId('conversation-locator-tick');
  assert.equal(await locatorTicks.count(), await page.locator('.user-message').count(), 'the rail contains one clickable position for every visible user message');
  await locatorTicks.first().hover();
  assert.ok((await locatorTicks.first().getAttribute('class'))?.includes('is-active'), 'the locator highlight follows the pointer over a position');
  if (await locatorTicks.count() > 1) {
    await locatorTicks.nth(1).hover();
    assert.ok((await locatorTicks.nth(1).getAttribute('class'))?.includes('is-active'), 'moving the pointer transfers the locator highlight');
    const firstTickClass = await locatorTicks.first().getAttribute('class');
    assert.ok(!firstTickClass?.includes('is-active'), 'the old locator position is no longer highlighted');
  }
  const locatorItems = page.getByTestId('conversation-locator-item');
  assert.equal(await locatorItems.count(), await page.locator('.user-message').count(), 'the locator contains one concise entry for every visible user message');
  const timelineScroller = page.locator('.timeline-scroll');
  const firstLocatedMessage = page.locator('.user-message').first();
  await locatorTicks.last().click();
  await page.waitForFunction(() => {
    const items = [...document.querySelectorAll('[data-testid="conversation-locator-item"]')];
    return items.at(-1)?.getAttribute('aria-current') === 'location';
  });
  await locatorItems.first().click();
  await page.waitForFunction(() => {
    const scroller = document.querySelector('.timeline-scroll');
    const message = document.querySelector('.user-message');
    if (!(scroller instanceof HTMLElement) || !(message instanceof HTMLElement)) return false;
    return Math.abs(message.getBoundingClientRect().top - scroller.getBoundingClientRect().top) <= 30;
  });
  assert.equal(await locatorItems.first().getAttribute('aria-current'), 'location', 'clicking a locator entry marks and reveals that user message');
  assert.ok(await timelineScroller.evaluate((element) => element.scrollTop) >= 0 && await firstLocatedMessage.isVisible(), 'locator navigation keeps the selected message visible');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'conversation-locator-packaged.png' : 'conversation-locator.png') });
  await timelineScroller.hover({ position: { x: 180, y: 100 } });
  await page.waitForFunction(() => document.querySelector('[data-testid="conversation-locator-trigger"]')?.getAttribute('data-state') === 'closed');
  await page.waitForFunction(() => {
    const rail = document.querySelector('[data-testid="conversation-locator-trigger"]');
    return rail instanceof HTMLElement && Number(getComputedStyle(rail).opacity) < .05;
  });
  assert.ok(Number(await locatorTrigger.evaluate((element) => getComputedStyle(element).opacity)) < .05, 'moving away hides the locator rail and outline again');

  await sendScenario(page, 'E2E_TOOL_BATCH');
  await page.getByText('E2E_TOOL_BATCH_DONE', { exact: true }).waitFor();
  await waitTurnIdle(page);
  const toolBatch = page.getByTestId('tool-batch').filter({ hasText: '2 个工具' }).last();
  await toolBatch.waitFor();
  assert.equal(await toolBatch.getAttribute('open'), null, 'a completed multi-tool batch starts collapsed');
  const replyContent = page.locator('.assistant-message .message-content').filter({ hasText: 'E2E_TOOL_BATCH_DONE' }).last();
  const replyWidth = await replyContent.evaluate((element) => element.getBoundingClientRect().width);
  const collapsedSummaryWidth = await toolBatch.locator(':scope > summary').evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(collapsedSummaryWidth < replyWidth * .5, 'the collapsed tool header stops close to its label instead of filling the reply width');
  const collapsedBatchHeight = await toolBatch.evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(collapsedBatchHeight <= 36, 'the collapsed tool batch stays compact like the video reference');
  await toolBatch.locator(':scope > summary').click();
  const expandedPanelWidth = await toolBatch.locator(':scope > .tool-batch__items').evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(Math.abs(expandedPanelWidth - replyWidth) <= 2, 'the expanded tool panel uses the same width as an assistant reply');
  assert.equal(await toolBatch.locator('.tool-batch__item').count(), 2, 'expanding the batch reveals one compact row per tool');
  const toolRowHeights = await toolBatch.locator('.tool-batch__item > summary').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  assert.equal(toolRowHeights.every((height) => height <= 36), true, 'expanded tool rows stay single-line and compact');
  const firstToolRow = toolBatch.locator('.tool-batch__item').first();
  const toolRowSummaryWidth = await firstToolRow.locator(':scope > summary').evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(toolRowSummaryWidth < replyWidth * .7, 'each collapsed tool row remains content-sized inside the expanded panel');
  await firstToolRow.locator(':scope > summary').click();
  const toolDetailWidth = await firstToolRow.locator(':scope > pre').evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(Math.abs(toolDetailWidth - replyWidth) <= 10, 'opening a tool reveals a full reply-width detail box below its compact header');
  assert.equal(await toolBatch.locator('.tool-batch__status.completed').count(), 2, 'each completed tool keeps its status indicator');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'tool-batch-packaged.png' : 'tool-batch.png') });
  await toolBatch.locator(':scope > summary').click();

  const authorizedRoot = await runtimeJson(page, '/api/workspace/roots', { path: externalRoot, access: 'ask', confirmed: true });
  assert.equal(authorizedRoot.kind, 'authorized');
  await runtimeJson(page, '/api/workspace/note', { note: 'E2E session note: keep provenance explicit.' });
  const createdWorkspaceFile = await runtimeJson(page, '/api/workspace/files/operate', {
    operation: { type: 'create_file', target: { rootId: authorizedRoot.id, path: 'workspace-e2e.md' }, content: '# Workspace E2E\nrestorable' },
  });
  const preview = await runtimeJson(page, '/api/workspace/preview', { rootId: authorizedRoot.id, path: 'workspace-e2e.md' });
  assert.equal(preview.kind, 'text');
  await runtimeJson(page, '/api/workspace/conversation-files', { ref: { rootId: authorizedRoot.id, path: 'workspace-e2e.md' }, origin: 'reference' });
  const richPreviewKinds = [
    ['preview.png', 'image'],
    ['preview.pdf', 'pdf'],
    ['preview.docx', 'word'],
  ];
  for (const [path, kind] of richPreviewKinds) {
    const richPreview = await runtimeJson(page, '/api/workspace/preview', { rootId: authorizedRoot.id, path });
    assert.equal(richPreview.kind, kind, `${path} exposes its native right-panel preview kind`);
    await runtimeJson(page, '/api/workspace/conversation-files', { ref: { rootId: authorizedRoot.id, path }, origin: 'reference' });
  }
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
  if (await page.getByTestId('workspace-tab-files').count() === 0) {
    await page.getByTestId('workspace-panel-launcher').waitFor();
    await page.getByTestId('workspace-panel-option-workspace').click();
    await page.getByTestId('workspace-tab-files').waitFor();
  }
  await page.getByTestId('workspace-tab-files').click();
  const conversationFileRow = page.locator('.conversation-files article').filter({ hasText: 'workspace-e2e.md' });
  await conversationFileRow.waitFor();
  await conversationFileRow.getByTitle('预览').click();
  const workspacePreviewDeck = page.getByTestId('workspace-preview-deck');
  await workspacePreviewDeck.waitFor();
  await workspacePreviewDeck.locator('.workspace-markdown-preview h1').filter({ hasText: 'Workspace E2E' }).waitFor();
  assert.equal(await workspacePreviewDeck.locator('[role="tab"]').count(), 1, 'opening a workspace file creates a GPT-style preview tab');
  assert.equal((await workspacePreviewDeck.locator('[role="tab"]').innerText()).includes('workspace-e2e.md'), true, 'the preview tab keeps the file name');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'workspace-preview-markdown-packaged.png' : 'workspace-preview-markdown.png') });
  await workspacePreviewDeck.getByLabel('新增预览').click();
  assert.deepEqual(await workspacePreviewDeck.locator('[role="menuitem"]').allTextContents(), ['选择文件', '新建浏览器', '终端'], 'the preview plus menu exposes files, the safe browser, and a project terminal');
  await workspacePreviewDeck.getByLabel('新增预览').click();
  await workspacePreviewDeck.locator('[role="tab"] > i').click();
  await workspacePreviewDeck.waitFor({ state: 'detached' });

  const imageFileRow = page.locator('.conversation-files article').filter({ hasText: 'preview.png' });
  await imageFileRow.getByTitle('预览').click();
  await page.getByTestId('workspace-preview-image').locator('.workspace-image-canvas img').waitFor();
  assert.equal(await page.getByTestId('workspace-preview-image').locator('.workspace-preview-toolbar').isVisible(), true, 'image preview exposes local zoom controls');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'workspace-preview-image-packaged.png' : 'workspace-preview-image.png') });
  await page.getByTestId('workspace-preview-deck').locator('[role="tab"] > i').click();

  const pdfFileRow = page.locator('.conversation-files article').filter({ hasText: 'preview.pdf' });
  await pdfFileRow.getByTitle('预览').click();
  const pdfCanvas = page.getByTestId('workspace-preview-pdf').locator('canvas');
  await pdfCanvas.waitFor();
  await waitFor(async () => await pdfCanvas.evaluate((canvas) => canvas.width > 0 && canvas.height > 0 ? true : undefined));
  assert.equal((await page.getByTestId('workspace-preview-pdf').innerText()).includes('1 / 1'), true, 'PDF preview renders pages with pagination');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'workspace-preview-pdf-packaged.png' : 'workspace-preview-pdf.png') });
  await page.getByTestId('workspace-preview-deck').locator('[role="tab"] > i').click();

  const wordFileRow = page.locator('.conversation-files article').filter({ hasText: 'preview.docx' });
  await wordFileRow.getByTitle('预览').click();
  await page.getByTestId('workspace-preview-word').getByText('Word Preview', { exact: true }).waitFor();
  assert.equal((await page.getByTestId('workspace-preview-word').innerText()).includes('Local DOCX rendering works.'), true, 'Word preview is converted locally into readable document content');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'workspace-preview-word-packaged.png' : 'workspace-preview-word.png') });
  await page.getByTestId('workspace-preview-deck').locator('[role="tab"] > i').click();

  await page.getByLabel('新建浏览器').click();
  const browserPreviewDeck = page.getByTestId('workspace-preview-deck');
  await browserPreviewDeck.getByTestId('workspace-browser-preview').waitFor();
  const browserSession = await waitFor(async () => {
    const state = await snapshot(page);
    return state.browserSessions.find((session) => session.paneId && session.url === 'about:blank');
  });
  assert.equal(await browserPreviewDeck.locator('input[aria-label="浏览器地址"]').inputValue(), '', 'browser preview starts with GPT-style empty URL input instead of exposing about:blank');
  await browserPreviewDeck.getByText('开始浏览', { exact: true }).waitFor();
  assert.equal((await browserPreviewDeck.innerText()).includes('输入 URL 以打开页面'), true, 'blank browser tab keeps the themed GPT-style start state');
  for (const label of ['后退', '前进', '刷新', '更多']) assert.equal(await browserPreviewDeck.getByLabel(label).count(), 1, `browser chrome exposes ${label}`);
  const browserViewport = await browserPreviewDeck.locator('.workspace-browser-viewport').boundingBox();
  assert.ok(browserViewport && browserViewport.width > 100 && browserViewport.height > 100, 'native browser view receives a stable right-panel viewport');
  await page.screenshot({ path: join(artifactRoot, packaged ? 'workspace-preview-browser-packaged.png' : 'workspace-preview-browser.png') });
  await browserPreviewDeck.locator('[role="tab"] > i').click();
  await browserPreviewDeck.waitFor({ state: 'detached' });
  await waitFor(async () => {
    const state = await snapshot(page);
    return state.browserSessions.some((session) => session.id === browserSession.id) ? undefined : true;
  });

  await page.getByLabel('终端').click();
  const terminalPreview = page.getByTestId('workspace-terminal-preview');
  await terminalPreview.waitFor();
  await waitFor(async () => await terminalPreview.getAttribute('data-status') === 'running' ? true : undefined);
  await page.screenshot({ path: join(artifactRoot, packaged ? 'workspace-preview-terminal-packaged.png' : 'workspace-preview-terminal.png') });
  const terminalId = await terminalPreview.getAttribute('data-terminal-id');
  assert.equal(typeof terminalId, 'string', 'terminal preview owns an isolated local session id');
  const terminalInput = terminalPreview.locator('.xterm-helper-textarea');
  await terminalInput.focus();
  await terminalInput.pressSequentially('echo OPENLAB_PREVIEW_TERMINAL');
  await terminalInput.press('Enter');
  await waitFor(async () => {
    const output = await runtimeJson(page, `/api/terminal/previews/${encodeURIComponent(terminalId)}`, { action: 'read', afterSequence: 0 });
    return output.chunks?.some((chunk) => typeof chunk.data === 'string' && chunk.data.includes('OPENLAB_PREVIEW_TERMINAL')) ? true : undefined;
  });
  await page.getByTestId('workspace-preview-deck').locator('[role="tab"] > i').click();
  await page.getByTestId('workspace-preview-deck').waitFor({ state: 'detached' });
  await waitFor(async () => {
    const output = await runtimeJson(page, `/api/terminal/previews/${encodeURIComponent(terminalId)}`, { action: 'read', afterSequence: 0 });
    return output.session?.status === 'cancelled' ? true : undefined;
  });
  await conversationFileRow.getByTitle('从本次对话移除').click();
  await conversationFileRow.waitFor({ state: 'detached' });
  assert.equal(existsSync(join(externalRoot, 'workspace-e2e.md')), true, 'removing a conversation-file reference must not delete the underlying workspace file');
  await page.getByTestId('workspace-tab-workspace').click();

  await sendScenario(page, 'E2E_WRITE_UNDO');
  await approveNext(page);
  await approveNext(page);
  await page.getByText('E2E_WRITE_UNDO_DONE', { exact: true }).waitFor();
  await waitTurnIdle(page);
  assert.equal(existsSync(join(projectRoot, 'e2e-change.txt')), false, 'undo must restore the pre-write state');
  const writeUndoSnapshot = await snapshot(page);
  const writeUndoTurnId = [...writeUndoSnapshot.timeline].reverse().find((node) => node.kind === 'user' && node.content === 'E2E_WRITE_UNDO')?.metadata?.turnId;
  assert.equal(typeof writeUndoTurnId, 'string', 'the multi-step tool response retains one causal turn id');
  const writeUndoIdentity = await page.evaluate(({ timeline, turnId }) => {
    const ids = timeline
      .filter((node) => node.metadata?.turnId === turnId && (node.kind === 'reasoning' || node.kind === 'assistant'))
      .map((node) => node.id);
    return ids.reduce((counts, id) => {
      const message = document.querySelector(`.assistant-message[data-node-id="${CSS.escape(id)}"]`);
      counts.headers += message?.querySelectorAll(':scope > header').length ?? 0;
      counts.avatars += message?.querySelectorAll(':scope > header .agent-avatar-visual').length ?? 0;
      counts.names += message?.querySelectorAll(':scope > header strong').length ?? 0;
      return counts;
    }, { headers: 0, avatars: 0, names: 0 });
  }, { timeline: writeUndoSnapshot.timeline, turnId: writeUndoTurnId });
  assert.deepEqual(writeUndoIdentity, { headers: 1, avatars: 1, names: 1 }, 'one reply shows the Agent avatar and name only once across tool-call continuations');

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
      sessionAvatarCount: document.querySelectorAll('.session-item .agent-avatar-visual').length,
      avatar: (() => {
        const element = document.querySelector('.agent-avatar-visual:not([data-avatar="custom"])');
        if (!element) throw new Error('missing built-in Agent avatar');
        const style = getComputedStyle(element);
        return `${style.backgroundColor}|${style.backgroundImage}`;
      })(),
    };
  });
  assert.ok(semanticVisuals.sessionAvatarCount > 0, 'compact session rows preserve the assigned Agent identity');
  for (const [name, background] of Object.entries(semanticVisuals).filter(([name]) => !['avatar', 'sessionAvatarCount'].includes(name))) {
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
  assert.equal(await page.getByTestId('toggle-archived').count(), 0, 'the sidebar header omits the redundant archive icon');
  await page.getByTestId('sidebar-search-toggle').click();
  await page.locator('.session-search input').fill(forkTitle);
  const archivedSearchResult = page.locator(`.session-item[data-session-id="${forkId}"]`);
  await archivedSearchResult.waitFor();
  await archivedSearchResult.getByTestId(`session-archive-${forkId}`).click();
  await waitFor(async () => (await snapshot(page)).sessions.find((session) => session.id === forkId)?.status !== 'archived');
  await page.getByTestId('sidebar-search-toggle').click();

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
  assert.equal(restored.userProfile?.name, 'E2E 用户');
  assert.equal(restored.userProfile?.profile, '偏好先看结论与证据，请使用中文回答。');
  assert.ok(restored.userProfile?.avatar?.startsWith('data:image/webp;base64,'));
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
  assert.equal(restored.workspace.roots.some((root) => root.kind === 'project' && root.displayPath.toLocaleLowerCase() === additionalProjectRoot.toLocaleLowerCase()), true, 'project folder bindings survive an application restart');
  assert.equal(restored.workspace.roots.some((root) => root.id === authorizedRoot.id && root.status === 'online'), true, 'the original session authorization must survive restart');
  assert.equal(restored.conversationFiles.some((item) => item.ref.rootId === authorizedRoot.id && item.ref.path === 'workspace-e2e.md'), false, 'removed conversation-file references stay removed after restart');
  assert.deepEqual(readFileSync(join(projectRoot, 'e2e-paper.pdf')), pdfFixture, 'paper reading keeps the original project PDF byte-for-byte unchanged');
  assert.deepEqual(readFileSync(join(externalRoot, 'preview.pdf')), pdfFixture, 'workspace preview keeps external PDFs byte-for-byte unchanged');
  assert.equal(readFileSync(join(externalRoot, 'external-evidence.md'), 'utf8'), '# External evidence\ntraceable', 'external evidence files remain unchanged');
  assert.equal(readFileSync(join(additionalProjectRoot, 'dataset-notes.md'), 'utf8'), '# Bound dataset folder\nproject-wide', 'additional project roots remain unchanged');
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
