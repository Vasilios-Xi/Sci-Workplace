import type {
  LayoutProposalV1,
  WorkbenchInstanceV1,
  WorkbenchSlotV1,
  WorktablePane,
  WorktableSplitNode,
} from '@openlab/protocol';

export interface WorkbenchLayoutDraft {
  layout: WorktableSplitNode;
  panes: WorktablePane[];
  slots: WorkbenchSlotV1[];
  title: string;
  reason: string;
}

export interface WorkbenchLayoutDiff {
  addedPanes: string[];
  removedPanes: string[];
  movedTabs: string[];
  reorderedTabs: string[];
}

export interface WorkbenchLayoutCopy {
  paneFallback(id: string): string;
  missingPane: string;
  maximumPanes: string;
  newPane: string;
  splitTitle(direction: 'horizontal' | 'vertical'): string;
  splitReason(pane: string): string;
  lastPane: string;
  noAdjacentPane: string;
  mergeTitle: string;
  mergeReason(source: string, tabCount: number, destination: string): string;
  missingTab: string;
  samePane: string;
  moveTitle: string;
  moveReason(tab: string, source: string, destination: string): string;
  reorderBoundary: string;
  reorderTitle: string;
  reorderReason(tab: string, pane: string, offset: -1 | 1): string;
}

const defaultCopy: WorkbenchLayoutCopy = {
  paneFallback: (id) => `Pane ${id.slice(0, 8)}`,
  missingPane: 'The target pane does not exist',
  maximumPanes: 'A workbench can display at most 6 panes',
  newPane: 'New pane',
  splitTitle: (direction) => direction === 'horizontal' ? 'Split pane to the right' : 'Split pane below',
  splitReason: (pane) => `Split “${pane}” and add an empty pane.`,
  lastPane: 'The final pane cannot be merged',
  noAdjacentPane: 'No adjacent pane is available to merge',
  mergeTitle: 'Merge current pane',
  mergeReason: (source, tabCount, destination) => `Remove “${source}” and move ${tabCount} tabs into “${destination}”.`,
  missingTab: 'The tab to move does not exist',
  samePane: 'The tab is already in the target pane',
  moveTitle: 'Move workbench tab',
  moveReason: (tab, source, destination) => `Move “${tab}” from “${source}” to “${destination}”.`,
  reorderBoundary: 'The tab is already at the end in that direction',
  reorderTitle: 'Reorder workbench tab',
  reorderReason: (tab, pane, offset) => `Move “${tab}” one position ${offset < 0 ? 'earlier' : 'later'} in “${pane}”.`,
};

function paneTitle(pane: WorktablePane, copy: WorkbenchLayoutCopy = defaultCopy): string {
  return pane.title?.trim() || copy.paneFallback(pane.id);
}

function replacePane(node: WorktableSplitNode, paneId: string, replacement: WorktableSplitNode): WorktableSplitNode {
  if (node.kind === 'pane') return node.paneId === paneId ? replacement : node;
  return {
    ...node,
    first: replacePane(node.first, paneId, replacement),
    second: replacePane(node.second, paneId, replacement),
  };
}

function firstPaneId(node: WorktableSplitNode): string {
  return node.kind === 'pane' ? node.paneId : firstPaneId(node.first);
}

function withoutPane(node: WorktableSplitNode, paneId: string): { layout: WorktableSplitNode; destinationPaneId: string } | undefined {
  if (node.kind === 'pane') return undefined;
  if (node.first.kind === 'pane' && node.first.paneId === paneId) {
    return { layout: structuredClone(node.second), destinationPaneId: firstPaneId(node.second) };
  }
  if (node.second.kind === 'pane' && node.second.paneId === paneId) {
    return { layout: structuredClone(node.first), destinationPaneId: firstPaneId(node.first) };
  }
  const first = withoutPane(node.first, paneId);
  if (first) return { ...first, layout: { ...node, first: first.layout } };
  const second = withoutPane(node.second, paneId);
  return second ? { ...second, layout: { ...node, second: second.layout } } : undefined;
}

function requirePane(instance: WorkbenchInstanceV1, paneId: string, copy: WorkbenchLayoutCopy): WorktablePane {
  const pane = instance.panes.find((candidate) => candidate.id === paneId);
  if (!pane) throw new Error(copy.missingPane);
  return pane;
}

export function splitWorkbenchPane(
  instance: WorkbenchInstanceV1,
  paneId: string,
  direction: 'horizontal' | 'vertical',
  idFactory: () => string = () => crypto.randomUUID(),
  copy: WorkbenchLayoutCopy = defaultCopy,
): WorkbenchLayoutDraft {
  const pane = requirePane(instance, paneId, copy);
  if (instance.panes.length >= 6) throw new Error(copy.maximumPanes);
  const newPaneId = idFactory();
  const newPane: WorktablePane = { id: newPaneId, title: copy.newPane, tabs: [] };
  return {
    layout: replacePane(instance.layout, paneId, {
      kind: 'split', direction, ratio: 0.5,
      first: { kind: 'pane', paneId }, second: { kind: 'pane', paneId: newPaneId },
    }),
    panes: [...structuredClone(instance.panes), newPane],
    slots: structuredClone(instance.slots),
    title: copy.splitTitle(direction),
    reason: copy.splitReason(paneTitle(pane, copy)),
  };
}

