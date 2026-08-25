import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, MessageSquareText, X } from 'lucide-react';
import { hanaZhCN as copy } from '../i18n/zh-CN.js';

interface AppDialogOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

interface DialogRequest extends AppDialogOptions {
  id: number;
  kind: 'confirm' | 'prompt';
  message: string;
  defaultValue?: string;
  resolve(value: boolean | string | null): void;
}

const dialogEvent = 'openlab:app-dialog';
let dialogId = 0;

function requestDialog(request: Omit<DialogRequest, 'id' | 'resolve'>): Promise<boolean | string | null> {
  return new Promise((resolve) => {
    const detail: DialogRequest = { ...request, id: ++dialogId, resolve };
    window.dispatchEvent(new CustomEvent<DialogRequest>(dialogEvent, { detail }));
  });
}

export async function confirmInApp(message: string, options: AppDialogOptions = {}): Promise<boolean> {
  return await requestDialog({ kind: 'confirm', message, ...options }) === true;
}

export async function promptInApp(message: string, defaultValue = '', options: AppDialogOptions = {}): Promise<string | null> {
  const value = await requestDialog({ kind: 'prompt', message, defaultValue, ...options });
  return typeof value === 'string' ? value : null;
}

export function AppDialogHost() {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLFormElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const active = queue[0];

  useEffect(() => {
    const receive = (event: Event) => setQueue((current) => [...current, (event as CustomEvent<DialogRequest>).detail]);
    window.addEventListener(dialogEvent, receive);
    return () => window.removeEventListener(dialogEvent, receive);
  }, []);

  useEffect(() => {
    if (!active) return;
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setValue(active.defaultValue ?? '');
    const frame = requestAnimationFrame(() => active.kind === 'prompt' ? input.current?.select() : confirmButton.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [active?.id]);

  if (!active) return null;
  const settle = (result: boolean | string | null) => {
    active.resolve(result);
    setQueue((current) => current.slice(1));
    requestAnimationFrame(() => restoreFocus.current?.focus());
  };
  const confirm = () => settle(active.kind === 'prompt' ? value : true);

  return <div className="app-dialog-backdrop" data-testid="app-dialog-backdrop" onMouseDown={(event) => event.currentTarget === event.target && settle(active.kind === 'confirm' ? false : null)} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); settle(active.kind === 'confirm' ? false : null); }
    if (event.key === 'Tab') {
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])];
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <form ref={dialog} className={`app-dialog ${active.tone === 'danger' ? 'is-danger' : ''}`} data-testid="app-dialog" role="dialog" aria-modal="true" aria-labelledby={`app-dialog-title-${active.id}`} onSubmit={(event) => { event.preventDefault(); confirm(); }}>
      <header><span>{active.tone === 'danger' ? <AlertTriangle size={18}/> : <MessageSquareText size={18}/>}</span><div><strong id={`app-dialog-title-${active.id}`}>{active.title ?? (active.kind === 'prompt' ? copy.dialog.inputTitle : copy.dialog.confirmTitle)}</strong><small>{active.kind === 'prompt' ? copy.dialog.promptHint : copy.dialog.confirmHint}</small></div><button type="button" aria-label={copy.dialog.close} onClick={() => settle(active.kind === 'confirm' ? false : null)}><X size={16}/></button></header>
      <p>{active.message}</p>
      {active.kind === 'prompt' && <input ref={input} data-testid="app-dialog-input" value={value} onChange={(event) => setValue(event.target.value)} />}
      <footer><button type="button" className="button secondary" onClick={() => settle(active.kind === 'confirm' ? false : null)}>{active.cancelLabel ?? copy.dialog.cancel}</button><button ref={confirmButton} type="submit" data-testid="app-dialog-confirm" className={`button primary ${active.tone === 'danger' ? 'danger' : ''}`}>{active.confirmLabel ?? copy.dialog.confirm}</button></footer>
    </form>
  </div>;
}
