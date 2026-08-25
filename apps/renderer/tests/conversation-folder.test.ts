import { describe, expect, it } from 'vitest';
import type { SessionWorkspace } from '@openlab/protocol';
import { conversationFolderRoot } from '../src/lib/conversation-folder.js';

const workspace: SessionWorkspace = {
  sessionId: 'session-1',
  activeRootId: 'project',
  roots: [{ id: 'project', name: 'Getting Started', displayPath: 'C:\\OpenLab', kind: 'project', access: 'ask', status: 'online' }],
  note: '',
  model: 'test',
  conversationFileCount: 0,
};

describe('conversationFolderRoot', () => {
  it('hides the default scratch folder until a project folder is selected', () => {
    expect(conversationFolderRoot(workspace, false)).toBeUndefined();
  });

  it('shows an explicitly selected project folder', () => {
    expect(conversationFolderRoot(workspace, true)?.id).toBe('project');
  });

  it('shows an authorized folder selected for the conversation', () => {
    const authorized: SessionWorkspace = {
      ...workspace,
      activeRootId: 'authorized-1',
      roots: [...workspace.roots, { id: 'authorized-1', name: 'Evidence', displayPath: 'D:\\Evidence', kind: 'authorized', access: 'read_only', status: 'online' }],
    };
    expect(conversationFolderRoot(authorized, false)?.id).toBe('authorized-1');
  });

  it('hides an unavailable active folder', () => {
    const offline: SessionWorkspace = { ...workspace, roots: workspace.roots.map((root) => ({ ...root, status: 'offline' as const })) };
    expect(conversationFolderRoot(offline, true)).toBeUndefined();
  });
});
