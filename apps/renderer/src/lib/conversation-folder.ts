import type { SessionWorkspace, WorkspaceRootSummary } from '@openlab/protocol';

export function conversationFolderRoot(workspace: SessionWorkspace, projectFolderSelected: boolean): WorkspaceRootSummary | undefined {
  const activeRoot = workspace.roots.find((root) => root.id === workspace.activeRootId);
  if (!activeRoot || activeRoot.status !== 'online') return undefined;
  return activeRoot.kind === 'authorized' || projectFolderSelected ? activeRoot : undefined;
}
