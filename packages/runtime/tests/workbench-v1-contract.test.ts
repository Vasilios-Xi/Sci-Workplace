import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteEventStore } from '../src/events/event-store.js';
import { CORE_WORKBENCH_BLUEPRINTS, WorkbenchService } from '../src/workbench/workbench-service.js';
import { WorktableStore } from '../src/worktable/worktable-store.js';

const roots: string[] = [];
const actor = { id: 'owner', kind: 'user', label: 'Local owner' } as const;

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'sci-workbench-v1-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('Workbench v1 contract', () => {
  it('keeps multiple conversation-bound instances, idempotent mounts, and accepted layout proposals across restart', () => {
    const database = join(temporaryDirectory(), 'events.sqlite');
    const events = new SqliteEventStore(database);
    const worktables = new WorktableStore({ projectId: 'project-one', events });
    const workbenches = new WorkbenchService({ projectId: 'project-one', events, worktables });

    const first = workbenches.create({ blueprintId: 'sci.core:research', title: '论文 A 精读', primaryConversationId: 'conversation-a' }, actor);
    const second = workbenches.create({ blueprintId: 'sci.core:research', title: '图 3 重绘', primaryConversationId: 'conversation-b' }, actor);
    expect(workbenches.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, primaryConversationId: 'conversation-a' }),
      expect.objectContaining({ id: second.id, primaryConversationId: 'conversation-b' }),
    ]));

    const intent = {
      schemaVersion: 1 as const,
      idempotencyKey: 'artifact:figure-3:revision-1',
      instanceId: second.id,
      targetRole: 'output',
      artifact: { artifactId: 'figure-3', revisionId: 'revision-1' },
      title: 'Figure 3',
    };
    const mounted = workbenches.mount(intent, actor);
    const tabsAfterMount = mounted.panes.flatMap((pane) => pane.tabs).length;
    expect(workbenches.mount(intent, actor).panes.flatMap((pane) => pane.tabs)).toHaveLength(tabsAfterMount);

    const proposal = workbenches.proposeLayout({
      instanceId: second.id,
      baseRevision: mounted.revision,
      title: '调整绘图画布比例',
      reason: '为产物预览提供更大空间',
      layout: mounted.layout.kind === 'split' ? { ...mounted.layout, ratio: 0.2 } : mounted.layout,
      panes: mounted.panes,
      slots: mounted.slots,
    }, actor);
    expect(workbenches.decideLayout(proposal.id, true, actor).status).toBe('accepted');
    const accepted = workbenches.inspect(second.id);
    expect(accepted.revision).toBe(mounted.revision + 1);
    expect(accepted.layout.kind === 'split' ? accepted.layout.ratio : 1).toBe(0.2);
    events.close();

    const reopenedEvents = new SqliteEventStore(database);
    const reopenedTables = new WorktableStore({ projectId: 'project-one', events: reopenedEvents });
    const reopened = new WorkbenchService({ projectId: 'project-one', events: reopenedEvents, worktables: reopenedTables });
    expect(reopened.inspect(first.id)).toMatchObject({ title: '论文 A 精读', primaryConversationId: 'conversation-a' });
    expect(reopened.inspect(second.id)).toMatchObject({ revision: accepted.revision, primaryConversationId: 'conversation-b' });
    expect(reopened.proposals(second.id)).toEqual([expect.objectContaining({ id: proposal.id, status: 'accepted' })]);
    expect(reopened.mount(intent, actor).panes.flatMap((pane) => pane.tabs)).toHaveLength(tabsAfterMount);
    reopenedEvents.close();
  });

  it('marks a layout proposal stale when the shared instance revision changes and supports rejection without mutation', () => {
    const events = new SqliteEventStore(join(temporaryDirectory(), 'events.sqlite'));
    const worktables = new WorktableStore({ projectId: 'project-two', events });
    const workbenches = new WorkbenchService({ projectId: 'project-two', events, worktables });
    const instance = workbenches.create({ blueprintId: CORE_WORKBENCH_BLUEPRINTS[0]!.id, primaryConversationId: 'conversation-a' }, actor);
    const input = {
      instanceId: instance.id, baseRevision: instance.revision, title: '候选布局', reason: 'test',
      layout: instance.layout, panes: instance.panes, slots: instance.slots,
    };
    const rejected = workbenches.proposeLayout(input, actor);
    expect(workbenches.decideLayout(rejected.id, false, actor).status).toBe('rejected');
    expect(workbenches.inspect(instance.id).revision).toBe(instance.revision);

    const stale = workbenches.proposeLayout(input, actor);
    workbenches.syncConversation(instance.id, 'conversation-b', actor);
    expect(workbenches.decideLayout(stale.id, true, actor).status).toBe('stale');
    expect(workbenches.inspect(instance.id).primaryConversationId).toBe('conversation-b');
    events.close();
  });
});
