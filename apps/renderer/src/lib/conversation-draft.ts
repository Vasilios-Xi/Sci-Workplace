import type { ConversationProjectTarget, SessionAgentBinding } from '@openlab/protocol';

export type ConversationDraftPhase = 'editing' | 'submitting' | 'committing';

export interface ConversationDraft {
  id: string;
  temporary: boolean;
  target: ConversationProjectTarget;
  binding: SessionAgentBinding;
  phase: ConversationDraftPhase;
  attemptId?: string;
  committedSessionId?: string;
}

export type ConversationDraftAction =
  | { type: 'start'; id: string; temporary: boolean; binding: SessionAgentBinding }
  | { type: 'select-target'; draftId: string; target: ConversationProjectTarget }
  | { type: 'choose-agent'; draftId: string; leadAgentId: string; updatedAt: string }
  | { type: 'sync-binding'; draftId: string; binding: SessionAgentBinding }
  | { type: 'submit'; draftId: string; attemptId: string }
  | { type: 'commit-ready'; draftId: string; attemptId: string; sessionId: string }
  | { type: 'submit-failed'; draftId: string; attemptId: string }
  | { type: 'complete'; draftId: string; attemptId: string; sessionId: string }
  | { type: 'cancel'; draftId?: string };

export function conversationDraftReducer(
  state: ConversationDraft | null,
  action: ConversationDraftAction,
): ConversationDraft | null {
  if (action.type === 'start') {
    return {
      id: action.id,
      temporary: action.temporary,
      target: { kind: 'detached' },
      binding: action.binding,
      phase: 'editing',
    };
  }
  if (!state) return null;
  if (action.type === 'cancel') {
    if (action.draftId && action.draftId !== state.id) return state;
    return state.phase === 'editing' ? null : state;
  }
  if (action.draftId !== state.id) return state;

  if (action.type === 'select-target') {
    return state.phase === 'editing' ? { ...state, target: action.target } : state;
  }
  if (action.type === 'choose-agent') {
    return state.phase === 'editing' ? {
      ...state,
      binding: {
        ...state.binding,
        leadAgentId: action.leadAgentId,
        memberAgentIds: [],
        capabilitySnapshotIds: [],
        updatedAt: action.updatedAt,
      },
    } : state;
  }
  if (action.type === 'sync-binding') {
    return state.phase === 'editing' ? { ...state, binding: action.binding } : state;
  }
  if (action.type === 'submit') {
    return state.phase === 'editing' ? { ...state, phase: 'submitting', attemptId: action.attemptId } : state;
  }
  if (action.attemptId !== state.attemptId) return state;
  if (action.type === 'submit-failed') {
    const { attemptId: _attemptId, committedSessionId: _committedSessionId, ...draft } = state;
    return state.phase === 'submitting' ? { ...draft, phase: 'editing' } : state;
  }
  if (action.type === 'commit-ready') {
    return state.phase === 'submitting' ? { ...state, phase: 'committing', committedSessionId: action.sessionId } : state;
  }
  if (action.type === 'complete') {
    return state.phase === 'committing' && state.committedSessionId === action.sessionId ? null : state;
  }
  return state;
}
