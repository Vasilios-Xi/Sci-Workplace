import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentRevisionRef, JsonValue, ToolExecutionResult, WorktableInstance, WorktableState } from '@openlab/protocol';
import { OpenLabRuntime } from '../src/runtime.js';

const roots: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'openlab-plugin-v3-worktable-contract-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 75));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const OPENED_AT = '1970-01-01T00:00:00.000Z';

function writeFixturePlugin(root: string, pluginId: string): string {
  const source = join(root, `${pluginId}-source`);
  mkdirSync(source, { recursive: true });
  const templateId = `${pluginId}:task`;
  writeFileSync(join(source, 'panel.html'), '<!doctype html><title>Contract fixture</title>', 'utf8');
  writeFileSync(join(source, 'index.mjs'), `
const result = (context, value) => ({
  callId: context.traceId,
  ok: true,
  content: JSON.stringify(value),
  artifactIds: [],
  metadata: { value },
});

export default {
  apiVersion: 3,
  tools: [{
    definition: {
      name: 'contract_probe',
      title: 'Contract probe',
      description: 'Exercise the v3 worktable host contract.',
      inputSchema: { type: 'object', additionalProperties: true },
      risk: 'write',
      renderHint: 'generic',
    },
    async execute(input, context) {
      let value;
      switch (input.action) {
        case 'create':
          value = await context.host.worktable.create({
            templateId: '${templateId}',
            title: input.title,
            inputs: input.inputs,
          });
          break;
        case 'inspect':
          value = await context.host.worktable.inspect(input.instanceId);
          break;
        case 'open':
          value = await context.host.worktable.open(input.instanceId);
          break;
        case 'update':
          value = await context.host.worktable.update(input.instanceId, input.patch, input.ifRevision);
          break;
        case 'archive':
          value = await context.host.worktable.archive(input.instanceId, input.ifRevision);
          break;
        case 'start':
          value = await context.host.workflows.start('contract.workflow', input.workflowInput ?? {}, { worktableInstanceId: input.instanceId });
          break;
        case 'mount-document':
          value = await context.host.worktable.mountContent({
            instanceId: input.instanceId,
            paneId: input.paneId,
            title: input.title ?? 'Evidence document',
            content: { kind: 'document', target: input.document },
          });
          break;
        case 'reveal':
          value = await context.host.worktable.reveal({
            instanceId: input.instanceId,
            document: input.document,
            selector: input.selector,
            ...(input.target ? { target: input.target } : {}),
          });
          break;
        case 'create-revision':
          value = await context.host.artifacts.createRevision({
            artifactId: input.artifactId,
            files: [{ role: 'output', name: input.name ?? 'result.md', mediaType: 'text/markdown', content: '# fixture' }],
            annotationSetIds: input.annotationSetIds ?? [],
            provenance: {
              traceId: context.traceId,
              sessionId: context.sessionId,
              agentId: context.agentId,
              tool: 'contract_probe',
              inputObjectIds: [],
              inputFileHashes: {},
            },
          });
          break;
        case 'mount-artifact':
          value = await context.host.worktable.mountArtifact({
            instanceId: input.instanceId,
            paneId: input.paneId,
            artifactId: input.artifactId,
            ...(input.revisionId ? { revisionId: input.revisionId } : {}),
            title: input.title,
          });
          break;
        default:
          throw new Error('unknown fixture action');
      }
      return result(context, value);
    },
  }],
  workflows: [{
    definition: {
      id: 'contract.workflow',
      title: 'Contract workflow',
      description: 'Stays active until the host cancels it.',
      inputSchema: {
        type: 'object',
        properties: { annotationBatchId: { type: 'string' } },
        additionalProperties: false,
      },
    },
    async run(_input, context) {
      await context.host.storage.put('project', 'last-workflow-context', {
        worktableInstanceId: context.worktableInstanceId,
        jobId: context.jobId,
      });
      if (_input.annotationBatchId) {
        return { artifactIds: [], metadata: { annotationBatchId: _input.annotationBatchId } };
      }
      return await new Promise((_resolve, reject) => {
        const abort = () => reject(context.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        if (context.signal.aborted) abort();
        else context.signal.addEventListener('abort', abort, { once: true });
      });
    },
  }],
};
`, 'utf8');
  writeFileSync(join(source, 'manifest.json'), JSON.stringify({
    schemaVersion: 3,
    apiVersion: 3,
    id: pluginId,
    name: `Fixture ${pluginId}`,
    version: '1.0.0',
    engine: '^0.1.0',
    entry: 'index.mjs',
    permissions: ['ui', 'worktable:read', 'worktable:write', 'resources:read', 'jobs:run', 'artifacts:write', 'plugin-storage'],
    contributes: {
      tools: ['contract_probe'],
      contextProviders: [],
      agentTemplates: [],
      agentPresets: [],
      researchObjectTypes: [],
      researchRelationTypes: [],
      uiPanels: [{ id: 'fixture', title: 'Fixture', entry: 'panel.html', tools: ['contract_probe'] }],
      worktableTemplates: [{
        id: templateId,
        version: '1.0.0',
        title: 'Contract task',
        description: 'Contract task instance fixture.',
        icon: 'flask-conical',
        kind: 'research',
        inputSchema: {
          type: 'object',
          properties: { sourceId: { type: 'string' } },
          required: ['sourceId'],
          additionalProperties: false,
        },
        layout: { kind: 'pane', paneId: 'main' },
        panes: [{
          id: 'main',
          title: 'Main',
          activeTabId: 'fixture',
          tabs: [{
            id: 'fixture',
            title: 'Fixture',
            content: { kind: 'plugin-panel', pluginId, panelId: 'fixture' },
            pinned: true,
            openedAt: OPENED_AT,
          }],
        }],
        commands: [],
      }],
    },
  }), 'utf8');
  return source;
}

