import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TerminalPane } from '../src/components/TerminalPane.js';
import {
  TERMINAL_OUTPUT_TEXT_LIMIT,
  emptyTerminalOutputState,
  mergeTerminalRead,
  shouldPollTerminal,
  terminalStartView,
  trimTerminalOutput,
} from '../src/lib/terminal-output.js';

describe('terminal output helpers', () => {
  it('does not treat an unavailable start response as a running terminal', () => {
    expect(terminalStartView({ status: 'unavailable', reason: 'node-pty unavailable' })).toEqual({
      running: false,
      reason: 'node-pty unavailable',
    });
    expect(terminalStartView({ status: 'opened', session: { id: 'terminal-1', status: 'running' } })).toEqual({
      running: true,
      sessionId: 'terminal-1',
    });
  });

  it('merges sequence chunks exactly once and follows the session status', () => {
    const first = mergeTerminalRead(emptyTerminalOutputState(), {
      session: { id: 'terminal-1', status: 'running' },
      chunks: [{ sequence: 2, data: 'two' }, { sequence: 1, data: 'one' }],
      droppedOutputBytes: 0,
    });
    expect(first).toMatchObject({ text: 'onetwo', afterSequence: 2, sessionId: 'terminal-1', status: 'running' });
    const second = mergeTerminalRead(first, {
      session: { id: 'terminal-1', status: 'exited' },
      chunks: [{ sequence: 2, data: 'duplicate' }, { sequence: 3, data: 'three' }],
      droppedOutputBytes: 12,
    });
    expect(second).toMatchObject({ text: 'onetwothree', afterSequence: 3, status: 'exited', droppedOutputBytes: 12 });
  });

  it('keeps only the newest approximately one MiB of UTF-8 output', () => {
    const trimmed = trimTerminalOutput(`old-${'测'.repeat(TERMINAL_OUTPUT_TEXT_LIMIT)}-new`);
    expect(new TextEncoder().encode(trimmed).byteLength).toBeLessThanOrEqual(TERMINAL_OUTPUT_TEXT_LIMIT);
    expect(trimmed.endsWith('-new')).toBe(true);
  });

  it('polls only while the worktable and active pane are visible and running', () => {
    expect(shouldPollTerminal({ visible: true, active: true, status: 'running' })).toBe(true);
    expect(shouldPollTerminal({ visible: false, active: true, status: 'running' })).toBe(false);
    expect(shouldPollTerminal({ visible: true, active: false, status: 'running' })).toBe(false);
    expect(shouldPollTerminal({ visible: true, active: true, status: 'exited' })).toBe(false);
  });
});

describe('TerminalPane', () => {
  it('renders an idle terminal without issuing an action during render', () => {
    const terminalAction = vi.fn(async () => undefined);
    const html = renderToStaticMarkup(createElement(TerminalPane, {
      actions: { terminalAction }, instanceId: 'instance', paneId: 'pane', visible: true, active: true,
    }));
    expect(html).toContain('终端尚未启动');
    expect(html).toContain('启动');
    expect(terminalAction).not.toHaveBeenCalled();
  });
});