export function mergeWorkbenchPane(instance: WorkbenchInstanceV1, paneId: string, copy: WorkbenchLayoutCopy = defaultCopy): WorkbenchLayoutDraft {
  const pane = requirePane(instance, paneId, copy);
  if (instance.panes.length <= 1) throw new Error(copy.lastPane);
  const removed = withoutPane(instance.layout, paneId);
  if (!removed) throw new Error(copy.noAdjacentPane);
  const destination = requirePane(instance, removed.destinationPaneId, copy);
  const movedTabs = structuredClone(pane.tabs);
  const panes = instance.panes.filter((candidate) => candidate.id !== paneId).map((candidate) => {
    if (candidate.id !== destination.id) return structuredClone(candidate);
    const tabs = [...structuredClone(candidate.tabs), ...movedTabs];
    return {
      ...structuredClone(candidate), tabs,
      ...(pane.activeTabId && movedTabs.some((tab) => tab.id === pane.activeTabId)
        ? { activeTabId: pane.activeTabId }
        : candidate.activeTabId ? { activeTabId: candidate.activeTabId } : tabs[0] ? { activeTabId: tabs[0].id } : {}),
    };
  });
  return {
    layout: removed.layout,
    panes,
    slots: instance.slots.map((slot) => slot.paneId === paneId ? { ...structuredClone(slot), paneId: destination.id } : structuredClone(slot)),
    title: copy.mergeTitle,
    reason: copy.mergeReason(paneTitle(pane, copy), movedTabs.length, paneTitle(destination, copy)),
  };
}

export function moveWorkbenchTab(instance: WorkbenchInstanceV1, tabId: string, targetPaneId: string, copy: WorkbenchLayoutCopy = defaultCopy): WorkbenchLayoutDraft {
  const source = instance.panes.find((pane) => pane.tabs.some((tab) => tab.id === tabId));
  const target = requirePane(instance, targetPaneId, copy);
  const tab = source?.tabs.find((candidate) => candidate.id === tabId);
  if (!source || !tab) throw new Error(copy.missingTab);
  if (source.id === target.id) throw new Error(copy.samePane);
  const panes = instance.panes.map((pane) => {
    if (pane.id === source.id) {
      const tabs = pane.tabs.filter((candidate) => candidate.id !== tabId);
      const activeTabId = pane.activeTabId === tabId ? tabs.at(-1)?.id : pane.activeTabId;
      const { activeTabId: _current, ...rest } = structuredClone(pane);
      return { ...rest, tabs, ...(activeTabId ? { activeTabId } : {}) };
    }
    if (pane.id === target.id) return { ...structuredClone(pane), tabs: [...structuredClone(pane.tabs), structuredClone(tab)], activeTabId: tab.id };
    return structuredClone(pane);
  });
  return {
    layout: structuredClone(instance.layout), panes, slots: structuredClone(instance.slots),
    title: copy.moveTitle,
    reason: copy.moveReason(tab.title, paneTitle(source, copy), paneTitle(target, copy)),
  };
}

export function reorderWorkbenchTab(instance: WorkbenchInstanceV1, paneId: string, tabId: string, offset: -1 | 1, copy: WorkbenchLayoutCopy = defaultCopy): WorkbenchLayoutDraft {
  const pane = requirePane(instance, paneId, copy);
  const index = pane.tabs.findIndex((tab) => tab.id === tabId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= pane.tabs.length) throw new Error(copy.reorderBoundary);
  const tabs = structuredClone(pane.tabs);
  const [tab] = tabs.splice(index, 1);
  tabs.splice(target, 0, tab!);
  return {
    layout: structuredClone(instance.layout),
    panes: instance.panes.map((candidate) => candidate.id === paneId ? { ...structuredClone(candidate), tabs } : structuredClone(candidate)),
    slots: structuredClone(instance.slots),
    title: copy.reorderTitle,
    reason: copy.reorderReason(tab!.title, paneTitle(pane, copy), offset),
  };
}

export function describeWorkbenchLayoutDiff(instance: WorkbenchInstanceV1, proposal: LayoutProposalV1, copy: WorkbenchLayoutCopy = defaultCopy): WorkbenchLayoutDiff {
  const currentPanes = new Map(instance.panes.map((pane) => [pane.id, pane]));
  const proposedPanes = new Map(proposal.panes.map((pane) => [pane.id, pane]));
  const currentTabPane = new Map(instance.panes.flatMap((pane) => pane.tabs.map((tab) => [tab.id, pane.id] as const)));
  const proposedTabPane = new Map(proposal.panes.flatMap((pane) => pane.tabs.map((tab) => [tab.id, pane.id] as const)));
  const movedTabs = instance.panes.flatMap((pane) => pane.tabs).filter((tab) => {
    const before = currentTabPane.get(tab.id);
    const after = proposedTabPane.get(tab.id);
    return before && after && before !== after;
  }).map((tab) => tab.title);
  const reorderedTabs: string[] = [];
  for (const [paneId, current] of currentPanes) {
    const proposed = proposedPanes.get(paneId);
    if (!proposed) continue;
    const stableCurrent = current.tabs.map((tab) => tab.id).filter((id) => proposed.tabs.some((tab) => tab.id === id));
    const stableProposed = proposed.tabs.map((tab) => tab.id).filter((id) => current.tabs.some((tab) => tab.id === id));
    if (stableCurrent.join('\0') !== stableProposed.join('\0')) reorderedTabs.push(paneTitle(current, copy));
  }
  return {
    addedPanes: proposal.panes.filter((pane) => !currentPanes.has(pane.id)).map((pane) => paneTitle(pane, copy)),
    removedPanes: instance.panes.filter((pane) => !proposedPanes.has(pane.id)).map((pane) => paneTitle(pane, copy)),
    movedTabs,
    reorderedTabs,
  };
}
