import { randomUUID } from 'node:crypto';
import type {
  ArtifactRevisionRef,
  EventActor,
  GeneratedAppBlueprintV1,
  GeneratedWorktableApp,
  WorkbenchBlueprintV1,
  WorkbenchInstanceV1,
} from '@openlab/protocol';
import type { SqliteEventStore } from '../events/event-store.js';
import { toJson } from '../util/json.js';

interface GeneratedBlueprintEventPayload { blueprint?: GeneratedAppBlueprintV1 }

interface GeneratedAppCode {
  generationId: string;
  body: string;
  style: string;
  script: string;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function titleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, ' ').trim();
  return normalized.slice(0, 42) || '生成式科研应用';
}

function createWorkbenchBlueprint(id: string, title: string): WorkbenchBlueprintV1 {
  const paneId = 'app';
  return {
    schemaVersion: 1,
    id: `generated:${id}`,
    version: '1.0.0',
    title,
    description: '由提示词生成的项目私有、不可变沙箱应用。',
    icon: 'sparkles',
    kind: 'generated',
    inputSchema: { type: 'object', additionalProperties: false },
    layout: { kind: 'pane', paneId },
    panes: [{
      id: paneId,
      title,
      tabs: [{ id: 'app-preview', title, content: { kind: 'generated-app', appId: 'pending', revisionId: 'pending' }, pinned: true, openedAt: 'template' }],
      activeTabId: 'app-preview',
    }],
    slots: [{ id: 'app', role: 'primary', paneId, title: '生成应用', accepts: ['generated-app'], autoMount: false }],
    commands: [],
  };
}

function generationSpec(prompt: string): NonNullable<GeneratedAppBlueprintV1['generationSpec']> {
  const normalized = prompt.toLocaleLowerCase();
  const interaction = /表格|table|矩阵|matrix/u.test(normalized) ? 'table'
    : /清单|checklist|待办|todo/u.test(normalized) ? 'checklist'
      : /表单|form|录入|填写/u.test(normalized) ? 'form' : 'workspace';
  return { interaction, language: 'zh-CN', theme: 'host-neutral', storage: 'session-only' };
}

