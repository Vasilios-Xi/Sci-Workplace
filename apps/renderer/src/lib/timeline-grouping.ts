import type { TimelineNode } from '@openlab/protocol';

const isAssistantIdentityNode = (node: TimelineNode): boolean => node.kind === 'reasoning' || node.kind === 'assistant';

export function assistantIdentityNodeIds(nodes: TimelineNode[]): Set<string> {
  const firstNodes = new Set<string>();
  const seenTurns = new Set<string>();
  let legacyTurn = 0;

  for (const node of nodes) {
    if (node.kind === 'user') {
      legacyTurn += 1;
      continue;
    }
    if (!isAssistantIdentityNode(node)) continue;
    const turnId = typeof node.metadata.turnId === 'string' ? node.metadata.turnId : undefined;
    const key = turnId ? `turn:${turnId}` : `legacy:${legacyTurn}`;
    if (seenTurns.has(key)) continue;
    seenTurns.add(key);
    firstNodes.add(node.id);
  }

  return firstNodes;
}

export function toolNodeBatches(nodes: TimelineNode[]): TimelineNode[][] {
  const batches: TimelineNode[][] = [];
  let current: TimelineNode[] = [];

  const flush = () => {
    if (current.length > 0) batches.push(current);
    current = [];
  };

  for (const node of nodes) {
    if (node.kind === 'tool') current.push(node);
    else flush();
  }
  flush();
  return batches;
}
