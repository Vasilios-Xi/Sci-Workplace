import type { JsonValue } from '@openlab/protocol';
import stripAnsi from 'strip-ansi';

export const TERMINAL_OUTPUT_TEXT_LIMIT = 1024 * 1024;

export interface TerminalOutputState {
  text: string;
  afterSequence: number;
  sessionId?: string;
  status: string;
  droppedOutputBytes: number;
}

export interface TerminalStartView {
  running: boolean;
  sessionId?: string;
  reason?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function emptyTerminalOutputState(): TerminalOutputState {
  return { text: '', afterSequence: 0, status: 'idle', droppedOutputBytes: 0 };
}

export function terminalStartView(value: JsonValue | undefined): TerminalStartView {
  const result = record(value);
  const session = record(result?.session);
  const running = result?.status === 'opened' && session?.status === 'running';
  const sessionId = typeof session?.id === 'string' ? session.id : undefined;
  const reason = typeof result?.reason === 'string' ? result.reason : undefined;
  return {
    running,
    ...(sessionId ? { sessionId } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function trimTerminalOutput(text: string, maxBytes = TERMINAL_OUTPUT_TEXT_LIMIT): string {
  const limit = Math.max(0, Math.trunc(maxBytes));
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= limit) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (encoder.encode(text.slice(middle)).byteLength > limit) low = middle + 1;
    else high = middle;
  }
  if (low < text.length) {
    const code = text.charCodeAt(low);
    if (code >= 0xdc00 && code <= 0xdfff) low += 1;
  }
  return text.slice(low);
}

export function mergeTerminalRead(current: TerminalOutputState, value: JsonValue | undefined): TerminalOutputState {
  const result = record(value);
  const session = record(result?.session);
  const sessionId = typeof session?.id === 'string' ? session.id : undefined;
  const base = sessionId && current.sessionId !== sessionId
    ? { ...emptyTerminalOutputState(), sessionId }
    : current;
  const seen = new Set<number>();
  const chunks = (Array.isArray(result?.chunks) ? result.chunks : [])
    .map((chunk) => record(chunk))
    .filter((chunk): chunk is Record<string, unknown> => chunk !== undefined)
    .map((chunk) => ({ sequence: chunk.sequence, data: chunk.data }))
    .filter((chunk): chunk is { sequence: number; data: string } => Number.isSafeInteger(chunk.sequence) && typeof chunk.data === 'string')
    .filter((chunk) => chunk.sequence > base.afterSequence && !seen.has(chunk.sequence) && seen.add(chunk.sequence))
    .sort((left, right) => left.sequence - right.sequence);
  const afterSequence = chunks.reduce((latest, chunk) => Math.max(latest, chunk.sequence), base.afterSequence);
  const status = typeof session?.status === 'string' ? session.status : base.status;
  const droppedOutputBytes = typeof result?.droppedOutputBytes === 'number' && Number.isFinite(result.droppedOutputBytes)
    ? Math.max(0, Math.trunc(result.droppedOutputBytes))
    : base.droppedOutputBytes;
  return {
    text: trimTerminalOutput(stripAnsi(`${base.text}${chunks.map((chunk) => chunk.data).join('')}`)),
    afterSequence,
    status,
    droppedOutputBytes,
    ...(sessionId ?? base.sessionId ? { sessionId: sessionId ?? base.sessionId } : {}),
  };
}

export function shouldPollTerminal(input: { visible: boolean; active: boolean; status: string }): boolean {
  return input.visible && input.active && input.status === 'running';
}
