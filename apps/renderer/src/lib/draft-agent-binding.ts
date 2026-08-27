import type { AgentDefinition, SessionAgentBinding } from '@openlab/protocol';

export function normalizeDraftAgentBinding(input: {
  sessionId: string;
  current: SessionAgentBinding;
  fallback: SessionAgentBinding;
  definitions: AgentDefinition[];
  updatedAt?: string;
}): SessionAgentBinding {
  const activeIds = new Set(input.definitions.filter((agent) => agent.status === 'active').map((agent) => agent.id));
  const leadAgentId = [input.current.leadAgentId, input.fallback.leadAgentId, ...input.definitions.map((agent) => agent.id)]
    .find((id) => activeIds.has(id)) ?? '';
  const unchanged = input.current.sessionId === input.sessionId
    && input.current.leadAgentId === leadAgentId
    && input.current.memberAgentIds.length === 0
    && input.current.capabilitySnapshotIds.length === 0;
  if (unchanged) return input.current;
  return {
    sessionId: input.sessionId,
    leadAgentId,
    memberAgentIds: [],
    capabilitySnapshotIds: [],
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}