async function fixtureRuntime(root: string, pluginIds: string[]): Promise<{
  runtime: OpenLabRuntime;
  sessionId: string;
  execute: (pluginId: string, input: Record<string, JsonValue>) => Promise<ToolExecutionResult>;
}> {
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const runtime = new OpenLabRuntime({
    host: '127.0.0.1', port: 0, authToken: 'contract-token', projectRoot,
    home: join(root, '.runtime'), demo: true,
  });
  await runtime.initialize();
  for (const pluginId of pluginIds) await runtime.plugins.install(writeFixturePlugin(root, pluginId), 'project');
  const sessionId = (await runtime.snapshot()).sessions[0]!.id;
  return {
    runtime,
    sessionId,
    execute: async (pluginId, input) => await runtime.plugins.executePanelTool(pluginId, 'contract_probe', input, {
      projectId: runtime.project.id,
      sessionId,
      agentId: 'contract-agent',
      traceId: `trace-${pluginId}-${String(input.action)}`,
    }),
  };
}

function value<T>(output: ToolExecutionResult): T {
  return output.metadata.value as T;
}

async function waitUntil(assertion: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for contract fixture');
}

describe('Plugin API v3 worktable Runtime contract', () => {
  it('preserves instance inputs, enforces optimistic revisions, and keeps archives irreversibly read-only', async () => {
    const root = temporaryDirectory();
    const { runtime, execute } = await fixtureRuntime(root, ['fixture.contract-a']);
    try {
      const created = value<WorktableInstance>(await execute('fixture.contract-a', {
        action: 'create', title: 'Reader task', inputs: { sourceId: 'paper-1' },
      }));
      expect(created).toMatchObject({
        title: 'Reader task', inputs: { sourceId: 'paper-1' }, revision: 1,
        templateId: 'fixture.contract-a:task', templateVersion: '1.0.0',
      });

      const updated = value<WorktableInstance>(await execute('fixture.contract-a', {
        action: 'update', instanceId: created.id, ifRevision: created.revision,
        patch: { title: 'Reviewed task', inputs: { sourceId: 'paper-2' } },
      }));
      expect(updated).toMatchObject({ title: 'Reviewed task', inputs: { sourceId: 'paper-2' }, revision: 2 });
      await expect(execute('fixture.contract-a', {
        action: 'update', instanceId: created.id, ifRevision: created.revision, patch: { title: 'stale' },
      })).rejects.toThrow(/已被其他操作更新/u);

      const archived = value<WorktableInstance>(await execute('fixture.contract-a', {
        action: 'archive', instanceId: created.id, ifRevision: updated.revision,
      }));
      expect(archived).toMatchObject({ status: 'archived', revision: 3 });
      expect(archived.archivedAt).toBeTruthy();
      await expect(execute('fixture.contract-a', {
        action: 'update', instanceId: created.id, ifRevision: archived.revision, patch: { status: 'idle' },
      })).rejects.toThrow(/只读/u);

      const inspected = value<{ instanceId: string; revision: number }>(await execute('fixture.contract-a', {
        action: 'inspect', instanceId: created.id,
      }));
      expect(inspected).toMatchObject({ instanceId: created.id, revision: archived.revision });
      const opened = value<WorktableInstance>(await execute('fixture.contract-a', { action: 'open', instanceId: created.id }));
      expect(opened).toMatchObject({ id: created.id, status: 'archived', revision: archived.revision });
    } finally {
      await runtime.stop();
    }
  }, 30_000);

  it('binds workflows.start options to the JobSpec and plugin context and rejects a second active run', async () => {
    const root = temporaryDirectory();
    const { runtime, execute } = await fixtureRuntime(root, ['fixture.contract-a']);
    try {
      const instance = value<WorktableInstance>(await execute('fixture.contract-a', {
        action: 'create', inputs: { sourceId: 'paper-1' },
      }));
      const run = value<{ id: string; spec: { worktableInstanceId?: string } }>(await execute('fixture.contract-a', {
        action: 'start', instanceId: instance.id,
      }));
      expect(run.spec.worktableInstanceId).toBe(instance.id);
      await waitUntil(() => runtime.workflows.get(run.id).status === 'running');
      await waitUntil(() => runtime.pluginStorage.get('fixture.contract-a', 'project', 'last-workflow-context') !== undefined);
      expect(runtime.pluginStorage.get('fixture.contract-a', 'project', 'last-workflow-context')?.value).toEqual({
        worktableInstanceId: instance.id,
        jobId: run.id,
      });
      expect(runtime.worktables.snapshot().instances.find((candidate) => candidate.id === instance.id)).toMatchObject({
        activeRunId: run.id,
        status: 'running',
      });
      await expect(execute('fixture.contract-a', { action: 'start', instanceId: instance.id })).rejects.toThrow(/已有活动工作流/u);
      runtime.workflows.cancel(run.id, { id: 'local-user', kind: 'user' });
    } finally {
      await runtime.stop();
    }
  }, 30_000);

  it('validates structured document anchors and reveals only into an explicit matching document or caller-owned panel', async () => {
    const root = temporaryDirectory();
    const { runtime, execute } = await fixtureRuntime(root, ['fixture.contract-a', 'fixture.contract-b']);
    try {
      const projectRoot = join(root, 'project');
      const evidenceBytes = Buffer.from('{"section":"methods","claim":"verified"}', 'utf8');
      const otherBytes = Buffer.from('{"section":"other"}', 'utf8');
      writeFileSync(join(projectRoot, 'evidence.json'), evidenceBytes);
      writeFileSync(join(projectRoot, 'other.json'), otherBytes);
      const document: DocumentRevisionRef = {
        ref: { rootId: 'project', path: 'evidence.json' },
        sha256: createHash('sha256').update(evidenceBytes).digest('hex'),
        mediaType: 'application/json',
      };
      const otherDocument: DocumentRevisionRef = {
        ref: { rootId: 'project', path: 'other.json' },
        sha256: createHash('sha256').update(otherBytes).digest('hex'),
        mediaType: 'application/json',
      };
      const instance = value<WorktableInstance>(await execute('fixture.contract-a', {
        action: 'create', inputs: { sourceId: 'structured-document' },
      }));
      await execute('fixture.contract-a', {
        action: 'mount-document', instanceId: instance.id, paneId: instance.panes[0]!.id, document,
      });
      const panelTabId = runtime.worktables.snapshot().instances.find((candidate) => candidate.id === instance.id)!
        .panes.flatMap((pane) => pane.tabs)
        .find((tab) => tab.content.kind === 'plugin-panel'
          && tab.content.pluginId === 'fixture.contract-a'
          && tab.content.panelId === 'fixture')!.id;
      const selector = {
        kind: 'document-anchor', scheme: 'openlab:section', anchor: 'methods/claim-1', start: 2, end: 10, exact: 'verified',
      } as const;
      const revealed = value<WorktableState>(await execute('fixture.contract-a', {
        action: 'reveal', instanceId: instance.id, document, selector, target: { panelId: 'fixture' },
      }));
      expect(revealed.reveal).toMatchObject({
        instanceId: instance.id,
        document,
        selector,
        targetPaneId: instance.panes[0]!.id,
        targetTabId: panelTabId,
      });
      expect(runtime.worktableContext(instance.id).reveal).toMatchObject({
        document,
        selector,
        targetPaneId: instance.panes[0]!.id,
        targetTabId: panelTabId,
      });

      await expect(execute('fixture.contract-a', {
        action: 'reveal', instanceId: instance.id, document,
        selector: { ...selector, scheme: 'Bad Scheme' }, target: { panelId: 'fixture' },
      })).rejects.toThrow(/scheme 无效/u);
      await expect(execute('fixture.contract-a', {
        action: 'reveal', instanceId: instance.id, document,
        selector: { ...selector, anchor: '   ' }, target: { panelId: 'fixture' },
      })).rejects.toThrow(/锚点标识无效/u);
      await expect(execute('fixture.contract-a', {
        action: 'reveal', instanceId: instance.id, document,
        selector: { ...selector, start: 10, end: 2 }, target: { panelId: 'fixture' },
      })).rejects.toThrow(/锚点范围(?:无效|必须同时提供)/u);
      await expect(execute('fixture.contract-a', {
        action: 'reveal', instanceId: instance.id, document,
        selector: { kind: 'document-anchor', scheme: 'openlab:section', anchor: 'methods', start: 1 },
        target: { panelId: 'fixture' },
      })).rejects.toThrow(/锚点范围(?:无效|必须同时提供)/u);
      await expect(execute('fixture.contract-a', {
        action: 'reveal', instanceId: instance.id, document: otherDocument, selector, target: { panelId: 'fixture' },
      })).rejects.toThrow(/文档不属于/u);

      const adversarial = runtime.worktables.mountTab(instance.id, instance.panes[0]!.id, {
        title: 'Foreign panel',
        content: { kind: 'plugin-panel', pluginId: 'fixture.contract-b', panelId: 'fixture' },
      }, { id: 'local-user', kind: 'user' });
      await expect(execute('fixture.contract-a', {
        action: 'reveal', instanceId: instance.id, document, selector,
        target: { paneId: instance.panes[0]!.id, tabId: adversarial.id },
      })).rejects.toThrow(/匹配文档或本插件面板/u);
    } finally {
      await runtime.stop();
    }
  }, 30_000);

  it('accepts annotation batch provenance only after a first-party submitted set is bound to a turn', async () => {
    const root = temporaryDirectory();
    const { runtime, execute } = await fixtureRuntime(root, ['fixture.contract-a']);
    try {
      const projectRoot = join(root, 'project');
      const bytes = Buffer.from('# Review target\n', 'utf8');
      writeFileSync(join(projectRoot, 'review.md'), bytes);
      const target: DocumentRevisionRef = {
        ref: { rootId: 'project', path: 'review.md' },
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mediaType: 'text/markdown',
      };
      const actor = { id: 'local-user', kind: 'user' as const };
      const unboundAnnotation = runtime.createAnnotation({
        target,
        selector: { kind: 'document-anchor', scheme: 'markdown:heading', anchor: 'review-target' },
        comment: 'Unbound review request',
      });
      const unbound = runtime.annotations.submit([unboundAnnotation.id], actor);
      const boundAnnotation = runtime.createAnnotation({
        target,
        selector: { kind: 'document-anchor', scheme: 'markdown:heading', anchor: 'review-target', start: 0, end: 6 },
        comment: 'Bound review request',
      });
      const submitted = runtime.annotations.submit([boundAnnotation.id], actor);
      const bound = runtime.annotations.bindTurn(submitted.id, 'turn-user-confirmed', actor);
      expect(bound).toMatchObject({ status: 'submitted', submittedTurnId: 'turn-user-confirmed' });

      const instance = value<WorktableInstance>(await execute('fixture.contract-a', {
        action: 'create', inputs: { sourceId: 'review.md' },
      }));
      await expect(execute('fixture.contract-a', {
        action: 'start', instanceId: instance.id, workflowInput: { annotationBatchId: 'forged-set' },
      })).rejects.toThrow(/未由用户提交给 Agent/u);
      await expect(execute('fixture.contract-a', {
        action: 'start', instanceId: instance.id, workflowInput: { annotationBatchId: unbound.id },
      })).rejects.toThrow(/未由用户提交给 Agent/u);

      const run = value<{ id: string }>(await execute('fixture.contract-a', {
        action: 'start', instanceId: instance.id, workflowInput: { annotationBatchId: bound.id },
      }));
      await waitUntil(() => runtime.workflows.get(run.id).status === 'completed');
      expect(runtime.workflows.get(run.id).metadata).toEqual({ annotationBatchId: bound.id });
      const queuedEvent = runtime.events.list(`project:${runtime.project.id}`).find((event) =>
        event.kind === 'workflow.queued' && (event.payload as { record?: { id?: string } }).record?.id === run.id);
      expect(queuedEvent?.payload).toMatchObject({ input: { annotationBatchId: bound.id } });

      for (const annotationSetIds of [['forged-set'], [unbound.id]]) {
        await expect(execute('fixture.contract-a', {
          action: 'create-revision', artifactId: `rejected-${annotationSetIds[0]}`, annotationSetIds,
        })).rejects.toThrow(/未由用户提交给 Agent/u);
      }
      const revision = value<{
        id: string; annotationSetIds: string[];
        provenance: { plugin?: { id: string }; traceId: string; sessionId: string; agentId: string };
      }>(await execute('fixture.contract-a', {
        action: 'create-revision', artifactId: 'review-ledger', annotationSetIds: [bound.id],
      }));
      expect(revision).toMatchObject({
        annotationSetIds: [bound.id],
        provenance: { plugin: { id: 'fixture.contract-a' }, agentId: 'contract-agent' },
      });
      const revisionEvent = runtime.events.list(`project:${runtime.project.id}`).find((event) =>
        event.kind === 'artifact.revision_created' && (event.payload as { id?: string }).id === revision.id);
      expect(revisionEvent?.provenanceRefs).toContain(bound.id);
      expect(revisionEvent?.payload).toMatchObject({ annotationSetIds: [bound.id] });
    } finally {
      await runtime.stop();
    }
  }, 30_000);

  it('mounts an unregistered Artifact only with its owning plugin revision and rejects mismatches', async () => {
    const root = temporaryDirectory();
    const { runtime, execute } = await fixtureRuntime(root, ['fixture.contract-a', 'fixture.contract-b']);
    try {
      const instanceA = value<WorktableInstance>(await execute('fixture.contract-a', {
        action: 'create', inputs: { sourceId: 'paper-a' },
      }));
      const instanceB = value<WorktableInstance>(await execute('fixture.contract-b', {
        action: 'create', inputs: { sourceId: 'paper-b' },
      }));
      const revisionA = value<{ id: string; artifactId: string; provenance: { plugin?: { id: string } } }>(await execute('fixture.contract-a', {
        action: 'create-revision', artifactId: 'ledger-a', name: 'a.md',
      }));
      const revisionB = value<{ id: string; artifactId: string }>(await execute('fixture.contract-b', {
        action: 'create-revision', artifactId: 'ledger-b', name: 'b.md',
      }));
      expect(revisionA).toMatchObject({ artifactId: 'ledger-a', provenance: { plugin: { id: 'fixture.contract-a' } } });
      expect(runtime.research.getObject('ledger-a')).toBeUndefined();

      const mounted = value<WorktableInstance>(await execute('fixture.contract-a', {
        action: 'mount-artifact', instanceId: instanceA.id, paneId: instanceA.panes[0]!.id,
        artifactId: 'ledger-a', revisionId: revisionA.id,
      }));
      expect(mounted.panes[0]!.tabs).toEqual(expect.arrayContaining([
        expect.objectContaining({ content: { kind: 'artifact', artifactId: 'ledger-a', revisionId: revisionA.id } }),
      ]));

      await expect(execute('fixture.contract-a', {
        action: 'mount-artifact', instanceId: instanceA.id, paneId: instanceA.panes[0]!.id,
        artifactId: 'ledger-a', revisionId: revisionB.id,
      })).rejects.toThrow(/不存在或不属于/u);
      await expect(execute('fixture.contract-a', {
        action: 'mount-artifact', instanceId: instanceA.id, paneId: instanceA.panes[0]!.id,
        artifactId: 'ledger-a',
      })).rejects.toThrow(/必须指定可验证的 Revision/u);
      await expect(execute('fixture.contract-b', {
        action: 'mount-artifact', instanceId: instanceB.id, paneId: instanceB.panes[0]!.id,
        artifactId: 'ledger-a', revisionId: revisionA.id,
      })).rejects.toThrow(/只能挂载自己创建/u);
    } finally {
      await runtime.stop();
    }
  }, 30_000);
});
