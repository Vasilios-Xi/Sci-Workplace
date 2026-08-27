import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRequire = createRequire(join(workspaceRoot, 'apps', 'desktop', 'package.json'));
const electronPath = desktopRequire('electron');
const mainEntry = resolve(workspaceRoot, 'apps', 'desktop', 'dist', 'main.js');
const artifactRoot = resolve(workspaceRoot, 'artifacts', 'live-qa');
const scratchRoot = resolve(artifactRoot, `write-probe-${Date.now()}`);
const modelId = 'chatgpt-oauth::gpt-5.3-codex-spark';

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

async function runtimeRaw(page, path, body, method = 'POST') {
  const target = await connection(page);
  const response = await fetch(`${target.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${target.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ok: response.ok, status: response.status, payload: await response.json() };
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
    await pause(150);
  }
  throw lastError ?? new Error(`Condition timed out after ${timeoutMs}ms`);
}

async function waitForIdle(page, sessionId, timeoutMs = 120_000) {
  return await waitFor(async () => {
    const state = await snapshot(page);
    const session = state.sessions.find((candidate) => candidate.id === sessionId);
    const leadRunning = state.agentRuns.some((run) => run.role === 'lead' && run.status === 'running');
    const sendVisible = await page.getByTestId('send-message').count() === 1;
    return session && session.status !== 'running' && !leadRunning && sendVisible ? state : undefined;
  }, timeoutMs);
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

async function send(page, text) {
  const input = page.locator('.app-mode-chat [data-testid="composer-input"]');
  await input.fill(text);
  try {
    await page.waitForFunction(() => {
      const button = document.querySelector('.app-mode-chat [data-testid="send-message"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    }, undefined, { timeout: 10_000 });
  } catch (error) {
    const state = await page.evaluate(() => {
      const button = document.querySelector('.app-mode-chat [data-testid="send-message"]');
      const textarea = document.querySelector('.app-mode-chat [data-testid="composer-input"]');
      const composer = document.querySelector('.app-mode-chat .composer');
      return {
        buttonExists: button instanceof HTMLButtonElement,
        buttonDisabled: button instanceof HTMLButtonElement ? button.disabled : undefined,
        inputValueLength: textarea instanceof HTMLTextAreaElement ? textarea.value.length : undefined,
        composerClass: composer?.className,
        cancelButtonCount: document.querySelectorAll('.app-mode-chat [data-testid="cancel-turn"]').length,
      };
    });
    throw new Error(`Composer did not become sendable: ${JSON.stringify(state)}; ${error instanceof Error ? error.message : String(error)}`);
  }
  await page.getByTestId('send-message').click();
  await page.locator('.user-message').filter({ hasText: text }).last().waitFor();
  await page.getByTestId('cancel-turn').waitFor({ state: 'visible' });
}

await mkdir(artifactRoot, { recursive: true });
await mkdir(scratchRoot, { recursive: true });

const application = await electron.launch({
  executablePath: electronPath,
  args: [mainEntry],
  cwd: workspaceRoot,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  timeout: 60_000,
});

let pageError;
try {
  const page = await application.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(60_000);
  page.on('pageerror', (error) => { pageError ??= error; });
  await page.locator('.app-mode-chat [data-testid="composer-input"]').waitFor();
  const initial = await snapshot(page);
  const selectedModel = initial.models.find((model) => model.id === modelId);
  assert.ok(selectedModel, `${modelId} is unavailable`);
  const provider = initial.providers.find((candidate) => candidate.definition.id === 'chatgpt-oauth');
  assert.equal(provider?.status, 'connected', 'ChatGPT OAuth provider is not connected');

  const leadAgentId = initial.sessionAgentBinding.leadAgentId
    || initial.projectAgents.find((binding) => binding.enabled)?.agentId;
  assert.ok(leadAgentId, 'No enabled project Agent is available for live QA');
  const created = await runtimeJson(page, '/api/sessions', {
    title: 'Sci Workplace 实机验收',
    leadAgentId,
    memberAgentIds: [],
    temporary: true,
  });
  const sessionId = created.id;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.app-mode-chat [data-testid="composer-input"]').waitFor({ state: 'visible' });
  await waitFor(async () => (await snapshot(page)).activeSessionId === sessionId);

  await selectPickerOption(page, 'model-picker', 'model-picker-menu', 'data-model-id', modelId);
  await selectPickerOption(page, 'composer-permission', 'permission-picker-menu', 'data-permission-mode', 'read_only');
  await selectPickerOption(page, 'reasoning-picker', 'reasoning-picker-menu', 'data-effort', 'high');
  await pause(500);

  const firstPrompt = '这是一次只读验收。请必须调用 list_files 查看当前项目根目录，maxFiles 设为 5；不要修改任何文件。工具完成后只回复 SCI_QA_OK。';
  await send(page, firstPrompt);
  let firstCompleted;
  try {
    firstCompleted = await waitFor(async () => {
      const state = await snapshot(page);
      const failed = [...state.timeline].reverse().find((node) => node.kind === 'notice' && node.status === 'failed');
      if (failed) throw new Error(`Live provider rejected the turn: ${failed.content}`);
      const answer = [...state.timeline].reverse().find((node) => node.kind === 'assistant' && node.content.includes('SCI_QA_OK'));
      const tool = [...state.timeline].reverse().find((node) => node.kind === 'tool' && node.metadata?.toolName === 'list_files');
      return answer && tool?.status === 'completed' ? { state, answer, tool } : undefined;
    });
  } catch (error) {
    const state = await snapshot(page);
    const diagnostic = {
      activeSessionId: state.activeSessionId,
      session: state.sessions.find((session) => session.id === sessionId),
      leadRuns: state.agentRuns.filter((run) => run.role === 'lead').map((run) => ({ status: run.status, error: run.error })),
      timeline: state.timeline.slice(-12).map((node) => ({
        kind: node.kind,
        title: node.title,
        status: node.status,
        content: node.content.slice(0, 300),
        toolName: node.metadata?.toolName,
      })),
    };
    await page.screenshot({ path: join(artifactRoot, 'sci-workplace-live-failure.png'), fullPage: true });
    throw new Error(`First live turn did not complete as expected: ${JSON.stringify(diagnostic)}; ${error instanceof Error ? error.message : String(error)}`);
  }
  const idleStartedAt = Date.now();
  const firstIdle = await waitForIdle(page, sessionId);
  const buttonRestoreMs = Date.now() - idleStartedAt;
  assert.equal(firstIdle.sessions.find((session) => session.id === sessionId)?.model, modelId);
  assert.equal(await page.getByTestId('cancel-turn').count(), 0, 'Stop button remained after the answer completed');
  assert.equal(await page.getByTestId('send-message').count(), 1, 'Send button did not return after the answer completed');

  const secondPrompt = '请不要调用工具，只回复 SCI_QA_SECOND_OK。';
  await send(page, secondPrompt);
  const secondIdle = await waitForIdle(page, sessionId);
  assert.ok(secondIdle.timeline.some((node) => node.kind === 'assistant' && node.content.includes('SCI_QA_SECOND_OK')),
    'A second turn could not run immediately after the first answer');

  const authorizedRoot = await runtimeJson(page, '/api/workspace/roots', {
    path: scratchRoot,
    access: 'ask',
    confirmed: true,
  });
  const visionDigit = String((Date.now() % 8) + 1);
  const visionDataUrl = await page.evaluate((digit) => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    context.fillStyle = '#176B4D';
    context.fillRect(0, 0, 256, 256);
    context.fillStyle = '#FFFFFF';
    context.font = '700 180px Segoe UI';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(digit, 128, 126);
    return canvas.toDataURL('image/png');
  }, visionDigit);
  await writeFile(join(scratchRoot, 'vision-probe.png'), Buffer.from(visionDataUrl.split(',')[1], 'base64'));
  const visionAttachment = await runtimeJson(page, '/api/workspace/attachment-ref', { rootId: authorizedRoot.id, path: 'vision-probe.png' });
  const visionInput = {
    text: '请只观察附图中央的白色数字，并且只回复该数字本身；不要解释，也不要调用工具。',
    model: modelId,
    thinking: 'enabled',
    reasoningEffort: 'high',
    permissionMode: 'read_only',
    interfaceLocale: 'zh-CN',
    attachments: [visionAttachment],
  };
  let visionInputCompleted = false;
  let unsupportedVisionRejected = false;
  if (selectedModel.supportsVision) {
    const visionTurn = await runtimeJson(page, '/api/chat', visionInput);
    const visionCompleted = await waitForIdle(page, sessionId);
    const visionAnswer = [...visionCompleted.timeline].reverse().find((node) => node.kind === 'assistant' && node.metadata?.turnId === visionTurn.turnId);
    if (visionAnswer?.content.trim() !== visionDigit) {
      await page.screenshot({ path: join(artifactRoot, 'sci-workplace-live-vision-failure.png'), fullPage: true });
      throw new Error(`Vision probe expected ${visionDigit} but received ${JSON.stringify(visionAnswer?.content ?? null)}; recent timeline: ${JSON.stringify(visionCompleted.timeline.slice(-8).map((node) => ({ kind: node.kind, status: node.status, content: node.content.slice(0, 300) })))}`);
    }
    visionInputCompleted = true;
  } else {
    const rejected = await runtimeRaw(page, '/api/chat', visionInput);
    assert.equal(rejected.ok, false, 'A non-vision model silently accepted an image attachment');
    const rejectionDetail = rejected.payload?.error ?? rejected.payload?.message ?? rejected.payload;
    const rejectionMessage = typeof rejectionDetail === 'string' ? rejectionDetail : JSON.stringify(rejectionDetail);
    assert.match(rejectionMessage, /不支持视觉输入/u);
    unsupportedVisionRejected = true;
  }

  await selectPickerOption(page, 'composer-permission', 'permission-picker-menu', 'data-permission-mode', 'ask');
  const writePrompt = `请必须调用 write_file，在 rootId ${authorizedRoot.id} 中写入 probe.txt，内容必须精确为 SCI_WORKPLACE_WRITE_PROBE。等待工具完成后只回复 SCI_QA_WRITE_OK。`;
  await send(page, writePrompt);
  await page.getByTestId('approve-tool').first().waitFor({ state: 'visible' });
  await page.getByTestId('approve-tool').first().click();
  const writeCompleted = await waitFor(async () => {
    const state = await snapshot(page);
    const tool = [...state.timeline].reverse().find((node) => node.kind === 'tool' && node.metadata?.toolName === 'write_file');
    const answer = [...state.timeline].reverse().find((node) => node.kind === 'assistant' && node.content.includes('SCI_QA_WRITE_OK'));
    return tool?.status === 'completed' && answer ? state : undefined;
  });
  await waitForIdle(page, sessionId);
  assert.equal(await readFile(join(scratchRoot, 'probe.txt'), 'utf8'), 'SCI_WORKPLACE_WRITE_PROBE');

  const deletePrompt = `请必须调用 delete_file，删除 rootId ${authorizedRoot.id} 中的 probe.txt。等待工具完成后只回复 SCI_QA_DELETE_OK。`;
  await send(page, deletePrompt);
  await page.getByTestId('approve-tool').first().waitFor({ state: 'visible' });
  await page.getByTestId('approve-tool').first().click();
  const deleteCompleted = await waitFor(async () => {
    const state = await snapshot(page);
    const tool = [...state.timeline].reverse().find((node) => node.kind === 'tool' && node.metadata?.toolName === 'delete_file');
    const answer = [...state.timeline].reverse().find((node) => node.kind === 'assistant' && node.content.includes('SCI_QA_DELETE_OK'));
    return tool?.status === 'completed' && answer ? state : undefined;
  });
  await waitForIdle(page, sessionId);
  assert.equal(await access(join(scratchRoot, 'probe.txt')).then(() => true, () => false), false, 'Approved delete did not remove the probe file');

  const cancelPrompt = '请开始详细说明科研 Harness 的十项验收原则。';
  await send(page, cancelPrompt);
  await page.getByTestId('cancel-turn').click();
  const cancelled = await waitForIdle(page, sessionId);
  assert.ok(cancelled.timeline.some((node) => node.kind === 'notice' && node.status === 'cancelled'),
    'Cancellation did not produce a traceable cancelled notice');

  const reasoningNodes = firstCompleted.state.timeline.filter((node) => node.kind === 'reasoning');
  const toolNodes = firstCompleted.state.timeline.filter((node) => node.kind === 'tool');
  await page.screenshot({ path: join(artifactRoot, 'sci-workplace-live.png'), fullPage: true });
  assert.equal(pageError, undefined, pageError?.message);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    model: modelId,
    providerConnected: true,
    firstAnswerCompleted: true,
    listFilesCompleted: true,
    reasoningNodeCount: reasoningNodes.length,
    reasoningSummaryVisible: reasoningNodes.some((node) => Boolean(node.content.trim())),
    toolNodeCount: toolNodes.length,
    modelSupportsVision: selectedModel.supportsVision,
    visionInputCompleted,
    unsupportedVisionRejected,
    writeApprovalCompleted: writeCompleted.pendingApprovals.length === 0,
    deleteApprovalCompleted: deleteCompleted.pendingApprovals.length === 0,
    buttonRestoreMs,
    secondTurnCompleted: true,
    cancellationCompleted: true,
    screenshot: join(artifactRoot, 'sci-workplace-live.png'),
  }, null, 2)}\n`);
} finally {
  await application.close().catch(() => undefined);
  assert.equal(scratchRoot.startsWith(`${artifactRoot}${sep}`), true, 'Refusing to remove a scratch directory outside live QA artifacts');
  await rm(scratchRoot, { recursive: true, force: true });
}
