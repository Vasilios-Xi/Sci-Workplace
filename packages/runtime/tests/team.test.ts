import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDefinition, AgentPreset } from '@openlab/protocol';
import { TeamManager } from '../src/agent/team-manager.js';
import { SqliteEventStore } from '../src/events/event-store.js';

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(name: string, id: string): { definition: AgentDefinition; preset: AgentPreset } {
  const now = new Date().toISOString();
  return {
    definition: {
      id, name, avatar: 'sage', identity: name, instructions: 'test', model: 'demo', reasoningEffort: 'high', status: 'active', createdAt: now, updatedAt: now,
      toolPolicy: { enabledCapabilityIds: ['workspace.read', 'collaboration'], disabledToolIds: [], revision: 1 },
      memoryPolicy: { memoryEnabled: false, experienceEnabled: false },
    },
    preset: { id: `preset:${id}`, name, role: id === 'lead' ? 'lead' : 'member', instructions: '', model: 'demo', thinking: 'enabled', reasoningEffort: 'high', toolNames: ['read_file'], skillIds: [], permissionMode: 'ask', contextBudget: 128_000 },
  };
}

function setup(runMember: ConstructorParameters<typeof TeamManager>[0]['runMember'], maxConcurrent = 3) {
  const root = mkdtempSync(join(tmpdir(), 'openlab-team-')); temporaryDirectories.push(root);
  const events = new SqliteEventStore(join(root, 'events.db'));
  const team = new TeamManager({ sessionId: 'session', events, maxConcurrent, runMember });
  const lead = fixture('主管', 'lead'); const memberA = fixture('成员 A', 'member-a'); const memberB = fixture('成员 B', 'member-b');
  const leadRun = team.createLead(lead.definition, lead.preset);
  return { events, team, lead, memberA, memberB, leadRun };
}

describe('persistent Agent team manager', () => {
  it('limits persistent member concurrency without creating identities', async () => {
    let active = 0; let maximum = 0;
    const environment = setup(async () => { active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 35)); active -= 1; return { text: 'done' }; }, 2);
    const runs = Array.from({ length: 4 }, (_, index) => environment.team.assignTask({ leadRunId: environment.leadRun.id, target: index % 2 ? environment.memberA.definition : environment.memberB.definition, preset: index % 2 ? environment.memberA.preset : environment.memberB.preset, title: `task ${index}`, description: 'test', inputRefs: [] }));
    await environment.team.waitForRuns(runs.map((run) => run.runId), new AbortController().signal);
    expect(maximum).toBe(2);
    expect(environment.team.snapshot().runs.filter((run) => run.role === 'member')).toHaveLength(4);
    expect(environment.team.snapshot().tasks.every((task) => task.status === 'completed')).toBe(true);
    await environment.team.stop(); environment.events.close();
  });

  it('uses the immutable member preset registered for the user-created target', async () => {
    const observed: AgentPreset[] = [];
    const environment = setup(async ({ preset }) => { observed.push(preset); return {}; }, 1);
    environment.memberA.preset.toolNames = ['read_file']; environment.memberA.preset.permissionMode = 'read_only';
    const delegated = environment.team.assignTask({ leadRunId: environment.leadRun.id, target: environment.memberA.definition, preset: environment.memberA.preset, title: 'limited', description: 'limited', inputRefs: [] });
    await environment.team.waitForRuns([delegated.runId], new AbortController().signal);
    expect(observed[0]).toMatchObject({ role: 'member', permissionMode: 'read_only', toolNames: ['read_file'] });
    await environment.team.stop(); environment.events.close();
  });

  it('retries a failed persistent member run with its recorded configuration', async () => {
    let attempts = 0; const tools: string[][] = [];
    const environment = setup(async ({ preset }) => { tools.push(preset.toolNames); attempts += 1; if (attempts === 1) throw new Error('fixture'); return { outputRefs: ['artifact:retry'] }; }, 1);
    const delegated = environment.team.assignTask({ leadRunId: environment.leadRun.id, target: environment.memberA.definition, preset: environment.memberA.preset, title: 'retry', description: 'retry', inputRefs: [] });
    await environment.team.waitForRuns([delegated.runId], new AbortController().signal);
    expect(environment.team.snapshot().runs.find((run) => run.id === delegated.runId)?.status).toBe('failed');
    environment.team.resume(delegated.runId);
    await environment.team.waitForRuns([delegated.runId], new AbortController().signal);
    expect(tools).toEqual([['read_file'], ['read_file']]);
    expect(environment.team.snapshot().tasks.find((task) => task.id === delegated.taskId)).toMatchObject({ status: 'completed', outputRefs: ['artifact:retry'] });
    await environment.team.stop(); environment.events.close();
  });

  it('keeps ordered mail, supports clarification and lets the lead take over', async () => {
    const environment = setup(async ({ signal }) => await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), 1);
    const delegated = environment.team.assignTask({ leadRunId: environment.leadRun.id, target: environment.memberA.definition, preset: environment.memberA.preset, title: 'inspect', description: 'inspect', inputRefs: [] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const first = environment.team.sendMessage({ fromAgentId: environment.lead.definition.id, toAgentId: environment.memberA.definition.id, content: 'first' });
    const second = environment.team.sendMessage({ fromAgentId: environment.lead.definition.id, toAgentId: environment.memberA.definition.id, content: 'second' });
    expect(environment.team.readMailbox(environment.memberA.definition.id).map((message) => message.id)).toEqual([first.id, second.id]);
    environment.team.requestClarification(delegated.runId, 'which dataset?', delegated.taskId);
    expect(environment.team.readMailbox(environment.lead.definition.id).at(-1)?.content).toContain('which dataset');
    const task = environment.team.takeOver(delegated.runId);
    expect(task).toMatchObject({ status: 'waiting_user', assignedAgentId: environment.leadRun.id });
    await environment.team.stop(); environment.events.close();
  });

  it('rejects recursive delegation by a member run', async () => {
    const environment = setup(async () => ({}));
    const delegated = environment.team.assignTask({ leadRunId: environment.leadRun.id, target: environment.memberA.definition, preset: environment.memberA.preset, title: 'one', description: 'one', inputRefs: [] });
    expect(() => environment.team.assignTask({ leadRunId: delegated.runId, target: environment.memberB.definition, preset: environment.memberB.preset, title: 'nested', description: 'nested', inputRefs: [] })).toThrow(/主管/u);
    await environment.team.waitForRuns([delegated.runId], new AbortController().signal);
    await environment.team.stop(); environment.events.close();
  });

  it('pauses queued and running members and joins them before disposal', async () => {
    const environment = setup(async ({ signal }) => await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), 1);
    environment.team.assignTask({ leadRunId: environment.leadRun.id, target: environment.memberA.definition, preset: environment.memberA.preset, title: 'running', description: 'test', inputRefs: [] });
    environment.team.assignTask({ leadRunId: environment.leadRun.id, target: environment.memberB.definition, preset: environment.memberB.preset, title: 'queued', description: 'test', inputRefs: [] });
    await new Promise((resolve) => setTimeout(resolve, 10)); await environment.team.stop();
    expect(environment.team.snapshot().runs.filter((run) => run.role === 'member').every((run) => run.status === 'paused')).toBe(true);
    expect(environment.team.snapshot().tasks.every((task) => task.status === 'waiting_user')).toBe(true);
    expect(() => environment.team.assignTask({ leadRunId: environment.leadRun.id, target: environment.memberA.definition, preset: environment.memberA.preset, title: 'late', description: 'late', inputRefs: [] })).toThrow(/正在停止/u);
    environment.events.close();
  });
});
