import { describe, expect, it } from 'vitest';
import type { WorkbenchInstanceV1 } from '@openlab/protocol';
import {
  describeWorkbenchLayoutDiff,
  mergeWorkbenchPane,
  moveWorkbenchTab,
  reorderWorkbenchTab,
  splitWorkbenchPane,
} from '../src/lib/workbench-layout.js';

function fixture(): WorkbenchInstanceV1 {
  return {
    schemaVersion: 1, id: 'workbench', projectId: 'project', blueprintId: 'fixture', blueprintVersion: '1.0.0',
    templateId: 'fixture', templateVersion: '1.0.0', title: 'Fixture', icon: 'flask', kind: 'research', status: 'idle', revision: 3,
    inputs: {}, layout: { kind: 'split', direction: 'horizontal', ratio: .5, first: { kind: 'pane', paneId: 'left' }, second: { kind: 'pane', paneId: 'right' } },
    panes: [
      { id: 'left', title: '来源', tabs: [{ id: 'a', title: 'A', content: { kind: 'builtin', type: 'explorer' }, openedAt: 'now' }, { id: 'b', title: 'B', content: { kind: 'builtin', type: 'tasks' }, openedAt: 'now' }], activeTabId: 'a' },
      { id: 'right', title: '分析', tabs: [{ id: 'c', title: 'C', content: { kind: 'builtin', type: 'control-room' }, openedAt: 'now' }], activeTabId: 'c' },
    ],
    activePaneId: 'left', slots: [{ id: 'source', role: 'source', paneId: 'left', title: '来源', accepts: ['document'], autoMount: false }],
    createdAt: 'now', updatedAt: 'now',
  };
}

describe('user workbench layout editor', () => {
  it('creates reviewable split and merge drafts while preserving slot targets', () => {
    const source = fixture();
    const split = splitWorkbenchPane(source, 'left', 'vertical', () => 'new-pane');
    expect(split.panes.map((pane) => pane.id)).toEqual(['left', 'right', 'new-pane']);
    expect(split.slots[0]?.paneId).toBe('left');

    const merged = mergeWorkbenchPane(source, 'left');
    expect(merged.layout).toEqual({ kind: 'pane', paneId: 'right' });
    expect(merged.panes).toHaveLength(1);
    expect(merged.panes[0]?.tabs.map((tab) => tab.id)).toEqual(['c', 'a', 'b']);
    expect(merged.slots[0]?.paneId).toBe('right');
  });

  it('moves and reorders tabs without mutating the current instance', () => {
    const source = fixture();
    const moved = moveWorkbenchTab(source, 'b', 'right');
    expect(source.panes[0]?.tabs.map((tab) => tab.id)).toEqual(['a', 'b']);
    expect(moved.panes[1]?.tabs.map((tab) => tab.id)).toEqual(['c', 'b']);
    const reordered = reorderWorkbenchTab(source, 'left', 'b', -1);
    expect(reordered.panes[0]?.tabs.map((tab) => tab.id)).toEqual(['b', 'a']);
  });

  it('describes pane, tab move, and tab-order differences for confirmation', () => {
    const source = fixture();
    const draft = moveWorkbenchTab(source, 'b', 'right');
    const proposal = { schemaVersion: 1 as const, id: 'proposal', instanceId: source.id, baseRevision: source.revision, status: 'pending' as const, createdAt: 'now', ...draft };
    expect(describeWorkbenchLayoutDiff(source, proposal)).toMatchObject({ movedTabs: ['B'], addedPanes: [], removedPanes: [] });
  });
});
