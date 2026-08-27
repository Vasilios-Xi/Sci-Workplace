import { describe, expect, it } from 'vitest';
import type { SessionAgentBinding } from '@openlab/protocol';
import { conversationDraftReducer } from '../src/lib/conversation-draft.js';

const binding: SessionAgentBinding = {
  sessionId: 'draft:one',
  leadAgentId: 'agent-one',
  memberAgentIds: [],
  capabilitySnapshotIds: [],
  updatedAt: '2026-08-26T00:00:00.000Z',
};

describe('new conversation state machine', () => {
  it('always starts detached and keeps project selection renderer-local', () => {
    const started = conversationDraftReducer(null, { type: 'start', id: 'one', temporary: false, binding });
    expect(started?.target).toEqual({ kind: 'detached' });
    const selected = conversationDraftReducer(started, {
      type: 'select-target',
      draftId: 'one',
      target: { kind: 'project', rootPath: 'F:\\Research', name: 'Research' },
    });
    expect(selected?.target).toMatchObject({ kind: 'project', name: 'Research' });
    expect(selected?.phase).toBe('editing');
  });

  it('locks navigation mutations while an atomic submission is in flight', () => {
    const started = conversationDraftReducer(null, { type: 'start', id: 'one', temporary: false, binding });
    const submitting = conversationDraftReducer(started, { type: 'submit', draftId: 'one', attemptId: 'attempt-one' });
    expect(conversationDraftReducer(submitting, { type: 'cancel', draftId: 'one' })).toEqual(submitting);
    expect(conversationDraftReducer(submitting, {
      type: 'select-target', draftId: 'one', target: { kind: 'project', rootPath: 'F:\\Other', name: 'Other' },
    })).toEqual(submitting);
  });

  it('does not let stale completions clear a newer draft', () => {
    const oldDraft = conversationDraftReducer(null, { type: 'start', id: 'old', temporary: false, binding });
    const submitting = conversationDraftReducer(oldDraft, { type: 'submit', draftId: 'old', attemptId: 'old-attempt' });
    const newer = conversationDraftReducer(submitting, { type: 'start', id: 'new', temporary: false, binding: { ...binding, sessionId: 'draft:new' } });
    const stale = conversationDraftReducer(newer, { type: 'complete', draftId: 'old', attemptId: 'old-attempt', sessionId: 'session-old' });
    expect(stale?.id).toBe('new');
  });

  it('returns to editing after failure and only completes the committed session', () => {
    const started = conversationDraftReducer(null, { type: 'start', id: 'one', temporary: false, binding });
    const submitting = conversationDraftReducer(started, { type: 'submit', draftId: 'one', attemptId: 'attempt-one' });
    const failed = conversationDraftReducer(submitting, { type: 'submit-failed', draftId: 'one', attemptId: 'attempt-one' });
    expect(failed?.phase).toBe('editing');

    const retrying = conversationDraftReducer(failed, { type: 'submit', draftId: 'one', attemptId: 'attempt-two' });
    const committing = conversationDraftReducer(retrying, { type: 'commit-ready', draftId: 'one', attemptId: 'attempt-two', sessionId: 'session-two' });
    expect(conversationDraftReducer(committing, { type: 'complete', draftId: 'one', attemptId: 'attempt-two', sessionId: 'wrong' })).toEqual(committing);
    expect(conversationDraftReducer(committing, { type: 'complete', draftId: 'one', attemptId: 'attempt-two', sessionId: 'session-two' })).toBeNull();
  });
});
