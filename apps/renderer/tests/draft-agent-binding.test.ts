import { describe, expect, it } from 'vitest';
import type { AgentDefinition, SessionAgentBinding } from '@openlab/protocol';
import { normalizeDraftAgentBinding } from '../src/lib/draft-agent-binding.js';

const now = '2026-08-26T00:00:00.000Z';

function agent(id: string, status: AgentDefinition['status'] = 'active'): AgentDefinition {
  return {
    id,
    name: id,
    avatar: 'sage',
    templateId: 'research_lead',
    identity: `# ${id}`,
    instructions: '- test',
    model: 'fixture-model',
    reasoningEffort: 'high',
    toolPolicy: { enabledCapabilityIds: [], disabledToolIds: [], revision: 1 },
    memoryPolicy: { memoryEnabled: false, experienceEnabled: false },
    status,
    createdAt: now,
    updatedAt: now,
  };
}

function binding(sessionId: string, leadAgentId: string, memberAgentIds: string[] = []): SessionAgentBinding {
  return { sessionId, leadAgentId, memberAgentIds, capabilitySnapshotIds: ['old-capability'], updatedAt: now };
}

describe('draft Agent binding', () => {
  it('keeps the selected project Agent and never carries the previous lead as a hidden member', () => {
    const result = normalizeDraftAgentBinding({
      sessionId: 'draft:one',
      current: binding('old-session', 'agent-b', ['agent-a']),
      fallback: binding('old-session', 'agent-a'),
      definitions: [agent('agent-a'), agent('agent-b')],
      updatedAt: now,
    });
    expect(result).toMatchObject({ sessionId: 'draft:one', leadAgentId: 'agent-b', memberAgentIds: [], capabilitySnapshotIds: [] });
  });

  it('keeps an active Agent available across projects and ignores archived Agents', () => {
    const result = normalizeDraftAgentBinding({
      sessionId: 'draft:two',
      current: binding('draft:two', 'agent-a'),
      fallback: binding('new-project-session', 'agent-a'),
      definitions: [agent('agent-a'), agent('agent-b'), agent('agent-c', 'archived')],
      updatedAt: now,
    });
    expect(result).toMatchObject({ sessionId: 'draft:two', leadAgentId: 'agent-a', memberAgentIds: [] });
  });
});
