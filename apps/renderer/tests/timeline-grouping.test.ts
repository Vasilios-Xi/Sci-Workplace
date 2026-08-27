import { describe, expect, it } from 'vitest';
import type { TimelineNode } from '@openlab/protocol';
import { assistantIdentityNodeIds, toolNodeBatches } from '../src/lib/timeline-grouping.js';

const node = (id: string, kind: TimelineNode['kind'], turnId?: string): TimelineNode => ({
  id,
  kind,
  content: id,
  timestamp: '2026-08-27T00:00:00.000Z',
  metadata: turnId ? { turnId } : {},
});

describe('timeline assistant identity grouping', () => {
  it('shows one avatar and name across reasoning, tools, and answer continuations in one turn', () => {
    const nodes = [
      node('user-1', 'user', 'turn-1'),
      node('reasoning-1', 'reasoning', 'turn-1'),
      node('assistant-1', 'assistant', 'turn-1'),
      node('tool-1', 'tool', 'turn-1'),
      node('reasoning-2', 'reasoning', 'turn-1'),
      node('assistant-2', 'assistant', 'turn-1'),
    ];
    expect([...assistantIdentityNodeIds(nodes)]).toEqual(['reasoning-1']);
  });

  it('shows identity again for the next user turn', () => {
    const nodes = [
      node('user-1', 'user', 'turn-1'),
      node('assistant-1', 'assistant', 'turn-1'),
      node('user-2', 'user', 'turn-2'),
      node('assistant-2', 'assistant', 'turn-2'),
    ];
    expect([...assistantIdentityNodeIds(nodes)]).toEqual(['assistant-1', 'assistant-2']);
  });

  it('groups legacy nodes between adjacent user messages', () => {
    const nodes = [node('user-1', 'user'), node('reasoning-1', 'reasoning'), node('tool-1', 'tool'), node('assistant-1', 'assistant')];
    expect([...assistantIdentityNodeIds(nodes)]).toEqual(['reasoning-1']);
  });

  it('groups consecutive calls into one tool batch and keeps reasoning boundaries', () => {
    const nodes = [
      node('reasoning-1', 'reasoning', 'turn-1'),
      node('tool-1', 'tool', 'turn-1'),
      node('tool-2', 'tool', 'turn-1'),
      node('reasoning-2', 'reasoning', 'turn-1'),
      node('tool-3', 'tool', 'turn-1'),
      node('assistant-1', 'assistant', 'turn-1'),
    ];
    expect(toolNodeBatches(nodes).map((batch) => batch.map((item) => item.id))).toEqual([
      ['tool-1', 'tool-2'],
      ['tool-3'],
    ]);
  });
});
