import { useCallback, useEffect, useRef, useState } from 'react';
import { CirclePlay, CircleStop, Send, TerminalSquare } from 'lucide-react';
import type { JsonValue } from '@openlab/protocol';
import { worktableZhCN as copy } from '../i18n/zh-CN.js';
import {
  emptyTerminalOutputState,
  mergeTerminalRead,
  shouldPollTerminal,
  terminalStartView,
  type TerminalOutputState,
} from '../lib/terminal-output.js';

const POLL_INTERVAL_MS = 350;

interface TerminalActions {
  terminalAction(instanceId: string, paneId: string, input: Record<string, unknown>): Promise<JsonValue | undefined>;
}

export interface TerminalPaneProps {
  actions: TerminalActions;
  instanceId: string;
  paneId: string;
  visible: boolean;
  active: boolean;
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function TerminalPane({ actions, instanceId, paneId, visible, active }: TerminalPaneProps) {
  const [command, setCommand] = useState('');
  const [terminal, setTerminal] = useState<TerminalOutputState>(() => emptyTerminalOutputState());
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const stateRef = useRef(terminal);
  const requestKeyRef = useRef(`${instanceId}:${paneId}`);
  const readPendingRef = useRef(false);
  const mountedRef = useRef(false);
  const readableRef = useRef(visible && active);
  readableRef.current = visible && active;
  requestKeyRef.current = `${instanceId}:${paneId}`;

  const commit = useCallback((next: TerminalOutputState) => {
    stateRef.current = next;
    if (mountedRef.current) setTerminal(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const next = emptyTerminalOutputState();
    stateRef.current = next;
    readPendingRef.current = false;
    setTerminal(next);
    setNotice(undefined);
    setCommand('');
  }, [instanceId, paneId]);

  const readOutput = useCallback(async () => {
    const requestKey = `${instanceId}:${paneId}`;
    if (!readableRef.current || readPendingRef.current) return;
    readPendingRef.current = true;
    try {
      const result = await actions.terminalAction(instanceId, paneId, {
        action: 'read',
        afterSequence: stateRef.current.afterSequence,
      });
      if (!mountedRef.current || requestKeyRef.current !== requestKey || !readableRef.current) return;
      commit(mergeTerminalRead(stateRef.current, result));
      setNotice(undefined);
    } catch (cause) {
      if (!mountedRef.current || requestKeyRef.current !== requestKey || !readableRef.current) return;
      commit({ ...stateRef.current, status: 'idle' });
      setNotice(`${copy.terminal.readFailed}：${failureMessage(cause)}`);
    } finally {
      if (requestKeyRef.current === requestKey) readPendingRef.current = false;
    }
  }, [actions, commit, instanceId, paneId]);

  useEffect(() => {
    if (!shouldPollTerminal({ visible, active, status: terminal.status })) return;
    void readOutput();
    const timer = window.setInterval(() => void readOutput(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, readOutput, terminal.status, visible]);

  const start = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await actions.terminalAction(instanceId, paneId, { action: 'start' });
      const opened = terminalStartView(result);
      if (!opened.running) {
        commit({ ...stateRef.current, status: 'idle' });
        setNotice(opened.reason ?? copy.terminal.unavailable);
        return;
      }
      const base = opened.sessionId !== stateRef.current.sessionId
        ? { ...emptyTerminalOutputState(), ...(opened.sessionId ? { sessionId: opened.sessionId } : {}) }
        : stateRef.current;
      commit({ ...base, status: 'running' });
      await readOutput();
    } catch (cause) {
      commit({ ...stateRef.current, status: 'idle' });
      setNotice(`${copy.terminal.startFailed}：${failureMessage(cause)}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const close = async () => {
    commit({ ...stateRef.current, status: 'idle' });
    setBusy(true);
    try {
      await actions.terminalAction(instanceId, paneId, { action: 'close' });
    } catch (cause) {
      setNotice(`${copy.terminal.closeFailed}：${failureMessage(cause)}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const send = async () => {
    const value = command.trim();
    if (terminal.status !== 'running' || !value) return;
    setCommand('');
    setNotice(undefined);
    try {
      await actions.terminalAction(instanceId, paneId, { action: 'input', data: `${value}\r` });
      await readOutput();
    } catch (cause) {
      setNotice(`${copy.terminal.inputFailed}：${failureMessage(cause)}`);
    }
  };

  const started = terminal.status === 'running';
  return <div className="worktable-terminal-pane">
    <header><span><TerminalSquare size={14}/><strong>{copy.terminal.title}</strong></span>{started
      ? <button disabled={busy} onClick={() => void close()}><CircleStop size={12}/>{copy.terminal.stop}</button>
      : <button disabled={busy} onClick={() => void start()}><CirclePlay size={12}/>{copy.terminal.start}</button>}</header>
    <p>{copy.terminal.hint}</p>
    <pre>{terminal.text || notice || (started ? copy.terminal.waitingOutput : copy.terminal.unavailable)}</pre>
    <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={copy.terminal.placeholder}/>
      <button disabled={busy || !started || !command.trim()}><Send size={12}/>{copy.terminal.send}</button>
    </form>
  </div>;
}