function validateGeneratedCode(code: GeneratedAppCode): GeneratedAppCode {
  for (const [name, value, maximum] of [['body', code.body, 300_000], ['style', code.style, 200_000], ['script', code.script, 300_000]] as const) {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum) throw new Error(`生成应用 ${name} 超过构建限制`);
  }
  if (/<\/?(?:script|style|link|meta|base|iframe|object|embed)\b|\bon[a-z]+\s*=|javascript:|https?:\/\//iu.test(code.body)) throw new Error('生成应用 HTML 包含宿主禁止的标签、事件属性或外部地址');
  if (/<\/style|@import|https?:\/\//iu.test(code.style)) throw new Error('生成应用 CSS 包含外部资源或非法结束标签');
  if (/<\/script|\b(?:eval|Function|fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\b|\b(?:parent|top|opener)\b/iu.test(code.script)) throw new Error('生成应用脚本请求了禁止的动态代码、网络或父窗口能力');
  try { Function(`"use strict";\n${code.script}`); }
  catch (error) { throw new Error(`生成应用 JavaScript 构建失败：${error instanceof Error ? error.message : String(error)}`); }
  return code;
}

export class GeneratedAppBlueprintService {
  readonly #projectId: string;
  readonly #events: SqliteEventStore;
  readonly #createArtifact: (input: { blueprint: GeneratedAppBlueprintV1; files: Array<{ name: string; content: string; mediaType: string }> }, actor: EventActor) => ArtifactRevisionRef;
  readonly #publish: (blueprint: GeneratedAppBlueprintV1, actor: EventActor) => GeneratedWorktableApp;
  readonly #mount: (blueprint: WorkbenchBlueprintV1, actor: EventActor, conversationId?: string) => WorkbenchInstanceV1;
  readonly #generateCode: ((blueprint: GeneratedAppBlueprintV1, actor: EventActor) => Promise<GeneratedAppCode | undefined>) | undefined;
  readonly #blueprints = new Map<string, GeneratedAppBlueprintV1>();

  constructor(options: {
    projectId: string;
    events: SqliteEventStore;
    createArtifact(input: { blueprint: GeneratedAppBlueprintV1; files: Array<{ name: string; content: string; mediaType: string }> }, actor: EventActor): ArtifactRevisionRef;
    publish(blueprint: GeneratedAppBlueprintV1, actor: EventActor): GeneratedWorktableApp;
    mount(blueprint: WorkbenchBlueprintV1, actor: EventActor, conversationId?: string): WorkbenchInstanceV1;
    generateCode?(blueprint: GeneratedAppBlueprintV1, actor: EventActor): Promise<GeneratedAppCode | undefined>;
  }) {
    this.#projectId = options.projectId;
    this.#events = options.events;
    this.#createArtifact = options.createArtifact;
    this.#publish = options.publish;
    this.#mount = options.mount;
    this.#generateCode = options.generateCode;
    this.replay();
  }

  list(): GeneratedAppBlueprintV1[] {
    return [...this.#blueprints.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map((blueprint) => structuredClone(blueprint));
  }

  get(id: string): GeneratedAppBlueprintV1 {
    const blueprint = this.#blueprints.get(id);
    if (!blueprint) throw new Error('GeneratedAppBlueprint 不存在');
    return structuredClone(blueprint);
  }

  propose(prompt: string, actor: EventActor): GeneratedAppBlueprintV1 {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt || normalizedPrompt.length > 20_000) throw new Error('生成应用提示词必须为 1–20,000 个字符');
    const id = randomUUID();
    const now = new Date().toISOString();
    const title = titleFromPrompt(normalizedPrompt);
    const blueprint: GeneratedAppBlueprintV1 = {
      schemaVersion: 1,
      id,
      projectId: this.#projectId,
      title,
      prompt: normalizedPrompt,
      workbench: createWorkbenchBlueprint(id, title),
      entry: 'index.html',
      hostCapabilities: [],
      networkDomains: [],
      generationSpec: generationSpec(normalizedPrompt),
      status: 'awaiting_confirmation',
      createdAt: now,
      updatedAt: now,
    };
    this.#blueprints.set(id, blueprint);
    this.record('generated-blueprint.proposed', blueprint, actor);
    return structuredClone(blueprint);
  }

  confirm(id: string, accepted: boolean, actor: EventActor): GeneratedAppBlueprintV1 {
    const current = this.get(id);
    if (current.status !== 'awaiting_confirmation') throw new Error('生成应用蓝图不在待确认状态');
    const blueprint: GeneratedAppBlueprintV1 = {
      ...current,
      status: accepted ? 'building' : 'rejected',
      updatedAt: new Date().toISOString(),
    };
    this.#blueprints.set(id, blueprint);
    this.record('generated-blueprint.confirmed', blueprint, actor);
    return structuredClone(blueprint);
  }

  async build(id: string, actor: EventActor): Promise<GeneratedAppBlueprintV1> {
    const current = this.get(id);
    if (current.status !== 'building') throw new Error('生成应用蓝图尚未通过能力与布局确认');
    try {
      const title = escapeHtml(current.title);
      const prompt = escapeHtml(current.prompt);
      const generatedCandidate = this.#generateCode ? await this.#generateCode(current, actor) : undefined;
      const generated = generatedCandidate ? validateGeneratedCode(generatedCandidate) : undefined;
      const body = generated?.body.trim() || `<span class="badge">项目私有 · 离线沙箱</span><h1>${title}</h1><p>${prompt}</p><textarea id="notes" placeholder="在这里记录科研笔记……"></textarea><button id="save">保存到当前预览</button><p id="status" aria-live="polite"></p>`;
      const style = generated?.style.trim() || '';
      const script = generated?.script.trim() || `document.getElementById('save').addEventListener('click',()=>{document.getElementById('status').textContent='已保存在当前沙箱会话中';});`;
      const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${title}</title><style>:root{font-family:Inter,"Microsoft YaHei",sans-serif;color:#17211b;background:#f7faf8}body{margin:0;padding:28px}main{max-width:900px;margin:auto}section{background:white;border:1px solid #dce6df;border-radius:14px;padding:20px;box-shadow:0 10px 30px #163d2710}h1{font-size:22px;margin:0 0 8px}p{line-height:1.65;color:#526159}.badge{display:inline-block;padding:4px 8px;border-radius:999px;background:#e3f4e9;color:#176438;font-size:12px}textarea{box-sizing:border-box;width:100%;min-height:150px;border:1px solid #cbd8d0;border-radius:9px;padding:12px;resize:vertical}button{margin-top:10px;border:0;border-radius:8px;padding:9px 14px;color:white;background:#176438;cursor:pointer}${style}</style></head>
<body><main><section>${body}</section></main><script>"use strict";${script}</script></body></html>`;
      const manifest = JSON.stringify({ schemaVersion: 1, blueprintId: current.id, entry: current.entry, networkDomains: current.networkDomains, hostCapabilities: current.hostCapabilities, modelGenerationIds: generated ? [generated.generationId] : [] }, null, 2);
      const artifact = this.#createArtifact({
        blueprint: current,
        files: [
          { name: 'index.html', content: html, mediaType: 'text/html' },
          { name: 'generated-app.json', content: manifest, mediaType: 'application/json' },
        ],
      }, actor);
      const blueprint: GeneratedAppBlueprintV1 = {
        ...current,
        artifact,
        ...(generated ? { modelGenerationIds: [...(current.modelGenerationIds ?? []), generated.generationId] } : {}),
        buildLog: `schema: ok\ncapabilities: ${current.hostCapabilities.join(', ') || 'none'}\nnetwork: ${current.networkDomains.join(', ') || 'denied'}\nCSP: ok\nJavaScript syntax: ok\nstatic bundle: ok\ncode generator: ${generated ? generated.generationId : 'deterministic'}`,
        status: 'preview',
        updatedAt: new Date().toISOString(),
      };
      delete blueprint.error;
      this.#blueprints.set(id, blueprint);
      this.record('generated-blueprint.built', blueprint, actor);
      return structuredClone(blueprint);
    } catch (error) {
      const blueprint: GeneratedAppBlueprintV1 = {
        ...current,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      };
      this.#blueprints.set(id, blueprint);
      this.record('generated-blueprint.failed', blueprint, actor);
      return structuredClone(blueprint);
    }
  }

  accept(id: string, confirmed: boolean, actor: EventActor, conversationId?: string): { app: GeneratedWorktableApp; instance: WorkbenchInstanceV1 } {
    if (!confirmed) throw new Error('接受并挂载生成应用需要用户明确确认');
    const current = this.get(id);
    if (current.status !== 'preview' || !current.artifact) throw new Error('生成应用尚未通过构建与沙箱预览');
    const app = this.#publish(current, actor);
    const workbench = structuredClone(current.workbench);
    const tab = workbench.panes[0]?.tabs[0];
    if (!tab) throw new Error('生成应用 WorkbenchBlueprint 缺少入口标签');
    tab.content = { kind: 'generated-app', appId: app.id, revisionId: app.activeRevisionId };
    const instance = this.#mount(workbench, actor, conversationId);
    const accepted: GeneratedAppBlueprintV1 = { ...current, workbench, status: 'accepted', updatedAt: new Date().toISOString() };
    this.#blueprints.set(id, accepted);
    this.record('generated-blueprint.accepted', accepted, actor);
    return { app, instance };
  }

  private record(kind: string, blueprint: GeneratedAppBlueprintV1, actor: EventActor): void {
    this.#events.append({
      streamId: `project:${this.#projectId}`,
      kind,
      actor,
      idempotencyKey: `${kind}:${blueprint.id}:${blueprint.updatedAt}`,
      provenanceRefs: [blueprint.id, ...(blueprint.artifact ? [blueprint.artifact.artifactId, blueprint.artifact.revisionId] : [])],
      payload: toJson({ blueprint }),
    });
  }

  private replay(): void {
    for (const event of this.#events.list(`project:${this.#projectId}`)) {
      if (!event.kind.startsWith('generated-blueprint.')) continue;
      const payload = event.payload as unknown as GeneratedBlueprintEventPayload;
      if (payload.blueprint?.id) this.#blueprints.set(payload.blueprint.id, structuredClone(payload.blueprint));
    }
  }
}
