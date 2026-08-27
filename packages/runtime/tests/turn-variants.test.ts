import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelEvent, ModelProvider, ModelRequest } from '@openlab/protocol';
import { OpenLabRuntime } from '../src/runtime.js';

const temporaryDirectories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'openlab-variants-'));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

async function waitForIdle(runtime: OpenLabRuntime, timeout = 3_000): Promise<void> {
  const started = Date.now();
  while (true) {
    const snapshot = await runtime.snapshot();
    if (snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)?.status !== 'running') return;
    if (Date.now() - started > timeout) throw new Error('turn did not finish');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

describe('turn variants', () => {
  it('regenerates, selects, locks and restores a causal answer path', async () => {
    let answer = 0;
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      id: 'fixture',
      async listModels() { return [{ id: 'fixture-model', label: 'Fixture', contextWindow: 128_000, supportsThinking: true, supportsTools: true, supportsVision: false }]; },
      async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        requests.push(structuredClone(request));
        answer += 1;
        yield { type: 'text_delta', text: `answer-${answer}` };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const root = temporaryDirectory();
    const config = { host: '127.0.0.1' as const, port: 0, authToken: 'token', projectRoot: root, home: join(root, '.runtime'), demo: false, modelProvider: provider };
    const runtime = new OpenLabRuntime(config);
    await runtime.initialize();
    runtime.createAgent({ name: 'Variant Lead', model: 'fixture-model' });
    const first = runtime.submitChat({ text: 'first question', model: 'fixture-model', thinking: 'disabled', reasoningEffort: 'low', permissionMode: 'trusted' });
    await waitForIdle(runtime);
    const initial = (await runtime.snapshot()).turnVariants[0]!;
    const firstVariantId = initial.activeVariantId;
    expect(initial.variants).toHaveLength(1);
    expect(initial.variants[0]).toMatchObject({ status: 'completed' });

    const regeneration = runtime.regenerateTurn(first.turnId);
    await waitForIdle(runtime);
    const regenerated = (await runtime.snapshot()).turnVariants[0]!;
    expect(regenerated.activeVariantId).toBe(regeneration.variantId);
    expect(regenerated.variants).toHaveLength(2);
    expect(requests[1]).toMatchObject({ model: 'fixture-model', thinking: 'disabled', reasoningEffort: 'low' });
    expect((await runtime.snapshot()).timeline.filter((node) => node.kind === 'assistant').map((node) => node.content)).toEqual(['answer-1', 'answer-2']);

    runtime.activateTurnVariant(first.turnId, firstVariantId);
    runtime.submitChat({ text: 'follow-up', model: 'fixture-model' });
    await waitForIdle(runtime);
    const request = requests.at(-1)!;
    expect(request.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: 'answer-1' }),
      expect.objectContaining({ role: 'user', content: 'follow-up' }),
    ]));
    expect(request.messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: 'answer-2' })]));
    const locked = (await runtime.snapshot()).turnVariants[0]!;
    expect(locked).toMatchObject({ activeVariantId: firstVariantId, locked: true });
    expect(() => runtime.activateTurnVariant(first.turnId, regeneration.variantId)).toThrow(/锁定/u);
    const sourceSnapshot = await runtime.snapshot();
    const sourceSessionId = sourceSnapshot.activeSessionId;
    const boundaryNodeId = locked.variants.find((variant) => variant.id === firstVariantId)?.assistantNodeIds.at(-1);
    expect(boundaryNodeId).toBeTruthy();
    runtime.forkSession(sourceSessionId, undefined, boundaryNodeId);
    const forked = await runtime.snapshot();
    expect(forked.timeline.some((node) => node.kind === 'user' && node.content === 'follow-up')).toBe(false);
    expect(forked.turnVariants[0]).toMatchObject({ activeVariantId: firstVariantId });
    expect(forked.turnVariants[0]?.variants.find((variant) => variant.id === firstVariantId)).toMatchObject({ status: 'completed' });

    runtime.switchSession(sourceSessionId);
    const followUpNode = sourceSnapshot.timeline.find((node) => node.kind === 'user' && node.content === 'follow-up');
    expect(followUpNode).toBeTruthy();
    runtime.forkSession(sourceSessionId, undefined, undefined, followUpNode!.id);
    const editFork = await runtime.snapshot();
    expect(editFork.timeline.some((node) => node.kind === 'user' && node.content === 'first question')).toBe(true);
    expect(editFork.timeline.some((node) => node.kind === 'user' && node.content === 'follow-up')).toBe(false);
    runtime.submitChat({ text: 'edited follow-up', model: 'fixture-model' });
    await waitForIdle(runtime);
    const editedRequest = requests.at(-1)!;
    expect(editedRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'first question' }),
      expect.objectContaining({ role: 'assistant', content: 'answer-1' }),
      expect.objectContaining({ role: 'user', content: 'edited follow-up' }),
    ]));
    expect(editedRequest.messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'follow-up' })]));

    runtime.switchSession(sourceSessionId);
    const firstUserNode = sourceSnapshot.timeline.find((node) => node.kind === 'user' && node.content === 'first question');
    expect(firstUserNode).toBeTruthy();
    runtime.forkSession(sourceSessionId, undefined, undefined, firstUserNode!.id);
    expect((await runtime.snapshot()).timeline).toEqual([]);
    runtime.switchSession(sourceSessionId);
    await runtime.stop();

    const restored = new OpenLabRuntime(config);
    await restored.initialize();
    expect((await restored.snapshot()).turnVariants[0]).toMatchObject({ activeVariantId: firstVariantId, locked: true });
    await restored.stop();
  });
});
